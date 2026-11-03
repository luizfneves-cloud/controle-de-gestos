'use strict';
/* ============================================================================
   UPGRADE v3 — carregar DEPOIS de script.js
   1) Física firme   2) Fundo em camadas (nebulosa, estrelas, piso em perspectiva)
   3) Câmera em quadro (PiP)   4) +5 formações   5) Temas de cor (tecla C ou
   pinça segurada sobre o quadro da câmera)   6) Poeira gravitacional + impactos
   ============================================================================ */
(() => {
  const C = CONFIG;

  /* ---------- 1. FÍSICA: mais dura, sem reação a qualquer tremida ---------- */
  Object.assign(C.core, { friction: 3.1, restitution: 0.5, springK: 150, springDamping: 17, maxThrowSpeed: 2600 });
  Object.assign(C.gestures, { stableFrames: 6, handLostGraceMs: 220, pinchEnter: 0.3, pinchExit: 0.48 });
  Object.assign(C.pulse, { cooldownMs: 1200, holdRange: 190, holdForce: 700 });
  C.charge.attractRange = 380;

  // Agarrar: segue a mão de perto (rígido), em vez de "boiar" atrás dela
  EnergyCore.prototype.grabTo = function (t, dt) {
    const k = 1 - Math.exp(-dt * 34);
    const nx = this.pos.x + (t.x - this.pos.x) * k;
    const ny = this.pos.y + (t.y - this.pos.y) * k;
    this.vel.x = this.vel.x * 0.4 + ((nx - this.pos.x) / dt) * 0.6;
    this.vel.y = this.vel.y * 0.4 + ((ny - this.pos.y) / dt) * 0.6;
    this.pos.x = nx; this.pos.y = ny; this.grabbed = true;
  };

  /* ---------- 4. MAIS FORMAÇÕES ---------- */
  const addF = (id, name, build) => FORMATIONS.push({ id, name, build, points: build(C.core.particleCount) });
  const arr = (n, fn) => Array.from({ length: n }, (_, i) => fn(i, n));

  addF('torus', 'Toro', (n) => arr(n, (i) => {
    const u = i * GOLDEN, v = i * GOLDEN * 5, r = 0.72 + 0.32 * Math.cos(v);
    return { x: Math.cos(u) * r, y: 0.32 * Math.sin(v), z: Math.sin(u) * r, inner: i % 3 === 0 };
  }));
  addF('knot', 'Nó trefólio', (n) => arr(n, (i) => {
    const t = (i / n) * Math.PI * 2;
    return { x: (Math.sin(t) + 2 * Math.sin(2 * t)) / 3, y: (Math.cos(t) - 2 * Math.cos(2 * t)) / 3, z: -Math.sin(3 * t) / 1.6, inner: i % 4 === 0 };
  }));
  addF('ico', 'Icosaedro', (n) => {
    const p = (1 + Math.sqrt(5)) / 2, v = [];
    for (const a of [-1, 1]) for (const b of [-p, p]) v.push([0, a, b], [a, b, 0], [b, 0, a]);
    const nm = Math.hypot(1, p), out = v.map(([x, y, z]) => ({ x: x / nm, y: y / nm, z: z / nm, inner: false }));
    for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) {
      if (Math.abs(Math.hypot(v[i][0] - v[j][0], v[i][1] - v[j][1], v[i][2] - v[j][2]) - 2) > 0.01) continue;
      for (let k = 1; k <= 3; k++) { const t = k / 4; out.push({ x: lerp(v[i][0], v[j][0], t) / nm, y: lerp(v[i][1], v[j][1], t) / nm, z: lerp(v[i][2], v[j][2], t) / nm, inner: false }); }
    }
    while (out.length < n) out.push({ x: rand(-0.15, 0.15), y: rand(-0.15, 0.15), z: rand(-0.15, 0.15), inner: true });
    return out.slice(0, n);
  });
  addF('tornado', 'Tornado', (n) => arr(n, (i) => {
    const t = i / n, a = t * 16 + (i % 2) * Math.PI, r = 0.12 + 0.9 * t;
    return { x: Math.cos(a) * r, y: t * 2 - 1, z: Math.sin(a) * r, inner: t < 0.3 };
  }));
  addF('gyro', 'Giroscópio', (n) => arr(n, (i) => {
    const k = i % 3, a = (i / n) * Math.PI * 2 * 3;
    const c = Math.cos(a), s = Math.sin(a);
    return { x: k === 2 ? 0 : c, y: k === 0 ? 0 : s * (k === 1 ? 1 : 1), z: k === 0 ? s : k === 2 ? c : 0, inner: k === 1 };
  }));

  /* ---------- 5. TEMAS ---------- */
  const THEMES = [
    ['Ciano / Magenta', [0, 240, 255], [255, 0, 200]],
    ['Âmbar / Carmesim', [255, 176, 0], [255, 40, 60]],
    ['Esmeralda / Violeta', [0, 255, 150], [170, 60, 255]],
    ['Gelo / Dourado', [120, 200, 255], [255, 210, 80]],
  ];
  let themeI = 0, nebula = null, themeCool = 0;

  function setTheme(i) {
    themeI = i % THEMES.length;
    const [name, c, m] = THEMES[themeI];
    c.forEach((v, k) => { CYAN[k] = v; });
    m.forEach((v, k) => { MAGENTA[k] = v; });
    core.spriteCyan = EnergyCore.createGlowSprite(CYAN);
    core.spriteMagenta = EnergyCore.createGlowSprite(MAGENTA);
    gridLayer = buildGridLayer();
    nebula = buildNebula();
    const st = document.documentElement.style, J = (a, al = 1) => `rgba(${a.join(',')},${al})`;
    st.setProperty('--cyan', J(c)); st.setProperty('--cyan-dim', J(c, 0.55)); st.setProperty('--cyan-faint', J(c, 0.14));
    st.setProperty('--magenta', J(m)); st.setProperty('--magenta-dim', J(m, 0.55));
    logEvent(`Tema: ${name}`, 'pulse');
    flashAction(`Tema: ${name}`, 'pulse', 1400);
  }
  window.addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 'c') setTheme(themeI + 1); });

  /* ---------- 2. FUNDO ---------- */
  function buildNebula() {
    const g = document.createElement('canvas');
    g.width = view.w; g.height = view.h;
    const c = g.getContext('2d');
    const blobs = [[0.2, 0.3, 0.55, CYAN, 0.10], [0.8, 0.7, 0.6, MAGENTA, 0.09], [0.55, 0.15, 0.4, MAGENTA, 0.05], [0.4, 0.85, 0.45, CYAN, 0.06]];
    for (const [x, y, r, col, a] of blobs) {
      const R = r * Math.max(view.w, view.h);
      const gr = c.createRadialGradient(x * view.w, y * view.h, 0, x * view.w, y * view.h, R);
      gr.addColorStop(0, rgba(col, a)); gr.addColorStop(1, rgba(col, 0));
      c.fillStyle = gr; c.fillRect(0, 0, view.w, view.h);
    }
    return g;
  }

  let stars = [];
  function initStars() {
    stars = arr(240, (i) => ({ x: Math.random() * view.w, y: Math.random() * view.h, z: 0.15 + Math.random() * 0.85, ph: Math.random() * 6.28 }));
  }
  let floorOff = 0;

  drawBackground = function () {
    const t = performance.now() / 1000;
    const g = ctx.createLinearGradient(0, 0, 0, view.h);
    g.addColorStop(0, '#02030a'); g.addColorStop(1, '#080b1e');
    ctx.fillStyle = g; ctx.fillRect(0, 0, view.w, view.h);
    if (nebula) ctx.drawImage(nebula, 0, 0, view.w, view.h);

    // estrelas em paralaxe: reagem à posição do núcleo
    const ox = (core.pos.x - view.w / 2), oy = (core.pos.y - view.h / 2);
    ctx.fillStyle = rgba(WHITE, 0.8);
    for (const s of stars) {
      s.y += s.z * 0.15; if (s.y > view.h) s.y = 0;
      const x = ((s.x - ox * s.z * 0.06) % view.w + view.w) % view.w, y = s.y - oy * s.z * 0.06;
      ctx.globalAlpha = (0.3 + 0.7 * s.z) * (0.6 + 0.4 * Math.sin(t * 2 + s.ph));
      ctx.fillRect(x, y, s.z * 2, s.z * 2);
    }
    ctx.globalAlpha = 1;

    // piso em perspectiva que acelera com a velocidade do núcleo
    const hy = view.h * 0.6, vx = view.w / 2 + ox * 0.15;
    ctx.strokeStyle = rgba(CYAN, 0.09); ctx.lineWidth = 1; ctx.beginPath();
    for (let i = -12; i <= 12; i++) { ctx.moveTo(vx + i * 18, hy); ctx.lineTo(vx + i * view.w * 0.14, view.h); }
    for (let k = 0; k < 12; k++) { const z = (k + (floorOff % 1)) / 12, y = hy + (view.h - hy) * z * z; ctx.moveTo(0, y); ctx.lineTo(view.w, y); }
    ctx.stroke();

    if (gridLayer) { ctx.globalAlpha = 0.6; ctx.drawImage(gridLayer, 0, 0, view.w, view.h); ctx.globalAlpha = 1; }

    // aura que acompanha o núcleo e muda de cor com o estresse
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    const col = mixColor(CYAN, MAGENTA, core.stress), R = 420 + core.radius * 2;
    const a = ctx.createRadialGradient(core.pos.x, core.pos.y, 0, core.pos.x, core.pos.y, R);
    a.addColorStop(0, rgba(col, 0.14 + core.charge * 0.2)); a.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = a; ctx.fillRect(0, 0, view.w, view.h);
    ctx.restore();
  };

  /* ---------- 6. POEIRA GRAVITACIONAL ---------- */
  const K = 34000; // velocidade orbital ~ sqrt(K)
  const dust = [];
  function spawnDust(p, edge) {
    if (edge) { const s = Math.floor(rand(0, 4)); p.x = s < 2 ? rand(0, view.w) : s === 2 ? 0 : view.w; p.y = s < 2 ? (s ? view.h : 0) : rand(0, view.h); }
    else { const a = rand(0, 6.28), d = rand(120, Math.min(view.w, view.h) * 0.5); p.x = core.pos.x + Math.cos(a) * d; p.y = core.pos.y + Math.sin(a) * d; }
    const dx = core.pos.x - p.x, dy = core.pos.y - p.y, d = Math.hypot(dx, dy) || 1, v = Math.sqrt(K) * rand(0.6, 1.1);
    p.vx = (-dy / d) * v; p.vy = (dx / d) * v;
    return p;
  }
  for (let i = 0; i < 320; i++) dust.push(spawnDust({}, false));

  function updateDust(dt) {
    const hands = trackedHands;
    for (const p of dust) {
      const dx = core.pos.x - p.x, dy = core.pos.y - p.y, d = Math.hypot(dx, dy) || 1;
      if (d < core.radius * 0.45) { spawnDust(p, true); continue; }
      const a = (K * (0.6 + core.radius / 180)) / Math.max(d, 50);
      p.vx += (dx / d) * a * dt; p.vy += (dy / d) * a * dt;
      for (const h of hands) {
        const hx = h.palm.x - p.x, hy = h.palm.y - p.y, hd = Math.hypot(hx, hy) || 1;
        if (hd > 260) continue;
        const f = 1 - hd / 260;
        const sgn = h.gesture === 'open' ? -1 : (h.gesture === 'fist' || h.gesture === 'point') ? 1 : 0;
        p.vx += (hx / hd) * sgn * f * 1500 * dt; p.vy += (hy / hd) * sgn * f * 1500 * dt;
      }
      for (const w of shockwaves) {
        if (w.r <= 0) continue;
        const wx = p.x - w.x, wy = p.y - w.y, wd = Math.hypot(wx, wy) || 1;
        if (Math.abs(wd - w.r) < 50) { p.vx += (wx / wd) * 2600 * dt; p.vy += (wy / wd) * 2600 * dt; }
      }
      const sp = Math.hypot(p.vx, p.vy);
      if (sp > 1100) { p.vx *= 1100 / sp; p.vy *= 1100 / sp; }
      const dr = Math.exp(-0.25 * dt); p.vx *= dr; p.vy *= dr;
      p.x += p.vx * dt; p.y += p.vy * dt;
      if (p.x < -20 || p.x > view.w + 20 || p.y < -20 || p.y > view.h + 20) spawnDust(p, true);
    }
  }

  function drawDust(c) {
    c.save(); c.globalCompositeOperation = 'lighter'; c.lineCap = 'round'; c.lineWidth = 1.6;
    for (const [col, fast] of [[CYAN, false], [MAGENTA, true]]) {
      c.strokeStyle = rgba(col, fast ? 0.85 : 0.55); c.beginPath();
      for (const p of dust) {
        if ((Math.hypot(p.vx, p.vy) > 320) !== fast) continue;
        c.moveTo(p.x, p.y); c.lineTo(p.x - p.vx * 0.018, p.y - p.vy * 0.018);
      }
      c.stroke();
    }
    c.restore();
  }

  /* ---------- 3. CÂMERA EM QUADRO ---------- */
  const pip = { x: 0, y: 0, w: 0, h: 0, hold: 0 };
  function layoutPip() { pip.w = clamp(view.w * 0.2, 220, 340); pip.h = pip.w * 9 / 16; pip.x = view.w - pip.w - 16; pip.y = 16; }

  function drawPip(c, now) {
    const { x, y, w, h } = pip;
    c.save();
    c.fillStyle = 'rgba(4,8,20,0.85)'; c.fillRect(x - 6, y - 6, w + 12, h + 12);
    if (video.readyState >= 2) {
      c.save(); c.beginPath(); c.rect(x, y, w, h); c.clip();
      c.translate(x + w, y); c.scale(-1, 1); c.globalAlpha = 0.9; c.drawImage(video, 0, 0, w, h);
      c.restore();
      c.fillStyle = rgba(CYAN, 0.1); c.fillRect(x, y, w, h);
    }
    const r = getVideoRect();
    c.fillStyle = rgba(MAGENTA, 1);
    for (const hd of trackedHands) for (const i of TIP_INDICES) {
      const p = hd.pts[i];
      c.fillRect(x + ((p.x - r.x) / r.w) * w - 2, y + ((p.y - r.y) / r.h) * h - 2, 4, 4);
    }
    // moldura em cantos + legenda
    c.strokeStyle = rgba(CYAN, 0.9); c.shadowColor = rgba(CYAN, 1); c.shadowBlur = 10; c.lineWidth = 2; c.beginPath();
    const L = 16;
    for (const [cx, cy, sx, sy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
      c.moveTo(cx + sx * L, cy); c.lineTo(cx, cy); c.lineTo(cx, cy + sy * L);
    }
    c.stroke(); c.shadowBlur = 0;
    c.font = '11px "Share Tech Mono", monospace'; c.textBaseline = 'top';
    c.fillStyle = rgba(MAGENTA, Math.sin(now * 0.005) > 0 ? 1 : 0.3); c.fillText('● REC', x + 8, y + 8);
    c.fillStyle = rgba(CYAN, 1); c.textAlign = 'right'; c.fillText(`CAM-01 · ${trackedHands.length} mão(s)`, x + w - 8, y + 8);
    c.textAlign = 'left'; c.fillStyle = 'rgba(217,251,255,0.6)';
    c.fillText(`Tema: ${THEMES[themeI][0]} (pinça aqui / C)`, x, y + h + 10);
    if (pip.hold > 0) { c.fillStyle = rgba(MAGENTA, 0.9); c.fillRect(x, y + h - 3, w * clamp(pip.hold / 0.4, 0, 1), 3); }
    c.restore();
  }

  /* ---------- Módulo plugável ---------- */
  let prevV = { x: 0, y: 0 };
  modules.push({
    update(dt, now) {
      const sp = Math.hypot(core.vel.x, core.vel.y);
      floorOff += dt * (0.15 + sp / 1400);
      updateDust(dt);

      // rastro de velocidade + impacto nas bordas (inversão brusca da velocidade)
      if (sp > 450 && !core.grabbed) spawnSpark(core.pos.x, core.pos.y, rand(-40, 40), rand(-40, 40), 0.45, Math.random() < 0.5 ? CYAN : MAGENTA, 2);
      const psp = Math.hypot(prevV.x, prevV.y);
      if (psp > 600 && core.vel.x * prevV.x + core.vel.y * prevV.y < 0) {
        for (let i = 0; i < 26; i++) { const a = rand(0, 6.28), s = rand(150, 600); spawnSpark(core.pos.x, core.pos.y, Math.cos(a) * s, Math.sin(a) * s, rand(0.3, 0.8), WHITE, 2); }
        shakeAmp = Math.max(shakeAmp, Math.min(14, psp / 200));
        core.shake(0.4);
        logEvent('Impacto na borda', 'pulse');
      }
      prevV = { x: core.vel.x, y: core.vel.y };

      // pinça segurada sobre o quadro da câmera troca o tema
      themeCool -= dt;
      const over = trackedHands.some((h) => h.pinching && h.pinchPoint.x > pip.x && h.pinchPoint.x < pip.x + pip.w && h.pinchPoint.y > pip.y && h.pinchPoint.y < pip.y + pip.h);
      pip.hold = over ? pip.hold + dt : 0;
      if (pip.hold > 0.4 && themeCool <= 0) { themeCool = 1.2; pip.hold = 0; setTheme(themeI + 1); }
    },
    drawWorld(c) { drawDust(c); },
    drawUI(c, now) { drawPip(c, now); },
  });

  function relayout() { layoutPip(); nebula = buildNebula(); initStars(); }
  window.addEventListener('resize', relayout);
  relayout();
  logEvent('Upgrade v3 carregado', 'pulse');
})();