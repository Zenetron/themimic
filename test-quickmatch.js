#!/usr/bin/env node
const io = require('socket.io-client');

async function main() {
    console.log('Testing Quick Match (Partie Rapide)...');
    
    const socket = io('http://localhost:3000');
    
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
        socket.on('connect', () => {
            console.log('Connected client:', socket.id);
            clearTimeout(timeout);
            resolve();
        });
    });

    console.log('Emitting joinRandomRoom for mimic mode...');
    socket.emit('joinRandomRoom', { mode: 'mimic' });

    let receivedCountdown = false;
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Countdown timeout')), 10000);

        socket.on('roomCreated', (code) => {
            console.log('Room created automatically:', code);
        });

        socket.on('lobbyCountdown', (data) => {
            console.log('lobbyCountdown received:', data);
            if (data.seconds === 0) {
                console.log('Ignoring initial uninitialized countdown event');
                return;
            }
            if (data.isQuickMatch === true && data.seconds > 0) {
                console.log('✓ Success: isQuickMatch is true, seconds remaining:', data.seconds);
                receivedCountdown = true;
                clearTimeout(timeout);
                resolve();
            } else {
                reject(new Error('Invalid lobbyCountdown data'));
            }
        });
    });

    socket.close();
    console.log('Quick Match test passed!');
    process.exit(0);
}

main().catch(err => {
    console.error('Test failed:', err.message);
    process.exit(1);
});
