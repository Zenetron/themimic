'use strict';

// Shared disconnect/grace-period/host-migration/rejoin/lobby-countdown logic used
// by both GameRoom (server.js, classic/mimic mode) and HunterRoom (hunter-room.js).
// Both room classes are duck-typed: they must expose roomId, io, roomsRef, players,
// hostId, state, interval, lastTime, MAX_PLAYERS, MAX_COUNTDOWN, isQuickMatch,
// countdownSeconds, stopCountdown(), gameLoop(), _checkAfterRemoval(socketId, ...extra).

function generateSessionToken() {
    return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

// Registers a socket event handler that can never crash the process: a malformed payload
// or a latent bug throws inside the try/catch and gets logged instead of killing every
// room on the server. This is the main defense — handlers below should still validate
// untrusted fields where a silently-bad value (NaN, wrong type) could corrupt game state.
function safeOn(socket, event, handler) {
    socket.on(event, (...args) => {
        try {
            handler(...args);
        } catch (err) {
            console.error(`[socket:${event}] handler error:`, err);
        }
    });
}

// Wraps a setInterval/setTimeout tick callback (gameLoop, countdown ticks, ...) so a thrown
// error logs and the timer keeps firing instead of taking down the whole process.
function safeTick(label, fn) {
    return (...args) => {
        try {
            fn(...args);
        } catch (err) {
            console.error(`[tick:${label}] error:`, err);
        }
    };
}

// Per-socket, per-action-key throttle for discrete actions (tag, powerups, room creation).
// Returns true if the call should be dropped (too soon since the last allowed call).
// Not meant for continuous input streams (movement) — only discrete, spammable actions.
function isRateLimited(socket, key, minIntervalMs) {
    if (!socket._rateLimits) socket._rateLimits = {};
    const now = Date.now();
    const last = socket._rateLimits[key] || 0;
    if (now - last < minIntervalMs) return true;
    socket._rateLimits[key] = now;
    return false;
}

const pendingRejoin = {}; // token -> { room, socketId, isHunter, timer }

function migrateHostOnDisconnect(room, socketId) {
    if (socketId !== room.hostId) return;
    const next = Object.entries(room.players)
        .filter(([id, pl]) => !pl.isBot && !pl.disconnected && id !== socketId)
        .sort(([, a], [, b]) => a.playerNum - b.playerNum)[0];
    if (next) {
        room.hostId = next[0];
        room.io.to(room.roomId).emit('hostMigrated', { newHostId: room.hostId });
    }
}

function invalidatePendingRejoinsForRoom(room) {
    for (const [tok, entry] of Object.entries(pendingRejoin)) {
        if (entry.room === room) {
            clearTimeout(entry.timer);
            delete pendingRejoin[tok];
        }
    }
}

function permanentRemove(room, socketId) {
    const p = room.players[socketId];
    if (!p) return;
    const wasInGame = room.state === 'PLAYING';
    delete room.players[socketId];
    room._checkAfterRemoval(socketId, wasInGame);
    room.io.to(room.roomId).emit('playerLeft', { socketId });
}

// Puts a disconnected human player into a 15s reconnect grace period. If that
// leaves nobody actually connected, pauses the tick loop instead of burning CPU
// on an empty room (resumed by resumeLoopIfPaused once someone rejoins).
function startGracePeriod(room, socketId, p, isHunter) {
    const token = generateSessionToken();
    p.disconnected = true;
    p.socket = null;

    pendingRejoin[token] = {
        room,
        socketId,
        isHunter,
        timer: setTimeout(() => {
            delete pendingRejoin[token];
            permanentRemove(room, socketId);
        }, 15000)
    };

    room.io.to(room.roomId).emit('playerDisconnected', { socketId, graceSecs: 15 });

    const connectedHumans = Object.values(room.players).filter(pl => !pl.isBot && !pl.disconnected).length;
    if (connectedHumans === 0 && room.interval) {
        clearInterval(room.interval);
        room.interval = null;
    }
}

function resumeLoopIfPaused(room, fps) {
    if (room.state === 'PLAYING' && !room.interval) {
        room.lastTime = Date.now();
        room.interval = setInterval(safeTick('gameLoop', () => room.gameLoop()), 1000 / fps);
    }
}

// Tears the room down once no human players remain. Returns true if it did.
function cleanupRoomIfEmpty(room) {
    const humansLeft = Object.values(room.players).filter(p => !p.isBot).length;
    if (humansLeft > 0) return false;
    room.stopCountdown();
    if (room.interval) clearInterval(room.interval);
    delete room.roomsRef[room.roomId];
    invalidatePendingRejoinsForRoom(room);
    return true;
}

// Splices a reconnecting socket into room.players under its new id and returns
// the pre-rejoin player snapshot, or null (after emitting rejoinFailed) if the
// old socket id isn't actually in the room anymore.
function beginRejoin(room, newSocket, oldSocketId) {
    const p = room.players[oldSocketId];
    if (!p) { newSocket.emit('rejoinFailed'); return null; }

    const token = generateSessionToken();
    room.players[newSocket.id] = { ...p, socket: newSocket, disconnected: false, sessionToken: token };
    delete room.players[oldSocketId];
    return p;
}

function broadcastCountdown(room, extra = {}) {
    const humans = Object.values(room.players).filter(p => !p.isBot);
    const realCount = humans.length;

    // Last 5s of quick match solo (only 1 real player): reveal fake P2-P6 one by one
    let fakeCount = 0;
    if (room.isQuickMatch && realCount === 1 && room.countdownSeconds <= 5 && room.countdownSeconds > 0) {
        fakeCount = Math.min(room.MAX_PLAYERS - realCount, 6 - room.countdownSeconds);
    }

    const slots = Array.from({ length: room.MAX_PLAYERS }, (_, i) => {
        if (i < realCount) {
            const p = humans[i];
            return { type: 'player', ready: p.isReady, num: p.playerNum };
        }
        if (room.isQuickMatch && i < realCount + fakeCount) {
            return { type: 'player', ready: true, num: i + 1 };
        }
        if (room.isQuickMatch) return { type: 'searching' };
        return { type: 'empty' };
    });

    room.io.to(room.roomId).emit('lobbyCountdown', {
        seconds: room.isQuickMatch ? room.countdownSeconds : null,
        total: room.MAX_COUNTDOWN,
        slots,
        readyCount: humans.filter(p => p.isReady).length + fakeCount,
        playerCount: realCount + fakeCount,
        hostId: room.hostId,
        isQuickMatch: room.isQuickMatch,
        ...extra
    });
}

module.exports = {
    generateSessionToken,
    pendingRejoin,
    migrateHostOnDisconnect,
    startGracePeriod,
    resumeLoopIfPaused,
    cleanupRoomIfEmpty,
    beginRejoin,
    broadcastCountdown,
    safeOn,
    safeTick,
    isRateLimited
};
