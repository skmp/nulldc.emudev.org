// bench.js: the benchmark as a user feature (FOLLOWUP item 4): the bench button or ?bench runs five scripted camera paths
// and shows a score card (GPU, resolution, fps mean and 1 % low per path, overall score). It records nothing.
// The recording variant (posting results to the dev server) sits between the DEV markers below; tools/build_static.mjs
// strips it from the public build. Screenshot views for the tools live here too.
export function initBench(V) {
  const { F, W, WALLS, LN, Q, U } = V;
  const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const smooth = t => t * t * (3 - 2 * t);
  const lookAt = (p, target) => { V.cam.p = p; V.setLook(target.map((v, i) => v - p[i])); };
  const laneByName = n => LN.find(l => l.name === n);
  const lastFrame = n => laneByName(n).frames.at(-1);
  const zMax = LN.at(-1).z0 + LN.at(-1).L.width;
  const wait = ms => new Promise(r => setTimeout(r, ms));

  // ---- views for screenshots (tools/verify/run.mjs shots)
  V.view = async (name) => {
    if (!V.load.meta) await new Promise(r => V.on('meta', r));
    V.fixedQuality = true; V.setQualityStep(0); if (Q.has('scale')) V.quality.scale = +Q.get('scale'); if (Q.has('t0')) V.quality.t0 = +Q.get('t0'); V.flight = null; V.setMarks(null); V.attract && V.attract.stop();
    V.setPlaying(false); V.presMode = 'clock'; document.getElementById('caption').classList.add('hidden');
    const wall = n => W[lastFrame(n)];
    const opts = {};
    if (name === 'far') { V.setX(V.xMax); const v = V.overview(); V.cam.p = v.p; V.setLook(v.dir); opts.noWalls = true; }
    else if (name.startsWith('read')) {   // close-up at 3 distances: px per line 22, 13, 8 (sh4_opcodes.cpp in nullDC 3)
      const px = { read: 22, 'read-near': 22, 'read-mid': 13, 'read-far': 8 }[name] || 22;
      const w = wall('nulldc3'); V.setX(w.x + 1);
      const k = w.meta.paths.findIndex(p => p.endsWith('interpr/sh4_opcodes.cpp')), s = w.meta.slot[k];
      await V.ensureWall(w.i); const line = await V.findLine(w, w.slotToFile.get(s), 'ToDo : Check This') || 40;
      const v = V.slotView(w, s, Math.max(1, line - 4), px); V.cam.p = v.p; V.setLook(v.dir);
    } else if (name === 'morph') {   // Now mode, a flycast frame mid-morph, frontal at reading range where most lines arrive
      const ln = laneByName('flycast'); let k = ln.frames.findIndex(f => F.frames[f].d && F.frames[f].d[1] > 400 && F.frames[f].d[1] < 6000 && F.frames[f].k > 2);
      if (k < 1) k = 10; const b = ln.frames[k], a = ln.frames[k - 1], xb = W[b].x, mL = Math.min(0.75 * U, xb - W[a].x);
      V.presMode = 'now'; V.setX(xb - mL * 0.45, { follow: false });
      await wait(100); { const v0 = V.wallView(W[a], 20, 600, V.readDist(11)); V.cam.p = v0.p; V.setLook(v0.dir); }   // near the live wall, so the morph is requested
      for (let i = 0; i < 300 && !(V.morph && V.morph.b === b); i++) await wait(50);
      const m = V.morph ? V.morph.m : null;
      let col = 20, row = 600;
      if (m) { const cnt = new Map(); for (let i = 0; i < m.nKA; i++) if (((m.inst[4 * i + 1] >>> 20) & 3) === 1) { const p = m.inst[4 * i + 1], key = (p & 511) * 64 + (((p >>> 9) & 2047) >> 5); cnt.set(key, (cnt.get(key) || 0) + 1); }
        const best = [...cnt].sort((x, y) => y[1] - x[1])[0]; if (best) { col = best[0] >> 6; row = (best[0] & 63) * 32 + 16; } }
      const v = V.wallView(W[b], col, row, V.readDist(11)); V.cam.p = v.p; V.setLook(v.dir); opts.morph = true;
    } else if (name === 'now') { V.presMode = 'now'; V.setX(W[laneByName('reicast').frames[40]].x + 0.3 * U, { follow: false }); lookAt([V.X - 30000, 9000, 40000], [V.X, 1500, 75000]); opts.noWalls = true; }
    else if (name === 'fork') { const fs = [28, 14, 42, 43, 29].filter(f => W[f]); V.setX(W[42].x + 1); const v = V.fitBox(V.wallsBox(fs), [0.88, -0.42, 0.12]); V.cam.p = v.p; V.setLook(v.dir); opts.noWalls = true; }
    else if (name === 'fpgadc') { const fs = WALLS.filter(w => LN[w.lane].L.group === 'fpgadc' && (w.solidRelease || w.i === LN[w.lane].frames.at(-1))).map(w => w.i); V.setX(V.xMax); const v = V.fitBox(V.wallsBox(fs), [0.62, -0.5, 0.6]); V.cam.p = v.p; V.setLook(v.dir); opts.noWalls = true; }
    else if (name === 'attract') {   // an attract caption over its line
      const it = V.attract.items.find(i => i.curated) || V.attract.items[0], st = it.stops[Math.min(1, it.stops.length - 1)], w = W[st[0]];
      V.setX(w.x + 1); await V.ensureWall(w.i); V.setMarks([it.id]);
      const v = V.slotView(w, V.slotOf(w, st[1]), st[2] + 1, 22); V.cam.p = v.p; V.setLook(v.dir); V.attract.caption(it, st);
      document.body.classList.add('attract');   // as in a real tour: panels faded, the caption alone
    } else if (name === 'hero') {   // og:image: Gallery (every frame solid), walls from ?heroy= (default 2016) on, wide oblique shot
      const y0 = Q.get('heroy') || '2016', dir = (Q.get('herodir') || '0.55,-0.42,0.72').split(',').map(Number);
      const fs = WALLS.filter(w => (F.frames[w.i].date || '') >= y0).map(w => w.i);
      V.presMode = 'gallery'; V.setX(V.xMax + U); const v = V.fitBox(V.wallsBox(fs), dir);
      const bb = V.wallsBox(fs), C = [0, 1, 2].map(i => (bb[0][i] + bb[1][i]) / 2), z = +(Q.get('herozoom') || 1);   // zoom > 1: closer
      V.cam.p = v.p.map((c, i) => C[i] + (c - C[i]) / z); V.setLook(v.dir);
    } else if (name === 'rec') { await V.gotoBookmark('nullDC rec_v1 driver', { instant: true }); }
    const ms = await V.whenReady({ timeout: 90000, ...opts });
    await wait(500);
    return { ms, renderer: V.RENDERER, cam: V.cam.p, X: V.X, stats: { draws: V.stats.draws, inst: V.stats.inst, walls: V.load.walls } };
  };

  // ---- scripted paths
  async function pathA() {   // a famous file through the frames that hold it (gallery)
    const it = (V.attract.items || []).find(i => i.kind === 'file' && /interpreter/.test(i.title)) || V.attract.items.find(i => i.kind === 'file');
    const keys = it.stops.map(([f, ident]) => { const w = W[f]; return V.slotView(w, V.slotOf(w, ident), 0, 9).p; });
    V.presMode = 'gallery'; V.setX(V.xMax + U);
    return t => { const x = t * (keys.length - 1), i = Math.min(keys.length - 2, Math.floor(x)), f = smooth(x - i); V.cam.p = lerp(keys[i], keys[i + 1], f); V.setLook([1, -0.05, 0.03]); };
  }
  const pathB = async () => { V.presMode = 'gallery'; V.setX(V.xMax + U); return t => { const a = t * Math.PI * 2, c = [(V.xMin + V.xMax) / 2, 0, zMax / 2]; lookAt([c[0] - Math.cos(a) * 520000, 260000, c[2] + Math.sin(a) * 300000], c); }; };
  const pathC = async () => { V.presMode = 'gallery'; V.setX(V.xMax + U); const lanes = ['nullDC', 'reicast', 'flycast', 'nulldc3', 'nullDC4Wii'].map(laneByName);
    return t => { const passes = lanes.length, x = t * passes, i = Math.min(passes - 1, Math.floor(x)), f = x - i, L = lanes[i];
      V.cam.p = [L.xs[0] - 6000 + f * (L.xs.at(-1) - L.xs[0] + 8000), 3000, L.z0 + L.L.width / 2 - 1500]; V.setLook([1, -0.06, 0.02]); }; };
  const pathD = async () => { const w = W[lastFrame('nulldc3')]; V.presMode = 'clock'; V.setX(V.xMax + U); const d = V.readDist(12);
    return t => { V.cam.p = [w.x - d, 2048 + Math.sin(t * Math.PI * 6) * 1700, w.z0 + 200 + t * (w.cols * 128 - 400)]; V.setLook([1, 0, 0]); }; };
  const pathE = async () => {   // Now mode: the clock plays 2010 -> 2026 across every lane; the camera rides along over the emulator lanes
    V.presMode = 'now'; const x0 = W[laneByName('nullDC').frames[0]].x, x1 = V.xMax;
    return t => { V.setX(x0 + (x1 - x0) * t, { follow: false }); lookAt([V.X - 26000, 11000, 30000], [V.X, 1800, 70000]); }; };
  const PATHS = { A: pathA, B: pathB, C: pathC, D: pathD, E: pathE };
  const NAMES = { A: 'file street', B: 'orbit', C: 'lane flights', D: 'close reading', E: 'live playback' };
  V.runBench = async (name, dur = 20) => {
    V.attract && V.attract.stop(); V.setPlaying(false); V.flight = null;
    V.fixedQuality = Q.get('fixed') === '1';
    const step = await PATHS[name]();
    step(0); const readyMs = await V.whenReady({ timeout: 60000 });
    const rec = []; let t0 = null; V.prof.worst.length = 0; V.bench = true; let lastGpuN = V.stats.gpuN || 0; const sk0 = V.stats.skipped;
    await new Promise(res => {
      const tick = () => {
        const now = performance.now(); if (t0 === null) t0 = now;
        const t = Math.min(1, (now - t0) / (dur * 1000)); step(t);
        if (t >= 1) { V.off('tick', tick); V.off('frame', fr); res(); }
      };
      const fr = ({ cpu, rawDt }) => { if (t0 === null) return; const gNew = (V.stats.gpuN || 0) !== lastGpuN ? V.stats.gpu.at(-1) : null; lastGpuN = V.stats.gpuN || 0;
        rec.push([rawDt, cpu, gNew, V.stats.draws, V.stats.inst, V.quality.step]); };
      V.on('tick', tick); V.on('frame', fr);
    });
    V.bench = false;
    const col = i => rec.map(r => r[i]).filter(v => v != null).slice(2);
    const pc = (a, p) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2); };
    const dt = col(0), cpu = col(1), gpu = col(2), sorted = dt.slice().sort((a, b) => b - a), worst = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 100)));
    const out = { path: name, name: NAMES[name], dur, frames: rec.length, renderer: V.RENDERER, soft: V.SOFT, viewport: [innerWidth, innerHeight], dpr: devicePixelRatio, canvas: [V.gl.canvas.width, V.gl.canvas.height],
      fps_mean: +(1000 * dt.length / dt.reduce((a, b) => a + b, 0)).toFixed(1), fps_1pct_low: +(1000 / (worst.reduce((a, b) => a + b, 0) / worst.length)).toFixed(1),
      frame_ms: { p50: pc(dt, .5), p95: pc(dt, .95), p99: pc(dt, .99), max: pc(dt, 1) }, cpu_ms: { p50: pc(cpu, .5), p95: pc(cpu, .95), p99: pc(cpu, .99) },
      gpu_ms: gpu.length ? { p50: pc(gpu, .5), p95: pc(gpu, .95), p99: pc(gpu, .99) } : null,
      draws_p95: pc(col(3), .95), lines_p95: pc(col(4), .95), quality_steps: [...new Set(col(5))], frames_over_100ms: dt.filter(v => v > 100).length, ready_ms: Math.round(readyMs),
      skipped_rafs: V.stats.skipped - sk0, slowest_frames_cpu_sections: V.prof.worst.slice(), frames_csv: rec.map(r => r.map(v => v == null ? '' : +(+v).toFixed(3)).join(',')).join('\n') };
    window.__bench = out;
    return out;
  };
  // ---- the score card
  const card = document.getElementById('scorecard');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function showCard(res, running) {
    const rows = Object.values(res);
    const gm = rows.length ? Math.exp(rows.reduce((a, r) => a + Math.log(Math.max(1, r.fps_mean)), 0) / rows.length) : 0;
    const lowGm = rows.length ? Math.exp(rows.reduce((a, r) => a + Math.log(Math.max(1, r.fps_1pct_low)), 0) / rows.length) : 0;
    const c = V.gl.canvas;
    card.innerHTML = `<h3>Benchmark${running ? ': running ' + esc(running) : ''}</h3>
      <div class="small">${esc(V.RENDERER)}<br>${c.width} x ${c.height} px canvas (${innerWidth} x ${innerHeight} CSS px, dpr ${devicePixelRatio})${V.SOFT ? ' | software renderer' : ''}</div>
      <table><tr><th>path</th><th>fps mean</th><th>1 % low</th><th>frame p95</th><th>GPU p95</th></tr>
      ${rows.map(r => `<tr><td>${r.path} ${esc(r.name)}</td><td>${r.fps_mean}</td><td>${r.fps_1pct_low}</td><td>${r.frame_ms.p95} ms</td><td>${r.gpu_ms ? r.gpu_ms.p95 + ' ms' : 'n/a'}</td></tr>`).join('')}</table>
      ${rows.length && !running ? `<div class="score">${Math.round(gm * 10)}</div><div class="small" style="text-align:center">score = 10 x geometric mean of the fps means (${gm.toFixed(1)} fps; 1 % lows ${lowGm.toFixed(1)} fps). Nothing was recorded or sent.</div>` : ''}
      <div style="text-align:right;margin-top:6px"><button id="bclose">close</button></div>`;
    card.classList.remove('hidden'); document.getElementById('bclose').onclick = () => card.classList.add('hidden');
  }
  V.benchAll = async (list = ['A', 'B', 'C', 'D', 'E'], dur = +(Q.get('dur') || 15)) => {
    const res = {};
    for (const p of list) { showCard(res, `${p} ${NAMES[p]}`); res[p] = await V.runBench(p, dur); }
    showCard(res, null);
    return res;
  };
  document.getElementById('tbench').onclick = () => { if (!V.bench) V.benchAll(); };
  
  if (Q.has('bench')) setTimeout(async () => {
    await V.whenReady({ timeout: 60000 });
    const b = Q.get('bench'), list = !b || b === 'all' || b === '1' ? ['A', 'B', 'C', 'D', 'E'] : b.split(',');
    const res = await V.benchAll(list, +(Q.get('dur') || 15));
    
    for (const r of Object.values(res)) delete r.frames_csv;
    console.log('BENCH', JSON.stringify(res));
  }, 50);
}
