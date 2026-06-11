'use strict';

// =============================================================================
// CONSTANTS
// =============================================================================

const CANVAS_W = 800;
const CANVAS_H = 600;
const FIXED_STEP = 1000 / 60;
const S = 2; // pixel scale for sprites

const STATE = Object.freeze({
  MENU: 'MENU',
  PLAYING: 'PLAYING',
  LEVEL_COMPLETE: 'LEVEL_COMPLETE',
  GAME_OVER: 'GAME_OVER',
});

// =============================================================================
// UTILITIES
// =============================================================================

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function weightedRandom(table) {
  const total = table.reduce((s, e) => s + e.weight, 0);
  let r = Math.random() * total;
  for (const entry of table) {
    r -= entry.weight;
    if (r <= 0) return entry.type;
  }
  return table[table.length - 1].type;
}

function circleCollide(ax, ay, ar, bx, by, br) {
  return Math.hypot(bx - ax, by - ay) < ar + br;
}

// =============================================================================
// AUDIO
// =============================================================================

let audio = null; // singleton set in Game constructor

// =============================================================================
// BGM SEQUENCER DATA
// =============================================================================

const BGM_BPM       = 132;
const BGM_STEP_DUR  = (60 / BGM_BPM) / 2; // 8th-note duration in seconds (~0.227s)
const BGM_STEPS     = 32;                  // 4 bars × 8 steps

// Frequencies used in the track (A minor pentatonic)
const P = {
  _:  0,
  E2: 82.41,  G2: 98,     A2: 110,
  C3: 130.81, D3: 146.83, E3: 164.81, G3: 196,
  A3: 220,
  C4: 261.63, D4: 293.66, E4: 329.63, G4: 392,
  A4: 440,
  C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99,
};

// Lead melody — square wave
const BGM_MELODY = [
  // Bar 1 — driving opening riff
  P.A4, P._,  P.C5, P._,  P.E5, P.D5, P.C5, P._,
  // Bar 2 — answering phrase
  P.A4, P.G4, P.E4, P._,  P.G4, P._,  P.A4, P._,
  // Bar 3 — build to top
  P.D5, P._,  P.E5, P.G5, P.E5, P._,  P.D5, P.C5,
  // Bar 4 — resolution
  P.A4, P.C5, P.A4, P._,  P.E4, P.G4, P.A4, P._,
];

// Bass line — sawtooth
const BGM_BASS = [
  P.A2, P._,  P._,  P.A2, P.E3, P._,  P._,  P._,
  P.A2, P._,  P._,  P.A2, P.E3, P._,  P._,  P.G2,
  P.D3, P._,  P._,  P.D3, P.A2, P._,  P._,  P._,
  P.E3, P._,  P._,  P.E3, P.A2, P._,  P.E2, P._,
];

// Drums  (1 = hit, 0 = rest)
const BGM_KICK  = [1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0];
const BGM_SNARE = [0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0, 0,0,0,0, 1,0,0,0];
const BGM_HIHAT = [1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0, 1,0,1,0];

class AudioManager {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this._bgmGain = null;
    this.muted = false;
    this._bgmRunning = false;
    this._bgmTimer = null;
    this._bgmStep = 0;
    this._bgmNextTime = 0;
  }

  _init() {
    if (this.ctx) return;
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      // SFX bus
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.35;
      this.masterGain.connect(this.ctx.destination);
      // BGM bus (separate gain so we can balance independently)
      this._bgmGain = this.ctx.createGain();
      this._bgmGain.gain.value = 0.18;
      this._bgmGain.connect(this.ctx.destination);
    } catch (_) {}
  }

  _resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }

  _tone(freq, type, duration, vol, freqEnd) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd != null) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(freqEnd, 1), t + duration);
    }
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  _noise(duration, vol, filterFreq) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, Math.ceil(sr * duration), sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const filt = this.ctx.createBiquadFilter();
    filt.type = 'lowpass';
    filt.frequency.value = filterFreq || 2000;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filt);
    filt.connect(g);
    g.connect(this.masterGain);
    src.start(t);
    src.stop(t + duration + 0.02);
  }

  toggle() {
    this.muted = !this.muted;
    if (this.masterGain) this.masterGain.gain.value = this.muted ? 0 : 0.35;
    if (this._bgmGain)   this._bgmGain.gain.value   = this.muted ? 0 : 0.18;
    return this.muted;
  }

  // Player fires
  shoot() {
    this._init(); this._resume();
    this._tone(900, 'square', 0.06, 0.28, 180);
    this._noise(0.05, 0.12, 4000);
  }

  // Bullet hits enemy but doesn't kill
  enemyHit() {
    this._init(); this._resume();
    this._noise(0.07, 0.18, 1800);
  }

  // Enemy dies
  enemyDeath() {
    this._init(); this._resume();
    this._noise(0.28, 0.45, 500);
    this._tone(90, 'sawtooth', 0.28, 0.35, 28);
  }

  // Player takes a bullet hit
  playerHurt() {
    this._init(); this._resume();
    this._tone(280, 'sawtooth', 0.14, 0.38, 90);
    this._noise(0.12, 0.18, 900);
  }

  // Player dies
  playerDeath() {
    this._init(); this._resume();
    this._noise(0.75, 0.75, 280);
    this._tone(110, 'sawtooth', 0.65, 0.5, 22);
    this._tone(220, 'sine', 0.4, 0.25, 45);
  }

  // Enemy shooter fires
  enemyShoot() {
    this._init(); this._resume();
    this._tone(180, 'sawtooth', 0.08, 0.16, 80);
    this._noise(0.06, 0.08, 1200);
  }

  // Collect a powerup (type-dependent jingle)
  powerupCollect(type) {
    this._init(); this._resume();
    if (type === 'health') {
      this._tone(523, 'sine', 0.12, 0.3);
      setTimeout(() => { this._init(); this._tone(659, 'sine', 0.12, 0.3); }, 90);
      setTimeout(() => { this._init(); this._tone(784, 'sine', 0.18, 0.28); }, 180);
    } else if (type === 'nuke') {
      this._noise(0.55, 0.65, 220);
      this._tone(55, 'sawtooth', 0.55, 0.55, 18);
    } else if (type === 'shield') {
      this._tone(440, 'sine', 0.1, 0.25, 880);
      setTimeout(() => { this._init(); this._tone(880, 'sine', 0.18, 0.25); }, 80);
    } else if (type === 'rapidfire') {
      this._tone(660, 'square', 0.06, 0.22, 880);
      this._noise(0.06, 0.1, 3000);
    } else if (type === 'speed') {
      this._tone(440, 'sine', 0.08, 0.22, 660);
      setTimeout(() => { this._init(); this._tone(880, 'sine', 0.1, 0.18); }, 70);
    } else {
      this._tone(440, 'triangle', 0.08, 0.22, 660);
      this._tone(660, 'sine', 0.15, 0.2);
    }
  }

  // Sector cleared
  levelComplete() {
    this._init(); this._resume();
    [523, 659, 784, 1047].forEach((freq, i) => {
      setTimeout(() => { this._init(); this._tone(freq, 'sine', 0.2, 0.3); }, i * 145);
    });
  }

  // ── BGM step sequencer ─────────────────────────────────────────────────────

  startBGM() {
    this._init();
    if (!this.ctx || this._bgmRunning) return;
    this._bgmRunning = true;
    this._bgmStep = 0;
    this._bgmNextTime = 0;
    this._bgmTick();
  }

  stopBGM() {
    this._bgmRunning = false;
    clearTimeout(this._bgmTimer);
    this._bgmTimer = null;
    if (this._bgmGain && this.ctx) {
      this._bgmGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
    }
  }

  _bgmTick() {
    if (!this._bgmRunning || !this.ctx) return;
    // Wait while context is suspended (browser autoplay policy)
    if (this.ctx.state === 'suspended') {
      this._bgmTimer = setTimeout(() => this._bgmTick(), 100);
      return;
    }
    // Resync if clock jumped ahead (e.g. after suspension)
    if (this._bgmNextTime < this.ctx.currentTime) {
      this._bgmNextTime = this.ctx.currentTime + 0.05;
    }
    // Schedule notes that fall within the look-ahead window
    while (this._bgmNextTime < this.ctx.currentTime + 0.14) {
      this._scheduleBGMStep(this._bgmStep, this._bgmNextTime);
      this._bgmStep = (this._bgmStep + 1) % BGM_STEPS;
      this._bgmNextTime += BGM_STEP_DUR;
    }
    this._bgmTimer = setTimeout(() => this._bgmTick(), 28);
  }

  _scheduleBGMStep(step, t) {
    if (!this.ctx || !this._bgmGain) return;
    const mel = BGM_MELODY[step];
    if (mel > 0) this._bgmOsc(mel, t, BGM_STEP_DUR * 0.82, 0.22, 'square');

    const bas = BGM_BASS[step];
    if (bas > 0) this._bgmOsc(bas, t, BGM_STEP_DUR * 1.85, 0.28, 'sawtooth');

    if (BGM_KICK[step])  this._bgmKick(t);
    if (BGM_SNARE[step]) this._bgmSnare(t);
    if (BGM_HIHAT[step]) this._bgmHihat(t);
  }

  _bgmOsc(freq, t, dur, vol, type) {
    const osc = this.ctx.createOscillator();
    const g   = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g);
    g.connect(this._bgmGain);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }

  _bgmKick(t) {
    const osc = this.ctx.createOscillator();
    const g   = this.ctx.createGain();
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(0.01, t + 0.13);
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    osc.connect(g);
    g.connect(this._bgmGain);
    osc.start(t);
    osc.stop(t + 0.14);
  }

  _bgmSnare(t) {
    const dur  = 0.11;
    const sr   = this.ctx.sampleRate;
    const buf  = this.ctx.createBuffer(1, Math.ceil(sr * dur), sr);
    const d    = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src  = this.ctx.createBufferSource();
    src.buffer = buf;
    const filt = this.ctx.createBiquadFilter();
    filt.type  = 'bandpass';
    filt.frequency.value = 2200;
    const g    = this.ctx.createGain();
    g.gain.setValueAtTime(0.38, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filt); filt.connect(g); g.connect(this._bgmGain);
    src.start(t); src.stop(t + dur + 0.01);
    // Body tone
    const osc2 = this.ctx.createOscillator();
    const g2   = this.ctx.createGain();
    osc2.frequency.setValueAtTime(220, t);
    osc2.frequency.exponentialRampToValueAtTime(100, t + 0.05);
    g2.gain.setValueAtTime(0.18, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    osc2.connect(g2); g2.connect(this._bgmGain);
    osc2.start(t); osc2.stop(t + 0.06);
  }

  _bgmHihat(t) {
    const dur  = 0.04;
    const sr   = this.ctx.sampleRate;
    const buf  = this.ctx.createBuffer(1, Math.ceil(sr * dur), sr);
    const d    = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src  = this.ctx.createBufferSource();
    src.buffer = buf;
    const filt = this.ctx.createBiquadFilter();
    filt.type  = 'highpass';
    filt.frequency.value = 7500;
    const g    = this.ctx.createGain();
    g.gain.setValueAtTime(0.14, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filt); filt.connect(g); g.connect(this._bgmGain);
    src.start(t); src.stop(t + dur + 0.01);
  }
}

// =============================================================================
// POWERUP DEFINITIONS
// =============================================================================

const POWERUP_DEFS = {
  health:    { color: '#2ecc71', label: 'HEALTH',      duration: 0 },
  rapidfire: { color: '#e74c3c', label: 'RAPID FIRE',  duration: 7 },
  speed:     { color: '#3498db', label: 'SPEED BOOST', duration: 7 },
  spread:    { color: '#9b59b6', label: 'SPREAD SHOT', duration: 6 },
  shield:    { color: '#f1c40f', label: 'SHIELD',      duration: 5 },
  nuke:      { color: '#e67e22', label: 'NUKE',        duration: 0 },
};

// Drop chance and drop table per enemy type
const ENEMY_DROPS = {
  grunt: {
    chance: 0.25,
    table: [
      { type: 'health',    weight: 6 },
      { type: 'rapidfire', weight: 3 },
      { type: 'speed',     weight: 3 },
      { type: 'spread',    weight: 2 },
      { type: 'shield',    weight: 1 },
    ],
  },
  flanker: {
    chance: 0.30,
    table: [
      { type: 'health',    weight: 4 },
      { type: 'rapidfire', weight: 3 },
      { type: 'speed',     weight: 5 },
      { type: 'spread',    weight: 3 },
      { type: 'shield',    weight: 1 },
    ],
  },
  tank: {
    chance: 0.70,
    table: [
      { type: 'health',    weight: 3 },
      { type: 'rapidfire', weight: 3 },
      { type: 'speed',     weight: 2 },
      { type: 'spread',    weight: 3 },
      { type: 'shield',    weight: 3 },
      { type: 'nuke',      weight: 2 },
    ],
  },
  shooter: {
    chance: 0.40,
    table: [
      { type: 'health',    weight: 3 },
      { type: 'rapidfire', weight: 5 },
      { type: 'speed',     weight: 3 },
      { type: 'spread',    weight: 4 },
      { type: 'shield',    weight: 2 },
    ],
  },
};

const TIMED_SPAWN_TABLE = [
  { type: 'health',    weight: 5 },
  { type: 'rapidfire', weight: 4 },
  { type: 'speed',     weight: 4 },
  { type: 'spread',    weight: 3 },
  { type: 'shield',    weight: 2 },
  { type: 'nuke',      weight: 1 },
];

// =============================================================================
// BACKGROUND
// =============================================================================

function drawBackground(ctx, bgColor, gridColor) {
  ctx.fillStyle = bgColor;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
  ctx.strokeStyle = gridColor;
  ctx.lineWidth = 1;
  const GRID = 40;
  ctx.beginPath();
  for (let x = 0; x <= CANVAS_W; x += GRID) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, CANVAS_H);
  }
  for (let y = 0; y <= CANVAS_H; y += GRID) {
    ctx.moveTo(0, y);
    ctx.lineTo(CANVAS_W, y);
  }
  ctx.stroke();
}

// =============================================================================
// SPRITE DRAWING (pixel art, all drawn relative to origin)
// =============================================================================

function drawPlayer(ctx, frame, muzzleFlash, invincible) {
  const flash = invincible > 0 && Math.floor(invincible * 10) % 2 === 0;
  ctx.globalAlpha = flash ? 0.25 : 1;

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath();
  ctx.ellipse(2, 5 * S, 7 * S, 3 * S, 0, 0, Math.PI * 2);
  ctx.fill();

  // Legs (animate walk cycle)
  ctx.fillStyle = '#1a3a1a';
  if (frame === 0) {
    ctx.fillRect(-4 * S, 3 * S, 3 * S, 6 * S);
    ctx.fillRect(1 * S,  3 * S, 3 * S, 3 * S);
  } else {
    ctx.fillRect(-4 * S, 3 * S, 3 * S, 3 * S);
    ctx.fillRect(1 * S,  3 * S, 3 * S, 6 * S);
  }
  // Boots
  ctx.fillStyle = '#111';
  if (frame === 0) {
    ctx.fillRect(-5 * S, 8 * S, 4 * S, 2 * S);
    ctx.fillRect(0 * S,  5 * S, 4 * S, 2 * S);
  } else {
    ctx.fillRect(-5 * S, 5 * S, 4 * S, 2 * S);
    ctx.fillRect(0 * S,  8 * S, 4 * S, 2 * S);
  }

  // Body (torso)
  ctx.fillStyle = '#2d5a27';
  ctx.fillRect(-5 * S, -5 * S, 10 * S, 9 * S);
  // Vest highlight
  ctx.fillStyle = '#3a7033';
  ctx.fillRect(-3 * S, -4 * S, 2 * S, 6 * S);
  ctx.fillRect(1 * S,  -4 * S, 2 * S, 6 * S);

  // Arms
  ctx.fillStyle = '#3a6e34';
  ctx.fillRect(-8 * S, -4 * S, 3 * S, 5 * S);
  ctx.fillRect(5 * S,  -4 * S, 3 * S, 4 * S);
  // Gloves
  ctx.fillStyle = '#222';
  ctx.fillRect(-8 * S, 0 * S, 3 * S, 2 * S);
  ctx.fillRect(5 * S,  -1 * S, 3 * S, 2 * S);

  // Gun grip + body
  ctx.fillStyle = '#555';
  ctx.fillRect(4 * S, -2 * S, 6 * S, 4 * S);
  // Gun barrel
  ctx.fillStyle = '#444';
  ctx.fillRect(8 * S, -1 * S, 8 * S, 3 * S);
  // Barrel tip highlight
  ctx.fillStyle = '#333';
  ctx.fillRect(14 * S, -1 * S, 2 * S, 3 * S);

  // Neck
  ctx.fillStyle = '#e0b070';
  ctx.fillRect(-1 * S, -7 * S, 2 * S, 3 * S);

  // Head
  ctx.fillStyle = '#f0c080';
  ctx.fillRect(-3 * S, -11 * S, 7 * S, 5 * S);
  // Ear
  ctx.fillStyle = '#e0b060';
  ctx.fillRect(-4 * S, -10 * S, 1 * S, 2 * S);

  // Helmet
  ctx.fillStyle = '#4a7c40';
  ctx.fillRect(-4 * S, -14 * S, 9 * S, 4 * S);
  ctx.fillStyle = '#3a6a30';
  ctx.fillRect(-3 * S, -15 * S, 7 * S, 2 * S);
  // Helmet brim
  ctx.fillStyle = '#3a6a30';
  ctx.fillRect(-5 * S, -13 * S, 11 * S, 2 * S);

  // Muzzle flash
  if (muzzleFlash > 0) {
    ctx.fillStyle = '#ffffa0';
    ctx.fillRect(15 * S, -4 * S, 6 * S, 6 * S);
    ctx.fillStyle = '#ffff44';
    ctx.fillRect(16 * S, -3 * S, 5 * S, 4 * S);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(17 * S, -2 * S, 3 * S, 2 * S);
  }

  ctx.globalAlpha = 1;
}

function drawGrunt(ctx, frame, hitFlash) {
  if (hitFlash > 0) ctx.globalAlpha = 0.6;

  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(0, 7 * S, 6 * S, 2 * S, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#7b1010';
  if (frame === 0) {
    ctx.fillRect(-4 * S, 4 * S, 3 * S, 6 * S);
    ctx.fillRect(1 * S,  4 * S, 3 * S, 3 * S);
  } else {
    ctx.fillRect(-4 * S, 4 * S, 3 * S, 3 * S);
    ctx.fillRect(1 * S,  4 * S, 3 * S, 6 * S);
  }

  ctx.fillStyle = '#c0392b';
  ctx.fillRect(-5 * S, -4 * S, 10 * S, 9 * S);
  ctx.fillStyle = '#a93226';
  ctx.fillRect(-2 * S, -3 * S, 4 * S, 7 * S);

  ctx.fillStyle = '#922b21';
  ctx.fillRect(-8 * S, -3 * S, 3 * S, 5 * S);
  ctx.fillRect(5 * S,  -3 * S, 3 * S, 5 * S);
  ctx.fillStyle = '#888';
  ctx.fillRect(-8 * S, 1 * S, 1 * S, 2 * S);
  ctx.fillRect(-7 * S, 2 * S, 1 * S, 2 * S);
  ctx.fillRect(7 * S,  1 * S, 1 * S, 2 * S);
  ctx.fillRect(8 * S,  2 * S, 1 * S, 2 * S);

  ctx.fillStyle = '#c0392b';
  ctx.fillRect(-1 * S, -6 * S, 3 * S, 3 * S);
  ctx.fillRect(-4 * S, -10 * S, 9 * S, 5 * S);
  ctx.fillStyle = '#e74c3c';
  ctx.fillRect(-3 * S, -9 * S, 2 * S, 3 * S);
  ctx.fillRect(2 * S,  -9 * S, 2 * S, 3 * S);

  ctx.fillStyle = '#ffee00';
  ctx.fillRect(-3 * S, -9 * S, 2 * S, 2 * S);
  ctx.fillRect(1 * S,  -9 * S, 2 * S, 2 * S);
  ctx.fillStyle = '#ff8800';
  ctx.fillRect(-3 * S, -9 * S, 1 * S, 1 * S);
  ctx.fillRect(2 * S,  -9 * S, 1 * S, 1 * S);

  ctx.fillStyle = '#000';
  ctx.fillRect(-3 * S, -10 * S, 2 * S, 1 * S);
  ctx.fillRect(2 * S,  -10 * S, 2 * S, 1 * S);
  ctx.fillRect(-2 * S, -6 * S, 5 * S, 1 * S);
  ctx.fillStyle = '#fff';
  ctx.fillRect(-2 * S, -7 * S, 1 * S, 2 * S);
  ctx.fillRect(0 * S,  -7 * S, 1 * S, 2 * S);
  ctx.fillRect(2 * S,  -7 * S, 1 * S, 2 * S);

  ctx.globalAlpha = 1;
}

function drawFlanker(ctx, frame, hitFlash) {
  if (hitFlash > 0) ctx.globalAlpha = 0.6;

  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(0, 7 * S, 5 * S, 2 * S, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#5b2c80';
  if (frame === 0) {
    ctx.fillRect(-3 * S, 4 * S, 2 * S, 7 * S);
    ctx.fillRect(1 * S,  4 * S, 2 * S, 3 * S);
  } else {
    ctx.fillRect(-3 * S, 4 * S, 2 * S, 3 * S);
    ctx.fillRect(1 * S,  4 * S, 2 * S, 7 * S);
  }

  ctx.fillStyle = '#9b59b6';
  ctx.fillRect(-4 * S, -5 * S, 8 * S, 10 * S);
  ctx.fillStyle = '#8e44ad';
  ctx.fillRect(-3 * S, -4 * S, 6 * S, 8 * S);

  ctx.fillStyle = '#7d3c98';
  ctx.fillRect(-8 * S, -2 * S, 4 * S, 3 * S);
  ctx.fillRect(4 * S,  -2 * S, 4 * S, 3 * S);
  ctx.fillStyle = '#c0c0c0';
  ctx.fillRect(-9 * S, -3 * S, 2 * S, 5 * S);
  ctx.fillRect(7 * S,  -3 * S, 2 * S, 5 * S);
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(-9 * S, -2 * S, 1 * S, 3 * S);
  ctx.fillRect(8 * S,  -2 * S, 1 * S, 3 * S);

  ctx.fillStyle = '#8e44ad';
  ctx.fillRect(-3 * S, -10 * S, 7 * S, 6 * S);
  ctx.fillStyle = '#6c3483';
  ctx.fillRect(-2 * S, -9 * S, 2 * S, 4 * S);
  ctx.fillRect(2 * S,  -9 * S, 2 * S, 4 * S);

  ctx.fillStyle = '#ff2020';
  ctx.fillRect(-2 * S, -9 * S, 2 * S, 2 * S);
  ctx.fillRect(2 * S,  -9 * S, 2 * S, 2 * S);
  ctx.fillStyle = '#ff8080';
  ctx.fillRect(-1 * S, -9 * S, 1 * S, 1 * S);
  ctx.fillRect(3 * S,  -9 * S, 1 * S, 1 * S);

  ctx.globalAlpha = 1;
}

function drawTank(ctx, frame, hitFlash) {
  if (hitFlash > 0) ctx.globalAlpha = 0.6;

  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  ctx.beginPath();
  ctx.ellipse(0, 9 * S, 12 * S, 4 * S, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#444';
  ctx.fillRect(-10 * S, -9 * S, 20 * S, 4 * S);
  ctx.fillRect(-10 * S,  6 * S, 20 * S, 4 * S);

  ctx.fillStyle = '#555';
  const tOffset = (frame * 4);
  for (let i = -10; i < 12; i += 4) {
    const tx = ((i + tOffset) % 20) - 10;
    if (tx >= -10 && tx < 10) {
      ctx.fillRect(tx * S, -9 * S, 2 * S, 2 * S);
      ctx.fillRect(tx * S,  8 * S, 2 * S, 2 * S);
    }
  }

  ctx.fillStyle = '#333';
  ctx.fillRect(-10 * S, -9 * S, 4 * S, 4 * S);
  ctx.fillRect( 6 * S,  -9 * S, 4 * S, 4 * S);
  ctx.fillRect(-10 * S,  6 * S, 4 * S, 4 * S);
  ctx.fillRect( 6 * S,   6 * S, 4 * S, 4 * S);

  ctx.fillStyle = '#2c3e50';
  ctx.fillRect(-8 * S, -7 * S, 16 * S, 15 * S);
  ctx.fillStyle = '#3d566e';
  ctx.fillRect(-7 * S, -6 * S, 14 * S, 3 * S);

  ctx.fillStyle = '#1f2e3d';
  ctx.fillRect(-5 * S, -5 * S, 10 * S, 10 * S);
  ctx.fillStyle = '#1a252f';
  ctx.fillRect(-4 * S, -4 * S, 8 * S, 8 * S);

  ctx.fillStyle = '#5d6d7e';
  ctx.fillRect(4 * S, -1 * S, 11 * S, 3 * S);
  ctx.fillStyle = '#4a4a4a';
  ctx.fillRect(11 * S, -2 * S, 4 * S, 5 * S);
  ctx.fillStyle = '#333';
  ctx.fillRect(13 * S, -1 * S, 3 * S, 3 * S);

  ctx.fillStyle = '#3d566e';
  ctx.fillRect(-7 * S, -6 * S, 2 * S, 2 * S);
  ctx.fillRect(5 * S,  -6 * S, 2 * S, 2 * S);
  ctx.fillRect(-7 * S,  5 * S, 2 * S, 2 * S);
  ctx.fillRect(5 * S,   5 * S, 2 * S, 2 * S);

  ctx.fillStyle = '#ff4400';
  ctx.fillRect(-2 * S, -2 * S, 4 * S, 2 * S);
  ctx.fillStyle = '#ff8844';
  ctx.fillRect(-1 * S, -2 * S, 2 * S, 1 * S);

  ctx.globalAlpha = 1;
}

function drawShooter(ctx, frame, hitFlash) {
  if (hitFlash > 0) ctx.globalAlpha = 0.6;

  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.beginPath();
  ctx.ellipse(0, 7 * S, 5 * S, 2 * S, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#a04010';
  if (frame === 0) {
    ctx.fillRect(-3 * S, 4 * S, 2 * S, 6 * S);
    ctx.fillRect(1 * S,  4 * S, 2 * S, 3 * S);
  } else {
    ctx.fillRect(-3 * S, 4 * S, 2 * S, 3 * S);
    ctx.fillRect(1 * S,  4 * S, 2 * S, 6 * S);
  }

  ctx.fillStyle = '#e67e22';
  ctx.fillRect(-4 * S, -5 * S, 8 * S, 10 * S);
  ctx.fillStyle = '#ca6f1e';
  ctx.fillRect(-3 * S, -4 * S, 6 * S, 8 * S);
  ctx.fillStyle = '#f39c12';
  for (let i = -2; i <= 2; i++) {
    ctx.fillRect(i * 2 * S, -2 * S, 1 * S, 1 * S);
  }

  ctx.fillStyle = '#ca6f1e';
  ctx.fillRect(-7 * S, -3 * S, 3 * S, 5 * S);
  ctx.fillRect(4 * S, -3 * S, 5 * S, 3 * S);

  ctx.fillStyle = '#555';
  ctx.fillRect(3 * S, -3 * S, 4 * S, 4 * S);
  ctx.fillStyle = '#444';
  ctx.fillRect(6 * S,  -2 * S, 9 * S, 3 * S);
  ctx.fillStyle = '#222';
  ctx.fillRect(7 * S, -4 * S, 4 * S, 2 * S);
  ctx.fillStyle = '#666';
  ctx.fillRect(8 * S, -5 * S, 2 * S, 2 * S);
  ctx.fillStyle = '#333';
  ctx.fillRect(13 * S, -2 * S, 2 * S, 3 * S);

  ctx.fillStyle = '#e67e22';
  ctx.fillRect(-3 * S, -11 * S, 7 * S, 7 * S);
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(-2 * S, -9 * S, 5 * S, 3 * S);

  ctx.fillStyle = '#ccc';
  ctx.fillRect(0 * S, -14 * S, 1 * S, 4 * S);
  ctx.fillStyle = '#e74c3c';
  ctx.fillRect(-1 * S, -15 * S, 3 * S, 2 * S);
  ctx.fillStyle = '#ff6666';
  ctx.fillRect(0 * S, -14 * S, 1 * S, 1 * S);

  ctx.fillStyle = '#00ddff';
  ctx.fillRect(-1 * S, -9 * S, 2 * S, 2 * S);
  ctx.fillRect(2 * S,  -9 * S, 2 * S, 2 * S);
  ctx.fillStyle = '#88ffff';
  ctx.fillRect(-1 * S, -9 * S, 1 * S, 1 * S);
  ctx.fillRect(3 * S,  -9 * S, 1 * S, 1 * S);

  ctx.globalAlpha = 1;
}

// =============================================================================
// POWERUP SPRITE
// =============================================================================

function drawPowerupIcon(ctx, type, color) {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  switch (type) {
    case 'health':
      ctx.fillRect(-1 * S, -4 * S, 2 * S, 8 * S);
      ctx.fillRect(-4 * S, -1 * S, 8 * S, 2 * S);
      break;
    case 'rapidfire':
      // Double chevron >>
      ctx.fillRect(-4 * S, -3 * S, 2 * S, 2 * S);
      ctx.fillRect(-2 * S, -1 * S, 2 * S, 2 * S);
      ctx.fillRect(-4 * S,  1 * S, 2 * S, 2 * S);
      ctx.fillRect(0 * S,  -3 * S, 2 * S, 2 * S);
      ctx.fillRect(2 * S,  -1 * S, 2 * S, 2 * S);
      ctx.fillRect(0 * S,   1 * S, 2 * S, 2 * S);
      break;
    case 'speed':
      // Arrow
      ctx.fillRect(-4 * S, -1 * S, 6 * S, 2 * S);
      ctx.fillRect(1 * S,  -3 * S, 2 * S, 6 * S);
      ctx.fillRect(3 * S,  -2 * S, 2 * S, 4 * S);
      ctx.fillRect(5 * S,  -1 * S, 1 * S, 2 * S);
      break;
    case 'spread':
      // Three spread dots
      ctx.fillRect(-5 * S, 0 * S,  2 * S, 2 * S);
      ctx.fillRect(-1 * S, -4 * S, 2 * S, 2 * S);
      ctx.fillRect(3 * S,  0 * S,  2 * S, 2 * S);
      ctx.fillRect(-1 * S, 2 * S,  2 * S, 2 * S);
      break;
    case 'shield':
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 4 * S, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillRect(-1 * S, -1 * S, 2 * S, 2 * S);
      break;
    case 'nuke':
      // Starburst: + and X
      ctx.fillRect(-5 * S, -1 * S, 10 * S, 2 * S);
      ctx.fillRect(-1 * S, -5 * S, 2 * S, 10 * S);
      ctx.fillRect(-4 * S, -4 * S, 2 * S, 2 * S);
      ctx.fillRect(2 * S,  -4 * S, 2 * S, 2 * S);
      ctx.fillRect(-4 * S,  2 * S, 2 * S, 2 * S);
      ctx.fillRect(2 * S,   2 * S, 2 * S, 2 * S);
      break;
  }
}

// =============================================================================
// PARTICLE SYSTEM
// =============================================================================

class Particle {
  constructor(x, y, vx, vy, color, size, lifetime) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.color = color;
    this.size = size;
    this.lifetime = lifetime;
    this.maxLifetime = lifetime;
    this.dead = false;
  }

  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vx *= (1 - 3 * dt);
    this.vy *= (1 - 3 * dt);
    this.lifetime -= dt;
    if (this.lifetime <= 0) this.dead = true;
  }

  draw(ctx) {
    const t = Math.max(0, this.lifetime / this.maxLifetime);
    ctx.globalAlpha = t;
    ctx.fillStyle = this.color;
    const s = this.size * t;
    ctx.fillRect(this.x - s / 2, this.y - s / 2, s, s);
    ctx.globalAlpha = 1;
  }
}

function spawnMuzzleFlash(particles, x, y, angle) {
  for (let i = 0; i < 8; i++) {
    const spread = (Math.random() - 0.5) * 0.9;
    const speed = 70 + Math.random() * 140;
    const a = angle + spread;
    particles.push(new Particle(
      x, y,
      Math.cos(a) * speed, Math.sin(a) * speed,
      Math.random() < 0.5 ? '#fff' : '#ffee44',
      2 + Math.random() * 4,
      0.06 + Math.random() * 0.06
    ));
  }
}

function spawnDeathParticles(particles, x, y, color) {
  const count = 14 + Math.floor(Math.random() * 6);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.4;
    const speed = 50 + Math.random() * 120;
    particles.push(new Particle(
      x, y,
      Math.cos(angle) * speed, Math.sin(angle) * speed,
      color,
      4 + Math.random() * 5,
      0.5 + Math.random() * 0.4
    ));
  }
  particles.push(new Particle(x, y, 0, 0, '#ffffff', 20, 0.15));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    particles.push(new Particle(
      x, y,
      Math.cos(a) * 30, Math.sin(a) * 30,
      '#ffffff', 8, 0.2
    ));
  }
}

function spawnHitSpark(particles, x, y) {
  for (let i = 0; i < 6; i++) {
    const a = Math.random() * Math.PI * 2;
    const speed = 40 + Math.random() * 80;
    particles.push(new Particle(
      x, y,
      Math.cos(a) * speed, Math.sin(a) * speed,
      '#ffffff', 2 + Math.random() * 2, 0.1 + Math.random() * 0.1
    ));
  }
}

function spawnBloodPuff(particles, x, y, color) {
  for (let i = 0; i < 3; i++) {
    const a = Math.random() * Math.PI * 2;
    const speed = 10 + Math.random() * 30;
    particles.push(new Particle(
      x, y,
      Math.cos(a) * speed, Math.sin(a) * speed,
      color, 2 + Math.random() * 2, 0.2 + Math.random() * 0.2
    ));
  }
}

function spawnPickupParticles(particles, x, y, color) {
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const speed = 55 + Math.random() * 90;
    particles.push(new Particle(
      x, y,
      Math.cos(a) * speed, Math.sin(a) * speed,
      color, 4 + Math.random() * 4, 0.4 + Math.random() * 0.35
    ));
  }
  particles.push(new Particle(x, y, 0, 0, '#ffffff', 22, 0.22));
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    particles.push(new Particle(
      x, y,
      Math.cos(a) * 25, Math.sin(a) * 25,
      '#ffffff', 6, 0.28
    ));
  }
}

function spawnNukeParticles(particles, x, y) {
  // Large screen-filling burst from player position
  for (let i = 0; i < 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const speed = 80 + Math.random() * 200;
    const colors = ['#e67e22', '#e74c3c', '#f1c40f', '#ffffff'];
    particles.push(new Particle(
      x, y,
      Math.cos(a) * speed, Math.sin(a) * speed,
      colors[Math.floor(Math.random() * colors.length)],
      6 + Math.random() * 8,
      0.6 + Math.random() * 0.5
    ));
  }
  particles.push(new Particle(x, y, 0, 0, '#ffffff', 40, 0.35));
}

// =============================================================================
// POWERUP PICKUP CLASS
// =============================================================================

class Powerup {
  constructor(x, y, type) {
    this.x = x;
    this.y = y;
    this.type = type;
    this.radius = 11;
    this.dead = false;
    this.lifetime = 12;
    this.maxLifetime = 12;
    this.phase = Math.random() * Math.PI * 2;
  }

  update(dt) {
    this.lifetime -= dt;
    if (this.lifetime <= 0) this.dead = true;
  }

  draw(ctx, totalTime) {
    const bobY = Math.sin(totalTime * 2.8 + this.phase) * 3;
    const alpha = this.lifetime < 2.5 ? this.lifetime / 2.5 : 1;
    const def = POWERUP_DEFS[this.type];
    const R = this.radius;

    ctx.save();
    ctx.translate(this.x, this.y + bobY);
    ctx.globalAlpha = alpha;

    // Outer glow ring (pulsing)
    const pulse = 0.35 + 0.25 * Math.sin(totalTime * 5 + this.phase);
    ctx.strokeStyle = def.color;
    ctx.globalAlpha = alpha * pulse;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, 0, R + 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = alpha;

    // Dark background
    ctx.fillStyle = '#111';
    ctx.fillRect(-R, -R, R * 2, R * 2);
    // Colored border
    ctx.strokeStyle = def.color;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-R, -R, R * 2, R * 2);

    // Icon
    drawPowerupIcon(ctx, this.type, def.color);

    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

// =============================================================================
// BULLET
// =============================================================================

class Bullet {
  constructor(x, y, angle, owner) {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.owner = owner;
    this.speed = owner === 'player' ? 430 : 165;
    this.damage = owner === 'player' ? 25 : 15;
    this.radius = owner === 'player' ? 3 : 4;
    this.color = owner === 'player' ? '#f1c40f' : '#ff4444';
    this.dead = false;
    this.trail = [];
  }

  update(dt) {
    this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > 6) this.trail.shift();

    this.x += Math.cos(this.angle) * this.speed * dt;
    this.y += Math.sin(this.angle) * this.speed * dt;

    if (this.x < -25 || this.x > CANVAS_W + 25 ||
        this.y < -25 || this.y > CANVAS_H + 25) {
      this.dead = true;
    }
  }

  draw(ctx) {
    for (let i = 0; i < this.trail.length; i++) {
      const alpha = ((i + 1) / this.trail.length) * 0.45;
      const r = this.radius * ((i + 1) / this.trail.length);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = this.color;
      ctx.fillRect(this.trail[i].x - r, this.trail[i].y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = this.color;
    ctx.fillRect(this.x - this.radius, this.y - this.radius, this.radius * 2, this.radius * 2);
    ctx.fillStyle = '#ffffff';
    const cr = this.radius * 0.5;
    ctx.fillRect(this.x - cr, this.y - cr, cr * 2, cr * 2);
  }
}

// =============================================================================
// PLAYER
// =============================================================================

class Player {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.speed = 185;
    this.angle = 0;
    this.hp = 100;
    this.maxHp = 100;
    this.radius = 10;

    this.fireRate = 0.14;
    this.fireCooldown = 0;

    this.animFrame = 0;
    this.animTimer = 0;
    this.animSpeed = 0.11;
    this.isMoving = false;

    this.invincible = 0;
    this.INVINCIBLE_DURATION = 0.65;
    this.muzzleFlash = 0;
    this.dead = false;
    this.contactHurtTimer = 0;

    // Powerup tracking: type → remaining seconds
    this.activePowerups = {};
    this.pulseTimer = 0;
  }

  update(dt, input, bullets, particles) {
    // Tick down active timed powerups
    for (const type in this.activePowerups) {
      this.activePowerups[type] -= dt;
      if (this.activePowerups[type] <= 0) delete this.activePowerups[type];
    }
    this.pulseTimer += dt;

    // Aim at mouse
    this.angle = Math.atan2(input.mouseY - this.y, input.mouseX - this.x);

    // Movement (speed boost applied)
    const effectiveSpeed = this.activePowerups.speed ? this.speed * 1.65 : this.speed;
    const dx = input.right - input.left;
    const dy = input.down - input.up;
    const len = Math.hypot(dx, dy) || 1;
    this.isMoving = (dx !== 0 || dy !== 0);

    if (this.isMoving) {
      this.vx = (dx / len) * effectiveSpeed;
      this.vy = (dy / len) * effectiveSpeed;
    } else {
      this.vx *= 0.75;
      this.vy *= 0.75;
    }

    this.x = clamp(this.x + this.vx * dt, 14, CANVAS_W - 14);
    this.y = clamp(this.y + this.vy * dt, 14, CANVAS_H - 14);

    // Walk animation
    if (this.isMoving) {
      this.animTimer += dt;
      if (this.animTimer >= this.animSpeed) {
        this.animTimer = 0;
        this.animFrame = 1 - this.animFrame;
      }
    }

    // Shooting (rapid fire and spread shot applied)
    const effectiveFireRate = this.activePowerups.rapidfire ? this.fireRate * 0.3 : this.fireRate;
    this.fireCooldown -= dt;
    this.muzzleFlash -= dt;

    if (input.mouseDown && this.fireCooldown <= 0) {
      this.fireCooldown = effectiveFireRate;
      this.muzzleFlash = 0.08;
      const muzzleX = this.x + Math.cos(this.angle) * 22;
      const muzzleY = this.y + Math.sin(this.angle) * 22;
      bullets.push(new Bullet(muzzleX, muzzleY, this.angle, 'player'));
      if (this.activePowerups.spread) {
        bullets.push(new Bullet(muzzleX, muzzleY, this.angle - 0.28, 'player'));
        bullets.push(new Bullet(muzzleX, muzzleY, this.angle + 0.28, 'player'));
      }
      spawnMuzzleFlash(particles, muzzleX, muzzleY, this.angle);
      if (audio) audio.shoot();
    }

    if (this.invincible > 0) this.invincible -= dt;
  }

  takeBulletDamage(amount) {
    if (this.invincible > 0 || this.activePowerups.shield) return;
    this.hp = Math.max(0, this.hp - amount);
    this.invincible = this.INVINCIBLE_DURATION;
    if (audio) audio.playerHurt();
    if (this.hp <= 0) this.dead = true;
  }

  takeContactDamage(amountPerSec, dt) {
    if (this.activePowerups.shield) return;
    this.hp = Math.max(0, this.hp - amountPerSec * dt);
    this.contactHurtTimer -= dt;
    if (this.contactHurtTimer <= 0) {
      this.contactHurtTimer = 0.38;
      if (audio) audio.playerHurt();
    }
    if (this.hp <= 0) this.dead = true;
  }

  draw(ctx) {
    // Shield ring (drawn beneath sprite so it appears as an aura)
    if (this.activePowerups.shield) {
      const pulse = 0.55 + 0.45 * Math.sin(this.pulseTimer * 9);
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.strokeStyle = `rgba(241,196,15,${pulse})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(0, 0, 21, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${pulse * 0.4})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, 26, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Speed trail when speed boost is active
    if (this.activePowerups.speed && this.isMoving) {
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = '#3498db';
      ctx.fillRect(-6, -8, 12, 16);
      ctx.restore();
    }

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);
    drawPlayer(ctx, this.animFrame, this.muzzleFlash, this.invincible);
    ctx.restore();
  }
}

// =============================================================================
// ENEMY BASE
// =============================================================================

class Enemy {
  constructor(x, y, type) {
    this.x = x;
    this.y = y;
    this.type = type;
    this.angle = 0;
    this.hp = 0;
    this.maxHp = 0;
    this.speed = 0;
    this.radius = 0;
    this.damage = 0;
    this.scoreValue = 0;
    this.animFrame = 0;
    this.animTimer = 0;
    this.animSpeed = 0.2;
    this.dead = false;
    this.hitFlash = 0;
    this.color = '#fff';
  }

  _baseUpdate(dt, playerX, playerY) {
    this.angle = Math.atan2(playerY - this.y, playerX - this.x);
    this.animTimer += dt;
    if (this.animTimer >= this.animSpeed) {
      this.animTimer = 0;
      this.animFrame = 1 - this.animFrame;
    }
    if (this.hitFlash > 0) this.hitFlash -= dt;
  }

  takeDamage(amount, particles) {
    this.hp -= amount;
    this.hitFlash = 0.12;
    if (particles) spawnHitSpark(particles, this.x, this.y);
    if (this.hp <= 0) {
      this.dead = true;
      if (particles) spawnDeathParticles(particles, this.x, this.y, this.color);
      if (audio) audio.enemyDeath();
    } else {
      if (particles) spawnBloodPuff(particles, this.x, this.y, this.color);
      if (audio) audio.enemyHit();
    }
  }

  draw(ctx) {
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);
    this._drawSprite(ctx);
    ctx.restore();

    if (this.hp < this.maxHp && this.hp > 0) {
      const bw = this.radius * 2.8;
      const bx = this.x - bw / 2;
      const by = this.y - this.radius * 2.2 - 6;
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(bx, by, bw, 4);
      const ratio = this.hp / this.maxHp;
      ctx.fillStyle = ratio > 0.5 ? '#2ecc71' : ratio > 0.25 ? '#f39c12' : '#e74c3c';
      ctx.fillRect(bx, by, bw * ratio, 4);
      ctx.strokeStyle = '#555';
      ctx.lineWidth = 0.5;
      ctx.strokeRect(bx, by, bw, 4);
    }
  }

  _drawSprite(ctx) {}
}

// =============================================================================
// GRUNT
// =============================================================================

class Grunt extends Enemy {
  constructor(x, y) {
    super(x, y, 'grunt');
    this.hp = this.maxHp = 30;
    this.speed = 70 + Math.random() * 25;
    this.radius = 10;
    this.damage = 14;
    this.scoreValue = 10;
    this.color = '#e74c3c';
  }

  update(dt, playerX, playerY) {
    this._baseUpdate(dt, playerX, playerY);
    this.x += Math.cos(this.angle) * this.speed * dt;
    this.y += Math.sin(this.angle) * this.speed * dt;
  }

  _drawSprite(ctx) {
    drawGrunt(ctx, this.animFrame, this.hitFlash);
  }
}

// =============================================================================
// FLANKER
// =============================================================================

class Flanker extends Enemy {
  constructor(x, y) {
    super(x, y, 'flanker');
    this.hp = this.maxHp = 50;
    this.speed = 95;
    this.radius = 10;
    this.damage = 18;
    this.scoreValue = 20;
    this.color = '#9b59b6';
    this.animSpeed = 0.09;
    this.flankOffset = (Math.random() < 0.5 ? 1 : -1) * (0.6 + Math.random() * 0.4);
    this.flankDecay = 0.55;
  }

  update(dt, playerX, playerY) {
    this._baseUpdate(dt, playerX, playerY);
    this.flankOffset *= (1 - this.flankDecay * dt);
    const moveAngle = this.angle + this.flankOffset;
    this.x += Math.cos(moveAngle) * this.speed * dt;
    this.y += Math.sin(moveAngle) * this.speed * dt;
  }

  _drawSprite(ctx) {
    drawFlanker(ctx, this.animFrame, this.hitFlash);
  }
}

// =============================================================================
// TANK
// =============================================================================

class Tank extends Enemy {
  constructor(x, y) {
    super(x, y, 'tank');
    this.hp = this.maxHp = 150;
    this.speed = 35;
    this.radius = 18;
    this.damage = 30;
    this.scoreValue = 50;
    this.color = '#2c3e50';
    this.animSpeed = 0.22;
  }

  update(dt, playerX, playerY) {
    this._baseUpdate(dt, playerX, playerY);
    this.x += Math.cos(this.angle) * this.speed * dt;
    this.y += Math.sin(this.angle) * this.speed * dt;
  }

  _drawSprite(ctx) {
    drawTank(ctx, this.animFrame, this.hitFlash);
  }
}

// =============================================================================
// SHOOTER
// =============================================================================

class Shooter extends Enemy {
  constructor(x, y) {
    super(x, y, 'shooter');
    this.hp = this.maxHp = 65;
    this.speed = 55;
    this.radius = 11;
    this.damage = 4;
    this.scoreValue = 35;
    this.color = '#e67e22';
    this.preferredDist = 230;
    this.fireRate = 1.9;
    this.fireCooldown = 0.6 + Math.random() * 1.4;
    this.strafeDir = Math.random() < 0.5 ? 1 : -1;
    this.strafeTimer = 1.5 + Math.random() * 2;
  }

  update(dt, playerX, playerY, bullets) {
    this._baseUpdate(dt, playerX, playerY);

    const dist = Math.hypot(playerX - this.x, playerY - this.y);
    const diff = dist - this.preferredDist;

    if (Math.abs(diff) > 25) {
      const sign = diff > 0 ? 1 : -1;
      this.x += Math.cos(this.angle) * this.speed * 0.7 * sign * dt;
      this.y += Math.sin(this.angle) * this.speed * 0.7 * sign * dt;
    }

    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeDir *= -1;
      this.strafeTimer = 1.2 + Math.random() * 2;
    }
    this.x += Math.cos(this.angle + Math.PI / 2) * 28 * this.strafeDir * dt;
    this.y += Math.sin(this.angle + Math.PI / 2) * 28 * this.strafeDir * dt;

    this.fireCooldown -= dt;
    if (this.fireCooldown <= 0 && bullets) {
      this.fireCooldown = this.fireRate;
      const aimAngle = this.angle + (Math.random() - 0.5) * 0.18;
      bullets.push(new Bullet(this.x, this.y, aimAngle, 'enemy'));
      if (audio) audio.enemyShoot();
    }
  }

  _drawSprite(ctx) {
    drawShooter(ctx, this.animFrame, this.hitFlash);
  }
}

// =============================================================================
// SPAWN UTILS
// =============================================================================

function spawnEnemy(type) {
  const edge = Math.floor(Math.random() * 4);
  const m = 35;
  let x, y;
  switch (edge) {
    case 0: x = Math.random() * CANVAS_W; y = -m; break;
    case 1: x = CANVAS_W + m; y = Math.random() * CANVAS_H; break;
    case 2: x = Math.random() * CANVAS_W; y = CANVAS_H + m; break;
    default: x = -m; y = Math.random() * CANVAS_H; break;
  }
  switch (type) {
    case 'grunt':   return new Grunt(x, y);
    case 'flanker': return new Flanker(x, y);
    case 'tank':    return new Tank(x, y);
    case 'shooter': return new Shooter(x, y);
    default:        return new Grunt(x, y);
  }
}

// =============================================================================
// LEVEL DEFINITIONS
// =============================================================================

const LEVELS = [
  {
    name: 'SECTOR 1',
    killsToWin: 20,
    spawnInterval: 2.0,
    maxActiveEnemies: 6,
    spawnTable: [
      { type: 'grunt',   weight: 10 },
      { type: 'flanker', weight: 3 },
    ],
    bgColor: '#070714',
    gridColor: '#0c1228',
  },
  {
    name: 'SECTOR 2',
    killsToWin: 35,
    spawnInterval: 1.5,
    maxActiveEnemies: 9,
    spawnTable: [
      { type: 'grunt',   weight: 8 },
      { type: 'flanker', weight: 5 },
      { type: 'tank',    weight: 2 },
    ],
    bgColor: '#070f07',
    gridColor: '#0c1e0c',
  },
  {
    name: 'SECTOR 3',
    killsToWin: 50,
    spawnInterval: 1.0,
    maxActiveEnemies: 13,
    spawnTable: [
      { type: 'grunt',   weight: 6 },
      { type: 'flanker', weight: 5 },
      { type: 'tank',    weight: 3 },
      { type: 'shooter', weight: 4 },
    ],
    bgColor: '#110707',
    gridColor: '#220d0d',
  },
];

// =============================================================================
// INPUT MANAGER
// =============================================================================

class InputManager {
  constructor(canvas) {
    this._keys = {};
    this.mouseX = CANVAS_W / 2;
    this.mouseY = CANVAS_H / 2;
    this.mouseDown = false;
    this._muteJustPressed = false;

    window.addEventListener('keydown', e => {
      if (!this._keys[e.code] && e.code === 'KeyM') this._muteJustPressed = true;
      this._keys[e.code] = true;
      if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Space'].includes(e.code)) {
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', e => {
      this._keys[e.code] = false;
    });

    canvas.addEventListener('mousemove', e => {
      const r = canvas.getBoundingClientRect();
      const scaleX = CANVAS_W / r.width;
      const scaleY = CANVAS_H / r.height;
      this.mouseX = (e.clientX - r.left) * scaleX;
      this.mouseY = (e.clientY - r.top) * scaleY;
    });
    canvas.addEventListener('mousedown', e => {
      if (e.button === 0) this.mouseDown = true;
    });
    canvas.addEventListener('mouseup', e => {
      if (e.button === 0) this.mouseDown = false;
    });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  }

  get left()  { return (this._keys['ArrowLeft']  || this._keys['KeyA']) ? 1 : 0; }
  get right() { return (this._keys['ArrowRight'] || this._keys['KeyD']) ? 1 : 0; }
  get up()    { return (this._keys['ArrowUp']    || this._keys['KeyW']) ? 1 : 0; }
  get down()  { return (this._keys['ArrowDown']  || this._keys['KeyS']) ? 1 : 0; }

  consumeMuteToggle() {
    const v = this._muteJustPressed;
    this._muteJustPressed = false;
    return v;
  }
}

// =============================================================================
// HUD
// =============================================================================

function drawHUD(ctx, player, score, levelIdx, killCount, killsToWin, audioMuted) {
  const PAD = 12;

  // HP bar
  const BAR_W = 160, BAR_H = 14;
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(PAD, PAD, BAR_W, BAR_H);
  const hpRatio = player.hp / player.maxHp;
  ctx.fillStyle = hpRatio > 0.5 ? '#27ae60' : hpRatio > 0.25 ? '#f39c12' : '#e74c3c';
  ctx.fillRect(PAD, PAD, BAR_W * hpRatio, BAR_H);
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1;
  ctx.strokeRect(PAD, PAD, BAR_W, BAR_H);
  ctx.fillStyle = '#ecf0f1';
  ctx.font = '10px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`HP ${Math.ceil(player.hp)}/${player.maxHp}`, PAD + 4, PAD + 11);

  // Active powerup bars (below HP bar)
  const timedTypes = ['rapidfire', 'speed', 'spread', 'shield'];
  let py = PAD + BAR_H + 3;
  for (const type of timedTypes) {
    const remaining = player.activePowerups[type];
    if (!remaining) continue;
    const def = POWERUP_DEFS[type];
    const ratio = Math.min(remaining / def.duration, 1);

    ctx.fillStyle = '#111';
    ctx.fillRect(PAD, py, BAR_W, 9);
    ctx.fillStyle = def.color;
    ctx.fillRect(PAD, py, BAR_W * ratio, 9);
    ctx.strokeStyle = '#444';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(PAD, py, BAR_W, 9);
    ctx.fillStyle = '#000';
    ctx.font = '7px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`${def.label}  ${remaining.toFixed(1)}s`, PAD + 3, py + 7);
    py += 12;
  }

  // Score (center top)
  ctx.fillStyle = '#f1c40f';
  ctx.font = 'bold 20px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`SCORE: ${score}`, CANVAS_W / 2, PAD + 16);

  // Level name + mute indicator (top right)
  ctx.fillStyle = '#ecf0f1';
  ctx.font = '14px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(LEVELS[levelIdx].name, CANVAS_W - PAD, PAD + 14);
  ctx.fillStyle = audioMuted ? '#e74c3c' : '#555';
  ctx.font = '10px monospace';
  ctx.fillText(audioMuted ? '[M] MUTED' : '[M] SFX', CANVAS_W - PAD, PAD + 30);

  // Kill progress bar (bottom center)
  const KILL_W = 220;
  const kx = CANVAS_W / 2 - KILL_W / 2;
  const ky = CANVAS_H - 22;
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(kx, ky, KILL_W, 10);
  ctx.fillStyle = '#c0392b';
  ctx.fillRect(kx, ky, KILL_W * Math.min(killCount / killsToWin, 1), 10);
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1;
  ctx.strokeRect(kx, ky, KILL_W, 10);
  ctx.fillStyle = '#aaa';
  ctx.font = '11px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(`${killCount} / ${killsToWin} KILLS`, CANVAS_W / 2, ky - 3);
}

// =============================================================================
// MENU SCREEN
// =============================================================================

function drawMenu(ctx, tick) {
  ctx.fillStyle = '#030310';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  for (let y = 0; y < CANVAS_H; y += 2) {
    ctx.fillRect(0, y, CANVAS_W, 1);
  }

  ctx.strokeStyle = '#0d1130';
  ctx.lineWidth = 1;
  for (let x = 0; x <= CANVAS_W; x += 40) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CANVAS_H); ctx.stroke();
  }
  for (let y = 0; y <= CANVAS_H; y += 40) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CANVAS_W, y); ctx.stroke();
  }

  ctx.shadowColor = '#f1c40f';
  ctx.shadowBlur = 22;
  ctx.fillStyle = '#f1c40f';
  ctx.font = 'bold 68px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('SECTOR ZERO', CANVAS_W / 2, 155);
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#e74c3c';
  ctx.font = '18px monospace';
  ctx.fillText('TOP-DOWN ARCADE SHOOTER', CANVAS_W / 2, 193);

  ctx.strokeStyle = '#e74c3c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(CANVAS_W / 2 - 180, 207);
  ctx.lineTo(CANVAS_W / 2 + 180, 207);
  ctx.stroke();

  const pulse = 0.82 + 0.18 * Math.sin(tick * 3.2);
  ctx.globalAlpha = pulse;
  ctx.fillStyle = '#27ae60';
  ctx.fillRect(CANVAS_W / 2 - 100, 250, 200, 52);
  ctx.fillStyle = '#000';
  ctx.font = 'bold 26px monospace';
  ctx.fillText('► PLAY', CANVAS_W / 2, 285);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#2ecc71';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(CANVAS_W / 2 - 100, 250, 200, 52);

  ctx.fillStyle = '#7f8c8d';
  ctx.font = '13px monospace';
  ctx.fillText('ARROWS / WASD: Move    Mouse: Aim    LMB: Shoot', CANVAS_W / 2, 360);

  // Powerup legend
  ctx.fillStyle = '#555';
  ctx.font = '11px monospace';
  ctx.fillText('POWERUPS (walk over to collect):', CANVAS_W / 2, 400);

  const pwShowcase = [
    { x: 110, type: 'health' },
    { x: 210, type: 'rapidfire' },
    { x: 310, type: 'speed' },
    { x: 410, type: 'spread' },
    { x: 510, type: 'shield' },
    { x: 610, type: 'nuke' },
  ];
  for (const pw of pwShowcase) {
    const def = POWERUP_DEFS[pw.type];
    ctx.fillStyle = '#111';
    ctx.fillRect(pw.x - 11, 414, 22, 22);
    ctx.strokeStyle = def.color;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(pw.x - 11, 414, 22, 22);
    ctx.save();
    ctx.translate(pw.x, 425);
    drawPowerupIcon(ctx, pw.type, def.color);
    ctx.restore();
    ctx.fillStyle = def.color;
    ctx.font = '8px monospace';
    ctx.fillText(def.label, pw.x, 450);
  }

  // Enemy showcase
  ctx.fillStyle = '#555';
  ctx.font = '11px monospace';
  ctx.fillText('ENEMY TYPES:', CANVAS_W / 2, 475);

  const showcase = [
    { x: 175, color: '#e74c3c', label: 'GRUNT' },
    { x: 310, color: '#9b59b6', label: 'FLANKER' },
    { x: 455, color: '#2c3e50', label: 'TANK' },
    { x: 595, color: '#e67e22', label: 'SHOOTER' },
  ];
  for (const e of showcase) {
    ctx.fillStyle = e.color;
    ctx.fillRect(e.x - 11, 488, 22, 22);
    ctx.fillStyle = '#fff';
    ctx.fillRect(e.x - 6, 492, 3, 3);
    ctx.fillRect(e.x + 3, 492, 3, 3);
    ctx.fillStyle = '#888';
    ctx.font = '10px monospace';
    ctx.fillText(e.label, e.x, 526);
  }

  ctx.fillStyle = '#1e2a3a';
  ctx.font = '10px monospace';
  ctx.textAlign = 'right';
  ctx.fillText('v1.1', CANVAS_W - 8, CANVAS_H - 8);
  ctx.textAlign = 'center';
}

// =============================================================================
// LEVEL COMPLETE OVERLAY
// =============================================================================

function drawLevelComplete(ctx, completedLevelIdx, score, timer) {
  ctx.fillStyle = 'rgba(0,0,0,0.72)';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  ctx.shadowColor = '#2ecc71';
  ctx.shadowBlur = 18;
  ctx.fillStyle = '#2ecc71';
  ctx.font = 'bold 50px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('SECTOR CLEAR!', CANVAS_W / 2, 235);
  ctx.shadowBlur = 0;

  ctx.fillStyle = '#f1c40f';
  ctx.font = '24px monospace';
  ctx.fillText(`SCORE: ${score}`, CANVAS_W / 2, 290);

  const nextIdx = completedLevelIdx + 1;
  if (nextIdx < LEVELS.length) {
    ctx.fillStyle = '#ecf0f1';
    ctx.font = '20px monospace';
    ctx.fillText(`NEXT: ${LEVELS[nextIdx].name}`, CANVAS_W / 2, 335);

    ctx.fillStyle = '#2ecc71';
    ctx.font = '14px monospace';
    ctx.fillText('+30 HP RESTORED', CANVAS_W / 2, 365);

    ctx.fillStyle = '#7f8c8d';
    ctx.font = '16px monospace';
    ctx.fillText(`Advancing in ${Math.ceil(timer)}...`, CANVAS_W / 2, 398);
  } else {
    ctx.fillStyle = '#7f8c8d';
    ctx.font = '16px monospace';
    ctx.fillText(`Finishing in ${Math.ceil(timer)}...`, CANVAS_W / 2, 365);
  }
}

// =============================================================================
// GAME OVER OVERLAY
// =============================================================================

function drawGameOver(ctx, score, victory) {
  ctx.fillStyle = 'rgba(0,0,0,0.88)';
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  if (victory) {
    ctx.shadowColor = '#f1c40f';
    ctx.shadowBlur = 24;
    ctx.fillStyle = '#f1c40f';
    ctx.font = 'bold 58px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('VICTORY!', CANVAS_W / 2, 210);
    ctx.shadowBlur = 0;

    ctx.fillStyle = '#2ecc71';
    ctx.font = '22px monospace';
    ctx.fillText('ALL SECTORS CLEARED', CANVAS_W / 2, 260);
    ctx.fillStyle = '#27ae60';
    ctx.font = '14px monospace';
    ctx.fillText('You are a legend.', CANVAS_W / 2, 290);
  } else {
    ctx.shadowColor = '#e74c3c';
    ctx.shadowBlur = 20;
    ctx.fillStyle = '#e74c3c';
    ctx.font = 'bold 58px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('GAME OVER', CANVAS_W / 2, 210);
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#c0392b';
    ctx.font = '16px monospace';
    ctx.fillText('You were overwhelmed.', CANVAS_W / 2, 250);
  }

  ctx.fillStyle = '#f1c40f';
  ctx.font = '26px monospace';
  ctx.fillText(`FINAL SCORE: ${score}`, CANVAS_W / 2, 325);

  ctx.strokeStyle = victory ? '#f1c40f' : '#e74c3c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(CANVAS_W / 2 - 160, 345);
  ctx.lineTo(CANVAS_W / 2 + 160, 345);
  ctx.stroke();

  ctx.fillStyle = '#ecf0f1';
  ctx.font = '18px monospace';
  ctx.fillText('CLICK ANYWHERE TO PLAY AGAIN', CANVAS_W / 2, 395);
}

// =============================================================================
// CROSSHAIR
// =============================================================================

function drawCrosshair(ctx, mx, my) {
  ctx.strokeStyle = 'rgba(255,255,255,0.75)';
  ctx.lineWidth = 1;
  const GAP = 5;
  const LEN = 8;

  ctx.beginPath();
  ctx.moveTo(mx - GAP - LEN, my); ctx.lineTo(mx - GAP, my);
  ctx.moveTo(mx + GAP, my);       ctx.lineTo(mx + GAP + LEN, my);
  ctx.moveTo(mx, my - GAP - LEN); ctx.lineTo(mx, my - GAP);
  ctx.moveTo(mx, my + GAP);       ctx.lineTo(mx, my + GAP + LEN);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,80,80,0.9)';
  ctx.beginPath();
  ctx.arc(mx, my, 3, 0, Math.PI * 2);
  ctx.stroke();
}

// =============================================================================
// GAME CLASS
// =============================================================================

class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ctx.imageSmoothingEnabled = false;

    this.input = new InputManager(canvas);

    this.state = STATE.MENU;
    this.totalTime = 0;
    this.lastTime = 0;
    this.accumulator = 0;

    this.player = null;
    this.enemies = [];
    this.bullets = [];
    this.particles = [];
    this.powerups = [];

    this.score = 0;
    this.highScore = 0;
    this.currentLevel = 0;
    this.killCount = 0;
    this.spawnTimer = 0;
    this.levelCompleteTimer = 0;
    this.victory = false;

    this.powerupSpawnTimer = 15;
    this.MAX_TIMED_POWERUPS = 3;
    this.audioMuted = false;

    audio = new AudioManager();
    audio.startBGM();

    canvas.addEventListener('click', e => this._onClick(e));
  }

  _getMouseCanvas(e) {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = CANVAS_W / rect.width;
    const scaleY = CANVAS_H / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  _onClick(e) {
    const { x: mx, y: my } = this._getMouseCanvas(e);

    if (this.state === STATE.MENU) {
      const cx = CANVAS_W / 2;
      if (mx > cx - 100 && mx < cx + 100 && my > 250 && my < 302) {
        this._startGame();
      }
    } else if (this.state === STATE.GAME_OVER) {
      this.state = STATE.MENU;
    }
  }

  _startGame() {
    this.currentLevel = 0;
    this.score = 0;
    this.killCount = 0;
    this.victory = false;
    this.enemies = [];
    this.bullets = [];
    this.particles = [];
    this.powerups = [];
    this.player = new Player(CANVAS_W / 2, CANVAS_H / 2);
    this.spawnTimer = 1.2;
    this.powerupSpawnTimer = 15;
    this.state = STATE.PLAYING;
  }

  _transitionLevelComplete() {
    this.state = STATE.LEVEL_COMPLETE;
    this.levelCompleteTimer = 3.0;
    this.enemies = [];
    this.bullets = [];
    this.powerups = [];
    if (this.player) {
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + 30);
    }
    if (audio) audio.levelComplete();
  }

  _applyPowerup(type) {
    const def = POWERUP_DEFS[type];
    spawnPickupParticles(this.particles, this.player.x, this.player.y, def.color);
    if (audio) audio.powerupCollect(type);

    if (type === 'health') {
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + 35);
      this.score += 5;
    } else if (type === 'nuke') {
      spawnNukeParticles(this.particles, this.player.x, this.player.y);
      for (const e of this.enemies) {
        if (!e.dead) {
          this.score += e.scoreValue;
          this.killCount++;
          spawnDeathParticles(this.particles, e.x, e.y, e.color);
        }
      }
      this.enemies = [];
      this.score += 50;
    } else {
      // Timed buff — refresh duration if already active
      this.player.activePowerups[type] = def.duration;
    }
  }

  update(dt) {
    this.totalTime += dt;

    // Mute toggle works from any state
    if (this.input.consumeMuteToggle() && audio) {
      this.audioMuted = audio.toggle();
    }

    if (this.state === STATE.MENU || this.state === STATE.GAME_OVER) return;

    if (this.state === STATE.LEVEL_COMPLETE) {
      this.levelCompleteTimer -= dt;
      for (const p of this.particles) p.update(dt);
      this.particles = this.particles.filter(p => !p.dead);

      if (this.levelCompleteTimer <= 0) {
        this.currentLevel++;
        if (this.currentLevel >= LEVELS.length) {
          this.victory = true;
          if (this.score > this.highScore) this.highScore = this.score;
          this.state = STATE.GAME_OVER;
        } else {
          this.killCount = 0;
          this.spawnTimer = 2.0;
          this.powerupSpawnTimer = 12;
          this.state = STATE.PLAYING;
        }
      }
      return;
    }

    // === STATE.PLAYING ===
    const level = LEVELS[this.currentLevel];

    // Update player
    this.player.update(dt, this.input, this.bullets, this.particles);

    // Update enemies
    for (const e of this.enemies) {
      if (e.type === 'shooter') {
        e.update(dt, this.player.x, this.player.y, this.bullets);
      } else {
        e.update(dt, this.player.x, this.player.y);
      }
    }

    // Update bullets
    for (const b of this.bullets) b.update(dt);

    // Update particles
    for (const p of this.particles) p.update(dt);

    // Update powerup pickups
    for (const pw of this.powerups) pw.update(dt);

    // --- Collision: player bullets vs enemies ---
    for (const b of this.bullets) {
      if (b.dead || b.owner !== 'player') continue;
      for (const e of this.enemies) {
        if (e.dead) continue;
        if (circleCollide(b.x, b.y, b.radius, e.x, e.y, e.radius)) {
          b.dead = true;
          e.takeDamage(b.damage, this.particles);
          if (e.dead) {
            this.score += e.scoreValue;
            this.killCount++;
            // Roll enemy drop
            const dropDef = ENEMY_DROPS[e.type];
            if (dropDef && Math.random() < dropDef.chance) {
              const dropType = weightedRandom(dropDef.table);
              this.powerups.push(new Powerup(e.x, e.y, dropType));
            }
          }
          break;
        }
      }
    }

    // --- Collision: enemy bullets vs player ---
    for (const b of this.bullets) {
      if (b.dead || b.owner !== 'enemy') continue;
      if (circleCollide(b.x, b.y, b.radius, this.player.x, this.player.y, this.player.radius)) {
        b.dead = true;
        this.player.takeBulletDamage(b.damage);
      }
    }

    // --- Collision: enemy bodies vs player (contact damage) ---
    for (const e of this.enemies) {
      if (e.dead) continue;
      if (circleCollide(e.x, e.y, e.radius, this.player.x, this.player.y, this.player.radius)) {
        this.player.takeContactDamage(e.damage, dt);
      }
    }

    // --- Collision: player vs powerup pickups ---
    for (const pw of this.powerups) {
      if (pw.dead) continue;
      if (circleCollide(pw.x, pw.y, pw.radius, this.player.x, this.player.y, this.player.radius + 6)) {
        pw.dead = true;
        this._applyPowerup(pw.type);
      }
    }

    // Flush dead entities
    this.enemies   = this.enemies.filter(e => !e.dead);
    this.bullets   = this.bullets.filter(b => !b.dead);
    this.particles = this.particles.filter(p => !p.dead);
    this.powerups  = this.powerups.filter(pw => !pw.dead);

    // Win / death check
    if (this.killCount >= level.killsToWin) {
      this._transitionLevelComplete();
      return;
    }

    if (this.player.dead) {
      if (audio) audio.playerDeath();
      if (this.score > this.highScore) this.highScore = this.score;
      this.victory = false;
      this.state = STATE.GAME_OVER;
      return;
    }

    // Spawn new enemies
    this.spawnTimer -= dt;
    if (this.spawnTimer <= 0 && this.enemies.length < level.maxActiveEnemies) {
      this.spawnTimer = level.spawnInterval;
      const type = weightedRandom(level.spawnTable);
      this.enemies.push(spawnEnemy(type));
    }

    // Timed powerup spawn (map drops)
    this.powerupSpawnTimer -= dt;
    if (this.powerupSpawnTimer <= 0 && this.powerups.length < this.MAX_TIMED_POWERUPS) {
      this.powerupSpawnTimer = 12 + Math.random() * 6;
      const type = weightedRandom(TIMED_SPAWN_TABLE);
      const margin = 60;
      const px = margin + Math.random() * (CANVAS_W - margin * 2);
      const py = margin + Math.random() * (CANVAS_H - margin * 2);
      this.powerups.push(new Powerup(px, py, type));
    }
  }

  render() {
    const ctx = this.ctx;

    const wantHidden = this.state === STATE.PLAYING || this.state === STATE.LEVEL_COMPLETE;
    const cursorStyle = wantHidden ? 'none' : 'default';
    if (this.canvas.style.cursor !== cursorStyle) {
      this.canvas.style.cursor = cursorStyle;
    }

    if (this.state === STATE.MENU) {
      drawMenu(ctx, this.totalTime);
      return;
    }

    const levelIdx = Math.min(this.currentLevel, LEVELS.length - 1);
    const level = LEVELS[levelIdx];

    // Background
    drawBackground(ctx, level.bgColor, level.gridColor);

    // Powerup pickups (behind entities)
    for (const pw of this.powerups) pw.draw(ctx, this.totalTime);

    // Bullets
    for (const b of this.bullets) b.draw(ctx);

    // Enemies
    for (const e of this.enemies) e.draw(ctx);

    // Player
    if (this.player) this.player.draw(ctx);

    // Particles (always on top of entities)
    for (const p of this.particles) p.draw(ctx);

    // HUD
    if (this.player && (this.state === STATE.PLAYING || this.state === STATE.LEVEL_COMPLETE)) {
      drawHUD(ctx, this.player, this.score, levelIdx, this.killCount, level.killsToWin, this.audioMuted);
    }

    // Crosshair (playing only)
    if (this.state === STATE.PLAYING) {
      drawCrosshair(ctx, this.input.mouseX, this.input.mouseY);
    }

    // State overlays
    if (this.state === STATE.LEVEL_COMPLETE) {
      drawLevelComplete(ctx, this.currentLevel, this.score, this.levelCompleteTimer);
    } else if (this.state === STATE.GAME_OVER) {
      drawGameOver(ctx, this.score, this.victory);
    }
  }

  loop(timestamp) {
    const delta = Math.min(timestamp - this.lastTime, 50);
    this.lastTime = timestamp;
    this.accumulator += delta;

    while (this.accumulator >= FIXED_STEP) {
      this.update(FIXED_STEP / 1000);
      this.accumulator -= FIXED_STEP;
    }

    this.render();
    requestAnimationFrame(ts => this.loop(ts));
  }

  start() {
    requestAnimationFrame(ts => {
      this.lastTime = ts;
      this.loop(ts);
    });
  }
}

// =============================================================================
// BOOTSTRAP
// =============================================================================

window.addEventListener('load', () => {
  const canvas = document.getElementById('gameCanvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const game = new Game(canvas);
  game.start();
});
