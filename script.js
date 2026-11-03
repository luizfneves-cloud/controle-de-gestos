'use strict';

/* ============================================================================
   NÚCLEO DE ENERGIA v2 — Controle por gestos (MediaPipe Hands + Canvas 2D)

   Arquitetura (dois "relógios" independentes):
   1) MediaPipe  -> roda no ritmo da câmera (~30 fps) e chama onResults().
                    Ali ANALISAMOS as mãos, classificamos o gesto e emitimos
                    eventos (barramento `bus`) quando um gesto começa/termina.
   2) gameLoop   -> roda em requestAnimationFrame (~60 fps). Lê o estado das
                    mãos, atualiza a física e desenha tudo.

   Repertório de gestos:
     Pinça (1 mão)     agarra e arrasta o núcleo
     Pinça (2 mãos)    escala o núcleo
     Mão aberta        pulso de repulsão / varrer empurra e gira
     Punho             carrega o reator -> abrir a mão detona (supernova)
     Indicador         caneta holográfica, atrai partículas, escaneia o núcleo
     Sinal de paz      troca a formação (esfera, anel, DNA, cubo, átomo, galáxia)
     Joinha            estabiliza o núcleo
     Chifres           sobrecarga
     Palmas            onda sônica que reinicia o núcleo

   O `bus` e o objeto `trackedHands` são a "porta de entrada" para novos módulos
   (ex.: Sistema Solar, cards de informação): basta escutar os mesmos eventos.
   ============================================================================ */


/* ============================================================================
   1. CONFIGURAÇÃO (ajuste aqui para calibrar a sensação dos gestos)
   ============================================================================ */
const CONFIG = {
  videoAlpha: 0.28,

  core: {
    particleCount: 150,
    baseRadius: 110,
    minRadius: 45,
    maxRadiusFactor: 0.46,
    friction: 1.7,
    restitution: 0.72,
    springK: 45,
    springDamping: 5,
    maxThrowSpeed: 3500,
  },

  gestures: {
    pinchEnter: 0.35,       // razão polegar-indicador / tamanho da mão para iniciar pinça
    pinchExit: 0.55,        // razão para soltar (histerese)
    grabMargin: 60,
    handLostGraceMs: 150,
    stableFrames: 3,        // quadros seguidos para confirmar um gesto (anti-tremedeira)
  },

  pulse: {
    cooldownMs: 700,
    waveSpeed: 1100,
    impulse: 1700,
    holdRange: 280,
    holdForce: 2600,
  },

  charge: {
    seconds: 1.8,           // tempo de punho fechado até a carga máxima
    minDetonate: 0.35,      // carga mínima para a abertura da mão virar detonação
    releaseWindowMs: 600,   // tempo após soltar o punho em que abrir a mão ainda detona
    attractRange: 520,      // alcance em que o punho puxa o núcleo
  },

  clap: {
    windowMs: 450,
    farFactor: 2.6,         // as mãos precisam ter ficado afastadas pelo menos isto (x tamanho da mão)
    nearFactor: 1.4,        // e se aproximar até isto
    cooldownMs: 1100,
  },

  trails: { lifeMs: 2600, maxPoints: 420 },
  formationCooldownMs: 900,

  colors: { cyan: [0, 240, 255], magenta: [255, 0, 200], white: [255, 255, 255] },
};


/* ============================================================================
   2. UTILITÁRIOS
   ============================================================================ */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
const mixColor = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

const CYAN = CONFIG.colors.cyan;
const MAGENTA = CONFIG.colors.magenta;
const WHITE = CONFIG.colors.white;

const rotX = (p, a) => ({ x: p.x, y: p.y * Math.cos(a) - p.z * Math.sin(a), z: p.y * Math.sin(a) + p.z * Math.cos(a) });
const rotZ = (p, a) => ({ x: p.x * Math.cos(a) - p.y * Math.sin(a), y: p.x * Math.sin(a) + p.y * Math.cos(a), z: p.z });


/* ============================================================================
   3. BARRAMENTO DE EVENTOS E REGISTRO (log estilo J.A.R.V.I.S)
   ============================================================================ */
const bus = {
  handlers: {},
  on(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); },
  emit(evt, data) { (this.handlers[evt] || []).forEach((fn) => fn(data)); },
};

/* --- Modos do aplicativo e módulos plugáveis --------------------------------
   'core'  = Núcleo de Energia (original)
   'armor' / 'build' = módulo da armadura 3D (armor.js)
   Um módulo se registra em `modules` com ganchos opcionais:
   update(dt, now), drawWorld(ctx, now), drawUI(ctx, now),
   hudAction(now), hudCoreState(), hudRow()                                    */
let appMode = 'core';
const modules = [];

function setMode(mode, force = false) {
  if (mode === appMode && !force) return;
  const prev = appMode;
  appMode = mode;
  // zera os estados sustentados do núcleo ao trocar de modo
  core.stabilizeGoal = core.overdriveGoal = core.scanGoal = 0;
  core.charge = 0;
  interaction.mode = 'idle';
  interaction.prevMode = 'idle';
  interaction.points = [];
  trails.length = 0;
  activeStroke[0] = activeStroke[1] = null;
  actionFlash.until = 0;
  bus.emit('mode', { mode, prev });
}

const eventLog = [];      // mais recente primeiro
let logVersion = 0;
let lastLogText = '';
let lastLogAt = 0;

function logEvent(text, kind = 'info') {
  const now = performance.now();
  if (text === lastLogText && now - lastLogAt < 500) return; // evita spam
  lastLogText = text;
  lastLogAt = now;
  const time = new Date().toLocaleTimeString('pt-BR', { hour12: false });
  eventLog.unshift({ time, text, kind });
  if (eventLog.length > 6) eventLog.pop();
  logVersion++;
}

// Mensagem de "ação atual" que sobrepõe o texto contínuo por alguns instantes
const actionFlash = { text: '', state: 'idle', until: 0 };
function flashAction(text, state, ms = 1200) {
  actionFlash.text = text;
  actionFlash.state = state;
  actionFlash.until = performance.now() + ms;
}


/* ============================================================================
   4. DOM, CANVAS E VIEWPORT
   ============================================================================ */
const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const video = document.getElementById('webcam');

const overlay = document.getElementById('overlay');
const overlayMsg = document.getElementById('overlay-msg');
const btnStart = document.getElementById('btn-start');

const view = { w: window.innerWidth, h: window.innerHeight, dpr: 1 };
let gridLayer = null;

function resizeCanvas() {
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  canvas.width = Math.round(view.w * view.dpr);
  canvas.height = Math.round(view.h * view.dpr);
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  gridLayer = buildGridLayer();
}

function buildGridLayer() {
  const g = document.createElement('canvas');
  g.width = view.w;
  g.height = view.h;
  const c = g.getContext('2d');
  const step = 60;
  c.strokeStyle = rgba(CYAN, 0.05);
  c.lineWidth = 1;
  c.beginPath();
  for (let x = 0; x <= view.w; x += step) { c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, view.h); }
  for (let y = 0; y <= view.h; y += step) { c.moveTo(0, y + 0.5); c.lineTo(view.w, y + 0.5); }
  c.stroke();
  return g;
}


/* ============================================================================
   5. CONVERSÃO DE COORDENADAS (IA 0.0–1.0 -> pixels do canvas)
   Vídeo em modo "cover" e ESPELHADO; landmarks usam o mesmo retângulo.
   ============================================================================ */
function getVideoRect() {
  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;
  const scale = Math.max(view.w / vw, view.h / vh);
  const w = vw * scale;
  const h = vh * scale;
  return { x: (view.w - w) / 2, y: (view.h - h) / 2, w, h };
}

function landmarkToCanvas(lm, rect) {
  return { x: rect.x + (1 - lm.x) * rect.w, y: rect.y + lm.y * rect.h };
}


/* ============================================================================
   6. RECONHECIMENTO DE GESTOS
   ============================================================================ */
const LM = { WRIST: 0, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4, INDEX_MCP: 5, INDEX_PIP: 6, INDEX_TIP: 8, MIDDLE_MCP: 9, PINKY_MCP: 17 };
const FINGER_JOINTS = [[6, 8], [10, 12], [14, 16], [18, 20]]; // [PIP, ponta]: indicador, médio, anelar, mindinho
const TIP_INDICES = [4, 8, 12, 16, 20];
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

const GESTURE_LABEL = {
  pinch: 'Pinça', open: 'Mão aberta', fist: 'Punho', point: 'Indicador',
  victory: 'Sinal de paz', thumbsup: 'Joinha', rock: 'Chifres', other: 'Neutro',
};

function makeMemory() {
  return {
    pinching: false,
    raw: 'other', frames: 0, stable: 'other',
    lastPulse: 0,
    prevPalm: null, prevT: 0, vel: { x: 0, y: 0 },
  };
}

let trackedHands = [];
let lastHandsSeen = 0;
const handMemory = [makeMemory(), makeMemory()];

function resetHandMemory(from = 0) {
  for (let i = from; i < handMemory.length; i++) handMemory[i] = makeMemory();
}

/**
 * Converte os 21 landmarks em pixels, descobre qual gesto está sendo feito e
 * emite o evento 'gesture' quando o gesto ESTÁVEL muda.
 * Toda a matemática é feita em pixels e normalizada pelo tamanho da mão,
 * então funciona em qualquer distância da câmera.
 */
function analyzeHand(landmarks, index, rect, now) {
  const pts = landmarks.map((lm) => landmarkToCanvas(lm, rect));
  const mem = handMemory[index];
  const wrist = pts[LM.WRIST];
  const handSize = dist(wrist, pts[LM.MIDDLE_MCP]) || 1;
  const G = CONFIG.gestures;

  // --- Pinça (com histerese) -------------------------------------------
  const pinchRatio = dist(pts[LM.THUMB_TIP], pts[LM.INDEX_TIP]) / handSize;
  const pinching = mem.pinching ? pinchRatio < G.pinchExit : pinchRatio < G.pinchEnter;
  mem.pinching = pinching;

  // --- Dedos esticados: a ponta está mais longe do punho que a articulação PIP
  const ext = FINGER_JOINTS.map(([pip, tip]) => dist(pts[tip], wrist) > dist(pts[pip], wrist) * 1.12);
  const [idx, mid, ring, pinky] = ext;
  const extCount = ext.filter(Boolean).length;

  // Polegar: ponta mais longe do mindinho que a articulação IP e afastada do indicador
  const thumbExt =
    dist(pts[LM.THUMB_TIP], pts[LM.PINKY_MCP]) > dist(pts[LM.THUMB_IP], pts[LM.PINKY_MCP]) * 1.05 &&
    dist(pts[LM.THUMB_TIP], pts[LM.INDEX_MCP]) / handSize > 0.45;
  // Joinha: polegar bem acima do punho e da base do polegar
  const thumbUp =
    thumbExt &&
    pts[LM.THUMB_TIP].y < pts[LM.THUMB_MCP].y - handSize * 0.35 &&
    pts[LM.THUMB_TIP].y < wrist.y - handSize * 0.5;

  // --- Classificação bruta ---------------------------------------------
  let raw;
  if (pinching) raw = 'pinch';
  else if (extCount === 4) raw = 'open'; // 4 dedos esticados (o polegar é opcional: mais confiável)
  else if (extCount === 0) raw = thumbUp ? 'thumbsup' : 'fist';
  else if (idx && !mid && !ring && !pinky) raw = 'point';
  else if (idx && mid && !ring && !pinky) raw = 'victory';
  else if (idx && !mid && !ring && pinky) raw = 'rock';
  else raw = 'other';

  // --- Debounce: o gesto só vira "estável" após alguns quadros iguais ----
  if (raw === mem.raw) mem.frames++; else { mem.raw = raw; mem.frames = 1; }
  const prevStable = mem.stable;
  // Entrar/sair da pinça é imediato (precisa de resposta rápida); o resto é debounced
  if (raw === 'pinch' || prevStable === 'pinch' || mem.frames >= G.stableFrames) mem.stable = raw;
  const gesture = mem.stable;

  // --- Centro da palma e velocidade da palma (para "varrer") ------------
  const palmIdx = [0, 5, 9, 13, 17];
  const palm = {
    x: palmIdx.reduce((s, i) => s + pts[i].x, 0) / palmIdx.length,
    y: palmIdx.reduce((s, i) => s + pts[i].y, 0) / palmIdx.length,
  };
  if (mem.prevPalm && now - mem.prevT < 200) {
    const dtS = Math.max((now - mem.prevT) / 1000, 0.001);
    mem.vel.x = lerp(mem.vel.x, (palm.x - mem.prevPalm.x) / dtS, 0.5);
    mem.vel.y = lerp(mem.vel.y, (palm.y - mem.prevPalm.y) / dtS, 0.5);
  } else {
    mem.vel.x = mem.vel.y = 0;
  }
  mem.prevPalm = palm;
  mem.prevT = now;

  const hand = {
    index, pts, handSize, pinchRatio, pinching, gesture,
    label: GESTURE_LABEL[gesture] || 'Neutro',
    palm,
    palmVel: { x: mem.vel.x, y: mem.vel.y },
    pinchPoint: {
      x: (pts[LM.THUMB_TIP].x + pts[LM.INDEX_TIP].x) / 2,
      y: (pts[LM.THUMB_TIP].y + pts[LM.INDEX_TIP].y) / 2,
    },
  };

  if (prevStable !== gesture) bus.emit('gesture', { hand, index, from: prevStable, to: gesture, now });
  return hand;
}

/* --- Palmas (clap): mãos muito afastadas que se encontram rapidamente --- */
const clap = { hist: [], size: 1, last: 0, mid: { x: 0, y: 0 }, blocked: false };

function detectClap(hands, now) {
  const C = CONFIG.clap;

  if (hands.length >= 2) {
    clap.size = (hands[0].handSize + hands[1].handSize) / 2;
    const d = dist(hands[0].palm, hands[1].palm);
    clap.mid = { x: (hands[0].palm.x + hands[1].palm.x) / 2, y: (hands[0].palm.y + hands[1].palm.y) / 2 };
    clap.blocked = hands.some((h) => h.pinching); // escalar com pinça não é palma
    clap.hist.push({ t: now, d });
    while (clap.hist.length && now - clap.hist[0].t > C.windowMs) clap.hist.shift();
    tryClap(d, C.nearFactor, now);
  } else if (clap.hist.length) {
    // Ao bater palmas as mãos se sobrepõem e o MediaPipe costuma perder uma delas.
    // Usamos o último valor conhecido (um pouco mais tolerante).
    const last = clap.hist[clap.hist.length - 1];
    if (now - last.t < 250) tryClap(last.d, C.nearFactor * 1.5, now);
    else clap.hist.length = 0;
  }
}

function tryClap(d, nearFactor, now) {
  const C = CONFIG.clap;
  if (clap.blocked || now - clap.last < C.cooldownMs) return;
  const far = clap.hist.reduce((m, h) => Math.max(m, h.d), 0);
  if (d < clap.size * nearFactor && far > clap.size * C.farFactor) {
    clap.last = now;
    clap.hist.length = 0;
    bus.emit('clap', { x: clap.mid.x, y: clap.mid.y, now });
  }
}

/** Callback do MediaPipe: chamado a cada frame processado da câmera. */
function onResults(results) {
  const now = performance.now();
  const lms = results.multiHandLandmarks || [];

  if (lms.length > 0) {
    const rect = getVideoRect();
    trackedHands = lms.slice(0, 2).map((lm, i) => analyzeHand(lm, i, rect, now));
    lastHandsSeen = now;
    resetHandMemory(lms.length); // memória das mãos que sumiram
    detectClap(trackedHands, now);
  } else {
    detectClap([], now);
    if (now - lastHandsSeen > CONFIG.gestures.handLostGraceMs) {
      trackedHands = [];
      resetHandMemory(0);
    }
  }
}


/* ============================================================================
   7. FORMAÇÕES (cada uma é um conjunto de pontos que as partículas assumem)
   ============================================================================ */
const FORMATIONS = [
  { id: 'sphere', name: 'Esfera estável', build: buildSphere },
  { id: 'planet', name: 'Anel planetário', build: buildPlanet },
  { id: 'dna', name: 'Hélice dupla', build: buildDNA },
  { id: 'cube', name: 'Cubo de dados', build: buildCube },
  { id: 'atom', name: 'Átomo', build: buildAtom },
  { id: 'galaxy', name: 'Galáxia espiral', build: buildGalaxy },
];

const GOLDEN = Math.PI * (3 - Math.sqrt(5));

function fibonacciSphere(count, radius, inner = false) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const r = Math.sqrt(1 - y * y);
    const th = i * GOLDEN;
    out.push({ x: Math.cos(th) * r * radius, y: y * radius, z: Math.sin(th) * r * radius, inner });
  }
  return out;
}

// "inner: true" = partícula nasce magenta; "false" = ciano.
function buildSphere(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const th = i * GOLDEN;
    const surface = Math.random() < 0.6;
    const k = surface ? 1 : rand(0.3, 0.8);
    out.push({ x: Math.cos(th) * r * k, y: y * k, z: Math.sin(th) * r * k, inner: !surface });
  }
  return out;
}

function buildPlanet(n) {
  const nS = Math.round(n * 0.32);
  const out = fibonacciSphere(nS, 0.5, false);
  for (let i = 0; i < n - nS; i++) {
    const r = 0.8 + 0.55 * Math.sqrt(Math.random());
    const a = rand(0, Math.PI * 2);
    let p = { x: Math.cos(a) * r, y: rand(-0.02, 0.02), z: Math.sin(a) * r };
    p = rotZ(rotX(p, 0.5), 0.35);
    out.push({ ...p, inner: true });
  }
  return out;
}

function buildDNA(n) {
  const out = [];
  const strands = Math.floor((n * 0.8) / 2) * 2;
  const perStrand = strands / 2;
  for (let i = 0; i < strands; i++) {
    const strand = i % 2;
    const t = Math.floor(i / 2) / perStrand;
    const ang = t * 4 * Math.PI + strand * Math.PI;
    out.push({ x: Math.cos(ang) * 0.5, y: t * 2 - 1, z: Math.sin(ang) * 0.5, inner: strand === 1 });
  }
  const rungs = n - strands;
  for (let k = 0; k < rungs; k++) {
    const t = (k + 0.5) / rungs;
    const ang = t * 4 * Math.PI;
    const s = ((k % 5) / 4) * 2 - 1;
    out.push({ x: Math.cos(ang) * 0.5 * s, y: t * 2 - 1, z: Math.sin(ang) * 0.5 * s, inner: false });
  }
  return out;
}

function buildCube(n) {
  const s = 0.72;
  const verts = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) verts.push({ x: sx * s, y: sy * s, z: sz * s });
  const out = verts.map((v) => ({ ...v, inner: false }));
  for (let i = 0; i < 8; i++) {
    for (let j = i + 1; j < 8; j++) {
      const diff = (verts[i].x !== verts[j].x) + (verts[i].y !== verts[j].y) + (verts[i].z !== verts[j].z);
      if (diff !== 1) continue; // só vértices vizinhos formam uma aresta
      for (let k = 1; k <= 11; k++) {
        const t = k / 12;
        out.push({
          x: lerp(verts[i].x, verts[j].x, t),
          y: lerp(verts[i].y, verts[j].y, t),
          z: lerp(verts[i].z, verts[j].z, t),
          inner: false,
        });
      }
    }
  }
  while (out.length < n) out.push({ x: rand(-0.2, 0.2), y: rand(-0.2, 0.2), z: rand(-0.2, 0.2), inner: true });
  return out.slice(0, n);
}

function buildAtom(n) {
  const out = [];
  for (let i = 0; i < 18; i++) {
    const v = { x: rand(-1, 1), y: rand(-1, 1), z: rand(-1, 1) };
    const m = Math.hypot(v.x, v.y, v.z) || 1;
    const r = rand(0.05, 0.2);
    out.push({ x: (v.x / m) * r, y: (v.y / m) * r, z: (v.z / m) * r, inner: true });
  }
  const per = Math.floor((n - 18) / 3);
  for (let k = 0; k < 3; k++) {
    for (let i = 0; i < per; i++) {
      const th = (i / per) * Math.PI * 2;
      let p = { x: Math.cos(th), y: Math.sin(th) * 0.45, z: 0 };
      p = rotX(rotZ(p, (k * Math.PI) / 3), k * 0.9 + 0.3);
      out.push({ ...p, inner: false });
    }
  }
  while (out.length < n) out.push({ x: rand(-0.15, 0.15), y: rand(-0.15, 0.15), z: rand(-0.15, 0.15), inner: true });
  return out;
}

function buildGalaxy(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = Math.pow(i / n, 0.8);
    const arm = i % 2;
    const r = 0.1 + 1.15 * t;
    const ang = t * 5.5 + arm * Math.PI + rand(-0.17, 0.17);
    const p = rotX({ x: Math.cos(ang) * r, y: rand(-0.06, 0.06) * (1 - t * 0.5), z: Math.sin(ang) * r }, 0.5);
    out.push({ ...p, inner: t < 0.25 });
  }
  return out;
}

FORMATIONS.forEach((f) => { f.points = f.build(CONFIG.core.particleCount); });


/* ============================================================================
   8. CLASSE EnergyCore
   ============================================================================ */
class EnergyCore {
  constructor(x, y) {
    this.pos = { x, y };
    this.vel = { x: 0, y: 0 };
    this.radius = CONFIG.core.baseRadius;
    this.targetRadius = this.radius;
    this.grabbed = false;

    this.chaos = 0;        // 0..1 vibração das partículas
    this.stress = 0;       // 0..1 mistura de cor ciano -> magenta
    this.charge = 0;       // 0..1 carga do reator (punho)
    this.integrity = 1;    // 0..1 (0 = acabou de explodir; volta a 1 reformando)
    this.reformDelay = 0;
    this.alphaMul = 1;     // multiplicador de opacidade (o reator some ao ficar de costas)

    this.stabilize = 0;  this.stabilizeGoal = 0;   // joinha
    this.overdrive = 0;  this.overdriveGoal = 0;   // chifres
    this.scan = 0;       this.scanGoal = 0;        // indicador apontado ao núcleo

    this.spin = 0;
    this.rotY = 0;
    this.rotX = 0.4;
    this.time = 0;
    this.formationIndex = 0;

    this.particles = this.createParticles(CONFIG.core.particleCount);
    this.spriteCyan = EnergyCore.createGlowSprite(CYAN);
    this.spriteMagenta = EnergyCore.createGlowSprite(MAGENTA);
    this.setFormation(0, true);
  }

  createParticles(n) {
    const list = [];
    for (let i = 0; i < n; i++) {
      list.push({
        x: 0, y: 0, z: 0, tx: 0, ty: 0, tz: 0, // posição atual e alvo (formação)
        tint: 0, tInner: false,                // 0 = ciano, 1 = magenta
        size: rand(0.8, 1.6),
        ox: 0, oy: 0, ovx: 0, ovy: 0,          // deslocamento/velocidade da mola
        sx: 0, sy: 0, depth: 0,                // projeção 2D
      });
    }
    return list;
  }

  static createGlowSprite(color) {
    const size = 64;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.18, rgba(color, 0.95));
    grad.addColorStop(0.5, rgba(color, 0.28));
    grad.addColorStop(1, rgba(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
    return c;
  }

  /** Troca a formação: as partículas "derretem" até os novos pontos (morph). */
  setFormation(i, instant = false) {
    this.formationIndex = (i + FORMATIONS.length) % FORMATIONS.length;
    const pts = FORMATIONS[this.formationIndex].points;
    this.particles.forEach((p, j) => {
      const t = pts[j % pts.length];
      p.tx = t.x; p.ty = t.y; p.tz = t.z; p.tInner = t.inner;
      if (instant) { p.x = t.x; p.y = t.y; p.z = t.z; p.tint = t.inner ? 1 : 0; }
    });
  }

  /** Segura o núcleo: segue o alvo suavemente e mede a velocidade (para o arremesso). */
  grabTo(target, dt) {
    const k = 1 - Math.exp(-dt * 18);
    const nx = this.pos.x + (target.x - this.pos.x) * k;
    const ny = this.pos.y + (target.y - this.pos.y) * k;
    this.vel.x = this.vel.x * 0.6 + ((nx - this.pos.x) / dt) * 0.4;
    this.vel.y = this.vel.y * 0.6 + ((ny - this.pos.y) / dt) * 0.4;
    this.pos.x = nx;
    this.pos.y = ny;
    this.grabbed = true;
  }

  applyImpulse(fx, fy) {
    if (this.grabbed) return;
    this.vel.x += fx;
    this.vel.y += fy;
  }

  /** Tranco aleatório nas partículas (vibração / explosão). */
  shake(amount) {
    const power = amount * this.radius * 4;
    for (const p of this.particles) {
      const a = rand(0, Math.PI * 2);
      const m = power * rand(0.4, 1);
      p.ovx += Math.cos(a) * m;
      p.ovy += Math.sin(a) * m;
    }
    this.chaos = Math.max(this.chaos, Math.min(1, amount));
  }

  keepInside(bounce) {
    const m = this.radius * 0.9;
    const e = CONFIG.core.restitution;
    if (this.pos.x < m) { this.pos.x = m; if (bounce) this.vel.x = Math.abs(this.vel.x) * e; }
    if (this.pos.x > view.w - m) { this.pos.x = view.w - m; if (bounce) this.vel.x = -Math.abs(this.vel.x) * e; }
    if (this.pos.y < m) { this.pos.y = m; if (bounce) this.vel.y = Math.abs(this.vel.y) * e; }
    if (this.pos.y > view.h - m) { this.pos.y = view.h - m; if (bounce) this.vel.y = -Math.abs(this.vel.y) * e; }
  }

  update(dt) {
    const cfg = CONFIG.core;
    this.time += dt;
    const smooth = (v, goal, rate) => v + (goal - v) * (1 - Math.exp(-dt * rate));

    // Estados suavizados (os "alvos" são definidos pelas ações de gesto)
    this.stabilize = smooth(this.stabilize, this.stabilizeGoal, 5);
    this.overdrive = smooth(this.overdrive, this.overdriveGoal, 4);
    this.scan = smooth(this.scan, this.scanGoal, 6);

    // Reforma depois de uma detonação
    if (this.integrity < 1) {
      if (this.reformDelay > 0) this.reformDelay -= dt;
      else this.integrity = Math.min(1, this.integrity + (1 - this.integrity) * (1 - Math.exp(-dt * 1.6)) + dt * 0.12);
    }

    // Raio elástico
    this.radius += (this.targetRadius - this.radius) * (1 - Math.exp(-dt * 9));

    // Joinha: ímã suave para o centro da tela + volta ao tamanho base + acalma
    if (this.stabilize > 0.02 && !this.grabbed) {
      const k = this.stabilize;
      this.vel.x += (view.w / 2 - this.pos.x) * 6 * k * dt;
      this.vel.y += (view.h / 2 - this.pos.y) * 6 * k * dt;
      const f = Math.exp(-5 * k * dt);
      this.vel.x *= f;
      this.vel.y *= f;
      this.chaos *= Math.exp(-dt * 6 * k);
      this.targetRadius += (cfg.baseRadius - this.targetRadius) * (1 - Math.exp(-dt * 2.5)) * k;
    }

    // --- Física de inércia + atrito -------------------------------------
    if (!this.grabbed) {
      const sp = Math.hypot(this.vel.x, this.vel.y);
      if (sp > cfg.maxThrowSpeed) {
        this.vel.x *= cfg.maxThrowSpeed / sp;
        this.vel.y *= cfg.maxThrowSpeed / sp;
      }
      this.pos.x += this.vel.x * dt;
      this.pos.y += this.vel.y * dt;
      const f = Math.exp(-cfg.friction * dt);
      this.vel.x *= f;
      this.vel.y *= f;
      if (Math.hypot(this.vel.x, this.vel.y) < 4) { this.vel.x = 0; this.vel.y = 0; }
      this.keepInside(true);
    } else {
      this.keepInside(false);
    }

    // --- Caos e "estresse" (cor) -----------------------------------------
    this.chaos *= Math.exp(-dt * 2.2);
    if (this.overdrive > 0.02) this.chaos = Math.max(this.chaos, this.overdrive * (0.35 + 0.25 * Math.sin(this.time * 14)));
    if (this.charge > 0.02) this.chaos = Math.max(this.chaos, this.charge * 0.35);

    const speed = Math.hypot(this.vel.x, this.vel.y);
    let stressGoal =
      this.chaos + speed / 2200 + (this.grabbed ? 0.25 : 0) +
      this.overdrive * 0.5 * (0.5 + 0.5 * Math.sin(this.time * 10)) + this.charge * 0.5;
    stressGoal = clamp(stressGoal, 0, 1) * (1 - 0.85 * this.stabilize);
    this.stress += (stressGoal - this.stress) * (1 - Math.exp(-dt * 8));

    // --- Rotação ---------------------------------------------------------
    this.spin *= Math.exp(-dt * 1.2);
    this.rotY += (0.5 + this.stress * 3 + this.overdrive * 5 + this.spin) * dt;
    this.rotX = 0.4 + Math.sin(this.time * 0.4) * 0.25;

    // --- Partículas: morph + mola amortecida + ruído ---------------------
    // Logo após detonar, a mola fica fraca: as partículas voam longe e voltam devagar.
    const integ = this.integrity;
    const kEff = cfg.springK * (0.08 + 0.92 * integ * integ);
    const cEff = cfg.springDamping * (0.5 + 0.5 * integ);
    const morph = 1 - Math.exp(-dt * 3.2);
    const kick = this.chaos * this.radius * 0.8 * dt * 60;

    for (const p of this.particles) {
      p.x += (p.tx - p.x) * morph;
      p.y += (p.ty - p.y) * morph;
      p.z += (p.tz - p.z) * morph;
      p.tint += ((p.tInner ? 1 : 0) - p.tint) * morph;

      if (kick > 0.01) {
        p.ovx += (Math.random() - 0.5) * kick;
        p.ovy += (Math.random() - 0.5) * kick;
      }
      p.ovx += (-kEff * p.ox - cEff * p.ovx) * dt;
      p.ovy += (-kEff * p.oy - cEff * p.ovy) * dt;
      p.ox += p.ovx * dt;
      p.oy += p.ovy * dt;
    }
  }

  /** Raio efetivo desenhado (respira e comprime ao carregar). */
  get drawRadius() {
    return this.radius * (1 + 0.025 * Math.sin(this.time * 2.2)) * (1 - 0.4 * this.charge);
  }

  project(R) {
    const cy = Math.cos(this.rotY), sy = Math.sin(this.rotY);
    const cx = Math.cos(this.rotX), sx = Math.sin(this.rotX);
    for (const p of this.particles) {
      const x1 = p.x * cy + p.z * sy;
      const z1 = -p.x * sy + p.z * cy;
      const y2 = p.y * cx - z1 * sx;
      const z2 = p.y * sx + z1 * cx;
      const persp = 1 / (1 - z2 * 0.35);
      p.sx = this.pos.x + x1 * R * persp + p.ox;
      p.sy = this.pos.y + y2 * R * persp + p.oy;
      p.depth = (z2 + 1) / 2;
    }
  }

  draw(c) {
    const R = this.drawRadius;
    this.project(R);

    const integ = this.integrity;
    const s = this.stress;
    let col = mixColor(CYAN, MAGENTA, s);
    col = mixColor(col, WHITE, this.charge * 0.55);
    const x = this.pos.x;
    const y = this.pos.y;

    c.save();
    c.globalCompositeOperation = 'lighter';

    // 1) Brilho central
    const glow = c.createRadialGradient(x, y, 0, x, y, R * 0.9);
    glow.addColorStop(0, `rgba(255,255,255,${(0.30 + s * 0.2 + this.charge * 0.4) * integ * this.alphaMul})`);
    glow.addColorStop(0.25, rgba(col, (0.22 + s * 0.12 + this.charge * 0.2) * integ * this.alphaMul));
    glow.addColorStop(1, rgba(col, 0));
    c.fillStyle = glow;
    c.beginPath();
    c.arc(x, y, R * 0.9, 0, Math.PI * 2);
    c.fill();

    // 2) Anéis do "reator" (peças de HUD em volta do núcleo)
    const ringAlpha = integ * integ * this.alphaMul;
    c.shadowColor = rgba(this.grabbed ? MAGENTA : CYAN, 1);
    c.shadowBlur = 14;

    // 2a) anel tracejado (sólido e magenta quando segurado)
    c.lineWidth = this.grabbed ? 2.5 : 1.5;
    c.strokeStyle = rgba(this.grabbed ? MAGENTA : CYAN, (this.grabbed ? 0.9 : 0.4) * ringAlpha);
    c.setLineDash(this.grabbed ? [] : [8, 12]);
    c.lineDashOffset = -this.time * 24;
    c.beginPath();
    c.arc(x, y, R * 1.2, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);

    // 2b) três arcos girando ao contrário (aceleram ao escanear)
    c.lineWidth = 3;
    c.strokeStyle = rgba(mixColor(CYAN, MAGENTA, 0.25 + s * 0.5), (0.45 + this.scan * 0.4) * ringAlpha);
    const arcStart = -this.time * (0.7 + this.scan * 2.5);
    for (let k = 0; k < 3; k++) {
      const a0 = arcStart + (k * Math.PI * 2) / 3;
      c.beginPath();
      c.arc(x, y, R * 1.38, a0, a0 + 1.0);
      c.stroke();
    }
    c.shadowBlur = 0;

    // 2c) régua de marcas
    if (integ > 0.4) {
      c.lineWidth = 1;
      c.strokeStyle = rgba(CYAN, 0.25 * ringAlpha);
      c.beginPath();
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * Math.PI * 2 + this.time * 0.15;
        const r0 = R * 1.52;
        const r1 = r0 + R * (i % 6 === 0 ? 0.07 : 0.035);
        c.moveTo(x + Math.cos(a) * r0, y + Math.sin(a) * r0);
        c.lineTo(x + Math.cos(a) * r1, y + Math.sin(a) * r1);
      }
      c.stroke();
    }

    // 2d) anéis convergindo (carga do reator)
    if (this.charge > 0.03) {
      for (let k = 0; k < 3; k++) {
        const ph = (this.time * 1.6 + k / 3) % 1;
        c.strokeStyle = rgba(mixColor(MAGENTA, WHITE, ph), this.charge * ph * 0.9);
        c.lineWidth = 1 + ph * 3;
        c.beginPath();
        c.arc(x, y, R * (2.5 - 1.5 * ph), 0, Math.PI * 2);
        c.stroke();
      }
    }

    // 2e) travas hexagonais (joinha = núcleo estabilizado)
    if (this.stabilize > 0.03) {
      const hr = R * 1.7;
      const rot = this.time * 0.25;
      c.strokeStyle = rgba(mixColor(CYAN, WHITE, 0.4), this.stabilize * 0.9);
      c.shadowColor = rgba(CYAN, 1);
      c.shadowBlur = 16;
      c.lineWidth = 2;
      c.beginPath();
      for (let i = 0; i <= 6; i++) {
        const a = rot + (i / 6) * Math.PI * 2;
        const px = x + Math.cos(a) * hr;
        const py = y + Math.sin(a) * hr;
        if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
      }
      c.stroke();
      c.fillStyle = rgba(WHITE, this.stabilize * 0.9);
      for (let i = 0; i < 6; i++) {
        const a = rot + (i / 6) * Math.PI * 2;
        c.beginPath();
        c.arc(x + Math.cos(a) * hr, y + Math.sin(a) * hr, 3.5, 0, Math.PI * 2);
        c.fill();
      }
      c.shadowBlur = 0;
    }

    // 2f) sobrecarga: anel que pisca entre ciano e magenta
    if (this.overdrive > 0.05) {
      c.strokeStyle = rgba(Math.random() < 0.5 ? CYAN : MAGENTA, this.overdrive * rand(0.4, 0.95));
      c.lineWidth = 2 + Math.random() * 3;
      c.beginPath();
      c.arc(x, y, R * rand(1.22, 1.3), 0, Math.PI * 2);
      c.stroke();
    }

    // 3) Ligações entre partículas próximas.
    //    A distância máxima cresce com a raiz do raio: ao expandir, a rede "espalha".
    const linkDist = clamp(0.5 * Math.sqrt(R * CONFIG.core.baseRadius), 20, 150);
    const linkDist2 = linkDist * linkDist;
    const ps = this.particles;
    c.lineWidth = 1;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i];
      for (let j = i + 1; j < ps.length; j++) {
        const b = ps[j];
        const dx = a.sx - b.sx;
        const dy = a.sy - b.sy;
        const d2 = dx * dx + dy * dy;
        if (d2 > linkDist2) continue;
        const closeness = 1 - Math.sqrt(d2) / linkDist;
        const depthFade = 0.35 + 0.65 * ((a.depth + b.depth) / 2);
        c.strokeStyle = rgba(col, closeness * depthFade * 0.85 * ringAlpha);
        c.beginPath();
        c.moveTo(a.sx, a.sy);
        c.lineTo(b.sx, b.sy);
        c.stroke();
      }
    }

    // 4) Partículas (sprites). `tint` mistura ciano/magenta; o estresse empurra para magenta.
    const sizeScale = Math.pow(R / CONFIG.core.baseRadius, 0.3);
    const ghost = (0.2 + 0.8 * integ) * this.alphaMul;
    for (const p of ps) {
      const magW = clamp(p.tint + (1 - p.tint) * s * 0.85, 0, 1);
      const size = (14 + 10 * p.size) * (0.6 + 0.8 * p.depth) * sizeScale;
      const alpha = (0.45 + 0.55 * p.depth) * ghost;
      if (magW < 0.97) {
        c.globalAlpha = alpha * (1 - magW);
        c.drawImage(this.spriteCyan, p.sx - size / 2, p.sy - size / 2, size, size);
      }
      if (magW > 0.03) {
        c.globalAlpha = alpha * magW;
        c.drawImage(this.spriteMagenta, p.sx - size / 2, p.sy - size / 2, size, size);
      }
    }

    c.restore();
  }
}


/* ============================================================================
   9. EFEITOS: faíscas, ondas de choque, rastros, flash e tremor de tela
   ============================================================================ */
const core = new EnergyCore(window.innerWidth / 2, window.innerHeight / 2);

const sparks = [];
function spawnSpark(x, y, vx, vy, life, color, size) {
  if (sparks.length > 900) sparks.shift();
  sparks.push({ x, y, vx, vy, life, max: life, color, size });
}

function updateSparks(dt) {
  const drag = Math.exp(-dt * 1.6);
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.life -= dt;
    if (s.life <= 0) { sparks[i] = sparks[sparks.length - 1]; sparks.pop(); continue; }
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.vx *= drag;
    s.vy *= drag;
  }
}

function drawSparks(c) {
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.lineCap = 'round';
  for (const s of sparks) {
    const a = s.life / s.max;
    c.strokeStyle = rgba(s.color, a);
    c.lineWidth = s.size * (0.5 + a);
    c.beginPath();
    c.moveTo(s.x, s.y);
    c.lineTo(s.x - s.vx * 0.025, s.y - s.vy * 0.025);
    c.stroke();
  }
  c.restore();
}

const shockwaves = [];
let flash = 0;
let shakeAmp = 0;

function updateShockwaves(dt) {
  const P = CONFIG.pulse;
  for (let i = shockwaves.length - 1; i >= 0; i--) {
    const w = shockwaves[i];
    w.r += (w.kind === 'blast' ? 1500 : P.waveSpeed) * dt;

    // Quando a frente da onda alcança o núcleo: empurra e embaralha as partículas
    if (!w.hit && w.r > 0) {
      const d = dist(w, core.pos);
      if (w.r >= d - core.radius * 0.5) {
        w.hit = true;
        const nx = (core.pos.x - w.x) / (d || 1);
        const ny = (core.pos.y - w.y) / (d || 1);
        const mult = w.kind === 'sonic' ? 1.5 : 1;
        const strength = P.impulse * mult * clamp(1 - d / w.max, 0.25, 1);
        core.applyImpulse(nx * strength, ny * strength);
        core.shake(w.kind === 'sonic' ? 1.4 : 1);
        if (w.onHit) w.onHit();
      }
    }
    if (w.r > w.max) shockwaves.splice(i, 1);
  }
}

function drawShockwaves(c) {
  c.save();
  c.globalCompositeOperation = 'lighter';
  for (const w of shockwaves) {
    if (w.r <= 0) continue;
    const life = clamp(1 - w.r / w.max, 0, 1);
    const main = w.kind === 'sonic' ? CYAN : w.kind === 'blast' ? WHITE : MAGENTA;
    const second = w.kind === 'blast' ? MAGENTA : CYAN;
    const thick = w.kind === 'blast' ? 10 : w.kind === 'sonic' ? 7 : 5;

    c.strokeStyle = rgba(main, life * 0.9);
    c.shadowColor = rgba(main, 1);
    c.shadowBlur = 22;
    c.lineWidth = 2 + life * thick;
    c.beginPath();
    c.arc(w.x, w.y, w.r, 0, Math.PI * 2);
    c.stroke();

    c.strokeStyle = rgba(second, life * 0.5);
    c.shadowColor = rgba(second, 1);
    c.lineWidth = 1.5;
    c.beginPath();
    c.arc(w.x, w.y, Math.max(0, w.r - 18), 0, Math.PI * 2);
    c.stroke();
  }
  c.restore();
}

/* --- Rastros da caneta holográfica (indicador) ------------------------- */
const trails = [];                 // traços: { pts: [{x,y,t}] }
const activeStroke = [null, null]; // traço em andamento de cada mão
const penTip = [null, null];       // posição suavizada da ponta do dedo

function updateTrails(now) {
  const T = CONFIG.trails;
  for (let i = 0; i < 2; i++) {
    const h = trackedHands[i];
    if (h && h.gesture === 'point') {
      const tip = h.pts[LM.INDEX_TIP];
      penTip[i] = penTip[i] ? { x: lerp(penTip[i].x, tip.x, 0.55), y: lerp(penTip[i].y, tip.y, 0.55) } : { x: tip.x, y: tip.y };
      if (!activeStroke[i]) { activeStroke[i] = { pts: [] }; trails.push(activeStroke[i]); }
      const pts = activeStroke[i].pts;
      const last = pts[pts.length - 1];
      if (!last || dist(last, penTip[i]) > 3) pts.push({ x: penTip[i].x, y: penTip[i].y, t: now });
      if (pts.length > T.maxPoints) pts.shift();
    } else {
      activeStroke[i] = null;
      penTip[i] = null;
    }
  }
  for (let i = trails.length - 1; i >= 0; i--) {
    const pts = trails[i].pts;
    while (pts.length && now - pts[0].t > T.lifeMs) pts.shift();
    if (!pts.length && !activeStroke.includes(trails[i])) trails.splice(i, 1);
  }
}

function drawTrails(c, now) {
  c.save();
  c.globalCompositeOperation = 'lighter';
  c.lineCap = 'round';
  for (const stroke of trails) {
    const pts = stroke.pts;
    for (let i = 1; i < pts.length; i++) {
      const age = clamp((now - pts[i].t) / CONFIG.trails.lifeMs, 0, 1);
      const col = mixColor(CYAN, MAGENTA, age);
      const a = 1 - age;
      c.strokeStyle = rgba(col, a * 0.25);
      c.lineWidth = 9 * a + 2;
      c.beginPath(); c.moveTo(pts[i - 1].x, pts[i - 1].y); c.lineTo(pts[i].x, pts[i].y); c.stroke();
      c.strokeStyle = rgba(mixColor(col, WHITE, 0.5), a);
      c.lineWidth = 2.5 * a + 0.5;
      c.beginPath(); c.moveTo(pts[i - 1].x, pts[i - 1].y); c.lineTo(pts[i].x, pts[i].y); c.stroke();
    }
  }
  c.restore();
}


/* ============================================================================
   10. AÇÕES DE GESTO
   ============================================================================ */
const interaction = {
  mode: 'idle',            // 'idle' | 'drag' | 'scale'
  prevMode: 'idle',
  offset: { x: 0, y: 0 },
  startDist: 1,
  startRadius: 1,
  points: [],
  holdingRepulse: false,
  sweeping: false,
};

let lastFistEnd = -9999;
let lastFormationAt = -9999;
let lastSweepLog = -9999;

function maxRadius() { return Math.min(view.w, view.h) * CONFIG.core.maxRadiusFactor; }

function resetCore() {
  core.pos.x = view.w / 2;
  core.pos.y = view.h / 2;
  core.vel.x = core.vel.y = 0;
  core.targetRadius = CONFIG.core.baseRadius;
  core.charge = 0;
  core.setFormation(0);
  core.shake(0.6);
  interaction.mode = 'idle';
  logEvent('Núcleo reposicionado');
}

function nextFormation(now) {
  if (now - lastFormationAt < CONFIG.formationCooldownMs) return;
  lastFormationAt = now;
  core.setFormation(core.formationIndex + 1);
  core.shake(0.35);
  for (let i = 0; i < 40; i++) {
    const a = rand(0, Math.PI * 2);
    const sp = rand(150, 600);
    spawnSpark(core.pos.x, core.pos.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.4, 0.9), Math.random() < 0.5 ? CYAN : MAGENTA, 2);
  }
  const name = FORMATIONS[core.formationIndex].name;
  logEvent(`Formação: ${name}`, 'pulse');
  flashAction(`Formação: ${name}`, 'pulse', 1400);
}

function firePulse(hand, now) {
  shockwaves.push({ x: hand.palm.x, y: hand.palm.y, r: 0, max: Math.max(view.w, view.h) * 0.7, hit: false, kind: 'pulse' });
  logEvent('Pulso de repulsão', 'pulse');
  flashAction('Pulso de repulsão', 'pulse', 900);
}

/** Supernova: explode o núcleo em faíscas, que depois se reforma. */
function detonate(power, origin, now) {
  power = clamp(power, 0.3, 1);
  const cx = core.pos.x;
  const cy = core.pos.y;

  const count = Math.round(140 + 260 * power);
  for (let i = 0; i < count; i++) {
    const a = rand(0, Math.PI * 2);
    const sp = rand(250, 1500) * (0.5 + power);
    const roll = Math.random();
    const color = roll < 0.4 ? CYAN : roll < 0.75 ? MAGENTA : WHITE;
    const off = rand(0, core.radius * 0.5);
    spawnSpark(cx + Math.cos(a) * off, cy + Math.sin(a) * off, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.7, 2.1), color, rand(1.5, 3.5));
  }

  const max = Math.max(view.w, view.h) * 0.9;
  shockwaves.push({ x: cx, y: cy, r: 0, max, hit: true, kind: 'blast' });
  shockwaves.push({ x: cx, y: cy, r: -140, max, hit: true, kind: 'blast' });

  core.shake(1.2 + 2.2 * power);
  core.integrity = 0;
  core.reformDelay = 0.45;
  core.charge = 0;
  lastFistEnd = -9999;

  if (origin) {
    const d = dist(core.pos, origin) || 1;
    core.applyImpulse(((core.pos.x - origin.x) / d) * 900 * power, ((core.pos.y - origin.y) / d) * 900 * power);
  }

  flash = 0.6 + 0.4 * power;
  shakeAmp = 10 + 26 * power;

  const pct = Math.round(power * 100);
  logEvent(`Detonação, potência ${pct}%`, 'blast');
  flashAction(`Detonação ${pct}%`, 'blast', 1800);
}

/* --- Eventos de gesto (disparados em onResults, no ritmo da câmera) ----- */
bus.on('gesture', ({ hand, index, from, to, now }) => {
  if (appMode !== 'core') return; // nos modos 3D quem trata é o armor.js
  if (from === 'fist') lastFistEnd = now;

  switch (to) {
    case 'open': {
      // Mão aberta logo depois de um punho carregado = detonação; senão, pulso comum
      const ready = core.charge >= CONFIG.charge.minDetonate && now - lastFistEnd < CONFIG.charge.releaseWindowMs;
      if (ready) {
        detonate(core.charge, hand.palm, now);
      } else if (now - handMemory[index].lastPulse > CONFIG.pulse.cooldownMs) {
        handMemory[index].lastPulse = now;
        firePulse(hand, now);
      }
      break;
    }
    case 'victory': nextFormation(now); break;
    case 'fist': logEvent('Punho: reator carregando', 'info'); break;
    case 'point': logEvent('Indicador: caneta holográfica', 'info'); break;
    case 'thumbsup': logEvent('Joinha: estabilizando núcleo', 'pulse'); break;
    case 'rock': logEvent('Chifres: sobrecarga ativada', 'blast'); break;
    default: break;
  }
});

bus.on('clap', ({ x, y }) => {
  if (appMode !== 'core') return;
  shockwaves.push({
    x, y, r: 0, max: Math.max(view.w, view.h) * 0.9, hit: false, kind: 'sonic',
    // Ao atingir o núcleo: reinicia tamanho e formação
    onHit() {
      core.targetRadius = CONFIG.core.baseRadius;
      core.setFormation(0);
      core.chaos = Math.max(core.chaos, 0.8);
    },
  });
  trails.length = 0;
  flash = Math.max(flash, 0.35);
  shakeAmp = Math.max(shakeAmp, 12);
  logEvent('Palmas: onda sônica', 'pulse');
  flashAction('Onda sônica', 'pulse', 1300);
});

/* --- Pinça: arrastar e escalar ---------------------------------------- */
function updateInteraction(dt) {
  const I = interaction;
  const pinches = trackedHands.filter((h) => h.pinching).map((h) => h.pinchPoint);
  I.points = pinches;

  const reach = core.radius * 1.2 + CONFIG.gestures.grabMargin;
  const isNearCore = (p) => dist(p, core.pos) < reach;

  if (pinches.length >= 2) {
    const [a, b] = pinches;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const d = dist(a, b);

    if (I.mode !== 'scale') {
      if (I.mode === 'drag' || isNearCore(a) || isNearCore(b)) {
        I.mode = 'scale';
        I.startDist = Math.max(d, 40);
        I.startRadius = core.targetRadius;
        I.offset.x = core.pos.x - mid.x;
        I.offset.y = core.pos.y - mid.y;
      }
    }
    if (I.mode === 'scale') {
      core.targetRadius = clamp(I.startRadius * (d / I.startDist), CONFIG.core.minRadius, maxRadius());
      decayOffset(I.offset, dt);
      core.grabTo({ x: mid.x + I.offset.x, y: mid.y + I.offset.y }, dt);
    }
    return;
  }

  if (pinches.length === 1) {
    const p = pinches[0];
    if (I.mode === 'scale' || (I.mode === 'idle' && isNearCore(p))) {
      I.mode = 'drag';
      I.offset.x = core.pos.x - p.x;
      I.offset.y = core.pos.y - p.y;
    }
    if (I.mode === 'drag') {
      decayOffset(I.offset, dt);
      core.grabTo({ x: p.x + I.offset.x, y: p.y + I.offset.y }, dt);
    }
    return;
  }

  I.mode = 'idle'; // solta: o núcleo desliza por inércia
}

function decayOffset(offset, dt) {
  const k = Math.exp(-dt * 5);
  offset.x *= k;
  offset.y *= k;
}

/** Registra no log quando o arrasto/escala começa ou termina. */
function trackInteractionLog() {
  const I = interaction;
  if (I.mode === I.prevMode) return;
  if (I.mode === 'drag' && I.prevMode === 'idle') logEvent('Núcleo agarrado', 'info');
  if (I.mode === 'scale') logEvent('Escala manual com 2 mãos', 'info');
  if (I.mode === 'idle') {
    const sp = Math.round(Math.hypot(core.vel.x, core.vel.y));
    logEvent(sp > 700 ? `Arremesso a ${sp} px/s` : 'Núcleo solto', sp > 700 ? 'pulse' : 'info');
  }
  I.prevMode = I.mode;
}

/** Ações contínuas dos demais gestos (punho, joinha, chifres, indicador, varrer). */
function updateGestureActions(dt, now) {
  const hands = trackedHands;
  const R = core.radius;

  // ---- Punho: carrega o reator -----------------------------------------
  const fists = hands.filter((h) => h.gesture === 'fist');
  if (fists.length) {
    core.charge = Math.min(1, core.charge + dt / CONFIG.charge.seconds);

    // O punho "puxa" o núcleo, como se o segurasse
    if (!core.grabbed) {
      for (const h of fists) {
        const d = dist(h.palm, core.pos);
        if (d < CONFIG.charge.attractRange) {
          const f = 1 - d / CONFIG.charge.attractRange;
          core.vel.x += ((h.palm.x - core.pos.x) / (d || 1)) * 1800 * f * dt;
          core.vel.y += ((h.palm.y - core.pos.y) / (d || 1)) * 1800 * f * dt;
          core.vel.x *= Math.exp(-dt * 1.5);
          core.vel.y *= Math.exp(-dt * 1.5);
        }
      }
    }
  } else if (now - lastFistEnd > CONFIG.charge.releaseWindowMs) {
    // Se ninguém abriu a mão a tempo, a carga se dissipa
    core.charge *= Math.exp(-dt * 3);
    if (core.charge < 0.01) core.charge = 0;
  }

  // Faíscas sendo sugadas para o núcleo enquanto carrega
  if (core.charge > 0.05 && core.integrity > 0.9) {
    const n = (60 + 140 * core.charge) * dt;
    for (let i = 0; i < Math.floor(n + Math.random()); i++) {
      const a = rand(0, Math.PI * 2);
      const d = R * rand(1.8, 3);
      const life = 0.35;
      spawnSpark(
        core.pos.x + Math.cos(a) * d, core.pos.y + Math.sin(a) * d,
        (-Math.cos(a) * d) / life, (-Math.sin(a) * d) / life,
        life, Math.random() < 0.5 ? MAGENTA : WHITE, 1.8
      );
    }
  }

  // ---- Joinha e chifres: estados sustentados -----------------------------
  const thumbs = hands.some((h) => h.gesture === 'thumbsup');
  core.stabilizeGoal = thumbs ? 1 : 0;
  core.overdriveGoal = !thumbs && hands.some((h) => h.gesture === 'rock') ? 1 : 0;

  // Sobrecarga: faíscas tangenciais saindo da borda
  if (core.overdrive > 0.4) {
    const n = 90 * core.overdrive * dt;
    for (let i = 0; i < Math.floor(n + Math.random()); i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(300, 700);
      spawnSpark(
        core.pos.x + Math.cos(a) * R, core.pos.y + Math.sin(a) * R,
        -Math.sin(a) * sp * 0.8 + Math.cos(a) * sp * 0.4, Math.cos(a) * sp * 0.8 + Math.sin(a) * sp * 0.4,
        rand(0.3, 0.7), Math.random() < 0.5 ? CYAN : MAGENTA, 2
      );
    }
  }

  // ---- Indicador: atrai partículas e escaneia -----------------------------
  let scanning = false;
  for (const h of hands) {
    if (h.gesture !== 'point') continue;
    const tip = h.pts[LM.INDEX_TIP];
    if (dist(tip, core.pos) < R * 1.3 + 50) scanning = true;
    for (const p of core.particles) {
      const dx = tip.x - p.sx;
      const dy = tip.y - p.sy;
      const d = Math.hypot(dx, dy);
      if (d < 260 && d > 1) {
        const f = 1 - d / 260;
        p.ovx += (dx / d) * f * 1400 * dt;
        p.ovy += (dy / d) * f * 1400 * dt;
      }
    }
  }
  core.scanGoal = scanning ? 1 : 0;
  if (scanning && core.scan < 0.1) logEvent('Escaneando núcleo', 'pulse');

  // ---- Mão aberta: repulsão contínua + varrer ------------------------------
  const P = CONFIG.pulse;
  interaction.holdingRepulse = false;
  interaction.sweeping = false;

  for (const h of hands) {
    if (h.gesture !== 'open') continue;
    const d = dist(h.palm, core.pos);

    // Varrer: mão aberta rápida encostando no núcleo transfere velocidade e giro
    const sp = Math.hypot(h.palmVel.x, h.palmVel.y);
    if (sp > 500 && d < R + h.handSize * 0.9 + 20) {
      interaction.sweeping = true;
      if (!core.grabbed) {
        const k = 1 - Math.exp(-dt * 7);
        core.vel.x += (h.palmVel.x * 0.9 - core.vel.x) * k;
        core.vel.y += (h.palmVel.y * 0.9 - core.vel.y) * k;
      }
      core.spin = clamp(core.spin + h.palmVel.x * dt * 0.012, -14, 14);
      core.chaos = Math.max(core.chaos, Math.min(0.8, sp / 2500));
      if (now - lastSweepLog > 900) {
        lastSweepLog = now;
        logEvent('Varredura: núcleo empurrado', 'pulse');
        flashAction('Varredura', 'pulse', 700);
      }
    }

    // Repulsão contínua da palma
    const range = R + P.holdRange;
    if (d < range) {
      const f = 1 - d / range;
      core.applyImpulse(((core.pos.x - h.palm.x) / (d || 1)) * P.holdForce * f * dt, ((core.pos.y - h.palm.y) / (d || 1)) * P.holdForce * f * dt);
      core.chaos = Math.max(core.chaos, f * 0.9);
      interaction.holdingRepulse = true;
    }
  }
}

function update(dt, now) {
  core.grabbed = false;
  if (appMode === 'core') {
    updateInteraction(dt);
    trackInteractionLog();
    updateGestureActions(dt, now);
    updateTrails(now);
  }
  for (const m of modules) if (m.update) m.update(dt, now);
  updateShockwaves(dt);
  updateSparks(dt);
  core.update(dt);

  flash *= Math.exp(-dt * 3.5);
  shakeAmp *= Math.exp(-dt * 5);
  if (flash < 0.002) flash = 0;
  if (shakeAmp < 0.2) shakeAmp = 0;
}


/* ============================================================================
   11. RENDERIZAÇÃO
   ============================================================================ */
function drawBackground() {
  ctx.fillStyle = '#04050c';
  ctx.fillRect(0, 0, view.w, view.h);

  if (video.readyState >= 2 && video.videoWidth) {
    const r = getVideoRect();
    ctx.save();
    ctx.globalAlpha = CONFIG.videoAlpha;
    ctx.translate(r.x + r.w, r.y);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, r.w, r.h);
    ctx.restore();
    ctx.fillStyle = 'rgba(0, 24, 48, 0.28)';
    ctx.fillRect(0, 0, view.w, view.h);
  }

  if (gridLayer) ctx.drawImage(gridLayer, 0, 0, view.w, view.h);
}

function drawFlash() {
  if (flash <= 0) return;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const r = Math.max(view.w, view.h) * 0.9;
  const g = ctx.createRadialGradient(core.pos.x, core.pos.y, 0, core.pos.x, core.pos.y, r);
  g.addColorStop(0, `rgba(255,255,255,${Math.min(1, flash)})`);
  g.addColorStop(0.35, rgba(CYAN, flash * 0.35));
  g.addColorStop(1, rgba(MAGENTA, 0));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, view.w, view.h);
  ctx.restore();
}

/** Painel de telemetria do núcleo, mostrado quando o indicador aponta para ele. */
function drawScanOverlay(now) {
  if (core.scan < 0.03) return;
  const a = core.scan;
  const R = core.drawRadius;
  const { x, y } = core.pos;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  // Mira em colchetes girando em volta do núcleo
  ctx.strokeStyle = rgba(CYAN, 0.9 * a);
  ctx.shadowColor = rgba(CYAN, 1);
  ctx.shadowBlur = 12;
  ctx.lineWidth = 2.5;
  const spin = now * 0.0012;
  for (let k = 0; k < 4; k++) {
    const a0 = spin + (k * Math.PI) / 2;
    ctx.beginPath();
    ctx.arc(x, y, R * 1.62, a0, a0 + 0.5);
    ctx.stroke();
  }
  ctx.restore();

  // Painel de dados (lado com mais espaço)
  const onLeft = x > view.w * 0.55;
  const pw = 250;
  const lh = 20;
  const px = onLeft ? x - R * 1.9 - pw : x + R * 1.9;
  const py = clamp(y - R * 1.1, 20, view.h - 190);
  const energy = clamp(Math.round(35 + (core.radius / maxRadius()) * 40 + core.stress * 25 + core.charge * 30), 0, 100);
  const stability = Math.round((1 - core.stress) * 100);
  const rows = [
    ['Formação', FORMATIONS[core.formationIndex].name],
    ['Energia', `${energy}%`],
    ['Raio', `${Math.round(core.radius)} px`],
    ['Estabilidade', `${stability}%`],
    ['Partículas', String(core.particles.length)],
  ];

  ctx.save();
  ctx.globalAlpha = a;
  // linha de conexão
  ctx.strokeStyle = rgba(CYAN, 0.7);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x + (onLeft ? -1 : 1) * R * 1.15, y - R * 0.4);
  ctx.lineTo(onLeft ? px + pw : px, py + 14);
  ctx.stroke();

  ctx.fillStyle = 'rgba(4, 8, 20, 0.75)';
  ctx.fillRect(px, py, pw, 34 + rows.length * lh);
  ctx.strokeStyle = rgba(CYAN, 0.8);
  ctx.strokeRect(px + 0.5, py + 0.5, pw, 34 + rows.length * lh);

  ctx.font = '700 13px "Orbitron", "Share Tech Mono", monospace';
  ctx.fillStyle = rgba(CYAN, 1);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText('Análise do núcleo', px + 12, py + 18);

  ctx.font = '13px "Share Tech Mono", monospace';
  rows.forEach(([k, v], i) => {
    const ty = py + 42 + i * lh;
    ctx.fillStyle = 'rgba(217, 251, 255, 0.6)';
    ctx.textAlign = 'left';
    ctx.fillText(k, px + 12, ty);
    ctx.fillStyle = rgba(MAGENTA, 1);
    ctx.textAlign = 'right';
    ctx.fillText(v, px + pw - 12, ty);
  });
  ctx.restore();
}

function drawInteractionLinks(now) {
  const I = interaction;
  if (I.mode === 'idle' || I.points.length === 0) return;

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = rgba(MAGENTA, 0.8);
  ctx.shadowColor = rgba(MAGENTA, 1);
  ctx.shadowBlur = 12;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 8]);
  ctx.lineDashOffset = -now * 0.04;

  for (const p of I.points) {
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(core.pos.x, core.pos.y);
    ctx.stroke();
  }

  if (I.mode === 'scale' && I.points.length >= 2) {
    const [a, b] = I.points;
    ctx.setLineDash([]);
    ctx.strokeStyle = rgba(CYAN, 0.9);
    ctx.shadowColor = rgba(CYAN, 1);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    ctx.shadowBlur = 8;
    ctx.fillStyle = rgba(CYAN, 1);
    ctx.font = '16px "Share Tech Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`×${(core.targetRadius / CONFIG.core.baseRadius).toFixed(2)}`, (a.x + b.x) / 2, (a.y + b.y) / 2 - 14);
  }
  ctx.restore();
}

function gestureColor(g) {
  return g === 'pinch' || g === 'fist' || g === 'rock' ? MAGENTA : CYAN;
}

/** Etiqueta flutuante com o nome do gesto, perto do pulso de cada mão. */
function drawHandTag(h) {
  const w = h.pts[LM.WRIST];
  const x = clamp(w.x, 80, view.w - 80);
  const y = clamp(w.y + h.handSize * 0.55 + 24, 30, view.h - 24);
  const col = gestureColor(h.gesture);

  ctx.save();
  ctx.font = '13px "Share Tech Mono", monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const tw = ctx.measureText(h.label).width + 24;
  ctx.fillStyle = 'rgba(4, 8, 20, 0.72)';
  ctx.fillRect(x - tw / 2, y - 12, tw, 24);
  ctx.strokeStyle = rgba(col, 0.9);
  ctx.shadowColor = rgba(col, 1);
  ctx.shadowBlur = 8;
  ctx.lineWidth = 1;
  ctx.strokeRect(x - tw / 2 + 0.5, y - 12 + 0.5, tw, 24);
  ctx.fillStyle = rgba(col, 1);
  ctx.fillText(h.label, x, y);
  ctx.restore();
}

function drawHands(now) {
  for (const h of trackedHands) {
    const pts = h.pts;
    ctx.save();

    // Conectores
    ctx.strokeStyle = rgba(CYAN, 0.95);
    ctx.shadowColor = rgba(CYAN, 1);
    ctx.shadowBlur = 12;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(pts[a].x, pts[a].y);
      ctx.lineTo(pts[b].x, pts[b].y);
    }
    ctx.stroke();

    // Juntas
    ctx.fillStyle = rgba(MAGENTA, 1);
    ctx.shadowColor = rgba(MAGENTA, 1);
    ctx.shadowBlur = 10;
    for (let i = 0; i < pts.length; i++) {
      ctx.beginPath();
      ctx.arc(pts[i].x, pts[i].y, TIP_INDICES.includes(i) ? 6 : 3.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Segmento polegar-indicador (acende em pinça)
    ctx.lineWidth = h.pinching ? 3 : 1.5;
    ctx.strokeStyle = h.pinching ? rgba(MAGENTA, 1) : rgba(CYAN, 0.35);
    ctx.setLineDash(h.pinching ? [] : [4, 6]);
    ctx.beginPath();
    ctx.moveTo(pts[LM.THUMB_TIP].x, pts[LM.THUMB_TIP].y);
    ctx.lineTo(pts[LM.INDEX_TIP].x, pts[LM.INDEX_TIP].y);
    ctx.stroke();
    ctx.setLineDash([]);

    if (h.pinching) {
      ctx.strokeStyle = rgba(MAGENTA, 0.95);
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(h.pinchPoint.x, h.pinchPoint.y, 22 * (1 + 0.15 * Math.sin(now * 0.012)), 0, Math.PI * 2);
      ctx.stroke();
    }

    // Mão aberta: repulsor (anéis concêntricos + hexágono girando)
    if (h.gesture === 'open') {
      ctx.strokeStyle = rgba(CYAN, 0.7);
      ctx.shadowColor = rgba(CYAN, 1);
      ctx.lineWidth = 2;
      [0.35, 0.6, 0.9].forEach((k, i) => {
        ctx.setLineDash([10 - i * 2, 8]);
        ctx.lineDashOffset = -now * 0.05 * (i % 2 ? -1 : 1);
        ctx.beginPath();
        ctx.arc(h.palm.x, h.palm.y, h.handSize * k, 0, Math.PI * 2);
        ctx.stroke();
      });
      ctx.setLineDash([]);
      ctx.beginPath();
      for (let i = 0; i <= 6; i++) {
        const a = now * 0.002 + (i / 6) * Math.PI * 2;
        const px = h.palm.x + Math.cos(a) * h.handSize * 0.5;
        const py = h.palm.y + Math.sin(a) * h.handSize * 0.5;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }

    // Punho: anel de progresso da carga
    if (h.gesture === 'fist') {
      const rr = h.handSize * 1.05;
      ctx.lineWidth = 6;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.beginPath();
      ctx.arc(h.palm.x, h.palm.y, rr, 0, Math.PI * 2);
      ctx.stroke();
      ctx.strokeStyle = core.charge > 0.97 ? rgba(WHITE, 1) : rgba(MAGENTA, 1);
      ctx.shadowColor = rgba(MAGENTA, 1);
      ctx.shadowBlur = 16;
      ctx.beginPath();
      ctx.arc(h.palm.x, h.palm.y, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * core.charge);
      ctx.stroke();
    }

    // Indicador: feixe de mira saindo da ponta do dedo
    if (h.gesture === 'point') {
      const tip = pts[LM.INDEX_TIP];
      const base = pts[LM.INDEX_MCP];
      const dx = tip.x - base.x;
      const dy = tip.y - base.y;
      const m = Math.hypot(dx, dy) || 1;
      const len = 170;
      const grad = ctx.createLinearGradient(tip.x, tip.y, tip.x + (dx / m) * len, tip.y + (dy / m) * len);
      grad.addColorStop(0, rgba(CYAN, 0.9));
      grad.addColorStop(1, rgba(CYAN, 0));
      ctx.strokeStyle = grad;
      ctx.lineWidth = 2;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.moveTo(tip.x, tip.y);
      ctx.lineTo(tip.x + (dx / m) * len, tip.y + (dy / m) * len);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(core.spriteCyan, tip.x - 30, tip.y - 30, 60, 60);
    }

    ctx.restore();
    drawHandTag(h);
  }
}

function render(now) {
  drawBackground();

  // Tremor de tela: só mundo (núcleo/efeitos), o esqueleto das mãos fica estável
  ctx.save();
  if (shakeAmp > 0) ctx.translate(rand(-shakeAmp, shakeAmp), rand(-shakeAmp, shakeAmp));
  drawShockwaves(ctx);
  for (const m of modules) if (m.drawWorld) m.drawWorld(ctx, now); // armadura 3D (antes do núcleo/reator)
  core.draw(ctx);
  drawSparks(ctx);
  if (appMode === 'core') {
    drawTrails(ctx, now);
    drawScanOverlay(now);
  }
  ctx.restore();

  drawFlash();
  drawInteractionLinks(now);
  for (const m of modules) if (m.drawUI) m.drawUI(ctx, now); // menu, fichas, progresso
  drawHands(now);
}


/* ============================================================================
   12. HUD (painéis HTML sobrepostos)
   ============================================================================ */
const $ = (id) => document.getElementById(id);
const hudEls = {
  status: $('hud-status'),
  hands: $('hud-hands'),
  slots: [$('hud-hand-0'), $('hud-hand-1')],
  coreState: $('hud-core-state'),
  barCharge: $('bar-charge'),
  valCharge: $('val-charge'),
  barStab: $('bar-stability'),
  valStab: $('val-stability'),
  formation: $('hud-formation'),
  formationLabel: $('hud-formation-label'),
  action: $('hud-action'),
  radius: $('hud-radius'),
  speed: $('hud-speed'),
  fps: $('hud-fps'),
  log: $('hud-log'),
};

function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
function setState(el, state) { if (el.dataset.state !== state) el.dataset.state = state; }
function setWidth(el, pct) { const v = `${Math.round(pct)}%`; if (el.style.width !== v) el.style.width = v; }

let fpsValue = 0;
let hudTimer = 0;
let renderedLogVersion = -1;

function getCoreState() {
  for (const m of modules) { const r = m.hudCoreState && m.hudCoreState(); if (r) return r; }
  if (core.integrity < 0.5) return ['Detonado', 'blast'];
  if (core.integrity < 0.97) return ['Reformando', 'blast'];
  if (core.charge > 0.05) return ['Carregando', 'charge'];
  if (core.overdrive > 0.5) return ['Sobrecarga', 'charge'];
  if (core.stabilize > 0.5) return ['Estabilizando', 'stable'];
  if (interaction.mode === 'scale') return ['Escalando', 'drag'];
  if (interaction.mode === 'drag') return ['Arrastando', 'drag'];
  if (core.scan > 0.5) return ['Escaneando', 'pulse'];
  if (core.stress > 0.35) return ['Instável', 'warn'];
  return ['Estável', 'stable'];
}

function getActionText(now) {
  if (now < actionFlash.until) return [actionFlash.text, actionFlash.state];
  for (const m of modules) { const r = m.hudAction && m.hudAction(now); if (r) return r; }
  if (core.charge > 0.05) return [`Carregando reator ${Math.round(core.charge * 100)}%`, 'charge'];
  if (core.overdrive > 0.5) return ['Sobrecarga ativa', 'charge'];
  if (core.stabilize > 0.5) return ['Estabilizando núcleo', 'stable'];
  if (interaction.mode === 'scale') return [`Escalando núcleo ×${(core.targetRadius / CONFIG.core.baseRadius).toFixed(2)}`, 'scale'];
  if (interaction.mode === 'drag') return ['Arrastando núcleo', 'drag'];
  if (core.scan > 0.5) return ['Escaneando núcleo', 'pulse'];
  if (interaction.holdingRepulse) return ['Repulsão ativa', 'pulse'];
  return ['Aguardando gesto', 'idle'];
}

function renderLog() {
  const ul = hudEls.log;
  ul.textContent = '';
  for (const e of eventLog) {
    const li = document.createElement('li');
    li.dataset.kind = e.kind;
    const t = document.createElement('time');
    t.textContent = e.time;
    const s = document.createElement('span');
    s.textContent = e.text;
    li.append(t, s);
    ul.append(li);
  }
}

function updateHud(now, dt) {
  hudTimer += dt;
  if (hudTimer < 0.1) return; // ~10 atualizações por segundo
  hudTimer = 0;

  setText(hudEls.hands, String(trackedHands.length));
  hudEls.slots.forEach((slot, i) => {
    const h = trackedHands[i];
    const gestureEl = slot.querySelector('.slot-gesture');
    if (h) {
      setText(gestureEl, h.gesture === 'pinch' ? `${h.label} (${h.pinchRatio.toFixed(2)})` : h.label);
      setState(slot, h.gesture);
    } else {
      setText(gestureEl, '—');
      setState(slot, 'none');
    }
  });

  const [stateText, stateKind] = getCoreState();
  setText(hudEls.coreState, stateText);
  setState(hudEls.coreState, stateKind);

  setWidth(hudEls.barCharge, core.charge * 100);
  setText(hudEls.valCharge, `${Math.round(core.charge * 100)}%`);
  const stab = (1 - core.stress) * 100;
  setWidth(hudEls.barStab, stab);
  setText(hudEls.valStab, `${Math.round(stab)}%`);

  let row = ['Formação', FORMATIONS[core.formationIndex].name];
  for (const m of modules) { const r = m.hudRow && m.hudRow(); if (r) row = r; }
  setText(hudEls.formationLabel, row[0]);
  setText(hudEls.formation, row[1]);

  const [actText, actState] = getActionText(now);
  setText(hudEls.action, actText);
  setState(hudEls.action, actState);

  setText(hudEls.radius, `${Math.round(core.radius)} px`);
  setText(hudEls.speed, `${Math.round(Math.hypot(core.vel.x, core.vel.y))} px/s`);
  setText(hudEls.fps, `${Math.round(fpsValue)} fps`);

  if (renderedLogVersion !== logVersion) {
    renderedLogVersion = logVersion;
    renderLog();
  }
}


/* ============================================================================
   13. GAME LOOP (requestAnimationFrame ~60 fps, independente da câmera)
   ============================================================================ */
let lastFrame = performance.now();

function gameLoop(now) {
  requestAnimationFrame(gameLoop);
  const dt = clamp((now - lastFrame) / 1000, 0.001, 0.05);
  lastFrame = now;
  fpsValue = lerp(fpsValue || 60, 1 / dt, 0.05);

  update(dt, now);
  render(now);
  updateHud(now, dt);
}


/* ============================================================================
   14. MEDIAPIPE + CÂMERA
   ============================================================================ */
async function startTracking() {
  if (typeof Hands === 'undefined' || typeof Camera === 'undefined') {
    throw new Error('Não foi possível carregar o MediaPipe. Verifique sua conexão com a internet.');
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Este navegador não permite acesso à câmera. Use localhost (Live Server) ou HTTPS.');
  }

  setText(hudEls.status, 'carregando modelo de IA...');

  const handsModel = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`,
  });
  handsModel.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });
  handsModel.onResults(onResults);

  await handsModel.initialize();
  setText(hudEls.status, 'iniciando câmera...');

  const camera = new Camera(video, {
    onFrame: async () => { await handsModel.send({ image: video }); },
    width: 1280,
    height: 720,
  });
  await camera.start();

  setText(hudEls.status, 'online');
  logEvent('Sistema online. Mostre as mãos para a câmera', 'pulse');
}

function showOverlayError(message) {
  overlayMsg.textContent = message;
  overlayMsg.classList.add('error');
  btnStart.disabled = false;
  btnStart.textContent = 'Tentar novamente';
  overlay.classList.remove('hidden');
  setText(hudEls.status, 'erro');
}

btnStart.addEventListener('click', async () => {
  btnStart.disabled = true;
  btnStart.textContent = 'Iniciando...';
  overlayMsg.classList.remove('error');
  try {
    await startTracking();
    overlay.classList.add('hidden');
  } catch (err) {
    console.error(err);
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError');
    const noCam = err && err.name === 'NotFoundError';
    showOverlayError(
      denied ? 'Acesso à câmera negado. Permita o uso da câmera no navegador e tente de novo.'
      : noCam ? 'Nenhuma câmera encontrada neste dispositivo.'
      : (err && err.message) || 'Falha ao iniciar a câmera.'
    );
  }
});


/* ============================================================================
   15. INICIALIZAÇÃO E ATALHOS DE TECLADO (úteis para testar sem a câmera)
   ============================================================================ */
window.addEventListener('resize', resizeCanvas);
window.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (appMode === 'core') {
    if (k === 'r') resetCore();
    if (k === 'f') nextFormation(performance.now() + CONFIG.formationCooldownMs);
    if (k === 'd') detonate(1, null, performance.now());
  }
  if (k === 'h') document.body.classList.toggle('ui-hidden');
});

resizeCanvas();
logEvent('Núcleo online');
requestAnimationFrame(gameLoop); // o núcleo já aparece antes de ligar a câmera