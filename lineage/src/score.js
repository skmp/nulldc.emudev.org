// score.js: the generative score (FOLLOWUP item 3). Original and synthesised in Web Audio; nothing sampled or quoted.
// Stylistic inspiration only: sparse modal piano (after Satie's Gnossiennes), slow strings with late-resolving suspensions
// (after Richter), additive organ arpeggios over pedal tones and a wordless choir (after Glass). No melody is copied:
// every line comes from a seeded random walk over the scale.
// It stays in one key signature (one flat): the sections only move the modal centre (D aeolian, F ionian, G dorian,
// B-flat lydian), so crossfades between sections are always in key.
// Drive (sampled by the scheduler): { year, fork (0..1 pulse), density (0..1), arc (0..1 attract-mode intensity) }.
// createScore(ctx, { seed, out }) works on an AudioContext or an OfflineAudioContext (tools/render_score.mjs).

export function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const KEY = [2, 4, 5, 7, 9, 10, 0];   // pitch classes of D aeolian (= F major): D E F G A Bb C
const SECTIONS = [
  { name: 'D aeolian', centre: 0, prog: [[0, 5, 2, 6], [0, 3, 5, 4], [0, 6, 5, 6]] },        // degrees in KEY
  { name: 'F ionian', centre: 2, prog: [[0, 3, 4, 0], [0, 5, 3, 4], [0, 2, 3, 4]] },
  { name: 'G dorian', centre: 3, prog: [[0, 3, 0, 6], [0, 6, 3, 0], [0, 2, 3, 6]] },
  { name: 'B-flat lydian', centre: 5, prog: [[0, 1, 0, 4], [0, 1, 5, 4], [0, 4, 1, 0]] },
];
const midiHz = m => 440 * Math.pow(2, (m - 69) / 12);
// scale degree (relative to the section centre, any integer) -> midi note near `base`
function degMidi(sec, deg, base) {
  const d = sec.centre + deg, o = Math.floor(d / 7), off = (KEY[((d % 7) + 7) % 7] - 2 + 12) % 12;   // semitones above D
  return base - (((base - 2) % 12) + 12) % 12 + off + 12 * o;
}
const smooth = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export function createScore(ctx, opts = {}) {
  const rnd = mulberry32(opts.seed ?? 2026);
  const pick = a => a[Math.floor(rnd() * a.length)];
  // ---- graph: voices -> group buses -> dry + reverb -> limiter -> master
  const master = ctx.createGain(); master.gain.value = opts.volume ?? 0.6;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -12; limiter.knee.value = 6; limiter.ratio.value = 12; limiter.attack.value = 0.005; limiter.release.value = 0.25;
  const pre = ctx.createGain(); pre.gain.value = 0.8;
  pre.connect(limiter); limiter.connect(master); master.connect(opts.out || ctx.destination);
  const verb = ctx.createConvolver(); verb.buffer = impulse(ctx, 2.6, 0.9, rnd);
  const wet = ctx.createGain(); wet.gain.value = 0.42; verb.connect(wet); wet.connect(pre);
  const bus = {};
  for (const [k, lvl, send] of [['piano', 0.9, 0.5], ['strings', 0, 0.7], ['organ', 0, 0.45], ['choir', 0, 0.8], ['pedal', 0, 0.3]]) {
    const g = ctx.createGain(); g.gain.value = lvl; const s = ctx.createGain(); s.gain.value = send;
    g.connect(pre); g.connect(s); s.connect(verb); bus[k] = g;
  }
  const organWave = ctx.createPeriodicWave(new Float32Array([0, 0, 0, 0, 0]), new Float32Array([0, 1, 0.5, 0.22, 0.12]));
  const noiseBuf = (() => { const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = b.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = rnd() * 2 - 1; return b; })();

  // ---- voices (every envelope starts and ends at zero: no clicks)
  function env(g, t, a, peak, hold, rel) {
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a);
    if (hold > 0) g.gain.setValueAtTime(peak, t + a + hold);
    g.gain.setTargetAtTime(0, t + a + Math.max(0, hold), rel / 4);
    return t + a + Math.max(0, hold) + rel * 1.6;
  }
  function piano(t, m, vel) {
    const f = midiHz(m), out = ctx.createGain(), lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1800 + 3500 * vel; lp.Q.value = 0.3;
    out.gain.value = 0; out.connect(lp); lp.connect(bus.piano);
    out.gain.setValueAtTime(0, t); out.gain.linearRampToValueAtTime(0.22 * vel, t + 0.004);
    const T = 5.5 * Math.pow(2, -(m - 60) / 24);   // lower notes ring longer
    out.gain.setTargetAtTime(0, t + 0.004, T / 5);
    const end = t + T * 1.4;
    for (let k = 1; k <= 4; k++) {
      const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.value = f * k * Math.sqrt(1 + 0.00035 * k * k);
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(Math.pow(k, -1.4) * (k === 1 ? 1 : 0.7), t + 0.003);
      g.gain.setTargetAtTime(0, t + 0.003, T / (4 + 3 * k)); o.connect(g); g.connect(out); o.start(t); o.stop(end);
    }
    const n = ctx.createBufferSource(), ng = ctx.createGain(), hp = ctx.createBiquadFilter(); n.buffer = noiseBuf; hp.type = 'bandpass'; hp.frequency.value = 2500; hp.Q.value = 0.8;
    ng.gain.setValueAtTime(0, t); ng.gain.linearRampToValueAtTime(0.03 * vel, t + 0.002); ng.gain.setTargetAtTime(0, t + 0.002, 0.012);
    n.connect(hp); hp.connect(ng); ng.connect(out); n.start(t, rnd() * 0.5); n.stop(t + 0.15);
  }
  function stringsNote(t, m, dur, lvl) {
    const f = midiHz(m), out = ctx.createGain(), lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 700 + 4 * f; lp.Q.value = 0.5;
    out.connect(lp); lp.connect(bus.strings);
    const end = env(out, t, 2.6, 0.05 * lvl, dur - 2.6, 4.5);
    const vib = ctx.createOscillator(), vg = ctx.createGain(); vib.frequency.value = 4.6 + rnd() * 0.8; vg.gain.value = f * 0.0025; vib.connect(vg);
    for (const det of [-6, 6]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f * Math.pow(2, det / 1200); vg.connect(o.frequency); o.connect(out); o.start(t); o.stop(end); }
    vib.start(t); vib.stop(end);
    return { out, f };
  }
  function organNote(t, m, dur, lvl, b = bus.organ) {
    const f = midiHz(m), out = ctx.createGain(); out.connect(b);
    const end = env(out, t, 0.012, 0.05 * lvl, Math.max(0, dur - 0.03), 0.09);
    const o = ctx.createOscillator(); o.setPeriodicWave(organWave); o.frequency.value = f; o.connect(out); o.start(t); o.stop(end);   // drawbars 8', 4', 2 2/3', 2'
  }
  const VOWELS = [[800, 1150, 2900], [400, 1600, 2700], [350, 600, 2400]];   // ah, eh, oo
  function choirNote(t, m, dur, lvl) {
    const f = midiHz(m), out = ctx.createGain(); out.connect(bus.choir);
    const end = env(out, t, 3.2, 0.09 * lvl, dur - 3.2, 5);
    const src = ctx.createGain(); const vib = ctx.createOscillator(), vg = ctx.createGain(); vib.frequency.value = 5.2 + rnd() * 0.6; vg.gain.value = f * 0.006; vib.connect(vg);
    for (const det of [-8, 9]) { const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f * Math.pow(2, det / 1200); vg.connect(o.frequency); o.connect(src); o.start(t); o.stop(end); }
    vib.start(t); vib.stop(end);
    const v0 = pick(VOWELS), v1 = pick(VOWELS);
    v0.forEach((fr, i) => { const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 9; bp.frequency.setValueAtTime(fr, t); bp.frequency.linearRampToValueAtTime(v1[i], t + dur);
      const g = ctx.createGain(); g.gain.value = [1, 0.5, 0.25][i]; src.connect(bp); bp.connect(g); g.connect(out); });
  }

  // ---- composition state
  let sec = SECTIONS[0], secIdx = 0, prog = sec.prog[0], chordI = 0, secStart = 0;
  let tChord = 0, tPiano = 0.5, tArp = 0, arpLen = 2, arpGrow = 1, arpStep = 0, motif = [], motifUse = 0, lastFork = 0, forkLevel = 0;
  const S = { section: sec.name, events: 0 }, level = { organ: 0, choir: 0, pedal: 0 };   // voices on a silent bus are not scheduled
  function chordTones(root) { return [root, root + 2, root + 4]; }
  function newMotif() { motif = []; let d = Math.floor(rnd() * 5); for (let i = 0; i < 4 + Math.floor(rnd() * 3); i++) { motif.push(d); d += pick([-2, -1, -1, 1, 1, 2, 3, -3]); } motifUse = 0; }
  newMotif();
  function wantSection(drive) { return drive.year < 2009 ? 0 : drive.year < 2018 ? 1 : drive.year < 2024 ? 2 : 3; }
  function setLevels(t, drive) {
    const y = drive.year, a = drive.arc || 0;
    const lv = { piano: 0.55 + 0.35 * (1 - smooth(2015, 2024, y)) + 0.1 * a, strings: 0.15 + 0.7 * smooth(2008, 2014, y) * (0.6 + 0.4 * (drive.density || 0)) + 0.25 * a,
      organ: 0.6 * smooth(2017, 2023, y) + 0.3 * a, choir: Math.min(1, 0.15 + 0.55 * forkLevel + 0.4 * smooth(2024, 2026, y) + 0.35 * a), pedal: 0.25 + 0.5 * smooth(2017, 2023, y) + 0.2 * a };
    for (const k in lv) bus[k].gain.setTargetAtTime(lv[k], t, 2.5);   // crossfades, not steps
    Object.assign(level, lv);
  }
  // schedule everything that starts in [t0, t1)
  function schedule(t0, t1, drive) {
    if (drive.fork && drive.fork > lastFork + 0.5) forkLevel = 1; lastFork = drive.fork || 0;
    forkLevel *= Math.exp(-(t1 - t0) / 12);
    setLevels(t0, drive);
    while (tChord < t1) {
      const want = wantSection(drive);
      if (chordI >= prog.length) {   // a progression ended: maybe a new section (always in the same key signature)
        if (want !== secIdx || tChord - secStart > 60) { secIdx = want !== secIdx ? want : (secIdx + (rnd() < 0.5 ? 1 : 3)) % 4; sec = SECTIONS[secIdx]; secStart = tChord; newMotif(); }
        prog = pick(sec.prog); chordI = 0; S.section = sec.name;
      }
      const dur = 7 + rnd() * 3 + 2 * (1 - (drive.density || 0)), root = prog[chordI++], tones = chordTones(root);
      // strings: the chord with a suspension (4 for 3 or 9 for 8) that resolves late, at 70-80 % of the chord
      const susp = rnd() < 0.7, resAt = tChord + dur * (0.7 + 0.1 * rnd());
      for (const [i, d] of tones.entries()) {
        const m = degMidi(sec, d, i === 0 ? 50 : 58);
        if (susp && i === 1) { stringsNote(tChord, degMidi(sec, d + 1, 58), resAt - tChord + 1.2, 0.9); stringsNote(resAt, m, tChord + dur - resAt + 1.5, 0.9); }
        else stringsNote(tChord, m, dur + 1.5, i === 0 ? 1 : 0.8);
      }
      stringsNote(tChord, degMidi(sec, root + 7, 62), dur + 1.5, 0.5);
      if (level.pedal > 0.03) organNote(tChord, degMidi(sec, root, 38), dur + 0.5, 1.4, bus.pedal);   // pedal tone
      if (level.choir > 0.03 && (forkLevel > 0.3 || (drive.arc || 0) > 0.5 || drive.year >= 2024 || rnd() < 0.25)) for (const d of [root, root + 4]) choirNote(tChord, degMidi(sec, d, 62), dur + 1, 0.8);
      S.chord = root; tChord += dur; S.events++;
    }
    // organ: additive arpeggio over the current chord (2, 3, 4, 5, 4, 3 notes ...), eighth notes
    const beat = 60 / 104 / 2;
    if (tArp < t0) tArp = Math.ceil(t0 / beat) * beat;
    while (tArp < t1) {
      const tones = chordTones(prog[Math.max(0, chordI - 1)] ?? 0), m = degMidi(sec, tones[arpStep % 3] + 7 * Math.floor(arpStep / 3), 62);
      if (level.organ > 0.03) organNote(tArp, m, beat * 0.9, 0.9);
      arpStep++; if (arpStep >= arpLen) { arpStep = 0; arpLen += arpGrow; if (arpLen >= 6 || arpLen <= 2) arpGrow = -arpGrow; }
      tArp += beat; S.events++;
    }
    // piano: the motif, varied (transposed in the scale, rubato), sparse; denser with more code on screen
    while (tPiano < t1) {
      if (motifUse >= motif.length * 3) newMotif();
      const d = motif[motifUse % motif.length] + (Math.floor(motifUse / motif.length) % 2 ? pick([0, 2, -1]) : 0);
      piano(tPiano, degMidi(sec, d, 67), 0.45 + 0.35 * rnd());
      if (rnd() < 0.2) piano(tPiano + 0.02, degMidi(sec, d - 2, 55), 0.35);   // an occasional low third
      motifUse++;
      const gap = (motifUse % motif.length === 0 ? 3.2 : 1.1) + rnd() * 1.4 - 0.9 * (drive.density || 0) - 0.3 * (drive.arc || 0);
      tPiano += Math.max(0.45, gap); S.events++;
    }
  }
  return { ctx, master, schedule, state: S, setVolume: (v, t = ctx.currentTime) => master.gain.setTargetAtTime(v, t, 0.1) };
}
function impulse(ctx, secs, decay, rnd) {
  const n = Math.floor(ctx.sampleRate * secs), b = ctx.createBuffer(2, n, ctx.sampleRate);
  for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) { const t = i / ctx.sampleRate; d[i] = (rnd() * 2 - 1) * Math.exp(-t / decay) * (t < 0.01 ? t / 0.01 : 1) * 0.5; } }
  return b;
}

// ---- live: off by default; the ♪ button starts it (browsers need a gesture); M mutes
export function initScore(V) {
  let S = null, timer = null, on = false, muted = false, vol = 0.6, lastMark = 0, forkCount = 0;
  const forks = V.WALLS.filter(w => w.mark && w.mark.kinds.some(k => k === 'fork' || k === 'import')).map(w => w.x).sort((a, b) => a - b);
  function drive() {
    const year = +V.dateOfX(V.X).slice(0, 4) + (+V.dateOfX(V.X).slice(5, 7) - 1) / 12;
    const passed = forks.filter(x => x <= V.X).length; if (passed !== lastMark) { if (passed > lastMark) forkCount++; lastMark = passed; }
    return { year, fork: forkCount, density: Math.min(1, (V.stats.inst || 0) / 300000), arc: V.attractArc || 0 };
  }
  function start() {
    if (!S) { const ctx = new (window.AudioContext || window.webkitAudioContext)(); S = createScore(ctx, { seed: +(V.Q.get('seed') || 2026), volume: 0 }); }
    S.ctx.resume(); on = true; S.setVolume(muted ? 0 : vol);
    lastMark = forks.filter(x => x <= V.X).length;
    let t = S.ctx.currentTime + 0.1;
    timer = setInterval(() => { const now = S.ctx.currentTime; if (t < now) t = now; const t1 = now + 0.8; if (t1 > t) { S.schedule(t, t1, drive()); t = t1; } }, 200);
    V.emit('score', { on, muted });
  }
  function stop() { if (!S) return; on = false; clearInterval(timer); S.setVolume(0); setTimeout(() => { if (!on) S.ctx.suspend(); }, 600); V.emit('score', { on, muted }); }
  V.score = {
    toggle: () => on ? stop() : start(),
    mute: () => { if (!on) return; muted = !muted; S.setVolume(muted ? 0 : vol); V.emit('score', { on, muted }); V.toast(muted ? 'score muted (M)' : 'score on'); },
    setVolume: v => { vol = v; if (S && on && !muted) S.setVolume(v); },
    get on() { return on; }, get state() { return S && S.state; },
  };
}
