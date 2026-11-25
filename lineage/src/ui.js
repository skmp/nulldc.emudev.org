// ui.js: HUD, legend / colour modes, timeline (shared clock, release marks), minimap, tooltip, search, bookmarks, story,
// file panel, keys, URL hash
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MODES = ['origin', 'age', 'survival', 'diff vs previous', 'repo of origin'];

export function initUI(V) {
  const { F, layout, story, W, WALLS, LN, tm, U } = V;
  const lanes = layout.lanes;
  const fmtDate = x => { const m = tm.monthOfX(x); return tm.dateOfMonth(m); };

  // ---------------- modes + legend
  const modesEl = $('modes');
  MODES.forEach((m, i) => { const b = document.createElement('button'); b.textContent = `${i + 1} ${m}`; b.onclick = () => setMode(i); modesEl.appendChild(b); });
  function setMode(i) { V.mode = i; V.invalidateImpostors(); [...modesEl.children].forEach((b, k) => b.classList.toggle('on', k === i)); legend(true); saveHash(); }
  V.setMode = setMode;
  $('hideinc').onchange = e => { V.hideInc = e.target.checked; V.invalidateImpostors(); };
  let legendKey = '';
  function legend(force) {
    const liveKey = LN.map(l => V.laneFrameAt(l.li)).join(',');
    const key = `${V.mode}|${liveKey}`; if (!force && key === legendKey) return; legendKey = key;
    let h = '';
    if (V.mode === 0 || V.mode === 4 || V.mode === 1) {
      h += `<div class="small">${V.mode === 1 ? 'age of the line\'s first appearance (2003 dark to 2026 yellow)' : 'where each line first appeared; per lane: the frame at the clock'}</div>`;
      for (const [li, L] of lanes.entries()) {
        const f = V.laneFrameAt(li), fr = f >= 0 ? F.frames[f] : null;
        h += `<div class="lrow" data-lane="${li}"><span class="sw" style="background:${V.palette.lane(li)}"></span><span class="lname" title="${esc(L.title)}">${esc(L.name)}</span>`;
        h += `<span class="ldate">${fr ? esc(fr.date + (fr.tags ? ' ' + fr.tags.join(',') : '')) : 'not yet'}</span></div>`;
      }
      h += `<div class="lrow"><span class="sw" style="background:${V.palette.origin(F.virt)}"></span><span class="lname">nullDC-pre2008</span><span class="ldate">in nullDCe 2009 and nullDC</span></div>`;
    } else if (V.mode === 2) h += `<div class="small">survival: of the later frames that could hold the line (its lane and the lanes forked from it), the share that do: <span class="sw" style="background:#d94040"></span> few <span class="sw" style="background:#3399ff"></span> all. Grey: trivial lines.</div>`;
    else if (V.mode === 3) h += `<div class="small"><span class="sw" style="background:#4df266"></span> added since the lane's previous frame, <span class="sw" style="background:#666b78"></span> unchanged</div>`;
    $('legendbody').innerHTML = h;
    $('legendbody').querySelectorAll('.lrow[data-lane]').forEach(e => e.onclick = () => goLane(+e.dataset.lane));
  }
  V.legend = legend;
  function goLane(li) { const f = V.laneFrameAt(li) >= 0 ? V.laneFrameAt(li) : LN[li].frames[0]; const w = W[f]; if (V.laneFrameAt(li) < 0) V.setX(w.x + 1, { follow: false }); const v = V.fitWall(w); V.flyTo(v.p, v.dir); }
  V.goLane = goLane;

  // ---------------- timeline
  const slider = $('tslider'), ticks = $('ticks');
  slider.min = String(Math.floor(V.xMin)); slider.max = String(Math.ceil(V.xMax)); slider.step = '1';
  slider.oninput = () => { V.setX(+slider.value); };
  $('tplay').onclick = () => V.setPlaying(!V.playing);
  $('tspeed').onchange = e => { V.speed = +e.target.value; };
  const stepMonth = d => { const m = Math.round(tm.monthOfX(V.X)) + d; V.setX(tm.xOfMonth(m) + 1); };
  $('tstepb').onclick = () => stepMonth(-1); $('tstepf').onclick = () => stepMonth(1);
  const rels = WALLS.filter(w => w.release).sort((a, b) => a.x - b.x);
  const relAfter = (d) => { const x = V.X + d * 2; return d > 0 ? rels.find(w => w.x > x) : rels.slice().reverse().find(w => w.x < x - 2); };
  const jumpRel = d => { const w = relAfter(d); if (w) { V.setX(w.x + 1); V.toast(`${w.releaseLabel || ''} (${w.fr.lane} ${w.fr.date})`); } };
  V.jumpRelease = jumpRel;
  $('tprev').onclick = () => jumpRel(-1); $('tnext').onclick = () => jumpRel(1);
  $('tpres').onclick = () => V.cyclePres();
  // release ticks: every release / tag on the time axis (click = jump); labels only where they fit
  const tickX = x => (x - V.xMin) / (V.xMax - V.xMin);
  function drawTicks() {
    const c = ticks, w = c.clientWidth, h = 26; if (c.width !== w) c.width = w; const g = c.getContext('2d'); g.clearRect(0, 0, w, h);
    const x0 = slider.getBoundingClientRect().left - c.getBoundingClientRect().left + 7, x1 = x0 + slider.clientWidth - 14, px = x => x0 + (x1 - x0) * tickX(x);
    // years (only where they fit, in order)
    g.font = '10px system-ui'; g.fillStyle = '#8b93a6'; let last = -1e9;
    for (const r of layout.ruler) if (r.year) { const X = px(r.x); if (X - last < 30) continue; last = X; g.fillRect(X, 0, 1, 5); g.fillText(String(r.year), X + 2, 9); }
    for (const r of layout.ruler) if (r.gap) { const X = px(r.x); g.fillStyle = '#5a5040'; g.fillRect(X - 1, 0, 3, 8); }
    // release marks: DreamSTer pins yellow, tags blue-grey
    let lastL = -1e9;
    for (const wl of rels) { const X = px(wl.x), dream = !!wl.releaseLabel && wl.releaseLabel.startsWith('DreamSTer');
      g.fillStyle = dream ? '#ffd25a' : '#7c9cc8'; g.fillRect(X, 11, 1.5, dream ? 9 : 6); }
    g.font = '9px system-ui';
    for (const wl of rels) { const X = px(wl.x); const lab = wl.releaseLabel || ''; if (!lab || X - lastL < 70) continue;
      const short = lab.replace('DreamSTer ', 'DS ').slice(0, 14); g.fillStyle = '#b8c3d6'; g.fillText(short, X + 2, 25); lastL = X + g.measureText(short).width; }
    const cx = px(V.X); g.fillStyle = '#7cc4ff'; g.fillRect(cx - 1, 0, 2, h);
    ticks._px = px; ticks._x0 = x0; ticks._x1 = x1;
  }
  ticks.onclick = e => {
    const r = ticks.getBoundingClientRect(), mx = e.clientX - r.left;
    let best = null, bd = 8; for (const wl of rels) { const d = Math.abs(ticks._px(wl.x) - mx); if (d < bd) { bd = d; best = wl; } }
    if (best) { V.setX(best.x + 1); V.toast(`${best.releaseLabel} (${best.fr.lane} ${best.fr.date})`); }
    else V.setX(V.xMin + (mx - ticks._x0) / (ticks._x1 - ticks._x0) * (V.xMax - V.xMin));
  };
  ticks.onmousemove = e => { const r = ticks.getBoundingClientRect(), mx = e.clientX - r.left; let best = null, bd = 8;
    for (const wl of rels) { const d = Math.abs(ticks._px(wl.x) - mx); if (d < bd) { bd = d; best = wl; } }
    ticks.title = best ? `${best.releaseLabel}: ${best.fr.lane} ${best.fr.date} (click to jump)` : 'click to set the time'; };
  function timeUI() {
    if (document.activeElement !== slider) slider.value = String(Math.round(V.X));
    $('tplay').textContent = V.playing ? '❚❚' : '▶'; $('tplay').classList.toggle('on', V.playing);
    $('tpres').textContent = { clock: 'Clock', now: 'Now', gallery: 'Gallery' }[V.presMode]; $('tpres').classList.toggle('on', V.presMode !== 'clock');
    const d = fmtDate(V.X), rel = rels.filter(w => Math.abs(w.x - V.X) < U * 0.5).map(w => w.releaseLabel).filter(Boolean);
    $('tdate').textContent = `${d}  ${{ clock: '(frames at the clock)', now: '(live walls)', gallery: '(every frame)' }[V.pres()]}${rel.length ? '  ' + [...new Set(rel)].slice(0, 2).join(', ') : ''}`;
    drawTicks(); legend();
  }
  // the clock moves every frame while playing: repaint the DOM / canvas parts at most ~6 times a second (software
  // compositors pay for every repainted layer)
  let tuiT = 0, tuiPending = false;
  const timeUIThrottled = () => { const now = performance.now(); if (now - tuiT > 160) { tuiT = now; timeUI(); } else if (!tuiPending) { tuiPending = true; setTimeout(() => { tuiPending = false; tuiT = performance.now(); timeUI(); }, 170); } };
  V.on('time', timeUIThrottled); addEventListener('resize', drawTicks);
  $('tmusic').onclick = () => V.score && V.score.toggle();
  $('vol').oninput = e => V.score && V.score.setVolume(+e.target.value);
  V.on('score', s => { $('tmusic').classList.toggle('on', s.on && !s.muted); $('tmusic').textContent = s.on ? (s.muted ? '♪ muted' : '♪ on') : '♪'; });
  $('tattract').onclick = () => V.attract && V.attract.start('button');

  // ---------------- HUD (small, bottom left above the timeline; it never covers what a view centres on)
  function hud() {
    const fps = V.stats.dt.length ? 1000 / (V.stats.dt.slice(-60).reduce((a, b) => a + b, 0) / Math.min(60, V.stats.dt.length)) : 0;
    const g = V.stats.gpu.length ? V.stats.gpu.at(-1).toFixed(2) + ' ms' : 'n/a';
    const w = nearestWall();
    $('hud').innerHTML = `<b>${fmtDate(V.X)}</b> ${V.pres()}  ${fps.toFixed(0)} fps  gpu ${g}  q${V.quality.step}\n` +
      `${w ? esc(V.trunc(`${w.fr.lane} ${w.fr.date}${w.fr.tags ? ' ' + w.fr.tags.join(',') : ''}`, 44)) : ''}  lines ${(V.stats.inst / 1000).toFixed(0)}k  walls ${V.load.walls}  ${V.load.text}/${F.text_chunks} text`;
  }
  V.on('hud', hud);
  function nearestWall() {
    let best = null, bd = 1e18; const c = V.cam.p;
    for (const w of WALLS) { if (!V.isSolid(w)) continue; const x = V.dispX(w); if (x < c[0]) continue; const d = (x - c[0]) ** 2 + Math.max(0, w.z0 - c[2], c[2] - w.z0 - w.cols * 128) ** 2; if (d < bd) { bd = d; best = w; } }
    return best;
  }
  V.nearestWall = nearestWall;

  // ---------------- minimap: lanes (rows) x time; year ticks only where they fit
  const mm = $('mm'), mg = mm.getContext('2d');
  const zMax = LN.at(-1).z0 + LN.at(-1).L.width, mx0 = V.xMin - 4 * U, mx1 = V.xMax + 4 * U;
  const MX = x => 30 + (x - mx0) / (mx1 - mx0) * (mm.width - 36), MZ = z => 14 + (z / zMax) * (mm.height - 26);
  function minimap() {
    mg.clearRect(0, 0, mm.width, mm.height); mg.font = '9px system-ui';
    let last = -1e9; mg.fillStyle = '#6b7385';
    for (const r of layout.ruler) if (r.year) { const X = MX(r.x); if (X - last < 26) continue; last = X; mg.fillRect(X, 10, 1, mm.height - 16); mg.fillText(String(r.year).slice(2), X - 5, 9); }
    for (const ln of LN) {
      mg.fillStyle = `rgb(${ln.rgb.join(',')})`;
      for (const x of ln.xs) mg.fillRect(MX(x), MZ(ln.z0), 1, Math.max(1.5, MZ(ln.z0 + ln.L.width) - MZ(ln.z0) - 1));
      if (MZ(ln.z0 + ln.L.width) - MZ(ln.z0) >= 7 && ln.L.group !== 'fpgadc') mg.fillText(ln.name.slice(0, 6), 1, MZ(ln.z0) + 6);
    }
    mg.fillStyle = '#78e6dc'; mg.fillText('fpgadc', 1, MZ(layout.fpgadc.z0) + 8);
    mg.fillStyle = '#7cc4ff'; mg.fillRect(MX(V.X) - 0.5, 10, 1.5, mm.height - 14);
    const c = V.cam.p, f = V.camBasis().f; mg.strokeStyle = '#fff'; mg.beginPath(); mg.arc(MX(c[0]), MZ(c[2]), 3, 0, 7); mg.stroke();
    mg.beginPath(); mg.moveTo(MX(c[0]), MZ(c[2])); mg.lineTo(MX(c[0]) + f[0] * 12, MZ(c[2]) + f[2] * 12); mg.stroke();
  }
  V.on('hud', minimap);
  mm.onclick = e => { const r = mm.getBoundingClientRect(), x = mx0 + (e.clientX - r.left - 30) / (mm.width - 36) * (mx1 - mx0), z = (e.clientY - r.top - 14) / (mm.height - 26) * zMax;
    V.flyTo([x - 9000, 5000, z], [1, -0.3, 0]); };

  // ---------------- tooltip
  const tip = $('tip'); let tipReq = 0;
  function laneTitle(li) { return lanes[li].title; }
  async function showTip(r, mx, my, pinned) {
    if (!r || r.kind === 'empty') { if (!V.pinned || pinned) tip.classList.add('hidden'); V.hi = null; return; }
    const req = ++tipReq, w = r.w, fr = w.fr;
    let h = `<b>${esc(laneTitle(w.lane))}</b> <span class="small">${esc(fr.date)}${fr.approx ? ' (approx.)' : ''}${fr.tags ? ' | ' + esc(fr.tags.join(', ')) : ''} | ${esc(fr.commit || '')}</span><br>`;
    if (r.path) h += `<span class="small">${esc(r.path)}${r.n ? ` (${r.n} lines${r.st ? ', ' + r.st : ''})` : ''}</span>`;
    if (r.kind === 'line') {
      const t = (await V.lineText([r.id]))[0]; if (req !== tipReq) return;
      h += `<pre>${esc(t ?? '(text loading)')}</pre>`;
      const o = r.origin, ofr = F.frames[o];
      if (r.keep === 511) h += `<span class="small">line ${r.line}: trivial (blank / brackets); coloured as the file</span>`;
      else {
        const poss = F.possible[o] ? F.possible[o][w.lane] : 0;
        h += `<span class="small">line ${r.line} | first seen: <b>${esc(V.palette.originName(o))}</b>${ofr.virtual ? ' (2005-2008)' : ''} | kept in ${r.keep} of ${poss} later frames that could hold it${r.flags & 2 ? ' | added in this frame' : ''}${r.flags & 1 ? ' | incidental match' : ''}</span>`;
      }
      V.hi = { f: w.i, a: r.j, b: r.j + 1 };
    } else if (r.kind === 'header') h += `<div class="small">file header: click for the file panel</div>`;
    else if (r.kind === 'hole') h += `<div class="small">empty slot: a file of this lane that is not in this frame</div>`;
    else if (r.kind === 'unloaded') h += `<div class="small">streaming this frame…</div>`;
    tip.innerHTML = h; tip.classList.remove('hidden');
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    tip.style.left = Math.min(innerWidth - tw - 8, mx + 16) + 'px'; tip.style.top = Math.min(innerHeight - th - 8, my + 16) + 'px';
  }
  let hoverT = 0;
  V.on('frame', () => {
    if (V.pinned || !V.mouse || !V.mouse.over || V.attractOn) return;
    const now = performance.now(); if (now - hoverT < 120) return; hoverT = now;
    showTip(V.pick(V.mouse.x, V.mouse.y), V.mouse.x, V.mouse.y, false);
  });
  V.on('click', e => {
    const r = V.pick(e.clientX, e.clientY);
    if (r && r.kind === 'header') { filePanel(r); return; }
    if (V.pinned) { V.pinned = null; tip.classList.add('hidden'); return; }
    if (r && r.kind === 'line') { V.pinned = r; showTip(r, e.clientX, e.clientY, true); }
  });
  V.on('dblclick', e => { const r = V.pick(e.clientX, e.clientY); if (r && r.slot >= 0) V.flyToSlot(r.w, r.slot, r.line || 0); });

  // ---------------- file panel: the file through every lane and frame that holds it
  let idents = null;
  async function loadIdents() { if (idents) return idents; const r = await fetch('data/identities.json.gz'); idents = JSON.parse(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text()); return idents; }
  async function filePanel(r) {
    const el = $('filepanel'), I = await loadIdents(), id = r.ident, rec = I[id];
    let h = `<h3>${esc(r.path)}</h3><div class="small">${r.n} lines in ${esc(r.w.fr.lane)} ${esc(r.w.fr.date)} | identity ${id}${rec && rec.from >= 0 ? ` (copied / imported from ${esc(I[rec.from].p)})` : ''}</div>`;
    if (rec) for (const [li, f0, f1] of rec.v) {
      h += `<div class="lrow" data-li="${li}" data-f0="${f0}" data-f1="${f1}"><span class="sw" style="background:${V.palette.lane(li)}"></span><span class="lname">${esc(lanes[li].name)}</span><span class="ldate">${esc(F.frames[f0].date)} to ${esc(F.frames[f1].date)}</span></div>`;
    }
    h += `<div class="small">click a lane: fly to the file there at the clock (or its first frame). [ ] step through the lane's frames.</div><button id="fpclose">close</button>`;
    el.innerHTML = h; el.classList.remove('hidden');
    $('fpclose').onclick = () => el.classList.add('hidden');
    el.querySelectorAll('.lrow').forEach(e => e.onclick = () => {
      const li = +e.dataset.li, f0 = +e.dataset.f0, f1 = +e.dataset.f1;
      let f = V.laneFrameAt(li); if (f < 0 || F.frames[f].date < F.frames[f0].date || F.frames[f].date > F.frames[f1].date) { f = f0; V.setX(W[f0].x + 1, { follow: false }); }
      const w = W[f], s = V.slotOf(w, id); if (s !== undefined) V.flyToSlot(w, s, 0);
    });
  }
  V.filePanel = filePanel;

  // ---------------- search
  const sq = $('sq'), sres = $('sres'), sstat = $('sstat');
  let sT = 0;
  sq.oninput = () => { clearTimeout(sT); sT = setTimeout(runSearch, 250); };
  $('skind').onchange = runSearch;
  async function runSearch() {
    const q = sq.value, kind = $('skind').value; if (!q) { sres.innerHTML = ''; V.setMarks(null); return; }
    if (kind === 'path') {   // over the frames at the clock
      const out = [];
      for (const ln of LN) { const f = V.laneFrameAt(ln.li); const w = f >= 0 ? W[f] : null; if (!w || !w.meta) continue;
        w.meta.paths.forEach((p, k) => { if (p.toLowerCase().includes(q.toLowerCase())) out.push([w, k, p]); }); }
      sstat.textContent = `${out.length} files in the frames at the clock`;
      sres.innerHTML = out.slice(0, 200).map(([w, k, p], i) => `<div class="res" data-i="${i}"><b>${esc(w.fr.lane)}</b> <code>${esc(p)}</code></div>`).join('');
      sres.querySelectorAll('.res').forEach(e => e.onclick = () => { const [w, k] = out[+e.dataset.i]; V.flyToSlot(w, w.meta.slot[k], 0); });
      return;
    }
    const r = await V.search(q, { regex: kind === 'regex', ci: !/[A-Z]/.test(q), max: 5000 });
    if (r.error) { sstat.textContent = r.error; return; }
    sstat.textContent = `${r.hits.length}${r.hits.length >= 5000 ? '+' : ''} distinct lines${r.partial ? ' (text still loading)' : ''} in ${r.ms.toFixed(0)} ms`;
    V.setMarks(r.hits);
    sres.innerHTML = r.hits.slice(0, 200).map((id, i) => `<div class="res" data-id="${id}"><code>${esc((r.text[i] || '').trim().slice(0, 140))}</code></div>`).join('');
    sres.querySelectorAll('.res').forEach(e => e.onclick = () => gotoLine(+e.dataset.id));
  }
  // fly to a line id: the frames at the clock first, then every lane's last frame
  async function gotoLine(id) {
    const fs = [...LN.map(l => V.laneFrameAt(l.li)).filter(f => f >= 0), ...LN.map(l => l.frames.at(-1))];
    sstat.textContent = 'locating…';
    const hit = await V.locate(id, [...new Set(fs)]);
    if (!hit) { sstat.textContent = 'not in the frames at the clock or the lane tips'; return; }
    const w = W[hit.f]; if (V.laneFrameAt(w.lane) !== hit.f) V.setX(w.x + 1, { follow: false });
    const s = V.slotOf(w, hit.ident); V.flyToSlot(w, s, hit.line + 1); sstat.textContent = `${w.fr.lane} ${w.fr.date}`;
  }
  V.gotoLine = gotoLine;

  // ---------------- bookmarks + story
  async function gotoBookmark(title, opts = {}) {
    const b = story.bookmarks.find(x => x.title === title); if (!b) return null;
    const w = W[b.frame]; V.setPlaying(false); V.presMode = 'clock'; V.setX(w.x + 1, { follow: false });
    const mt = w.meta || await new Promise(res => V.on('meta', () => res(w.meta)));
    const k = mt.paths.indexOf(b.path); if (k < 0) return null;
    const s = mt.slot[k]; let line = b.line || 0;
    if (b.grep) { const ww = await V.ensureWall(w.i); if (ww) { const kk = ww.slotToFile.get(s); line = (await V.findLine(ww, kk, b.grep)) || line; } }
    const v = V.slotView(w, s, line);
    if (opts.instant) { V.cam.p = v.p; V.setLook(v.dir); } else V.flyTo(v.p, v.dir);
    return { w, s, line, b };
  }
  V.gotoBookmark = gotoBookmark;
  $('bmbody').innerHTML = [...new Set(story.bookmarks.map(b => b.group))].map(g => `<div class="small" style="margin-top:4px">${esc(g)}</div>` +
    story.bookmarks.filter(b => b.group === g).map(b => `<div class="res" data-t="${esc(b.title)}">${esc(b.title)} <span class="small">${esc(b.lane)} ${esc(b.date)}</span></div>`).join('')).join('');
  $('bmbody').querySelectorAll('.res').forEach(e => e.onclick = () => gotoBookmark(e.dataset.t));
  $('storybody').innerHTML = `<p class="small">nullDC, nullDCe, reicast and nullDC 3 were started by ${esc(story.author.handle)} (said "${esc(story.author.said)}"). Click a chapter to go there.</p>` +
    story.chapters.map((c, i) => `<div class="ch" data-i="${i}"><b>${esc(c.title)}</b><p>${esc(c.text)}</p></div>`).join('');
  $('storybody').querySelectorAll('.ch').forEach(e => e.onclick = () => {
    const c = story.chapters[+e.dataset.i], [ln] = Object.keys(c.frames), [f0] = c.frames[ln];
    V.setPlaying(false); V.presMode = 'clock'; V.setX(W[f0].x + 1, { follow: false });
    const fs = Object.values(c.frames).flatMap(([a, b]) => [a, b]); const v = V.fitBox(V.wallsBox(fs), [0.75, -0.4, 0.4]); V.flyTo(v.p, v.dir);
  });

  // ---------------- keys
  const toggle = id => $(id).classList.toggle('hidden');
  function laneStep(d) {   // same place in the lane's previous / next frame
    const w = nearestWall(); if (!w) return;
    const ln = LN[w.lane], k = ln.frames.indexOf(w.i) + d; if (k < 0 || k >= ln.frames.length) return;
    const w2 = W[ln.frames[k]], dx = V.cam.p[0] - V.dispX(w);
    if (V.pres() === 'gallery') { V.cam.p[0] = w2.x + dx; V.emit('time'); } else { V.setX(w2.x + 1, { follow: false }); if (V.pres() === 'clock') V.cam.p[0] = w2.x + dx; }
  }
  V.on('key', e => {
    const k = e.key;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k >= '1' && k <= '5') setMode(+k - 1);
    else if (k === 'p' || k === 'P') V.setPlaying(!V.playing);
    else if (k === ',') stepMonth(-1); else if (k === '.') stepMonth(1);
    else if (k === 'PageUp') { jumpRel(-1); e.preventDefault(); } else if (k === 'PageDown') { jumpRel(1); e.preventDefault(); }
    else if (k === 'n' || k === 'N') V.cyclePres();
    else if (k === 'g' || k === 'G') { const v = V.overview(); V.flyTo(v.p, v.dir); }
    else if (k === '[') laneStep(-1); else if (k === ']') laneStep(1);
    else if (k === '{' || k === '}') { const w = nearestWall(); const li = Math.max(0, Math.min(LN.length - 1, (w ? w.lane : 0) + (k === '{' ? -1 : 1))); goLane(li); }
    else if (k === 'f' || k === 'F') { if (V.mouse) { const r = V.pick(V.mouse.x, V.mouse.y); if (r && r.slot >= 0) V.flyToSlot(r.w, r.slot, r.line || 0); } }
    else if (k === '/') { toggle('search'); if (!$('search').classList.contains('hidden')) setTimeout(() => sq.focus(), 0); e.preventDefault(); }
    else if (k === 'b' || k === 'B') toggle('bookmarks'); else if (k === 'i' || k === 'I') toggle('minimap');
    else if (k === 'l' || k === 'L') toggle('story'); else if (k === 'h' || k === 'H' || k === '?') toggle('help');
    else if (k === 'm' || k === 'M') V.score && V.score.mute();
    else if (k === 't' || k === 'T') V.attract && V.attract.start('key');
    else if (k === 'Escape') { for (const id of ['search', 'bookmarks', 'help', 'story', 'filepanel', 'scorecard']) $(id).classList.add('hidden'); V.pinned = null; tip.classList.add('hidden'); V.setMarks(null); }
    saveHash();
  });

  // ---------------- URL hash: camera, time, mode, presentation
  let hashT = 0;
  function saveHash() { if (!V._hashReady || V.Q.has('shots') || V.attractOn || V.bench) return; const c = V.cam; history.replaceState(null, '', `#x=${Math.round(V.X)}&c=${c.p.map(v => Math.round(v)).join(',')}&yp=${c.yaw.toFixed(3)},${c.pitch.toFixed(3)}&m=${V.mode}&pm=${V.presMode}`); }
  V.on('hud', () => { const now = performance.now(); if (now - hashT > 1500) { hashT = now; saveHash(); } });
  V.restoreHash = () => {
    const h = new URLSearchParams(location.hash.slice(1)); if (!h.has('c')) return false;
    const c = h.get('c').split(',').map(Number), yp = (h.get('yp') || '0,0').split(',').map(Number);
    if (c.length !== 3 || c.some(isNaN)) return false;
    V.cam.p = c; V.cam.yaw = yp[0]; V.cam.pitch = yp[1]; if (h.has('x')) V.X = +h.get('x'); if (h.has('m')) setMode(+h.get('m')); if (['clock', 'now', 'gallery'].includes(h.get('pm'))) V.presMode = h.get('pm');
    return true;
  };
  setMode(0); timeUI(); hud();
}
