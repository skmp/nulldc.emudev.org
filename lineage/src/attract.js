// attract.js: attract mode (FOLLOWUP item 2). Starts on page load once the data is ready, after 2 minutes without input, or
// on T / the tour button: a fly-through of important and recurring lines (data/attract.json: curated lines, the computed
// longest-surviving / widest-spread ones, famous files). For each: smooth flights to reading range in the frames that hold
// it, back and forth in time and across lanes at fork points, with a caption (the line, where it first appeared, how far
// it spread). Dragging, keys, the wheel or a click exit (a mouse that only moves does not).
// The audio gate: browsers start audio only from a user gesture, so a small overlay asks for a click; the first click /
// tap / key only turns the score on (and closes the overlay): it does not reach the viewer, and the tour keeps running.
// prefers-reduced-motion: no automatic camera movement (no tour on load or after idle); the overlay offers 'start tour'.
export function initAttract(V) {
  const { F, W, attractList } = V;
  const items = (attractList.items || []).filter(it => it.stops && it.stops.length);
  const cap = document.getElementById('caption');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let run = 0, startedAt = 0, lastInput = performance.now();
  const IDLE = +(V.Q.get('idle') || 120) * 1000;
  const REDUCE = V.Q.has('reducedmotion') || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const QUIET = V.Q.has('shots') || V.Q.has('bench');
  V.attractOn = false; V.attractArc = 0;
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // smooth camera: ease in-out position and direction, lifted when the move is long (crossing lanes / years)
  function glide(p1, d1, dur, token, atApex = null) {   // atApex: run once at the top of the flight (s >= 0.5), when the scene is farthest away
    return new Promise(res => {
      const c = V.cam, p0 = c.p.slice(), d0 = V.camBasis().f, dist = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
      const lift = Math.min(dist * 0.28, 50000), t0 = performance.now();
      const n = x => { const l = Math.hypot(...x) || 1; return x.map(v => v / l); };
      const tick = () => {
        if (token !== run) { V.off('tick', tick); return res(false); }
        const t = Math.min(1, (performance.now() - t0) / (dur * 1000)), s = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
        if (atApex && s >= 0.5) { const f = atApex; atApex = null; f(); }
        const p = p0.map((v, i) => v + (p1[i] - v) * s); p[1] += Math.sin(Math.PI * s) * lift;
        V.cam.p = p; V.setLook(n(d0.map((v, i) => v + (d1[i] - v) * s)));
        if (t >= 1) { V.off('tick', tick); res(true); }
      };
      V.on('tick', tick);
    });
  }
  // slow drift while a caption is read (keeps the picture alive)
  async function hold(ms, token) {
    const t0 = performance.now(), p0 = V.cam.p.slice();
    while (performance.now() - t0 < ms) { if (token !== run) return false; const t = (performance.now() - t0) / 1000; V.cam.p = [p0[0] + Math.sin(t * 0.4) * 8 - t * 6, p0[1] - t * 3, p0[2] + t * 9]; await sleep(30); }
    return true;
  }
  function caption(it, stop) {
    const fr = F.frames[stop[0]], lane = fr.lane;
    let h = it.unique ? `<div class="uq">unique: only ever in ${esc(it.lanes[0])}</div>` : '';
    if (it.kind === 'line') {
      h += `<div class="cl">${esc(it.text)}</div><div class="cm">first seen in <b>${esc(it.origin_lane)}</b> ${esc(it.origin_date)}; ` +
        (it.unique ? `held by ${it.frames} frames` : `held by ${it.frames} frames in ${it.lanes.length} lanes (${esc(it.lanes.join(', '))})`) + `</div>`;
    } else if (it.kind === 'segment') {
      h += `<div class="ct">${esc(it.title)}</div><div class="cm">${it.n} lines, first seen in <b>${esc(it.origin_lane)}</b> ${esc(it.origin_date)}; ` +
        (it.unique ? `held by ${it.frames} frames` : `held by ${it.frames} frames in ${it.lanes.length} lanes (${esc(it.lanes.join(', '))})`) + `</div>`;
    } else h += `<div class="cl">${esc(it.title)}</div><div class="cm">${it.frames} frames in ${it.lanes.length} lanes (${esc(it.lanes.join(', '))}), since ${esc(it.first_date)}</div>`;
    if (it.note && it.picked) h += `<div class="nt">${esc(it.note)}</div>`;
    h += `<div class="cm">now: ${esc(lane)} ${esc(fr.date)}${fr.tags ? ' ' + esc(fr.tags.join(', ')) : ''}${it.note && !it.picked ? ' | ' + esc(it.note) : ''}</div>`;
    cap.innerHTML = h; cap.classList.remove('hidden'); cap.style.opacity = 1;
  }
  // order: random on every load and every lap. Curated and computed items are shuffled separately, then merged with a
  // lean towards the curated ones (picked 60 % of the time while both remain), so the famous lines still come early
  const shuffle = a => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  function playlist() {
    const cur = shuffle(items.filter(i => i.curated)), rest = shuffle(items.filter(i => !i.curated)), out = [];
    while (cur.length || rest.length) out.push((cur.length && (!rest.length || Math.random() < 0.6) ? cur : rest).shift());
    return out;
  }
  // stop sequence for an item: forward in time, then back to a middle one (back and forth), at most 5 stops
  function route(it) {
    const s = it.stops; if (s.length <= 3) return s;
    const a = s[0], b = s[Math.floor(s.length * 0.45)], c = s[s.length - 1], d = s[Math.floor(s.length * 0.75)];
    return [...new Set([a, b, c, d])];
  }
  // reading view of an item. Segments: the whole block in the top 60 % of the screen (the caption sits under it): line
  // height from the block length, and the view centred below the block's middle so the block lands at 36 % of the height
  function itemView(it, w, s, line) {
    if (it.kind === 'line') return V.slotView(w, s, line + 1, 22);
    if (it.kind !== 'segment') return V.slotView(w, s, 0, 14);
    const px = Math.max(9, Math.min(22, Math.floor(innerHeight * 0.6 / (it.n + 2))));
    return V.slotView(w, s, line + 1 + Math.round(it.n / 2 + 0.14 * innerHeight / px), px);
  }
  async function visit(it, token) {
    if (it.kind === 'line') V.setMarks([it.id], it.unique ? 2 : 1); else if (it.kind === 'segment') V.setMarks(it.marks || it.ids, it.unique ? 2 : 1); else V.setMarks(null);
    const stops = route(it).filter(st => W[st[0]]);
    // one caption for the whole item: shown as the visit starts, its "now:" line updated per stop, faded when the item ends
    if (stops.length) caption(it, stops[0]);
    for (const [q, stop] of stops.entries()) {
      if (token !== run) return;
      const [f, ident, line] = stop, w = W[f];
      const s = V.slotOf(w, ident); if (s === undefined) continue;
      V.attractArc = 0.4 + 0.6 * (q / 4);
      V.ensureWall(f, 15000);   // build the target wall while flying, not on arrival
      // the clock moves to the target frame at the top of the flight, not as the camera leaves the wall it was reading
      const toClock = () => { V.presMode = 'clock'; V.setPlaying(false); V.setX(w.x + 1, { follow: false }); if (q) caption(it, stop); };
      if (q === 0) toClock();
      // establishing shot of the wall, then in to reading range
      const v0 = V.fitWall(w); if (!await glide(v0.p, [1, -0.08, 0.05], q === 0 ? 5 : 4, token, q ? toClock : null)) return;
      const v = itemView(it, w, s, line);
      if (!await glide(v.p, v.dir, 4.5, token)) return;
      if (!await hold(q === 0 ? 6500 : 4500, token)) return;
    }
    cap.style.opacity = 0.0;
  }
  async function loop(token) {
    document.body.classList.add('attract'); V.attractOn = true;
    while (token === run) {
      for (const it of playlist()) {
        if (token !== run) break;
        V.attractArc = 0.2;
        await visit(it, token);
        if (token !== run) break;
        // between items: rise to a mid view of the lanes around the clock
        V.attractArc = 0.1; const ov = V.overview();
        await glide(ov.p.map((x, i) => x * (i === 1 ? 0.6 : 1)), ov.dir, 5, token);
      }
    }
  }
  function start(why) {
    if (V.attractOn || V.bench) return;
    run++; startedAt = performance.now(); loop(run);
    if (why !== 'auto') V.toast('tour: drag, a key or a click takes over', 2500);
  }
  function stop() {
    if (!V.attractOn) return;
    run++; V.attractOn = false; V.attractArc = 0; document.body.classList.remove('attract'); cap.classList.add('hidden'); V.setMarks(null);
  }
  let acted = false;
  V.on('input', (e) => { lastInput = performance.now(); if (e && e.type === 'mousemove') return; acted = true; if (V.attractOn && performance.now() - startedAt > 400) stop(); });
  setInterval(() => { if (!REDUCE && !V.attractOn && !V.bench && !QUIET && IDLE > 0 && performance.now() - lastInput > IDLE) start('idle'); }, 1000);
  // screenshots / checks: an item's first stop, placed instantly as the tour would frame it
  async function showItem(it, k = 0) {
    const [f, ident, line] = it.stops[k], w = W[f], sl = V.slotOf(w, ident);
    V.presMode = 'clock'; V.setPlaying(false); V.setX(w.x + 1, { follow: false }); await V.ensureWall(f, 30000);
    if (it.kind === 'line') V.setMarks([it.id], it.unique ? 2 : 1); else if (it.kind === 'segment') V.setMarks(it.marks || it.ids, it.unique ? 2 : 1);
    const v = itemView(it, w, sl, line);
    V.cam.p = v.p; V.setLook(v.dir); caption(it, it.stops[k]);
    await V.whenReady({ timeout: 60000 });
  }
  V.attract = { start, stop, items, caption, route, showItem, get on() { return V.attractOn; }, reduce: REDUCE };
  if (V.Q.has('attract')) setTimeout(() => start('url'), 1500);

  // ---- tour on load + the audio gate
  const gate = document.getElementById('audiogate'), gateTour = document.getElementById('gatetour');
  let gateOpen = !QUIET && !!gate, swallowT = 0;
  const ready = f => { if (V.load.meta) f(); else V.on('meta', f); };
  if (!QUIET && !REDUCE && V.Q.get('tour') !== '0') ready(() => setTimeout(() => { if (!acted) start('auto'); }, 200));   // not if the user already took the controls
  if (gateOpen) {
    if (REDUCE) gateTour.classList.remove('hidden');
    ready(() => gate.classList.remove('hidden'));
    const swallow = e => { if (performance.now() < swallowT) { e.stopImmediatePropagation(); e.preventDefault(); if (e.type === 'click') swallowT = 0; } };
    const first = e => {
      if (!gateOpen) return;
      const t = e.target && e.target.closest ? e.target : null;
      const onControl = t && t.closest('.panel') && !t.closest('#audiogate');   // a button / slider: let it work, still turn the sound on
      if (e.type === 'keydown' && (e.ctrlKey || e.metaKey || e.altKey || /^F\d+$|^(Tab|Shift|Control|Alt|Meta)$/.test(e.key))) return;
      gateOpen = false; gate.classList.add('hidden');
      for (const k of ['pointerdown', 'keydown']) removeEventListener(k, first, true);
      if (!(t && t.closest('#tmusic')) && V.score && !V.score.on) V.score.toggle();
      if (t && t.closest('#gatetour')) start('button');
      if (onControl) return;
      // the gesture only enables audio: it does not reach the viewer (no pin, no drag, no key), so the tour keeps running
      e.stopImmediatePropagation(); if (e.type !== 'keydown') e.preventDefault();
      swallowT = performance.now() + (e.type === 'keydown' ? 0 : 1500);
    };
    addEventListener('pointerdown', first, true); addEventListener('keydown', first, true);
    for (const k of ['mousedown', 'mouseup', 'click', 'touchstart', 'touchend', 'pointerup']) addEventListener(k, swallow, { capture: true, passive: false });
  }
}
