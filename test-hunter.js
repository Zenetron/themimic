#!/usr/bin/env node
/**
 * Test script: Vérifier flow Hunter complet (nouvelle architecture HunterRoom)
 * - Crée room hunter
 * - Rejoint room hunter
 * - Prêt des joueurs
 * - Host lance avec startNow
 * - Attend hunterGameStart et valide payload
 * - Attend hunterState et valide payload
 */

const io = require('socket.io-client');

const CLIENT_COUNT = 2; // 1 hunter + 1 ghost pour test simple
let clients = [];
let testPassed = 0;
let testFailed = 0;

function log(msg, type = 'info') {
    console.log(`[${type.toUpperCase()}] ${msg}`);
}

function test(name, condition) {
    if (condition) {
        log(`✓ ${name}`, 'pass');
        testPassed++;
    } else {
        log(`✗ ${name}`, 'fail');
        testFailed++;
    }
}

async function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

async function main() {
    log('Connecting clients...');

    for (let i = 0; i < CLIENT_COUNT; i++) {
        const socket = io('http://localhost:3000', {
            reconnection: true,
            reconnectionDelay: 100
        });

        await new Promise(resolve => {
            socket.on('connect', () => {
                log(`Client ${i+1} connected: ${socket.id}`);
                resolve();
            });
        });

        clients.push(socket);
    }

    log('Creating room...');
    let roomCode = null;
    
    await new Promise(resolve => {
        clients[0].emit('createHunterRoom');
        clients[0].on('hunterRoomCreated', (data) => {
            log(`Room created: ${data.code}`);
            roomCode = data.code;
            resolve();
        });
    });

    // Client 2 joins
    log('Client 2 joining room...');
    await new Promise(resolve => {
        clients[1].emit('joinHunterRoom', roomCode);
        clients[1].on('hunterRoomJoined', (data) => {
            log(`Client 2 joined: ${data.code}`);
            resolve();
        });
    });

    // Both clients playerReady
    log('Clients marking ready...');
    clients[0].emit('playerReady', { avatar: 'Combat-Operative', theme: 'Depot Alpha' });
    clients[1].emit('playerReady', { avatar: 'Combat-Operative' });

    await sleep(200);

    // Host starts game
    log('Host emitting startNow...');
    clients[0].emit('startNow');

    // Wait for hunterGameStart
    let hunterGameStartData = null;
    await new Promise(resolve => {
        const timeout = setTimeout(() => {
            log('Timeout waiting for hunterGameStart', 'warn');
            resolve();
        }, 5000);

        const onHunterGameStart = (data) => {
            log('hunterGameStart event received!', 'pass');
            hunterGameStartData = data;
            clearTimeout(timeout);
            clients[0].off('hunterGameStart', onHunterGameStart);
            resolve();
        };

        clients[0].on('hunterGameStart', onHunterGameStart);
    });

    // Validate payload
    // NOTE: startShuffle() always rolls a random theme (same as classic mode) — the
    // theme requested via playerReady is just a lobby preview, not a guarantee. So
    // tests below must read the actual rolled theme rather than assume 'Depot Alpha'.
    const VALID_HUNTER_THEMES = ['Depot Alpha', 'Zone Charlie', 'Bloc Tactique'];
    if (hunterGameStartData) {
        test('hunterGameStart has gameMode === "hunter"', hunterGameStartData.gameMode === 'hunter');
        test('hunterGameStart has theme', VALID_HUNTER_THEMES.includes(hunterGameStartData.theme));
        test('hunterGameStart has seed', hunterGameStartData.seed !== undefined);
        test('hunterGameStart has props array', Array.isArray(hunterGameStartData.props));
        test('hunterGameStart has hunterId', hunterGameStartData.hunterId !== undefined);
        test('hunterGameStart has roles mapping', typeof hunterGameStartData.roles === 'object');
        test('hunterGameStart phase is RECON', hunterGameStartData.phase === 'RECON');
        test('hunterGameStart has mapSize', hunterGameStartData.mapSize && hunterGameStartData.mapSize.w > 0);
        test('Props count between 40-600', hunterGameStartData.props.length >= 40 && hunterGameStartData.props.length <= 600);
        
        if (hunterGameStartData.props.length > 0) {
            const prop = hunterGameStartData.props[0];
            test('Prop has id', prop.id !== undefined);
            test('Prop has type', prop.type !== undefined);
            test('Prop has x, y', prop.x !== undefined && prop.y !== undefined);
            test('Prop has radius', prop.radius !== undefined);
        }
    } else {
        test('hunterGameStart received', false);
    }

    // Wait for hunterState
    let hunterState = null;
    await new Promise(resolve => {
        const timeout = setTimeout(() => {
            log('Timeout waiting for hunterState', 'warn');
            resolve();
        }, 3000);

        const onHunterState = (data) => {
            log('hunterState event received!', 'pass');
            hunterState = data;
            clearTimeout(timeout);
            clients[0].off('hunterState', onHunterState);
            resolve();
        };

        clients[0].on('hunterState', onHunterState);
    });

    if (hunterState) {
        test('hunterState has players object', typeof hunterState.players === 'object');
        test('hunterState phase is RECON', hunterState.phase === 'RECON');
        test('hunterState hunterHealth === 100', hunterState.hunterHealth === 100);
        
        test('hunterState has doors array', Array.isArray(hunterState.doors));
        // The vault (and its single door) only generates on the 'Depot Alpha' map —
        // other rolled themes legitimately have zero doors.
        const rolledDepotAlpha = hunterGameStartData && hunterGameStartData.theme === 'Depot Alpha';
        const expectedDoorCount = rolledDepotAlpha ? 1 : 0;
        test(`hunterState has ${expectedDoorCount} door(s) for theme ${hunterGameStartData && hunterGameStartData.theme}`,
            hunterState.doors && hunterState.doors.length === expectedDoorCount);
        if (rolledDepotAlpha && hunterState.doors && hunterState.doors.length === 1) {
            test('vault door id is door_vault', hunterState.doors[0].id === 'door_vault');
        }
        
        const playerIds = Object.keys(hunterState.players);
        test('hunterState contains our players', playerIds.length === CLIENT_COUNT);
        if (playerIds.length > 0) {
            const p = hunterState.players[playerIds[0]];
            test('Player has x, y', p.x !== undefined && p.y !== undefined);
            test('Player has role', p.role !== undefined);
            test('Player has disguised status', p.disguised !== undefined);
        }
    } else {
        test('hunterState received', false);
    }

    // Summary
    log('─'.repeat(50));
    log(`Tests passed: ${testPassed}`);
    log(`Tests failed: ${testFailed}`);
    
    // Close
    clients.forEach(c => c.close());
    process.exit(testFailed > 0 ? 1 : 0);
}

main().catch(err => {
    log(`Fatal error: ${err.message}`, 'error');
    clients.forEach(c => c.close());
    process.exit(1);
});
