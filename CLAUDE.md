# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the game

Open `index.html` directly in a browser — no build step, no server required. The game is entirely self-contained in two files:

```
index.html   # canvas shell + CSS
game.js      # all game logic (~2200 lines)
```

There are no dependencies, no package.json, no bundler, and no tests.

## Git workflow

**After every meaningful change, commit and push immediately.** Do not batch unrelated changes into one commit. The remote is `origin master` on GitHub (`judeimuede/sector-zero`).

```bash
git add game.js          # (or index.html / CLAUDE.md if changed)
git commit -m "short imperative summary of what and why"
git push
```

Commit message rules:
- Imperative mood: "Add spread shot powerup" not "Added" or "Adding"
- First line ≤ 72 characters; describe *what changed and why*, not just what the code does
- Always append `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`

Always push in the same session the code was written. The goal is that GitHub always reflects the current state of the project so work is never lost and any commit can be restored.

## Architecture

Everything lives in `game.js`, structured in order from top to bottom:

1. **Constants** — `CANVAS_W/H`, `FIXED_STEP`, `S` (pixel scale = 2), `STATE` enum
2. **Utilities** — `clamp`, `weightedRandom(table)`, `circleCollide`
3. **Audio** — `AudioManager` singleton (`audio`), BGM step-sequencer data (`BGM_MELODY`, `BGM_BASS`, drum arrays)
4. **Powerup data** — `POWERUP_DEFS`, `ENEMY_DROPS`, `TIMED_SPAWN_TABLE`
5. **Background drawing** — `drawBackground(ctx, bgColor, gridColor)`
6. **Sprite functions** — `drawPlayer`, `drawGrunt`, `drawFlanker`, `drawTank`, `drawShooter`, `drawPowerupIcon` — all use `ctx.fillRect` at scale `S=2`; called with `ctx` pre-translated and pre-rotated
7. **Particle system** — `Particle` class + spawn helpers (`spawnMuzzleFlash`, `spawnDeathParticles`, `spawnHitSpark`, `spawnBloodPuff`, `spawnPickupParticles`, `spawnNukeParticles`)
8. **Powerup class** — `Powerup` — world pickup item with bob animation, lifetime, and `draw(ctx, totalTime)`
9. **Bullet class** — `Bullet` — player (`owner:'player'`) and enemy (`owner:'enemy'`) bullets with trail
10. **Player class** — movement, aim, shooting, active powerup timers, two damage paths
11. **Enemy base + 4 subclasses** — `Grunt`, `Flanker`, `Tank`, `Shooter`
12. **Spawn utils + level definitions** — `LEVELS` array, `spawnEnemy(type)`
13. **InputManager** — keyboard + mouse state; `consumeMuteToggle()` for one-shot M key
14. **HUD** — `drawHUD(ctx, player, score, levelIdx, killCount, killsToWin, audioMuted)`
15. **Overlay screens** — `drawMenu`, `drawLevelComplete`, `drawGameOver`
16. **Game class** — state machine, fixed-timestep loop, collision, spawning, powerup application

### Game loop

Fixed 60 fps timestep with a capped delta (`FIXED_STEP = 1000/60`):

```
accumulator += min(delta, 50ms)
while accumulator >= FIXED_STEP: update(dt); accumulator -= FIXED_STEP
render()
```

Update order: player → enemies → bullets → particles → powerups → collisions → flush dead → win/death check → enemy spawn → powerup spawn.

Render order (back to front): background grid → powerup pickups → bullets → enemies → player → particles → HUD → crosshair → state overlays.

### State machine

`MENU → PLAYING → LEVEL_COMPLETE → PLAYING (next level)`  
`PLAYING → GAME_OVER` (player death or victory after level 3)  
`GAME_OVER → MENU` (click anywhere)

### Collision

Circle–circle only: `circleCollide(ax, ay, ar, bx, by, br)`. Three collision passes per frame:
- Player bullets vs enemies (`takeDamage`)
- Enemy bullets vs player (`takeBulletDamage` — triggers invincibility frames)
- Enemy bodies vs player (`takeContactDamage` — continuous drain, no i-frames, shield blocks it)

### Player damage model

- `takeBulletDamage(amount)` — skipped if `invincible > 0` or `shield` active; sets 0.65s i-frame window
- `takeContactDamage(amountPerSec, dt)` — skipped only if `shield` active; sound throttled via `contactHurtTimer`
- Active powerups tracked in `player.activePowerups` (`{ type: remainingSeconds }`); ticked down in `Player.update()`

### Audio

`AudioManager` is a module-level singleton (`audio`). All sounds are synthesized — no audio files.

- **SFX bus**: `masterGain` (gain 0.35) → `ctx.destination`
- **BGM bus**: `_bgmGain` (gain 0.18) → `ctx.destination`
- **BGM scheduler**: 28ms `setTimeout` loop, 140ms look-ahead window, uses `ctx.currentTime` for drift-free timing. Resync guard handles `AudioContext` suspension (browser autoplay policy).
- **Mute**: `audio.toggle()` sets both gain nodes to 0; `M` key fires via `input.consumeMuteToggle()`

### Powerup system

- **Drop on kill**: `ENEMY_DROPS[type].chance` roll → `weightedRandom(table)` picks type → `new Powerup(x, y, type)`
- **Timed map spawn**: every 12–18s if `powerups.length < MAX_TIMED_POWERUPS (3)`
- **Collection**: circle collision player+8 vs powerup → `Game._applyPowerup(type)` → instant effect (health, nuke) or sets `player.activePowerups[type] = duration`
- **HUD**: active timed powerups render as labelled depletion bars below the HP bar

### Adding a new enemy type

1. Write a `draw<Name>` sprite function using `fillRect` — sprite drawn at origin, facing +X
2. Subclass `Enemy`, set stats in constructor, override `update(dt, px, py)` and `_drawSprite(ctx)`
3. Add a case to `spawnEnemy(type)`
4. Add `{ type: '...', weight: N }` entries to the desired `LEVELS[n].spawnTable`
5. Add a drop entry to `ENEMY_DROPS`

### Adding a new powerup type

1. Add an entry to `POWERUP_DEFS` with `color`, `label`, and `duration` (0 = instant)
2. Add a case to `drawPowerupIcon(ctx, type, color)` using `fillRect`
3. Handle the type in `Game._applyPowerup(type)`
4. Add a jingle case in `AudioManager.powerupCollect(type)`
5. Add to relevant `ENEMY_DROPS` tables and/or `TIMED_SPAWN_TABLE`
6. If timed, add to the `timedTypes` array in `drawHUD`
