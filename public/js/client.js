const socket = io();

// UI
const connectMenu = document.getElementById('connectMenu');
const lobbyMenu = document.getElementById('lobbyMenu');
const gameOverMenu = document.getElementById('gameOverMenu');
const hud = document.getElementById('hud');
const errorToast = document.getElementById('errorToast');
const minimapEl = document.getElementById('minimap');
const minimapCanvas = document.getElementById('minimapCanvas');
const minimapCtx = minimapCanvas.getContext('2d');
const playerCounterEl = document.getElementById('playerCounter');
const aliveCountEl = document.getElementById('aliveCount');

const btnCreateRoom = document.getElementById('btnCreateRoom');
const btnJoinRoom = document.getElementById('btnJoinRoom');
const btnJoinRandom = document.getElementById('btnJoinRandom');
const joinCodeInput = document.getElementById('joinCodeInput');
const roomCodeDisplay = document.getElementById('roomCodeDisplay');
const btnReady = document.getElementById('btnReady');

// ── Share widget ─────────────────────────────────
const shareWidget   = document.getElementById('shareWidget');
const shareUrlText  = document.getElementById('shareUrlText');
const btnShare      = document.getElementById('btnShare');
const btnShareLabel = document.getElementById('btnShareLabel');
const shareCopied   = document.getElementById('shareCopiedFlash');
let shareUrl        = '';
let shareCopyTimer  = null;

function updateShareWidget(code, mode) {
    const base = window.location.origin + window.location.pathname;
    const param = mode === 'hunter' ? 'hunter' : 'code';
    shareUrl = `${base}?${param}=${code}`;
    shareUrlText.textContent = shareUrl.replace(/^https?:\/\//, '');
}

btnShare.addEventListener('click', () => {
    if (!shareUrl) return;
    const doCopy = () => {
        navigator.clipboard.writeText(shareUrl).catch(() => {
            const ta = document.createElement('textarea');
            ta.value = shareUrl;
            ta.style.cssText = 'position:fixed;opacity:0';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
        });
    };
    doCopy();
    btnShare.classList.add('copied');
    btnShareLabel.textContent = '✓ COPIÉ !';
    shareCopied.classList.add('visible');
    clearTimeout(shareCopyTimer);
    shareCopyTimer = setTimeout(() => {
        btnShare.classList.remove('copied');
        btnShareLabel.textContent = '⬡ COPY LINK';
        shareCopied.classList.remove('visible');
    }, 1800);
});
const btnTogglePublic = document.getElementById('btnTogglePublic');
const lobbyStatus = document.getElementById('lobbyStatus');
const livesCount = document.getElementById('livesCount');

// Canvas
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

// Minimap size
const MM_SIZE = 180;
minimapCanvas.width = MM_SIZE;
minimapCanvas.height = MM_SIZE;

// Game State Client
let localIsReady = false;
let localPlayerId = socket ? socket.id : null;
let playersInfo = {};
let spectateTargetId = null;
let previousLives = null;
let isHost = false;
let MAP_SIZE = { w: window.innerWidth, h: window.innerHeight };
let theme = 'Military Base';
let mapRule = 'sync';
let alarmPhase = 'idle';
let mapPings = [];
let serverRadarAngle = 0;
let gameState = [];
let latestServerEntities = [];
let interpolatedEntities = {};
let itemsState = []; // Track spawned items
let decorations = []; // Map decorations (bushes, rocks, torches)
let bgParticles = [];
let alivePlayersCount = 0;
let totalPlayersCount = 0;
let tagEffects = []; // Visual clicks {x,y,time}
let classicEndGameMode = 'STORM';
let classicEndGameTriggered = false;
let classicEndGameCountdownRemaining = 30000;
let classicStormRadius = 2500;
let clientLastTime = performance.now();
let hitFeedbackEffects = []; // Hunter hit feedback {x,y,time,type}
let deathParticles = []; // Death burst particles {x,y,vx,vy,life,decay,size,col}
let shakePow = 0; // Current screen shake magnitude

let pickupEffects = []; // Powerup texts {x,y,text,color,time}
let CAMERA = { x: 0, y: 0 };
const LERP_FACTOR = 0.1;

// --- Hunter Mode Variables ---
let roomType = 'mimic'; // 'mimic' or 'hunter'
let myRole = null; // 'hunter' | 'prop'
let hunterId = null;
let selectedMap = 'Depot Alpha';
let lastInputSent = 0;
let decoyEffects = [];
let interpolatedPlayers = {};

const BIOME_FLOOR = {
    'Depot Alpha':   { bg: '#1a1c18', gridCol: 'rgba(90,100,70,0.12)',  accentLine: 'rgba(140,130,80,0.06)' },
    'Zone Charlie':  { bg: '#151a12', gridCol: 'rgba(60,90,50,0.12)',   accentLine: 'rgba(80,120,60,0.06)'  },
    'Bloc Tactique': { bg: '#141519', gridCol: 'rgba(50,70,110,0.12)',  accentLine: 'rgba(60,100,150,0.06)' }
};

const G = {
    state:        'LOBBY',  // LOBBY | PLAYING
    phase:        'RECON',  // RECON | CACHE | HUNT
    phaseEndsAt:  0,
    hunterHealth: 100,
    players:      {},  // id → serialized player
    props:        [],  // map decorations
    mapSize:      { w: 3000, h: 2400 },
    theme:        'Depot Alpha',
    cam:          { x: 0, y: 0, scale: 1 }
};

const keys = { up:false, down:false, left:false, right:false };
let nearbyPropId = null;
let thermalActive = false;
let thermalEndsAt = 0;
let droneActive = false;
let droneData = null;
let droneEndsAt = 0;
let mouseScreenX = 0;
let mouseScreenY = 0;

let currentLang = 'fr';
let selectedMode = 'mimic';
let nextHeartbeatBeepTime = 0;

const langStrings = {
    fr: {
        lobbyMenuTitle: "SALON PRÊT",
        lblRoomCode: "── CODE DU SALON ──",
        lblUnitModel: "Modèle d'unité",
        lblArena: "Arène",
        controlsInfoMimic: `<strong>COMMANDES</strong><br>DÉPLACER : ZQSD ou WASD / FLÈCHES<br>TIRER / VISER : CLIC GAUCHE`,
        controlsInfoHunter: `<strong>COMMANDES (FANTÔME)</strong><br>DÉPLACER : ZQSD ou WASD / FLÈCHES<br>SE DÉGUISER [E] / TOURNER [F]<br>FUMÉE [A] / SPRINT [Shift]<br><br><strong>COMMANDES (CHASSEUR)</strong><br>DÉPLACER : ZQSD ou WASD / FLÈCHES<br>ATTRAPER : CLIC GAUCHE<br>DRONE : [A]`,
        btnSoloTest: "⬡ TEST SOLO",
        btnLobbyLeave: "✕ QUITTER LE SALON",
        btnCreateRoom: "⊕ Créer une Partie",
        lblOrJoinRoom: "ou rejoindre une partie",
        btnJoinRoom: "→ Saisir Code",
        quickMatchOr: "ou",
        btnJoinRandom: "⚡ Partie Rapide",
        btnReady: "▶ PRÊT",
        btnStartNow: "⚡ DÉMARRER MAINTENANT",
        mainMenuTitleMimic: "MIMIC OPS",
        mainMenuSubMimic: "// Prototype v0.1 — Trouver & Éliminer //",
        mainMenuTitleHunter: "PROP HUNT",
        mainMenuSubHunter: "// Opération Hunter — Traquer & Taguer //",
        lblMatchEnded: "── MATCH TERMINÉ ──",
        lblSystemShutdown: "Arrêt du système...",
        btnPlayAgain: "↺ Rejouer",
        btnReturnToConnect: "✕ Quitter Salon",
        
        // HUD / Game specific text
        hudHealthLabel: "CHASSEUR — POINTS DE VIE",
        hudGhostsLabel: "FANTÔMES EN VIE",
        hudControlsTitle: "◈ CONTRÔLES",
        hudControlsMove: '<span class="ctrl-key">ZQSD</span> / <span class="ctrl-key">↑↓←→</span> — Déplacer',
        hudStandbySub: "Le chasseur mémorise les positions · Ne bougez pas",
        hunterHUD_blindSub: "LES FANTÔMES SE CAMOUFLENT — PRÉPAREZ-VOUS À INTERVENIR",
        hunterHUD_disguiseHint: "[ E ] SE DÉGUISER",
        hunterHUD_blindTitle: "AVEUGLEMENT TACTIQUE",
        
        // Avatar Options
        avatar_combat: "🔫 OPÉRATEUR COMBAT",
        avatar_recon: "🚁 DRONE RECON",
        avatar_sniper: "🍃 SNIPER FURTIF",
        avatar_gunner: "💣 ARTILLEUR LOURD"
    },
    en: {
        lobbyMenuTitle: "ROOM READY",
        lblRoomCode: "── ROOM CODE ──",
        lblUnitModel: "Unit Model",
        lblArena: "Arena",
        controlsInfoMimic: `<strong>CONTROLS</strong><br>MOVE: WASD / ARROWS<br>TAG / SHOOT: LEFT CLICK`,
        controlsInfoHunter: `<strong>CONTROLS (GHOST)</strong><br>MOVE: WASD / ARROWS<br>DISGUISE [E] / ROTATE [F]<br>SMOKE [Q] / SPRINT [Shift]<br><br><strong>CONTROLS (HUNTER)</strong><br>MOVE: WASD / ARROWS<br>TAG: LEFT CLICK<br>DRONE: [Q]`,
        btnSoloTest: "⬡ SOLO TEST",
        btnLobbyLeave: "✕ LEAVE ROOM",
        btnCreateRoom: "⊕ Create Room",
        lblOrJoinRoom: "or join a room",
        btnJoinRoom: "→ Join Code",
        quickMatchOr: "or",
        btnJoinRandom: "⚡ Quick Match",
        btnReady: "▶ READY",
        btnStartNow: "⚡ START NOW",
        mainMenuTitleMimic: "MIMIC OPS",
        mainMenuSubMimic: "// Prototype v0.1 — Find & Eliminate //",
        mainMenuTitleHunter: "PROP HUNT",
        mainMenuSubHunter: "// Hunter Operation — Search & Tag //",
        lblMatchEnded: "── MATCH ENDED ──",
        lblSystemShutdown: "System shutting down...",
        btnPlayAgain: "↺ Play Again",
        btnReturnToConnect: "✕ Leave Room",
        
        // HUD / Game specific text
        hudHealthLabel: "HUNTER — LIFE POINTS",
        hudGhostsLabel: "ALIVE GHOSTS",
        hudControlsTitle: "◈ CONTROLS",
        hudControlsMove: '<span class="ctrl-key">WASD</span> / <span class="ctrl-key">↑↓←→</span> — Move',
        hudStandbySub: "Hunter is memorizing positions · Stand still",
        hunterHUD_blindSub: "GHOSTS ARE DISGUISING — GET READY TO ENGAGE",
        hunterHUD_disguiseHint: "[ E ] DISGUISE",
        hunterHUD_blindTitle: "TACTICAL BLINDING",
        
        // Avatar Options
        avatar_combat: "🔫 COMBAT OPERATIVE",
        avatar_recon: "🚁 RECON DRONE",
        avatar_sniper: "🍃 STEALTH SNIPER",
        avatar_gunner: "💣 HEAVY GUNNER"
    }
};

function t(key) {
    const isEng = (currentLang === 'en');
    const strings = {
        phaseCache: isEng ? "⏱ CACHE PHASE — HIDE YOURSELF !" : "⏱ PHASE CACHE — CACHEZ-VOUS !",
        phaseHunt: isEng ? "🎯 HUNT OPENED !" : "🎯 CHASSE OUVERTE !",
        disguiseActivated: isEng ? "🎭 DISGUISE ACTIVATED" : "🎭 DÉGUISEMENT ACTIVÉ",
        ghostHidden: isEng ? "👻 A ghost has hidden" : "👻 Un fantôme s'est caché",
        youEliminated: isEng ? "💀 YOU HAVE BEEN ELIMINATED !" : "💀 TU AS ÉTÉ ÉLIMINÉ !",
        ghostEliminated: isEng ? "🎯 GHOST ELIMINATED !" : "🎯 FANTÔME ÉLIMINÉ !",
        wrongDecoy: isEng ? "❌ WRONG LEAD −5 HP" : "❌ FAUSSE PISTE −5 PV",
        wrongMiss: isEng ? "❌ MISSED SHOT −5 HP" : "❌ TIR RATÉ −5 PV",
        droneActive: isEng ? "🛸 RECON DRONE ACTIVE" : "🛸 DRONE RECON ACTIF",
        disguiseHint: isEng ? "[ E ] DISGUISE" : "[ E ] SE DÉGUISER",
        smokeActive: isEng ? "💨 Smoke screen deployed !" : "💨 Écran de fumée déployé !",
        sprintActive: isEng ? "⚡ Sprint activated !" : "⚡ Sprint activé !",
        doorToggled: isEng ? "🚪 Door state changed !" : "🚪 État de la porte modifié !",
        teleported: isEng ? "🌀 Teleporter used !" : "🌀 Téléporteur utilisé !"
    };
    return strings[key] || key;
}

function applyLanguage(lang) {
    currentLang = lang;
    const s = langStrings[lang];
    
    const ids = [
        'lobbyMenuTitle', 'lblRoomCode', 'lblUnitModel', 'lblArena', 
        'btnSoloTest', 'btnLobbyLeave', 'btnCreateRoom', 
        'lblOrJoinRoom', 'btnJoinRoom', 'quickMatchOr', 'btnJoinRandom', 
        'btnReady', 'btnStartNow', 
        'lblMatchEnded', 'lblSystemShutdown', 'btnPlayAgain', 'btnReturnToConnect',
        'hudHealthLabel', 'hudGhostsLabel', 'hudControlsTitle', 'hudControlsMove',
        'hudStandbySub', 'hunterHUD_blindSub', 'hunterHUD_disguiseHint', 'hunterHUD_blindTitle'
    ];
    
    ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            if (id === 'hudControlsMove') {
                el.innerHTML = s[id];
            } else {
                el.textContent = s[id];
            }
        }
    });

    const btnTogglePublic = document.getElementById('btnTogglePublic');
    if (btnTogglePublic) {
        const isPublic = btnTogglePublic.textContent.toLowerCase().includes('public');
        if (isPublic) {
            btnTogglePublic.textContent = (lang === 'en') ? "Room is PUBLIC (Click to Hide)" : "Salon PUBLIC (Cliquer pour masquer)";
        } else {
            btnTogglePublic.textContent = (lang === 'en') ? "Room is PRIVATE (Click to Publish)" : "Salon PRIVÉ (Cliquer pour publier)";
        }
    }
    
    const avSelect = document.getElementById('avatarSelect');
    if (avSelect) {
        const opts = avSelect.options;
        if (opts[0]) opts[0].textContent = s.avatar_combat;
        if (opts[1]) opts[1].textContent = s.avatar_recon;
        if (opts[2]) opts[2].textContent = s.avatar_sniper;
        if (opts[3]) opts[3].textContent = s.avatar_gunner;
    }

    // Update main menu texts based on selectedMode
    const mainTitleEl = document.getElementById('mainMenuTitle');
    const mainSubEl = document.getElementById('mainMenuSub');
    if (mainTitleEl && mainSubEl) {
        if (selectedMode === 'mimic') {
            mainTitleEl.textContent = s.mainMenuTitleMimic;
            mainSubEl.textContent = s.mainMenuSubMimic;
        } else {
            mainTitleEl.textContent = s.mainMenuTitleHunter;
            mainSubEl.textContent = s.mainMenuSubHunter;
        }
    }

    // Update controlsInfo based on selectedMode
    const controlsEl = document.getElementById('controlsInfo');
    if (controlsEl) {
        if (selectedMode === 'mimic') {
            controlsEl.innerHTML = s.controlsInfoMimic;
        } else {
            controlsEl.innerHTML = s.controlsInfoHunter;
        }
    }

    // Update player badge role if active
    const badge = document.getElementById('hunterHUD_roleBadge');
    if (badge) {
        if (myRole === 'hunter') {
            badge.textContent = (lang === 'en') ? '🔴 OPERATIVE' : '🔴 OPÉRATEUR';
        } else if (myRole === 'prop') {
            badge.textContent = (lang === 'en') ? '👻 GHOST' : '👻 FANTÔME';
        }
    }

    updateLobbyThemeOptions();

    const flag = document.getElementById('currentLangFlag');
    const text = document.getElementById('currentLangText');
    if (flag) flag.textContent = lang === 'fr' ? '🇫🇷' : '🇬🇧';
    if (text) text.textContent = lang === 'fr' ? 'FR' : 'EN';
}

function updateLobbyThemeOptions() {
    const select = document.getElementById('themeSelect');
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '';
    const isEng = (currentLang === 'en');
    if (roomType === 'hunter') {
        select.innerHTML = `
            <option value="Depot Alpha">${isEng ? '🌲 DEPOT ALPHA — Industrial Sector' : '🌲 DÉPÔT ALPHA — Secteur Industriel'}</option>
            <option value="Zone Charlie">${isEng ? '🌾 ZONE CHARLIE — Camouflage Netting' : '🌾 ZONE CHARLIE — Filet de Camouflage'}</option>
            <option value="Bloc Tactique">${isEng ? '🏢 BLOC TACTIQUE — Server Complex' : '🏢 BLOC TACTIQUE — Complexe Serveur'}</option>
        `;
        selectedMap = select.value;
        document.getElementById('btnSoloTest').style.display = 'none';
        if (isHost) {
            document.getElementById('btnStartNow').style.display = 'inline-block';
        }
    } else {
        select.innerHTML = `
            <option value="Military Base">${isEng ? '🏭 INDUSTRIAL SECTOR — Sync Events' : '🏭 SECTEUR INDUSTRIEL — Événements de Sync'}</option>
            <option value="Weapon Warehouse">${isEng ? '⛓️ WEAPON WAREHOUSE — Alarm Lockdown' : '⛓️ ENTREPÔT D\'ARMES — Confinement Alerte'}</option>
            <option value="Command Center">${isEng ? '📡 COMMAND CENTER — Radar Sweep' : '📡 CENTRE DE COMMANDE — Balayage Radar'}</option>
        `;
        document.getElementById('btnSoloTest').style.display = 'inline-block';
        if (isHost) {
            document.getElementById('btnStartNow').style.display = 'inline-block';
        }
    }
    if (currentVal) select.value = currentVal;
}

// Language Selector dropdown toggle and close on click outside
const btnLang = document.getElementById('btnLang');
const langDropdown = document.getElementById('langDropdown');

// ── Mute toggle ────────────────────────────────────────────────────
const btnMute = document.getElementById('btnMute');
function toggleMute() {
    isMuted = !isMuted;
    if (masterGain) masterGain.gain.value = isMuted ? 0 : 1;
    btnMute.textContent = isMuted ? '🔇' : '🔊';
    btnMute.title = isMuted
        ? (currentLang === 'en' ? 'Unmute' : 'Activer le son')
        : (currentLang === 'en' ? 'Mute'   : 'Couper le son');
}
btnMute.addEventListener('click', () => toggleMute());

btnLang.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = langDropdown.style.display === 'none' || langDropdown.style.display === '';
    langDropdown.style.display = isHidden ? 'block' : 'none';
});

document.addEventListener('click', (e) => {
    if (!btnLang.contains(e.target) && !langDropdown.contains(e.target)) {
        langDropdown.style.display = 'none';
    }
});

// Language options click handler
document.querySelectorAll('.lang-option').forEach(el => {
    el.addEventListener('click', () => {
        const lang = el.getAttribute('data-lang');
        applyLanguage(lang);
        localStorage.setItem('game_lang', lang);
        langDropdown.style.display = 'none';
    });
});

// Initialize language with Geo-IP detection
const savedLang = localStorage.getItem('game_lang');
if (savedLang) {
    applyLanguage(savedLang);
} else {
    // Instant fallback to browser language to prevent empty text
    const browserLang = (navigator.language || navigator.userLanguage || 'fr').toLowerCase();
    const defaultLang = browserLang.startsWith('fr') ? 'fr' : 'en';
    applyLanguage(defaultLang);
    
    // Query public GeoIP endpoint
    fetch('https://api.country.is/')
        .then(res => res.json())
        .then(data => {
            if (data && data.country) {
                const ipLang = (data.country === 'FR') ? 'fr' : 'en';
                if (!localStorage.getItem('game_lang')) {
                    applyLanguage(ipLang);
                }
            }
        })
        .catch(err => {
        });
}

function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    // The map size on frontend matches window. Wait for server map size override if any.
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

function updateLivesGraphically(lives) {
    let hearts = "";
    for (let i = 0; i < lives; i++) {
        hearts += "♥";
    }
    // Add empty hearts to show lost lives
    for (let i = lives; i < 3; i++) {
        hearts += "♡";
    }
    livesCount.innerHTML = hearts;
}

function showError(msg) {
    errorToast.textContent = msg;
    errorToast.style.opacity = 1;
    setTimeout(() => errorToast.style.opacity = 0, 3000);
}

// ---------- AUDIO ENGINE ----------

let audioCtx = null;
let musicNodes = {}; // for background music oscillators
let musicGain = null;
let masterGain = null;
let isMuted = false;

function ensureAudioCtx() {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        masterGain = audioCtx.createGain();
        masterGain.gain.value = isMuted ? 0 : 1;
        masterGain.connect(audioCtx.destination);
        musicGain = audioCtx.createGain();
        musicGain.gain.value = 0.15;
        musicGain.connect(masterGain);
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
}

// ----- SFX helpers -----

function sfxBeep(freq, duration, type = 'square', vol = 0.25) {
    try {
        ensureAudioCtx();
        if (!audioCtx) return;
        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        g.gain.setValueAtTime(vol, audioCtx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
        osc.connect(g);
        g.connect(masterGain);
        osc.start();
        osc.stop(audioCtx.currentTime + duration);
    } catch (e) {
        console.warn('[sfxBeep] Audio Context error:', e);
    }
}

function sfxPickupHeart() {
    // Rising arpeggio
    [523, 659, 784, 1047].forEach((f, i) => {
        setTimeout(() => sfxBeep(f, 0.12, 'sine', 0.3), i * 50);
    });
}

function sfxPickupShapeshift() {
    // Weird glitchy sweep
    ensureAudioCtx();
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(200, audioCtx.currentTime);
    osc.frequency.linearRampToValueAtTime(1200, audioCtx.currentTime + 0.18);
    osc.frequency.linearRampToValueAtTime(400, audioCtx.currentTime + 0.35);
    g.gain.setValueAtTime(0.3, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.4);
    osc.connect(g);
    g.connect(masterGain);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.4);
}

function sfxTag() {
    // Impact thud
    ensureAudioCtx();
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.15, audioCtx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
    const src = audioCtx.createBufferSource();
    src.buffer = buf;
    const g = audioCtx.createGain();
    g.gain.value = 0.5;
    src.connect(g);
    g.connect(masterGain);
    src.start();
}

function sfxLoseLife() {
    // Descending tones
    [440, 330, 220].forEach((f, i) => {
        setTimeout(() => sfxBeep(f, 0.2, 'sawtooth', 0.28), i * 80);
    });
}

function sfxWin() {
    [523, 659, 784, 1047, 1319].forEach((f, i) => {
        setTimeout(() => sfxBeep(f, 0.2, 'sine', 0.3), i * 90);
    });
}

// Hunter-only cue: a prop just gave away a noise. Louder/closer = higher volume (0-1).
function sfxPropNoise(volume) {
    const v = Math.max(0.05, Math.min(1, volume));
    sfxBeep(190, 0.35, 'sine', v * 0.5);
    setTimeout(() => sfxBeep(150, 0.45, 'sine', v * 0.35), 100);
}

function sfxLose() {
    [440, 370, 294, 220].forEach((f, i) => {
        setTimeout(() => sfxBeep(f, 0.25, 'square', 0.25), i * 100);
    });
}

// ----- Background music -----
// A simple looping chip-music pattern using oscillators

let musicInterval = null;
const MELODY = [523, 659, 784, 659, 523, 392, 440, 523]; // C5, E5, G5...
let melodyStep = 0;

function startMusic() {
    ensureAudioCtx();
    stopMusic();

    // Bass drone
    const bass = audioCtx.createOscillator();
    const bassG = audioCtx.createGain();
    bass.type = 'square';
    bass.frequency.value = 110; // A2
    bassG.gain.value = 0.05;
    bass.connect(bassG);
    bassG.connect(musicGain);
    bass.start();
    musicNodes.bass = bass;
    musicNodes.bassG = bassG;

    // Pad
    const pad = audioCtx.createOscillator();
    const padG = audioCtx.createGain();
    pad.type = 'sawtooth';
    pad.frequency.value = 220;
    padG.gain.value = 0.04;
    pad.connect(padG);
    padG.connect(musicGain);
    pad.start();
    musicNodes.pad = pad;
    musicNodes.padG = padG;

    // Arpeggio melody ticks
    melodyStep = 0;
    musicInterval = setInterval(() => {
        if (!audioCtx) return;
        const freq = MELODY[melodyStep % MELODY.length];
        melodyStep++;
        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0.07, audioCtx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.18);
        osc.connect(g);
        g.connect(musicGain);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.2);

        // Drum kick every 4 beats
        if (melodyStep % 4 === 0) {
            const kick = audioCtx.createOscillator();
            const kg = audioCtx.createGain();
            kick.type = 'sine';
            kick.frequency.setValueAtTime(160, audioCtx.currentTime);
            kick.frequency.exponentialRampToValueAtTime(30, audioCtx.currentTime + 0.08);
            kg.gain.setValueAtTime(0.35, audioCtx.currentTime);
            kg.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.12);
            kick.connect(kg);
            kg.connect(masterGain);
            kick.start();
            kick.stop(audioCtx.currentTime + 0.15);
        }
    }, 200); // 200ms per note = ~150BPM 8th notes
}

function stopMusic() {
    if (musicInterval) { clearInterval(musicInterval); musicInterval = null; }
    for (const key of Object.keys(musicNodes)) {
        try { musicNodes[key].stop ? musicNodes[key].stop() : musicNodes[key].disconnect(); } catch(e) {}
    }
    musicNodes = {};
}

// ── MENU MUSIC (epic war theme) ───────────────────────────────────
let menuMusicInterval = null;
let menuMusicNodes = {};
let menuMusicStarted = false;

function startMenuMusic() {
    ensureAudioCtx();
    stopMenuMusic();

    // Bass drones — A1, thick layered
    [[55, 0.05], [55.35, 0.03], [110, 0.022]].forEach(([freq, vol], i) => {
        const osc = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.value = freq;
        g.gain.value = vol;
        osc.connect(g);
        g.connect(masterGain);
        osc.start();
        menuMusicNodes[`d${i}`] = osc;
    });

    // Sustained Am pad (A2–E4, detuned pairs for width)
    [110, 130.81, 164.81, 220, 261.63].forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const filt = audioCtx.createBiquadFilter();
        const g = audioCtx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.value = freq + (i % 2 === 0 ? 0.45 : -0.45);
        filt.type = 'lowpass';
        filt.frequency.value = 850;
        g.gain.value = 0.017;
        osc.connect(filt); filt.connect(g); g.connect(masterGain);
        osc.start();
        menuMusicNodes[`p${i}`] = osc;
    });

    // Sequencer — 16th notes at 80 BPM
    const STEP_MS = (60 / 80 / 4) * 1000; // 187.5 ms

    // Chord cycle: Am → G → F → Em (8 steps each)
    const CHORDS = [
        [220, 261.63, 329.63],
        [196,  246.94, 293.66],
        [174.61, 220, 261.63],
        [164.81, 207.65, 246.94],
    ];

    //                   1  2  3  4  5  6  7  8  9 10 11 12 13 14 15 16
    const KICK_PAT   = [1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0];
    const SNARE_PAT  = [0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0];
    const HAT_PAT    = [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0];
    const BRASS_PAT  = [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0];

    let menuStep = 0;
    menuMusicInterval = setInterval(() => {
        if (!audioCtx) return;
        const now = audioCtx.currentTime;
        const s = menuStep % 16;
        const chordIdx = Math.floor((menuStep % 32) / 8);

        // Timpani kick
        if (KICK_PAT[s]) {
            const k = audioCtx.createOscillator(), kg = audioCtx.createGain();
            k.type = 'sine';
            k.frequency.setValueAtTime(100, now);
            k.frequency.exponentialRampToValueAtTime(26, now + 0.22);
            kg.gain.setValueAtTime(0.58, now);
            kg.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
            k.connect(kg); kg.connect(masterGain);
            k.start(now); k.stop(now + 0.35);
        }

        // Military snare
        if (SNARE_PAT[s]) {
            const bLen = Math.floor(audioCtx.sampleRate * 0.17);
            const buf = audioCtx.createBuffer(1, bLen, audioCtx.sampleRate);
            const d = buf.getChannelData(0);
            for (let i = 0; i < bLen; i++) d[i] = Math.random() * 2 - 1;
            const src = audioCtx.createBufferSource(); src.buffer = buf;
            const sg = audioCtx.createGain();
            sg.gain.setValueAtTime(0.28, now);
            sg.gain.exponentialRampToValueAtTime(0.001, now + 0.17);
            src.connect(sg); sg.connect(masterGain); src.start(now);
        }

        // Hi-hat (subtle)
        if (HAT_PAT[s]) {
            const bLen = Math.floor(audioCtx.sampleRate * 0.028);
            const buf = audioCtx.createBuffer(1, bLen, audioCtx.sampleRate);
            const d = buf.getChannelData(0);
            for (let i = 0; i < bLen; i++) d[i] = Math.random() * 2 - 1;
            const src = audioCtx.createBufferSource(); src.buffer = buf;
            const hf = audioCtx.createBiquadFilter();
            hf.type = 'highpass'; hf.frequency.value = 7000;
            const hg = audioCtx.createGain();
            hg.gain.setValueAtTime(0.065, now);
            hg.gain.exponentialRampToValueAtTime(0.001, now + 0.028);
            src.connect(hf); hf.connect(hg); hg.connect(masterGain); src.start(now);
        }

        // Brass chord stab
        if (BRASS_PAT[s]) {
            CHORDS[chordIdx].forEach(freq => {
                const o = audioCtx.createOscillator();
                const filt = audioCtx.createBiquadFilter();
                const g = audioCtx.createGain();
                o.type = 'sawtooth';
                o.frequency.value = freq * 2;
                filt.type = 'lowpass'; filt.frequency.value = 1800; filt.Q.value = 0.7;
                g.gain.setValueAtTime(0.095, now);
                g.gain.setValueAtTime(0.055, now + 0.06);
                g.gain.exponentialRampToValueAtTime(0.001, now + STEP_MS * 6 / 1000);
                o.connect(filt); filt.connect(g); g.connect(masterGain);
                o.start(now); o.stop(now + STEP_MS * 7 / 1000);
            });
        }

        menuStep++;
    }, STEP_MS);
}

function stopMenuMusic() {
    if (menuMusicInterval) { clearInterval(menuMusicInterval); menuMusicInterval = null; }
    for (const key of Object.keys(menuMusicNodes)) {
        try { menuMusicNodes[key].stop ? menuMusicNodes[key].stop() : menuMusicNodes[key].disconnect(); } catch(e) {}
    }
    menuMusicNodes = {};
}

// ── Screen shake (CSS transform on canvas — zero draw-call cost) ──
function triggerShake(power) { shakePow = Math.max(shakePow, power); }

function applyShake() {
    if (shakePow > 0.2) {
        canvas.style.transform = `translate(${(Math.random()*2-1)*shakePow|0}px,${(Math.random()*2-1)*shakePow|0}px)`;
        shakePow *= 0.78;
    } else if (shakePow) {
        canvas.style.transform = '';
        shakePow = 0;
    }
}

// ── Death particles ──
function spawnDeathParticles(x, y, col, count) {
    const n = count || 14;
    for (let i = 0; i < n; i++) {
        const angle = (Math.PI * 2 * i / n) + Math.random() * 0.5;
        const speed = 2 + Math.random() * 5;
        deathParticles.push({
            x, y,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: 1,
            decay: 0.022 + Math.random() * 0.018,
            size: 2.5 + Math.random() * 4,
            col
        });
    }
}

function drawDeathParticles(camX, camY, scale) {
    if (!deathParticles.length) return;
    ctx.save();
    ctx.scale(scale || 1, scale || 1);
    ctx.translate(-camX, -camY);
    for (let i = deathParticles.length - 1; i >= 0; i--) {
        const p = deathParticles[i];
        p.x += p.vx; p.y += p.vy;
        p.vx *= 0.91; p.vy *= 0.91;
        p.life -= p.decay;
        if (p.life <= 0) { deathParticles.splice(i, 1); continue; }
        ctx.globalAlpha = p.life;
        ctx.fillStyle = p.col;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
}

// ── Lobby ambient music ──
// 16-step grid at 8th-note = 280ms. C minor pentatonic phrase that loops.
// null = rest, [freq, holdBeats, vol] = note.
const LOBBY_GRID = [
    [261.6, 1, 0.11],  // C4  tap
    null,
    [392.0, 1, 0.10],  // G4  tap
    [466.2, 1, 0.10],  // Bb4 tap
    null,
    [523.3, 2, 0.13],  // C5  held (2 beats)
    null,
    null,
    [392.0, 1, 0.10],  // G4  down
    null,
    [311.1, 1, 0.09],  // Eb4
    [261.6, 3, 0.12],  // C4  long resolve
    null,
    null,
    null,
    null,
];
const LOBBY_STEP_MS = 280;
let lobbyMusicInterval = null;
let lobbyStep = 0;

function startLobbyMusic() {
    stopLobbyMusic();
    ensureAudioCtx();
    lobbyStep = 0;
    lobbyMusicInterval = setInterval(() => {
        if (!audioCtx) return;
        const cell = LOBBY_GRID[lobbyStep % LOBBY_GRID.length];
        lobbyStep++;
        if (!cell) return;
        const [freq, hold, vol] = cell;
        const holdSec = hold * LOBBY_STEP_MS / 1000;
        const osc = audioCtx.createOscillator();
        const env = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        env.gain.setValueAtTime(0, audioCtx.currentTime);
        env.gain.linearRampToValueAtTime(vol, audioCtx.currentTime + 0.06);
        env.gain.setValueAtTime(vol, audioCtx.currentTime + holdSec * 0.6);
        env.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + holdSec + 0.15);
        osc.connect(env);
        env.connect(masterGain);
        osc.start();
        osc.stop(audioCtx.currentTime + holdSec + 0.2);
    }, LOBBY_STEP_MS);
}

function stopLobbyMusic() {
    if (lobbyMusicInterval) { clearInterval(lobbyMusicInterval); lobbyMusicInterval = null; }
}



socket.on('connect', () => {
    localPlayerId = socket.id;

    // Attempt session rejoin first
    const rejoinToken = sessionStorage.getItem('mimic_token');
    if (rejoinToken) {
        socket.emit('rejoinRoom', { token: rejoinToken });
        return; // wait for rejoinSuccess or rejoinFailed before doing anything else
    }

    // Auto-join from shared URL (?code=XXXX or ?hunter=XXXX)
    const urlParams = new URLSearchParams(window.location.search);
    const autoMimic  = urlParams.get('code');
    const autoHunter = urlParams.get('hunter');
    if (autoMimic) {
        joinCodeInput.value = autoMimic.toUpperCase();
        // Switch to mimic mode visually
        document.getElementById('btnSelectMimic')?.classList.add('active');
        document.getElementById('btnSelectHunter')?.classList.remove('active');
        selectedMode = 'mimic';
        socket.emit('joinRoom', autoMimic.toUpperCase());
        roomType = 'mimic';
        isHost = false;
    } else if (autoHunter) {
        joinCodeInput.value = autoHunter.toUpperCase();
        document.getElementById('btnSelectHunter')?.classList.add('active');
        document.getElementById('btnSelectMimic')?.classList.remove('active');
        selectedMode = 'hunter';
        socket.emit('joinHunterRoom', autoHunter.toUpperCase());
        roomType = 'hunter';
        isHost = false;
    }
    // Clean the URL without reloading
    if (autoMimic || autoHunter) {
        window.history.replaceState({}, '', window.location.pathname);
    }
});
if (socket && socket.id) {
    localPlayerId = socket.id;
}

// ── Session token persistence ────────────────────────
socket.on('sessionToken', ({ token, roomCode, isHunter }) => {
    sessionStorage.setItem('mimic_token', token);
    sessionStorage.setItem('mimic_room', roomCode);
    sessionStorage.setItem('mimic_isHunter', isHunter ? '1' : '0');
});

socket.on('rejoinFailed', () => {
    sessionStorage.removeItem('mimic_token');
    sessionStorage.removeItem('mimic_room');
    sessionStorage.removeItem('mimic_isHunter');
});

socket.on('rejoinSuccess', (data) => {
    sessionStorage.removeItem('mimic_token');
    sessionStorage.removeItem('mimic_room');
    sessionStorage.removeItem('mimic_isHunter');
    localPlayerId = socket.id;

    if (data.mode === 'hunter') {
        roomType = 'hunter';
        myRole = data.role;
        G.state = 'PLAYING';
        G.phase = data.phase;
        G.mapSize = data.mapSize;
        G.theme = data.theme;
        G.hunterHealth = data.hunterHealth;
        G.props = data.props || [];
        G.teleporters = data.teleporters || [];
        G.phaseEndsAt = Date.now() + (data.remaining || 0);
        G.cam = { x: 0, y: 0, scale: 1 };
        hunterId = data.hunterId;

        G.players = {};
        const ghostIds = Object.entries(data.roles || {}).filter(([, v]) => v.role === 'prop').map(([id]) => id);
        for (const [id, role] of Object.entries(data.roles || {})) {
            G.players[id] = {
                role: role.role,
                lives: role.role === 'prop' ? 3 : 1,
                eliminated: false,
                num: role.num,
                avatar: role.avatar,
                x: role.x,
                y: role.y,
                angle: 0
            };
        }

        const badge = document.getElementById('hunterHUD_roleBadge');
        if (badge) {
            const isEng = (currentLang === 'en');
            if (myRole === 'hunter') {
                badge.textContent = isEng ? '🔴 OPERATIVE' : '🔴 OPÉRATEUR';
                badge.className = 'role-badge role-hunter';
            } else {
                badge.textContent = isEng ? '👻 GHOST' : '👻 FANTÔME';
                badge.className = 'role-badge role-ghost';
            }
        }

        buildGhostIndicators(ghostIds);
        buildPowerupsHUD();
        applyPhaseOverlays(data.phase, G.phaseEndsAt);
        updateHealthHUD();
        updateCtrlHints();
        updateTimerHUD();

        lobbyMenu.classList.add('hidden');
        const hHUD = document.getElementById('hunterHUD');
        if (hHUD) hHUD.classList.remove('hidden');
        const notif = (currentLang === 'en') ? 'Reconnected!' : 'Reconnecté !';
        showNotif(notif, 'success');
        startMusic();
        requestAnimationFrame(renderLoop);
    } else {
        // mimic mode
        theme = data.theme;
        mapRule = data.mapRule || 'sync';
        MAP_SIZE = data.mapSize;
        decorations = data.decorations || [];
        initEnvironment();
        playersInfo = data.playersInfo || {};
        if (playersInfo[localPlayerId]) {
            previousLives = playersInfo[localPlayerId].lives;
            updateLivesGraphically(previousLives);
        }
        clientLastTime = performance.now();
        lobbyMenu.classList.add('hidden');
        hud.style.display = 'block';
        minimapEl.style.display = 'block';
        playerCounterEl.style.display = 'block';
        document.getElementById('spectatorOverlay').classList.add('hidden');
        const notif = (currentLang === 'en') ? 'Reconnected!' : 'Reconnecté !';
        showNotif(notif, 'success');
        startMusic();
        requestAnimationFrame(renderLoop);
    }
});

socket.on('hostMigrated', ({ newHostId }) => {
    if (newHostId === localPlayerId) {
        isHost = true;
        const msg = (currentLang === 'en') ? 'You are now the host' : "Vous êtes maintenant l'hôte";
        showNotif(msg, 'info');
        // Show host controls if in lobby
        const btnStartNow = document.getElementById('btnStartNow');
        if (btnStartNow) btnStartNow.style.display = 'inline-block';
        btnTogglePublic.style.display = '';
    }
});

socket.on('playerDisconnected', ({ socketId, graceSecs }) => {
    const msg = (currentLang === 'en')
        ? `A player disconnected — ${graceSecs}s to reconnect`
        : `Un joueur s'est déconnecté — ${graceSecs}s pour revenir`;
    showNotif(msg, 'warn');
});

socket.on('playerRejoined', ({ socketId }) => {
    const msg = (currentLang === 'en') ? 'A player reconnected!' : 'Un joueur a reconnecté !';
    showNotif(msg, 'success');
});

// Game Mode Selection on First Page
selectedMode = 'mimic';
const btnSelectMimic = document.getElementById('btnSelectMimic');
const btnSelectHunter = document.getElementById('btnSelectHunter');
const mainMenuTitle = document.getElementById('mainMenuTitle');
const mainMenuSub = document.getElementById('mainMenuSub');
const quickMatchOr = document.getElementById('quickMatchOr');

btnSelectMimic.addEventListener('click', () => {
    selectedMode = 'mimic';
    btnSelectMimic.classList.add('active');
    btnSelectHunter.classList.remove('active');
    const s = langStrings[currentLang];
    mainMenuTitle.textContent = s.mainMenuTitleMimic;
    mainMenuSub.textContent = s.mainMenuSubMimic;
    const controlsEl = document.getElementById('controlsInfo');
    if (controlsEl) controlsEl.innerHTML = s.controlsInfoMimic;
    btnJoinRandom.classList.remove('hidden');
    if (quickMatchOr) quickMatchOr.classList.remove('hidden');
});

btnSelectHunter.addEventListener('click', () => {
    selectedMode = 'hunter';
    btnSelectHunter.classList.add('active');
    btnSelectMimic.classList.remove('active');
    const s = langStrings[currentLang];
    mainMenuTitle.textContent = s.mainMenuTitleHunter;
    mainMenuSub.textContent = s.mainMenuSubHunter;
    const controlsEl = document.getElementById('controlsInfo');
    if (controlsEl) controlsEl.innerHTML = s.controlsInfoHunter;
    btnJoinRandom.classList.remove('hidden');
    if (quickMatchOr) quickMatchOr.classList.remove('hidden');
});

btnCreateRoom.addEventListener('click', () => {
    if (selectedMode === 'hunter') {
        socket.emit('createHunterRoom');
        isHost = true;
        roomType = 'hunter';
        updateLobbyThemeOptions();
        return;
    }
    socket.emit('createRoom');
    isHost = true;
    roomType = 'mimic';
    updateLobbyThemeOptions();
});

btnJoinRoom.addEventListener('click', () => {
    const code = joinCodeInput.value.trim().toUpperCase();
    if (code.length === 4) {
        if (selectedMode === 'hunter') {
            socket.emit('joinHunterRoom', code);
            isHost = false;
            roomType = 'hunter';
            updateLobbyThemeOptions();
            return;
        }
        socket.emit('joinRoom', code);
        isHost = false;
        roomType = 'mimic';
        updateLobbyThemeOptions();
    } else {
        showError("Invalid Code");
    }
});

btnJoinRandom.addEventListener('click', () => {
    socket.emit('joinRandomRoom', { mode: selectedMode });
    isHost = false;
});

socket.on('hunterRoomCreated', (data) => {
    isHost = true;
    roomType = 'hunter';
    connectMenu.classList.add('hidden');
    lobbyMenu.classList.remove('hidden');
    roomCodeDisplay.textContent = data.code;
    updateLobbyThemeOptions();
    document.getElementById('hostSettings').style.display = 'block';
    updateShareWidget(data.code, 'hunter');
    shareWidget.style.display = 'flex';
    stopMenuMusic();
    startLobbyMusic();
});

socket.on('hunterRoomJoined', (data) => {
    isHost = false;
    roomType = 'hunter';
    connectMenu.classList.add('hidden');
    lobbyMenu.classList.remove('hidden');
    roomCodeDisplay.textContent = data.code;
    updateLobbyThemeOptions();
    document.getElementById('hostSettings').style.display = 'none';
    shareWidget.style.display = 'none';
    stopMenuMusic();
    startLobbyMusic();
});

socket.on('roomCreated', (code) => {
    roomType = 'mimic';
    connectMenu.classList.add('hidden');
    lobbyMenu.classList.remove('hidden');
    roomCodeDisplay.textContent = code;
    updateLobbyThemeOptions();
    document.getElementById('hostSettings').style.display = 'block';
    updateShareWidget(code, 'mimic');
    shareWidget.style.display = 'flex';
    stopMenuMusic();
    startLobbyMusic();
});

socket.on('roomJoined', (code) => {
    roomType = 'mimic';
    connectMenu.classList.add('hidden');
    lobbyMenu.classList.remove('hidden');
    roomCodeDisplay.textContent = code;
    updateLobbyThemeOptions();
    // Guest doesn't pick theme or public status
    document.getElementById('hostSettings').style.display = 'none';
    shareWidget.style.display = 'none';
    stopMenuMusic();
    startLobbyMusic();
});

btnTogglePublic.addEventListener('click', () => {
    if (isHost) {
        socket.emit('togglePublic');
    }
});

socket.on('errorMsg', (msg) => {
    showError(msg);
});

socket.on('roomStatus', (status) => {
    localPlayerId = socket.id;
    // Hide spectator overlay
    document.getElementById('spectatorOverlay').classList.add('hidden');

    if (status.state === 'LOBBY') {
        countdownWrap.classList.remove('active');
        if (!localIsReady) {
            btnReady.textContent = (currentLang === 'en') ? "▶ READY" : "▶ PRÊT";
            btnReady.disabled = false;
        }

        // Reset states
        G.state = 'LOBBY';

        // Hide Hunter HUD & overlays
        const hHUD = document.getElementById('hunterHUD');
        if (hHUD) hHUD.classList.add('hidden');

        const standbyOver = document.getElementById('hunterHUD_standbyOverlay');
        if (standbyOver) standbyOver.classList.add('hidden');

        const blindOver = document.getElementById('hunterHUD_blindOverlay');
        if (blindOver) blindOver.classList.add('hidden');

        // Hide Mimic HUD & elements
        if (hud) hud.style.display = 'none';
        if (minimapEl) minimapEl.style.display = 'none';
        if (playerCounterEl) playerCounterEl.style.display = 'none';

        // Clear canvas to dark background
        if (ctx && canvas) {
            ctx.fillStyle = '#131613';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
    }

    // If returning from game over, hide game over screen and show lobby
    if (!gameOverMenu.classList.contains('hidden')) {
        gameOverMenu.classList.add('hidden');
        lobbyMenu.classList.remove('hidden');

        // Reset ready button state
        localIsReady = false;
        btnReady.textContent = (currentLang === 'en') ? "▶ READY" : "▶ PRÊT";
        btnReady.disabled = false;
    }

    lobbyStatus.textContent = (currentLang === 'en')
        ? `Players: [${status.playerCount}/6] | Ready: [${status.readyCount}/${status.playerCount}]`
        : `Joueurs : [${status.playerCount}/6] | Prêt(s) : [${status.readyCount}/${status.playerCount}]`;

    if (status.gameMode === 'hunter') {
        roomType = 'hunter';
        selectedMode = 'hunter';
        updateLobbyThemeOptions();
    } else {
        roomType = 'mimic';
        selectedMode = 'mimic';
        updateLobbyThemeOptions();
    }

    if (isHost) {
        if (status.isQuickMatch) {
            btnTogglePublic.style.display = 'none';
        } else {
            btnTogglePublic.style.display = '';
            if (status.isPublic) {
                btnTogglePublic.textContent = (currentLang === 'en') ? "Room is PUBLIC (Click to Hide)" : "Salon PUBLIC (Cliquer pour masquer)";
                btnTogglePublic.style.color = "#00ff00";
                btnTogglePublic.style.borderColor = "#00ff00";
                btnTogglePublic.style.boxShadow = "0 0 10px rgba(0, 255, 0, 0.2) inset";
            } else {
                btnTogglePublic.textContent = (currentLang === 'en') ? "Room is PRIVATE (Click to Publish)" : "Salon PRIVÉ (Cliquer pour publier)";
                btnTogglePublic.style.color = "var(--accent-color)";
                btnTogglePublic.style.borderColor = "var(--accent-color)";
                btnTogglePublic.style.boxShadow = "0 0 10px rgba(0, 255, 255, 0.2) inset";
            }
        }
    } else {
        document.getElementById('themeSelect').value = status.theme;
    }
});

// ─── HUNTER MODE SOCKET LISTENERS & HELPERS ───
function buildGhostIndicators(ids) {
    const list = document.getElementById('hunterHUD_ghostList');
    if (list) {
        list.innerHTML = '';
        ids.forEach(id => {
            const d = document.createElement('span');
            d.className = 'ghost-indicator';
            d.id = `gi-${id}`;
            // Create 3 hearts for each prop
            for (let i = 0; i < 3; i++) {
                const heart = document.createElement('span');
                heart.className = 'heart';
                heart.id = `heart-${id}-${i}`;
                d.appendChild(heart);
            }
            list.appendChild(d);
        });
    }
}

function updateGhostIndicators() {
    for (const [id, p] of Object.entries(G.players)) {
        const el = document.getElementById(`gi-${id}`);
        if (el) {
            if (p.eliminated) {
                el.classList.add('dead');
            } else {
                el.classList.remove('dead');
                // Update hearts based on lives
                const lives = Math.max(0, p.lives || 3);
                for (let i = 0; i < 3; i++) {
                    const heart = document.getElementById(`heart-${id}-${i}`);
                    if (heart) {
                        if (i < lives) {
                            heart.classList.remove('broken');
                        } else {
                            heart.classList.add('broken');
                        }
                    }
                }
            }
        }
    }
}

function buildPowerupsHUD() {
    const wrap = document.getElementById('hunterHUD_powerups');
    if (wrap) {
        wrap.innerHTML = '';
        if (myRole === 'hunter') {
            const label = (currentLang === 'en') ? '🛸 DRONE [Q]' : '🛸 DRONE [A]';
            const drone = makePowerupBtn(label, 'btnDrone', () => {
                socket.emit('hunterUseDrone');
                G.droneRevealUsed = true;
            });
            wrap.appendChild(drone);
        } else {
            const smokeLabel = (currentLang === 'en') ? '💨 SMOKE [Q]' : '💨 FUMÉE [A]';
            const sprintLabel = (currentLang === 'en') ? '⚡ SPRINT [Shift]' : '⚡ SPRINT [Shift]';
            const smoke = makePowerupBtn(smokeLabel, 'btnSmoke', () => socket.emit('ghostUseSmoke'));
            const sprint = makePowerupBtn(sprintLabel, 'btnSprint', () => socket.emit('ghostUseSprint'));
            wrap.appendChild(smoke);
            wrap.appendChild(sprint);
        }
    }
}

function makePowerupBtn(label, id, cb) {
    const b = document.createElement('button');
    b.className = 'powerup-btn';
    b.id = id;
    b.textContent = label;
    b.addEventListener('click', () => {
        cb();
        b.classList.add('used');
        b.disabled = true;
    });
    return b;
}

function applyPhaseOverlays(phase, phaseEndsAt) {
    const standby = document.getElementById('hunterHUD_standbyOverlay');
    const blind   = document.getElementById('hunterHUD_blindOverlay');

    if (standby && blind) {
        standby.classList.add('hidden');
        blind.classList.add('hidden');

        if (phase === 'RECON') {
            const ph = document.getElementById('hunterHUD_phaseDisplay');
            if (ph) {
                ph.textContent = 'RECON';
                ph.className = 'hud-phase phase-recon';
            }
            if (myRole === 'prop') {
                standby.classList.remove('hidden');
            }
        } else if (phase === 'CACHE') {
            const ph = document.getElementById('hunterHUD_phaseDisplay');
            if (ph) {
                ph.textContent = 'CACHE';
                ph.className = 'hud-phase phase-cache';
            }
            if (myRole === 'hunter') {
                blind.classList.remove('hidden');
            }
        } else if (phase === 'HUNT') {
            const ph = document.getElementById('hunterHUD_phaseDisplay');
            if (ph) {
                ph.textContent = 'CHASSE';
                ph.className = 'hud-phase phase-hunt';
            }
        }
    }
}

function flashPhase(phase) {
    const fl = document.getElementById('hunterHUD_phaseFlash');
    if (fl) {
        const colors = { CACHE:'rgba(40,60,120,0.5)', HUNT:'rgba(150,30,20,0.5)', RECON:'rgba(100,80,20,0.5)' };
        fl.style.background = colors[phase] || 'transparent';
        fl.style.opacity = '1';
        setTimeout(() => { fl.style.opacity = '0'; }, 400);
    }
}

function updateHealthHUD() {
    const pct  = Math.max(0, G.hunterHealth) / 100;
    const fill = document.getElementById('hunterHUD_healthFill');
    const val  = document.getElementById('hunterHUD_healthValue');
    if (fill && val) {
        fill.style.width = (pct * 100) + '%';
        val.textContent  = G.hunterHealth;
        fill.className = 'health-bar-fill' + (pct <= 0.2 ? ' crit' : pct <= 0.5 ? ' low' : '');
    }
}

function updateCtrlHints() {
    const el = document.getElementById('hunterHUD_ctrlAction');
    if (el) {
        if (G.phase === 'RECON') {
            el.innerHTML = myRole === 'hunter'
                ? '<span class="ctrl-key">🔍</span> Mémorise les positions'
                : '⏳ Immobile…';
        } else if (G.phase === 'CACHE') {
            el.innerHTML = myRole === 'prop'
                ? '<span class="ctrl-key">E</span> — Se déguiser | <span class="ctrl-key">F</span> — Tourner'
                : '⌛ En attente…';
        } else if (G.phase === 'HUNT') {
            el.innerHTML = myRole === 'hunter'
                ? '<span class="ctrl-key">CLIC</span> — Tagger un fantôme'
                : '<span class="ctrl-key">Se fondre dans la masse…</span>';
        }
    }
}

function showNotif(msg, type = 'info') {
    const stack = document.getElementById('hunterHUD_notifStack');
    if (stack) {
        const n = document.createElement('div');
        n.className = `notif notif-${type}`;
        n.textContent = msg;
        stack.appendChild(n);
        setTimeout(() => n.remove(), 2100);
    }
}

function updateProximityHint() {
    const hint = document.getElementById('hunterHUD_disguiseHint');
    if (!hint) return;
    if (G.phase !== 'CACHE' && G.phase !== 'HUNT') { hint.style.display = 'none'; nearbyPropId = null; return; }
    if (myRole !== 'prop') { hint.style.display = 'none'; nearbyPropId = null; return; }
    const me = G.players[localPlayerId];
    if (!me || me.eliminated) { hint.style.display = 'none'; nearbyPropId = null; return; }

    const mouseW = screenToWorldCoords(mouseScreenX, mouseScreenY);
    let bestProp = null;
    let bestMouseDist = Infinity;

    for (const prop of G.props) {
        const pdx = me.x - prop.x;
        const pdy = me.y - prop.y;
        const pDist = Math.sqrt(pdx * pdx + pdy * pdy);

        if (pDist <= 70 + prop.radius) {
            const mdx = mouseW.x - prop.x;
            const mdy = mouseW.y - prop.y;
            const mDist = Math.sqrt(mdx * mdx + mdy * mdy);
            if (mDist < bestMouseDist) {
                bestMouseDist = mDist;
                bestProp = prop;
            }
        }
    }

    if (bestProp) {
        nearbyPropId = bestProp.id;
        const propNames = (currentLang === 'en') ? {
            'CRATE_S': 'Small Crate', 'CRATE_M': 'Medium Crate', 'CRATE_L': 'Large Crate',
            'BARREL': 'Metal Barrel', 'FUEL_DRUM': 'Fuel Drum', 'CONE': 'Traffic Cone',
            'PALLET': 'Wooden Pallet', 'AMMO_BOX': 'Ammo Box', 'TOOL_CHEST': 'Tool Chest',
            'GENERATOR': 'Power Generator', 'FIRE_EXT': 'Fire Extinguisher', 'SANDBAG': 'Sandbag',
            'LOCKER': 'Metal Locker', 'SERVER_RACK': 'Server Rack', 'DESK': 'Tactical Desk',
            'TURRET_OFF': 'Inactive Turret', 'CAMO_NET': 'Camouflage Net',
            'TOXIC_DRUM': 'Toxic Drum', 'RADAR_DISH': 'Radar Dish', 'OFFICE_CHAIR': 'Office Chair'
        } : {
            'CRATE_S': 'Petite Caisse', 'CRATE_M': 'Caisse Moyenne', 'CRATE_L': 'Grande Caisse',
            'BARREL': 'Baril métallique', 'FUEL_DRUM': 'Baril de carburant', 'CONE': 'Cône de chantier',
            'PALLET': 'Palette bois', 'AMMO_BOX': 'Caisse de munitions', 'TOOL_CHEST': 'Coffre à outils',
            'GENERATOR': 'Générateur électrique', 'FIRE_EXT': 'Extincteur', 'SANDBAG': 'Sac de sable',
            'LOCKER': 'Armoire métallique', 'SERVER_RACK': 'Rack serveur', 'DESK': 'Bureau tactique',
            'TURRET_OFF': 'Tourelle inactive', 'CAMO_NET': 'Filet de camouflage',
            'TOXIC_DRUM': 'Bidon Toxique', 'RADAR_DISH': 'Antenne Radar', 'OFFICE_CHAIR': 'Chaise de bureau'
        };
        const friendlyName = propNames[bestProp.type] || bestProp.type;
        const keyPrompt = (currentLang === 'en') ? 'copy' : 'copier';
        hint.innerHTML = `<span style="color: #ffcc00; font-weight: bold;">[E]</span> ${keyPrompt} <span style="color: #00ffaa; font-weight: bold;">${friendlyName}</span>`;
        hint.style.display = 'block';
    } else {
        nearbyPropId = null;
        hint.style.display = 'none';
    }
}

function updateTimerHUD() {
    const remaining = Math.max(0, G.phaseEndsAt - Date.now());
    const sec  = Math.ceil(remaining / 1000);
    const min  = Math.floor(sec / 60);
    const s    = sec % 60;
    const timerEl = document.getElementById('hunterHUD_timerDisplay');
    if (timerEl) {
        const timeStr = String(min).padStart(2,'0') + ':' + String(s).padStart(2,'0');
        timerEl.style.fontSize = '32px';
        
        timerEl.textContent = timeStr;
        timerEl.className = 'hud-timer' + (remaining < 30000 && G.phase === 'HUNT' ? ' urgent' : '');
    } else {
    }

    // Standby / blind countdown
    const standbyCountEl = document.getElementById('hunterHUD_standbyCount');
    const blindCountEl = document.getElementById('hunterHUD_blindCount');
    if (G.phase === 'RECON' && standbyCountEl) {
        standbyCountEl.textContent = sec;
    }
    if (G.phase === 'CACHE' && blindCountEl) {
        blindCountEl.textContent = sec;
    }
}

function runShuffleAnimation(data, mapList, mapOnly, config) {
    const overlay    = document.getElementById('shuffleOverlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');

    const mapReel    = document.getElementById('slotMapReel');
    const modeReel   = document.getElementById('slotModeReel');
    const statusText = document.getElementById('shuffleStatus');
    const progressBar= document.getElementById('shuffleProgressBar');
    const headerId   = document.getElementById('shuffleHeaderId');
    const isFr       = (currentLang !== 'en');

    // Show/hide mode column and divider depending on mapOnly flag
    const slotDivider = document.querySelector('#shuffleOverlay .slot-divider');
    const modeColEl   = document.getElementById('slotModeBox') ? document.getElementById('slotModeBox').closest('.slot-column') : null;
    if (modeColEl)   modeColEl.style.display   = mapOnly ? 'none' : '';
    if (slotDivider) slotDivider.style.display = mapOnly ? 'none' : '';

    // Set all UI text based on current language
    const titleEl    = document.getElementById('shuffleTitle');
    const subtitleEl = document.getElementById('shuffleSubtitle');
    const labelMapEl = document.getElementById('slotLabelMap');
    const labelModeEl= document.getElementById('slotLabelMode');
    const footerEl   = document.getElementById('shuffleFooterText');
    if (titleEl)     titleEl.textContent    = isFr ? 'AFFECTATION ALÉATOIRE' : 'RANDOM ASSIGNMENT';
    if (subtitleEl)  subtitleEl.textContent = isFr ? '// PARAMÈTRES DE MISSION EN COURS //' : '// RANDOMIZING MISSION PARAMETERS //';
    if (labelMapEl)  labelMapEl.textContent  = isFr ? '◈ THÉÂTRE D\'OPS ◈' : '◈ THEATRE OF OPS ◈';
    if (labelModeEl) labelModeEl.textContent = (config && config.secondSlotLabel) || (isFr ? '◈ OBJECTIF FINAL ◈' : '◈ FINAL OBJECTIVE ◈');
    if (footerEl)    footerEl.textContent    = isFr
        ? 'CLASSIFIÉ — PROTOCOLE MIMIC OPS — NE PAS DIVULGUER'
        : 'CLASSIFIED — MIMIC OPS PROTOCOL — DO NOT DISCLOSE';

    // Generate a random mission ref ID
    const refId = 'REF: ' + Math.random().toString(36).slice(2,6).toUpperCase() + '-' + Math.random().toString(36).slice(2,6).toUpperCase();
    if (headerId) headerId.textContent = refId;

    const maps  = mapList || ['Military Base', 'Forest', 'Arcade Grid'];
    const modes = (config && config.roleItems) || ['STORM', 'FREEZE', 'PURGE', 'TEMPETE', 'GEL', 'DISPARITION'];

    mapReel.innerHTML  = '';
    modeReel.innerHTML = '';

    const repeats = 24;
    for (let i = 0; i < repeats; i++) {
        const mapDiv = document.createElement('div');
        mapDiv.textContent = maps[i % maps.length];
        mapReel.appendChild(mapDiv);

        const modeDiv = document.createElement('div');
        modeDiv.textContent = modes[i % modes.length];
        modeReel.appendChild(modeDiv);
    }

    // Place target items near the end
    const targetMapIndex  = repeats - 2;
    const targetModeIndex = repeats - 1;
    mapReel.children[targetMapIndex].textContent  = data.map;
    if (!mapOnly) modeReel.children[targetModeIndex].textContent = data.mode;

    // Reset reels
    mapReel.style.transition  = 'none';
    modeReel.style.transition = 'none';
    mapReel.style.transform   = 'translateY(0)';
    modeReel.style.transform  = 'translateY(0)';
    if (progressBar) { progressBar.style.transition = 'none'; progressBar.style.width = '0%'; }
    if (statusText)  { statusText.textContent = isFr ? 'SYNCHRONISATION EN COURS...' : 'RANDOMIZING...'; statusText.className = 'shuffle-status'; }

    mapReel.offsetHeight; // force reflow

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const duration = data.duration || 3500;
            const ITEM_H   = 88;

            mapReel.style.transition  = `transform ${duration - 500}ms cubic-bezier(0.05, 0.9, 0.1, 1.0)`;
            if (!mapOnly) {
                modeReel.style.transition = `transform ${duration}ms cubic-bezier(0.05, 0.9, 0.1, 1.0)`;
                modeReel.style.transform  = `translateY(${-targetModeIndex * ITEM_H}px)`;
            }
            mapReel.style.transform   = `translateY(${-targetMapIndex  * ITEM_H}px)`;

            // Progress bar
            if (progressBar) {
                progressBar.style.transition = `width ${duration}ms linear`;
                progressBar.style.width = '100%';
            }
        });
    });

    // Tick sounds
    const totalTicks = 14;
    let tickCount = 0;
    const tickInterval = setInterval(() => {
        tickCount++;
        if (tickCount >= totalTicks) { clearInterval(tickInterval); return; }
        const freq = 260 + tickCount * 30;
        sfxBeep(freq, 0.03, 'square', 0.08);
    }, (data.duration || 3500) / totalTicks);

    // Lock-in sound + status update
    setTimeout(() => {
        sfxBeep(440, 0.06, 'sine', 0.15);
        setTimeout(() => sfxBeep(660, 0.1, 'sine', 0.2), 120);
        setTimeout(() => sfxBeep(880, 0.14, 'sine', 0.25), 240);
        if (statusText) {
            const lockedLabel = isFr ? 'VERROUILLÉ' : 'LOCKED';
            statusText.textContent = mapOnly
                ? `◈ ${lockedLabel} — ${data.map.toUpperCase()} ◈`
                : `◈ ${lockedLabel} — ${data.map.toUpperCase()} / ${data.mode} ◈`;
            statusText.className = 'shuffle-status locked';
        }
        // Flash selected items green
        const mapTarget  = mapReel.children[targetMapIndex];
        if (mapTarget)  mapTarget.style.color  = 'var(--gold)';
        if (!mapOnly) {
            const modeTarget = modeReel.children[targetModeIndex];
            if (modeTarget) modeTarget.style.color = 'var(--gold)';
        }
    }, (data.duration || 3500) - 300);

    setTimeout(() => { overlay.classList.add('hidden'); }, (data.duration || 3500) + 900);
}

socket.on('hunterRoomShuffle', (data) => {
    const isFr = (currentLang !== 'en');
    const hunterLabel = isFr ? 'CHASSEUR' : 'HUNTER';
    const propLabel   = isFr ? 'CACHÉ' : 'HIDDEN';
    const roleLabel   = data.role === 'hunter' ? hunterLabel : propLabel;
    const roleItems   = [hunterLabel, propLabel, hunterLabel, propLabel, hunterLabel, propLabel];
    const secondLabel = isFr ? '◈ TON RÔLE ◈' : '◈ YOUR ROLE ◈';
    runShuffleAnimation(
        { ...data, mode: roleLabel },
        ['Depot Alpha', 'Zone Charlie', 'Bloc Tactique'],
        false,
        { roleItems, secondSlotLabel: secondLabel }
    );
});

socket.on('roomShuffle', (data) => {
    runShuffleAnimation(data, data.maps || ['Military Base', 'Forest', 'Arcade Grid', 'Weapon Warehouse', 'Cave', 'Toy Factory', 'Command Center', 'Desert', 'Micro-Circuit']);
});

function showEndGameBanner(mode, textTable) {
    const banner = document.getElementById('purgeBanner');
    const entry = textTable[mode];
    if (!banner || !entry) return;

    const t = (currentLang === 'en') ? entry.en : entry.fr;
    document.getElementById('purgeBannerTitle').textContent = t.title;
    document.getElementById('purgeBannerSubtitle').textContent = t.subtitle;

    banner.classList.remove('hidden');
    sfxBeep(220, 0.2, 'sawtooth', 0.35);
    setTimeout(() => sfxBeep(180, 0.4, 'sawtooth', 0.35), 250);

    setTimeout(() => {
        banner.classList.add('hidden');
    }, 4000);
}

const CLASSIC_ENDGAME_BANNER_TEXT = {
    STORM:       { en: { title: '⚠️ STORM ZONE CLOSING ⚠️', subtitle: 'STAY INSIDE THE SECURE CIRCLE' }, fr: { title: '⚠️ RÉTRÉCISSEMENT DE LA ZONE ⚠️', subtitle: 'RESTEZ DANS LE CERCLE SÉCURISÉ' } },
    FREEZE:      { en: { title: '⚠️ COGNITIVE FREEZE ACTIVATED ⚠️', subtitle: 'ALL BOT SPECTRES HAVE FROZEN IN PLACE' }, fr: { title: '⚠️ CONGÉLATION COGNITIVE ACTIVÉE ⚠️', subtitle: 'TOUS LES BOTS DECOYS SONT FIGÉS' } },
    PURGE:       { en: { title: '⚠️ BOT PURGE PROTOCOL ⚠️', subtitle: 'TERMINATING BOT HOSTS EVERY 5 SECONDS' }, fr: { title: '⚠️ PROTOCOLE DE PURGE DES BOTS ⚠️', subtitle: 'ÉLIMINATION DES BOTS TOUTES LES 5 SECONDES' } },
    TEMPETE:     { en: { title: '⚠️ TEMPEST ZONE CLOSING ⚠️', subtitle: 'STAY INSIDE THE SAFE CIRCLE' }, fr: { title: '⚠️ TEMPÊTE — ZONE EN FERMETURE ⚠️', subtitle: 'RESTEZ DANS LE CERCLE SÉCURISÉ' } },
    GEL:         { en: { title: '⚠️ CRYO-GEL ACTIVATED ⚠️', subtitle: 'ALL BOTS ARE FROZEN — FIND THE PLAYERS!' }, fr: { title: '⚠️ CRYO-GEL ACTIVÉ ⚠️', subtitle: 'TOUS LES BOTS SONT FIGÉS — TROUVEZ LES JOUEURS !' } },
    DISPARITION: { en: { title: '⚠️ VANISHING PROTOCOL ⚠️', subtitle: 'BOTS VANISHING EVERY 5 SECONDS' }, fr: { title: '⚠️ PROTOCOLE DE DISPARITION ⚠️', subtitle: 'LES BOTS DISPARAISSENT TOUTES LES 5 SECONDES' } }
};

const HUNTER_ENDGAME_BANNER_TEXT = {
    STORM:  CLASSIC_ENDGAME_BANNER_TEXT.STORM,
    FREEZE: { en: { title: '⚠️ COGNITIVE FREEZE ACTIVATED ⚠️', subtitle: 'ALL BOT SPECTRES HAVE FROZEN IN PLACE' }, fr: { title: '⚠️ CONGÉLATION COGNITIVE ACTIVÉE ⚠️', subtitle: 'TOUS LES BOTS SPECTRES SONT FIGÉS' } },
    PURGE:  CLASSIC_ENDGAME_BANNER_TEXT.PURGE
};

socket.on('classicEndGameModeTriggered', (data) => showEndGameBanner(data.mode, CLASSIC_ENDGAME_BANNER_TEXT));

socket.on('hunterGameStart', (data) => {
    localPlayerId = socket.id;
    roomType = 'hunter';
    
    // Clear visual effects from previous game
    hitFeedbackEffects = [];
    tagEffects = [];
    deathParticles = [];
    stopLobbyMusic();

    document.getElementById('shuffleOverlay')?.classList.add('hidden');
    document.getElementById('purgeBanner')?.classList.add('hidden');

    lobbyMenu.classList.add('hidden');
    document.getElementById('hunterHUD').classList.remove('hidden');
    
    G.state = 'PLAYING';
    G.mapSize = data.mapSize;
    G.props = data.props || [];
    G.theme = data.theme;
    G.phase = data.phase;
    G.phaseEndsAt = Date.now() + (data.remaining !== undefined ? data.remaining : (data.phaseEndsAt ? data.phaseEndsAt - Date.now() : 0));
    G.hunterHealth = data.hunterHealth;
    G.teleporters = data.teleporters || [];
    G.players = {};
    G.cam = { x: 0, y: 0, scale: 1 };
    

    hunterId = data.hunterId;
    myRole = data.roles[localPlayerId]?.role || 'prop';
    
    const ghostIds = Object.entries(data.roles).filter(([,v])=>v.role==='prop').map(([id])=>id);
    
    // Initialize G.players with role data and lives
    for (const [id, role] of Object.entries(data.roles)) {
        G.players[id] = {
            role: role.role,
            lives: role.role === 'prop' ? 3 : 1,
            eliminated: false,
            num: role.num,
            avatar: role.avatar,
            x: role.x,
            y: role.y,
            angle: 0
        };
    }

    const badge = document.getElementById('hunterHUD_roleBadge');
    if (badge) {
        const isEng = (currentLang === 'en');
        if (myRole === 'hunter') {
            badge.textContent = isEng ? '🔴 OPERATIVE' : '🔴 OPÉRATEUR';
            badge.className = 'role-badge role-hunter';
        } else {
            badge.textContent = isEng ? '👻 GHOST' : '👻 FANTÔME';
            badge.className = 'role-badge role-ghost';
        }
    }
    
    buildGhostIndicators(ghostIds);
    buildPowerupsHUD();

    applyPhaseOverlays(data.phase, G.phaseEndsAt);
    updateHealthHUD();
    updateCtrlHints();
    updateTimerHUD();

    startMusic();
    requestAnimationFrame(renderLoop);
});

socket.on('hunterPhase', (data) => {
    G.phase       = data.phase;
    G.phaseEndsAt = Date.now() + (data.remaining !== undefined ? data.remaining : (data.phaseEndsAt ? data.phaseEndsAt - Date.now() : 0));
    if (data.hunterHealth !== undefined) G.hunterHealth = data.hunterHealth;
    flashPhase(data.phase);
    applyPhaseOverlays(data.phase, G.phaseEndsAt);
    updateCtrlHints();
    updateHealthHUD();
    updateTimerHUD();

    if (data.phase === 'CACHE') showNotif(t('phaseCache'), 'info');
    if (data.phase === 'HUNT')  showNotif(t('phaseHunt'), 'danger');
});

socket.on('hunterState', (data) => {
    G.players      = data.players || {};
    G.phase        = data.phase;
    if (data.remaining !== undefined) {
        G.phaseEndsAt = Date.now() + data.remaining;
    }
    G.hunterHealth = data.hunterHealth;
    G.doors        = data.doors || [];
    G.smokes       = data.smokes || [];
    G.droneZone    = data.droneZone || null;

    updateHealthHUD();
    updateProximityHint();
    
    // Dynamic button state update
    const localP = G.players[localPlayerId];
    if (localP) {
        if (myRole === 'hunter') {
            const btnDrone = document.getElementById('btnDrone');
            if (btnDrone && G.droneRevealUsed) {
                btnDrone.classList.add('used');
                btnDrone.disabled = true;
            }
        } else {
            const btnSmoke = document.getElementById('btnSmoke');
            if (btnSmoke && localP.smokeUsed) {
                btnSmoke.classList.add('used');
                btnSmoke.disabled = true;
            }
            const btnSprint = document.getElementById('btnSprint');
            if (btnSprint && localP.sprintUsed) {
                btnSprint.classList.add('used');
                btnSprint.disabled = true;
            }
        }
    }
});

socket.on('hunterDisguised', (data) => {
    if (data.id === localPlayerId) {
        showNotif(t('disguiseActivated'), 'success');
    } else {
        showNotif(t('ghostHidden'), 'info');
    }
});

socket.on('hunterEliminated', (data) => {
    if (data.id === localPlayerId) {
        showNotif(t('youEliminated'), 'danger');
    } else if (myRole === 'hunter') {
        showNotif(t('ghostEliminated'), 'success');
    }
    updateGhostIndicators();
    triggerShake(10);
    const ep = interpolatedPlayers[data.id] || G.players[data.id];
    if (ep) spawnDeathParticles(ep.x, ep.y, '#ff6644', 22);
});

socket.on('hunterLivesUpdated', (data) => {
    if (G.players[data.id]) {
        G.players[data.id].lives = data.lives;
    }
    // Update lives display if it's the local player
    if (data.id === localPlayerId) {
        updateLivesGraphically(data.lives);
    }
});

socket.on('propHit', (data) => {
    // Update player lives
    if (G.players[data.id]) {
        G.players[data.id].lives = data.lives;
    }
    
    // Animate the lost heart
    const lostHeartIndex = data.lives; // The heart that just broke is at index = lives
    const heartEl = document.getElementById(`heart-${data.id}-${lostHeartIndex}`);
    if (heartEl) {
        heartEl.classList.add('hit');
        setTimeout(() => heartEl.classList.remove('hit'), 400);
        heartEl.classList.add('broken');
    }
    
    // Add hit effect at position
    tagEffects.push({ x: data.x, y: data.y, time: Date.now(), result: 'hit' });
    
    // Notification
    if (data.id === localPlayerId) {
        showNotif(t('youHit'), 'danger');
    } else if (myRole === 'hunter') {
        showNotif(t('ghostHit'), 'success');
    }
});

socket.on('hunterTagEffect', (data) => {
    tagEffects.push({ x: data.x, y: data.y, by: data.by || hunterId, time: Date.now(), result: data.result });
    sfxTag();
    triggerShake(data.result === 'hit' ? 5 : 2);
    if (data.result === 'hit') spawnDeathParticles(data.x, data.y, '#50e878', 8);
});

socket.on('hunterHealth', (data) => {
    G.hunterHealth = data.health;
    updateHealthHUD();
    const msg = data.reason === 'decoy' ? t('wrongDecoy') : t('wrongMiss');
    if (myRole === 'hunter') showNotif(msg, 'danger');
    triggerShake(5);
});

socket.on('hunterHitFeedback', (data) => {
    // Add visual feedback for hunter hits
    hitFeedbackEffects.push({
        x: data.x,
        y: data.y,
        time: Date.now(),
        type: data.type, // 'player', 'decoy', or 'miss'
        targetId: data.targetId
    });
    
    // Play sound effect based on hit type
    if (data.type === 'player') {
        sfxTag(); // Use tag sound for player hit
    }
});

socket.on('hunterDroneReveal', (data) => {
    G.droneZone = data;
    G.droneRevealUsed = true;
    showNotif(t('droneActive'), 'info');
});

socket.on('ghostSmokeActive', (data) => {
    showNotif(t('smokeActive'), 'info');
});

socket.on('ghostSprintActive', (data) => {
    if (data.playerId === localPlayerId) {
        showNotif(t('sprintActive'), 'success');
    }
});

socket.on('playerTeleported', (data) => {
    if (data.playerId === localPlayerId) {
        showNotif(t('teleported'), 'info');
    }
});

socket.on('doorToggled', (data) => {
    showNotif(t('doorToggled'), 'info');
});

socket.on('hunterNoiseHeard', (data) => {
    sfxPropNoise(data.volume);
});

let noiseAlertTimeout = null;
socket.on('youMadeNoise', () => {
    sfxBeep(300, 0.15, 'sine', 0.12);

    const alert = document.getElementById('propNoiseAlert');
    const sub   = document.getElementById('propNoiseAlertSub');
    if (!alert) return;

    const isFr = (currentLang !== 'en');
    alert.querySelector('div > div').textContent = isFr ? '🔊 BRUIT ÉMIS' : '🔊 NOISE EMITTED';
    if (sub) sub.textContent = isFr ? 'LE CHASSEUR PEUT VOUS ENTENDRE' : 'THE HUNTER CAN HEAR YOU';

    alert.style.display = 'block';
    alert.style.opacity = '1';
    if (noiseAlertTimeout) clearTimeout(noiseAlertTimeout);
    noiseAlertTimeout = setTimeout(() => {
        alert.style.transition = 'opacity 0.4s';
        alert.style.opacity = '0';
        setTimeout(() => { alert.style.display = 'none'; alert.style.transition = ''; }, 420);
    }, 1800);
});

socket.on('hunterGameOver', (data) => {
    document.getElementById('hunterHUD_standbyOverlay').classList.add('hidden');
    document.getElementById('hunterHUD_blindOverlay').classList.add('hidden');
    document.getElementById('hunterHUD').classList.add('hidden');
    gameOverMenu.classList.remove('hidden');
    stopMusic();
    
    // Clear visual effects
    hitFeedbackEffects = [];
    tagEffects = [];

    const title = document.getElementById('winnerText');
    const sub = document.querySelector('#gameOverMenu .gameover-sub');

    if (data.winner === 'hunter') {
        title.textContent = 'CHASSEUR VICTORIEUX';
        title.style.color = 'var(--pink)';
        sub.textContent = (myRole === 'hunter') ? 'TOUS LES FANTÔMES ÉLIMINÉS' : 'TU AS ÉTÉ DÉCOUVERT';
        setTimeout(() => sfxLose(), 200);
    } else {
        title.textContent = 'FANTÔMES SURVIVANTS';
        title.style.color = 'var(--green)';
        sub.textContent = (myRole === 'prop') ? 'TU AS SURVÉCU !' : 'LE TEMPS EST ÉCOULÉ';
        setTimeout(() => sfxWin(), 200);
    }
});

// --- Countdown UI references ---
const countdownWrap   = document.getElementById('countdownWrap');
const countdownNumber = document.getElementById('countdownNumber');
const countdownMsg    = document.getElementById('countdownMsg');
const countdownRing   = document.getElementById('countdownRingFill');
const slotRow         = document.getElementById('slotRow');
const btnStartNow     = document.getElementById('btnStartNow');
const RING_CIRC       = 251.3; // 2π × 40

btnReady.addEventListener('click', () => {
    socket.emit('playerReady', {
        avatar: document.getElementById('avatarSelect').value,
        theme: document.getElementById('themeSelect').value
    });
    localIsReady = true;
    btnReady.textContent = (currentLang === 'en') ? "WAITING..." : "ATTENTE...";
    btnReady.disabled = true;
    countdownWrap.classList.add('active');
});

btnStartNow.addEventListener('click', () => {
    socket.emit('startNow');
});

// lobbyCountdown: update the ring, slots, message every second
socket.on('lobbyCountdown', (data) => {
    const { seconds, total, slots, readyCount, playerCount } = data;
    const isHost = (localPlayerId === data.hostId);
    const isUrgent = seconds !== null && seconds <= 10;
    const countdownRingContainer = document.getElementById('countdownRingContainer');

    if (seconds === null) {
        if (countdownRingContainer) countdownRingContainer.style.display = 'none';
        countdownMsg.textContent = (currentLang === 'en')
            ? `${readyCount}/${playerCount} READY — Starts when everyone is ready`
            : `${readyCount}/${playerCount} PRÊT(S) — La partie lance dès que tout le monde est prêt`;
        countdownMsg.classList.remove('urgent');
    } else {
        if (countdownRingContainer) countdownRingContainer.style.display = 'flex';
        // Ring
        const progress = seconds / total;
        countdownRing.style.strokeDashoffset = RING_CIRC * (1 - progress);
        countdownRing.classList.toggle('urgent', isUrgent);

        // Number
        countdownNumber.firstChild.textContent = String(seconds).padStart(2, '0');
        countdownNumber.classList.toggle('urgent', isUrgent);

        // Message
        if (isUrgent) {
            countdownMsg.textContent = (currentLang === 'en') ? 'LAUNCHING IN ' + seconds + 's' : 'LANCEMENT DANS ' + seconds + 's';
            countdownMsg.classList.add('urgent');
        } else {
            countdownMsg.textContent = (currentLang === 'en')
                ? `${readyCount}/${playerCount} READY — LAUNCHING IN ${seconds}s`
                : `${readyCount}/${playerCount} PRÊT(S) — LANCEMENT DANS ${seconds}s`;
            countdownMsg.classList.remove('urgent');
        }
    }

    // Slots
    slotRow.innerHTML = '';
    slots.forEach((slot, i) => {
        const div = document.createElement('div');
        if (slot.type === 'searching') {
            div.className = 'slot searching';
            div.innerHTML = `<span class="slot-icon">◌</span><span>···</span>`;
        } else if (slot.type === 'empty') {
            div.className = 'slot human';
            div.innerHTML = `<span class="slot-icon">○</span><span>${currentLang === 'en' ? 'OPEN' : 'LIBRE'}</span>`;
        } else if (slot.ready) {
            div.className = 'slot human-ready';
            div.innerHTML = `<span class="slot-icon">▶</span><span>P${slot.num}</span>`;
        } else {
            div.className = 'slot human';
            div.innerHTML = `<span class="slot-icon">◎</span><span>P${slot.num}</span>`;
        }
        div.style.animation = 'slotAppear 0.18s ease both';
        div.style.animationDelay = (i * 60) + 'ms';
        slotRow.appendChild(div);
    });

    // Show 'Start Now' only to host of public/quickmatch rooms (private auto-starts)
    btnStartNow.style.display = (isHost && data.isPublic) ? 'inline-block' : 'none';

    // Make sure countdown wrap is visible
    countdownWrap.classList.add('active');
});

// botFill: dramatic overlay before game starts
socket.on('botFill', () => {
    const flash = document.getElementById('botFillFlash');
    flash.style.display = 'block';
    // Re-trigger animation
    flash.style.animation = 'none';
    flash.offsetHeight; // reflow
    flash.style.animation = '';
    setTimeout(() => { flash.style.display = 'none'; }, 2100);
});

document.getElementById('btnSoloTest').addEventListener('click', () => {
    socket.emit('soloTest', {
        avatar: document.getElementById('avatarSelect').value,
        theme: document.getElementById('themeSelect').value
    });
});

socket.on('gameStart', (data) => {
    localPlayerId = socket.id;
    localIsReady = false;
    roomType = 'mimic';
    lobbyMenu.classList.add('hidden');
    hud.style.display = 'block';
    minimapEl.style.display = 'block';
    playerCounterEl.style.display = 'block';
    stopLobbyMusic();

    // Clear visual effects from previous game
    hitFeedbackEffects = [];
    tagEffects = [];
    deathParticles = [];
    
    classicEndGameMode = 'STORM';
    classicEndGameTriggered = false;
    classicEndGameCountdownRemaining = 30000;
    classicStormRadius = 2500;
    clientLastTime = performance.now();
    document.getElementById('shuffleOverlay')?.classList.add('hidden');
    document.getElementById('purgeBanner')?.classList.add('hidden');
    
    theme = data.theme;
    mapRule = data.mapRule || 'sync';
    alarmPhase = 'idle';
    mapPings = [];
    MAP_SIZE = data.mapSize;
    decorations = data.decorations || [];
    initEnvironment();

    const ruleBadge = document.getElementById('mapRuleBadge');
    const ruleLabels = {
        sync: 'RULE: SYNC EVENTS',
        alarm: 'RULE: ALARM LOCKDOWN',
        radar: 'RULE: RADAR SWEEP'
    };
    ruleBadge.textContent = ruleLabels[mapRule] || '';
    ruleBadge.classList.remove('hidden');

    playersInfo = data.playersInfo || {};
    if (playersInfo[localPlayerId]) {
        previousLives = playersInfo[localPlayerId].lives;
        updateLivesGraphically(previousLives);
    }
    document.getElementById('spectatorOverlay').classList.add('hidden');

    // Start background music
    startMusic();

    // Start input loop
    requestAnimationFrame(renderLoop);
});

// Single gameState handler — compact array format for smaller payload
socket.on('gameState', (state) => {
    const rawEnts = state.e || state.entities || [];
    latestServerEntities = rawEnts.map(e => {
        if (Array.isArray(e)) {
            return {
                id: e[0], x: e[1], y: e[2], angle: e[3],
                isRevealed: e[4] === 1, vx: e[5], vy: e[6],
                inBush: e[7] === 1, isPlayer: e[8] === 1,
                avatarType: e[9], color: e[10], size: 35
            };
        }
        return e;
    });
    itemsState = state.i || state.items || [];
    mapPings = state.p || [];
    if (state.ra !== undefined) serverRadarAngle = state.ra;
    const alive = state.a !== undefined ? state.a : state.alivePlayers;
    const total = state.t !== undefined ? state.t : state.totalPlayers;
    if (alive !== undefined) {
        alivePlayersCount = alive;
        totalPlayersCount = total;
        aliveCountEl.textContent = `${alive}/${total} joueurs`;
    }
    if (state.egm !== undefined) {
        classicEndGameMode = state.egm;
        classicEndGameTriggered = state.egt;
        classicEndGameCountdownRemaining = state.egc;
        classicStormRadius = state.sr;
    }
});


socket.on('livesUpdated', (data) => {
    playersInfo = data || {};
    if (playersInfo[localPlayerId]) {
        const currentLives = playersInfo[localPlayerId].lives;
        updateLivesGraphically(currentLives);

        if (previousLives !== null && currentLives < previousLives) {
            hud.style.textShadow = "0 0 30px #ff0000";
            setTimeout(() => hud.style.textShadow = "0 0 10px #ff0055", 300);
            sfxLoseLife();
        }

        if (currentLives <= 0) {
            document.getElementById('spectatorOverlay').classList.remove('hidden');
        }
        previousLives = currentLives;
    } else {
        updateLivesGraphically(0);
        document.getElementById('spectatorOverlay').classList.remove('hidden');
        previousLives = 0;
    }
});

socket.on('tagEffect', (data) => {
    tagEffects.push({ x: data.x, y: data.y, by: data.by, time: Date.now() });
    triggerShake(4);
    spawnDeathParticles(data.x, data.y, '#ff5533', 10);
    sfxTag();
});

socket.on('itemPickedUp', (data) => {
    // Find the player who picked it up to spawn text on them
    const pEnt = gameState.find(e => e.id === data.by);
    if (pEnt) {
        const text = data.type === 'HEART' ? '+1 LIFE' : 'SHAPESHIFT!';
        const color = data.type === 'HEART' ? '#ff0055' : '#ffff00';
        pickupEffects.push({ x: pEnt.x, y: pEnt.y, text: text, color: color, time: Date.now() });
    }
    // Play sfx for local player
    if (data.by === localPlayerId) {
        if (data.type === 'HEART') sfxPickupHeart();
        else sfxPickupShapeshift();
    }
});

socket.on('gameOver', (data) => {
    document.getElementById('spectatorOverlay').classList.add('hidden');
    hud.style.display = 'none';
    minimapEl.style.display = 'none';
    playerCounterEl.style.display = 'none';
    document.getElementById('mapRuleBadge').classList.add('hidden');
    document.getElementById('alarmWarning').classList.add('hidden');
    document.getElementById('syncWarning').classList.add('hidden');
    gameOverMenu.classList.remove('hidden');
    stopMusic();
    
    // Clear visual effects
    hitFeedbackEffects = [];
    tagEffects = [];

    if (data.winner === localPlayerId) {
        winnerText.textContent = "YOU WIN!";
        winnerText.style.color = "#00ff00";
        setTimeout(() => sfxWin(), 200);
    } else if (data.winner === null) {
        winnerText.textContent = "DRAW!";
        winnerText.style.color = "#ffff00";
    } else {
        winnerText.textContent = "YOU LOSE.";
        winnerText.style.color = "#ff0000";
        setTimeout(() => sfxLose(), 200);
    }
});

document.getElementById('btnPlayAgain').addEventListener('click', () => {
    sessionStorage.removeItem('mimic_token');
    sessionStorage.removeItem('mimic_room');
    sessionStorage.removeItem('mimic_isHunter');
    localIsReady = false;
    socket.emit('backToLobby');
});

document.getElementById('btnReturnToConnect').addEventListener('click', () => {
    sessionStorage.removeItem('mimic_token');
    sessionStorage.removeItem('mimic_room');
    sessionStorage.removeItem('mimic_isHunter');
    sessionStorage.setItem('mimic_came_from_room', '1');
    window.location.reload();
});

document.getElementById('btnLobbyLeave').addEventListener('click', () => {
    sessionStorage.removeItem('mimic_token');
    sessionStorage.removeItem('mimic_room');
    sessionStorage.removeItem('mimic_isHunter');
    sessionStorage.setItem('mimic_came_from_room', '1');
    window.location.reload();
});

document.getElementById('btnLeaveSpectate').addEventListener('click', () => {
    sessionStorage.removeItem('mimic_token');
    sessionStorage.removeItem('mimic_room');
    sessionStorage.removeItem('mimic_isHunter');
    sessionStorage.setItem('mimic_came_from_room', '1');
    window.location.reload();
});

const syncWarning = document.getElementById('syncWarning');
const alarmWarning = document.getElementById('alarmWarning');
socket.on('syncEvent', (data) => {
    if (mapRule !== 'sync') return;
    if (data.active) {
        syncWarning.classList.remove('hidden');
    } else {
        syncWarning.classList.add('hidden');
    }
});

socket.on('alarmEvent', (data) => {
    if (mapRule !== 'alarm') return;
    alarmPhase = data.phase;
    if (data.phase === 'warning') {
        alarmWarning.textContent = '🚨 ALARM INCOMING — PREPARE TO FREEZE 🚨';
        alarmWarning.classList.remove('hidden');
    } else if (data.phase === 'freeze') {
        alarmWarning.textContent = '⛔ LOCKDOWN — DO NOT MOVE ⛔';
        alarmWarning.classList.remove('hidden');
    } else if (data.phase === 'release') {
        alarmWarning.classList.add('hidden');
    }
});

// ---------- INPUT CAPTURE ----------

const currentInput = { up: false, down: false, left: false, right: false };
let inputDirty = false;

function screenToWorldCoords(sx, sy) {
    return {
        x: sx / G.cam.scale + G.cam.x,
        y: sy / G.cam.scale + G.cam.y
    };
}

window.addEventListener('keydown', e => {
    if (roomType === 'hunter') {
        const me = G.players[localPlayerId];
        const isEliminated = me ? me.eliminated : false;
        if (isEliminated) {
            const alivePlayers = Object.entries(G.players).filter(([id, p]) => p.role === 'prop' && !p.eliminated).map(([id]) => id);
            if (alivePlayers.length > 0) {
                let currentIndex = alivePlayers.indexOf(spectateTargetId);
                if (e.code === 'ArrowRight' || e.code === 'Space' || e.code === 'KeyD') {
                    currentIndex = (currentIndex + 1) % alivePlayers.length;
                    spectateTargetId = alivePlayers[currentIndex];
                } else if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
                    currentIndex = (currentIndex - 1 + alivePlayers.length) % alivePlayers.length;
                    spectateTargetId = alivePlayers[currentIndex];
                }
            }
            return;
        }

        let keyChanged = false;
        if (e.code === 'KeyW' || e.code === 'ArrowUp') { keys.up = true; keyChanged = true; }
        if (e.code === 'KeyS' || e.code === 'ArrowDown') { keys.down = true; keyChanged = true; }
        if (e.code === 'KeyA' || e.code === 'ArrowLeft') { keys.left = true; keyChanged = true; }
        if (e.code === 'KeyD' || e.code === 'ArrowRight') { keys.right = true; keyChanged = true; }

        if (e.key === 'e' || e.key === 'E') {
            if (nearbyPropId && myRole === 'prop') {
                socket.emit('hunterDisguise', { propId: nearbyPropId });
            }
        }
        if (e.code === 'KeyF' || e.key === 'f' || e.key === 'F') {
            socket.emit('hunterRotateDisguise');
        }
        let isPowerupKey = false;
        if (currentLang === 'fr') {
            if ((e.key === 'a' || e.key === 'A' || e.code === 'KeyQ') && e.code !== 'KeyA') {
                isPowerupKey = true;
            }
        } else {
            if ((e.key === 'q' || e.key === 'Q' || e.code === 'KeyQ') && e.code !== 'KeyA') {
                isPowerupKey = true;
            }
        }
        if (isPowerupKey && G.state === 'PLAYING') {
            document.getElementById(myRole === 'hunter' ? 'btnDrone' : 'btnSmoke')?.click();
        }
        if ((e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.key === 'Shift') && G.state === 'PLAYING') {
            if (myRole === 'prop') {
                document.getElementById('btnSprint')?.click();
            }
        }
        return;
    }

    const myLives = (playersInfo[localPlayerId] && playersInfo[localPlayerId].lives !== undefined) ? playersInfo[localPlayerId].lives : 3;
    if (myLives <= 0) {
        // Spectator cycling controls
        const alivePlayers = gameState.filter(ent => ent.isPlayer && playersInfo[ent.id] && playersInfo[ent.id].lives > 0);
        if (alivePlayers.length > 0) {
            let currentIndex = alivePlayers.findIndex(ent => ent.id === spectateTargetId);
            if (e.code === 'ArrowRight' || e.code === 'Space' || e.code === 'KeyD') {
                currentIndex = (currentIndex + 1) % alivePlayers.length;
                spectateTargetId = alivePlayers[currentIndex].id;
            } else if (e.code === 'ArrowLeft' || e.code === 'KeyA') {
                currentIndex = (currentIndex - 1 + alivePlayers.length) % alivePlayers.length;
                spectateTargetId = alivePlayers[currentIndex].id;
            }
        }
        return;
    }

    let changed = false;
    if (e.code === 'KeyW' || e.code === 'ArrowUp') { currentInput.up = true; changed = true; }
    if (e.code === 'KeyS' || e.code === 'ArrowDown') { currentInput.down = true; changed = true; }
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') { currentInput.left = true; changed = true; }
    if (e.code === 'KeyD' || e.code === 'ArrowRight') { currentInput.right = true; changed = true; }

    if (changed) socket.emit('input', currentInput);
});

window.addEventListener('keyup', e => {
    if (roomType === 'hunter') {
        const me = G.players[localPlayerId];
        const isEliminated = me ? me.eliminated : false;
        if (isEliminated) return;

        if (e.code === 'KeyW' || e.code === 'ArrowUp') keys.up = false;
        if (e.code === 'KeyS' || e.code === 'ArrowDown') keys.down = false;
        if (e.code === 'KeyA' || e.code === 'ArrowLeft') keys.left = false;
        if (e.code === 'KeyD' || e.code === 'ArrowRight') keys.right = false;
        return;
    }

    const myLives = (playersInfo[localPlayerId] && playersInfo[localPlayerId].lives !== undefined) ? playersInfo[localPlayerId].lives : 3;
    if (myLives <= 0) return;

    let changed = false;
    if (e.code === 'KeyW' || e.code === 'ArrowUp') { currentInput.up = false; changed = true; }
    if (e.code === 'KeyS' || e.code === 'ArrowDown') { currentInput.down = false; changed = true; }
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') { currentInput.left = false; changed = true; }
    if (e.code === 'KeyD' || e.code === 'ArrowRight') { currentInput.right = false; changed = true; }

    if (changed) socket.emit('input', currentInput);
});

window.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    mouseScreenX = e.clientX - rect.left;
    mouseScreenY = e.clientY - rect.top;
});

window.addEventListener('mousedown', e => {
    if (roomType === 'hunter') {
        const me = G.players[localPlayerId];
        const isEliminated = me ? me.eliminated : false;
        const isPlaying = G.state === 'PLAYING';
        if (isEliminated && isPlaying) {
            const alivePlayers = Object.entries(G.players).filter(([id, p]) => p.role === 'prop' && !p.eliminated).map(([id]) => id);
            if (alivePlayers.length > 0) {
                let currentIndex = alivePlayers.indexOf(spectateTargetId);
                currentIndex = (currentIndex + 1) % alivePlayers.length;
                spectateTargetId = alivePlayers[currentIndex];
            }
            return;
        }
        if (isPlaying) {
            if (myRole === 'hunter' && G.phase === 'HUNT') {
                const rect = canvas.getBoundingClientRect();
                const w = screenToWorldCoords(e.clientX - rect.left, e.clientY - rect.top);
                socket.emit('hunterTag', { x: w.x, y: w.y });
            } else if (myRole === 'prop') {
                if (nearbyPropId) {
                    socket.emit('hunterDisguise', { propId: nearbyPropId });
                }
            }
        }
        return;
    }

    const myLives = (playersInfo[localPlayerId] && playersInfo[localPlayerId].lives !== undefined) ? playersInfo[localPlayerId].lives : 3;
    if (myLives <= 0 && hud.style.display === 'block') {
        // Cycle spectate on click when dead
        const alivePlayers = gameState.filter(ent => ent.isPlayer && playersInfo[ent.id] && playersInfo[ent.id].lives > 0);
        if (alivePlayers.length > 0) {
            let currentIndex = alivePlayers.findIndex(ent => ent.id === spectateTargetId);
            currentIndex = (currentIndex + 1) % alivePlayers.length;
            spectateTargetId = alivePlayers[currentIndex].id;
        }
        return;
    }
    if (e.button === 0 && hud.style.display === 'block') { // Left click during game
        socket.emit('tagAttempt', { x: e.clientX + CAMERA.x, y: e.clientY + CAMERA.y });
    }
});

// ---------- RENDERING METHODS ----------

const rand = (min, max) => Math.random() * (max - min) + min;

// Environment matching server theme logic
// Environment matching server theme logic
function initEnvironment() {
    bgParticles = [];
    if (theme === "Military Base" || theme === "Forest" || theme === "Arcade Grid") {
        // Drifting green embers / screen sparks
        for (let i = 0; i < 80; i++) {
            bgParticles.push({
                x: rand(0, MAP_SIZE.w),
                y: rand(0, MAP_SIZE.h),
                size: rand(2, 4),
                color: 'rgba(0, 255, 170, 0.25)',
                vx: rand(-0.1, 0.1),
                vy: rand(-0.2, -0.4)
            });
        }
    } else if (theme === "Weapon Warehouse" || theme === "Cave" || theme === "Toy Factory") {
        // Steam clouds drifting from the floor grates
        for (let i = 0; i < 40; i++) {
            bgParticles.push({
                x: rand(0, MAP_SIZE.w),
                y: rand(0, MAP_SIZE.h),
                r: rand(15, 30),
                alpha: rand(0.05, 0.25),
                vx: rand(-0.15, 0.15),
                vy: rand(-0.3, -0.6),
                life: Math.random() * 120,
                maxLife: 120 + Math.random() * 120
            });
        }
    } else if (theme === "Command Center" || theme === "Desert" || theme === "Micro-Circuit") {
        // Drifting digital matrix codes
        for (let i = 0; i < 60; i++) {
            bgParticles.push({
                x: rand(0, MAP_SIZE.w),
                y: rand(0, MAP_SIZE.h),
                text: Math.random() > 0.5 ? '1' : '0',
                alpha: rand(0.08, 0.3),
                vy: rand(0.4, 0.9),
                size: Math.floor(rand(8, 12))
            });
        }
    }
}

function drawEnvironment() {
    // Dark room background
    ctx.fillStyle = '#0d0f0c';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(-CAMERA.x, -CAMERA.y);

    const vLeft   = CAMERA.x - 100;
    const vRight  = CAMERA.x + canvas.width + 100;
    const vTop    = CAMERA.y - 100;
    const vBottom = CAMERA.y + canvas.height + 100;

    if (theme === "Military Base" || theme === "Forest" || theme === "Arcade Grid") {
        // --- INDUSTRIAL SECTOR ---
        // Slate metal floor
        ctx.fillStyle = '#181c17';
        ctx.fillRect(0, 0, MAP_SIZE.w, MAP_SIZE.h);

        // Plating grid
        const gridSize = 100;
        const startX = Math.floor(CAMERA.x / gridSize) * gridSize;
        const startY = Math.floor(CAMERA.y / gridSize) * gridSize;

        ctx.strokeStyle = '#232822';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let x = startX; x < CAMERA.x + canvas.width + gridSize; x += gridSize) {
            ctx.moveTo(x, 0); ctx.lineTo(x, MAP_SIZE.h);
        }
        for (let y = startY; y < CAMERA.y + canvas.height + gridSize; y += gridSize) {
            ctx.moveTo(0, y); ctx.lineTo(MAP_SIZE.w, y);
        }
        ctx.stroke();

        // Draw rivets/bolts at plate intersections
        ctx.fillStyle = '#353c34';
        for (let x = startX; x < CAMERA.x + canvas.width + gridSize; x += gridSize) {
            for (let y = startY; y < CAMERA.y + canvas.height + gridSize; y += gridSize) {
                ctx.beginPath();
                ctx.arc(x - 4, y - 4, 1.2, 0, Math.PI * 2);
                ctx.arc(x + 4, y - 4, 1.2, 0, Math.PI * 2);
                ctx.arc(x - 4, y + 4, 1.2, 0, Math.PI * 2);
                ctx.arc(x + 4, y + 4, 1.2, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Ventilation fans
        const vents = [
            {x: 400, y: 300}, {x: 1200, y: 800}, 
            {x: 500, y: 1500}, {x: 1500, y: 1200}, 
            {x: 800, y: 900}
        ];
        vents.forEach(v => {
            if (v.x + 80 < vLeft || v.x - 80 > vRight || v.y + 80 < vTop || v.y - 80 > vBottom) return;
            ctx.save();
            ctx.translate(v.x, v.y);
            
            // Outer housing ring
            ctx.fillStyle = '#202520';
            ctx.strokeStyle = '#323b32';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(0, 0, 42, 0, Math.PI * 2);
            ctx.fill(); ctx.stroke();

            // Protective mesh
            ctx.strokeStyle = 'rgba(0,0,0,0.45)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let d = -32; d <= 32; d += 8) {
                ctx.moveTo(d, -Math.sqrt(1600 - d*d));
                ctx.lineTo(d, Math.sqrt(1600 - d*d));
                ctx.moveTo(-Math.sqrt(1600 - d*d), d);
                ctx.lineTo(Math.sqrt(1600 - d*d), d);
            }
            ctx.stroke();

            // Rotating fan blades
            ctx.rotate(Date.now() * 0.0018);
            ctx.fillStyle = '#0d0f0c';
            for (let b = 0; b < 4; b++) {
                ctx.rotate(Math.PI / 2);
                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.quadraticCurveTo(-10, -18, -6, -32);
                ctx.lineTo(6, -32);
                ctx.quadraticCurveTo(10, -18, 0, 0);
                ctx.fill();
            }

            // Center cap
            ctx.fillStyle = '#323b32';
            ctx.beginPath();
            ctx.arc(0, 0, 8, 0, Math.PI * 2);
            ctx.fill();

            ctx.restore();
        });

        // Drifting embers
        bgParticles.forEach(p => {
            p.x += p.vx;
            p.y += p.vy;
            if (p.y < 0) p.y = MAP_SIZE.h;
            if (p.x < 0) p.x = MAP_SIZE.w;
            if (p.x > MAP_SIZE.w) p.x = 0;

            ctx.fillStyle = p.color;
            ctx.fillRect(p.x, p.y, p.size, p.size);
        });

        // Safety hazard stripe borders
        ctx.strokeStyle = '#d4a317'; // Yellow
        ctx.lineWidth = 14;
        ctx.strokeRect(0, 0, MAP_SIZE.w, MAP_SIZE.h);

        ctx.strokeStyle = '#111111'; // Black hazard stripes overlay
        ctx.lineWidth = 14;
        ctx.setLineDash([16, 16]);
        ctx.strokeRect(0, 0, MAP_SIZE.w, MAP_SIZE.h);
        ctx.setLineDash([]); // Reset dash

        // Outer border line
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 4;
        ctx.strokeRect(7, 7, MAP_SIZE.w - 14, MAP_SIZE.h - 14);

    } else if (theme === "Weapon Warehouse" || theme === "Cave" || theme === "Toy Factory") {
        // --- WEAPON WAREHOUSE ---
        // Dark base steel
        ctx.fillStyle = '#0f1114';
        ctx.fillRect(0, 0, MAP_SIZE.w, MAP_SIZE.h);

        // Metal floor grates lines
        const gridSize = 80;
        const startX = Math.floor(CAMERA.x / gridSize) * gridSize;
        const startY = Math.floor(CAMERA.y / gridSize) * gridSize;

        ctx.strokeStyle = '#1b1d22';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let x = startX; x < CAMERA.x + canvas.width + gridSize; x += gridSize) {
            ctx.moveTo(x, 0); ctx.lineTo(x, MAP_SIZE.h);
        }
        for (let y = startY; y < CAMERA.y + canvas.height + gridSize; y += gridSize) {
            ctx.moveTo(0, y); ctx.lineTo(MAP_SIZE.w, y);
        }
        ctx.stroke();

        // Draw grate slots
        ctx.strokeStyle = 'rgba(0,0,0,0.38)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = startX; x < CAMERA.x + canvas.width + gridSize; x += gridSize) {
            for (let xo = 16; xo < gridSize; xo += 16) {
                ctx.moveTo(x + xo, startY);
                ctx.lineTo(x + xo, Math.min(MAP_SIZE.h, CAMERA.y + canvas.height + gridSize));
            }
        }
        ctx.stroke();

        // Industrial pipes running across the map
        const pipeYs = [150, 750, 1350];
        const pipeXs = [350, 950, 1650];
        
        // Horizontal copper pipes
        ctx.strokeStyle = '#855a15'; // Copper/bronze
        ctx.lineWidth = 12;
        ctx.beginPath();
        pipeYs.forEach(py => {
            if (py >= vTop && py <= vBottom) {
                ctx.moveTo(0, py);
                ctx.lineTo(MAP_SIZE.w, py);
            }
        });
        ctx.stroke();

        // Vertical steel pipes
        ctx.strokeStyle = '#414856'; // Steel gray
        ctx.lineWidth = 8;
        ctx.beginPath();
        pipeXs.forEach(px => {
            if (px >= vLeft && px <= vRight) {
                ctx.moveTo(px, 0);
                ctx.lineTo(px, MAP_SIZE.h);
            }
        });
        ctx.stroke();

        // Draw flanges/valves at pipes intersections
        pipeXs.forEach(px => {
            pipeYs.forEach(py => {
                if (px >= vLeft && px <= vRight && py >= vTop && py <= vBottom) {
                    // Brass joint bracket
                    ctx.fillStyle = '#b8860b';
                    ctx.fillRect(px - 8, py - 8, 16, 16);
                    // Red emergency control valve wheel
                    ctx.fillStyle = '#990000';
                    ctx.beginPath();
                    ctx.arc(px, py, 14, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.fillStyle = '#fff';
                    ctx.beginPath();
                    ctx.arc(px, py, 3, 0, Math.PI * 2);
                    ctx.fill();
                }
            });
        });

        // Steam vapors drifting up
        bgParticles.forEach(p => {
            p.x += p.vx;
            p.y += p.vy;
            p.life += 1;
            if (p.life > p.maxLife || p.x < 0 || p.x > MAP_SIZE.w || p.y < 0) {
                p.x = rand(0, MAP_SIZE.w);
                p.y = MAP_SIZE.h;
                p.life = 0;
                p.alpha = rand(0.05, 0.25);
            }
            const currentAlpha = p.alpha * (1 - p.life / p.maxLife);
            ctx.fillStyle = `rgba(200, 200, 200, ${currentAlpha})`;
            ctx.beginPath();
            ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
            ctx.fill();
        });

        // Solid heavy gray border
        ctx.strokeStyle = '#2d2f34';
        ctx.lineWidth = 12;
        ctx.strokeRect(0, 0, MAP_SIZE.w, MAP_SIZE.h);

    } else if (theme === "Command Center" || theme === "Desert" || theme === "Micro-Circuit") {
        // --- COMMAND CENTER ---
        // Dark console glass background
        ctx.fillStyle = '#04070a';
        ctx.fillRect(0, 0, MAP_SIZE.w, MAP_SIZE.h);

        // Tactical grid circles
        const cx = MAP_SIZE.w / 2;
        const cy = MAP_SIZE.h / 2;
        ctx.strokeStyle = 'rgba(139, 168, 134, 0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let r = 150; r < Math.max(MAP_SIZE.w, MAP_SIZE.h); r += 200) {
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
        }
        ctx.stroke();

        // Axis gridlines
        ctx.strokeStyle = 'rgba(139, 168, 134, 0.06)';
        ctx.beginPath();
        ctx.moveTo(cx, 0); ctx.lineTo(cx, MAP_SIZE.h);
        ctx.moveTo(0, cy); ctx.lineTo(MAP_SIZE.w, cy);
        ctx.stroke();

        // Rotating radar scan line
        const radarAngle = (Date.now() * 0.0007) % (Math.PI * 2);
        ctx.save();
        ctx.translate(cx, cy);

        // Sweep trace cone
        const sweepGrad = ctx.createRadialGradient(0, 0, 50, 0, 0, Math.max(MAP_SIZE.w, MAP_SIZE.h));
        sweepGrad.addColorStop(0, 'rgba(139, 168, 134, 0.15)');
        sweepGrad.addColorStop(1, 'rgba(139, 168, 134, 0.0)');
        ctx.fillStyle = sweepGrad;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, Math.max(MAP_SIZE.w, MAP_SIZE.h), radarAngle - 0.28, radarAngle, false);
        ctx.closePath();
        ctx.fill();

        // Scanner main line
        ctx.strokeStyle = 'rgba(139, 168, 134, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(radarAngle) * MAP_SIZE.w, Math.sin(radarAngle) * MAP_SIZE.h);
        ctx.stroke();
        ctx.restore();

        // Matrix coordinate drift
        ctx.font = 'bold 9px "Share Tech Mono", Courier';
        bgParticles.forEach(p => {
            p.y += p.vy;
            if (p.y > MAP_SIZE.h) {
                p.y = 0;
                p.x = rand(0, MAP_SIZE.w);
            }
            ctx.fillStyle = `rgba(139, 168, 134, ${p.alpha})`;
            ctx.fillText(p.text, p.x, p.y);
        });

        // Laser borders
        ctx.strokeStyle = '#8ca885';
        ctx.lineWidth = 8;
        ctx.shadowColor = '#8ca885';
        ctx.shadowBlur = 6;
        ctx.strokeRect(0, 0, MAP_SIZE.w, MAP_SIZE.h);
        ctx.shadowBlur = 0;
    }
    ctx.restore();
}

// ── Helpers for pseudo-3D volume ──────────────────────────────────
function drawSphere(ctx, cx, cy, r, baseColor, lightAngle = -Math.PI / 4) {
    const lx = Math.cos(lightAngle) * r * 0.35;
    const ly = Math.sin(lightAngle) * r * 0.35;
    const g = ctx.createRadialGradient(cx + lx, cy + ly, r * 0.05, cx, cy, r);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.3, baseColor);
    g.addColorStop(1, 'rgba(0,0,0,0.85)');
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
}
function drawCylinder(ctx, cx, cy, w, h, baseColor, lightAngle = -Math.PI / 4) {
    const g = ctx.createLinearGradient(cx - w, cy, cx + w, cy);
    g.addColorStop(0, 'rgba(0,0,0,0.7)');
    g.addColorStop(0.35, baseColor);
    g.addColorStop(0.6, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.beginPath();
    ctx.ellipse(cx, cy, w, h, 0, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
}
function drawGroundShadow(ctx, cx, cy, r) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(0,0,0,0.45)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, r * 0.35, 0, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.fill();
}

function getDirection(angle) {
    let norm = angle;
    while (norm < -Math.PI) norm += Math.PI * 2;
    while (norm > Math.PI) norm -= Math.PI * 2;
    if (norm > -Math.PI/4 && norm <= Math.PI/4) {
        return 'RIGHT';
    } else if (norm > Math.PI/4 && norm <= 3*Math.PI/4) {
        return 'DOWN';
    } else if (norm > -3*Math.PI/4 && norm <= -Math.PI/4) {
        return 'UP';
    } else {
        return 'LEFT';
    }
}

function clipEntityToBushes(ctx, x, y) {
    let found = false;
    ctx.beginPath();
    for (const dec of decorations) {
        if (dec.type !== 'BUSH') continue;
        const dx = x - dec.x;
        const dy = y - dec.y;
        if (dx * dx + dy * dy <= dec.radius * dec.radius) {
            found = true;
            ctx.moveTo(dec.x + dec.radius, dec.y);
            ctx.arc(dec.x, dec.y, dec.radius, 0, Math.PI * 2);
        }
    }
    if (found) ctx.clip();
    return found;
}

const Avatars = {
    "Combat-Operative": (ctx, x, y, size, color, isMoving, angle, inCover = false) => {
        const s = size;
        const t = Date.now();
        const swing = isMoving ? Math.sin(t * 0.012) * s * 0.35 : 0;
        const bob = isMoving ? Math.sin(t * 0.012) * 1.5 : 0;

        ctx.save();
        ctx.translate(x, y + bob);
        ctx.shadowColor = color;
        ctx.shadowBlur = 4;

        drawGroundShadow(ctx, 0, s * 0.9, s * 0.8);

        const dir = getDirection(angle);
        const camoGreen = '#2e432a';
        const camoTan = '#8b7e66';
        const vestColor = '#151821';
        const skinColor = '#e0a98c';

        // Camo pattern helper for drawing panels
        const applyCamoPattern = (cx, cy, w, h) => {
            ctx.fillStyle = camoGreen;
            ctx.fillRect(cx, cy, w, h);
            ctx.fillStyle = camoTan;
            ctx.fillRect(cx + w * 0.2, cy + h * 0.1, w * 0.4, h * 0.3);
            ctx.fillStyle = '#1e2d1c';
            ctx.fillRect(cx + w * 0.5, cy + h * 0.5, w * 0.3, h * 0.4);
        };

        if (dir === 'DOWN') {
            // Legs (camo pants + black boots)
            ctx.fillStyle = '#1a1a1e';
            ctx.fillRect(-s*0.25, s*0.45 + swing, s*0.14, s*0.25);
            ctx.fillRect(s*0.11, s*0.45 - swing, s*0.14, s*0.25);
            // Kneepads
            ctx.fillStyle = vestColor;
            ctx.fillRect(-s*0.26, s*0.42 + swing, s*0.16, s*0.1);
            ctx.fillRect(s*0.1, s*0.42 - swing, s*0.16, s*0.1);

            // Torso (camo base)
            applyCamoPattern(-s*0.3, -s*0.1, s*0.6, s*0.55);
            // Plate carrier / Tactical vest
            ctx.fillStyle = vestColor;
            ctx.beginPath();
            ctx.roundRect(-s*0.22, -s*0.05, s*0.44, s*0.44, 4);
            ctx.fill();
            // Webbing lines on vest
            ctx.strokeStyle = '#323947';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(-s*0.18, s*0.1); ctx.lineTo(s*0.18, s*0.1);
            ctx.moveTo(-s*0.18, s*0.22); ctx.lineTo(s*0.18, s*0.22);
            ctx.moveTo(-s*0.18, s*0.34); ctx.lineTo(s*0.18, s*0.34);
            ctx.stroke();

            // Arms holding rifle
            ctx.fillStyle = camoGreen;
            ctx.fillRect(-s*0.42, -s*0.05, s*0.14, s*0.35); // Left arm
            ctx.fillRect(s*0.28, -s*0.05, s*0.14, s*0.35); // Right arm

            // Assault Rifle M4
            ctx.save();
            ctx.translate(s*0.18, s*0.15);
            ctx.rotate(0.2); // Pointing slightly down-right
            ctx.fillStyle = '#111115';
            ctx.fillRect(-6, 0, 12, s*0.5); // barrel/handguard
            ctx.fillRect(-4, s*0.2, 8, s*0.3); // clip/magazine
            ctx.fillRect(-8, -s*0.1, 6, s*0.25); // stock
            if (!inCover) {
                ctx.strokeStyle = 'rgba(0, 255, 170, 0.45)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(0, s*0.5);
                ctx.lineTo(0, s*1.8);
                ctx.stroke();
                
                ctx.fillStyle = color;
                ctx.beginPath();
                ctx.arc(0, s*1.8, 3, 0, Math.PI*2);
                ctx.fill();
            }
            ctx.restore();

            // Neck & Head
            ctx.fillStyle = skinColor;
            ctx.fillRect(-s*0.08, -s*0.2, s*0.16, s*0.12);
            // Helmet
            ctx.fillStyle = camoGreen;
            ctx.beginPath();
            ctx.arc(0, -s*0.32, s*0.24, Math.PI, 0);
            ctx.fill();
            ctx.fillRect(-s*0.24, -s*0.32, s*0.48, s*0.08); // rim
            // Tactical Goggles (neon cyan glow)
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.roundRect(-s*0.18, -s*0.28, s*0.36, s*0.1, 2);
            ctx.fill();

        } else if (dir === 'UP') {
            // Back view
            ctx.fillStyle = '#1a1a1e';
            ctx.fillRect(-s*0.25, s*0.45 - swing, s*0.14, s*0.25);
            ctx.fillRect(s*0.11, s*0.45 + swing, s*0.14, s*0.25);

            applyCamoPattern(-s*0.3, -s*0.1, s*0.6, s*0.55);
            
            // Tactical Backpack
            ctx.fillStyle = vestColor;
            ctx.beginPath();
            ctx.roundRect(-s*0.2, s*0.02, s*0.4, s*0.38, 3);
            ctx.fill();
            // Buckle straps
            ctx.fillStyle = camoGreen;
            ctx.fillRect(-s*0.14, s*0.02, s*0.04, s*0.38);
            ctx.fillRect(s*0.1, s*0.02, s*0.04, s*0.38);

            // Arms
            ctx.fillRect(-s*0.42, -s*0.05, s*0.14, s*0.3);
            ctx.fillRect(s*0.28, -s*0.05, s*0.14, s*0.3);

            // Helmet Back
            ctx.fillStyle = camoGreen;
            ctx.beginPath();
            ctx.arc(0, -s*0.32, s*0.24, Math.PI, 0);
            ctx.fill();
            ctx.fillRect(-s*0.24, -s*0.32, s*0.48, s*0.12);

        } else if (dir === 'RIGHT') {
            // Profile Right
            ctx.fillStyle = '#1a1a1e';
            ctx.fillRect(-s*0.18 - swing*0.5, s*0.45, s*0.13, s*0.25); // Back leg
            ctx.fillRect(s*0.05 + swing*0.5, s*0.45, s*0.14, s*0.25); // Front leg

            applyCamoPattern(-s*0.2, -s*0.1, s*0.4, s*0.55);
            
            // Vest plate side
            ctx.fillStyle = vestColor;
            ctx.fillRect(-s*0.16, -s*0.05, s*0.32, s*0.44);

            // Arms holding rifle forward
            ctx.save();
            ctx.translate(s*0.12, s*0.12);
            ctx.rotate(0.1 + (isMoving ? Math.sin(t/120)*0.1 : 0));
            // Rifle body
            ctx.fillStyle = '#111115';
            ctx.fillRect(0, -4, s*0.55, 8); // barrel
            ctx.fillRect(s*0.18, 2, 6, 12); // clip
            ctx.fillRect(-s*0.18, -4, s*0.18, 6); // stock
            if (!inCover) {
                ctx.strokeStyle = 'rgba(0, 255, 170, 0.45)';
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(s*0.55, 0); ctx.lineTo(s*1.8, 0); ctx.stroke();
                ctx.fillStyle = color;
                ctx.beginPath(); ctx.arc(s*1.8, 0, 3, 0, Math.PI*2); ctx.fill();
            }
            ctx.restore();

            // Helmet right side
            ctx.fillStyle = camoGreen;
            ctx.beginPath(); ctx.arc(0, -s*0.32, s*0.21, 0, Math.PI*2); ctx.fill();
            // Visor side glow
            ctx.fillStyle = color;
            ctx.fillRect(s*0.05, -s*0.32, s*0.16, 6);

        } else if (dir === 'LEFT') {
            // Profile Left
            ctx.fillStyle = '#1a1a1e';
            ctx.fillRect(s*0.05 + swing*0.5, s*0.45, s*0.13, s*0.25); // Back leg
            ctx.fillRect(-s*0.18 - swing*0.5, s*0.45, s*0.14, s*0.25); // Front leg

            applyCamoPattern(-s*0.2, -s*0.1, s*0.4, s*0.55);
            
            ctx.fillStyle = vestColor;
            ctx.fillRect(-s*0.16, -s*0.05, s*0.32, s*0.44);

            // Arms holding rifle forward
            ctx.save();
            ctx.translate(-s*0.12, s*0.12);
            ctx.rotate(-0.1 - (isMoving ? Math.sin(t/120)*0.1 : 0));
            // Rifle
            ctx.fillStyle = '#111115';
            ctx.fillRect(-s*0.55, -4, s*0.55, 8); // barrel
            ctx.fillRect(-s*0.24, 2, 6, 12); // clip
            ctx.fillRect(0, -4, s*0.18, 6); // stock
            if (!inCover) {
                ctx.strokeStyle = 'rgba(0, 255, 170, 0.45)';
                ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(-s*0.55, 0); ctx.lineTo(-s*1.8, 0); ctx.stroke();
                ctx.fillStyle = color;
                ctx.beginPath(); ctx.arc(-s*1.8, 0, 3, 0, Math.PI*2); ctx.fill();
            }
            ctx.restore();

            // Helmet left
            ctx.fillStyle = camoGreen;
            ctx.beginPath(); ctx.arc(0, -s*0.32, s*0.21, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = color;
            ctx.fillRect(-s*0.21, -s*0.32, s*0.16, 6);
        }

        ctx.restore();
    },

    "Recon-Drone": (ctx, x, y, size, color, isMoving, angle, inCover = false) => {
        const s = size;
        const t = Date.now();
        // Hover bobbing
        const bob = Math.sin(t / 250) * s * 0.12;
        // Rotor spin angle
        const spin = (t * 0.08) % (Math.PI * 2);

        ctx.save();
        ctx.translate(x, y + bob);
        ctx.shadowColor = color;
        ctx.shadowBlur = 6;

        drawGroundShadow(ctx, 0, s * 0.95, s * 0.75);

        const droneBodyColor = '#4a5568';
        const metalDark = '#2d3748';

        if (isMoving && !inCover) {
            const sparkX = -Math.cos(angle) * s * 0.4;
            const sparkY = -Math.sin(angle) * s * 0.4 + s*0.25;
            const grad = ctx.createRadialGradient(sparkX, sparkY, 0, sparkX, sparkY, s * 0.45);
            grad.addColorStop(0, '#f0ad4e');
            grad.addColorStop(0.3, 'rgba(240,173,78,0.6)');
            grad.addColorStop(1, 'rgba(240,173,78,0)');
            ctx.fillStyle = grad;
            ctx.beginPath();
            ctx.arc(sparkX, sparkY, s * 0.45, 0, Math.PI * 2);
            ctx.fill();
        }

        const arm = inCover ? 0.72 : 1;
        ctx.strokeStyle = metalDark;
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(-s*0.35*arm, -s*0.25*arm); ctx.lineTo(s*0.35*arm, s*0.25*arm);
        ctx.moveTo(-s*0.35*arm, s*0.25*arm); ctx.lineTo(s*0.35*arm, -s*0.25*arm);
        ctx.stroke();

        const drawRotor = (rx, ry) => {
            ctx.strokeStyle = '#718096';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.ellipse(rx, ry, s*0.22*arm, s*0.08*arm, 0, 0, Math.PI * 2);
            ctx.stroke();

            ctx.save();
            ctx.translate(rx, ry);
            ctx.rotate(spin);
            ctx.strokeStyle = '#2d3748';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.moveTo(-s*0.18*arm, 0); ctx.lineTo(s*0.18*arm, 0);
            ctx.stroke();
            ctx.restore();
        };

        drawRotor(-s*0.35*arm, -s*0.25*arm);
        drawRotor(s*0.35*arm, -s*0.25*arm);
        drawRotor(-s*0.35*arm, s*0.25*arm);
        drawRotor(s*0.35*arm, s*0.25*arm);

        // Central drone hull (digital camo style - drawn as octagonal prism)
        ctx.fillStyle = droneBodyColor;
        ctx.strokeStyle = '#718096';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-s*0.24, -s*0.2);
        ctx.lineTo(s*0.24, -s*0.2);
        ctx.lineTo(s*0.32, 0);
        ctx.lineTo(s*0.24, s*0.22);
        ctx.lineTo(-s*0.24, s*0.22);
        ctx.lineTo(-s*0.32, 0);
        ctx.closePath();
        ctx.fill(); ctx.stroke();

        // Camo accent decal
        ctx.fillStyle = '#2d3748';
        ctx.beginPath();
        ctx.moveTo(-s*0.15, -s*0.15);
        ctx.lineTo(s*0.15, -s*0.15);
        ctx.lineTo(s*0.2, 0);
        ctx.lineTo(0, s*0.15);
        ctx.closePath();
        ctx.fill();

        // Gimbal Camera underneath (blinking search eye)
        ctx.fillStyle = '#1a202c';
        ctx.beginPath();
        ctx.arc(0, s*0.16, s*0.14, 0, Math.PI * 2);
        ctx.fill();
        // Glowing lens
        ctx.fillStyle = color;
        ctx.shadowBlur = 10;
        ctx.shadowColor = color;
        ctx.beginPath();
        ctx.arc(0, s*0.18, s*0.07, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0; // reset

        ctx.restore();
    },

    "Stealth-Sniper": (ctx, x, y, size, color, isMoving, angle, inCover = false) => {
        const s = size;
        const t = Date.now();
        const bob = isMoving ? Math.sin(t * 0.012) * 1.5 : 0;
        const swing = isMoving ? Math.sin(t * 0.012) * s * 0.25 : 0;

        ctx.save();
        ctx.translate(x, y + bob);
        ctx.shadowColor = color;
        ctx.shadowBlur = 4;

        // Ground shadow
        drawGroundShadow(ctx, 0, s * 0.85, s * 0.7);

        const dir = getDirection(angle);
        const ghillieGreen = '#1e351f';
        const ghillieOlive = '#3c5837';
        const ghillieBrown = '#5c4033';
        const capColor = '#2f3d2f';

        // Helper to draw leafy clumps forming a ghillie suit
        const drawGhillieSuit = (gx, gy, gr) => {
            ctx.save();
            ctx.translate(gx, gy);
            ctx.lineWidth = 1;

            // Overlapping leaf blobs
            const seeds = [12, 45, 78, 110, 150, 190, 230, 280];
            seeds.forEach((seed, i) => {
                const ang = (i / seeds.length) * Math.PI * 2;
                const rx = Math.cos(ang) * gr * 0.45;
                const ry = Math.sin(ang) * gr * 0.45;
                const rad = gr * 0.55 + Math.sin(seed + t*0.002) * 2;

                ctx.fillStyle = i % 3 === 0 ? ghillieGreen : (i % 3 === 1 ? ghillieOlive : ghillieBrown);
                ctx.beginPath();
                ctx.arc(rx, ry, rad, 0, Math.PI*2);
                ctx.fill();
            });
            ctx.restore();
        };

        if (dir === 'DOWN') {
            // Hidden legs
            ctx.fillStyle = '#1e1f1a';
            ctx.fillRect(-s*0.2, s*0.45 + swing, s*0.12, s*0.25);
            ctx.fillRect(s*0.08, s*0.45 - swing, s*0.12, s*0.25);

            // Ghillie mass
            drawGhillieSuit(0, s*0.15, inCover ? s*0.44 : s*0.58);

            // Sniper rifle (compact when in cover)
            ctx.save();
            ctx.translate(s*0.18, s*0.22);
            ctx.fillStyle = '#1a1d20';
            ctx.fillRect(-4, 0, 8, inCover ? s*0.32 : s*0.65);
            ctx.fillStyle = '#2d333a';
            ctx.fillRect(-6, s*0.12, 12, inCover ? s*0.14 : s*0.22);
            if (!inCover) {
                ctx.strokeStyle = 'rgba(255, 51, 51, 0.4)';
                ctx.lineWidth = 0.8;
                ctx.beginPath(); ctx.moveTo(0, s*0.65); ctx.lineTo(0, s*2.2); ctx.stroke();
                ctx.fillStyle = '#ff3333';
                ctx.beginPath(); ctx.arc(0, s*2.2, 2.5, 0, Math.PI*2); ctx.fill();
            }
            ctx.restore();

            // Helmet/Cap emerging
            ctx.fillStyle = capColor;
            ctx.beginPath();
            ctx.roundRect(-s*0.16, -s*0.28, s*0.32, s*0.22, 2);
            ctx.fill();
            // Red sniper optic lens glowing
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(-s*0.06, -s*0.18, 3, 0, Math.PI*2);
            ctx.fill();

        } else if (dir === 'UP') {
            ctx.fillStyle = '#1e1f1a';
            ctx.fillRect(-s*0.2, s*0.45 - swing, s*0.12, s*0.25);
            ctx.fillRect(s*0.08, s*0.45 + swing, s*0.12, s*0.25);

            drawGhillieSuit(0, s*0.15, inCover ? s*0.44 : s*0.58);

            // Cap back
            ctx.fillStyle = capColor;
            ctx.beginPath();
            ctx.roundRect(-s*0.16, -s*0.28, s*0.32, s*0.22, 2);
            ctx.fill();

        } else if (dir === 'RIGHT') {
            ctx.fillStyle = '#1e1f1a';
            ctx.fillRect(-s*0.15 - swing*0.5, s*0.45, s*0.11, s*0.25);
            ctx.fillRect(s*0.04 + swing*0.5, s*0.45, s*0.12, s*0.25);

            drawGhillieSuit(0, s*0.15, inCover ? s*0.4 : s*0.5);

            ctx.save();
            ctx.translate(s*0.1, s*0.1);
            ctx.fillStyle = '#1a1d20';
            ctx.fillRect(0, -3, inCover ? s*0.38 : s*0.8, 6);
            ctx.fillRect(s*0.18, -8, inCover ? s*0.14 : s*0.25, 5);
            ctx.fillRect(-s*0.15, -3, s*0.15, 5);
            if (!inCover) {
                ctx.strokeStyle = 'rgba(255, 51, 51, 0.4)';
                ctx.lineWidth = 0.8;
                ctx.beginPath(); ctx.moveTo(s*0.8, 0); ctx.lineTo(s*2.2, 0); ctx.stroke();
                ctx.fillStyle = '#ff3333';
                ctx.beginPath(); ctx.arc(s*2.2, 0, 2.5, 0, Math.PI*2); ctx.fill();
            }
            ctx.restore();

            ctx.fillStyle = capColor;
            ctx.beginPath(); ctx.arc(0, -s*0.22, s*0.18, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = color;
            ctx.fillRect(s*0.06, -s*0.24, s*0.1, 4);

        } else if (dir === 'LEFT') {
            ctx.fillStyle = '#1e1f1a';
            ctx.fillRect(s*0.04 + swing*0.5, s*0.45, s*0.11, s*0.25);
            ctx.fillRect(-s*0.15 - swing*0.5, s*0.45, s*0.12, s*0.25);

            drawGhillieSuit(0, s*0.15, inCover ? s*0.4 : s*0.5);

            ctx.save();
            ctx.translate(-s*0.1, s*0.1);
            ctx.fillStyle = '#1a1d20';
            ctx.fillRect(inCover ? -s*0.38 : -s*0.8, -3, inCover ? s*0.38 : s*0.8, 6);
            ctx.fillRect(-s*0.43, -8, inCover ? s*0.14 : s*0.25, 5);
            ctx.fillRect(0, -3, s*0.15, 5);
            if (!inCover) {
                ctx.strokeStyle = 'rgba(255, 51, 51, 0.4)';
                ctx.lineWidth = 0.8;
                ctx.beginPath(); ctx.moveTo(-s*0.8, 0); ctx.lineTo(-s*2.2, 0); ctx.stroke();
                ctx.fillStyle = '#ff3333';
                ctx.beginPath(); ctx.arc(-s*2.2, 0, 2.5, 0, Math.PI*2); ctx.fill();
            }
            ctx.restore();

            // Head
            ctx.fillStyle = capColor;
            ctx.beginPath(); ctx.arc(0, -s*0.22, s*0.18, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = color;
            ctx.fillRect(-s*0.16, -s*0.24, s*0.1, 4);
        }

        ctx.restore();
    },

    "Heavy-Gunner": (ctx, x, y, size, color, isMoving, angle, inCover = false) => {
        const s = size * (inCover ? 0.95 : 1.15);
        const t = Date.now();
        const bob = isMoving ? Math.sin(t * 0.009) * 1.0 : 0;
        const swing = isMoving ? Math.sin(t * 0.009) * s * 0.25 : 0;

        ctx.save();
        ctx.translate(x, y + bob);
        ctx.shadowColor = color;
        ctx.shadowBlur = 6;

        drawGroundShadow(ctx, 0, s * 0.95, s * 0.9);

        const dir = getDirection(angle);
        const armorColor = '#4a4d55';
        const armorDark = '#2c2e35';
        const warningOrange = '#ffaa00';

        // Warning hazard line drawing helper
        const drawHazardPanel = (hx, hy, hw, hh) => {
            ctx.fillStyle = armorDark;
            ctx.fillRect(hx, hy, hw, hh);
            // Yellow bars
            ctx.fillStyle = warningOrange;
            ctx.beginPath();
            for (let ox = 4; ox < hw; ox += 12) {
                ctx.moveTo(hx + ox, hy);
                ctx.lineTo(hx + Math.min(hw, ox + 6), hy);
                ctx.lineTo(hx + Math.min(hw, ox + 6) - 4, hy + hh);
                ctx.lineTo(hx + ox - 4, hy + hh);
                ctx.closePath();
                ctx.fill();
            }
        };

        if (dir === 'DOWN') {
            // Heavy metal tread-like feet
            ctx.fillStyle = '#111';
            ctx.fillRect(-s*0.28, s*0.45 + swing, s*0.16, s*0.24);
            ctx.fillRect(s*0.12, s*0.45 - swing, s*0.16, s*0.24);
            ctx.fillStyle = armorDark;
            ctx.fillRect(-s*0.3, s*0.38 + swing, s*0.2, s*0.08);
            ctx.fillRect(s*0.1, s*0.38 - swing, s*0.2, s*0.08);

            // Bulky Torso
            ctx.fillStyle = armorColor;
            ctx.strokeStyle = '#7f8c8d';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.roundRect(-s*0.38, -s*0.1, s*0.76, s*0.52, 6);
            ctx.fill(); ctx.stroke();

            // Chest hazard panel
            drawHazardPanel(-s*0.22, s*0.02, s*0.44, s*0.2);

            // Armored shoulders
            ctx.fillStyle = armorDark;
            ctx.beginPath(); ctx.roundRect(-s*0.48, -s*0.12, s*0.16, s*0.28, 4); ctx.fill();
            ctx.beginPath(); ctx.roundRect(s*0.32, -s*0.12, s*0.16, s*0.28, 4); ctx.fill();

            // Heavy Minigun (carrying forward-right)
            ctx.save();
            ctx.translate(s*0.26, s*0.2);
            ctx.rotate(0.35);
            ctx.fillStyle = '#111';
            ctx.fillRect(-8, 0, 16, s*0.5); // barrels
            ctx.fillStyle = '#555';
            ctx.fillRect(-10, s*0.12, 20, 6); // structural collar
            ctx.fillRect(-10, s*0.3, 20, 6); // structural collar
            ctx.restore();

            // Flexible Ammo Belt connecting to back
            ctx.strokeStyle = '#c5a059'; // bronze bullet colors
            ctx.lineWidth = 5;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.quadraticCurveTo(-s*0.5, s*0.2, s*0.2, s*0.35);
            ctx.stroke();
            ctx.setLineDash([]);

            // Heavy Helmet
            ctx.fillStyle = armorColor;
            ctx.beginPath();
            ctx.roundRect(-s*0.22, -s*0.42, s*0.44, s*0.32, 4);
            ctx.fill();
            // Horizontal Visor Slit
            ctx.fillStyle = color;
            ctx.fillRect(-s*0.14, -s*0.34, s*0.28, 5);

        } else if (dir === 'UP') {
            // Back view
            ctx.fillStyle = '#111';
            ctx.fillRect(-s*0.28, s*0.45 - swing, s*0.16, s*0.24);
            ctx.fillRect(s*0.12, s*0.45 + swing, s*0.16, s*0.24);

            // Body
            ctx.fillStyle = armorDark;
            ctx.beginPath();
            ctx.roundRect(-s*0.38, -s*0.1, s*0.76, s*0.52, 6);
            ctx.fill();

            // Heavy ammo canister on back
            drawHazardPanel(-s*0.25, s*0.0, s*0.5, s*0.38);

            // Helmet Back
            ctx.fillStyle = armorColor;
            ctx.beginPath();
            ctx.roundRect(-s*0.22, -s*0.42, s*0.44, s*0.32, 4);
            ctx.fill();

        } else if (dir === 'RIGHT') {
            // Profile Right
            ctx.fillStyle = '#111';
            ctx.fillRect(-s*0.2 - swing*0.5, s*0.45, s*0.16, s*0.24);
            ctx.fillRect(s*0.06 + swing*0.5, s*0.45, s*0.16, s*0.24);

            // Body
            ctx.fillStyle = armorColor;
            ctx.beginPath();
            ctx.roundRect(-s*0.26, -s*0.1, s*0.52, s*0.52, 6);
            ctx.fill();

            // Shoulder armor plate
            ctx.fillStyle = armorDark;
            ctx.beginPath(); ctx.roundRect(-s*0.05, -s*0.12, s*0.24, s*0.26, 4); ctx.fill();

            // Ammo backpack side
            ctx.fillStyle = '#1c1d22';
            ctx.fillRect(-s*0.38, s*0.0, s*0.14, s*0.35);

            // Minigun held forward
            ctx.save();
            ctx.translate(s*0.2, s*0.18);
            ctx.rotate(Math.PI/2 - 0.2);
            ctx.fillStyle = '#111';
            ctx.fillRect(-8, 0, 16, s*0.58);
            ctx.fillStyle = '#555';
            ctx.fillRect(-10, s*0.15, 20, 5);
            ctx.fillRect(-10, s*0.35, 20, 5);
            ctx.restore();

            // Ammo belt loop
            ctx.strokeStyle = '#c5a059';
            ctx.lineWidth = 5;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.quadraticCurveTo(-s*0.2, s*0.38, s*0.2, s*0.28);
            ctx.stroke();
            ctx.setLineDash([]);

            // Helmet side
            ctx.fillStyle = armorColor;
            ctx.beginPath(); ctx.arc(0, -s*0.26, s*0.18, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = color;
            ctx.fillRect(s*0.06, -s*0.28, s*0.12, 5);

        } else if (dir === 'LEFT') {
            // Profile Left
            ctx.fillStyle = '#111';
            ctx.fillRect(s*0.06 + swing*0.5, s*0.45, s*0.16, s*0.24);
            ctx.fillRect(-s*0.2 - swing*0.5, s*0.45, s*0.16, s*0.24);

            ctx.fillStyle = armorColor;
            ctx.beginPath();
            ctx.roundRect(-s*0.26, -s*0.1, s*0.52, s*0.52, 6);
            ctx.fill();

            ctx.fillStyle = armorDark;
            ctx.beginPath(); ctx.roundRect(-s*0.19, -s*0.12, s*0.24, s*0.26, 4); ctx.fill();

            ctx.fillStyle = '#1c1d22';
            ctx.fillRect(s*0.24, s*0.0, s*0.14, s*0.35);

            // Minigun left
            ctx.save();
            ctx.translate(-s*0.2, s*0.18);
            ctx.rotate(-Math.PI/2 + 0.2);
            ctx.fillStyle = '#111';
            ctx.fillRect(-8, 0, 16, s*0.58);
            ctx.fillStyle = '#555';
            ctx.fillRect(-10, s*0.15, 20, 5);
            ctx.fillRect(-10, s*0.35, 20, 5);
            ctx.restore();

            // Ammo belt loop
            ctx.strokeStyle = '#c5a059';
            ctx.lineWidth = 5;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.quadraticCurveTo(s*0.2, s*0.38, -s*0.2, s*0.28);
            ctx.stroke();
            ctx.setLineDash([]);

            // Helmet
            ctx.fillStyle = armorColor;
            ctx.beginPath(); ctx.arc(0, -s*0.26, s*0.18, 0, Math.PI*2); ctx.fill();
            ctx.fillStyle = color;
            ctx.fillRect(-s*0.18, -s*0.28, s*0.12, 5);
        }

        ctx.restore();
    }
};

// Aliases for retro compatibility
Avatars["Sentry-Mech"] = Avatars["Combat-Operative"];
Avatars["Spider-Core"] = Avatars["Recon-Drone"];
Avatars["Stealth-Agent"] = Avatars["Stealth-Sniper"];
Avatars["Spring-Runner"] = Avatars["Heavy-Gunner"];

// ─── HUNTER MODE DRAWINGS & ENGINE ───
function draw3DBox(ctx, cx, cy, w, d, h, baseColor, angle = 0) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);

    const wp = w * 0.7;
    const dp = d * 0.7;
    
    // Ground shadow
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-wp, wp * 0.5);
    ctx.lineTo(0, wp * 0.5 + dp * 0.5);
    ctx.lineTo(dp, dp * 0.5);
    ctx.closePath();
    ctx.fill();

    // Left face
    ctx.fillStyle = baseColor;
    ctx.beginPath();
    ctx.moveTo(-wp, wp * 0.5 - h);
    ctx.lineTo(0, -h);
    ctx.lineTo(0, 0);
    ctx.lineTo(-wp, wp * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.15)';
    ctx.fill();

    // Right face
    ctx.fillStyle = baseColor;
    ctx.beginPath();
    ctx.moveTo(0, -h);
    ctx.lineTo(dp, dp * 0.5 - h);
    ctx.lineTo(dp, dp * 0.5);
    ctx.lineTo(0, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.fill();

    // Top face
    ctx.fillStyle = baseColor;
    ctx.beginPath();
    ctx.moveTo(0, -h);
    ctx.lineTo(-wp, wp * 0.5 - h);
    ctx.lineTo(0, wp * 0.5 + dp * 0.5 - h);
    ctx.lineTo(dp, dp * 0.5 - h);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.15)';
    ctx.fill();

    // Outlines
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -h);
    ctx.lineTo(0, 0);
    ctx.moveTo(-wp, wp * 0.5 - h);
    ctx.lineTo(-wp, wp * 0.5);
    ctx.moveTo(dp, dp * 0.5 - h);
    ctx.lineTo(dp, dp * 0.5);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath();
    ctx.moveTo(-wp, wp * 0.5 - h);
    ctx.lineTo(0, -h);
    ctx.lineTo(dp, dp * 0.5 - h);
    ctx.lineTo(0, wp * 0.5 + dp * 0.5 - h);
    ctx.closePath();
    ctx.stroke();

    ctx.restore();
}

function drawHunterCrate(ctx, r, color) {
    drawGroundShadow(ctx, 0, 0, r * 1.3);
    const size = r * 1.2;
    const height = r * 1.0;
    draw3DBox(ctx, 0, 0, size, size, height, color);

    const wp = size * 0.7;
    const dp = size * 0.7;
    ctx.save();
    ctx.translate(0, -height);
    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-wp * 0.8, wp * 0.4);
    ctx.lineTo(dp * 0.8, -dp * 0.4);
    ctx.moveTo(wp * 0.8, wp * 0.4);
    ctx.lineTo(-dp * 0.8, -dp * 0.4);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = `bold ${r * 0.7}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('★', 0, 0);
    ctx.restore();
}

function drawHunterBarrel(ctx, r, color) {
    drawGroundShadow(ctx, 0, 0, r * 1.2);
    const w = r * 0.85;
    const h = r * 1.4;
    
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, h * 0.5, w, w * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    const g = ctx.createLinearGradient(-w, 0, w, 0);
    g.addColorStop(0, 'rgba(0,0,0,0.6)');
    g.addColorStop(0.3, color);
    g.addColorStop(0.6, 'rgba(255,255,255,0.3)');
    g.addColorStop(0.9, color);
    g.addColorStop(1, 'rgba(0,0,0,0.7)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-w, -h * 0.5);
    ctx.lineTo(w, -h * 0.5);
    ctx.lineTo(w, h * 0.5);
    ctx.lineTo(-w, h * 0.5);
    ctx.closePath();
    ctx.fill();

    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 3;
    [-h*0.25, 0, h*0.25].forEach(y => {
        ctx.beginPath();
        ctx.ellipse(0, y, w, w * 0.4, 0, 0, Math.PI);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.beginPath();
        ctx.ellipse(0, y, w, w * 0.4, 0, Math.PI, Math.PI * 2);
        ctx.stroke();
    });

    const topG = ctx.createRadialGradient(0, -h * 0.5, 0, 0, -h * 0.5, w);
    topG.addColorStop(0, 'rgba(255,255,255,0.15)');
    topG.addColorStop(0.8, color);
    topG.addColorStop(1, 'rgba(0,0,0,0.6)');
    ctx.fillStyle = topG;
    ctx.beginPath();
    ctx.ellipse(0, -h * 0.5, w, w * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.stroke();

    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.ellipse(0, -h * 0.5, w * 0.8, w * 0.32, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = '#ff3333';
    ctx.beginPath();
    ctx.moveTo(-w * 0.3, -h * 0.1);
    ctx.lineTo(0, -h * 0.25);
    ctx.lineTo(w * 0.3, -h * 0.1);
    ctx.lineTo(0, h * 0.05);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 8px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('☣', 0, -h * 0.08);
    ctx.restore();
}

function drawHunterCone(ctx, r) {
    drawGroundShadow(ctx, 0, 0, r * 1.1);
    ctx.save();
    ctx.fillStyle = '#1e1e1e';
    ctx.beginPath();
    ctx.ellipse(0, r * 0.4, r * 0.9, r * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#333';
    ctx.stroke();

    const h = r * 2.2;
    const bodyG = ctx.createLinearGradient(-r * 0.6, 0, r * 0.6, 0);
    bodyG.addColorStop(0, '#cc3a0a');
    bodyG.addColorStop(0.4, '#ff6030');
    bodyG.addColorStop(0.7, '#cc3a0a');
    bodyG.addColorStop(1, '#802000');
    ctx.fillStyle = bodyG;
    ctx.beginPath();
    ctx.moveTo(0, -h * 0.8);
    ctx.lineTo(r * 0.5, r * 0.3);
    ctx.ellipse(0, r * 0.3, r * 0.5, r * 0.2, 0, 0, Math.PI, false);
    ctx.lineTo(-r * 0.5, r * 0.3);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(-r * 0.25, -h * 0.3);
    ctx.lineTo(r * 0.25, -h * 0.3);
    ctx.lineTo(r * 0.35, -h * 0.1);
    ctx.lineTo(-r * 0.35, -h * 0.1);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#ff8050';
    ctx.beginPath();
    ctx.arc(0, -h * 0.8, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function drawHunterPallet(ctx, r) {
    drawGroundShadow(ctx, 0, 0, r * 1.3);
    ctx.save();
    const w = r * 1.3;
    const d = r * 1.1;
    const woodColor = '#805d3f';
    const darkWood = '#5a3e25';

    [-w * 0.7, 0, w * 0.7].forEach(x => {
        draw3DBox(ctx, x, r * 0.2, r * 0.2, r * 0.2, r * 0.25, darkWood);
    });

    [-d * 0.7, -d * 0.35, 0, d * 0.35, d * 0.7].forEach(z => {
        draw3DBox(ctx, 0, z * 0.5, w * 1.3, r * 0.18, 5, woodColor);
    });
    ctx.restore();
}

function drawHunterAmmoBox(ctx, r) {
    drawGroundShadow(ctx, 0, 0, r * 1.2);
    const boxColor = '#3a4f3b';
    const w = r * 1.1;
    const d = r * 0.75;
    const h = r * 0.8;
    draw3DBox(ctx, 0, 0, w, d, h, boxColor);

    const wp = w * 0.7;
    const dp = d * 0.7;
    ctx.save();
    ctx.translate(dp * 0.5, dp * 0.25 - h * 0.5);
    ctx.fillStyle = '#dcd635';
    ctx.font = 'bold 8px Courier New';
    ctx.textAlign = 'center';
    ctx.fillText('5.56 MM', 0, 0);
    ctx.restore();

    ctx.save();
    ctx.translate(-wp * 0.5, wp * 0.25 - h * 0.5);
    ctx.fillStyle = '#1e261f';
    ctx.fillRect(-3, -4, 6, 8);
    ctx.strokeStyle = '#5a705b';
    ctx.strokeRect(-3, -4, 6, 8);
    ctx.restore();
}

function drawHunterToolChest(ctx, r) {
    drawGroundShadow(ctx, 0, 0, r * 1.25);
    const chestColor = '#9c2a2a';
    const w = r * 1.1;
    const d = r * 0.8;
    const h = r * 0.9;
    draw3DBox(ctx, 0, 0, w, d, h, chestColor);

    const wp = w * 0.7;
    ctx.save();
    ctx.translate(-wp * 0.5, wp * 0.25 - h * 0.4);
    ctx.strokeStyle = '#eee';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-wp * 0.3, 0); ctx.lineTo(wp * 0.3, wp * 0.15);
    ctx.moveTo(-wp * 0.3, h * 0.25); ctx.lineTo(wp * 0.3, wp * 0.15 + h * 0.25);
    ctx.stroke();
    ctx.restore();
}

function drawHunterGenerator(ctx, r) {
    drawGroundShadow(ctx, 0, 0, r * 1.35);
    const genColor = '#c28717';
    const w = r * 1.2;
    const d = r * 0.9;
    const h = r * 1.1;
    draw3DBox(ctx, 0, 0, w, d, h, genColor);

    const wp = w * 0.7;
    ctx.save();
    ctx.translate(-wp * 0.5, wp * 0.25 - h * 0.4);
    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.4, r * 0.25, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#444';
    ctx.stroke();

    ctx.strokeStyle = '#888';
    ctx.lineWidth = 3;
    const angle = (Date.now() / 150) % (Math.PI * 2);
    ctx.beginPath();
    ctx.moveTo(-Math.cos(angle) * r * 0.35, -Math.sin(angle) * r * 0.2);
    ctx.lineTo(Math.cos(angle) * r * 0.35, Math.sin(angle) * r * 0.2);
    ctx.moveTo(-Math.sin(angle) * r * 0.35, Math.cos(angle) * r * 0.2);
    ctx.lineTo(Math.sin(angle) * r * 0.35, -Math.cos(angle) * r * 0.2);
    ctx.stroke();
    ctx.restore();
}

function drawHunterFireExt(ctx, r) {
    drawGroundShadow(ctx, 0, 0, r * 1.15);
    ctx.save();
    const w = r * 0.6;
    const h = r * 1.6;
    
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(0, h * 0.5, w, w * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    const g = ctx.createLinearGradient(-w, 0, w, 0);
    g.addColorStop(0, 'rgba(120,0,0,0.8)');
    g.addColorStop(0.3, '#d02020');
    g.addColorStop(0.6, 'rgba(255,255,255,0.4)');
    g.addColorStop(0.9, '#c01010');
    g.addColorStop(1, 'rgba(0,0,0,0.8)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-w, -h * 0.5);
    ctx.lineTo(w, -h * 0.5);
    ctx.lineTo(w, h * 0.5);
    ctx.lineTo(-w, h * 0.5);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#b01010';
    ctx.beginPath();
    ctx.ellipse(0, -h * 0.5, w, w * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#222';
    ctx.fillRect(-2, -h * 0.5 - 6, 4, 8);
    ctx.fillRect(-6, -h * 0.5 - 9, 12, 3);
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(2, -h * 0.5 - 4);
    ctx.quadraticCurveTo(w * 1.2, -h * 0.2, w * 0.8, h * 0.2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.moveTo(-w * 0.9, -h * 0.1);
    ctx.lineTo(w * 0.9, -h * 0.1);
    ctx.lineTo(w * 0.9, h * 0.25);
    ctx.lineTo(-w * 0.9, h * 0.25);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.font = '5px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('FIRE EX.', 0, h * 0.1);
    ctx.restore();
}

function drawHunterSandbag(ctx, r) {
    drawGroundShadow(ctx, 0, 0, r * 1.3);
    ctx.save();
    const w = r * 1.25;
    const h = r * 0.7;
    const sandG = ctx.createRadialGradient(-w * 0.1, -h * 0.1, 2, 0, 0, w);
    sandG.addColorStop(0, '#ebd2a0');
    sandG.addColorStop(0.7, '#c2ab7c');
    sandG.addColorStop(1, '#8c764e');
    ctx.fillStyle = sandG;

    ctx.beginPath();
    ctx.ellipse(0, 0, w, h, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.strokeStyle = 'rgba(0,0,0,0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.ellipse(0, 0, w * 0.9, h * 0.85, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-w * 0.6, -h * 0.1);
    ctx.quadraticCurveTo(0, h * 0.3, w * 0.6, -h * 0.1);
    ctx.stroke();
    ctx.restore();
}

function drawHunterLocker(ctx, r) {
    drawGroundShadow(ctx, 0, 0, r * 1.2);
    const lockerColor = '#5c646b';
    const w = r * 0.8;
    const d = r * 0.8;
    const h = r * 1.6;
    draw3DBox(ctx, 0, 0, w, d, h, lockerColor);

    const wp = w * 0.7;
    ctx.save();
    ctx.translate(-wp * 0.5, wp * 0.25 - h * 0.8);
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
        const y = i * 6;
        ctx.beginPath(); ctx.moveTo(-wp * 0.2, y); ctx.lineTo(wp * 0.2, y + wp * 0.1); ctx.stroke();
    }
    ctx.fillStyle = '#bbb';
    ctx.fillRect(wp * 0.1, h * 0.4, 3, 12);
    ctx.restore();
}

function drawHunterServerRack(ctx, r) {
    drawGroundShadow(ctx, 0, 0, r * 1.3);
    const rackColor = '#1e1f22';
    const w = r * 1.2;
    const d = r * 0.9;
    const h = r * 1.5;
    draw3DBox(ctx, 0, 0, w, d, h, rackColor);

    const wp = w * 0.7;
    ctx.save();
    ctx.translate(-wp * 0.5, wp * 0.25 - h * 0.5);

    const slots = 6;
    const slotH = h / slots;
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    for (let i = 1; i < slots; i++) {
        const y = i * slotH - h * 0.5;
        ctx.beginPath();
        ctx.moveTo(-wp * 0.45, y);
        ctx.lineTo(wp * 0.45, y + wp * 0.22);
        ctx.stroke();
    }

    const time = Date.now();
    for (let i = 0; i < slots; i++) {
        const y = i * slotH - h * 0.5 + slotH * 0.4;
        const lx = -wp * 0.3;
        const ly = y + wp * 0.05;

        let ledColor = '#00ff66';
        if (i % 3 === 1) ledColor = '#00ccff';
        else if (i % 3 === 2) ledColor = '#ffaa00';

        const speed = 400 + (i * 150) % 500;
        const isOn = (Math.floor(time / speed) % 2) === 0;

        if (isOn) {
            ctx.shadowColor = ledColor;
            ctx.shadowBlur = 6;
            ctx.fillStyle = ledColor;
        } else {
            ctx.fillStyle = 'rgba(0,0,0,0.8)';
        }
        ctx.beginPath();
        ctx.arc(lx, ly, 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
    }
    ctx.restore();
}

function drawHunterDesk(ctx, r) {
    drawGroundShadow(ctx, 0, 0, r * 1.3);
    ctx.save();
    const w = r * 1.3;
    const d = r * 0.9;
    const h = r * 0.85;

    draw3DBox(ctx, 0, -r * 0.15, w, d, 8, '#b07b50');

    const wp = w * 0.7;
    const dp = d * 0.7;
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 3;

    ctx.beginPath(); ctx.moveTo(-wp * 0.8, wp * 0.4); ctx.lineTo(-wp * 0.8, wp * 0.4 + h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(dp * 0.8, dp * 0.4); ctx.lineTo(dp * 0.8, dp * 0.4 + h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(dp * 0.8 - wp * 0.8, dp * 0.4 + wp * 0.4); ctx.lineTo(dp * 0.8 - wp * 0.8, dp * 0.4 + wp * 0.4 + h); ctx.stroke();
    ctx.restore();
}

function drawHunterTurret(ctx, r) {
    drawGroundShadow(ctx, 0, 0, r * 1.2);
    ctx.save();
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.2); ctx.lineTo(-r * 0.8, r * 0.5);
    ctx.moveTo(0, -r * 0.2); ctx.lineTo(r * 0.8, r * 0.5);
    ctx.moveTo(0, -r * 0.2); ctx.lineTo(0, -r * 0.9);
    ctx.stroke();

    ctx.fillStyle = '#222';
    ctx.beginPath();
    ctx.arc(0, -r * 0.5, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#666';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = '#111';
    ctx.fillRect(-8, -r * 0.85, 4, 16);
    ctx.fillRect(4, -r * 0.85, 4, 16);
    ctx.restore();
}

function drawHunterCamoNet(ctx, r) {
    drawGroundShadow(ctx, 0, 0, r * 1.4);
    ctx.save();
    ctx.strokeStyle = '#5c4e36';
    ctx.lineWidth = 3.5;
    const px = r * 0.85;
    const py = r * 0.45;
    
    [[-px, py], [px, py], [0, -py * 0.5]].forEach(([wx, wy]) => {
        ctx.beginPath();
        ctx.moveTo(wx, wy);
        ctx.lineTo(wx, wy - r * 0.9);
        ctx.stroke();
        ctx.fillStyle = '#1e1a12';
        ctx.fillRect(wx - 2, wy - r * 0.9 - 3, 4, 3);
    });

    ctx.fillStyle = 'rgba(74, 98, 68, 0.78)';
    ctx.beginPath();
    ctx.moveTo(-px, py - r * 0.7);
    ctx.quadraticCurveTo(0, py - r * 0.8, px, py - r * 0.7);
    ctx.quadraticCurveTo(px * 0.6, 0, px * 0.2, py * 0.5);
    ctx.quadraticCurveTo(-px * 0.6, py * 0.2, -px, py - r * 0.7);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(120, 100, 50, 0.75)';
    for (let i = 0; i < 5; i++) {
        const lx = (Math.sin(i * 4.2) * px * 0.5);
        const ly = (Math.cos(i * 2.8) * py * 0.4) - r * 0.35;
        const rad = r * 0.28;
        ctx.beginPath();
        ctx.arc(lx, ly, rad, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.fillStyle = 'rgba(54, 73, 50, 0.8)';
    for (let i = 0; i < 4; i++) {
        const lx = (Math.cos(i * 3.3) * px * 0.5);
        const ly = (Math.sin(i * 1.9) * py * 0.4) - r * 0.35;
        const rad = r * 0.24;
        ctx.beginPath();
        ctx.arc(lx, ly, rad, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.strokeStyle = 'rgba(0,0,0,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = -px; i <= px; i += 6) {
        ctx.moveTo(i, py - r * 0.85);
        ctx.lineTo(i + 12, py * 0.5);
    }
    ctx.stroke();
    ctx.restore();
}

function drawHunterToxicDrum(ctx, r) {
    drawGroundShadow(ctx, 0, 0, r * 1.25);
    const w = r * 0.85;
    const h = r * 1.45;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(0, h * 0.5, w, w * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    const g = ctx.createLinearGradient(-w, 0, w, 0);
    g.addColorStop(0, '#0c1d09');
    g.addColorStop(0.35, '#226017');
    g.addColorStop(0.65, '#39ff14');
    g.addColorStop(0.85, '#226017');
    g.addColorStop(1, '#050a04');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-w, -h * 0.5);
    ctx.lineTo(w, -h * 0.5);
    ctx.lineTo(w, h * 0.5);
    ctx.lineTo(-w, h * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)';
    ctx.lineWidth = 3.5;
    [-h*0.25, 0, h*0.25].forEach(y => {
        ctx.beginPath();
        ctx.ellipse(0, y, w, w * 0.45, 0, 0, Math.PI);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(57,255,20,0.3)';
        ctx.beginPath();
        ctx.ellipse(0, y, w, w * 0.45, 0, Math.PI, Math.PI * 2);
        ctx.stroke();
    });
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeStyle = '#39ff14';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(0, h * 0.05, w * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#39ff14';
    ctx.font = `bold ${w * 0.45}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('☣', 0, h * 0.05);
    ctx.restore();
    const topG = ctx.createRadialGradient(0, -h * 0.5, 0, 0, -h * 0.5, w);
    topG.addColorStop(0, '#39ff14');
    topG.addColorStop(0.7, '#1e5413');
    topG.addColorStop(1, '#050a04');
    ctx.fillStyle = topG;
    ctx.beginPath();
    ctx.ellipse(0, -h * 0.5, w, w * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.ellipse(0, -h * 0.5, w * 0.85, w * 0.38, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#39ff14';
    ctx.beginPath();
    ctx.ellipse(-w * 0.3, -h * 0.46, w * 0.15, w * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(-w * 0.36, -h * 0.46, w * 0.12, h * 0.32);
    ctx.beginPath();
    ctx.arc(-w * 0.3, -h * 0.46 + h * 0.32, w * 0.06, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function drawHunterRadarDish(ctx, r) {
    drawGroundShadow(ctx, 0, 0, r * 1.2);
    ctx.save();
    ctx.fillStyle = '#444';
    ctx.fillRect(-r * 0.4, -r * 0.4, r * 0.8, r * 0.8);
    ctx.strokeStyle = '#222';
    ctx.strokeRect(-r * 0.4, -r * 0.4, r * 0.8, r * 0.8);
    const dishG = ctx.createRadialGradient(0, 0, 2, 0, 0, r);
    dishG.addColorStop(0, '#aaa');
    dishG.addColorStop(0.6, '#888');
    dishG.addColorStop(1, '#555');
    ctx.fillStyle = dishG;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-r, 0); ctx.lineTo(r, 0);
    ctx.moveTo(0, -r); ctx.lineTo(0, r);
    ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = '#d00';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}

function drawHunterOfficeChair(ctx, r) {
    drawGroundShadow(ctx, 0, 0, r * 1.1);
    ctx.save();
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 3;
    for (let i = 0; i < 5; i++) {
        const ang = (i * Math.PI * 2) / 5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(ang) * r * 0.9, Math.sin(ang) * r * 0.9);
        ctx.stroke();
    }
    const seatG = ctx.createRadialGradient(0, 0, 2, 0, 0, r * 0.8);
    seatG.addColorStop(0, '#445');
    seatG.addColorStop(1, '#222d3a');
    ctx.fillStyle = seatG;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#111822';
    ctx.fillRect(-r * 0.6, -r * 0.9, r * 1.2, r * 0.35);
    ctx.strokeStyle = '#333';
    ctx.strokeRect(-r * 0.6, -r * 0.9, r * 1.2, r * 0.35);
    ctx.fillStyle = '#222';
    ctx.fillRect(-r * 0.9, -r * 0.4, r * 0.18, r * 0.7);
    ctx.fillRect(r * 0.72, -r * 0.4, r * 0.18, r * 0.7);
    ctx.restore();
}

function drawPropShape(ctx, type, r, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    if (type.startsWith('CRATE_S')) {
        drawHunterCrate(ctx, r, '#3d5a3c');
    } else if (type.startsWith('CRATE_M')) {
        drawHunterCrate(ctx, r, '#9c855a');
    } else if (type.startsWith('CRATE_L')) {
        drawHunterCrate(ctx, r, '#3c5a75');
    } else if (type === 'BARREL') {
        drawHunterBarrel(ctx, r, '#3a3a3a');
    } else if (type === 'FUEL_DRUM') {
        drawHunterBarrel(ctx, r, '#cc3a0a');
    } else if (type === 'CONE') {
        drawHunterCone(ctx, r);
    } else if (type === 'PALLET') {
        drawHunterPallet(ctx, r);
    } else if (type === 'AMMO_BOX') {
        drawHunterAmmoBox(ctx, r);
    } else if (type === 'TOOL_CHEST') {
        drawHunterToolChest(ctx, r);
    } else if (type === 'GENERATOR') {
        drawHunterGenerator(ctx, r);
    } else if (type === 'FIRE_EXT') {
        drawHunterFireExt(ctx, r);
    } else if (type === 'SANDBAG') {
        drawHunterSandbag(ctx, r);
    } else if (type === 'LOCKER') {
        drawHunterLocker(ctx, r);
    } else if (type === 'SERVER_RACK') {
        drawHunterServerRack(ctx, r);
    } else if (type === 'DESK') {
        drawHunterDesk(ctx, r);
    } else if (type === 'TURRET_OFF') {
        drawHunterTurret(ctx, r);
    } else if (type === 'CAMO_NET') {
        drawHunterCamoNet(ctx, r);
    } else if (type === 'TOXIC_DRUM') {
        drawHunterToxicDrum(ctx, r);
    } else if (type === 'RADAR_DISH') {
        drawHunterRadarDish(ctx, r);
    } else if (type === 'OFFICE_CHAIR') {
        drawHunterOfficeChair(ctx, r);
    } else {
        ctx.fillStyle = '#555';
        ctx.fillRect(-r, -r, r * 2, r * 2);
    }
    ctx.restore();
}

function drawHunterProp(prop, alpha = 1) {
    const now = Date.now();

    ctx.save();
    ctx.translate(prop.x, prop.y);
    ctx.rotate(prop.angle);

    // Disabled pulse animation to prevent bots from blinking
    // if (prop.animated) {
    //     const pulse = 0.9 + 0.1 * Math.sin(now / 300);
    //     ctx.scale(pulse, pulse);
    // }

    drawPropShape(ctx, prop.type, prop.radius, alpha);
    ctx.restore();
}

function drawHunterPlayer(id, p) {
    const isMe = (id === localPlayerId);
    const isHunter = (id === hunterId);
    const sc = G.cam.scale;

    ctx.save();
    ctx.translate(p.x, p.y);

    if (p.eliminated) {
        ctx.globalAlpha = 0.4;
        ctx.font = `bold 22px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#ff4444';
        ctx.fillText('💀', 0, 0);
        ctx.restore();
        return;
    }

    // Smoke screening visual check
    if (p.inSmoke && id !== hunterId) {
        let revealedByDrone = false;
        if (G.droneZone) {
            const dx = p.x - G.droneZone.x;
            const dy = p.y - G.droneZone.y;
            if (dx * dx + dy * dy < G.droneZone.radius * G.droneZone.radius) {
                revealedByDrone = true;
            }
        }
        if (myRole === 'hunter' && !revealedByDrone) {
            ctx.restore();
            return; // Completely invisible to hunter
        }
        // Semi-transparent for local player or spectator/other ghosts
        ctx.globalAlpha = 0.35;
    }

    if (p.disguised && p.disguiseType) {
        let alpha = isMe ? 0.55 : (id.startsWith('bot_') ? 0.85 : 1.0);
        if (p.inSmoke) {
            let revealedByDrone = false;
            if (G.droneZone) {
                const dx = p.x - G.droneZone.x;
                const dy = p.y - G.droneZone.y;
                if (dx * dx + dy * dy < G.droneZone.radius * G.droneZone.radius) {
                    revealedByDrone = true;
                }
            }
            if (myRole === 'hunter' && !revealedByDrone) {
                ctx.restore();
                return; // Completely invisible to hunter
            }
            alpha = 0.25; // Extra transparent under smoke
        }
        ctx.rotate(p.disguiseAngle);
        drawPropShape(ctx, p.disguiseType, p.disguiseRadius || 22, alpha);
        ctx.restore();
        return;
    }

    const size = 18;
    const color = isHunter ? '#00ffaa' : '#50c878';
    
    let isMoving = false;
    if (p._lastX !== undefined) {
        const dx = p.x - p._lastX;
        const dy = p.y - p._lastY;
        if (dx*dx + dy*dy > 0.1) isMoving = true;
    }
    p._lastX = p.x;
    p._lastY = p.y;

    const avType = isHunter ? 'Combat-Operative' : (p.avatar || 'Stealth-Sniper');
    const avDraw = Avatars[avType] || Avatars['Stealth-Sniper'];

    const isSpectatingThis = (id === spectateTargetId);
    if (isMe || isSpectatingThis) {
        ctx.save();
        ctx.strokeStyle = isSpectatingThis ? 'rgba(217, 83, 79, 0.6)' : 'rgba(80, 200, 120, 0.6)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        ctx.ellipse(0, size * 0.9, size * 0.9, size * 0.4, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    avDraw(ctx, 0, 0, size, color, isMoving, p.angle, false);

    if (avType !== 'Combat-Operative') {
        ctx.strokeStyle = isMe ? '#ffe080' : color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.cos(p.angle) * (size + 6), Math.sin(p.angle) * (size + 6));
        ctx.stroke();
    }

    if (isSpectatingThis) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(0, -size - 22);
        ctx.lineTo(-6, -size - 32);
        ctx.lineTo(6, -size - 32);
        ctx.closePath();
        ctx.fillStyle = '#d9534f';
        ctx.shadowColor = '#d9534f';
        ctx.shadowBlur = 4;
        ctx.fill();
        ctx.restore();
    }

    ctx.fillStyle = isMe ? '#ffe080' : '#aaa';
    ctx.font = `bold 10px 'Share Tech Mono', monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    let label = '';
    const isEng = (currentLang === 'en');
    if (isMe) {
        label = isEng ? 'YOU' : 'VOUS';
    } else if (isHunter) {
        label = id.startsWith('bot_') ? (p.name || `${isEng ? '🤖 HUNTER' : '🤖 CHASSEUR'} ${p.num}`) : `${isEng ? '👤 HUNTER' : '👤 CHASSEUR'} ${p.num}`;
    } else {
        label = id.startsWith('bot_') ? (p.name || `${isEng ? '🤖 GHOST' : '🤖 FANTÔME'} ${p.num}`) : `${isEng ? '👤 GHOST' : '👤 FANTÔME'} ${p.num}`;
    }
    ctx.fillText(label, 0, -size - 6);

    ctx.restore();
}

function drawHunterEffects() {
    const now = Date.now();

    for (let i = tagEffects.length - 1; i >= 0; i--) {
        const e = tagEffects[i];
        const age = now - (e.time || e.born);
        if (age > 400) {
            tagEffects.splice(i, 1);
            continue;
        }
        const t = age / 400;
        const r = 25 + t * 45;
        const col = e.result === 'hit' ? '#50e878' : (e.result === 'decoy' ? '#e8a020' : '#e05030');
        const ex = (e.x !== undefined ? e.x : e.wx);
        const ey = (e.y !== undefined ? e.y : e.wy);
        
        ctx.save();
        ctx.globalAlpha = 1 - t;
        ctx.strokeStyle = col;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(ex, ey, r, 0, Math.PI * 2);
        ctx.stroke();

        if (e.result === 'hit') {
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(ex - r * 0.5, ey); ctx.lineTo(ex + r * 0.5, ey);
            ctx.moveTo(ex, ey - r * 0.5); ctx.lineTo(ex, ey + r * 0.5);
            ctx.stroke();
        }
        ctx.restore();
    }

    for (let i = decoyEffects.length - 1; i >= 0; i--) {
        const e = decoyEffects[i];
        const age = now - e.born;
        if (age > e.life) {
            decoyEffects.splice(i, 1);
            continue;
        }
        const t = age / e.life;
        ctx.save();
        ctx.globalAlpha = (1 - t) * 0.8;
        ctx.font = `24px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('👣', e.wx, e.wy - t * 30);
        ctx.restore();
    }

    // Draw drone zone orange sonar sweep
    drawDroneZone();

    // Draw active smoke screens
    drawSmokes();

    // Draw cinétique wind sprint trails
    updateAndDrawSprintTrails();
}

function playHeartbeatBeep(vol) {
    sfxBeep(100, 0.12, 'sine', vol * 0.45);
    setTimeout(() => {
        sfxBeep(120, 0.15, 'sine', vol * 0.35);
    }, 180);
}

function drawDoorShape(door) {
    const now = Date.now();
    const open = door.open;
    const color = open ? '#00ff66' : '#ff1133';
    
    // Draw double-leaf metal door
    ctx.save();
    ctx.fillStyle = '#2c2e30';
    ctx.strokeStyle = '#4e5154';
    ctx.lineWidth = 3;
    
    const halfW = door.w / 2;
    const halfH = door.h / 2;
    
    if (open) {
        // Leaves retracted to the sides
        const leafW = door.w * 0.15;
        ctx.fillRect(door.x - halfW, door.y - halfH, leafW, door.h);
        ctx.strokeRect(door.x - halfW, door.y - halfH, leafW, door.h);
        
        ctx.fillRect(door.x + halfW - leafW, door.y - halfH, leafW, door.h);
        ctx.strokeRect(door.x + halfW - leafW, door.y - halfH, leafW, door.h);
    } else {
        // Leaves closed meeting in the middle
        const leafW = door.w * 0.48;
        ctx.fillRect(door.x - halfW, door.y - halfH, leafW, door.h);
        ctx.strokeRect(door.x - halfW, door.y - halfH, leafW, door.h);
        
        ctx.fillRect(door.x + 5, door.y - halfH, leafW, door.h);
        ctx.strokeRect(door.x + 5, door.y - halfH, leafW, door.h);
    }

    // Glowing barrier light
    ctx.strokeStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = (Math.floor(now / 200) % 2 === 0) ? 12 : 4;
    ctx.lineWidth = 4;
    ctx.beginPath();
    if (open) {
        ctx.moveTo(door.x - halfW + 15, door.y);
        ctx.lineTo(door.x - halfW + 35, door.y);
        ctx.moveTo(door.x + halfW - 35, door.y);
        ctx.lineTo(door.x + halfW - 15, door.y);
    } else {
        ctx.moveTo(door.x - halfW + 15, door.y);
        ctx.lineTo(door.x + halfW - 15, door.y);
    }
    ctx.stroke();
    ctx.restore();

    // Draw door console
    ctx.save();
    ctx.fillStyle = '#1e2022';
    ctx.strokeStyle = '#3e4144';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(door.consoleX, door.consoleY, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    
    ctx.fillStyle = color;
    ctx.shadowColor = color;
    ctx.shadowBlur = 6;
    ctx.beginPath();
    ctx.arc(door.consoleX, door.consoleY, 4, 0, Math.PI * 2);
    ctx.fill();
    
    ctx.font = 'bold 8px sans-serif';
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.fillText('DOOR', door.consoleX, door.consoleY - 8);
    ctx.restore();
}

const teleporterParticles = [];
function drawTeleporters() {
    if (G.theme !== 'Bloc Tactique') return;
    if (!G.teleporters || G.teleporters.length === 0) return;
    const now = Date.now();
    const pads = G.teleporters.map(tp => ({ x: tp.x, y: tp.y }));

    // Spawn rising particles periodically
    if (Math.random() < 0.15) {
        const pad = pads[Math.floor(Math.random() * pads.length)];
        const radius = 20 + Math.random() * 15;
        const angle = Math.random() * Math.PI * 2;
        teleporterParticles.push({
            x: pad.x + Math.cos(angle) * radius,
            y: pad.y + Math.sin(angle) * radius,
            vy: -(0.5 + Math.random() * 0.8),
            alpha: 1.0,
            life: 60 + Math.random() * 40
        });
    }

    // Update & draw teleporter particles
    for (let i = teleporterParticles.length - 1; i >= 0; i--) {
        const p = teleporterParticles[i];
        p.y += p.vy;
        p.alpha -= 0.015;
        p.life--;
        if (p.life <= 0 || p.alpha <= 0) {
            teleporterParticles.splice(i, 1);
            continue;
        }
        ctx.save();
        ctx.fillStyle = `rgba(0, 255, 240, ${p.alpha})`;
        ctx.shadowColor = '#00fff0';
        ctx.shadowBlur = 4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    for (const pad of pads) {
        // Draw hexagonal base
        ctx.save();
        ctx.strokeStyle = '#00fff0';
        ctx.shadowColor = '#00fff0';
        ctx.shadowBlur = 8;
        ctx.lineWidth = 2;
        
        // Draw Hexagon
        ctx.beginPath();
        const radius = 40;
        for (let i = 0; i < 6; i++) {
            const angle = (i / 6) * Math.PI * 2 + (now * 0.0003); // slowly rotate hexagon outline
            const hx = pad.x + Math.cos(angle) * radius;
            const hy = pad.y + Math.sin(angle) * radius;
            if (i === 0) ctx.moveTo(hx, hy);
            else ctx.lineTo(hx, hy);
        }
        ctx.closePath();
        ctx.fillStyle = 'rgba(0, 255, 240, 0.08)';
        ctx.fill();
        ctx.stroke();

        // Draw rotating inner rings
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(pad.x, pad.y, 25, 0, Math.PI * 2);
        ctx.stroke();

        ctx.setLineDash([8, 12]);
        ctx.beginPath();
        ctx.arc(pad.x, pad.y, 18, now * 0.0015, now * 0.0015 + Math.PI * 2);
        ctx.stroke();
        
        // Center node
        ctx.fillStyle = '#00fff0';
        ctx.beginPath();
        ctx.arc(pad.x, pad.y, 5, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
    }
}

const smokePuffs = [];
function drawSmokes() {
    if (!G.smokes || G.smokes.length === 0) return;
    
    const now = Date.now();
    // Spawn local visual cloud puffs inside active smoke zones if needed
    for (const smoke of G.smokes) {
        if (Math.random() < 0.12) {
            const ang = Math.random() * Math.PI * 2;
            const dist = Math.random() * smoke.radius * 0.8;
            smokePuffs.push({
                x: smoke.x + Math.cos(ang) * dist,
                y: smoke.y + Math.sin(ang) * dist,
                size: 45 + Math.random() * 45,
                vx: (Math.random() - 0.5) * 0.25,
                vy: (Math.random() - 0.5) * 0.25,
                alpha: 0.4 + Math.random() * 0.2,
                life: 80 + Math.random() * 40
            });
        }
    }

    // Draw active smoke disks
    for (const smoke of G.smokes) {
        ctx.save();
        const grad = ctx.createRadialGradient(smoke.x, smoke.y, smoke.radius * 0.2, smoke.x, smoke.y, smoke.radius);
        grad.addColorStop(0, 'rgba(120, 140, 150, 0.45)');
        grad.addColorStop(0.5, 'rgba(110, 125, 135, 0.25)');
        grad.addColorStop(1, 'rgba(100, 110, 120, 0)');
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(smoke.x, smoke.y, smoke.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    // Update & draw textured smoke puffs
    for (let i = smokePuffs.length - 1; i >= 0; i--) {
        const p = smokePuffs[i];
        p.x += p.vx;
        p.y += p.vy;
        p.alpha -= 0.005;
        p.life--;
        
        let insideAny = false;
        if (G.smokes) {
            for (const s of G.smokes) {
                const dx = p.x - s.x;
                const dy = p.y - s.y;
                if (dx * dx + dy * dy < s.radius * s.radius) {
                    insideAny = true;
                    break;
                }
            }
        }
        if (!insideAny) p.alpha -= 0.02;

        if (p.life <= 0 || p.alpha <= 0) {
            smokePuffs.splice(i, 1);
            continue;
        }

        ctx.save();
        ctx.globalAlpha = p.alpha;
        ctx.fillStyle = '#6e7a82';
        ctx.shadowColor = '#5e6a72';
        ctx.shadowBlur = p.size * 0.4;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
}

const sprintTrails = [];
function updateAndDrawSprintTrails() {
    const now = Date.now();
    for (const [id, p] of Object.entries(G.players)) {
        if (p.eliminated) continue;
        if (p.sprintActive) {
            if (p.inSmoke && myRole === 'hunter') {
                let revealedByDrone = false;
                if (G.droneZone) {
                    const dx = p.x - G.droneZone.x;
                    const dy = p.y - G.droneZone.y;
                    if (dx * dx + dy * dy < G.droneZone.radius * G.droneZone.radius) {
                        revealedByDrone = true;
                    }
                }
                if (!revealedByDrone) continue;
            }
            const ip = interpolatedPlayers[id] || p;
            sprintTrails.push({
                x: ip.x,
                y: ip.y,
                alpha: 0.6,
                life: 15
            });
        }
    }

    for (let i = sprintTrails.length - 1; i >= 0; i--) {
        const t = sprintTrails[i];
        t.alpha -= 0.04;
        t.life--;
        if (t.life <= 0 || t.alpha <= 0) {
            sprintTrails.splice(i, 1);
            continue;
        }
        ctx.save();
        ctx.strokeStyle = `rgba(255, 255, 255, ${t.alpha})`;
        ctx.lineWidth = 3;
        ctx.shadowColor = '#ffffff';
        ctx.shadowBlur = 6;
        ctx.beginPath();
        ctx.arc(t.x, t.y, 8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }
}

function drawDroneZone() {
    if (!G.droneZone) return;
    const now = Date.now();
    const zone = G.droneZone;

    ctx.save();
    ctx.fillStyle = 'rgba(255, 120, 0, 0.08)';
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(255, 120, 0, 0.45)';
    ctx.shadowColor = '#ff7800';
    ctx.shadowBlur = 10;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
    ctx.stroke();

    const sonarRadius = (now * 0.15) % zone.radius;
    ctx.strokeStyle = `rgba(255, 120, 0, ${1 - sonarRadius / zone.radius})`;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(zone.x, zone.y, sonarRadius, 0, Math.PI * 2);
    ctx.stroke();

    const sweepAngle = (now * 0.002) % (Math.PI * 2);
    ctx.strokeStyle = 'rgba(255, 120, 0, 0.2)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(zone.x, zone.y);
    ctx.lineTo(zone.x + Math.cos(sweepAngle) * zone.radius, zone.y + Math.sin(sweepAngle) * zone.radius);
    ctx.stroke();

    ctx.restore();
}

function drawHunterBackground() {
    const bio = BIOME_FLOOR[G.theme] || BIOME_FLOOR['Depot Alpha'];
    
    ctx.fillStyle = bio.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.scale(G.cam.scale, G.cam.scale);
    ctx.translate(-G.cam.x, -G.cam.y);

    const vLeft   = G.cam.x - 100;
    const vRight  = G.cam.x + canvas.width / G.cam.scale + 100;
    const vTop    = G.cam.y - 100;
    const vBottom = G.cam.y + canvas.height / G.cam.scale + 100;

    const GRID = 120;
    const now = Date.now();

    if (G.theme === 'Depot Alpha') {
        // --- INDUSTRIAL DEPOT BACKGROUND ---
        // --- MILITARY BASE / DEPOT ALPHA ---
        // Draw concrete seams
        ctx.strokeStyle = '#10120f';
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        const SEAM = 240;
        for (let x = 0; x <= G.mapSize.w; x += SEAM) {
            ctx.moveTo(x, 0); ctx.lineTo(x, G.mapSize.h);
        }
        for (let y = 0; y <= G.mapSize.h; y += SEAM) {
            ctx.moveTo(0, y); ctx.lineTo(G.mapSize.w, y);
        }
        ctx.stroke();

        // Faint inner grid lines
        ctx.strokeStyle = 'rgba(255,255,255,0.02)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 120; x <= G.mapSize.w; x += SEAM) {
            ctx.moveTo(x, 0); ctx.lineTo(x, G.mapSize.h);
        }
        for (let y = 120; y <= G.mapSize.h; y += SEAM) {
            ctx.moveTo(0, y); ctx.lineTo(G.mapSize.w, y);
        }
        ctx.stroke();

        // Double rivets/bolts at concrete corners
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        for (let x = 0; x <= G.mapSize.w; x += SEAM) {
            for (let y = 0; y <= G.mapSize.h; y += SEAM) {
                if (x < vLeft || x > vRight || y < vTop || y > vBottom) continue;
                ctx.beginPath();
                ctx.arc(x - 5, y - 5, 2, 0, Math.PI * 2);
                ctx.arc(x + 5, y - 5, 2, 0, Math.PI * 2);
                ctx.arc(x - 5, y + 5, 2, 0, Math.PI * 2);
                ctx.arc(x + 5, y + 5, 2, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Faint concrete cracks
        ctx.strokeStyle = 'rgba(0,0,0,0.18)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        const cracks = [
            { x: 300, y: 400, pts: [[0,0],[20,15],[35,10],[50,30]] },
            { x: 1800, y: 600, pts: [[0,0],[-15,20],[-40,35],[-50,60]] },
            { x: 1100, y: 1500, pts: [[0,0],[30,10],[50,0],[80,20]] },
            { x: 2200, y: 1900, pts: [[0,0],[-20,-10],[-35,-30],[-40,-60]] }
        ];
        for (const c of cracks) {
            if (c.x >= vLeft && c.x <= vRight && c.y >= vTop && c.y <= vBottom) {
                ctx.moveTo(c.x, c.y);
                for (const pt of c.pts) {
                    ctx.lineTo(c.x + pt[0], c.y + pt[1]);
                }
            }
        }
        ctx.stroke();

        // Metal floor panels (reinforced steel plates on ground)
        const plates = [
            { x: 800, y: 400, w: 200, h: 160 },
            { x: 2000, y: 1400, w: 240, h: 180 },
            { x: 600, y: 1800, w: 180, h: 180 }
        ];
        for (const pl of plates) {
            if (pl.x + pl.w > vLeft && pl.x < vRight && pl.y + pl.h > vTop && pl.y < vBottom) {
                // Draw metal box
                ctx.fillStyle = '#222520';
                ctx.fillRect(pl.x, pl.y, pl.w, pl.h);
                ctx.strokeStyle = '#141613';
                ctx.lineWidth = 3;
                ctx.strokeRect(pl.x, pl.y, pl.w, pl.h);
                
                // Metal bolts at corners
                ctx.fillStyle = '#555';
                ctx.beginPath();
                ctx.arc(pl.x + 10, pl.y + 10, 3, 0, Math.PI * 2);
                ctx.arc(pl.x + pl.w - 10, pl.y + 10, 3, 0, Math.PI * 2);
                ctx.arc(pl.x + 10, pl.y + pl.h - 10, 3, 0, Math.PI * 2);
                ctx.arc(pl.x + pl.w - 10, pl.y + pl.h - 10, 3, 0, Math.PI * 2);
                ctx.fill();
                
                // Diagonal grip texture
                ctx.strokeStyle = 'rgba(255,255,255,0.03)';
                ctx.lineWidth = 2;
                ctx.beginPath();
                for (let k = 20; k < pl.w; k += 40) {
                    ctx.moveTo(pl.x + k, pl.y + 15);
                    ctx.lineTo(pl.x + k - 10, pl.y + pl.h - 15);
                }
                ctx.stroke();
            }
        }

        // Military Warning Stencils and markings
        ctx.save();
        ctx.font = 'bold 22px monospace';
        ctx.textAlign = 'center';
        const labels = [
            { t: '★ RESTRICTED AREA ★', x: 1500, y: 1250, c: 'rgba(220, 80, 80, 0.12)' },
            { t: 'AMMUNITION DEPOT B', x: 480, y: 480, c: 'rgba(255, 200, 100, 0.08)' },
            { t: 'MIL-BASE SEC-01', x: 2520, y: 480, c: 'rgba(255, 200, 100, 0.08)' },
            { t: 'HQ CONTROL GATEWAY', x: 1500, y: 2200, c: 'rgba(100, 200, 255, 0.09)' },
            { t: 'TACTICAL UNIT STANDBY', x: 480, y: 1920, c: 'rgba(255, 200, 100, 0.08)' }
        ];
        for (const l of labels) {
            if (l.x >= vLeft && l.x <= vRight && l.y >= vTop && l.y <= vBottom) {
                ctx.fillStyle = l.c;
                ctx.fillText(l.t, l.x, l.y);
            }
        }
        ctx.restore();

        // Tactical circle radar overlay on ground
        ctx.save();
        ctx.strokeStyle = 'rgba(250, 70, 70, 0.04)';
        ctx.lineWidth = 5;
        ctx.setLineDash([15, 30]);
        ctx.beginPath();
        ctx.arc(1500, 1200, 400, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(1500, 1200, 800, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        // Hazard floor paint zones
        ctx.fillStyle = 'rgba(212, 163, 23, 0.08)';
        const hazardZones = [
            { x: 1200, y: 1000, w: 600, h: 400 },
            { x: 300, y: 1000, w: 200, h: 400 },
            { x: 2500, y: 1000, w: 200, h: 400 }
        ];
        for (const hz of hazardZones) {
            if (hz.x + hz.w > vLeft && hz.x < vRight && hz.y + hz.h > vTop && hz.y < vBottom) {
                ctx.fillRect(hz.x, hz.y, hz.w, hz.h);
                // Draw some lines inside
                ctx.save();
                ctx.strokeStyle = 'rgba(0,0,0,0.1)';
                ctx.lineWidth = 8;
                ctx.setLineDash([15, 15]);
                ctx.beginPath();
                ctx.moveTo(hz.x, hz.y);
                ctx.lineTo(hz.x + hz.w, hz.y + hz.h);
                ctx.stroke();
                ctx.restore();
            }
        }

        // Ventilation fans
        const vents = [
            {x: 400, y: 300}, {x: 1200, y: 800}, 
            {x: 500, y: 1500}, {x: 1500, y: 1200}, 
            {x: 800, y: 900}, {x: 2200, y: 600},
            {x: 2500, y: 1800}, {x: 1800, y: 2200}
        ];
        vents.forEach(v => {
            if (v.x + 80 < vLeft || v.x - 80 > vRight || v.y + 80 < vTop || v.y - 80 > vBottom) return;
            ctx.save();
            ctx.translate(v.x, v.y);
            
            ctx.fillStyle = '#202520';
            ctx.strokeStyle = '#323b32';
            ctx.lineWidth = 4;
            ctx.beginPath();
            ctx.arc(0, 0, 42, 0, Math.PI * 2);
            ctx.fill(); ctx.stroke();

            ctx.strokeStyle = 'rgba(0,0,0,0.45)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            for (let d = -32; d <= 32; d += 8) {
                ctx.moveTo(d, -Math.sqrt(1600 - d*d));
                ctx.lineTo(d, Math.sqrt(1600 - d*d));
                ctx.moveTo(-Math.sqrt(1600 - d*d), d);
                ctx.lineTo(Math.sqrt(1600 - d*d), d);
            }
            ctx.stroke();

            ctx.rotate(now * 0.0018);
            ctx.fillStyle = '#0d0f0c';
            for (let b = 0; b < 4; b++) {
                ctx.rotate(Math.PI / 2);
                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.quadraticCurveTo(-10, -18, -6, -32);
                ctx.lineTo(6, -32);
                ctx.quadraticCurveTo(10, -18, 0, 0);
                ctx.fill();
            }

            ctx.fillStyle = '#323b32';
            ctx.beginPath();
            ctx.arc(0, 0, 8, 0, Math.PI * 2);
            ctx.fill();

            ctx.restore();
        });

        // Safety hazard stripe borders
        ctx.save();
        ctx.strokeStyle = '#d4a317'; // Yellow
        ctx.lineWidth = 14;
        ctx.strokeRect(0, 0, G.mapSize.w, G.mapSize.h);

        ctx.strokeStyle = '#111111'; // Black hazard stripes overlay
        ctx.lineWidth = 14;
        ctx.setLineDash([16, 16]);
        ctx.strokeRect(0, 0, G.mapSize.w, G.mapSize.h);
        ctx.restore();

    } else if (G.theme === 'Zone Charlie') {
        // --- FOREST OVERGROWN BACKGROUND ---
        // Draw soft mossy circles
        ctx.fillStyle = 'rgba(30, 50, 20, 0.12)';
        for (let x = 300; x < G.mapSize.w; x += 450) {
            for (let y = 300; y < G.mapSize.h; y += 450) {
                // Offset mathematically
                const ox = x + Math.sin(x * 0.05) * 80;
                const oy = y + Math.cos(y * 0.07) * 80;
                if (ox + 100 < vLeft || ox - 100 > vRight || oy + 100 < vTop || oy - 100 > vBottom) continue;
                ctx.beginPath();
                ctx.arc(ox, oy, 80 + (x % 30), 0, Math.PI * 2);
                ctx.fill();
            }
        }

        // Grass tufts clusters
        ctx.strokeStyle = 'rgba(80, 150, 70, 0.35)';
        ctx.lineWidth = 1.8;
        for (let x = 100; x < G.mapSize.w; x += 180) {
            for (let y = 100; y < G.mapSize.h; y += 180) {
                const ox = x + Math.cos(x) * 40;
                const oy = y + Math.sin(y) * 40;
                if (ox < vLeft || ox > vRight || oy < vTop || oy > vBottom) continue;
                ctx.beginPath();
                // 3 grass blades
                ctx.moveTo(ox, oy); ctx.lineTo(ox - 5, oy - 12);
                ctx.moveTo(ox, oy); ctx.lineTo(ox, oy - 15);
                ctx.moveTo(ox, oy); ctx.lineTo(ox + 5, oy - 10);
                ctx.stroke();
            }
        }

        // Bioluminescent firefly spores
        ctx.save();
        for (let i = 0; i < 20; i++) {
            const seedX = i * 237.5 + 120;
            const seedY = i * 189.3 + 90;
            const fx = (seedX + Math.sin(now * 0.0004 + seedX) * 250 + G.mapSize.w) % G.mapSize.w;
            const fy = (seedY + Math.cos(now * 0.0003 + seedY) * 200 + G.mapSize.h) % G.mapSize.h;
            if (fx < vLeft || fx > vRight || fy < vTop || fy > vBottom) continue;

            const alpha = 0.3 + 0.3 * Math.sin(now * 0.002 + seedX);
            ctx.fillStyle = `rgba(0, 255, 150, ${alpha})`;
            ctx.shadowColor = '#00ffaa';
            ctx.shadowBlur = 6;
            ctx.beginPath();
            ctx.arc(fx, fy, 4, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();

        // Mossy log borders
        ctx.save();
        ctx.strokeStyle = 'rgba(85, 60, 40, 0.65)'; // Wood brown
        ctx.lineWidth = 12;
        ctx.strokeRect(0, 0, G.mapSize.w, G.mapSize.h);
        
        ctx.strokeStyle = 'rgba(50, 110, 50, 0.5)'; // Moss overlay
        ctx.lineWidth = 12;
        ctx.setLineDash([25, 45]);
        ctx.strokeRect(0, 0, G.mapSize.w, G.mapSize.h);
        ctx.restore();

    } else {
        // --- CYBER BLOC TACTIQUE BACKGROUND ---
        ctx.strokeStyle = bio.gridCol;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x <= G.mapSize.w; x += GRID) {
            ctx.moveTo(x, 0); ctx.lineTo(x, G.mapSize.h);
        }
        for (let y = 0; y <= G.mapSize.h; y += GRID) {
            ctx.moveTo(0, y); ctx.lineTo(G.mapSize.w, y);
        }
        ctx.stroke();

        // Cyber grid accents
        ctx.strokeStyle = bio.accentLine;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        const AGRID = 600;
        for (let x = 0; x <= G.mapSize.w; x += AGRID) {
            ctx.moveTo(x, 0); ctx.lineTo(x, G.mapSize.h);
        }
        for (let y = 0; y <= G.mapSize.h; y += AGRID) {
            ctx.moveTo(0, y); ctx.lineTo(G.mapSize.w, y);
        }
        ctx.stroke();

        // Circuit pathways on the floor
        ctx.strokeStyle = 'rgba(0, 180, 255, 0.12)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const pathsX = [300, 900, 1500, 2100, 2700];
        for (const px of pathsX) {
            if (px < vLeft || px > vRight) continue;
            ctx.moveTo(px, 0);
            ctx.lineTo(px, G.mapSize.h);
            // Draw diagonal bends
            for (let cy = 400; cy < G.mapSize.h; cy += 800) {
                ctx.moveTo(px, cy);
                ctx.lineTo(px + 40, cy + 40);
                ctx.lineTo(px + 40, cy + 120);
                ctx.lineTo(px, cy + 160);
            }
        }
        ctx.stroke();

        // Server Status Blinking LEDs (cyber nodes)
        ctx.save();
        const blinkFast = Math.floor(now / 350) % 2 === 0;
        const blinkSlow = Math.floor(now / 700) % 2 === 0;
        const leds = [
            { x: 600, y: 600, c: '#00ffaa' }, { x: 615, y: 600, c: '#ff3344' },
            { x: 1800, y: 600, c: '#00ffaa' }, { x: 1815, y: 600, c: '#00ffaa' },
            { x: 1200, y: 1800, c: '#ffff00' }, { x: 1215, y: 1800, c: '#ff3344' },
            { x: 2400, y: 1200, c: '#00ffaa' }, { x: 2415, y: 1200, c: '#ffff00' }
        ];
        for (const led of leds) {
            if (led.x < vLeft || led.x > vRight || led.y < vTop || led.y > vBottom) continue;
            const active = led.x % 2 === 0 ? blinkFast : blinkSlow;
            ctx.fillStyle = active ? led.c : '#222';
            ctx.beginPath();
            ctx.arc(led.x, led.y, 3, 0, Math.PI * 2);
            ctx.fill();
        }
        ctx.restore();

        // Holographic security camera scanner sweeps
        ctx.save();
        const cameras = [
            { x: 200, y: 200, startAng: 0 },
            { x: 2800, y: 200, startAng: Math.PI / 2 },
            { x: 1500, y: 1200, startAng: Math.PI },
            { x: 200, y: 2200, startAng: Math.PI * 1.5 },
            { x: 2800, y: 2200, startAng: 0 }
        ];
        for (const cam of cameras) {
            if (cam.x + 150 < vLeft || cam.x - 150 > vRight || cam.y + 150 < vTop || cam.y - 150 > vBottom) continue;
            ctx.save();
            ctx.translate(cam.x, cam.y);
            
            // Rotating scanning cone
            const sweepAngle = cam.startAng + Math.sin(now * 0.0008 + cam.x) * 0.8;
            ctx.rotate(sweepAngle);
            
            const grad = ctx.createLinearGradient(0, 0, 150, 0);
            grad.addColorStop(0, 'rgba(0, 255, 170, 0.25)');
            grad.addColorStop(1, 'rgba(0, 255, 170, 0)');
            ctx.fillStyle = grad;
            
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(150, -35);
            ctx.lineTo(150, 35);
            ctx.closePath();
            ctx.fill();
            
            ctx.restore();
        }
        ctx.restore();

        // Glowing blue cyber field border
        ctx.save();
        ctx.strokeStyle = '#00bbff';
        ctx.shadowColor = '#00bbff';
        ctx.shadowBlur = 8;
        ctx.lineWidth = 6;
        ctx.strokeRect(0, 0, G.mapSize.w, G.mapSize.h);
        ctx.restore();
    }

    ctx.restore();
}

function drawHunterMinimap() {
    const canvasEl = document.getElementById('hunterHUD_minimapCanvas');
    if (!canvasEl) return;
    const mmCtx = canvasEl.getContext('2d');
    const W = canvasEl.width;
    const H = canvasEl.height;
    const sx = W / G.mapSize.w;
    const sy = H / G.mapSize.h;

    mmCtx.fillStyle = 'rgba(10,14,8,0.92)';
    mmCtx.fillRect(0, 0, W, H);
    
    mmCtx.strokeStyle = 'rgba(100,90,50,0.5)';
    mmCtx.lineWidth = 1.5;
    mmCtx.strokeRect(1, 1, W-2, H-2);

    // Last 30s of HUNT: tint map quadrants that still hide a prop (coarse reveal, no exact position).
    if (myRole === 'hunter' && G.phase === 'HUNT' && G.phaseEndsAt) {
        const remaining = G.phaseEndsAt - Date.now();
        if (remaining > 0 && remaining <= 30000) {
            const halfW = G.mapSize.w / 2;
            const halfH = G.mapSize.h / 2;
            const quadrants = [false, false, false, false]; // TL, TR, BL, BR
            for (const p of Object.values(G.players)) {
                if (p.role !== 'prop' || p.eliminated) continue;
                const qx = p.x < halfW ? 0 : 1;
                const qy = p.y < halfH ? 0 : 1;
                quadrants[qy * 2 + qx] = true;
            }
            mmCtx.save();
            const pulse = 0.5 + 0.35 * Math.sin(Date.now() / 220);
            quadrants.forEach((active, i) => {
                if (!active) return;
                const qx = (i % 2) * (W / 2);
                const qy = Math.floor(i / 2) * (H / 2);
                mmCtx.globalAlpha = pulse;
                mmCtx.fillStyle = 'rgba(255, 180, 0, 0.45)';
                mmCtx.fillRect(qx, qy, W / 2, H / 2);
                mmCtx.globalAlpha = 1;
                mmCtx.strokeStyle = 'rgba(255, 210, 80, 0.8)';
                mmCtx.lineWidth = 1.5;
                mmCtx.strokeRect(qx, qy, W / 2, H / 2);
            });
            mmCtx.restore();
        }
    }

    mmCtx.fillStyle = 'rgba(100,90,50,0.4)';
    for (const p of G.props) {
        mmCtx.fillRect(p.x * sx - 1, p.y * sy - 1, 2.2, 2.2);
    }

    for (const [id, p] of Object.entries(G.players)) {
        if (p.eliminated) continue;
        if (myRole === 'hunter' && p.role === 'prop' && id !== localPlayerId) {
            let revealedByDrone = false;
            if (G.droneZone) {
                const dx = p.x - G.droneZone.x;
                const dy = p.y - G.droneZone.y;
                if (dx * dx + dy * dy < G.droneZone.radius * G.droneZone.radius) {
                    revealedByDrone = true;
                }
            }
            if (!revealedByDrone) continue;
        }
        if (myRole === 'prop' && p.role === 'hunter' && id !== localPlayerId) continue;
        const px = p.x * sx;
        const py = p.y * sy;
        let col = '#50c878';
        if (id === localPlayerId) {
            col = '#f0d060';
        } else if (id === hunterId) {
            col = '#e05030';
        }
        mmCtx.fillStyle = col;
        mmCtx.beginPath();
        mmCtx.arc(px, py, 3, 0, Math.PI * 2);
        mmCtx.fill();
    }

    const camLeft = G.cam.x;
    const camTop = G.cam.y;
    const camRight = camLeft + canvas.width / G.cam.scale;
    const camBottom = camTop + canvas.height / G.cam.scale;
    mmCtx.strokeStyle = 'rgba(200,180,100,0.35)';
    mmCtx.lineWidth = 1.2;
    mmCtx.strokeRect(camLeft * sx, camTop * sy, (camRight - camLeft) * sx, (camBottom - camTop) * sy);
}

function updateHunterCamera() {
    let target = G.players[localPlayerId];
    if (!target || target.eliminated) {
        const alivePlayers = Object.entries(G.players).filter(([id, p]) => p.role === 'prop' && !p.eliminated).map(([id, p]) => p);
        if (alivePlayers.length > 0) {
            let spectateTarget = G.players[spectateTargetId];
            if (!spectateTarget || spectateTarget.eliminated) {
                spectateTarget = alivePlayers[0];
                spectateTargetId = Object.keys(G.players).find(k => G.players[k] === spectateTarget);
            }
            target = spectateTarget;
            
            const specOverlay = document.getElementById('spectatorOverlay');
            if (specOverlay) {
                specOverlay.classList.remove('hidden');
                const pInfo = G.players[spectateTargetId];
                const targetName = spectateTargetId.startsWith('bot_') ? `🤖 BOT ${pInfo ? pInfo.num : ''}` : `👤 PLAYER ${pInfo ? pInfo.num : ''}`;
                specOverlay.querySelector('.spectator-msg').innerHTML = `⚡ SPECTATING MODE<br><span style="color: var(--pink); font-size: 1.25em; text-shadow: 0 0 10px var(--pink); font-weight: 800;">${targetName}</span><br><span style="font-size: 0.7em; opacity: 0.65; letter-spacing: 1px;">[CLICK / SPACE / ARROWS TO CYCLE]</span>`;
            }
        } else {
            target = null;
            const specOverlay = document.getElementById('spectatorOverlay');
            if (specOverlay) {
                specOverlay.classList.remove('hidden');
                specOverlay.querySelector('.spectator-msg').innerHTML = `⚡ SPECTATING MODE<br><span style="color: #666; font-size: 1.1em;">NO SURVIVORS REMAINING</span>`;
            }
        }
    } else {
        const specOverlay = document.getElementById('spectatorOverlay');
        if (specOverlay) specOverlay.classList.add('hidden');
    }

    if (!target) return;

    G.cam.scale = Math.min(canvas.width / 900, canvas.height / 700, 1.4);

    const targetId = Object.keys(G.players).find(id => G.players[id] === target);
    const ip = (targetId && interpolatedPlayers[targetId]) ? interpolatedPlayers[targetId] : target;

    const targetCamX = ip.x - canvas.width / (2 * G.cam.scale);
    const targetCamY = ip.y - canvas.height / (2 * G.cam.scale);

    G.cam.x += (targetCamX - G.cam.x) * LERP_FACTOR;
    G.cam.y += (targetCamY - G.cam.y) * LERP_FACTOR;

    G.cam.x = Math.max(0, Math.min(G.mapSize.w - canvas.width / G.cam.scale, G.cam.x));
    G.cam.y = Math.max(0, Math.min(G.mapSize.h - canvas.height / G.cam.scale, G.cam.y));
}

function renderHunter() {
    // Update interpolated coordinates for all players
    for (const [id, p] of Object.entries(G.players)) {
        if (p.x === undefined || p.y === undefined) continue;

        if (!interpolatedPlayers[id] || isNaN(interpolatedPlayers[id].x) || isNaN(interpolatedPlayers[id].y)) {
            interpolatedPlayers[id] = {
                x: p.x,
                y: p.y,
                angle: p.angle || 0,
                disguiseAngle: p.disguiseAngle || 0
            };
        } else {
            const ip = interpolatedPlayers[id];
            ip.x += (p.x - ip.x) * 0.3;
            ip.y += (p.y - ip.y) * 0.3;

            let diffAngle = (p.angle || 0) - ip.angle;
            while (diffAngle < -Math.PI) diffAngle += Math.PI * 2;
            while (diffAngle > Math.PI) diffAngle -= Math.PI * 2;
            ip.angle += diffAngle * 0.3;

            let diffDA = (p.disguiseAngle || 0) - ip.disguiseAngle;
            while (diffDA < -Math.PI) diffDA += Math.PI * 2;
            while (diffDA > Math.PI) diffDA -= Math.PI * 2;
            ip.disguiseAngle += diffDA * 0.3;
        }
    }

    // Cleanup disconnected players
    for (const id in interpolatedPlayers) {
        if (!G.players[id]) {
            delete interpolatedPlayers[id];
        }
    }

    updateHunterCamera();
    drawHunterBackground();

    // Draw teleporters on top of background but under Y-sorted entities
    ctx.save();
    ctx.scale(G.cam.scale, G.cam.scale);
    ctx.translate(-G.cam.x, -G.cam.y);
    drawTeleporters();
    ctx.restore();

    ctx.save();
    ctx.scale(G.cam.scale, G.cam.scale);
    ctx.translate(-G.cam.x, -G.cam.y);

    // Base layer: real props, doors, and disguised ghosts (Y-sorted for depth)
    // Top layer: non-disguised players including hunter (always above props)
    const baseElements = [];
    const topElements  = [];

    const showProps = (G.phase === 'HUNT') ||
                      (G.phase === 'RECON' && myRole === 'hunter') ||
                      (G.phase === 'CACHE' && myRole === 'prop');
    if (showProps) {
        for (const p of G.props) {
            // Hide original prop if possessed by an active player standing right on it
            const isPossessed = Object.entries(G.players).some(([id, pl]) => {
                if (!pl.disguised || pl.possessedPropId !== p.id || pl.eliminated) return false;
                const ip = interpolatedPlayers[id] || pl;
                return Math.hypot(ip.x - p.x, ip.y - p.y) < 8;
            });
            if (!isPossessed) {
                baseElements.push({ type: 'prop', y: p.y, data: p });
            }
        }
    }

    // Draw confinement doors if in Depot Alpha map
    if (G.theme === 'Depot Alpha' && G.doors) {
        for (const door of G.doors) {
            baseElements.push({ type: 'door', y: door.y, data: door });
        }
    }

    for (const [id, p] of Object.entries(G.players)) {
        const ip = interpolatedPlayers[id] || p;
        const renderData = {
            ...p,
            x: ip.x,
            y: ip.y,
            angle: ip.angle,
            disguiseAngle: ip.disguiseAngle
        };

        if (myRole === 'hunter' && p.disguised && id !== localPlayerId) {
            // Disguised ghosts blend into the base prop layer for correct depth sorting
            baseElements.push({
                type: 'prop',
                y: ip.y,
                data: { ...renderData, type: p.disguiseType, angle: ip.disguiseAngle, radius: p.disguiseRadius || 22, animated: false }
            });
        } else {
            // All visible players (hunter + undisguised ghosts) always render on top
            topElements.push({ type: 'player', y: ip.y, id, data: renderData });
        }
    }

    baseElements.sort((a, b) => a.y - b.y);
    topElements.sort((a, b) => a.y - b.y);

    for (const ent of baseElements) {
        if (ent.type === 'prop') {
            drawHunterProp(ent.data, 1.0);
        } else if (ent.type === 'door') {
            drawDoorShape(ent.data);
        }
    }
    for (const ent of topElements) {
        drawHunterPlayer(ent.id, ent.data);
    }

    drawHunterEffects();
    drawDeathParticles(G.cam.x, G.cam.y, G.cam.scale);

    ctx.restore();

    // Heartbeat beep system for local hunter
    const now = Date.now();
    if (myRole === 'hunter' && G.phase === 'HUNT') {
        if (now >= nextHeartbeatBeepTime) {
            let closestDist = Infinity;
            const me = G.players[localPlayerId];
            if (me) {
                for (const [id, p] of Object.entries(G.players)) {
                    if (p.role === 'prop' && !p.eliminated) {
                        const dx = p.x - me.x;
                        const dy = p.y - me.y;
                        const dist = Math.sqrt(dx * dx + dy * dy);
                        if (dist < closestDist) closestDist = dist;
                    }
                }
            }

            if (closestDist !== Infinity) {
                const maxProximity = 1200;
                const minProximity = 100;
                const vol = Math.max(0.05, Math.min(1.0, 1 - (closestDist - minProximity) / (maxProximity - minProximity)));
                playHeartbeatBeep(vol);

                const remaining = Math.max(0, G.phaseEndsAt - now);
                const totalDuration = 240000;
                const progress = 1 - (remaining / totalDuration);
                
                let minInterval = 15000;
                let maxInterval = 20000;
                if (progress > 0.85) {
                    minInterval = 3000;
                    maxInterval = 5000;
                } else if (progress > 0.5) {
                    minInterval = 8000;
                    maxInterval = 12000;
                } else {
                    const t = progress / 0.5;
                    minInterval = 15000 - t * 7000;
                    maxInterval = 20000 - t * 8000;
                }
                const nextDelay = minInterval + Math.random() * (maxInterval - minInterval);
                nextHeartbeatBeepTime = now + nextDelay;
            } else {
                nextHeartbeatBeepTime = now + 5000;
            }
        }
    }

    drawHunterMinimap();
    updateTimerHUD();
    updateGhostIndicators();
    updateProximityHint();

    if (now - lastInputSent > 50) {
        lastInputSent = now;
        if (socket) socket.emit('hunterInput', keys);
    }

    requestAnimationFrame(renderLoop);
}

function renderLoop() {
    applyShake();
    if (roomType === 'hunter') {
        if (G.state === 'LOBBY') return;
        renderHunter();
        return;
    }
    if (hud.style.display !== 'block' && gameOverMenu.classList.contains('hidden')) return;

    // Compute frame delta time and update the countdown smoothly locally
    const clientNow = performance.now();
    const frameDt = clientNow - clientLastTime;
    clientLastTime = clientNow;

    if (!classicEndGameTriggered && classicEndGameCountdownRemaining > 0) {
        classicEndGameCountdownRemaining = Math.max(0, classicEndGameCountdownRemaining - frameDt);
    }

    // Update classic timer in HUD
    const timerEl = document.getElementById('classicTimer');
    if (timerEl) {
        const endgameSec = Math.ceil((classicEndGameCountdownRemaining || 0) / 1000);
        let timeStr = '';
        if (classicEndGameTriggered) {
            if (classicEndGameMode === 'STORM') {
                timeStr = (currentLang === 'en') ? 'STORM ACTIVE!' : 'TEMPÊTE ACTIVE !';
                timerEl.style.color = 'var(--pink)';
            } else if (classicEndGameMode === 'TEMPETE') {
                timeStr = (currentLang === 'en') ? 'TEMPEST ACTIVE!' : 'TEMPÊTE ACTIVE !';
                timerEl.style.color = 'var(--pink)';
            } else if (classicEndGameMode === 'FREEZE') {
                timeStr = (currentLang === 'en') ? 'BOTS FROZEN!' : 'BOTS FIGÉS !';
                timerEl.style.color = '#ffff00';
            } else if (classicEndGameMode === 'GEL') {
                timeStr = (currentLang === 'en') ? 'BOTS FROZEN!' : 'BOTS FIGÉS !';
                timerEl.style.color = '#88eeff';
            } else if (classicEndGameMode === 'PURGE') {
                timeStr = (currentLang === 'en') ? 'PURGE ACTIVE!' : 'PURGE ACTIVE !';
                timerEl.style.color = '#ffaa00';
            } else if (classicEndGameMode === 'DISPARITION') {
                timeStr = (currentLang === 'en') ? 'VANISHING...' : 'DISPARITION...';
                timerEl.style.color = '#ff6600';
            }
        } else if (endgameSec > 0) {
            timerEl.style.color = 'var(--green)';
            if (classicEndGameMode === 'STORM') {
                timeStr = ((currentLang === 'en') ? 'STORM IN: ' : 'ZONE DANS : ') + endgameSec + 's';
            } else if (classicEndGameMode === 'TEMPETE') {
                timeStr = ((currentLang === 'en') ? 'TEMPEST IN: ' : 'TEMPÊTE DANS : ') + endgameSec + 's';
            } else if (classicEndGameMode === 'FREEZE') {
                timeStr = ((currentLang === 'en') ? 'FREEZE IN: ' : 'GEL DANS : ') + endgameSec + 's';
            } else if (classicEndGameMode === 'GEL') {
                timeStr = ((currentLang === 'en') ? 'CRYO-GEL IN: ' : 'GEL DANS : ') + endgameSec + 's';
            } else if (classicEndGameMode === 'PURGE') {
                timeStr = ((currentLang === 'en') ? 'PURGE IN: ' : 'PURGE DANS : ') + endgameSec + 's';
            } else if (classicEndGameMode === 'DISPARITION') {
                timeStr = ((currentLang === 'en') ? 'VANISH IN: ' : 'DISPARITION DANS : ') + endgameSec + 's';
            }
        }
        timerEl.textContent = timeStr;
    }

    // --- Interpolation update ---
    // Build active ID set in one pass (no intermediate array)
    const activeIds = new Set();
    for (const se of latestServerEntities) activeIds.add(se.id);

    // Remove stale entities
    for (const id in interpolatedEntities) {
        if (!activeIds.has(id)) delete interpolatedEntities[id];
    }

    for (const serverEnt of latestServerEntities) {
        let localEnt = interpolatedEntities[serverEnt.id];
        if (!localEnt) {
            localEnt = { ...serverEnt, targetX: serverEnt.x, targetY: serverEnt.y, targetAngle: serverEnt.angle };
            interpolatedEntities[serverEnt.id] = localEnt;
        } else {
            localEnt.targetX = serverEnt.x;
            localEnt.targetY = serverEnt.y;
            localEnt.targetAngle = serverEnt.angle;
            localEnt.vx = serverEnt.vx;
            localEnt.vy = serverEnt.vy;
            localEnt.avatarType = serverEnt.avatarType;
            localEnt.color = serverEnt.color;
            localEnt.isRevealed = serverEnt.isRevealed;
            localEnt.inBush = serverEnt.inBush;
            localEnt.isPlayer = serverEnt.isPlayer;
            localEnt.size = serverEnt.size;
        }
    }

    gameState = Object.values(interpolatedEntities);
    // Higher lerp factor = snappier feel (compensates for 20fps server send rate)
    for (const ent of gameState) {
        ent.x += (ent.targetX - ent.x) * 0.35;
        ent.y += (ent.targetY - ent.y) * 0.35;
        let diff = ent.targetAngle - ent.angle;
        if (diff > Math.PI) diff -= Math.PI * 2;
        else if (diff < -Math.PI) diff += Math.PI * 2;
        ent.angle += diff * 0.3;
    }

    // Sort entities by Y for pseudo-3D depth
    gameState.sort((a, b) => a.y - b.y);

    // Camera update (cache half sizes)
    const hw = canvas.width >> 1;
    const hh = canvas.height >> 1;
    let targetEnt = gameState.find(e => e.id === localPlayerId);
    const myLives = (playersInfo[localPlayerId] && playersInfo[localPlayerId].lives !== undefined) ? playersInfo[localPlayerId].lives : 3;
    if (!targetEnt || myLives <= 0) {
        const alivePlayers = gameState.filter(e => e.isPlayer && playersInfo[e.id] && playersInfo[e.id].lives > 0);
        if (alivePlayers.length > 0) {
            let target = alivePlayers.find(e => e.id === spectateTargetId);
            if (!target) {
                target = alivePlayers[0];
                spectateTargetId = target.id;
            }
            targetEnt = target;

            // Update spectator overlay message dynamically
            const pInfo = playersInfo[spectateTargetId];
            const targetName = spectateTargetId.startsWith('bot_player_') ? (targetEnt.name || `🤖 BOT ${pInfo ? pInfo.num : ''}`) : `👤 PLAYER ${pInfo ? pInfo.num : ''}`;
            const targetLives = pInfo ? pInfo.lives : 0;
            document.querySelector('#spectatorOverlay .spectator-msg').innerHTML = `⚡ SPECTATING MODE<br><span style="color: var(--pink); font-size: 1.25em; text-shadow: 0 0 10px var(--pink); font-weight: 800;">${targetName}</span><br>LIVES LEFT: ${targetLives}<br><span style="font-size: 0.7em; opacity: 0.65; letter-spacing: 1px;">[CLICK / SPACE / ARROWS TO CYCLE]</span>`;
        } else {
            targetEnt = null;
            document.querySelector('#spectatorOverlay .spectator-msg').innerHTML = `⚡ SPECTATING MODE<br><span style="color: #666; font-size: 1.1em;">NO SURVIVORS REMAINING</span>`;
        }
    }
    if (targetEnt) {
        CAMERA.x += (targetEnt.x - hw - CAMERA.x) * LERP_FACTOR;
        CAMERA.y += (targetEnt.y - hh - CAMERA.y) * LERP_FACTOR;
    }
    CAMERA.x = Math.max(0, Math.min(MAP_SIZE.w - canvas.width, CAMERA.x));
    CAMERA.y = Math.max(0, Math.min(MAP_SIZE.h - canvas.height, CAMERA.y));

    // Frustum bounds (screen-space in world coords, with margin)
    const MARGIN = 100;
    const vLeft   = CAMERA.x - MARGIN;
    const vRight  = CAMERA.x + canvas.width + MARGIN;
    const vTop    = CAMERA.y - MARGIN;
    const vBottom = CAMERA.y + canvas.height + MARGIN;

    drawEnvironment();

    // Draw Storm Zone inside camera view for classic mode
    if ((classicEndGameMode === 'STORM' || classicEndGameMode === 'TEMPETE') && classicEndGameTriggered) {
        ctx.save();
        ctx.translate(-CAMERA.x, -CAMERA.y);
        const cx = MAP_SIZE.w / 2;
        const cy = MAP_SIZE.h / 2;
        ctx.fillStyle = 'rgba(150, 0, 0, 0.25)';
        ctx.beginPath();
        ctx.rect(0, 0, MAP_SIZE.w, MAP_SIZE.h);
        ctx.arc(cx, cy, classicStormRadius, 0, Math.PI * 2, true);
        ctx.fill();

        ctx.strokeStyle = 'rgba(255, 0, 100, 0.8)';
        ctx.lineWidth = 6;
        ctx.shadowColor = 'rgba(255, 0, 100, 0.9)';
        ctx.shadowBlur = 15;
        ctx.beginPath();
        ctx.arc(cx, cy, classicStormRadius, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
    }

    ctx.save();
    ctx.translate(-CAMERA.x, -CAMERA.y);

    // Draw visual tags
    const now = Date.now();
    ctx.lineWidth = 4;
    for (let i = 0; i < tagEffects.length; i++) {
        const eff = tagEffects[i];
        const age = now - eff.time;
        if (age > 300) continue; // Effect duration 300ms

        const opacity = 1 - (age / 300);

        // Find shooter in current gameState to draw bullet tracer line
        const shooter = gameState.find(e => e.id === eff.by);
        if (shooter) {
            ctx.save();
            ctx.beginPath();
            ctx.moveTo(shooter.x, shooter.y);
            ctx.lineTo(eff.x, eff.y);
            
            // Class-specific tracer styles
            const aType = shooter.avatarType;
            if (aType === 'Combat-Operative' || aType === 'Sentry-Mech') {
                ctx.strokeStyle = `rgba(0, 255, 170, ${opacity * 0.7})`;
                ctx.lineWidth = 2.5;
            } else if (aType === 'Stealth-Sniper' || aType === 'Stealth-Agent') {
                ctx.strokeStyle = `rgba(255, 51, 51, ${opacity * 0.9})`;
                ctx.lineWidth = 1.2;
            } else if (aType === 'Heavy-Gunner' || aType === 'Spring-Runner') {
                ctx.strokeStyle = `rgba(255, 170, 0, ${opacity * 1.2})`;
                ctx.lineWidth = 4.5;
            } else { // Recon-Drone / Spider-Core
                ctx.strokeStyle = `rgba(0, 200, 255, ${opacity * 0.7})`;
                ctx.lineWidth = 2;
            }
            ctx.stroke();
            ctx.restore();
        }

        // Expanding impact circle
        const maxRad = 40;
        const rad = (age / 300) * maxRad;

        ctx.beginPath();
        ctx.arc(eff.x, eff.y, rad, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 51, 51, ${opacity})`;
        ctx.stroke();

        // Crosshair shape
        ctx.beginPath();
        ctx.moveTo(eff.x - 20, eff.y);
        ctx.lineTo(eff.x + 20, eff.y);
        ctx.moveTo(eff.x, eff.y - 20);
        ctx.lineTo(eff.x, eff.y + 20);
        ctx.stroke();
    }
    tagEffects = tagEffects.filter(e => now - e.time <= 300);

    // Draw hit feedback effects (hunter visual confirmation)
    for (let i = 0; i < hitFeedbackEffects.length; i++) {
        const eff = hitFeedbackEffects[i];
        const age = now - eff.time;
        if (age > 500) continue; // Longer duration for visibility

        const opacity = 1 - (age / 500);
        
        // Different colors based on hit type
        let color, size;
        if (eff.type === 'player') {
            color = 'rgba(255, 50, 50, ' + opacity + ')'; // RED - hit player
            size = 60;
        } else if (eff.type === 'decoy') {
            color = 'rgba(255, 200, 50, ' + opacity + ')'; // YELLOW - hit decoy
            size = 40;
        } else {
            color = 'rgba(150, 150, 150, ' + opacity + ')'; // GRAY - miss
            size = 30;
        }
        
        // Draw expanding circle
        const progress = age / 500;
        const rad = progress * size;
        
        ctx.beginPath();
        ctx.arc(eff.x, eff.y, rad, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        
        // Draw inner pulse ring
        if (eff.type === 'player') {
            ctx.beginPath();
            ctx.arc(eff.x, eff.y, rad * 0.6, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255, 255, 255, ' + opacity * 0.8 + ')';
            ctx.lineWidth = 3;
            ctx.stroke();
            
            // Draw heart icon for player hit
            ctx.beginPath();
            ctx.moveTo(eff.x - 8, eff.y - 5);
            ctx.bezierCurveTo(eff.x - 12, eff.y - 12, eff.x, eff.y - 15, eff.x, eff.y - 8);
            ctx.bezierCurveTo(eff.x, eff.y - 1, eff.x + 12, eff.y - 12, eff.x + 8, eff.y - 5);
            ctx.bezierCurveTo(eff.x + 4, eff.y, eff.x, eff.y + 5, eff.x, eff.y + 5);
            ctx.bezierCurveTo(eff.x, eff.y + 5, eff.x - 4, eff.y, eff.x - 8, eff.y - 5);
            ctx.fillStyle = 'rgba(255, 255, 255, ' + opacity + ')';
            ctx.fill();
        } else if (eff.type === 'decoy') {
            // Draw X for decoy hit
            ctx.beginPath();
            ctx.moveTo(eff.x - 15, eff.y - 15);
            ctx.lineTo(eff.x + 15, eff.y + 15);
            ctx.moveTo(eff.x + 15, eff.y - 15);
            ctx.lineTo(eff.x - 15, eff.y + 15);
            ctx.strokeStyle = 'rgba(200, 100, 0, ' + opacity + ')';
            ctx.lineWidth = 3;
            ctx.stroke();
        }
    }
    hitFeedbackEffects = hitFeedbackEffects.filter(e => now - e.time <= 500);

    // Draw Items
    for (const item of itemsState) {
        ctx.save();
        ctx.translate(item.x, item.y);

        // Pulsating effect for items
        const pulse = 1 + Math.sin(now * 0.01) * 0.2;
        ctx.scale(pulse, pulse);

        if (item.type === 'HEART') {
            // Military Medkit (Olive Drab box, white circle decal, flat red cross)
            ctx.fillStyle = '#3c4e3c';
            ctx.strokeStyle = '#1b251b';
            ctx.lineWidth = 2.5;
            ctx.beginPath();
            ctx.roundRect(-15, -12, 30, 24, 4);
            ctx.fill(); ctx.stroke();

            // White circle emblem backing
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(0, 0, 7, 0, Math.PI*2);
            ctx.fill();

            // Flat tactical red cross
            ctx.fillStyle = '#d9534f';
            ctx.fillRect(-2, -5, 4, 10);
            ctx.fillRect(-5, -2, 10, 4);
        } else if (item.type === 'SHAPESHIFT') {
            // Military Manila Intel Folder
            ctx.fillStyle = '#c5a059';
            ctx.strokeStyle = '#85642a';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.roundRect(-14, -10, 28, 20, 2);
            ctx.fill(); ctx.stroke();

            // Folder tab
            ctx.beginPath();
            ctx.rect(-14, -13, 10, 3);
            ctx.fill(); ctx.stroke();

            // Stencil black star details inside
            ctx.fillStyle = '#1c1f1a';
            
            // Draw a quick 5-point star
            const drawStar = (cx, cy, spikes, outerRadius, innerRadius) => {
                let rot = Math.PI / 2 * 3;
                let x = cx;
                let y = cy;
                let step = Math.PI / spikes;

                ctx.beginPath();
                ctx.moveTo(cx, cy - outerRadius);
                for (let i = 0; i < spikes; i++) {
                    x = cx + Math.cos(rot) * outerRadius;
                    y = cy + Math.sin(rot) * outerRadius;
                    ctx.lineTo(x, y);
                    rot += step;

                    x = cx + Math.cos(rot) * innerRadius;
                    y = cy + Math.sin(rot) * innerRadius;
                    ctx.lineTo(x, y);
                    rot += step;
                }
                ctx.lineTo(cx, cy - outerRadius);
                ctx.closePath();
                ctx.fill();
            };
            drawStar(0, 1, 5, 5, 2.2);
        }
        ctx.restore();
    }

    // Draw Pickup Texts
    for (let i = 0; i < pickupEffects.length; i++) {
        const pEff = pickupEffects[i];
        const age = now - pEff.time;
        if (age > 1000) continue;

        const opacity = 1 - (age / 1000);
        const floatY = pEff.y - (age / 1000) * 40 - 20;

        ctx.save();
        ctx.fillStyle = pEff.color;
        ctx.globalAlpha = opacity;
        ctx.font = 'bold 20px poppins, sans-serif';
        ctx.textAlign = 'center';
        ctx.shadowColor = pEff.color;
        ctx.shadowBlur = 10;
        ctx.fillText(pEff.text, pEff.x, floatY);
        ctx.restore();
    }
    pickupEffects = pickupEffects.filter(e => now - e.time <= 1000);

    // Draw Decorations BEHIND entities — with frustum culling
    for (const dec of decorations) {
        // Skip decorations outside the screen
        if (dec.x + dec.radius < vLeft || dec.x - dec.radius > vRight ||
            dec.y + dec.radius < vTop  || dec.y - dec.radius > vBottom) continue;

        ctx.save();
        ctx.translate(dec.x, dec.y);
        
        if (theme === "Military Base" || theme === "Forest" || theme === "Arcade Grid") {
            if (dec.type === 'ROCK') {
                // Military Cargo Container (3D Isometric crate)
                const r = dec.radius;
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = '#22291d';

                // Left face (dark shaded olive)
                ctx.fillStyle = '#2f3d26';
                ctx.beginPath();
                ctx.moveTo(-r, -r*0.2);
                ctx.lineTo(-r, r*0.6);
                ctx.lineTo(0, r*0.9);
                ctx.lineTo(0, r*0.1);
                ctx.closePath();
                ctx.fill(); ctx.stroke();

                // Right face (medium shaded olive)
                ctx.fillStyle = '#425537';
                ctx.beginPath();
                ctx.moveTo(0, r*0.1);
                ctx.lineTo(0, r*0.9);
                ctx.lineTo(r, r*0.6);
                ctx.lineTo(r, -r*0.2);
                ctx.closePath();
                ctx.fill(); ctx.stroke();

                // Top face (light olive)
                ctx.fillStyle = '#556b46';
                ctx.beginPath();
                ctx.moveTo(-r, -r*0.2);
                ctx.lineTo(0, -r*0.5);
                ctx.lineTo(r, -r*0.2);
                ctx.lineTo(0, r*0.1);
                ctx.closePath();
                ctx.fill(); ctx.stroke();

                // Crates lines / bracing
                ctx.strokeStyle = '#22291d';
                ctx.lineWidth = 2;
                // Draw X bracing on side panels
                ctx.beginPath();
                ctx.moveTo(-r*0.8, -r*0.05); ctx.lineTo(-r*0.2, r*0.7);
                ctx.moveTo(-r*0.2, -r*0.05); ctx.lineTo(-r*0.8, r*0.7);
                ctx.moveTo(r*0.8, -r*0.05); ctx.lineTo(r*0.2, r*0.7);
                ctx.moveTo(r*0.2, -r*0.05); ctx.lineTo(r*0.8, r*0.7);
                ctx.stroke();

                // Text stencils
                ctx.fillStyle = 'rgba(255,255,255,0.45)';
                ctx.font = '8px Arial';
                ctx.fillText("MIL-A1", -r*0.6, r*0.1);

            } else if (dec.type === 'BUSH') {
                // Ground shadow and pole stands for Camouflage Netting
                const r = dec.radius;
                drawGroundShadow(ctx, 0, 0, r);
                
                // Support poles (metal rods at corners)
                ctx.fillStyle = '#3a3d45';
                ctx.strokeStyle = '#1a1b1e';
                ctx.lineWidth = 1;
                for (let angle of [-Math.PI*0.75, -Math.PI*0.25, Math.PI*0.25, Math.PI*0.75]) {
                    const px = Math.cos(angle) * r * 0.75;
                    const py = Math.sin(angle) * r * 0.75;
                    ctx.beginPath();
                    ctx.arc(px, py, 3, 0, Math.PI*2);
                    ctx.fill(); ctx.stroke();
                }
            }
        } 
        else if (theme === "Weapon Warehouse" || theme === "Cave" || theme === "Toy Factory") {
            if (dec.type === 'ROCK') {
                // Munitions / Hazard Crate
                const r = dec.radius;
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = '#2d1804';

                // Isometric wooden ammunition box
                // Left
                ctx.fillStyle = '#5c4033';
                ctx.beginPath();
                ctx.moveTo(-r, -r*0.2);
                ctx.lineTo(-r, r*0.6);
                ctx.lineTo(0, r*0.9);
                ctx.lineTo(0, r*0.1);
                ctx.closePath();
                ctx.fill(); ctx.stroke();

                // Right
                ctx.fillStyle = '#7c5843';
                ctx.beginPath();
                ctx.moveTo(0, r*0.1);
                ctx.lineTo(0, r*0.9);
                ctx.lineTo(r, r*0.6);
                ctx.lineTo(r, -r*0.2);
                ctx.closePath();
                ctx.fill(); ctx.stroke();

                // Top
                ctx.fillStyle = '#9c7056';
                ctx.beginPath();
                ctx.moveTo(-r, -r*0.2);
                ctx.lineTo(0, -r*0.5);
                ctx.lineTo(r, -r*0.2);
                ctx.lineTo(0, r*0.1);
                ctx.closePath();
                ctx.fill(); ctx.stroke();

                // Warning Label badge on the front
                ctx.fillStyle = '#ffaa00';
                ctx.beginPath();
                ctx.moveTo(-r*0.4, r*0.2);
                ctx.lineTo(-r*0.2, r*0.1);
                ctx.lineTo(0, r*0.2);
                ctx.lineTo(-r*0.2, r*0.3);
                ctx.closePath();
                ctx.fill();

                ctx.fillStyle = '#000';
                ctx.font = 'bold 6px Courier';
                ctx.fillText("TNT", -r*0.35, r*0.23);

            } else if (dec.type === 'BUSH') {
                const r = dec.radius;
                drawGroundShadow(ctx, 0, 0, r);
            }
        } 
        else if (theme === "Command Center" || theme === "Desert" || theme === "Micro-Circuit") {
            if (dec.type === 'ROCK') {
                // High-tech Mainframe / Server Column
                const r = dec.radius;
                ctx.lineWidth = 1.5;
                ctx.strokeStyle = '#0f2b3b';

                // Isometric Server Tower
                // Left
                ctx.fillStyle = '#0a0d14';
                ctx.beginPath();
                ctx.moveTo(-r, -r*0.2);
                ctx.lineTo(-r, r*0.6);
                ctx.lineTo(0, r*0.9);
                ctx.lineTo(0, r*0.1);
                ctx.closePath();
                ctx.fill(); ctx.stroke();

                // Right
                ctx.fillStyle = '#101622';
                ctx.beginPath();
                ctx.moveTo(0, r*0.1);
                ctx.lineTo(0, r*0.9);
                ctx.lineTo(r, r*0.6);
                ctx.lineTo(r, -r*0.2);
                ctx.closePath();
                ctx.fill(); ctx.stroke();

                // Top
                ctx.fillStyle = '#1b2234';
                ctx.beginPath();
                ctx.moveTo(-r, -r*0.2);
                ctx.lineTo(0, -r*0.5);
                ctx.lineTo(r, -r*0.2);
                ctx.lineTo(0, r*0.1);
                ctx.closePath();
                ctx.fill(); ctx.stroke();

                // Blinking server LEDs
                const flash = Math.floor(Date.now() / 200) % 2 === 0;
                ctx.fillStyle = flash ? '#00ffaa' : '#003322';
                ctx.beginPath();
                ctx.arc(r*0.3, r*0.2, 2, 0, Math.PI*2);
                ctx.arc(r*0.3, r*0.35, 2, 0, Math.PI*2);
                ctx.fill();

                ctx.fillStyle = !flash ? '#ff3333' : '#330000';
                ctx.beginPath();
                ctx.arc(r*0.6, r*0.2, 2, 0, Math.PI*2);
                ctx.fill();

                ctx.fillStyle = 'rgba(0, 255, 170, 0.4)';
                ctx.font = '6px monospace';
                ctx.fillText("SRV-90", -r*0.7, r*0.15);

            } else if (dec.type === 'BUSH') {
                const r = dec.radius;
                drawGroundShadow(ctx, 0, 0, r);
            }
        
        }
        ctx.restore();
    }

    // Draw Entities (with frustum culling)
    for (const ent of gameState) {
        // Skip if outside viewport
        const entR = ent.size + 60;
        if (ent.x + entR < vLeft || ent.x - entR > vRight ||
            ent.y + entR < vTop  || ent.y - entR > vBottom) continue;

        const isMoving = ent.vx * ent.vx + ent.vy * ent.vy > 0.01;

        const isSpectatingThis = (myLives <= 0 && ent.id === spectateTargetId);
        ctx.globalAlpha = (ent.inBush) ? ((ent.id === localPlayerId || isSpectatingThis) ? 0.5 : 0) : 1;

        if (ent.isRevealed) {
            ctx.save();
            ctx.translate(ent.x, ent.y);
            
            // Draw exposed scanning ring
            ctx.strokeStyle = 'rgba(217, 83, 79, 0.85)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(0, 0, ent.size + 10, 0, Math.PI * 2);
            ctx.stroke();

            // Draw target crosshair brackets
            const bLen = 10; // bracket line length
            const offset = ent.size + 15;
            ctx.beginPath();
            // Top-left bracket
            ctx.moveTo(-offset, -offset + bLen);
            ctx.lineTo(-offset, -offset);
            ctx.lineTo(-offset + bLen, -offset);
            // Top-right bracket
            ctx.moveTo(offset, -offset + bLen);
            ctx.lineTo(offset, -offset);
            ctx.lineTo(offset - bLen, -offset);
            // Bottom-left bracket
            ctx.moveTo(-offset, offset - bLen);
            ctx.lineTo(-offset, offset);
            ctx.lineTo(-offset + bLen, offset);
            // Bottom-right bracket
            ctx.moveTo(offset, offset - bLen);
            ctx.lineTo(offset, offset);
            ctx.lineTo(offset - bLen, offset);
            ctx.stroke();

            // Text alert DECOY
            ctx.font = "bold 10px 'Share Tech Mono', Courier";
            ctx.fillStyle = '#d9534f';
            ctx.textAlign = 'center';
            ctx.shadowColor = '#d9534f';
            ctx.shadowBlur = 3;
            ctx.fillText("DECOY", 0, ent.size + 28);
            ctx.shadowBlur = 0;

            ctx.restore();
        }

        const inCover = ent.inBush;
        const clipForCover = inCover && ent.id !== localPlayerId && !isSpectatingThis;
        ctx.save();
        if (clipForCover) clipEntityToBushes(ctx, ent.x, ent.y);
        const avatarDrawFn = Avatars[ent.avatarType];
        if (avatarDrawFn) {
            avatarDrawFn(ctx, ent.x, ent.y, ent.size, ent.color, isMoving, ent.angle, inCover);
        }
        ctx.restore();
        ctx.globalAlpha = 1;

        if (ent.id === localPlayerId || isSpectatingThis) {
            // Player or spectated target indicator arrow
            ctx.save();
            ctx.translate(ent.x, ent.y);
            ctx.beginPath();
            ctx.moveTo(0, -ent.size - 20);
            ctx.lineTo(-6, -ent.size - 30);
            ctx.lineTo(6, -ent.size - 30);
            ctx.closePath();
            const indicatorColor = isSpectatingThis ? '#d9534f' : '#8ca885'; // tactical red for spectated target, camo green for self
            ctx.fillStyle = indicatorColor;
            ctx.shadowColor = indicatorColor;
            ctx.shadowBlur = 4;
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.restore();

            if (isSpectatingThis) {
                // Draw name label above the spectated player/bot
                ctx.save();
                ctx.font = "bold 11px 'Share Tech Mono', Courier";
                ctx.fillStyle = '#d9534f';
                ctx.textAlign = 'center';
                ctx.shadowBlur = 0;
                const pInfo = playersInfo[ent.id];
                const nameText = ent.id.startsWith('bot_player_') ? (ent.name || `🤖 BOT ${pInfo ? pInfo.num : ''}`) : `👤 PLAYER ${pInfo ? pInfo.num : ''}`;
                ctx.fillText(nameText, ent.x, ent.y - ent.size - 35);
                ctx.restore();
            }
        }
    }

    // Map rule ping markers (radar / alarm violators)
    if (mapRule === 'radar' || mapRule === 'alarm') {
        for (const ping of mapPings) {
            if (ping.x < vLeft || ping.x > vRight || ping.y < vTop || ping.y > vBottom) continue;
            const blink = Math.floor(now / 180) % 2 === 0;
            ctx.save();
            ctx.translate(ping.x, ping.y);
            ctx.strokeStyle = ping.t === 'r'
                ? `rgba(0, 255, 170, ${blink ? 0.85 : 0.35})`
                : `rgba(255, 34, 68, ${blink ? 0.9 : 0.4})`;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(0, 0, 22 + (now % 400) / 40, 0, Math.PI * 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(0, 0, 6, 0, Math.PI * 2);
            ctx.fillStyle = ping.t === 'r' ? 'rgba(0, 255, 170, 0.6)' : 'rgba(255, 34, 68, 0.7)';
            ctx.fill();
            ctx.restore();
        }
    }

    // Fade bush foliage when targetEnt is standing close enough to be hidden behind it
    function bushAlphaFor(targetEnt, dec, lowAlpha) {
        if (!targetEnt) return 0.98;
        const dx = targetEnt.x - dec.x;
        const dy = targetEnt.y - dec.y;
        const checkRadius = dec.radius * 1.35;
        return (dx * dx + dy * dy < checkRadius * checkRadius) ? lowAlpha : 0.98;
    }

    // Draw Decorations ON TOP of entities (bush foliage, torches) — with frustum culling
    for (const dec of decorations) {
        if (dec.x + dec.radius < vLeft || dec.x - dec.radius > vRight ||
            dec.y + dec.radius < vTop  || dec.y - dec.radius > vBottom) continue;
        ctx.save();
        ctx.translate(dec.x, dec.y);
        
        if (theme === "Military Base" || theme === "Forest" || theme === "Arcade Grid") {
            if (dec.type === 'BUSH') {
                const r = dec.radius;
                const foliageR = r * 1.2;
                ctx.save();
                
                ctx.globalAlpha = bushAlphaFor(targetEnt, dec, 0.38);
                
                ctx.fillStyle = 'rgba(46, 67, 42, 1.0)';
                ctx.beginPath();
                ctx.arc(0, 0, foliageR, 0, Math.PI * 2);
                ctx.fill();
                
                ctx.strokeStyle = 'rgba(15, 25, 12, 1.0)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                for (let d = -foliageR; d <= foliageR; d += 12) {
                    ctx.moveTo(-Math.sqrt(foliageR*foliageR - d*d), d);
                    ctx.lineTo(Math.sqrt(foliageR*foliageR - d*d), d);
                    ctx.moveTo(d, -Math.sqrt(foliageR*foliageR - d*d));
                    ctx.lineTo(d, Math.sqrt(foliageR*foliageR - d*d));
                }
                ctx.stroke();

                const numLeaves = 18;
                const seed = dec.x + 45;
                ctx.fillStyle = '#1c2e1a';
                for (let i = 0; i < numLeaves; i++) {
                    const leafX = Math.sin(seed + i * 33) * foliageR * 0.82;
                    const leafY = Math.cos(seed + i * 59) * foliageR * 0.82;
                    const lRad = 8 + (Math.sin(seed + i) + 1) * 4;
                    ctx.beginPath();
                    ctx.arc(leafX, leafY, lRad, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();

            } else if (dec.type === 'TORCH') {
                // Halogen Spotlight Tower
                const flicker = 0.9 + 0.1 * Math.sin(now * 0.04 + dec.x);
                
                // Metal base stand
                ctx.fillStyle = '#222';
                ctx.fillRect(-6, -8, 12, 22);
                ctx.strokeStyle = '#444';
                ctx.lineWidth = 1;
                ctx.strokeRect(-6, -8, 12, 22);

                // Double spotlight lamp heads
                ctx.fillStyle = '#333';
                ctx.beginPath();
                ctx.arc(-8, -12, 6, 0, Math.PI*2);
                ctx.arc(8, -12, 6, 0, Math.PI*2);
                ctx.fill();

                // Spotlight beam gradient
                const sweepAngle = Math.sin(now * 0.0012 + dec.x) * 0.35 + Math.PI*0.75; // sweeping left/right
                ctx.save();
                ctx.translate(0, -12);
                ctx.rotate(sweepAngle);

                const beamGrad = ctx.createLinearGradient(0, 0, 160, 0);
                beamGrad.addColorStop(0, 'rgba(255, 255, 210, 0.4)');
                beamGrad.addColorStop(0.3, 'rgba(255, 255, 210, 0.18)');
                beamGrad.addColorStop(1, 'rgba(255, 255, 210, 0)');
                
                ctx.fillStyle = beamGrad;
                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.lineTo(160, -35 * flicker);
                ctx.lineTo(160, 35 * flicker);
                ctx.closePath();
                ctx.fill();
                ctx.restore();

                // Bright yellow lamp bulbs
                ctx.fillStyle = '#ffaa00';
                ctx.beginPath();
                ctx.arc(-8, -12, 3 * flicker, 0, Math.PI*2);
                ctx.arc(8, -12, 3 * flicker, 0, Math.PI*2);
                ctx.fill();
            }
        } 
        else if (theme === "Weapon Warehouse" || theme === "Cave" || theme === "Toy Factory") {
            if (dec.type === 'BUSH') {
                const r = dec.radius;
                const foliageR = r * 1.2;
                ctx.save();
                
                ctx.globalAlpha = bushAlphaFor(targetEnt, dec, 0.45);
                
                ctx.fillStyle = 'rgba(30, 32, 38, 1.0)';
                ctx.beginPath();
                ctx.arc(0, 0, foliageR, 0, Math.PI * 2);
                ctx.fill();
                
                ctx.strokeStyle = 'rgba(0, 0, 0, 1.0)';
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                for (let d = -foliageR; d <= foliageR; d += 16) {
                    ctx.moveTo(-Math.sqrt(foliageR*foliageR - d*d), d);
                    ctx.lineTo(Math.sqrt(foliageR*foliageR - d*d), d);
                    ctx.moveTo(d, -Math.sqrt(foliageR*foliageR - d*d));
                    ctx.lineTo(d, Math.sqrt(foliageR*foliageR - d*d));
                }
                ctx.stroke();

                // Safety warning signs draped on net
                ctx.fillStyle = '#d4a317';
                ctx.fillRect(-10, -5, 20, 10);
                ctx.fillStyle = '#000';
                ctx.font = 'bold 5px Arial';
                ctx.fillText("KEEP OUT", -9, 2);

                ctx.restore();

            } else if (dec.type === 'TORCH') {
                // Steam pipeline emergency siren light
                const flicker = 0.85 + 0.15 * Math.sin(now * 0.05 + dec.x);
                
                // Heavy steam pipe backdrop
                ctx.fillStyle = '#555';
                ctx.fillRect(-4, -4, 8, 20);

                // Revolving alarm light
                ctx.fillStyle = '#990000';
                ctx.fillRect(-8, -10, 16, 6);

                // Glowing dome
                ctx.fillStyle = '#ff0033';
                ctx.shadowColor = '#ff0033';
                ctx.shadowBlur = 18 * flicker;
                ctx.beginPath();
                ctx.arc(0, -13, 6, Math.PI, 0);
                ctx.fill();
                ctx.shadowBlur = 0; // reset

                // Double sweeping red rays
                ctx.save();
                ctx.translate(0, -13);
                ctx.rotate(now * 0.008 + dec.x);
                const redGrad = ctx.createLinearGradient(0, 0, 80, 0);
                redGrad.addColorStop(0, 'rgba(255, 0, 50, 0.45)');
                redGrad.addColorStop(1, 'rgba(255, 0, 50, 0)');
                ctx.fillStyle = redGrad;
                ctx.beginPath();
                ctx.moveTo(0, 0);
                ctx.lineTo(80, -15);
                ctx.lineTo(80, 15);
                ctx.closePath();
                ctx.fill();
                ctx.restore();
            }
        } 
        else if (theme === "Command Center" || theme === "Desert" || theme === "Micro-Circuit") {
            if (dec.type === 'BUSH') {
                const r = dec.radius;
                const foliageR = r * 1.2;
                ctx.save();
                
                ctx.globalAlpha = bushAlphaFor(targetEnt, dec, 0.35);
                
                ctx.fillStyle = 'rgba(0, 40, 35, 1.0)';
                ctx.beginPath();
                ctx.arc(0, 0, foliageR, 0, Math.PI * 2);
                ctx.fill();

                ctx.strokeStyle = 'rgba(0, 255, 170, 1.0)';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.arc(0, 0, foliageR, 0, Math.PI * 2);
                ctx.arc(0, 0, foliageR * 0.6, 0, Math.PI * 2);
                ctx.stroke();

                ctx.beginPath();
                for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 4) {
                    ctx.moveTo(0, 0);
                    ctx.lineTo(Math.cos(angle) * foliageR, Math.sin(angle) * foliageR);
                }
                ctx.stroke();

                ctx.fillStyle = '#00ffaa';
                ctx.beginPath();
                for (let i = 0; i < 6; i++) {
                    const nodeAng = now * 0.001 + (i / 6) * Math.PI * 2;
                    ctx.arc(Math.cos(nodeAng) * foliageR * 0.8, Math.sin(nodeAng) * foliageR * 0.8, 3, 0, Math.PI*2);
                }
                ctx.fill();
                ctx.restore();

            } else if (dec.type === 'TORCH') {
                // Sensor scanner / Security camera laser beam
                const flicker = 0.95 + 0.05 * Math.sin(now * 0.08 + dec.x);
                
                // Cyber camera stand
                ctx.fillStyle = '#111';
                ctx.fillRect(-4, -6, 8, 18);

                // Rotating camera lens
                ctx.save();
                ctx.translate(0, -6);
                const rotation = Math.sin(now * 0.0008 + dec.x) * 0.5;
                ctx.rotate(rotation);
                
                ctx.fillStyle = '#222';
                ctx.fillRect(-6, -4, 12, 8);
                ctx.fillStyle = '#00ffaa';
                ctx.beginPath();
                ctx.arc(4, 0, 2.5, 0, Math.PI*2);
                ctx.fill();

                // Laser line
                ctx.strokeStyle = 'rgba(0, 255, 170, 0.5)';
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(4, 0);
                ctx.lineTo(180 * flicker, 0);
                ctx.stroke();
                ctx.restore();
            }
        }
        ctx.restore();
    }

    drawDeathParticles(CAMERA.x, CAMERA.y, 1);
    ctx.restore();

    // Alarm lockdown screen tint (Weapon Warehouse)
    if (mapRule === 'alarm' && (alarmPhase === 'warning' || alarmPhase === 'freeze')) {
        const alarmNow = Date.now();
        const intensity = alarmPhase === 'freeze'
            ? 0.3
            : 0.1 + 0.08 * Math.sin(alarmNow * 0.012);
        ctx.fillStyle = `rgba(255, 20, 40, ${intensity})`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    // ---- MINIMAP ----
    if (minimapEl.style.display !== 'none') {
        const scale = MM_SIZE / Math.max(MAP_SIZE.w, MAP_SIZE.h);
        minimapCtx.clearRect(0, 0, MM_SIZE, MM_SIZE);

        // Background
        minimapCtx.fillStyle = 'rgba(0, 10, 20, 0.92)';
        minimapCtx.fillRect(0, 0, MM_SIZE, MM_SIZE);

        // Map border
        minimapCtx.strokeStyle = 'rgba(0,255,255,0.4)';
        minimapCtx.lineWidth = 1;
        minimapCtx.strokeRect(
            0, 0,
            MAP_SIZE.w * scale,
            MAP_SIZE.h * scale
        );

        // Decorations (rocks as grey dots)
        for (const dec of decorations) {
            if (dec.type !== 'ROCK') continue;
            minimapCtx.fillStyle = 'rgba(120,120,160,0.6)';
            minimapCtx.beginPath();
            minimapCtx.arc(dec.x * scale, dec.y * scale, Math.max(2, dec.radius * scale), 0, Math.PI * 2);
            minimapCtx.fill();
        }

        // Items
        for (const item of itemsState) {
            minimapCtx.fillStyle = item.type === 'HEART' ? '#ff2255' : '#ffff00';
            minimapCtx.shadowColor = minimapCtx.fillStyle;
            minimapCtx.shadowBlur = 4;
            minimapCtx.beginPath();
            minimapCtx.arc(item.x * scale, item.y * scale, 3, 0, Math.PI * 2);
            minimapCtx.fill();
            minimapCtx.shadowBlur = 0;
        }

        // Radar sweep line on Command Center minimap
        if (mapRule === 'radar') {
            const mcx = (MAP_SIZE.w / 2) * scale;
            const mcy = (MAP_SIZE.h / 2) * scale;
            const angle = serverRadarAngle || ((Date.now() * 0.0007) % (Math.PI * 2));
            minimapCtx.strokeStyle = 'rgba(0, 255, 170, 0.55)';
            minimapCtx.lineWidth = 1.5;
            minimapCtx.beginPath();
            minimapCtx.moveTo(mcx, mcy);
            minimapCtx.lineTo(mcx + Math.cos(angle) * MM_SIZE, mcy + Math.sin(angle) * MM_SIZE);
            minimapCtx.stroke();
        }

        // Map rule pings (radar + alarm violators)
        for (const ping of mapPings) {
            const px = ping.x * scale;
            const py = ping.y * scale;
            const blink = Math.floor(Date.now() / 200) % 2 === 0;
            if (ping.t === 'r') {
                minimapCtx.fillStyle = blink ? '#00ffaa' : '#006644';
                minimapCtx.shadowColor = '#00ffaa';
            } else {
                minimapCtx.fillStyle = blink ? '#ff2244' : '#880011';
                minimapCtx.shadowColor = '#ff2244';
            }
            minimapCtx.shadowBlur = 5;
            minimapCtx.beginPath();
            minimapCtx.arc(px, py, 4, 0, Math.PI * 2);
            minimapCtx.fill();
            minimapCtx.shadowBlur = 0;
        }

        // Entities
        for (const ent of gameState) {
            const ex = ent.x * scale;
            const ey = ent.y * scale;
            const isSpectatingThis = (myLives <= 0 && ent.id === spectateTargetId);

            if (ent.id === localPlayerId) {
                minimapCtx.fillStyle = '#8ca885';
                minimapCtx.shadowColor = '#8ca885';
                minimapCtx.shadowBlur = 3;
                minimapCtx.beginPath();
                minimapCtx.arc(ex, ey, 4, 0, Math.PI * 2);
                minimapCtx.fill();
                minimapCtx.shadowBlur = 0;
            } else if (isSpectatingThis) {
                const blink = Math.floor(Date.now() / 250) % 2 === 0;
                minimapCtx.fillStyle = blink ? '#d9534f' : '#ffffff';
                minimapCtx.shadowColor = '#d9534f';
                minimapCtx.shadowBlur = 3;
                minimapCtx.beginPath();
                minimapCtx.arc(ex, ey, 4.5, 0, Math.PI * 2);
                minimapCtx.fill();
                minimapCtx.shadowBlur = 0;
            } else if (ent.isPlayer && mapRule !== 'radar' && !ent.inBush) {
                minimapCtx.fillStyle = '#f0ad4e';
                minimapCtx.beginPath();
                minimapCtx.arc(ex, ey, 3, 0, Math.PI * 2);
                minimapCtx.fill();
            }
        }

        // Draw Storm Zone on classic minimap
        if ((classicEndGameMode === 'STORM' || classicEndGameMode === 'TEMPETE') && classicEndGameTriggered) {
            const mcx = (MAP_SIZE.w / 2) * scale;
            const mcy = (MAP_SIZE.h / 2) * scale;
            const mr = classicStormRadius * scale;
            
            minimapCtx.save();
            minimapCtx.fillStyle = 'rgba(150, 0, 0, 0.35)';
            minimapCtx.beginPath();
            minimapCtx.rect(0, 0, MM_SIZE, MM_SIZE);
            minimapCtx.arc(mcx, mcy, mr, 0, Math.PI * 2, true);
            minimapCtx.fill();
            
            minimapCtx.strokeStyle = 'rgba(255, 0, 100, 0.8)';
            minimapCtx.lineWidth = 2;
            minimapCtx.beginPath();
            minimapCtx.arc(mcx, mcy, mr, 0, Math.PI * 2);
            minimapCtx.stroke();
            minimapCtx.restore();
        }
    }

    requestAnimationFrame(renderLoop);
}

// ─── Lightweight test suite (runs once on load, logs to console) ────
(function runTests() {
    let passed = 0, failed = 0;
    function assert(label, cond) {
        if (cond) { passed++; }
        else { failed++; console.error('[TEST FAIL]', label); }
    }

    // triggerShake — max wins, never goes negative
    shakePow = 0;
    triggerShake(5);
    assert('triggerShake sets power', shakePow === 5);
    triggerShake(3);
    assert('triggerShake keeps max', shakePow === 5);
    triggerShake(8);
    assert('triggerShake raises when higher', shakePow === 8);

    // applyShake — clears when power is tiny
    shakePow = 0.1;
    canvas.style.transform = 'translate(3px,3px)';
    applyShake();
    assert('applyShake clears sub-threshold', shakePow === 0 && canvas.style.transform === '');

    // spawnDeathParticles — correct count
    deathParticles = [];
    spawnDeathParticles(100, 200, '#ff0000', 10);
    assert('spawnDeathParticles count', deathParticles.length === 10);
    assert('spawnDeathParticles life=1', deathParticles.every(p => p.life === 1));
    assert('spawnDeathParticles origin x', deathParticles.every(p => p.x === 100));

    // drawDeathParticles — particles age and are removed
    deathParticles = [];
    spawnDeathParticles(0, 0, '#00ff00', 3);
    deathParticles.forEach(p => { p.decay = 1.5; }); // force expiry
    drawDeathParticles(0, 0, 1);
    assert('drawDeathParticles removes expired particles', deathParticles.length === 0);

    // Slot cascade — smoke test (DOM round-trip)
    const tempRow = document.createElement('div');
    [{ type: 'human', ready: false, num: 1 }, { type: 'empty' }].forEach((slot, i) => {
        const d = document.createElement('div');
        d.style.animation = 'slotAppear 0.18s ease both';
        d.style.animationDelay = (i * 60) + 'ms';
        tempRow.appendChild(d);
    });
    assert('slotCascade delay P1', tempRow.children[0].style.animationDelay === '0ms');
    assert('slotCascade delay P2', tempRow.children[1].style.animationDelay === '60ms');

    // updateShareWidget — builds correct URL shapes
    shareUrl = '';
    updateShareWidget('ABCD', 'mimic');
    assert('shareWidget mimic param', shareUrl.includes('?code=ABCD'));
    updateShareWidget('WXYZ', 'hunter');
    assert('shareWidget hunter param', shareUrl.includes('?hunter=WXYZ'));

    // Summary
    const status = failed === 0 ? '✓ All' : `✗ ${failed} failed,`;
    console.log(`[TESTS] ${status} ${passed} passed`);
})();

// ── Rules overlay ──────────────────────────────────────────────────
(function initRulesOverlay() {
    const overlay = document.getElementById('rulesOverlay');
    const btn     = document.getElementById('btnCloseRules');

    // Skip rules if returning from a room (page reload after leave)
    if (sessionStorage.getItem('mimic_came_from_room')) {
        sessionStorage.removeItem('mimic_came_from_room');
        overlay.remove();
        startMenuMusic();
        return;
    }
    const btnRulesLang = document.getElementById('btnRulesLang');

    const TEXTS = {
        fr: {
            subtitle: '// BRIEFING DE MISSION //',
            ref: 'RÉF-OPS-001 — CLASSIFICATION : RECRUES',
            mimic_badge: 'CLASSIQUE',
            role_agent: 'AGENT', role_agent_desc: 'Chasseur &amp; Proie',
            m1: 'Tous les joueurs sont mélangés aux bots dans l\'arène',
            m2: 'Chaque joueur est à la fois <strong>chasseur</strong> et <strong>proie</strong>',
            m3: 'Repère les vrais joueurs sans te faire repérer toi-même',
            m4: 'Élimine les adversaires avant qu\'ils ne t\'éliminent',
            m5: 'Imite les bots pour rester discret — un faux mouvement te trahit',
            m_event: '⚠ ÉVÉNEMENT FINAL ALÉATOIRE EN FIN DE PARTIE',
            hunter_badge: 'PROP HUNT',
            role_hunter: 'CHASSEUR', role_hunter_desc: 'Débusque les props',
            role_prop: 'PROP', role_prop_desc: 'Se déguise en objet',
            h1: 'Les <strong>Props</strong> se déguisent en objets du décor',
            h2: 'Le <strong>Chasseur</strong> doit débusquer et taguer tous les props',
            h3: 'Les Props peuvent bouger — mais choisissez le bon moment !',
            h4: 'Le Chasseur perd de la vie si le temps passe sans trouver personne',
            h_event: '⚠ PHASE DE CONFINEMENT SE DÉCLENCHE EN FIN DE PARTIE',
            btn: '▶ LANCER LA MISSION',
            hint: '// SON ACTIVÉ AU DÉMARRAGE //',
        },
        en: {
            subtitle: '// MISSION BRIEFING //',
            ref: 'REF-OPS-001 — CLASSIFICATION: RECRUITS',
            mimic_badge: 'CLASSIC',
            role_agent: 'AGENT', role_agent_desc: 'Hunter &amp; Prey',
            m1: 'All players are mixed among bots across the arena',
            m2: 'Every player is both <strong>hunter</strong> and <strong>prey</strong>',
            m3: 'Spot real players before they spot you',
            m4: 'Eliminate opponents before they eliminate you',
            m5: 'Mimic the bots to stay hidden — one wrong move gives you away',
            m_event: '⚠ RANDOM END-GAME EVENT WHEN TIME RUNS LOW',
            hunter_badge: 'PROP HUNT',
            role_hunter: 'HUNTER', role_hunter_desc: 'Finds all props',
            role_prop: 'PROP', role_prop_desc: 'Disguises as object',
            h1: '<strong>Props</strong> disguise themselves as objects in the scene',
            h2: 'The <strong>Hunter</strong> must find and tag every hidden player',
            h3: 'Props can move — but choose your moment wisely!',
            h4: 'The Hunter loses HP every second no prop is found',
            h_event: '⚠ CONFINEMENT PHASE TRIGGERS NEAR END OF GAME',
            btn: '▶ LAUNCH MISSION',
            hint: '// SOUND ENABLED ON START //',
        },
    };

    const rlDropdown = document.getElementById('rlLangDropdown');
    const rlFlag     = document.getElementById('rlLangFlag');
    const rlText     = document.getElementById('rlLangText');

    function applyRulesLang(lang) {
        const t = TEXTS[lang] || TEXTS.fr;
        const set = (id, html) => { const el = document.getElementById(id); if (el) el.innerHTML = html; };
        set('rl_subtitle',       t.subtitle);
        set('rl_ref',            t.ref);
        set('rl_mimic_badge',    t.mimic_badge);
        set('rl_role_agent',     t.role_agent);
        set('rl_role_agent_desc',t.role_agent_desc);
        set('rl_m1',             t.m1);
        set('rl_m2',        t.m2);
        set('rl_m3',        t.m3);
        set('rl_m4',        t.m4);
        set('rl_m5',        t.m5);
        set('rl_m_event',   t.m_event);
        set('rl_hunter_title',    '◈ HUNTER MODE');
        set('rl_hunter_badge',    t.hunter_badge);
        set('rl_role_hunter',     t.role_hunter);
        set('rl_role_hunter_desc',t.role_hunter_desc);
        set('rl_role_prop',       t.role_prop);
        set('rl_role_prop_desc',  t.role_prop_desc);
        set('rl_h1',        t.h1);
        set('rl_h2',        t.h2);
        set('rl_h3',        t.h3);
        set('rl_h4',        t.h4);
        set('rl_h_event',   t.h_event);
        btn.textContent = t.btn;
        set('rl_hint', t.hint);
        if (rlFlag) rlFlag.textContent = lang === 'en' ? '🇬🇧' : '🇫🇷';
        if (rlText) rlText.textContent = lang === 'en' ? 'EN' : 'FR';
    }

    applyRulesLang(currentLang);

    // Dropdown open/close
    btnRulesLang.addEventListener('click', (e) => {
        e.stopPropagation();
        rlDropdown.style.display = rlDropdown.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { rlDropdown.style.display = 'none'; });

    // Language option selection
    document.querySelectorAll('[data-rllang]').forEach(el => {
        el.addEventListener('click', () => {
            const lang = el.getAttribute('data-rllang');
            rlDropdown.style.display = 'none';
            applyLanguage(lang);
            applyRulesLang(lang);
        });
    });

    btn.addEventListener('click', () => {
        overlay.classList.add('hiding');
        startMenuMusic();
        overlay.addEventListener('animationend', () => overlay.remove(), { once: true });
    });
})();

