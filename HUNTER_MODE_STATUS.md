# MODE HUNTER — RÉSUMÉ COMPLET

## ✅ IMPLÉMENTATION COMPLÈTE

### Serveur (server.js)
1. **Seeded PRNG + Génération procédurale**
   - `mulberry32()` : PRNG déterministe pour map identique côté tous les clients
   - `generateHunterObjects()` : Pool militaire (caisses, barils, extincteurs, etc.)
   - Espacement min 60px, 2–3 leurres animés auto-générés

2. **Gestion du mode 'hunter'**
   - `gameMode: 'hunter'` dans lobby (flag clientside + socket emit `setGameMode`)
   - `startHunterGame()` : création entités, objets, assignment hunter/ghosts
   - Phases : RECON (20s) → CACHE (30s) → CHASSE (5m)

3. **Phases & Timer Management**
   - `hunterPhase`, `phaseRemaining` : mis à jour chaque tick
   - Transition auto dans `gameLoop()` 
   - Events Socket.IO : `hunterStart`, `hunterPhase`, `playerDisguised`

4. **Pénalités & Scoring**
   - Hunter `lives` système (100 PV → 15 malus décor, 5 malus miss)
   - Ghost `lives` : 1 hit = éliminé (tag direct)
   - Fin round : 3 ghosts éliminés → chasseur gagne | timeout → ghosts gagnent

5. **Blend Mechanism**
   - Ghost `blendRequest` socket → `handleBlend()`
   - Déguisement à < 60px d'un objet (CACHE phase)
   - Flag `hasDisguisedOnce` (1x par round)

### Client (hunter.html)
1. **Canvas 2D + Socket.IO**
   - Affichage map, objets (gris) + entités (hunter rouge / ghost vert)
   - Minimap avec positions temps réel
   - Grid background + zoom smooth

2. **Phases & UI**
   - HUD top-left : PHASE, TIMER (mm:ss), ROLE badge
   - HUD top-right : Hunter lives, Ghosts alive
   - Standby overlay pour CACHE (écran noir, countdown 30s)
   - Messages pop : « Game Started », « Disguised », etc.

3. **Interactions**
   - **Hunter** : CLICK pour tag (max 200px proximity)
   - **Ghost** : CLICK/E pour blend (CACHE), puis slowed movement
   - **Tous** : WASD/Arrows pour mouvement
   - Phase-aware : ghosts immobilisés en RECON

4. **Socket Events Récepteur**
   - `hunterStart` : init game, seed+objects, assign role
   - `gameState` : entities, objects, phase, phaseRemaining (20fps throttle)
   - `hunterPhase` : phase change + standby blind
   - `playerDisguised` : feedback player

### Lobby (index.html)
- Bouton `🎯 HUNTER MODE` en bas du menu lobby
- Émit `setGameMode('hunter')` + redirect `/hunter.html`

---

## 🎮 FLOW UTILISATEUR

### Démarrage partie
1. Joueur crée room → `🎯 HUNTER MODE` button
2. Clique → `setGameMode('hunter')` + `playerReady()`
3. Redirect `/hunter.html`
4. Socket reçoit `hunterStart` : map, objets, roles
5. Affichage HUD : "1 HUNTER vs 3 GHOSTS"

### RECON (20s)
- **Hunter** : voit tout, peut bouger (rassemble la map)
- **Ghosts** : écran STANDBY noir, immobilisés

### CACHE (30s)
- **Hunter** : écran noir + countdown (blinded)
- **Ghosts** : peuvent bouger, trouvent objet à < 60px, clic/E blend
- Si disguisés → move lent (× 0.4)

### CHASSE (5m)
- **Hunter** : voit tout, clique pour tag (false décor = -15 PV, miss = -5 PV)
- **Ghosts** : bougent, évitent clic (tag = éliminé)
- **Fin** : 
  - 0 ghosts → Hunter wins
  - Timer à 0 → Ghosts win

---

## 🚀 COMMANDES DÉMARRAGE

```bash
npm start
# Server listening on port 3000

# Ouvrir http://localhost:3000
# Menu → 🎯 HUNTER MODE
# Attend 4 joueurs + 20s countdown auto
# Redirige /hunter.html
```

---

## 📋 FEATURES IMPLÉMENTÉS

✅ Seeded RNG (PRNG Mulberry32)
✅ Pool objets procédurale (9 types)
✅ Espacement minimal + leurres
✅ Hunter/Ghost roles
✅ Phases RECON/CACHE/CHASSE
✅ Standby overlay (écran noir blinded)
✅ Blend mechanism (ghost dans objet)
✅ Pénalités chasseur (décor -15, miss -5)
✅ Tag detection + élimination ghost
✅ HUD phases, timers, lives
✅ Canvas 2D rendering
✅ Minimap
✅ Socket.IO event throttle 20fps
✅ Movement constraints phase-aware

---

## 🔧 PROCHAINS TWEAKS (OPTIONNELS)

- [ ] Animations des objets (rotation, pulse)
- [ ] Drone RECON bonus (1x/round, reveal zone 200×200)
- [ ] Scan thermique bonus (suspectes pulsent 2s)
- [ ] Leurre sonore bonus ghost (bruit pas)
- [ ] Rotation des rôles après 4 manches
- [ ] Chat / ping wheel
- [ ] Replay mode
- [ ] Leaderboard rounds

---

## ⚡ STATUS

**FONCTIONNEL** — Tout est connecté :
- Serveur phases auto
- Client map + HUD
- Socket.IO live state sync
- Mécanique tag/blend/pénalités

**PRÊT À TESTER** — 4 clients min (1 Hunter + 3 Ghosts)
