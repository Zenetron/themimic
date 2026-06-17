const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const { HunterRoom, HUNTER_MAPS } = require('./hunter-room');
const {
    generateSessionToken,
    pendingRejoin,
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

const INDUSTRIAL_THEMES = ['Military Base', 'Forest', 'Arcade Grid'];
const WAREHOUSE_THEMES = ['Weapon Warehouse', 'Cave', 'Toy Factory'];
const COMMAND_THEMES = ['Command Center', 'Desert', 'Micro-Circuit'];
const VALID_CLASSIC_THEMES = [...INDUSTRIAL_THEMES, ...WAREHOUSE_THEMES, ...COMMAND_THEMES];

function getMapRule(theme) {
    if (WAREHOUSE_THEMES.includes(theme)) return 'alarm';
    if (COMMAND_THEMES.includes(theme)) return 'radar';
    return 'sync';
}

// Coerces an untrusted movement-input payload into a safe boolean-only shape,
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
    }

    getBotColor() {
        const colors = ['#c93b2b', '#5b7a54', '#bfa26f', '#4f758c'];
        return colors[Math.floor(Math.random() * colors.length)];
    }

    update(dt, mapSize, rockDecorations, bushDecorations, allEntities, room) {
        const isEndGameFreeze = room && room.endGameTriggered && (room.endGameMode === 'FREEZE' || room.endGameMode === 'GEL');
        const frozen = (room && room.isAlarmFreeze) || (isEndGameFreeze && !this.isPlayer);
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
        this.io = io;
        this.roomsRef = rooms;
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
        this.MAX_PLAYERS      = 6;
        this.hostId           = hostSocket.id;

        // End-game Mode properties
        this.endGameMode = 'STORM';
        this.endGameTriggered = false;
        this.endGameCountdownRemaining = 30000;
        this.stormRadius = 2500;
        this.lastBotPurgeTime = 0;

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

        const token = generateSessionToken();
        this.players[socket.id].sessionToken = token;
        socket.emit('sessionToken', { token, roomCode: this.roomId, isHunter: false });

        socket.join(this.roomId);

        // If countdown is running, a new real player joined — extend or reset timer
        if (this.state === 'COUNTDOWN') {
            const extended = Math.min(this.MAX_COUNTDOWN, this.countdownSeconds + 15);
            this.countdownSeconds = extended;
            this.broadcastCountdown();
        } else {
            this.broadcastCountdown();
        }

        this._bindSocket(socket);
        io.to(this.roomId).emit('roomStatus', this.getLobbyStatus());
    }

    _bindSocket(socket) {
        // Listeners for this room
        safeOn(socket, 'playerReady', (data) => {
            if (this.state !== 'LOBBY' && this.state !== 'COUNTDOWN') return;
            const p = this.players[socket.id];
            if (p && !p.isReady) {
                p.isReady = true;
                p.avatar = (data && typeof data.avatar === 'string') ? data.avatar.slice(0, 40) : 'Combat-Operative';
                if (p.playerNum === 1 && data && VALID_CLASSIC_THEMES.includes(data.theme)) {
                    this.theme = data.theme;
                }
                io.to(this.roomId).emit('roomStatus', this.getLobbyStatus());

                // If room full + all ready → instant start
                const pKeys = Object.keys(this.players);
                const allReady = pKeys.every(k => this.players[k].isReady);
                if (pKeys.length >= this.MAX_PLAYERS && allReady) {
                    this.stopCountdown();
                    this.startShuffle();
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

        safeOn(socket, 'soloTest', (data) => {
            if (this.state !== 'LOBBY' && this.state !== 'COUNTDOWN') return;
            const p = this.players[socket.id];
            if (p) {
                p.isReady = true;
                p.avatar = (data && typeof data.avatar === 'string') ? data.avatar.slice(0, 40) : 'Combat-Operative';
                if (data && VALID_CLASSIC_THEMES.includes(data.theme)) this.theme = data.theme;
                this.stopCountdown();
                this.startShuffle();
            }
        });

        safeOn(socket, 'input', (inputData) => {
            if (this.state !== 'PLAYING') return;
            const pEnt = this.entities.find(e => e.isPlayer && e.id === socket.id);
            if (pEnt) pEnt.input = sanitizeMovementInput(inputData);
        });

        safeOn(socket, 'tagAttempt', (data) => {
            if (this.state !== 'PLAYING') return;
            if (isRateLimited(socket, 'tagAttempt', 80)) return;
            if (!data || !Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
            this.handleTagAttempt(socket.id, data.x, data.y);
        });
    }

    // ─── Countdown logic ────────────────────────────────────
    startCountdown() {
        if (this.state !== 'LOBBY') return;
        this.state = 'COUNTDOWN';
        this.countdownSeconds = this.MAX_COUNTDOWN;
        this.broadcastCountdown();

        this.countdownTimer = setInterval(safeTick('countdownTimer', () => {
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
                setTimeout(() => this.startShuffle(), 2000); // 2s drama delay
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
        if (this.shuffleTimeout) {
            clearTimeout(this.shuffleTimeout);
            this.shuffleTimeout = null;
        }
        if (this.state === 'COUNTDOWN') this.state = 'LOBBY';
    }

    broadcastCountdown() {
        broadcastCountdownShared(this);
    }

    getLobbyStatus() {
        const humans = Object.values(this.players).filter(p => !p.isBot);
        return {
            roomId: this.roomId,
            playerCount: humans.length,
            readyCount: humans.filter(p => p.isReady).length,
            theme: this.theme,
            isPublic: this.isPublic,
            isQuickMatch: this.isQuickMatch,
            state: this.state,
            gameMode: this.gameMode || 'classic'
        };
    }

    startShuffle() {
        if (this.state !== 'LOBBY' && this.state !== 'COUNTDOWN') return;
        this.state = 'SHUFFLING';

        // Mark all human players as ready
        for (const p of Object.values(this.players)) {
            p.isReady = true;
        }

        // Choose random map (theme)
        const themes = [
            'Military Base', 'Forest', 'Arcade Grid',
            'Weapon Warehouse', 'Cave', 'Toy Factory',
            'Command Center', 'Desert', 'Micro-Circuit'
        ];
        this.theme = themes[Math.floor(Math.random() * themes.length)];

        // Choose random end-game mode
        const modes = ['STORM', 'FREEZE', 'PURGE', 'TEMPETE', 'GEL', 'DISPARITION'];
        this.endGameMode = modes[Math.floor(Math.random() * modes.length)];

        // Shuffling duration (shorter for tests)
        const isTest = this.roomId.toLowerCase().includes('test');
        const duration = isTest ? 500 : 3000;

        // Emit shuffle command to all clients
        io.to(this.roomId).emit('roomShuffle', {
            map: this.theme,
            maps: themes,
            mode: this.endGameMode,
            duration: duration
        });

        // Set timeout to start the game after the shuffling animation + drama delay
        const serverDelay = isTest ? 500 : (duration + 1500);
        this.shuffleTimeout = setTimeout(() => {
            this.startGame();
        }, serverDelay);
    }

    startGame() {
        this.state = 'PLAYING';
        // Mark all players as ready
        for (const p of Object.values(this.players)) {
            p.isReady = true;
        }
        this.entities = [];
        this.endGameTriggered = false;
        const modeTimers = { STORM: 30000, FREEZE: 60000, PURGE: 30000, TEMPETE: 60000, GEL: 60000, DISPARITION: 30000 };
        this.endGameCountdownRemaining = modeTimers[this.endGameMode] || 30000;

        const maxRealPlayers = this.MAX_PLAYERS;
        const currentRealPlayerIds = Object.keys(this.players);
        const currentRealPlayerCount = currentRealPlayerIds.length;
        const shouldFillBots = currentRealPlayerCount === 1;
        if (shouldFillBots && currentRealPlayerCount < maxRealPlayers) {
            const botNames = this.isQuickMatch
                ? ['P2', 'P3', 'P4', 'P5', 'P6']
                : ['🤖 OPERATIVE-ALPHA', '🤖 DRONE-BETA', '🤖 SNIPER-DELTA', '🤖 HEAVY-SIGMA', '🤖 SCOUT-EPSILON', '🤖 MEDIC-ZETA'];
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
        if (pCount <= 2) {
            this.mapSize = { w: 2000, h: 1800 };
            this.totalEntities = 32;
        } else if (pCount <= 4) {
            this.mapSize = { w: 2800, h: 2400 };
            this.totalEntities = 55;
        } else {
            this.mapSize = { w: 3800, h: 3200 };
            this.totalEntities = 85;
        }
        this.stormRadius = Math.max(this.mapSize.w, this.mapSize.h);

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
        this.interval = setInterval(safeTick('gameLoop', () => this.gameLoop()), 1000 / FPS);
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

        if (hitEntity) {
            if (hitEntity.isPlayer) {
                // HIT OPPONENT PLAYER!
                const targetPlayer = this.players[hitEntity.id];
                if (targetPlayer && targetPlayer.lives > 0) {
                    targetPlayer.lives--;
                    io.to(this.roomId).emit('livesUpdated', this.getPlayersInfo());

                    if (targetPlayer.lives <= 0) {
                        this.entities = this.entities.filter(e => e.id !== hitEntity.id);
                    }

                    const living = Object.keys(this.players).filter(id => this.players[id].lives > 0);
                    this.cachedAlivePlayers = living.length;

                    if (living.length === 1) {
                        setTimeout(() => { if (this.state === 'PLAYING') this.endGame(living[0]); }, 800);
                    } else if (living.length === 0) {
                        setTimeout(() => { if (this.state === 'PLAYING') this.endGame(null); }, 800);
                    }
                }
            } else {
                // HIT BOT! LOSE LIFE!
                shooter.lives--;
                hitEntity.revealedUntil = Date.now() + REVEAL_DURATION;
                io.to(this.roomId).emit('livesUpdated', this.getPlayersInfo());

                if (shooter.lives <= 0) {
                    this.entities = this.entities.filter(e => e.id !== shooterEnt.id);
                }

                const living = Object.keys(this.players).filter(id => this.players[id].lives > 0);
                this.cachedAlivePlayers = living.length;

                if (living.length === 1) {
                    setTimeout(() => { if (this.state === 'PLAYING') this.endGame(living[0]); }, 800);
                } else if (living.length === 0) {
                    setTimeout(() => { if (this.state === 'PLAYING') this.endGame(null); }, 800);
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
        if (!this.endGameTriggered) {
            if (mapRule === 'sync') {
                this.updateSyncEvent(dt);
            } else if (mapRule === 'alarm') {
                this.updateAlarmEvent(dt, now);
            }
        } else if (this.isSyncEventActive) {
            // Stop any active sync event when endgame triggers
            this.isSyncEventActive = false;
            io.to(this.roomId).emit('syncEvent', { active: false });
        }

        // Handle classic endgame modes
        if (this.state === 'PLAYING') {
            if (!this.endGameTriggered) {
                this.endGameCountdownRemaining = Math.max(0, this.endGameCountdownRemaining - dt);
                if (this.endGameCountdownRemaining <= 0) {
                    this.endGameTriggered = true;
                    io.to(this.roomId).emit('classicEndGameModeTriggered', { mode: this.endGameMode });
                    if (this.endGameMode === 'PURGE' || this.endGameMode === 'DISPARITION') {
                        this.lastBotPurgeTime = now;
                    }
                }
            } else {
                if (this.endGameMode === 'STORM' || this.endGameMode === 'TEMPETE') {
                    // Shrink storm radius from max map size (2500 or 3500) to 150 over 60 seconds
                    const maxDim = Math.max(this.mapSize.w, this.mapSize.h);
                    const shrinkSpeed = (maxDim - 150) / 60; // units per second
                    this.stormRadius = Math.max(150, this.stormRadius - shrinkSpeed * (dt / 1000));

                    // Center of the map
                    const cx = this.mapSize.w / 2;
                    const cy = this.mapSize.h / 2;

                    // Apply storm damage to classic players
                    for (const [id, pl] of Object.entries(this.players)) {
                        if (pl.lives > 0) {
                            const pEnt = this.entities.find(e => e.id === id);
                            if (pEnt) {
                                const dx = pEnt.x - cx;
                                const dy = pEnt.y - cy;
                                const dist = Math.sqrt(dx * dx + dy * dy);
                                if (dist > this.stormRadius) {
                                    pl.timeOutsideStorm = (pl.timeOutsideStorm || 0) + dt;
                                    if (pl.timeOutsideStorm >= 1000) {
                                        pl.timeOutsideStorm = 0;
                                        pl.lives--;
                                        io.to(this.roomId).emit('livesUpdated', this.getPlayersInfo());
                                        if (pl.lives <= 0) {
                                            // Eliminate
                                            this.entities = this.entities.filter(e => e.id !== id);
                                        }
                                        // Check if game is over (only 1 player with lives > 0 left)
                                        const living = Object.keys(this.players).filter(pid => this.players[pid].lives > 0);
                                        this.cachedAlivePlayers = living.length;
                                        if (living.length === 1) {
                                            setTimeout(() => { if (this.state === 'PLAYING') this.endGame(living[0]); }, 800);
                                        } else if (living.length === 0) {
                                            setTimeout(() => { if (this.state === 'PLAYING') this.endGame(null); }, 800);
                                        }
                                    }
                                } else {
                                    pl.timeOutsideStorm = 0;
                                }
                            }
                        }
                    }
                } else if (this.endGameMode === 'PURGE' || this.endGameMode === 'DISPARITION') {
                    if (now - this.lastBotPurgeTime >= 5000) {
                        this.lastBotPurgeTime = now;
                        // Purge a random decoy bot entity (not a real/bot player)
                        const decoyBots = this.entities.filter(e => !e.isPlayer);
                        if (decoyBots.length > 0) {
                            const botToPurge = decoyBots[Math.floor(Math.random() * decoyBots.length)];
                            this.entities = this.entities.filter(e => e.id !== botToPurge.id);
                        }
                    }
                }
            }
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
            
            const statePayload = {
                e: this.entities.map(e => e.serialize()),
                i: this.items,
                a: this.cachedAlivePlayers,
                t: this.cachedTotalPlayers,
                p: this.getActivePings(now),
                egm: this.endGameMode,
                egt: this.endGameTriggered,
                egc: this.endGameCountdownRemaining,
                sr: this.stormRadius
            };
            if (mapRule === 'radar') {
                statePayload.ra = Math.round(this.radarAngle * 100) / 100;
            }
            io.to(this.roomId).volatile.emit('gameState', statePayload);
        }
    }


    handleDisconnect(socketId) {
        const p = this.players[socketId];
        if (!p) return;

        migrateHostOnDisconnect(this, socketId);

        // Grace period during game for human players
        if (this.state === 'PLAYING' && !p.isBot && p.sessionToken) {
            startGracePeriod(this, socketId, p, false);
            return;
        }

        delete this.players[socketId];
        this._checkAfterRemoval(socketId);
    }

    _checkAfterRemoval(socketId) {
        if (cleanupRoomIfEmpty(this)) return;

        if (this.state === 'PLAYING') {
            this.entities = this.entities.filter(e => e.id !== socketId);
            const living = Object.keys(this.players).filter(id => this.players[id].lives > 0);
            this.cachedAlivePlayers = living.length;
            if (living.length === 1) this.endGame(living[0]);
            else if (living.length === 0) this.endGame(null);
        } else if (this.state === 'LOBBY' || this.state === 'COUNTDOWN') {
            if (this.state === 'COUNTDOWN') this.broadcastCountdown();
            io.to(this.roomId).emit('roomStatus', this.getLobbyStatus());
        }
    }

    rejoinPlayer(newSocket, oldSocketId) {
        const p = beginRejoin(this, newSocket, oldSocketId);
        if (!p) return;

        const ent = this.entities.find(e => e.id === oldSocketId);
        if (ent) ent.id = newSocket.id;

        resumeLoopIfPaused(this, FPS);

        newSocket.join(this.roomId);
        this._bindSocket(newSocket);

        newSocket.emit('rejoinSuccess', {
            mode: 'mimic',
            sessionToken: this.players[newSocket.id].sessionToken,
            roomCode: this.roomId,
            isHunter: false,
            lives: p.lives,
            theme: this.theme,
            mapRule: getMapRule(this.theme),
            mapSize: this.mapSize,
            playersInfo: this.getPlayersInfo(),
            decorations: this.decorations
        });

        io.to(this.roomId).emit('playerRejoined', { socketId: newSocket.id, oldSocketId });
    }
}

io.on('connection', (socket) => {
    let currentRoom       = null;  // MIMIC GameRoom
    let currentHunterRoom = null;  // HUNTER HunterRoom

    // ── MIMIC MODE ──────────────────────────────────────────
    safeOn(socket, 'createRoom', () => {
        if (isRateLimited(socket, 'createRoom', 3000)) return;
        const code = generateRoomCode();
        currentRoom = new GameRoom(code, socket);
        rooms[code] = currentRoom;
        socket.emit('roomCreated', code);
    });

    safeOn(socket, 'joinRoom', (code) => {
        if (!code) return;
        code = code.toString().toUpperCase();
        const room = rooms[code];
        if (room) {
            if (Object.keys(room.players).length < room.MAX_PLAYERS && (room.state === 'LOBBY' || room.state === 'COUNTDOWN')) {
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

    safeOn(socket, 'joinRandomRoom', (data) => {
        if (isRateLimited(socket, 'joinRandomRoom', 1500)) return;
        const mode = (data && data.mode) ? data.mode : 'mimic';
        if (mode === 'hunter') {
            const availableRooms = Object.values(hunterRooms).filter(
                r => r.isPublic && Object.keys(r.players).length < r.MAX_PLAYERS && r.state === 'LOBBY'
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
                r => r.isPublic && Object.keys(r.players).length < r.MAX_PLAYERS && r.state === 'LOBBY'
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

    safeOn(socket, 'togglePublic', () => {
        if (currentRoom && currentRoom.players[socket.id]?.playerNum === 1 && !currentRoom.isQuickMatch) {
            currentRoom.isPublic = !currentRoom.isPublic;
            io.to(currentRoom.roomId).emit('roomStatus', currentRoom.getLobbyStatus());
        } else if (currentHunterRoom && currentHunterRoom.players[socket.id]?.playerNum === 1 && !currentHunterRoom.isQuickMatch) {
            currentHunterRoom.isPublic = !currentHunterRoom.isPublic;
            io.to(currentHunterRoom.roomId).emit('roomStatus', currentHunterRoom.getLobbyStatus());
        }
    });

    safeOn(socket, 'backToLobby', () => {
        if (currentRoom) currentRoom.resetToLobby();
        if (currentHunterRoom) currentHunterRoom.resetToLobby();
    });

    // Global startNow handler for both modes
    safeOn(socket, 'startNow', () => {
        console.log('[server.js GLOBAL] startNow received from', socket.id);
        if (currentHunterRoom && currentHunterRoom.hostId === socket.id) {
            console.log('[server.js] Starting HunterRoom shuffle');
            currentHunterRoom.stopCountdown();
            currentHunterRoom.startShuffle();
            return;
        }
        if (currentRoom && currentRoom.hostId === socket.id) {
            console.log('[server.js] Starting GameRoom game');
            currentRoom.stopCountdown();
            currentRoom.startShuffle();
            return;
        }
        console.log('[server.js] startNow: not host in any room');
    });

    // ── HUNTER MODE ─────────────────────────────────────────
    safeOn(socket, 'createHunterRoom', () => {
        // Prevent creating if already in a room
        if (currentHunterRoom || currentRoom) {
            socket.emit('errorMsg', 'Tu es déjà dans une room.');
            return;
        }
        if (isRateLimited(socket, 'createHunterRoom', 3000)) return;
        const code = generateRoomCode();
        const room = new HunterRoom(code, socket, io, hunterRooms);
        hunterRooms[code] = room;
        currentHunterRoom = room;
        socket.emit('hunterRoomCreated', { code, maps: Object.keys(HUNTER_MAPS) });
    });

    safeOn(socket, 'joinHunterRoom', (code) => {
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
            socket.emit('errorMsg', `Room HUNTER complète (${room.MAX_PLAYERS} joueurs max).`);
            return;
        }
        currentHunterRoom = room;
        room.addPlayer(socket, Object.keys(room.players).length + 1);
        socket.emit('hunterRoomJoined', { code, maps: Object.keys(HUNTER_MAPS) });
    });

    // ── REJOIN ──────────────────────────────────────────────
    safeOn(socket, 'rejoinRoom', (data) => {
        const token = data && data.token;
        if (!token) return;
        const entry = pendingRejoin[token];
        if (!entry) {
            socket.emit('rejoinFailed');
            return;
        }
        clearTimeout(entry.timer);
        delete pendingRejoin[token];

        if (entry.isHunter) {
            currentHunterRoom = entry.room;
            entry.room.rejoinPlayer(socket, entry.socketId);
        } else {
            currentRoom = entry.room;
            entry.room.rejoinPlayer(socket, entry.socketId);
        }
    });

    // ── DISCONNECT ──────────────────────────────────────────
    safeOn(socket, 'disconnect', () => {
        if (currentRoom)       currentRoom.handleDisconnect(socket.id);
        if (currentHunterRoom) currentHunterRoom.handleDisconnect(socket.id);
    });
});

// Last-resort net: safeOn/safeTick already catch errors in socket handlers and game
// ticks, but anything that slips through (a timer callback we didn't wrap, a stray
// promise) would otherwise kill the process and drop every active room/game at once.
// Logging and staying up is the right tradeoff here over crash-and-restart.
process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (err) => {
    console.error('[unhandledRejection]', err);
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
