'use strict';

const {
    generateSessionToken,
    migrateHostOnDisconnect,
    startGracePeriod,
    resumeLoopIfPaused,
    cleanupRoomIfEmpty,
    beginRejoin,
    broadcastCountdown: broadcastCountdownShared,
    safeOn,
    safeTick,
    isRateLimited
} = require('./room-lifecycle');

const FPS = 60;
const HUNTER_HEALTH_MAX = 100;
const HUNTER_WRONG_PENALTY = 5;   // -5 PV que ce soit décor ou miss
const DISGUISE_RANGE = 70;
const TAG_HIT_RANGE = 42;
const PLAYER_SPEED = 3.2;
const DISGUISED_SPEED = 1.4;
const NET_TICK_MS = 50; // 20fps réseau

const PHASE_DURATIONS = {
    RECON: 20000,
    CACHE: 30000,
    HUNT: 240000
};

// Endgame mode (STORM/FREEZE/PURGE) triggers this many ms before HUNT ends,
// not after HUNT starts — storm fully closes (2500 / 28px/s ≈ 89s) right around phase end.

// Props periodically make noise during HUNT — interval shrinks from NOISE_START_INTERVAL
// down to NOISE_MIN_INTERVAL as the phase progresses. The hunter only hears it within
// NOISE_HEAR_RADIUS, louder the closer the source — no position is ever sent to the client.
const NOISE_START_INTERVAL = 22000;
const NOISE_MIN_INTERVAL   = 6000;
const NOISE_HEAR_RADIUS    = 850;

// Coerces an untrusted 'hunterInput' payload into a safe boolean-only shape,
// so a malformed/malicious client can't crash movement code or store garbage.
function sanitizeMovementInput(input) {
    if (!input || typeof input !== 'object') {
        return { up: false, down: false, left: false, right: false };
    }
    return {
        up:    !!input.up,
        down:  !!input.down,
        left:  !!input.left,
        right: !!input.right
    };
}

// ──────────────────────────────────────────────
// BIOMES — props par thème de map
// ──────────────────────────────────────────────
const BIOME_POOLS = {
    'Depot Alpha': [
        { type: 'CRATE_S',      radius: 20, weight: 4 },
        { type: 'CRATE_M',      radius: 28, weight: 4 },
        { type: 'CRATE_L',      radius: 36, weight: 3 },
        { type: 'BARREL',       radius: 18, weight: 4 },
        { type: 'FUEL_DRUM',    radius: 20, weight: 3 },
        { type: 'PALLET',       radius: 30, weight: 3 },
        { type: 'AMMO_BOX',     radius: 22, weight: 3 },
        { type: 'TOOL_CHEST',   radius: 24, weight: 2 },
        { type: 'CONE',         radius: 13, weight: 2 },
        { type: 'GENERATOR',    radius: 28, weight: 1 },
        { type: 'TOXIC_DRUM',    radius: 19, weight: 2 }
    ],
    'Zone Charlie': [
        { type: 'BARREL',       radius: 18, weight: 4 },
        { type: 'FUEL_DRUM',    radius: 20, weight: 4 },
        { type: 'CONE',         radius: 13, weight: 4 },
        { type: 'SANDBAG',      radius: 22, weight: 4 },
        { type: 'AMMO_BOX',     radius: 22, weight: 3 },
        { type: 'CRATE_S',      radius: 20, weight: 3 },
        { type: 'CRATE_M',      radius: 28, weight: 2 },
        { type: 'TURRET_OFF',   radius: 26, weight: 2 },
        { type: 'CAMO_NET',     radius: 32, weight: 2 },
        { type: 'GENERATOR',    radius: 28, weight: 1 },
        { type: 'RADAR_DISH',    radius: 25, weight: 2 }
    ],
    'Bloc Tactique': [
        { type: 'LOCKER',       radius: 22, weight: 4 },
        { type: 'SERVER_RACK',  radius: 28, weight: 4 },
        { type: 'DESK',         radius: 30, weight: 3 },
        { type: 'CRATE_S',      radius: 20, weight: 3 },
        { type: 'AMMO_BOX',     radius: 22, weight: 3 },
        { type: 'TOOL_CHEST',   radius: 24, weight: 3 },
        { type: 'FIRE_EXT',     radius: 12, weight: 3 },
        { type: 'CONE',         radius: 13, weight: 2 },
        { type: 'BARREL',       radius: 18, weight: 2 },
        { type: 'GENERATOR',    radius: 28, weight: 1 },
        { type: 'OFFICE_CHAIR',  radius: 16, weight: 2 }
    ]
};

const HUNTER_MAPS = {
    'Depot Alpha':   { w: 3000, h: 2400, propCount: 55, floor: '#1a1c18', accent: '#8a7a4a' },
    'Zone Charlie':  { w: 3400, h: 2600, propCount: 62, floor: '#171c13', accent: '#5a7a4a' },
    'Bloc Tactique': { w: 2800, h: 2200, propCount: 48, floor: '#14151a', accent: '#4a6a8a' }
};

// Scales a map's base size/prop density by total player count (same tiering idea as classic mode):
// fewer players -> smaller map (hunt stays findable), more players -> bigger map (more room to hide).
function hunterMapSizeFor(theme, totalPlayers) {
    const base = HUNTER_MAPS[theme] || HUNTER_MAPS['Depot Alpha'];
    let scale;
    if (totalPlayers <= 2) scale = 0.75;
    else if (totalPlayers <= 4) scale = 1.0;
    else scale = 1.3;
    return {
        w: Math.round(base.w * scale),
        h: Math.round(base.h * scale),
        propCount: Math.round(base.propCount * scale * scale) // density stays ~constant per unit area
    };
}

// ──────────────────────────────────────────────
// PRNG (déterministe, partagée client/serveur)
// ──────────────────────────────────────────────
function mulberry32(seed) {
    let s = seed >>> 0;
    return function() {
        s = Math.imul((s ^= s + 0x6D2B79F5), s | 1);
        s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
        return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
    };
}

// Tirage pondéré depuis un pool
function weightedPick(rng, pool) {
    const totalWeight = pool.reduce((s, p) => s + p.weight, 0);
    let r = rng() * totalWeight;
    for (const p of pool) {
        r -= p.weight;
        if (r <= 0) return p;
    }
    return pool[pool.length - 1];
}

function generateProps(mapSize, count, biome, seed) {
    const pool = BIOME_POOLS[biome] || BIOME_POOLS['Depot Alpha'];
    const rng  = mulberry32(seed ^ 0xDEADBEEF);
    const props = [];
    const minDist = 80;

    // Choose wall prop type and radius based on biome
    let wallType = 'CRATE_L';
    let wallRadius = 36;
    let pillarType = 'GENERATOR';
    let pillarRadius = 28;

    if (biome === 'Bloc Tactique') {
        wallType = 'SERVER_RACK';
        wallRadius = 28;
        pillarType = 'SERVER_RACK';
        pillarRadius = 28;
    } else if (biome === 'Zone Charlie') {
        wallType = 'SANDBAG';
        wallRadius = 22;
        pillarType = 'TURRET_OFF';
        pillarRadius = 26;
    }

    const cx = mapSize.w / 2;
    const cy = mapSize.h / 2;

    const doors = [];
    let rx = 0, ry = 0;
    let halfW = 180;
    let halfH = 140;
    let hasVault = false;

    if (biome === 'Depot Alpha') {
        hasVault = true;
        let valid = false;
        let limitAttempts = 0;
        while (!valid && limitAttempts < 100) {
            limitAttempts++;
            rx = Math.floor(400 + rng() * (mapSize.w - 800));
            ry = Math.floor(400 + rng() * (mapSize.h - 800));
            const distToHub = Math.sqrt((rx - cx) ** 2 + (ry - cy) ** 2);
            if (distToHub > 600) {
                valid = true;
            }
        }
        if (!valid) {
            rx = 600;
            ry = 600;
        }

        const step = wallRadius * 1.6;

        for (let y = ry - halfH; y <= ry + halfH; y += step) {
            props.push({
                id: `vault_wall_L_${Math.round(y)}`,
                type: wallType,
                x: rx - halfW,
                y: Math.round(y),
                radius: wallRadius,
                angle: Math.PI / 2,
                animated: false
            });
        }

        for (let y = ry - halfH; y <= ry + halfH; y += step) {
            props.push({
                id: `vault_wall_R_${Math.round(y)}`,
                type: wallType,
                x: rx + halfW,
                y: Math.round(y),
                radius: wallRadius,
                angle: Math.PI / 2,
                animated: false
            });
        }

        for (let x = rx - halfW + step; x < rx + halfW; x += step) {
            props.push({
                id: `vault_wall_B_${Math.round(x)}`,
                type: wallType,
                x: Math.round(x),
                y: ry + halfH,
                radius: wallRadius,
                angle: 0,
                animated: false
            });
        }

        for (let x = rx - halfW + step; x <= rx - 60; x += step) {
            props.push({
                id: `vault_wall_T_left_${Math.round(x)}`,
                type: wallType,
                x: Math.round(x),
                y: ry - halfH,
                radius: wallRadius,
                angle: 0,
                animated: false
            });
        }
        for (let x = rx + 60; x < rx + halfW; x += step) {
            props.push({
                id: `vault_wall_T_right_${Math.round(x)}`,
                type: wallType,
                x: Math.round(x),
                y: ry - halfH,
                radius: wallRadius,
                angle: 0,
                animated: false
            });
        }

        doors.push({
            id: 'door_vault',
            x: rx,
            y: ry - halfH,
            w: 130,
            h: 32,
            consoleX: rx - 85,
            consoleY: ry - halfH,
            open: false
        });

        const insidePropCount = Math.floor(3 + rng() * 3);
        let insideAttempts = 0;
        let insidePropsSpawned = 0;
        while (insidePropsSpawned < insidePropCount && insideAttempts < 50) {
            insideAttempts++;
            const def = weightedPick(rng, pool);
            const px = Math.round(rx - halfW + 55 + rng() * (halfW * 2 - 110));
            const py = Math.round(ry - halfH + 55 + rng() * (halfH * 2 - 110));

            let overlap = false;
            for (let i = props.length - insidePropsSpawned; i < props.length; i++) {
                const p = props[i];
                const dx = px - p.x;
                const dy = py - p.y;
                if (dx*dx + dy*dy < (p.radius + def.radius + 15) ** 2) {
                    overlap = true;
                    break;
                }
            }
            if (overlap) continue;

            props.push({
                id: `vault_prop_${insidePropsSpawned}`,
                type: def.type,
                x: px,
                y: py,
                radius: def.radius,
                angle: Math.floor(rng() * 4) * (Math.PI / 2),
                animated: false
            });
            insidePropsSpawned++;
        }
    }

    // 1. Spawn Central Hub Core (pulsing generator)
    props.push({
        id: 'hub_core',
        type: 'GENERATOR',
        x: cx,
        y: cy,
        radius: 30,
        angle: 0,
        animated: true
    });

    // 2. Spawn Central Hub Cabin Walls
    const cabinHalf = 140;
    const cabinStep = wallRadius * 1.6;

    // Top wall (with 120px doorway)
    for (let x = cx - cabinHalf; x <= cx + cabinHalf; x += cabinStep) {
        if (Math.abs(x - cx) < 60) continue;
        props.push({
            id: `hub_wall_top_${Math.round(x)}`,
            type: wallType,
            x: Math.round(x),
            y: cy - cabinHalf,
            radius: wallRadius,
            angle: 0,
            animated: false
        });
    }

    // Bottom wall (with 120px doorway)
    for (let x = cx - cabinHalf; x <= cx + cabinHalf; x += cabinStep) {
        if (Math.abs(x - cx) < 60) continue;
        props.push({
            id: `hub_wall_bot_${Math.round(x)}`,
            type: wallType,
            x: Math.round(x),
            y: cy + cabinHalf,
            radius: wallRadius,
            angle: 0,
            animated: false
        });
    }

    // Left wall (solid, skip corners)
    for (let y = cy - cabinHalf + cabinStep; y <= cy + cabinHalf - cabinStep; y += cabinStep) {
        props.push({
            id: `hub_wall_left_${Math.round(y)}`,
            type: wallType,
            x: cx - cabinHalf,
            y: Math.round(y),
            radius: wallRadius,
            angle: Math.PI / 2,
            animated: false
        });
    }

    // Right wall (solid, skip corners)
    for (let y = cy - cabinHalf + cabinStep; y <= cy + cabinHalf - cabinStep; y += cabinStep) {
        props.push({
            id: `hub_wall_right_${Math.round(y)}`,
            type: wallType,
            x: cx + cabinHalf,
            y: Math.round(y),
            radius: wallRadius,
            angle: Math.PI / 2,
            animated: false
        });
    }

    // Generate grid lines
    const hWalls = [
        Math.round(mapSize.h * 0.25),
        Math.round(mapSize.h * 0.5),
        Math.round(mapSize.h * 0.75)
    ];
    const vWalls = [
        Math.round(mapSize.w * 0.25),
        Math.round(mapSize.w * 0.5),
        Math.round(mapSize.w * 0.75)
    ];

    // 3. Spawn Corner Pillars at grid intersections (except the center intersection)
    vWalls.forEach((vx, vIdx) => {
        hWalls.forEach((hy, hIdx) => {
            if (vIdx === 1 && hIdx === 1) return; // Skip center which is inside Central Hub
            props.push({
                id: `pillar_${vIdx}_${hIdx}`,
                type: pillarType,
                x: vx,
                y: hy,
                radius: pillarRadius,
                angle: 0,
                animated: false
            });
        });
    });

    // Helper to verify placement clearance
    function isPositionClear(x, y, radius, propsList, customMinDist = minDist) {
        // Map boundary check
        if (x - radius < 120 || x + radius > mapSize.w - 120) return false;
        if (y - radius < 120 || y + radius > mapSize.h - 120) return false;

        // Central Hub exclusion zone
        if (Math.abs(x - cx) < 200 && Math.abs(y - cy) < 200) return false;

        // Vault exclusion zone
        if (hasVault && Math.abs(x - rx) < halfW + 70 && Math.abs(y - ry) < halfH + 70) return false;

        // Existing props overlap
        for (const p of propsList) {
            const dx = x - p.x;
            const dy = y - p.y;
            if (dx*dx + dy*dy < (customMinDist + p.radius + radius) ** 2) {
                return false;
            }
        }
        return true;
    }

    // 4. Horizontal wall segments
    hWalls.forEach((y, wIdx) => {
        const xBreaks = [0, vWalls[0], vWalls[1], vWalls[2], mapSize.w];
        for (let i = 0; i < xBreaks.length - 1; i++) {
            if (rng() > 0.85) continue;

            const xStart = xBreaks[i];
            const xEnd = xBreaks[i+1];
            
            const startMargin = (xStart === 0) ? (wallRadius * 1.5) : (pillarRadius + wallRadius + 12);
            const endMargin = (xEnd === mapSize.w) ? (wallRadius * 1.5) : (pillarRadius + wallRadius + 12);

            const margin = 120;
            const doorCenter = xStart + margin + rng() * (xEnd - xStart - 2 * margin);
            const doorHalfWidth = 110; // 220px doorway

            const step = wallRadius * 1.8;
            for (let x = xStart + startMargin; x < xEnd - endMargin; x += step) {
                if (x > doorCenter - doorHalfWidth && x < doorCenter + doorHalfWidth) continue;
                if (Math.abs(x - cx) < 200 && Math.abs(y - cy) < 200) continue;
                if (hasVault && Math.abs(x - rx) < halfW + 70 && Math.abs(y - ry) < halfH + 70) continue;

                props.push({
                     id: `hwall_${wIdx}_${i}_${Math.round(x)}`,
                     type: wallType,
                     x: Math.round(x),
                     y: y,
                     radius: wallRadius,
                     angle: 0,
                     animated: false
                });
            }
        }
    });

    // 5. Vertical wall segments
    vWalls.forEach((x, wIdx) => {
        const yBreaks = [0, hWalls[0], hWalls[1], hWalls[2], mapSize.h];
        for (let i = 0; i < yBreaks.length - 1; i++) {
            if (rng() > 0.85) continue;

            const yStart = yBreaks[i];
            const yEnd = yBreaks[i+1];

            const startMargin = (yStart === 0) ? (wallRadius * 1.5) : (pillarRadius + wallRadius + 12);
            const endMargin = (yEnd === mapSize.h) ? (wallRadius * 1.5) : (pillarRadius + wallRadius + 12);

            const margin = 120;
            const doorCenter = yStart + margin + rng() * (yEnd - yStart - 2 * margin);
            const doorHalfWidth = 110;

            const step = wallRadius * 1.8;
            for (let y = yStart + startMargin; y < yEnd - endMargin; y += step) {
                if (y > doorCenter - doorHalfWidth && y < doorCenter + doorHalfWidth) continue;
                if (Math.abs(x - cx) < 200 && Math.abs(y - cy) < 200) continue;
                if (hasVault && Math.abs(x - rx) < halfW + 70 && Math.abs(y - ry) < halfH + 70) continue;

                let tooClose = false;
                for (const p of props) {
                    const dx = x - p.x;
                    const dy = y - p.y;
                    if (dx*dx + dy*dy < (wallRadius * 1.4) ** 2) {
                        tooClose = true;
                        break;
                    }
                }
                if (tooClose) continue;

                props.push({
                    id: `vwall_${wIdx}_${i}_${Math.round(y)}`,
                    type: wallType,
                    x: x,
                    y: Math.round(y),
                    radius: wallRadius,
                    angle: Math.PI / 2,
                    animated: false
                });
            }
        }
    });

    // 6. Fill the rest with random props (scatter) & clustered spawning inside rooms
    let attempts = 0;
    const targetTotal = props.length + count;
    const maxAttempts = count * 60;
    while (props.length < targetTotal && attempts < maxAttempts) {
        attempts++;
        const def = weightedPick(rng, pool);
        const x   = Math.round(rng() * (mapSize.w - 240) + 120);
        const y   = Math.round(rng() * (mapSize.h - 240) + 120);

        if (!isPositionClear(x, y, def.radius, props)) continue;

        props.push({
            id:       `prop_${props.length}`,
            type:     def.type,
            x, y,
            radius:   def.radius,
            angle:    Math.floor(rng() * 4) * (Math.PI / 2),
            animated: false
        });

        // 45% chance to spawn a clustered secondary prop nearby
        if (rng() < 0.45) {
            const secDef = weightedPick(rng, pool);
            const secAngle = rng() * Math.PI * 2;
            const distance = def.radius + secDef.radius + 8;
            const secX = Math.round(x + Math.cos(secAngle) * distance);
            const secY = Math.round(y + Math.sin(secAngle) * distance);

            if (isPositionClear(secX, secY, secDef.radius, props, 5)) {
                props.push({
                    id:       `prop_${props.length}`,
                    type:     secDef.type,
                    x:        secX,
                    y:        secY,
                    radius:   secDef.radius,
                    angle:    Math.floor(rng() * 4) * (Math.PI / 2),
                    animated: false
                });
            }
        }
    }

    // 2–3 animated decoys
    const decoyCount = 2 + Math.floor(rng() * 2);
    const decoyIndices = new Set();
    while (decoyIndices.size < Math.min(decoyCount, props.length)) {
        decoyIndices.add(Math.floor(rng() * props.length));
    }
    for (const i of decoyIndices) {
        // Skip animating the hub core since it is always animated
        if (props[i].id === 'hub_core') continue;
        props[i].animated = true;
    }

    return { props, doors };
}

// ──────────────────────────────────────────────
// CLASS HunterRoom
// ──────────────────────────────────────────────
class HunterRoom {
    constructor(roomId, hostSocket, io, roomsRef, isQuickMatch = false) {
        this.roomId   = roomId;
        this.io       = io;
        this.roomsRef = roomsRef;
        this.gameMode = 'hunter';
        this.isQuickMatch = isQuickMatch;
        this.isPublic = isQuickMatch;

        this.players  = {};   // socketId → playerData
        this.state    = 'LOBBY';
        this.theme    = 'Depot Alpha';
        this.hostId   = hostSocket.id;
        this.MAX_PLAYERS   = 6;
        this.MAX_COUNTDOWN = 45;

        this.countdownTimer   = null;
        this.countdownSeconds = 0;

        // Game state
        this.mapSize      = { w: 3000, h: 2400 };
        this.props        = [];
        this.hunterId     = null;
        this.phase        = 'LOBBY';
        this.phaseEndsAt  = 0;
        this.hunterHealth = HUNTER_HEALTH_MAX;
        this.interval     = null;
        this.lastTime     = Date.now();
        this.netTickTimer = 0;
        this.seed         = 0;

        this.doors = [];
        this.teleporters = [];
        this.smokes = [];
        this.droneRevealEndsAt = 0;

        // Powerup state (par partie)
        this.hunterPowers = { droneUsed: false };

        this.addPlayer(hostSocket, 1);
    }

    // ─── Players ────────────────────────────────
    addPlayer(socket, num) {
        this.players[socket.id] = {
            socket,
            playerNum:    num,
            isReady:      false,
            avatar:       'Combat-Operative',
            x: 0, y: 0,
            angle:        0,
            vx: 0, vy: 0,
            input:        { up: false, down: false, left: false, right: false },
            role:         null,
            disguised:    false,
            disguiseType: null,
            disguiseAngle:0,
            eliminated:   false,
            hasDisguised: false,
            lives:        3,
            // Ghost powerups
            smokeUsed:    false,
            sprintUsed:   false,
            sprintActive: false,
            sprintEndsAt: 0,
            teleportReadyAt: 0
        };

        const token = generateSessionToken();
        this.players[socket.id].sessionToken = token;
        socket.emit('sessionToken', { token, roomCode: this.roomId, isHunter: true });

        socket.join(this.roomId);
        this._bindSocket(socket);

        if (this.state === 'COUNTDOWN') {
            this.countdownSeconds = Math.min(this.MAX_COUNTDOWN, this.countdownSeconds + 15);
        }

        this.io.to(this.roomId).emit('roomStatus', this.getLobbyStatus());
        // Broadcast slots AFTER roomStatus so the client receives them in the right order
        this.broadcastCountdown();
    }

    // ─── Socket bindings ────────────────────────
    _bindSocket(socket) {
        safeOn(socket, 'playerReady', (data) => {
            if (this.state !== 'LOBBY' && this.state !== 'COUNTDOWN') return;
            const p = this.players[socket.id];
            if (!p || p.isReady) return;
            const avatar = (data && typeof data.avatar === 'string') ? data.avatar.slice(0, 40) : 'Combat-Operative';
            p.isReady = true;
            p.avatar  = avatar || 'Combat-Operative';
            if (p.playerNum === 1 && data && typeof data.theme === 'string' && HUNTER_MAPS[data.theme]) {
                this.theme = data.theme;
            }
            this.io.to(this.roomId).emit('roomStatus', this.getLobbyStatus());

            const keys     = Object.keys(this.players);
            const allReady = keys.every(k => this.players[k].isReady);

            if (allReady) {
                this.stopCountdown();
                this.startShuffle();
                return;
            }
            if (this.isPublic || this.isQuickMatch) {
                if (this.state === 'LOBBY') this.startCountdown();
                else this.broadcastCountdown();
            } else {
                this.broadcastCountdown();
            }
        });

        safeOn(socket, 'hunterInput', (input) => {
            const p = this.players[socket.id];
            if (!p || p.eliminated) return;
            p.input = sanitizeMovementInput(input);
        });

        safeOn(socket, 'hunterDisguise', (data) => {
            if (isRateLimited(socket, 'hunterDisguise', 200)) return;
            if (!data || typeof data.propId !== 'string') return;
            this.handleDisguise(socket.id, data.propId);
        });

        safeOn(socket, 'hunterRotateDisguise', () => {
            if (isRateLimited(socket, 'hunterRotateDisguise', 150)) return;
            const p = this.players[socket.id];
            if (!p || p.eliminated) return;

            // Check if player is near a door console to toggle it
            if (this.doors && this.doors.length > 0) {
                for (const door of this.doors) {
                    const dx = p.x - door.consoleX;
                    const dy = p.y - door.consoleY;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist < 60) {
                        door.open = !door.open;
                        this.io.to(this.roomId).emit('doorToggled', { doorId: door.id, open: door.open });
                        return; // Door toggled, skip disguise rotation
                    }
                }
            }

            if (p.role === 'prop' && p.disguised) {
                p.disguiseAngle = (p.disguiseAngle + Math.PI / 2) % (Math.PI * 2);
            }
        });

        safeOn(socket, 'hunterTag', (data) => {
            if (isRateLimited(socket, 'hunterTag', 80)) return;
            if (!data || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
            this.handleHunterTag(socket.id, data.x, data.y);
        });

        // Powerups chasseur
        safeOn(socket, 'hunterUseDrone', () => {
            if (isRateLimited(socket, 'hunterUseDrone', 300)) return;
            this._handleDroneRecon(socket.id);
        });

        // Powerups fantôme
        safeOn(socket, 'ghostUseSmoke', () => {
            if (isRateLimited(socket, 'ghostUseSmoke', 300)) return;
            this._handleSmokeScreen(socket.id);
        });

        safeOn(socket, 'ghostUseSprint', () => {
            if (isRateLimited(socket, 'ghostUseSprint', 300)) return;
            this._handleSprint(socket.id);
        });

        safeOn(socket, 'backToLobby', () => {
            if (this.state === 'GAME_OVER') this.resetToLobby();
        });
    }

    // ─── Lobby ──────────────────────────────────
    getLobbyStatus() {
        const humans = Object.values(this.players);
        return {
            roomId:       this.roomId,
            gameMode:     'hunter',
            playerCount:  humans.length,
            readyCount:   humans.filter(p => p.isReady).length,
            theme:        this.theme,
            isPublic:     this.isPublic,
            isQuickMatch: this.isQuickMatch,
            state:        this.state,
            players:      humans.map(p => ({
                num:    p.playerNum,
                ready:  p.isReady,
                avatar: p.avatar
            }))
        };
    }

    startCountdown() {
        if (this.state !== 'LOBBY') return;
        this.state            = 'COUNTDOWN';
        this.countdownSeconds = this.MAX_COUNTDOWN;
        this.broadcastCountdown();
        this.countdownTimer = setInterval(safeTick('countdownTimer', () => {
            this.countdownSeconds--;
            if (this.countdownSeconds <= 0) {
                this.stopCountdown();
                if (Object.keys(this.players).length < this.MAX_PLAYERS) {
                    this.state = 'LOBBY';
                    this.io.to(this.roomId).emit('errorMsg', `Hunter mode nécessite ${this.MAX_PLAYERS} joueurs humains.`);
                    this.io.to(this.roomId).emit('roomStatus', this.getLobbyStatus());
                    return;
                }
                this.startShuffle();
                return;
            }
            this.broadcastCountdown();
        }), 1000);
    }

    stopCountdown() {
        if (this.countdownTimer) {
            clearInterval(this.countdownTimer);
            this.countdownTimer = null;
        }
        if (this.state === 'COUNTDOWN') this.state = 'LOBBY';
    }

    broadcastCountdown() {
        broadcastCountdownShared(this, { state: this.state });
    }

    // ─── Game Shuffle & Start ────────────────────
    startShuffle() {
        if (this.state !== 'LOBBY' && this.state !== 'COUNTDOWN') return;
        this.stopCountdown();
        this.state = 'SHUFFLING';

        // Mark all human players as ready
        for (const p of Object.values(this.players)) {
            p.isReady = true;
        }

        // Choose random map (theme)
        const themes = ['Depot Alpha', 'Zone Charlie', 'Bloc Tactique'];
        this.theme = themes[Math.floor(Math.random() * themes.length)];

        // PropHunt has no storm — the HUNT timer expiry alone decides the winner.

        // Assign hunter role now so we can reveal it in the shuffle animation.
        // Bots aren't added until startGame(), so all current players are human.
        const humanIds = Object.keys(this.players);
        this.hunterId = humanIds[Math.floor(Math.random() * humanIds.length)];

        // Shuffling duration (shorter for tests)
        const isTest = this.roomId.toLowerCase().includes('test');
        const duration = isTest ? 500 : 3000;

        // Emit shuffle individually so each player sees their own role
        for (const id of humanIds) {
            const p = this.players[id];
            if (p && p.socket) {
                p.socket.emit('hunterRoomShuffle', {
                    map: this.theme,
                    role: id === this.hunterId ? 'hunter' : 'prop',
                    duration
                });
            }
        }

        // Set timeout to start the game after the shuffling animation + drama delay
        const serverDelay = isTest ? 500 : (duration + 1500);
        this.shuffleTimeout = setTimeout(() => {
            this.startGame();
        }, serverDelay);
    }

    startGame() {
        // Fill with bots up to MAX_PLAYERS (Quick Match or Solo Test only) BEFORE sizing the map,
        // so map size scales with the final player count — same approach as classic mode.
        const currentHumanIds = Object.keys(this.players);
        const shouldFillBots = this.isQuickMatch || (currentHumanIds.length === 1);
        if (shouldFillBots && currentHumanIds.length < this.MAX_PLAYERS) {
            const botNames = ['🤖 OPÉRATEUR-ALPHA', '🤖 SPECTRE-BRAVO', '🤖 AGENT-DELTA', '🤖 PHANTOM-SIGMA', '🤖 OMBRE-EPSILON'];
            const hostAvatar = this.players[this.hostId]?.avatar || 'Combat-Operative';
            let botIndex = 0;
            for (let i = currentHumanIds.length; i < this.MAX_PLAYERS; i++) {
                const botId = `bot_player_${i}_` + Math.floor(Math.random() * 1000);
                this.players[botId] = {
                    socket: null,
                    playerNum: i + 1,
                    isReady: true,
                    avatar: hostAvatar,
                    x: 0, y: 0,
                    angle: 0,
                    vx: 0, vy: 0,
                    input: { up: false, down: false, left: false, right: false },
                    role: null,
                    disguised: false,
                    disguiseType: null,
                    disguiseAngle: 0,
                    eliminated: false,
                    hasDisguised: false,
                    lives: 3,
                    smokeUsed: false,
                    sprintUsed: false,
                    sprintActive: false,
                    sprintEndsAt: 0,
                    teleportReadyAt: 0,
                    isBot: true,
                    name: botNames[botIndex % botNames.length],
                    // bot AI properties
                    aiState: 'IDLE',
                    aiTimer: 0,
                    aiTargetX: 0,
                    aiTargetY: 0,
                    aiTargetPropId: null,
                    aiTagCooldown: 0,
                    aiPowerupCooldown: 0,
                    aiInspectTimer: 0
                };
                botIndex++;
            }
        }

        const mapDef     = hunterMapSizeFor(this.theme, Object.keys(this.players).length);
        this.mapSize     = { w: mapDef.w, h: mapDef.h };
        this.seed        = Math.floor(Math.random() * 0xFFFFFF);
        const genResult  = generateProps(this.mapSize, mapDef.propCount, this.theme, this.seed);
        this.props       = genResult.props;
        this.hunterHealth = HUNTER_HEALTH_MAX;
        this.state       = 'PLAYING';

        this.doors = [];
        this.teleporters = [];
        this.smokes = [];
        this.droneRevealEndsAt = 0;
        this.hunterPowers = { droneUsed: false };


        if (this.theme === 'Depot Alpha') {
            this.doors = genResult.doors;
        } else if (this.theme === 'Bloc Tactique') {
            // Relative to mapSize so the teleporter pair stays well-placed at any scale.
            this.teleporters = [
                { id: 'teleport_A', x: this.mapSize.w * 0.18, y: this.mapSize.h * 0.23, targetX: this.mapSize.w * 0.82, targetY: this.mapSize.h * 0.77 },
                { id: 'teleport_B', x: this.mapSize.w * 0.82, y: this.mapSize.h * 0.77, targetX: this.mapSize.w * 0.18, targetY: this.mapSize.h * 0.23 }
            ];
        }

        // Chasseur déjà assigné pendant le shuffle (avant ajout des bots) — on garde ce choix.
        // Si pour une raison quelconque il n'est pas défini, on en choisit un aléatoirement.
        const ids = Object.keys(this.players);
        if (!this.hunterId || !this.players[this.hunterId]) {
            this.hunterId = ids[Math.floor(Math.random() * ids.length)];
        }

        const spawns = this._spawnPoints(ids.length);
        ids.forEach((id, i) => {
            const p        = this.players[id];
            p.eliminated   = false;
            p.disguised    = false;
            p.disguiseType = null;
            p.possessedPropId = null;
            p.hasDisguised = false;
            p.lives        = 3;
            p.smokeUsed    = false;
            p.sprintUsed   = false;
            p.sprintActive = false;
            p.sprintEndsAt = 0;
            p.teleportReadyAt = 0;
            p.noiseTimer   = NOISE_START_INTERVAL;
            p.role         = (id === this.hunterId) ? 'hunter' : 'prop';
            
            // Find a clear spawn position (not on top of props, players, or vault interior)
            let spawnX = spawns[i].x;
            let spawnY = spawns[i].y;
            let attempts = 0;
            const maxAttempts = 60;

            // Derive vault bounding box from the door (Depot Alpha only)
            const vaultDoor = this.doors && this.doors.find(d => d.id === 'door_vault');
            const vaultCX = vaultDoor ? vaultDoor.x : -9999;
            const vaultCY = vaultDoor ? vaultDoor.y + 140 : -9999;
            const vaultHW = 200, vaultHH = 160; // slightly larger than actual (180×140) for safety margin

            const hasCollision = (x, y) => {
                // Reject positions inside the closed vault interior
                if (vaultDoor && !vaultDoor.open) {
                    if (Math.abs(x - vaultCX) < vaultHW && Math.abs(y - vaultCY) < vaultHH) {
                        return true;
                    }
                }
                // Check props
                for (const prop of this.props) {
                    const dx = x - prop.x;
                    const dy = y - prop.y;
                    if (dx * dx + dy * dy < (prop.radius + 25) * (prop.radius + 25)) {
                        return true;
                    }
                }
                // Check already placed players
                for (let j = 0; j < i; j++) {
                    const otherP = this.players[ids[j]];
                    const dx = x - otherP.x;
                    const dy = y - otherP.y;
                    if (dx * dx + dy * dy < 40 * 40) {
                        return true;
                    }
                }
                return false;
            };

            // Phase 1: try positions near the assigned spawn point (radius 50–150)
            while (hasCollision(spawnX, spawnY) && attempts < 30) {
                const angle = Math.random() * Math.PI * 2;
                const offset = 50 + Math.random() * 100;
                spawnX = spawns[i].x + Math.cos(angle) * offset;
                spawnY = spawns[i].y + Math.sin(angle) * offset;
                attempts++;
            }
            // Phase 2: if still stuck, search the full map randomly
            while (hasCollision(spawnX, spawnY) && attempts < maxAttempts) {
                spawnX = 80 + Math.random() * (this.mapSize.w - 160);
                spawnY = 80 + Math.random() * (this.mapSize.h - 160);
                attempts++;
            }
            
            p.x            = spawnX;
            p.y            = spawnY;
            p.angle        = 0;
            p.input        = { up: false, down: false, left: false, right: false };

            if (p.isBot && p.role === 'hunter') {
                const memorizationRate = 0.4 + Math.random() * 0.45; // between 40% and 85%
                const numMemorized = Math.floor(this.props.length * memorizationRate);
                const shuffledProps = [...this.props].sort(() => Math.random() - 0.5);
                const memorizedIds = shuffledProps.slice(0, numMemorized).map(pr => pr.id);
                
                p.aiDifficulty = 0.4 + Math.random() * 0.5; // between 40% and 90%
                p.aiMemorizationRate = memorizationRate;
                p.aiMemorizedPropIds = memorizedIds;
                p.name = `${p.name} [MEM: ${Math.round(memorizationRate * 100)}%]`;
            }
        });

        this._setPhase('RECON');

        this.io.to(this.roomId).emit('hunterGameStart', {
            gameMode:     'hunter',
            theme:        this.theme,
            mapSize:      this.mapSize,
            props:        this.props,
            seed:         this.seed,
            hunterId:     this.hunterId,
            roles:        this._getRolesPayload(),
            phase:        this.phase,
            phaseEndsAt:  this.phaseEndsAt,
            remaining:    PHASE_DURATIONS[this.phase],
            hunterHealth: this.hunterHealth,
            teleporters:  this.teleporters
        });

        this.lastTime     = Date.now();
        this.netTickTimer = 0;
        if (this.interval) clearInterval(this.interval);
        this.interval = setInterval(safeTick('gameLoop', () => this.gameLoop()), 1000 / FPS);
    }

    _spawnPoints(n) {
        const cx = this.mapSize.w / 2;
        const cy = this.mapSize.h / 2;
        const r  = Math.min(this.mapSize.w, this.mapSize.h) * 0.28;
        return Array.from({ length: n }, (_, i) => {
            const a = (i / n) * Math.PI * 2 - Math.PI / 2;
            return { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r };
        });
    }

    _setPhase(phase) {
        const now       = Date.now();
        this.phase      = phase;
        this.phaseEndsAt = now + PHASE_DURATIONS[phase];
        this.io.to(this.roomId).emit('hunterPhase', {
            phase,
            phaseEndsAt:  this.phaseEndsAt,
            remaining:    PHASE_DURATIONS[phase],
            hunterHealth: this.hunterHealth
        });
    }

    _getRolesPayload() {
        const out = {};
        for (const [id, p] of Object.entries(this.players)) {
            out[id] = { role: p.role, num: p.playerNum, avatar: p.avatar, x: p.x, y: p.y };
        }
        return out;
    }

    // ─── Movement ───────────────────────────────
    _canMove(p) {
        if (p.eliminated) return false;
        if (this.phase === 'RECON')  return p.role === 'hunter';
        if (this.phase === 'CACHE')  return p.role === 'prop';
        if (this.phase === 'HUNT')   return true;
        return false;
    }

    _updateMovement(p) {
        if (!this._canMove(p)) { p.vx = 0; p.vy = 0; return; }

        let speed = PLAYER_SPEED;
        if (p.role === 'prop' && p.disguised) {
            const refRadius = 22;
            const radius = p.disguiseRadius || refRadius;
            const factor = refRadius / radius;
            const clampedFactor = Math.max(0.5, Math.min(2.0, factor));
            speed = DISGUISED_SPEED * clampedFactor;
        }
        if (p.isBot && p.role === 'hunter') {
            speed = PLAYER_SPEED * (0.8 + 0.3 * (p.aiDifficulty || 0.7));
        }
        if (p.role === 'hunter' && this.phase === 'RECON') {
            speed = PLAYER_SPEED * 1.6;
        }

        p.vx = 0; p.vy = 0;
        if (p.input.up)    p.vy -= speed;
        if (p.input.down)  p.vy += speed;
        if (p.input.left)  p.vx -= speed;
        if (p.input.right) p.vx += speed;

        if (p.vx !== 0 && p.vy !== 0) {
            const len = Math.sqrt(p.vx * p.vx + p.vy * p.vy);
            p.vx = (p.vx / len) * speed;
            p.vy = (p.vy / len) * speed;
        }

        if (p.sprintActive) {
            p.vx *= 2.0;
            p.vy *= 2.0;
        }

        if (p.vx !== 0 || p.vy !== 0) {
            if (p.role === 'prop' && p.disguised) {
                // Snap à 90° si déguisé
                p.angle = Math.round(Math.atan2(p.vy, p.vx) / (Math.PI / 2)) * (Math.PI / 2);
            } else {
                p.angle = Math.atan2(p.vy, p.vx);
            }
        }

        p.x += p.vx;
        p.y += p.vy;

        const pad = 30;
        p.x = Math.max(pad, Math.min(this.mapSize.w - pad, p.x));
        p.y = Math.max(pad, Math.min(this.mapSize.h - pad, p.y));

        // Collision avec les portes de confinement fermées
        for (const door of this.doors) {
            if (door.open) continue;
            const halfW = door.w / 2;
            const halfH = door.h / 2;
            const closestX = Math.max(door.x - halfW, Math.min(p.x, door.x + halfW));
            const closestY = Math.max(door.y - halfH, Math.min(p.y, door.y + halfH));
            const dx = p.x - closestX;
            const dy = p.y - closestY;
            const distSq = dx * dx + dy * dy;
            const radius = p.disguised ? (p.disguiseRadius || 18) : 18;
            if (distSq < radius * radius && distSq > 0) {
                const dist = Math.sqrt(distSq);
                const overlap = radius - dist;
                p.x += (dx / dist) * overlap;
                p.y += (dy / dist) * overlap;
            } else if (distSq === 0) {
                p.y -= radius;
            }
        }

        // Collision avec les props
        for (const prop of this.props) {
            const dx      = p.x - prop.x;
            const dy      = p.y - prop.y;
            const minDist = prop.radius + 18;
            const distSq  = dx * dx + dy * dy;
            if (distSq < minDist * minDist && distSq > 0) {
                const dist    = Math.sqrt(distSq);
                const overlap = minDist - dist;
                p.x += (dx / dist) * overlap;
                p.y += (dy / dist) * overlap;
            }
        }
    }

    // ─── Disguise ───────────────────────────────
    handleDisguise(socketId, propId) {
        if (this.phase !== 'CACHE' && this.phase !== 'HUNT') return;
        const p = this.players[socketId];
        if (!p || p.role !== 'prop' || p.eliminated) return;
        
        // Allow switching disguise dynamically in CACHE and HUNT phases without restrictions

        const prop = this.props.find(pr => pr.id === propId);
        if (!prop) return;

        const dx = p.x - prop.x;
        const dy = p.y - prop.y;
        if (dx * dx + dy * dy > (DISGUISE_RANGE + prop.radius) ** 2) return;

        p.disguised      = true;
        p.disguiseType   = prop.type;
        p.disguiseAngle  = prop.angle;
        p.disguiseRadius = prop.radius;
        p.possessedPropId = prop.id; // Store possessed prop ID
        p.hasDisguised   = true;

        // Snap player exactly to the prop's center
        p.x = prop.x;
        p.y = prop.y;

        this.io.to(this.roomId).emit('hunterDisguised', { id: socketId, type: prop.type, angle: prop.angle, radius: prop.radius, possessedPropId: prop.id });
    }

    // ─── Tag (chasseur) ─────────────────────────
    handleHunterTag(socketId, clickX, clickY) {
        if (this.phase !== 'HUNT') return;
        if (socketId !== this.hunterId) return;

        // Cherche si un fantôme est touché
        let hitProp = null;
        let hitId   = null;
        let minDist = Infinity;

        for (const [id, p] of Object.entries(this.players)) {
            if (p.role !== 'prop' || p.eliminated) continue;
            const dx   = clickX - p.x;
            const dy   = clickY - p.y;
            const hitR = p.disguised ? (p.disguiseRadius || 22) : 36;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist <= hitR && dist < minDist) {
                minDist = dist;
                hitProp = p;
                hitId   = id;
            }
        }

        if (hitProp) {
            hitProp.lives--;
            if (hitProp.lives <= 0) {
                hitProp.eliminated = true;
                hitProp.disguised  = false;
                this.io.to(this.roomId).emit('hunterEliminated', { id: hitId });
            }
            this.io.to(this.roomId).emit('hunterTagEffect', { x: clickX, y: clickY, result: 'hit' });
            this.io.to(this.roomId).emit('hunterLivesUpdated', { id: hitId, lives: hitProp.lives });

            const propsAlive = Object.values(this.players).filter(pl => pl.role === 'prop' && !pl.eliminated);
            if (propsAlive.length === 0) {
                this.endGame('hunter');
            }
            return;
        }

        // Miss : −5 PV, qu'il ait touché un décor ou le vide
        let hitDecoration = false;
        for (const prop of this.props) {
            const dx = clickX - prop.x;
            const dy = clickY - prop.y;
            if (dx * dx + dy * dy <= (prop.radius + 12) ** 2) {
                hitDecoration = true;
                break;
            }
        }

        this.hunterHealth -= HUNTER_WRONG_PENALTY;
        const reason = hitDecoration ? 'decoy' : 'miss';
        this.io.to(this.roomId).emit('hunterTagEffect', { x: clickX, y: clickY, result: reason });
        this.io.to(this.roomId).emit('hunterHealth', { health: this.hunterHealth, reason });

        if (this.hunterHealth <= 0) {
            this.endGame('props');
        }
    }

    // ─── Powerups ───────────────────────────────
    _handleDroneRecon(socketId) {
        if (socketId !== this.hunterId) return;
        if (this.phase !== 'HUNT') return;
        if (this.hunterPowers.droneUsed) return;
        this.hunterPowers.droneUsed = true;

        const alive = Object.values(this.players).filter(p => p.role === 'prop' && !p.eliminated);
        if (alive.length === 0) return;
        const targetP = alive[Math.floor(Math.random() * alive.length)];

        // Déterminer un point central offset d'une distance de 100px à 300px par rapport au fantôme ciblé
        const offsetDist = 100 + Math.random() * 200;
        const offsetAngle = Math.random() * Math.PI * 2;
        const droneX = targetP.x + Math.cos(offsetAngle) * offsetDist;
        const droneY = targetP.y + Math.sin(offsetAngle) * offsetDist;

        this.droneRevealX = droneX;
        this.droneRevealY = droneY;
        this.droneRevealRadius = 400;
        this.droneRevealEndsAt = Date.now() + 6000;

        this.io.to(this.roomId).emit('hunterDroneReveal', {
            x: droneX,
            y: droneY,
            radius: 400,
            duration: 6000
        });
    }

    _handleSmokeScreen(socketId) {
        const p = this.players[socketId];
        if (!p || p.role !== 'prop' || p.eliminated) return;
        if (this.phase !== 'HUNT') return;
        if (p.smokeUsed) return;
        p.smokeUsed = true;

        const ang = Math.random() * Math.PI * 2;
        const dist = 60 + Math.random() * 100;
        const smokeX = p.x + Math.cos(ang) * dist;
        const smokeY = p.y + Math.sin(ang) * dist;

        const smoke = {
            id: `smoke_${socketId}_${Date.now()}`,
            x: smokeX,
            y: smokeY,
            radius: 250,
            endsAt: Date.now() + 10000
        };
        this.smokes.push(smoke);
        this.io.to(this.roomId).emit('ghostSmokeActive', { x: smokeX, y: smokeY, radius: 250, duration: 10000 });
    }

    _handleSprint(socketId) {
        const p = this.players[socketId];
        if (!p || p.role !== 'prop' || p.eliminated) return;
        if (this.phase !== 'HUNT') return;
        if (p.sprintUsed) return;
        p.sprintUsed = true;
        p.sprintActive = true;
        p.sprintEndsAt = Date.now() + 4000;
        this.io.to(this.roomId).emit('ghostSprintActive', { playerId: socketId, duration: 4000 });
    }

    // ─── Game Loop ──────────────────────────────
    gameLoop() {
        const now = Date.now();
        const dt  = now - this.lastTime;
        this.lastTime = now;

        // Transitions de phase
        if (now >= this.phaseEndsAt) {
            if (this.phase === 'RECON') {
                this._setPhase('CACHE');
            } else if (this.phase === 'CACHE') {
                // Force-déguise les fantômes qui ne l'ont pas fait
                for (const [, p] of Object.entries(this.players)) {
                    if (p.role === 'prop' && !p.eliminated && !p.disguised) {
                        // Reste en avatar militaire = proie facile, pas de forçage
                    }
                }
                this._setPhase('HUNT');
            } else if (this.phase === 'HUNT') {
                this.endGame('props');
                return;
            }
        }

        // Cooldown updates, sprint check and teleporter handling
        for (const [id, p] of Object.entries(this.players)) {
            if (p.eliminated) continue;

            if (p.sprintActive && now >= p.sprintEndsAt) {
                p.sprintActive = false;
            }

            if (this.teleporters && this.teleporters.length > 0) {
                if (!p.teleportReadyAt) p.teleportReadyAt = 0;
                if (now >= p.teleportReadyAt) {
                    for (const tp of this.teleporters) {
                        const dx = p.x - tp.x;
                        const dy = p.y - tp.y;
                        const radius = p.disguised ? (p.disguiseRadius || 18) : 18;
                        const tpRadius = 40;
                        if (dx * dx + dy * dy < (radius + tpRadius) ** 2) {
                            p.x = tp.targetX;
                            p.y = tp.targetY;
                            p.teleportReadyAt = now + 5000;
                            this.io.to(this.roomId).emit('playerTeleported', { playerId: id, x: p.x, y: p.y });
                            break;
                        }
                    }
                }
            }
        }

        // Smoke handling + movement in a single pass over players
        this.smokes = this.smokes.filter(s => now < s.endsAt);
        for (const p of Object.values(this.players)) {
            p.inSmoke = false;
            for (const s of this.smokes) {
                const dx = p.x - s.x;
                const dy = p.y - s.y;
                if (dx * dx + dy * dy < s.radius * s.radius) { p.inSmoke = true; break; }
            }
            if (p.isBot) this._updateBotAI(p, dt);
            this._updateMovement(p);
        }

        // Props periodically give away a noise — interval shrinks as HUNT progresses.
        // Only the hunter hears it, as a proximity-scaled volume (no position is sent).
        if (this.phase === 'HUNT') {
            const huntElapsed = PHASE_DURATIONS.HUNT - Math.max(0, this.phaseEndsAt - now);
            const noiseInterval = Math.max(
                NOISE_MIN_INTERVAL,
                NOISE_START_INTERVAL - (NOISE_START_INTERVAL - NOISE_MIN_INTERVAL) * (huntElapsed / PHASE_DURATIONS.HUNT)
            );
            const hunterP = this.players[this.hunterId];

            for (const [id, p] of Object.entries(this.players)) {
                if (p.role !== 'prop' || p.eliminated) continue;
                if (p.noiseTimer === undefined) p.noiseTimer = NOISE_START_INTERVAL;
                p.noiseTimer -= dt;
                if (p.noiseTimer > 0) continue;
                p.noiseTimer = noiseInterval;

                if (p.socket) p.socket.emit('youMadeNoise');

                if (hunterP) {
                    const dx = p.x - hunterP.x;
                    const dy = p.y - hunterP.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);
                    if (dist <= NOISE_HEAR_RADIUS && hunterP.socket) {
                        const volume = Math.pow(Math.max(0, 1 - dist / NOISE_HEAR_RADIUS), 1.5);
                        hunterP.socket.emit('hunterNoiseHeard', { volume: Math.round(volume * 100) / 100 });
                    }
                }
            }
        }


        this.netTickTimer += dt;
        if (this.netTickTimer >= NET_TICK_MS) {
            this.netTickTimer = 0;
            this.io.to(this.roomId).volatile.emit('hunterState', {
                players:      this._serializePlayers(),
                phase:        this.phase,
                phaseEndsAt:  this.phaseEndsAt,
                remaining:    Math.max(0, this.phaseEndsAt - now),
                hunterHealth: this.hunterHealth,
                doors:        this.doors.map(d => ({ id: d.id, x: d.x, y: d.y, w: d.w, h: d.h, consoleX: d.consoleX, consoleY: d.consoleY, open: d.open })),
                smokes:       this.smokes.map(s => ({ x: s.x, y: s.y, radius: s.radius, remaining: Math.max(0, s.endsAt - now) })),
                droneZone:    (this.droneRevealEndsAt && now < this.droneRevealEndsAt) ? { x: this.droneRevealX, y: this.droneRevealY, radius: this.droneRevealRadius } : null
            });
        }
    }

    _updateBotAI(p, dt) {
        if (p.eliminated) {
            p.input = { up: false, down: false, left: false, right: false };
            return;
        }
        p.aiTagCooldown = Math.max(0, p.aiTagCooldown - dt);
        p.aiPowerupCooldown = Math.max(0, p.aiPowerupCooldown - dt);
        p.aiInspectTimer = Math.max(0, p.aiInspectTimer - dt);

        // Wake up hunter bot instantly if any target is visible close/revealed
        let hasVisibleGhost = false;
        if (p.role === 'hunter' && this.phase === 'HUNT') {
            const detectionDist = 200 + 200 * (p.aiDifficulty || 0.7);
            for (const gp of Object.values(this.players)) {
                if (gp.role !== 'prop' || gp.eliminated) continue;
                const dx = gp.x - p.x;
                const dy = gp.y - p.y;
                const dist = Math.sqrt(dx*dx + dy*dy);
                
                let isMoving = (gp.vx * gp.vx + gp.vy * gp.vy > 0.5) || (gp.input && (gp.input.up || gp.input.down || gp.input.left || gp.input.right));

                let revealedByDrone = false;
                if (this.droneRevealEndsAt && Date.now() < this.droneRevealEndsAt) {
                    const drDx = gp.x - this.droneRevealX;
                    const drDy = gp.y - this.droneRevealY;
                    if (drDx*drDx + drDy*drDy <= this.droneRevealRadius * this.droneRevealRadius) {
                        revealedByDrone = true;
                    }
                }

                let inSmoke = gp.inSmoke;
                let visible = !gp.disguised || revealedByDrone || (isMoving && dist < detectionDist);
                if (inSmoke && !revealedByDrone) {
                    visible = false;
                }
                if (visible) {
                    hasVisibleGhost = true;
                    break;
                }
            }
        }

        if (hasVisibleGhost) {
            p.aiInspectTimer = 0;
        }

        if (p.aiInspectTimer > 0) {
            p.input = { up: false, down: false, left: false, right: false };
            return;
        }

        if (this.phase === 'RECON') {
            if (p.role === 'hunter') {
                if (p.aiTimer === undefined || p.aiTimer <= 0) {
                    p.aiTimer = 1000 + Math.random() * 2000;
                    p.aiTargetX = Math.random() * (this.mapSize.w - 200) + 100;
                    p.aiTargetY = Math.random() * (this.mapSize.h - 200) + 100;
                }
                p.aiTimer -= dt;
                this._botMoveTowards(p, p.aiTargetX, p.aiTargetY);
            } else {
                p.input = { up: false, down: false, left: false, right: false };
            }
        } 
        else if (this.phase === 'CACHE') {
            if (p.role === 'prop') {
                if (!p.disguised) {
                    if (!p.aiTargetPropId) {
                        const targetedIds = new Set();
                        for (const op of Object.values(this.players)) {
                            if (op.role === 'prop' && op !== p && op.aiTargetPropId) {
                                targetedIds.add(op.aiTargetPropId);
                            }
                        }

                        const candidates = [];
                        for (const prop of this.props) {
                            if (targetedIds.has(prop.id)) continue;
                            const dx = prop.x - p.x;
                            const dy = prop.y - p.y;
                            const dist = dx * dx + dy * dy;
                            candidates.push({ prop, dist });
                        }

                        candidates.sort((a, b) => a.dist - b.dist);

                        const chosen = candidates[Math.floor(Math.random() * Math.min(3, candidates.length))];
                        if (chosen) {
                            p.aiTargetPropId = chosen.prop.id;
                            p.aiTargetX = chosen.prop.x;
                            p.aiTargetY = chosen.prop.y;
                        } else if (this.props.length > 0) {
                            const fallback = this.props[Math.floor(Math.random() * this.props.length)];
                            p.aiTargetPropId = fallback.id;
                            p.aiTargetX = fallback.x;
                            p.aiTargetY = fallback.y;
                        }
                    }
                    if (p.aiTargetX) {
                        this._botMoveTowards(p, p.aiTargetX, p.aiTargetY);
                        const dx = p.x - p.aiTargetX;
                        const dy = p.y - p.aiTargetY;
                        if (dx*dx + dy*dy <= 55 * 55) {
                            const botKey = Object.keys(this.players).find(k => this.players[k] === p);
                            if (botKey) this.handleDisguise(botKey, p.aiTargetPropId);
                        }
                    }
                } else {
                    p.input = { up: false, down: false, left: false, right: false };
                }
            } else {
                p.input = { up: false, down: false, left: false, right: false };
            }
        } 
        else if (this.phase === 'HUNT') {
            const botKey = Object.keys(this.players).find(k => this.players[k] === p);
            if (!botKey) return;

            if (p.role === 'hunter') {
                const aliveGhosts = Object.entries(this.players)
                    .filter(([id, gp]) => gp.role === 'prop' && !gp.eliminated)
                    .map(([id, gp]) => {
                        const dx = gp.x - p.x;
                        const dy = gp.y - p.y;
                        const dist = Math.sqrt(dx*dx + dy*dy);
                        
                        let isMoving = (gp.vx * gp.vx + gp.vy * gp.vy > 0.5) || (gp.input && (gp.input.up || gp.input.down || gp.input.left || gp.input.right));

                        let revealedByDrone = false;
                        if (this.droneRevealEndsAt && Date.now() < this.droneRevealEndsAt) {
                            const drDx = gp.x - this.droneRevealX;
                            const drDy = gp.y - this.droneRevealY;
                            if (drDx*drDx + drDy*drDy <= this.droneRevealRadius * this.droneRevealRadius) {
                                revealedByDrone = true;
                            }
                        }

                        const detectionDist = 200 + 200 * (p.aiDifficulty || 0.7);
                        let inSmoke = gp.inSmoke;
                        let visible = !gp.disguised || revealedByDrone || (isMoving && dist < detectionDist);
                        if (inSmoke && !revealedByDrone) {
                            visible = false;
                        }

                        return { id, x: gp.x, y: gp.y, disguised: gp.disguised, dist, visible };
                    });

                if (aliveGhosts.length === 0) {
                    p.input = { up: false, down: false, left: false, right: false };
                    return;
                }

                // Powerups usage
                if (p.aiPowerupCooldown <= 0) {
                    if (!this.hunterPowers.droneUsed && Math.random() < 0.003) {
                        this._handleDroneRecon(botKey);
                        p.aiPowerupCooldown = 4000;
                    }
                }

                const visibleGhosts = aliveGhosts.filter(g => g.visible);
                p.aiState = p.aiState || 'PATROL'; // PATROL | CHASE | SEARCH

                if (visibleGhosts.length > 0) {
                    visibleGhosts.sort((a, b) => a.dist - b.dist);
                    const chaseTarget = visibleGhosts[0];
                    p.aiState = 'CHASE';
                    p.aiTargetGhostId = chaseTarget.id;
                    p.aiLastKnownX = chaseTarget.x;
                    p.aiLastKnownY = chaseTarget.y;
                }

                if (p.aiState === 'CHASE') {
                    const currentTarget = aliveGhosts.find(g => g.id === p.aiTargetGhostId);
                    if (currentTarget && currentTarget.visible) {
                        this._botMoveTowards(p, currentTarget.x, currentTarget.y);
                        
                        p.aiLastKnownX = currentTarget.x;
                        p.aiLastKnownY = currentTarget.y;

                        if (currentTarget.dist <= 75 && p.aiTagCooldown <= 0) {
                            this.handleHunterTag(botKey, currentTarget.x, currentTarget.y);
                            p.aiTagCooldown = 1200;
                        }
                    } else {
                        // Target lost, go search last known position
                        p.aiState = 'SEARCH';
                        p.aiTimer = 4000; // max search time
                    }
                }
                
                if (p.aiState === 'SEARCH') {
                    if (p.aiLastKnownX === undefined) {
                        p.aiState = 'PATROL';
                    } else {
                        this._botMoveTowards(p, p.aiLastKnownX, p.aiLastKnownY);
                        
                        const dx = p.aiLastKnownX - p.x;
                        const dy = p.aiLastKnownY - p.y;
                        const dist = Math.sqrt(dx*dx + dy*dy);
                        p.aiTimer = (p.aiTimer || 4000) - dt;

                        if (dist < 40 || p.aiTimer <= 0) {
                            // Inspect and shoot the closest prop/disguised player in the area
                            let closestProp = null;
                            let minDist = Infinity;

                            const candidates = [
                                ...this.props.map(pr => ({ x: pr.x, y: pr.y, id: pr.id, isPlayer: false })),
                                ...Object.entries(this.players)
                                    .filter(([id, pl]) => pl.role === 'prop' && !pl.eliminated && pl.disguised)
                                    .map(([id, pl]) => ({ x: pl.x, y: pl.y, id, isPlayer: true }))
                            ];

                            for (const cand of candidates) {
                                const pdx = cand.x - p.x;
                                const pdy = cand.y - p.y;
                                const pdist = pdx*pdx + pdy*pdy;
                                if (pdist < minDist) {
                                    minDist = pdist;
                                    closestProp = cand;
                                }
                            }

                            if (closestProp && minDist < 150*150 && p.aiTagCooldown <= 0) {
                                let shootChance = 0.25;
                                if (closestProp.isPlayer) {
                                    shootChance = 0.3 + 0.4 * (p.aiDifficulty || 0.7); // high chance to shoot players
                                } else {
                                    // lower chance to shoot static props if smart
                                    shootChance = 0.05 + 0.15 * (1 - (p.aiDifficulty || 0.7)); 
                                }

                                if (Math.random() < shootChance) {
                                    this.handleHunterTag(botKey, closestProp.x, closestProp.y);
                                    p.aiTagCooldown = 1500;
                                }
                            }
                            
                            p.aiInspectTimer = 600; // pause for 0.6s
                            p.aiState = 'PATROL';
                            p.aiTargetX = undefined;
                        }
                    }
                }

                if (p.aiState === 'PATROL') {
                    if (p.aiTargetX === undefined || p.aiTimer === undefined || p.aiTimer <= 0) {
                        const randomProp = this.props[Math.floor(Math.random() * this.props.length)];
                        if (randomProp) {
                            p.aiTargetX = randomProp.x;
                            p.aiTargetY = randomProp.y;
                        } else {
                            p.aiTargetX = Math.random() * this.mapSize.w;
                            p.aiTargetY = Math.random() * this.mapSize.h;
                        }
                        p.aiTimer = 6000 + Math.random() * 6000;
                    }
                    
                    p.aiTimer -= dt;
                    this._botMoveTowards(p, p.aiTargetX, p.aiTargetY);

                    // Chance to inspect a close prop or disguised ghost while patrolling
                    const closePropsAndGhosts = [
                        ...this.props.map(pr => ({ x: pr.x, y: pr.y, id: pr.id, isPlayer: false })),
                        ...Object.entries(this.players)
                            .filter(([id, pl]) => pl.role === 'prop' && !pl.eliminated && pl.disguised)
                            .map(([id, pl]) => ({ x: pl.x, y: pl.y, id, isPlayer: true }))
                    ].filter(item => {
                        // If it's a memorized prop, the hunter completely ignores it (no suspicion)
                        if (p.aiMemorizedPropIds && p.aiMemorizedPropIds.includes(item.id)) {
                            return false;
                        }
                        const dx = item.x - p.x;
                        const dy = item.y - p.y;
                        return dx*dx + dy*dy < 95*95;
                    });

                    // Probability of inspection scales with difficulty
                    const inspectProb = 0.005 + 0.01 * (p.aiDifficulty || 0.7);

                    if (closePropsAndGhosts.length > 0 && Math.random() < inspectProb && p.aiInspectTimer <= 0) {
                        const inspectTarget = closePropsAndGhosts[Math.floor(Math.random() * closePropsAndGhosts.length)];
                        p.aiInspectTimer = 500; // pause 0.5s to inspect
                        
                        let shootChance = 0.20;
                        if (inspectTarget.isPlayer) {
                            shootChance = 0.15 + 0.35 * (p.aiDifficulty || 0.7); // 29% to 46% if player
                        } else {
                            shootChance = 0.05 + 0.15 * (1 - (p.aiDifficulty || 0.7)); // 14% down to 6% if static prop
                        }

                        if (Math.random() < shootChance && p.aiTagCooldown <= 0) {
                            this.handleHunterTag(botKey, inspectTarget.x, inspectTarget.y);
                            p.aiTagCooldown = 1500;
                        }
                    }
                }
            } else {
                // Ghost bot logic
                if (!p.disguised) {
                    let bestProp = null;
                    let minDist = Infinity;
                    
                    // Try to disguise FIRST before considering running away
                    if (p.aiPowerupCooldown <= 0 && !p.hasDisguised) {
                        for (const prop of this.props) {
                            const dx = prop.x - p.x;
                            const dy = prop.y - p.y;
                            const dist = dx*dx + dy*dy;
                            if (dist < minDist) {
                                minDist = dist;
                                bestProp = prop;
                            }
                        }
                        if (bestProp && minDist <= 60*60) {
                            this.handleDisguise(botKey, bestProp.id);
                        } else if (bestProp && minDist <= 200*200) {
                            // Move towards nearest prop to disguise
                            this._botMoveTowards(p, bestProp.x, bestProp.y);
                        }
                    } else if (!bestProp) {
                        // If we already tried to disguise, find best prop for later reference
                        for (const prop of this.props) {
                            const dx = prop.x - p.x;
                            const dy = prop.y - p.y;
                            const dist = dx*dx + dy*dy;
                            if (dist < minDist) {
                                minDist = dist;
                                bestProp = prop;
                            }
                        }
                    }
                    
                    // Only run away if already disguised OR no prop available AND hunter is close
                    if (this.phase === 'CACHE' && (p.hasDisguised || !bestProp)) {
                        const hunter = Object.values(this.players).find(hp => hp.role === 'hunter');
                        if (hunter) {
                            const hdx = p.x - hunter.x;
                            const hdy = p.y - hunter.y;
                            const hdist = Math.sqrt(hdx*hdx + hdy*hdy);
                            if (hdist < 350) {
                                const escapeAngle = Math.atan2(hdy, hdx);
                                const escapeX = p.x + Math.cos(escapeAngle) * 200;
                                const escapeY = p.y + Math.sin(escapeAngle) * 200;
                                this._botMoveTowards(p, escapeX, escapeY);
                            }
                        }
                    } else {
                        // Standing still during HUNT phase if temporarily undisguised
                        p.input = { up: false, down: false, left: false, right: false };
                    }
                } else {
                    if (p.aiPanicTimer === undefined) p.aiPanicTimer = 0;
                    if (p.aiPanicTimer > 0) {
                        p.aiPanicTimer -= 1 / 60;
                        const hunter = Object.values(this.players).find(hp => hp.role === 'hunter');
                        if (hunter) {
                            const hdx = p.x - hunter.x;
                            const hdy = p.y - hunter.y;
                            const hdist = Math.sqrt(hdx * hdx + hdy * hdy);
                            if (hdist > 10) {
                                p.input.up    = hdy < 0;
                                p.input.down  = hdy > 0;
                                p.input.left  = hdx < 0;
                                p.input.right = hdx > 0;
                            } else {
                                p.input = { up: false, down: false, left: false, right: false };
                            }
                            if (hdist < 180) {
                                if (!p.smokeUsed && Math.random() < 0.02) {
                                    this._handleSmokeScreen(botKey);
                                }
                                if (!p.sprintUsed && Math.random() < 0.05) {
                                    this._handleSprint(botKey);
                                }
                            }
                        } else {
                            p.input = { up: false, down: false, left: false, right: false };
                        }
                    } else {
                        p.input = { up: false, down: false, left: false, right: false };
                        const hunter = Object.values(this.players).find(hp => hp.role === 'hunter');
                        if (hunter) {
                            const hdx = p.x - hunter.x;
                            const hdy = p.y - hunter.y;
                            const hdistSq = hdx * hdx + hdy * hdy;
                            if (hdistSq < 180 * 180 && Math.random() < 0.01) {
                                if (Math.random() < 0.6) {
                                    p.aiPanicTimer = 3.0 + Math.random() * 2.0;
                                } else {
                                    p.aiPanicTimer = -2.0;
                                }
                            }
                        }
                    }
                    if (p.aiPanicTimer < 0) {
                        p.aiPanicTimer = Math.min(0, p.aiPanicTimer + 1/60);
                    }
                }
            }
        }
    }

    _botMoveTowards(p, tx, ty) {
        const dx = tx - p.x;
        const dy = ty - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 10) {
            p.input.left  = false;
            p.input.right = false;
            p.input.up    = false;
            p.input.down  = false;
            return;
        }

        let targetX = tx;
        let targetY = ty;

        const vx = dx / dist;
        const vy = dy / dist;

        let closestObstacle = null;
        let closestProj = Infinity;
        const avoidDist = 110; 

        for (const prop of this.props) {
            if (p.role === 'prop' && prop.id === p.aiTargetPropId) continue;

            const pdx = prop.x - p.x;
            const pdy = prop.y - p.y;
            const proj = pdx * vx + pdy * vy;

            if (proj > 5 && proj < avoidDist) {
                const perpSq = (pdx - proj * vx) ** 2 + (pdy - proj * vy) ** 2;
                const threatRadius = prop.radius + 24; 
                if (perpSq < threatRadius * threatRadius) {
                    if (proj < closestProj) {
                        closestProj = proj;
                        closestObstacle = prop;
                    }
                }
            }
        }

        if (closestObstacle) {
            const perpX = -vy;
            const perpY = vx;

            const pdx = closestObstacle.x - p.x;
            const pdy = closestObstacle.y - p.y;
            const dotPerp = pdx * perpX + pdy * perpY;

            let steerDir = p.aiSteerDir;
            if (p.aiSteerTargetId !== closestObstacle.id || steerDir === undefined) {
                steerDir = dotPerp > 0 ? -1 : 1;
                p.aiSteerDir = steerDir;
                p.aiSteerTargetId = closestObstacle.id;
            }
            
            targetX = p.x + vx * (closestProj - 15) + perpX * steerDir * (closestObstacle.radius + 35);
            targetY = p.y + vy * (closestProj - 15) + perpY * steerDir * (closestObstacle.radius + 35);
        } else {
            p.aiSteerTargetId = null;
            p.aiSteerDir = undefined;
        }

        const ndx = targetX - p.x;
        const ndy = targetY - p.y;
        p.input.left  = ndx < -8;
        p.input.right = ndx > 8;
        p.input.up    = ndy < -8;
        p.input.down  = ndy > 8;
    }

    _serializePlayers() {
        const out = {};
        for (const [id, p] of Object.entries(this.players)) {
            out[id] = {
                x:            Math.round(p.x),
                y:            Math.round(p.y),
                angle:         Math.round(p.angle * 100) / 100,
                role:          p.role,
                disguised:     p.disguised,
                disguiseType:  p.disguiseType,
                disguiseAngle: p.disguiseAngle,
                disguiseRadius:p.disguiseRadius,
                possessedPropId: p.possessedPropId || null,
                eliminated:    p.eliminated,
                lives:         p.lives,
                avatar:       p.avatar,
                num:          p.playerNum,
                // powerup status
                hasDisguised: p.hasDisguised,
                smokeUsed:    p.smokeUsed || false,
                sprintUsed:   p.sprintUsed || false,
                sprintActive: p.sprintActive || false,
                inSmoke:      p.inSmoke || false,
                name:         p.name
            };
        }
        return out;
    }

    // ─── End / Reset ────────────────────────────
    endGame(winner) {
        this.state = 'GAME_OVER';
        if (this.interval) clearInterval(this.interval);
        for (const p of Object.values(this.players)) p.isReady = false;
        this.io.to(this.roomId).emit('hunterGameOver', { winner });
    }

    resetToLobby() {
        if (this.state !== 'GAME_OVER') return;
        this.stopCountdown();
        this.state = 'LOBBY';
        this.phase = 'LOBBY';
        if (this.interval) clearInterval(this.interval);

        // Supprimer les bots du lobby pour laisser la place aux humains
        for (const id of Object.keys(this.players)) {
            if (this.players[id].isBot) {
                delete this.players[id];
            }
        }

        for (const p of Object.values(this.players)) {
            p.isReady      = false;
            p.eliminated   = false;
            p.disguised    = false;
            p.disguiseType = null;
            p.hasDisguised = false;
            p.smokeUsed    = false;
            p.sprintUsed   = false;
            p.sprintActive = false;
            p.sprintEndsAt = 0;
            p.teleportReadyAt = 0;
        }
        this.io.to(this.roomId).emit('roomStatus', this.getLobbyStatus());
        this.broadcastCountdown();
    }

    handleDisconnect(socketId) {
        const p = this.players[socketId];
        if (!p) return;

        const wasInGame = this.state === 'PLAYING';

        migrateHostOnDisconnect(this, socketId);

        // Grace period during game for human players
        if (wasInGame && !p.isBot && p.sessionToken) {
            p.input = { up: false, down: false, left: false, right: false };
            startGracePeriod(this, socketId, p, true);
            return;
        }

        delete this.players[socketId];
        this._checkAfterRemoval(socketId, wasInGame);
    }

    _checkAfterRemoval(socketId, wasInGame) {
        if (cleanupRoomIfEmpty(this)) return;

        if (wasInGame) {
            if (socketId === this.hunterId) {
                this.endGame('props');
            } else {
                const propsAlive = Object.values(this.players).filter(p => p.role === 'prop' && !p.eliminated);
                if (propsAlive.length === 0) this.endGame('hunter');
            }
        } else if (this.state === 'LOBBY' || this.state === 'COUNTDOWN') {
            if (this.state === 'COUNTDOWN') this.broadcastCountdown();
            this.io.to(this.roomId).emit('roomStatus', this.getLobbyStatus());
        }
    }

    rejoinPlayer(newSocket, oldSocketId) {
        const p = beginRejoin(this, newSocket, oldSocketId);
        if (!p) return;
        if (this.hunterId === oldSocketId) this.hunterId = newSocket.id;

        resumeLoopIfPaused(this, FPS);

        newSocket.join(this.roomId);
        this._bindSocket(newSocket);

        newSocket.emit('rejoinSuccess', {
            mode: 'hunter',
            sessionToken: this.players[newSocket.id].sessionToken,
            roomCode: this.roomId,
            isHunter: true,
            role: p.role,
            phase: this.phase,
            remaining: Math.max(0, this.phaseEndsAt - Date.now()),
            hunterHealth: this.hunterHealth,
            hunterId: this.hunterId,
            theme: this.theme,
            mapSize: this.mapSize,
            props: this.props,
            seed: this.seed,
            roles: this._getRolesPayload(),
            teleporters: this.teleporters
        });

        this.io.to(this.roomId).emit('playerRejoined', { socketId: newSocket.id, oldSocketId });
    }
}

module.exports = { HunterRoom, HUNTER_MAPS, BIOME_POOLS };
