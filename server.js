const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const { HunterRoom, HUNTER_MAPS } = require('./hunter-room');

app.use(express.static(path.join(__dirname, 'public')));

// Global Game Settings matching the frontend concepts
// Global Game Settings
const TAG_RANGE = 200;
const REVEAL_DURATION = 3000;
const FPS = 60;
const STARTING_LIVES = 3;

// Active rooms storage
const rooms = {};
const hunterRooms = {};

// Utility
const rand = (min, max) => Math.random() * (max - min) + min;

// Seeded PRNG (mulberry32) for shared map generation
function mulberry32(a) {
    return function() {
        let t = a += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
}

function randSeeded(rng, min, max) {
    return rng() * (max - min) + min;
}

// Generate hunter-mode objects given a seed and map size
function generateHunterObjects(seed, mapSize, count) {
    const rng = mulberry32(seed >>> 0);
    const pool = [
        { type: 'crate_small', size: 28 },
        { type: 'crate_med', size: 42 },
        { type: 'crate_large', size: 60 },
        { type: 'barrel', size: 36 },
        { type: 'extinguisher', size: 30 },
        { type: 'cone', size: 20 },
        { type: 'pallet', size: 48 },
        { type: 'generator', size: 50 },
        { type: 'toolbox', size: 26 }
    ];

    const out = [];
    const minSpacing = 60;
    let attempts = 0;
    while (out.length < count && attempts < count * 12) {
        attempts++;
        const pick = pool[Math.floor(rng() * pool.length)];
        const x = Math.floor(randSeeded(rng, 100, mapSize.w - 100));
        const y = Math.floor(randSeeded(rng, 100, mapSize.h - 100));

        // ensure spacing
        let ok = true;
        for (const o of out) {
            const dx = o.x - x;
            const dy = o.y - y;
            if (dx * dx + dy * dy < (minSpacing + o.size) * (minSpacing + o.size)) { ok = false; break; }
        }
        if (!ok) continue;

        out.push({ id: `obj_${out.length}_${Math.floor(rng()*1e6)}`, type: pick.type, x, y, size: pick.size, animated: false });
    }

    // add 2-3 animated decoys
    const animatedCount = Math.max(2, Math.min(3, Math.floor(rng() * 4)));
    for (let i = 0; i < animatedCount && i < out.length; i++) {
        out[i].animated = true; // first ones are animated for confusion
    }
    return out;
}

const INDUSTRIAL_THEMES = ['Military Base', 'Forest', 'Arcade Grid'];
const WAREHOUSE_THEMES = ['Weapon Warehouse', 'Cave', 'Toy Factory'];
const COMMAND_THEMES = ['Command Center', 'Desert', 'Micro-Circuit'];

function getMapRule(theme) {
    if (WAREHOUSE_THEMES.includes(theme)) return 'alarm';
    if (COMMAND_THEMES.includes(theme)) return 'radar';
    return 'sync';
}

// Generate 4 letter code
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

class Entity {
    constructor(id, isPlayer, playerNum = 0, avatarType = "Combat-Operative") {
        this.id = id;
        this.isPlayer = isPlayer;
        this.playerNum = playerNum;
        this.avatarType = avatarType;

        this.x = rand(0, 500); // Will be randomized properly when spawning
        this.y = rand(0, 500);
        this.vx = 0;
        this.vy = 0;
        this.angle = rand(0, Math.PI * 2);
        this.targetAngle = this.angle;

        this.size = 35;
        this.baseColor = this.getBotColor();
        this.color = this.baseColor;
        this.revealedUntil = 0;
        this.stationaryTime = 0;

        // AI State
        this.aiState = 'IDLE';
        this.aiTimer = rand(500, 2000);
        this.aiSpeed = rand(1, 3);

        // Player Input State
        this.input = { up: false, down: false, left: false, right: false };
        this.isGhost = false; // hunter mode: ghost player
        this.isHunter = false;
        this.isDisguised = false;
        this.disguiseObjectId = null;
        this.hasDisguisedOnce = false;
    }

    getBotColor() {
        const colors = ['#c93b2b', '#5b7a54', '#bfa26f', '#4f758c'];
        return colors[Math.floor(Math.random() * colors.length)];
    }

    update(dt, mapSize, rockDecorations, bushDecorations, allEntities, room) {
        const frozen = room && room.isAlarmFreeze;
        if (!frozen) {
            if (this.isPlayer && !this.isBotPlayer) {
                this.updatePlayerInput(room);
            } else if (this.isBotPlayer) {
                this.updateBotPlayerAI(dt, mapSize, allEntities, room);
            } else {
                this.updateAILogic(dt, mapSize, room);
            }
        } else {
            this.vx = 0;
            this.vy = 0;
        }

        if (this.vx !== 0 || this.vy !== 0) {
            this.targetAngle = Math.atan2(this.vy, this.vx);
        }

        // Lerp angle
        let dAngle = this.targetAngle - this.angle;
        while (dAngle > Math.PI) dAngle -= Math.PI * 2;
        while (dAngle < -Math.PI) dAngle += Math.PI * 2;
        this.angle += dAngle * 0.1;

        this.x += this.vx;
        this.y += this.vy;

        // Resolve collisions with ROCK decorations (squared distance avoids sqrt)
        for (const d of rockDecorations) {
            const dx = this.x - d.x;
            const dy = this.y - d.y;
            const minDist = this.size + d.radius;
            const distSq = dx * dx + dy * dy;
            const minDistSq = minDist * minDist;
            if (distSq < minDistSq) {
                const dist = Math.sqrt(distSq); // only when actually colliding
                const overlap = minDist - dist;
                if (dist > 0) {
                    this.x += (dx / dist) * overlap;
                    this.y += (dy / dist) * overlap;
                } else {
                    this.x += minDist;
                }
                if (!this.isPlayer) {
                    this.targetAngle = Math.atan2(dy, dx) + rand(-0.5, 0.5);
                }
            }
        }

        // Clamp to map bounds
        if (this.x < this.size) this.x = this.size;
        else if (this.x > mapSize.w - this.size) this.x = mapSize.w - this.size;
        if (this.y < this.size) this.y = this.size;
        else if (this.y > mapSize.h - this.size) this.y = mapSize.h - this.size;

        // Bush check (squared distance)
        this.inBush = false;
        for (const d of bushDecorations) {
            const dx = this.x - d.x;
            const dy = this.y - d.y;
            if (dx * dx + dy * dy < d.radiusSq) {
                this.inBush = true;
                break;
            }
        }

        // Reveal state
        const now = Date.now();
        if (now < this.revealedUntil) {
            this.isRevealed = true;
        } else {
            this.isRevealed = false;
        }

        // Track stationary time
        const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (speed < 0.2) {
            this.stationaryTime = (this.stationaryTime || 0) + dt;
        } else {
            this.stationaryTime = 0;
        }
    }

    updatePlayerInput(room) {
        this.vx = 0;
        this.vy = 0;
        let speed = 3;

        // Hunter-mode constraints: ghosts immobilized during RECON
        if (room && room.gameMode === 'hunter' && this.isGhost) {
            const phase = room.hunterPhase || 'RECON';
            if (phase === 'RECON') {
                // immobilized
                return;
            }
            // if disguised, move slower
            if (this.isDisguised) speed *= 0.4;
        }

        if (this.input.up) this.vy -= speed;
        if (this.input.down) this.vy += speed;
        if (this.input.left) this.vx -= speed;
        if (this.input.right) this.vx += speed;

        if (this.vx !== 0 && this.vy !== 0) {
            const len = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
            this.vx = (this.vx / len) * speed;
            this.vy = (this.vy / len) * speed;
        }
    }

    updateAILogic(dt, mapSize, room) {
        // 1. Sync Event Reaction Delay
        if (room && room.isSyncEventActive) {
            if (!this.isSyncing) {
                if (this.syncReactionTimer === undefined || this.syncReactionTimer <= 0) {
                    this.syncReactionTimer = rand(300, 800);
                }
                this.syncReactionTimer -= dt;
                if (this.syncReactionTimer <= 0) {
                    this.isSyncing = true;
                    this.aiState = 'SYNC';
                    this.targetAngle = room.syncAngle || 0;
                    this.aiSpeed = room.syncSpeed || 3;
                }
            }
        } else {
            if (this.isSyncing) {
                if (this.desyncReactionTimer === undefined || this.desyncReactionTimer <= 0) {
                    this.desyncReactionTimer = rand(250, 600);
                }
                this.desyncReactionTimer -= dt;
                if (this.desyncReactionTimer <= 0) {
                    this.isSyncing = false;
                    this.aiState = 'IDLE';
                    this.aiTimer = rand(500, 1500);
                }
            }
        }

        if (this.aiState === 'SYNC') {
            this.vx = Math.cos(this.targetAngle) * this.aiSpeed;
            this.vy = Math.sin(this.targetAngle) * this.aiSpeed;

            if (this.x + this.vx < this.size || this.x + this.vx > mapSize.w - this.size) this.targetAngle = Math.PI - this.targetAngle;
            if (this.y + this.vy < this.size || this.y + this.vy > mapSize.h - this.size) this.targetAngle = -this.targetAngle;
            return;
        }

        this.aiTimer -= dt;

        if (this.aiTimer <= 0) {
            if (this.aiState === 'IDLE') {
                this.aiState = 'MOVING';
                this.aiTimer = rand(1000, 3000);
                this.targetAngle = rand(0, Math.PI * 2);
                this.aiSpeed = rand(1.5, 3.5);
            } else {
                this.aiState = 'IDLE';
                this.aiTimer = rand(1000, 2000);
            }
        }

        if (this.aiState === 'MOVING') {
            this.vx = Math.cos(this.targetAngle) * this.aiSpeed;
            this.vy = Math.sin(this.targetAngle) * this.aiSpeed;

            if (this.x + this.vx < this.size || this.x + this.vx > mapSize.w - this.size) this.targetAngle = Math.PI - this.targetAngle;
            if (this.y + this.vy < this.size || this.y + this.vy > mapSize.h - this.size) this.targetAngle = -this.targetAngle;
        } else {
            this.vx *= 0.8;
            this.vy *= 0.8;
        }
    }

    updateBotPlayerAI(dt, mapSize, allEntities, room) {
        // 1. Sync Event Reaction Delay
        if (room && room.isSyncEventActive) {
            if (!this.isSyncing) {
                if (this.syncReactionTimer === undefined || this.syncReactionTimer <= 0) {
                    this.syncReactionTimer = rand(300, 800);
                }
                this.syncReactionTimer -= dt;
                if (this.syncReactionTimer <= 0) {
                    this.isSyncing = true;
                    this.aiState = 'SYNC';
                    this.targetAngle = room.syncAngle || 0;
                    this.aiSpeed = room.syncSpeed || 3;
                }
            }
        } else {
            if (this.isSyncing) {
                if (this.desyncReactionTimer === undefined || this.desyncReactionTimer <= 0) {
                    this.desyncReactionTimer = rand(250, 600);
                }
                this.desyncReactionTimer -= dt;
                if (this.desyncReactionTimer <= 0) {
                    this.isSyncing = false;
                    this.aiState = 'IDLE';
                    this.aiTimer = rand(500, 1500);
                }
            }
        }

        // If syncing, move along and return
        if (this.aiState === 'SYNC') {
            this.vx = Math.cos(this.targetAngle) * this.aiSpeed;
            this.vy = Math.sin(this.targetAngle) * this.aiSpeed;

            if (this.x + this.vx < this.size || this.x + this.vx > mapSize.w - this.size) this.targetAngle = Math.PI - this.targetAngle;
            if (this.y + this.vy < this.size || this.y + this.vy > mapSize.h - this.size) this.targetAngle = -this.targetAngle;
            return;
        }

        // Hunt items (hearts/shapeshifts) if nearby
        let targetItem = null;
        let minItemDist = 180;
        if (room && room.items) {
            for (const item of room.items) {
                const dx = item.x - this.x;
                const dy = item.y - this.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < minItemDist) {
                    minItemDist = dist;
                    targetItem = item;
                }
            }
        }

        if (targetItem) {
            const dx = targetItem.x - this.x;
            const dy = targetItem.y - this.y;
            this.targetAngle = Math.atan2(dy, dx);
            this.aiState = 'MOVING';
            this.vx = Math.cos(this.targetAngle) * 3; // move faster to item
            this.vy = Math.sin(this.targetAngle) * 3;
            this.aiTimer = 100; // prevent idle state immediately
        } else {
            // Decide if we should hunt a player or walk randomly
            if (this.huntTimer === undefined) {
                this.huntTimer = 0;
            }
            this.huntTimer -= dt;

            if (this.huntTimer <= 0) {
                this.huntTimer = rand(4000, 8000); // choose new hunt target every 4-8s
                
                // 65% chance to hunt a player
                if (Math.random() < 0.65 && room) {
                    const targets = Object.keys(room.players).filter(id => id !== this.id && room.players[id].lives > 0);
                    if (targets.length > 0) {
                        const targetId = targets[Math.floor(Math.random() * targets.length)];
                        this.huntTargetId = targetId;
                    }
                } else {
                    this.huntTargetId = null;
                }
            }

            let isHunting = false;
            if (this.huntTargetId && allEntities) {
                const targetEnt = allEntities.find(e => e.id === this.huntTargetId);
                if (targetEnt) {
                    const dx = targetEnt.x - this.x;
                    const dy = targetEnt.y - this.y;
                    const dist = Math.sqrt(dx * dx + dy * dy);

                    if (dist > 150) {
                        this.targetAngle = Math.atan2(dy, dx) + rand(-0.35, 0.35); // human-like tracking deviation
                        this.aiState = 'MOVING';
                        this.vx = Math.cos(this.targetAngle) * this.aiSpeed;
                        this.vy = Math.sin(this.targetAngle) * this.aiSpeed;
                        this.aiTimer = 200; // override random walk timer
                        isHunting = true;
                    }
                }
            }

            if (!isHunting) {
                // Standard random walking
                this.aiTimer -= dt;
                if (this.aiTimer <= 0) {
                    if (this.aiState === 'IDLE') {
                        this.aiState = 'MOVING';
                        this.aiTimer = rand(1000, 3000);
                        this.targetAngle = rand(0, Math.PI * 2);
                        this.aiSpeed = rand(1.5, 3.5);
                    } else {
                        this.aiState = 'IDLE';
                        this.aiTimer = rand(1000, 2000);
                    }
                }

                if (this.aiState === 'MOVING') {
                    this.vx = Math.cos(this.targetAngle) * this.aiSpeed;
                    this.vy = Math.sin(this.targetAngle) * this.aiSpeed;

                    if (this.x + this.vx < this.size || this.x + this.vx > mapSize.w - this.size) this.targetAngle = Math.PI - this.targetAngle;
                    if (this.y + this.vy < this.size || this.y + this.vy > mapSize.h - this.size) this.targetAngle = -this.targetAngle;
                } else {
                    this.vx *= 0.8;
                    this.vy *= 0.8;
                }
            }
        }

        // Tagging AI logic
        const mapRule = room ? getMapRule(room.theme) : 'sync';
        if (this.botTagCooldown === undefined) {
            this.botTagCooldown = mapRule === 'radar'
                ? rand(6000, 10000)
                : rand(1500, 3500);
        }
        this.botTagCooldown -= dt;
        if (this.botTagCooldown <= 0) {
            this.botTagCooldown = mapRule === 'radar'
                ? rand(8000, 14000)
                : rand(2000, 4500);
            this.attemptBotPlayerTag(allEntities, room);
        }
    }

    attemptBotPlayerTag(allEntities, room) {
        if (!room || !allEntities) return;
        const mapRule = getMapRule(room.theme);
        const tagRange = mapRule === 'radar' ? 150 : 200;
        const scoreThreshold = mapRule === 'radar' ? 10 : 5;
        const candidates = [];
        const now = Date.now();

        for (const ent of allEntities) {
            if (ent.id === this.id) continue;
            const dx = ent.x - this.x;
            const dy = ent.y - this.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            if (dist > tagRange) continue;

            // Radar map: brief immunity after being scanned — time to reach holo cover
            if (mapRule === 'radar' && ent.isPlayer && !ent.isBotPlayer) {
                if (ent.radarTagImmunityUntil && now < ent.radarTagImmunityUntil) continue;
            }

            let score = 1; // base suspicion
            if (ent.isPlayer && !ent.isBotPlayer) {
                score += mapRule === 'radar' ? 1 : 4;
            } else if (ent.isBotPlayer) {
                score += 2;
            }

            const speed = Math.sqrt(ent.vx * ent.vx + ent.vy * ent.vy);
            if (speed > 2.5) score += 3; // suspicious running

            if (ent.stationaryTime > 4000) {
                score += 3; // suspicious camping/AFK behavior
            }

            // Suspicious bush camping
            if (ent.inBush) {
                if (ent.stationaryTime > 2000) {
                    score += 5; // extremely suspicious camping in a bush
                } else {
                    score += 1;
                }
            }

            // suspicious item approach
            let nearItem = false;
            if (room.items) {
                for (const item of room.items) {
                    const idx = item.x - ent.x;
                    const idy = item.y - ent.y;
                    if (idx * idx + idy * idy < 60 * 60) {
                        nearItem = true;
                        break;
                    }
                }
            }
            if (nearItem) score += 4;

            // Stalking / following detection
            if (dist < 120) {
                if (speed > 1) {
                    score += 4;
                    const botSpeed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
                    if (botSpeed > 1) {
                        const angleDiff = Math.abs(ent.angle - this.angle);
                        const normDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));
                        if (Math.abs(normDiff) < 0.6) {
                            score += 5;
                        }
                    }
                }
            }

            if (ent.isRevealed) {
                if (ent.isPlayer) score += 15;
                else score = 0; // revealed decoy is not player
            }

            if (score >= scoreThreshold) {
                candidates.push({ entity: ent, score: score });
            }
        }

        if (candidates.length === 0) return;
        candidates.sort((a, b) => b.score - a.score);
        const target = candidates[0].entity;
        room.handleTagAttempt(this.id, target.x, target.y);
    }

    serialize() {
        return [
            this.id,
            Math.round(this.x),
            Math.round(this.y),
            Math.round(this.angle * 100) / 100,
            this.isRevealed ? 1 : 0,
            Math.round(this.vx * 10) / 10,
            Math.round(this.vy * 10) / 10,
            this.inBush ? 1 : 0,
            this.isPlayer ? 1 : 0,
            this.avatarType,
            this.color
        ];
    }
}

class GameRoom {
    constructor(roomId, hostSocket, isQuickMatch = false) {
        this.roomId = roomId;
        this.players = {}; // socket.id -> { playerNum, socket, lives, isReady, avatar }
        this.entities = [];
        this.state = 'LOBBY'; // LOBBY, COUNTDOWN, PLAYING, GAME_OVER
        this.theme = 'Arcade Grid';
        this.isQuickMatch = isQuickMatch;
        this.isPublic = isQuickMatch;
        this.mapSize = { w: 2000, h: 2000 };
        this.totalEntities = 50;
        this.gameMode = 'classic'; // 'classic' or 'hunter'

        this.items = [];
        this.itemSpawnTimer = rand(2000, 5000);
        for (let i = 0; i < 3; i++) this._spawnStartItem();

        this.syncEventTimer = rand(15000, 30000);
        this.isSyncEventActive = false;
        this.syncEventDuration = 0;

        this.alarmEventTimer = rand(22000, 35000);
        this.alarmPhase = 'idle';
        this.alarmPhaseRemaining = 0;
        this.isAlarmFreeze = false;
        this.freezeSnapshots = null;

        this.radarAngle = 0;

        this.lastTime = Date.now();
        this.interval = null;

        // --- Bot-fill countdown ---
        this.countdownTimer   = null;  // setInterval handle
        this.countdownSeconds = 0;     // current seconds remaining
        this.MAX_COUNTDOWN    = 45;    // seconds to wait before bot-fill
        this.MAX_PLAYERS      = 4;
        this.hostId           = hostSocket.id;

        this.addPlayer(hostSocket, 1);
    }

    addPlayer(socket, num) {
        this.players[socket.id] = {
            socket: socket,
            playerNum: num,
            lives: STARTING_LIVES,
            isReady: false,
            avatar: 'Combat-Operative'
        };

        socket.join(this.roomId);

        // If countdown is running, a new real player joined — extend or reset timer
        if (this.state === 'COUNTDOWN') {
            const extended = Math.min(this.MAX_COUNTDOWN, this.countdownSeconds + 15);
            this.countdownSeconds = extended;
            this.broadcastCountdown();
        } else {
            this.broadcastCountdown();
        }

        // Listeners for this room
        socket.on('playerReady', (data) => {
            if (this.state !== 'LOBBY' && this.state !== 'COUNTDOWN') return;
            const p = this.players[socket.id];
            if (p && !p.isReady) {
                p.isReady = true;
                p.avatar = data.avatar;
                if (p.playerNum === 1 && data.theme) {
                    this.theme = data.theme;
                }
                io.to(this.roomId).emit('roomStatus', this.getLobbyStatus());

                // If room full + all ready → instant start
                const pKeys = Object.keys(this.players);
                const allReady = pKeys.every(k => this.players[k].isReady);
                if (pKeys.length >= this.MAX_PLAYERS && allReady) {
                    this.stopCountdown();
                    this.startGame();
                    return;
                }

                // Start countdown on first ready player (Quick Match only)
                if (this.isQuickMatch) {
                    if (this.state === 'LOBBY') {
                        this.startCountdown();
                    } else {
                        this.broadcastCountdown(); // update ready count in UI
                    }
                } else {
                    this.broadcastCountdown();
                }
            }
        });

        // Allow host to set game mode (e.g., 'hunter')
        socket.on('setGameMode', (mode) => {
            if (this.players[socket.id] && this.players[socket.id].playerNum === 1) {
                this.gameMode = mode;
                io.to(this.roomId).emit('roomStatus', this.getLobbyStatus());
            }
        });

        // Ghost blend request (during CACHE phase)
        socket.on('blendRequest', () => {
            if (this.state !== 'PLAYING') return;
            this.handleBlend(socket.id);
        });

        socket.on('startNow', () => {
            // Host-only force start
            if (socket.id !== this.hostId) return;
            if (this.state !== 'COUNTDOWN' && this.state !== 'LOBBY') return;
            const p = this.players[socket.id];
            if (!p || !p.isReady) return;
            this.stopCountdown();
            this.startGame();
        });

        socket.on('soloTest', (data) => {
            if (this.state !== 'LOBBY' && this.state !== 'COUNTDOWN') return;
            const p = this.players[socket.id];
            if (p) {
                p.isReady = true;
                p.avatar = data.avatar || 'Combat-Operative';
                if (data.theme) this.theme = data.theme;
                this.stopCountdown();
                this.startGame();
            }
        });

        socket.on('input', (inputData) => {
            if (this.state !== 'PLAYING') return;
            const pEnt = this.entities.find(e => e.isPlayer && e.id === socket.id);
            if (pEnt) pEnt.input = inputData;
        });

        socket.on('tagAttempt', (data) => {
            if (this.state !== 'PLAYING') return;
            this.handleTagAttempt(socket.id, data.x, data.y);
        });

        io.to(this.roomId).emit('roomStatus', this.getLobbyStatus());
    }

    // ─── Countdown logic ────────────────────────────────────
    startCountdown() {
        if (this.state !== 'LOBBY') return;
        this.state = 'COUNTDOWN';
        this.countdownSeconds = this.MAX_COUNTDOWN;
        this.broadcastCountdown();

        this.countdownTimer = setInterval(() => {
            this.countdownSeconds--;

            if (this.countdownSeconds <= 0) {
                // Time's up — fill empty slots with bots and go!
                this.stopCountdown();
                // Mark un-ready players as ready with default avatar
                for (const p of Object.values(this.players)) {
                    if (!p.isReady) {
                        p.isReady = true;
                        p.avatar = 'Combat-Operative';
                    }
                }
                // Signal clients: bot fill happening
                io.to(this.roomId).emit('botFill');
                setTimeout(() => this.startGame(), 2000); // 2s drama delay
                return;
            }

            this.broadcastCountdown();
        }, 1000);
    }

    stopCountdown() {
        if (this.countdownTimer) {
            clearInterval(this.countdownTimer);
            this.countdownTimer = null;
        }
        if (this.state === 'COUNTDOWN') this.state = 'LOBBY';
    }

    broadcastCountdown() {
        const humans = Object.values(this.players).filter(p => !p.isBot);
        const slots = Array.from({ length: this.MAX_PLAYERS }, (_, i) => {
            const p = humans[i];
            if (!p) return { type: 'empty' };
            return { type: 'player', ready: p.isReady, num: p.playerNum };
        });
        io.to(this.roomId).emit('lobbyCountdown', {
            seconds: this.isQuickMatch ? this.countdownSeconds : null,
            total: this.MAX_COUNTDOWN,
            slots,
            readyCount: humans.filter(p => p.isReady).length,
            playerCount: humans.length,
            hostId: this.hostId,
            isQuickMatch: this.isQuickMatch
        });
    }

    getLobbyStatus() {
        const humans = Object.values(this.players).filter(p => !p.isBot);
        return {
            roomId: this.roomId,
            playerCount: humans.length,
            readyCount: humans.filter(p => p.isReady).length,
            theme: this.theme,
            isPublic: this.isPublic,
            state: this.state,
            gameMode: this.gameMode || 'classic'
        };
    }

    serializeHunterState() {
        const out = {
            entities: this.entities.map(e => ({
                id: e.id,
                x: Math.round(e.x),
                y: Math.round(e.y),
                angle: Math.round(e.angle * 100) / 100,
                isPlayer: e.isPlayer,
                isHunter: e.isHunter,
                isGhost: e.isGhost,
                isDisguised: e.isDisguised,
                disguiseObjectId: e.disguiseObjectId,
                eliminated: this.players[e.id] ? this.players[e.id].lives <= 0 : false,
                avatar: e.avatarType
            })),
            objects: this.hunterObjects || [],
            phase: this.hunterPhase,
            phaseRemaining: Math.max(0, this.phaseRemaining || 0),
            hunterLives: this.players[this.hunterId] ? this.players[this.hunterId].lives : 0,
            ghostIds: this.ghostIds || []
        };
        return out;
    }

    checkStart() {
        // Legacy — no longer used (countdown replaces it)
    }

    startGame() {
        this.state = 'PLAYING';
        // If Hunter mode selected, use hunter-specific start flow
        if (this.gameMode === 'hunter') {
            this.startHunterGame();
            return;
        }
        this.entities = [];

        const maxRealPlayers = 4;
        const currentRealPlayerIds = Object.keys(this.players);
        const currentRealPlayerCount = currentRealPlayerIds.length;
        const shouldFillBots = this.isQuickMatch || (currentRealPlayerCount === 1);
        if (shouldFillBots && currentRealPlayerCount < maxRealPlayers) {
            const botNames = ['🤖 OPERATIVE-ALPHA', '🤖 DRONE-BETA', '🤖 SNIPER-DELTA', '🤖 HEAVY-SIGMA'];
            const avatarTypes = ['Combat-Operative', 'Recon-Drone', 'Stealth-Sniper', 'Heavy-Gunner'];
            
            let botIdx = 0;
            for (let i = 1; i <= maxRealPlayers; i++) {
                const numTaken = Object.values(this.players).some(p => p.playerNum === i);
                if (!numTaken) {
                    const botId = `bot_player_${i}`;
                    const randomAvatar = avatarTypes[Math.floor(Math.random() * avatarTypes.length)];
                    this.players[botId] = {
                        playerNum: i,
                        lives: STARTING_LIVES,
                        isReady: true,
                        avatar: randomAvatar,
                        isBot: true,
                        name: botNames[botIdx % botNames.length]
                    };
                    botIdx++;
                }
            }
        }

        const pCount = Object.keys(this.players).length;
        if (pCount <= 3) {
            this.mapSize = { w: 2500, h: 2000 };
            this.totalEntities = 40;
        } else {
            this.mapSize = { w: 3500, h: 3000 };
            this.totalEntities = 70;
        }

        const avatarTypes = ['Combat-Operative', 'Recon-Drone', 'Stealth-Sniper', 'Heavy-Gunner'];

        // Generate decorations
        this.decorations = [];
        const numBushes = 25;
        const numRocks = 15;
        const numTorches = 10;
        for (let i = 0; i < numBushes; i++) {
            const r = rand(42, 58);
            this.decorations.push({
                id: `bush_${i}`, type: 'BUSH',
                x: rand(100, this.mapSize.w - 100),
                y: rand(100, this.mapSize.h - 100),
                radius: r,
                radiusSq: r * r   // pre-computed for fast squared-dist check
            });
        }
        for (let i = 0; i < numRocks; i++) {
            this.decorations.push({
                id: `rock_${i}`, type: 'ROCK',
                x: rand(100, this.mapSize.w - 100),
                y: rand(100, this.mapSize.h - 100),
                radius: rand(18, 32)
            });
        }
        for (let i = 0; i < numTorches; i++) {
            this.decorations.push({
                id: `torch_${i}`, type: 'TORCH',
                x: rand(100, this.mapSize.w - 100),
                y: rand(100, this.mapSize.h - 100),
                radius: 8
            });
        }

        // Pre-filter decoration sub-arrays once (avoids per-entity filtering each tick)
        this.rockDecorations = this.decorations.filter(d => d.type === 'ROCK');
        this.bushDecorations = this.decorations.filter(d => d.type === 'BUSH');

        // Bots
        for (let i = 0; i < this.totalEntities - pCount; i++) {
            const randomAvatar = avatarTypes[Math.floor(Math.random() * avatarTypes.length)];
            let bot = new Entity(`bot_${i}`, false, 0, randomAvatar);
            bot.x = rand(0, this.mapSize.w);
            bot.y = rand(0, this.mapSize.h);
            this.entities.push(bot);
        }

        // Add Players
        for (const [socketId, p] of Object.entries(this.players)) {
            p.lives = STARTING_LIVES;
            let pEnt = new Entity(socketId, true, p.playerNum, p.avatar);
            if (p.isBot) {
                pEnt.isBotPlayer = true;
                pEnt.name = p.name;
            }
            pEnt.x = rand(100, this.mapSize.w - 100);
            pEnt.y = rand(100, this.mapSize.h - 100);
            this.entities.push(pEnt);
        }

        this.entities.sort(() => Math.random() - 0.5);

        // Network throttle: send state at 20fps even though logic runs at 60fps
        this.netTickTimer = 0;
        this.cachedAlivePlayers = pCount;
        this.cachedTotalPlayers = pCount;

        io.to(this.roomId).emit('gameStart', {
            theme: this.theme,
            mapRule: getMapRule(this.theme),
            mapSize: this.mapSize,
            playersInfo: this.getPlayersInfo(),
            decorations: this.decorations
        });

        this.lastTime = Date.now();
        this.interval = setInterval(() => this.gameLoop(), 1000 / FPS);
    }

    // Hunter-mode start: assign roles, generate objects, set phase timers
    startHunterGame() {
        this.entities = [];

        const maxRealPlayers = 4;
        const currentRealPlayerIds = Object.keys(this.players);
        const currentRealPlayerCount = currentRealPlayerIds.length;
        const shouldFillBots = this.isQuickMatch || (currentRealPlayerCount === 1);
        if (shouldFillBots && currentRealPlayerCount < maxRealPlayers) {
            const botNames = ['🤖 OPERATIVE-ALPHA', '🤖 DRONE-BETA', '🤖 SNIPER-DELTA', '🤖 HEAVY-SIGMA'];
            const avatarTypes = ['Combat-Operative', 'Recon-Drone', 'Stealth-Sniper', 'Heavy-Gunner'];
            let botIdx = 0;
            for (let i = 1; i <= maxRealPlayers; i++) {
                const numTaken = Object.values(this.players).some(p => p.playerNum === i);
                if (!numTaken) {
                    const botId = `bot_player_${i}`;
                    const randomAvatar = avatarTypes[Math.floor(Math.random() * avatarTypes.length)];
                    this.players[botId] = {
                        playerNum: i,
                        lives: STARTING_LIVES,
                        isReady: true,
                        avatar: randomAvatar,
                        isBot: true,
                        name: botNames[botIdx % botNames.length]
                    };
                    botIdx++;
                }
            }
        }

        const pCount = Object.keys(this.players).length;
        if (pCount <= 3) {
            this.mapSize = { w: 2500, h: 2000 };
        } else {
            this.mapSize = { w: 3500, h: 3000 };
        }

        // Choose hunter: first human player (non-bot), else first player
        const humanIds = Object.keys(this.players).filter(id => !this.players[id].isBot);
        let hunterId = humanIds.length > 0 ? humanIds[0] : Object.keys(this.players)[0];
        this.hunterId = hunterId;
        this.ghostIds = Object.keys(this.players).filter(id => id !== hunterId);

        // Generate procedural objects with a seed
        const seed = Math.floor(Math.random() * 1e9);
        this.hunterSeed = seed;
        const objCount = Math.floor(rand(40, 70));
        this.hunterObjects = generateHunterObjects(seed, this.mapSize, objCount);

        // Initialize decorations (rocks, bushes) for physics even in hunter mode
        this.decorations = [];
        const numBushes = 10;
        const numRocks = 5;
        for (let i = 0; i < numBushes; i++) {
            const r = rand(42, 58);
            this.decorations.push({
                id: `bush_${i}`, type: 'BUSH',
                x: rand(100, this.mapSize.w - 100),
                y: rand(100, this.mapSize.h - 100),
                radius: r,
                radiusSq: r * r
            });
        }
        for (let i = 0; i < numRocks; i++) {
            this.decorations.push({
                id: `rock_${i}`, type: 'ROCK',
                x: rand(100, this.mapSize.w - 100),
                y: rand(100, this.mapSize.h - 100),
                radius: rand(18, 32)
            });
        }
        this.rockDecorations = this.decorations.filter(d => d.type === 'ROCK');
        this.bushDecorations = this.decorations.filter(d => d.type === 'BUSH');

        // Create player entities: hunter + ghosts
        for (const [socketId, p] of Object.entries(this.players)) {
            p.lives = STARTING_LIVES;
            let pEnt = new Entity(socketId, true, p.playerNum, p.avatar);
            pEnt.x = rand(100, this.mapSize.w - 100);
            pEnt.y = rand(100, this.mapSize.h - 100);
            if (socketId === hunterId) {
                pEnt.isHunter = true;
            } else {
                pEnt.isGhost = true;
            }
            this.entities.push(pEnt);
        }

        // Add neutral bots to populate the scene (non-ghost NPCs)
        const avatarTypes = ['Combat-Operative', 'Recon-Drone', 'Stealth-Sniper', 'Heavy-Gunner'];
        const botFill = 30; // background bots
        for (let i = 0; i < botFill; i++) {
            const randomAvatar = avatarTypes[Math.floor(Math.random() * avatarTypes.length)];
            let bot = new Entity(`bot_${i}`, false, 0, randomAvatar);
            bot.x = rand(0, this.mapSize.w);
            bot.y = rand(0, this.mapSize.h);
            this.entities.push(bot);
        }

        // Phases: RECON 20s, CACHE 30s, CHASSE 5min
        this.hunterPhase = 'RECON';
        this.phaseRemaining = 20000;

        io.to(this.roomId).emit('hunterStart', {
            seed: seed,
            objects: this.hunterObjects,
            hunterId: this.hunterId,
            ghostIds: this.ghostIds,
            phase: this.hunterPhase,
            phaseRemaining: this.phaseRemaining
        });

        this.lastTime = Date.now();
        this.interval = setInterval(() => this.gameLoop(), 1000 / FPS);
    }

    handleBlend(socketId) {
        // Ghost attempts to disguise to nearest object during CACHE phase
        const p = this.players[socketId];
        if (!p) return;
        if (this.gameMode !== 'hunter') return;
        if (this.hunterPhase !== 'CACHE') return;

        const ent = this.entities.find(e => e.id === socketId);
        if (!ent || !ent.isGhost) return;
        if (ent.hasDisguisedOnce) return; // only once per round

        // find nearest object within 60 px
        let nearest = null;
        let nd = 999999;
        for (const o of this.hunterObjects) {
            const dx = o.x - ent.x;
            const dy = o.y - ent.y;
            const d2 = dx * dx + dy * dy;
            if (d2 < nd && d2 <= 60 * 60) {
                nd = d2;
                nearest = o;
            }
        }
        if (!nearest) return;

        ent.x = nearest.x;
        ent.y = nearest.y;
        ent.isDisguised = true;
        ent.disguiseObjectId = nearest.id;
        ent.hasDisguisedOnce = true;

        io.to(this.roomId).emit('playerDisguised', { id: socketId, objectId: nearest.id });
    }

    _spawnStartItem() {
        const itemTypes = ['HEART', 'SHAPESHIFT'];
        const type = itemTypes[Math.floor(Math.random() * itemTypes.length)];
        const item = {
            id: `item_${Date.now()}_${Math.random()}`,
            type: type,
            x: rand(150, this.mapSize.w - 150),
            y: rand(150, this.mapSize.h - 150),
            expiresAt: Date.now() + 12000,
            size: 15
        };
        this.items.push(item);
    }

    spawnItem() {
        const itemTypes = ['HEART', 'SHAPESHIFT', 'SHAPESHIFT']; // SHAPESHIFT is more common
        const type = itemTypes[Math.floor(Math.random() * itemTypes.length)];
        const item = {
            id: `item_${Date.now()}`,
            type: type,
            x: rand(100, this.mapSize.w - 100),
            y: rand(100, this.mapSize.h - 100),
            expiresAt: Date.now() + 10000, // 10 seconds
            size: 15
        };
        this.items.push(item);
        io.to(this.roomId).emit('itemSpawned', item);
    }

    getPlayersInfo() {
        const info = {};
        for (const [socketId, p] of Object.entries(this.players)) {
            info[socketId] = { num: p.playerNum, lives: p.lives };
        }
        return info;
    }

    handleTagAttempt(socketId, clickX, clickY) {
        // Player attempted a tag at clickX, clickY
        const shooter = this.players[socketId];
        const shooterEnt = this.entities.find(e => e.id === socketId);

        if (!shooter || !shooterEnt || shooter.lives <= 0) return;

        // In hunter mode, only the hunter may tag
        if (this.gameMode === 'hunter' && !shooterEnt.isHunter) return;

        // Check if click is out of bounds (Proximity tagging)
        const dxRange = clickX - shooterEnt.x;
        const dyRange = clickY - shooterEnt.y;
        if (Math.sqrt(dxRange * dxRange + dyRange * dyRange) > TAG_RANGE) {
            return; // Player clicked too far away!
        }

        // Visual feedback to all
        io.to(this.roomId).emit('tagEffect', { x: clickX, y: clickY, by: socketId });

        // Check if any entity was clicked. (Simple radius check)
        let hitEntity = null;
        for (let ent of this.entities) {
            if (ent.id === socketId) continue; // can't click self
            const dx = clickX - ent.x;
            const dy = clickY - ent.y;
            if (Math.sqrt(dx * dx + dy * dy) <= ent.size + 10) { // +10 for generous hitbox
                hitEntity = ent;
                break;
            }
        }

        if (!hitEntity && this.gameMode === 'hunter') {
            // If click near a decor object -> false alarm heavy penalty
            let nearObj = null;
            for (const o of (this.hunterObjects || [])) {
                const dx = clickX - o.x;
                const dy = clickY - o.y;
                if (dx * dx + dy * dy <= (o.size + 10) * (o.size + 10)) { nearObj = o; break; }
            }
            if (nearObj) {
                shooter.lives -= 15;
            } else {
                shooter.lives -= 5;
            }
            io.to(this.roomId).emit('livesUpdated', this.getPlayersInfo());
            if (shooter.lives <= 0) {
                this.entities = this.entities.filter(e => e.id !== shooterEnt.id);
                const living = Object.keys(this.players).filter(id => this.players[id].lives > 0);
                this.cachedAlivePlayers = living.length;
                if (living.length <= 1) this.endGame(living[0] || null);
            }
            return;
        }

        if (hitEntity) {
            if (hitEntity.isPlayer) {
                // HIT OPPONENT PLAYER!
                const targetPlayer = this.players[hitEntity.id];
                if (targetPlayer && targetPlayer.lives > 0) {
                    // Eliminate instantly
                    targetPlayer.lives = 0;
                    
                    // Broadcast updated lives
                    io.to(this.roomId).emit('livesUpdated', this.getPlayersInfo());

                    // Remove target player entity from the game immediately
                    this.entities = this.entities.filter(e => e.id !== hitEntity.id);

                    // Check if game is over (only 1 player with lives > 0 left)
                    const living = Object.keys(this.players).filter(id => this.players[id].lives > 0);
                    this.cachedAlivePlayers = living.length;
                    
                    if (living.length === 1) {
                        this.endGame(living[0]); // that player wins!
                    } else if (living.length === 0) {
                        this.endGame(null); // draw
                    }
                }
            } else {
                // HIT BOT! LOSE LIFE!
                shooter.lives--;
                hitEntity.revealedUntil = Date.now() + REVEAL_DURATION;
                io.to(this.roomId).emit('livesUpdated', this.getPlayersInfo());

                if (shooter.lives <= 0) {
                    // Remove shooter entity from the game
                    this.entities = this.entities.filter(e => e.id !== shooterEnt.id);
                }

                const living = Object.keys(this.players).filter(id => this.players[id].lives > 0);
                this.cachedAlivePlayers = living.length;

                if (living.length === 1) {
                    this.endGame(living[0]);
                } else if (living.length === 0) {
                    this.endGame(null);
                }
            }
        }
    }

    endGame(winnerId) {
        this.state = 'GAME_OVER';
        clearInterval(this.interval);

        // Reset player readyness for the next round
        for (const p of Object.values(this.players)) {
            p.isReady = false;
        }

        io.to(this.roomId).emit('gameOver', { winner: winnerId });
    }

    resetToLobby() {
        if (this.state === 'GAME_OVER') {
            this.stopCountdown();
            // Remove bot players
            for (const [id, p] of Object.entries(this.players)) {
                if (p.isBot) {
                    delete this.players[id];
                }
            }
            this.state = 'LOBBY';
            for (const p of Object.values(this.players)) {
                p.isReady = false;
            }
            io.to(this.roomId).emit('roomStatus', this.getLobbyStatus());
            this.broadcastCountdown();
        }
    }

    getActivePings(now) {
        const pings = [];
        for (const e of this.entities) {
            if (e.radarPingUntil && now < e.radarPingUntil) {
                pings.push({ x: Math.round(e.x), y: Math.round(e.y), t: 'r' });
            }
            if (e.alarmPingUntil && now < e.alarmPingUntil) {
                pings.push({ x: Math.round(e.x), y: Math.round(e.y), t: 'a' });
            }
        }
        return pings;
    }

    updateSyncEvent(dt) {
        if (!this.isSyncEventActive) {
            this.syncEventTimer -= dt;
            if (this.syncEventTimer <= 0) {
                this.isSyncEventActive = true;
                this.syncEventDuration = rand(4000, 7000);
                const orthogonalAngles = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];
                const syncAngle = orthogonalAngles[Math.floor(Math.random() * orthogonalAngles.length)];
                const syncSpeed = rand(2.5, 3.5);
                this.syncAngle = syncAngle;
                this.syncSpeed = syncSpeed;

                for (const e of this.entities) {
                    e.syncReactionTimer = rand(300, 800);
                    e.isSyncing = false;
                }
                io.to(this.roomId).emit('syncEvent', { active: true });
            }
        } else {
            this.syncEventDuration -= dt;
            if (this.syncEventDuration <= 0) {
                this.isSyncEventActive = false;
                this.syncEventTimer = rand(15000, 30000);
                for (const e of this.entities) {
                    e.desyncReactionTimer = rand(250, 600);
                }
                io.to(this.roomId).emit('syncEvent', { active: false });
            }
        }
    }

    updateAlarmEvent(dt, now) {
        if (this.alarmPhase === 'idle') {
            this.alarmEventTimer -= dt;
            if (this.alarmEventTimer <= 0) {
                this.alarmPhase = 'warning';
                this.alarmPhaseRemaining = 2000;
                io.to(this.roomId).emit('alarmEvent', { phase: 'warning' });
            }
            return;
        }

        this.alarmPhaseRemaining -= dt;

        if (this.alarmPhase === 'warning' && this.alarmPhaseRemaining <= 0) {
            this.alarmPhase = 'freeze';
            this.alarmPhaseRemaining = 3000;
            this.isAlarmFreeze = true;
            this.freezeSnapshots = {};
            for (const e of this.entities) {
                this.freezeSnapshots[e.id] = { x: e.x, y: e.y };
            }
            io.to(this.roomId).emit('alarmEvent', { phase: 'freeze' });
        } else if (this.alarmPhase === 'freeze' && this.alarmPhaseRemaining <= 0) {
            this.isAlarmFreeze = false;
            const violators = [];
            for (const e of this.entities) {
                const snap = this.freezeSnapshots[e.id];
                if (!snap) continue;
                const dx = e.x - snap.x;
                const dy = e.y - snap.y;
                if (dx * dx + dy * dy > 64) {
                    e.alarmPingUntil = now + 4000;
                    violators.push({ x: Math.round(e.x), y: Math.round(e.y) });
                }
            }
            this.freezeSnapshots = null;
            this.alarmPhase = 'idle';
            this.alarmEventTimer = rand(22000, 35000);
            io.to(this.roomId).emit('alarmEvent', { phase: 'release', violators });
        }
    }

    updateRadarSweep(now) {
        const cx = this.mapSize.w / 2;
        const cy = this.mapSize.h / 2;
        this.radarAngle = (now * 0.0007) % (Math.PI * 2);
        const SWEEP_HALF = 0.15;

        for (const e of this.entities) {
            if (e.inBush) {
                e._radarInCone = false;
                continue;
            }

            const angle = Math.atan2(e.y - cy, e.x - cx);
            let diff = angle - this.radarAngle;
            while (diff > Math.PI) diff -= Math.PI * 2;
            while (diff < -Math.PI) diff += Math.PI * 2;

            if (Math.abs(diff) < SWEEP_HALF) {
                if (!e._radarInCone) {
                    e._radarInCone = true;
                    const isHuman = e.isPlayer && !e.isBotPlayer;
                    e._radarPingDelay = isHuman ? 0 : (e.isBotPlayer ? 200 : 350);
                    e._radarConeEnterTime = now;
                }
                if (now - e._radarConeEnterTime >= e._radarPingDelay) {
                    e.radarPingUntil = now + 1200;
                    if (e.isPlayer && !e.isBotPlayer) {
                        e.radarTagImmunityUntil = now + 5000;
                    }
                }
            } else {
                e._radarInCone = false;
            }
        }
    }

    gameLoop() {
        const now = Date.now();
        const dt = now - this.lastTime;
        this.lastTime = now;

        // Hunter-mode phase management
        if (this.gameMode === 'hunter' && this.state === 'PLAYING') {
            if (this.phaseRemaining !== undefined) {
                this.phaseRemaining -= dt;
                if (this.phaseRemaining <= 0) {
                    if (this.hunterPhase === 'RECON') {
                        // Switch to CACHE
                        this.hunterPhase = 'CACHE';
                        this.phaseRemaining = 30000;
                        // Blind the hunter client briefly (clients will handle UI)
                        if (this.players[this.hunterId] && this.players[this.hunterId].socket) {
                            this.players[this.hunterId].socket.emit('hunterBlind', { duration: 30000 });
                        }
                        io.to(this.roomId).emit('hunterPhase', { phase: 'CACHE', remaining: this.phaseRemaining });
                    } else if (this.hunterPhase === 'CACHE') {
                        // Switch to CHASSE
                        this.hunterPhase = 'CHASSE';
                        this.phaseRemaining = 240000; // 4 minutes
                        io.to(this.roomId).emit('hunterPhase', { phase: 'CHASSE', remaining: this.phaseRemaining });
                    } else if (this.hunterPhase === 'CHASSE') {
                        // End round: ghosts survive -> ghosts win
                        // determine winner or emit round end
                        io.to(this.roomId).emit('hunterPhase', { phase: 'ENDED' });
                        this.endGame(null);
                        return;
                    }
                }
            }
        }

        // Item Spawning Logic
        this.itemSpawnTimer -= dt;
        if (this.itemSpawnTimer <= 0) {
            this.spawnItem();
            this.itemSpawnTimer = rand(3000, 8000);
        }

        // Cache player entities once per tick (used multiple times below)
        const playerEntities = this.entities.filter(e => e.isPlayer);

        // Item Expiration & Collision Logic (use squared dist to avoid sqrt)
        for (let i = this.items.length - 1; i >= 0; i--) {
            const item = this.items[i];

            if (now > item.expiresAt) {
                this.items.splice(i, 1);
                io.to(this.roomId).emit('itemRemoved', item.id);
                continue;
            }

            for (const pEnt of playerEntities) {
                const dx = pEnt.x - item.x;
                const dy = pEnt.y - item.y;
                const pickupDist = pEnt.size + item.size;
                if (dx * dx + dy * dy < pickupDist * pickupDist) {
                    const socketId = pEnt.id;
                    const playerState = this.players[socketId];
                    if (!playerState) continue;

                    if (item.type === 'HEART' && playerState.lives < 3) {
                        playerState.lives++;
                        this.cachedAlivePlayers = Object.values(this.players).filter(p => p.lives > 0).length;
                        io.to(this.roomId).emit('livesUpdated', this.getPlayersInfo());
                    } else if (item.type === 'SHAPESHIFT') {
                        const avatarTypes = ['Combat-Operative', 'Recon-Drone', 'Stealth-Sniper', 'Heavy-Gunner'];
                        const newAvatar = avatarTypes[Math.floor(Math.random() * avatarTypes.length)];
                        pEnt.avatarType = newAvatar;

                        const botId = `bot_clone_${now}`;
                        let cloneBot = new Entity(botId, false, 0, newAvatar);
                        cloneBot.x = pEnt.x;
                        cloneBot.y = pEnt.y;
                        cloneBot.baseColor = pEnt.baseColor;
                        cloneBot.color = pEnt.color;
                        cloneBot.aiState = 'MOVING';
                        cloneBot.aiTimer = rand(2000, 4000);
                        cloneBot.targetAngle = rand(0, Math.PI * 2);
                        cloneBot.aiSpeed = rand(2, 3);
                        this.entities.push(cloneBot);
                    }

                    this.items.splice(i, 1);
                    io.to(this.roomId).emit('itemRemoved', item.id);
                    io.to(this.roomId).emit('itemPickedUp', { id: item.id, by: pEnt.id, type: item.type });
                    break;
                }
            }
        }

        const mapRule = getMapRule(this.theme);
        if (mapRule === 'sync') {
            this.updateSyncEvent(dt);
        } else if (mapRule === 'alarm') {
            this.updateAlarmEvent(dt, now);
        }

        // Update all entities
        for (const e of this.entities) {
            e.update(dt, this.mapSize, this.rockDecorations, this.bushDecorations, this.entities, this);
        }

        if (mapRule === 'radar') {
            this.updateRadarSweep(now);
        }

        // Network broadcast throttled to 20fps (logic still runs at 60fps for smooth physics)
        this.netTickTimer += dt;
        if (this.netTickTimer >= 50) { // 50ms = 20fps
            this.netTickTimer = 0;
            
            // Hunter mode: serialize differently
            if (this.gameMode === 'hunter') {
                io.to(this.roomId).volatile.emit('gameState', this.serializeHunterState());
            } else {
                const statePayload = {
                    e: this.entities.map(e => e.serialize()),
                    i: this.items,
                    a: this.cachedAlivePlayers,
                    t: this.cachedTotalPlayers,
                    p: this.getActivePings(now)
                };
                if (mapRule === 'radar') {
                    statePayload.ra = Math.round(this.radarAngle * 100) / 100;
                }
                io.to(this.roomId).volatile.emit('gameState', statePayload);
            }
        }
    }


    handleDisconnect(socketId) {
        delete this.players[socketId];

        // Clean up room if no human players are left
        const humansLeft = Object.values(this.players).filter(p => !p.isBot);
        if (humansLeft.length === 0) {
            this.stopCountdown();
            if (this.interval) clearInterval(this.interval);
            delete rooms[this.roomId];
            return;
        }

        if (this.state === 'PLAYING') {
            // Remove their entity if it exists
            this.entities = this.entities.filter(e => e.id !== socketId);
            
            const living = Object.keys(this.players).filter(id => this.players[id].lives > 0);
            this.cachedAlivePlayers = living.length;
            
            if (living.length === 1) {
                this.endGame(living[0]);
            } else if (living.length === 0) {
                if (this.interval) clearInterval(this.interval);
                delete rooms[this.roomId];
            }
        } else if (this.state === 'LOBBY' || this.state === 'COUNTDOWN') {
            if (this.state === 'COUNTDOWN') {
                this.broadcastCountdown();
            }
            io.to(this.roomId).emit('roomStatus', this.getLobbyStatus());
        }
    }
}

io.on('connection', (socket) => {
    let currentRoom       = null;  // MIMIC GameRoom
    let currentHunterRoom = null;  // HUNTER HunterRoom

    // ── MIMIC MODE ──────────────────────────────────────────
    socket.on('createRoom', () => {
        const code = generateRoomCode();
        currentRoom = new GameRoom(code, socket);
        rooms[code] = currentRoom;
        socket.emit('roomCreated', code);
    });

    socket.on('joinRoom', (code) => {
        code = code.toUpperCase();
        const room = rooms[code];
        if (room) {
            if (Object.keys(room.players).length < 4 && (room.state === 'LOBBY' || room.state === 'COUNTDOWN')) {
                currentRoom = room;
                room.addPlayer(socket, Object.keys(room.players).length + 1);
                socket.emit('roomJoined', code);
            } else {
                socket.emit('errorMsg', 'Room is full or game already started.');
            }
        } else {
            socket.emit('errorMsg', 'Room not found.');
        }
    });

    socket.on('joinRandomRoom', (data) => {
        const mode = (data && data.mode) ? data.mode : 'mimic';
        if (mode === 'hunter') {
            const availableRooms = Object.values(hunterRooms).filter(
                r => r.isPublic && Object.keys(r.players).length < 4 && r.state === 'LOBBY'
            );
            if (availableRooms.length > 0) {
                const randomRoom = availableRooms[Math.floor(Math.random() * availableRooms.length)];
                currentHunterRoom = randomRoom;
                randomRoom.addPlayer(socket, Object.keys(randomRoom.players).length + 1);
                socket.emit('hunterRoomJoined', { code: randomRoom.roomId, maps: Object.keys(HUNTER_MAPS) });
            } else {
                const code = generateRoomCode();
                const newRoom = new HunterRoom(code, socket, io, hunterRooms, true);
                hunterRooms[code] = newRoom;
                currentHunterRoom = newRoom;
                socket.emit('hunterRoomCreated', { code, maps: Object.keys(HUNTER_MAPS) });
                newRoom.startCountdown();
            }
        } else {
            const availableRooms = Object.values(rooms).filter(
                r => r.isPublic && Object.keys(r.players).length < 4 && r.state === 'LOBBY'
            );
            if (availableRooms.length > 0) {
                const randomRoom = availableRooms[Math.floor(Math.random() * availableRooms.length)];
                currentRoom = randomRoom;
                randomRoom.addPlayer(socket, Object.keys(randomRoom.players).length + 1);
                socket.emit('roomJoined', randomRoom.roomId);
            } else {
                const code = generateRoomCode();
                const newRoom = new GameRoom(code, socket, true);
                rooms[code] = newRoom;
                currentRoom = newRoom;
                socket.emit('roomCreated', code);
                newRoom.startCountdown();
            }
        }
    });

    socket.on('togglePublic', () => {
        if (currentRoom && currentRoom.players[socket.id]?.playerNum === 1) {
            currentRoom.isPublic = !currentRoom.isPublic;
            io.to(currentRoom.roomId).emit('roomStatus', currentRoom.getLobbyStatus());
        } else if (currentHunterRoom && currentHunterRoom.players[socket.id]?.playerNum === 1) {
            currentHunterRoom.isPublic = !currentHunterRoom.isPublic;
            io.to(currentHunterRoom.roomId).emit('roomStatus', currentHunterRoom.getLobbyStatus());
        }
    });

    socket.on('backToLobby', () => {
        if (currentRoom) currentRoom.resetToLobby();
        if (currentHunterRoom) currentHunterRoom.resetToLobby();
    });

    // ── HUNTER MODE ─────────────────────────────────────────
    socket.on('createHunterRoom', () => {
        // Prevent creating if already in a room
        if (currentHunterRoom || currentRoom) {
            socket.emit('errorMsg', 'Tu es déjà dans une room.');
            return;
        }
        const code = generateRoomCode();
        const room = new HunterRoom(code, socket, io, hunterRooms);
        hunterRooms[code] = room;
        currentHunterRoom = room;
        socket.emit('hunterRoomCreated', { code, maps: Object.keys(HUNTER_MAPS) });
    });

    socket.on('joinHunterRoom', (code) => {
        if (!code) return;
        code = code.toString().toUpperCase();
        const room = hunterRooms[code];
        if (!room) {
            socket.emit('errorMsg', 'Room HUNTER introuvable.');
            return;
        }
        if (room.state !== 'LOBBY' && room.state !== 'COUNTDOWN') {
            socket.emit('errorMsg', 'La partie HUNTER a déjà commencé.');
            return;
        }
        if (Object.keys(room.players).length >= room.MAX_PLAYERS) {
            socket.emit('errorMsg', 'Room HUNTER complète (4 joueurs max).');
            return;
        }
        currentHunterRoom = room;
        room.addPlayer(socket, Object.keys(room.players).length + 1);
        socket.emit('hunterRoomJoined', { code, maps: Object.keys(HUNTER_MAPS) });
    });

    // ── DISCONNECT ──────────────────────────────────────────
    socket.on('disconnect', () => {
        if (currentRoom)       currentRoom.handleDisconnect(socket.id);
        if (currentHunterRoom) currentHunterRoom.handleDisconnect(socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
