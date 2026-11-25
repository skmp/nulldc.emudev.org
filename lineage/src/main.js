// main.js: boot, scene, shared clock, frame streaming, LOD, frame loop, picking (format 2 data: frames per month + releases)
import * as G from './gl.js';
import * as SH from './shaders.js';
import * as core from './core.js';
import { initUI } from './ui.js';
import { initBench } from './bench.js';
import { initAttract } from './attract.js';
import { initScore } from './score.js';

const Q = new URLSearchParams(location.search);
const canvas = document.getElementById('gl');
if (Q.has('clean')) document.body.classList.add('shots');
const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: true, powerPreference: 'high-performance', preserveDrawingBuffer: Q.has('shots') });
if (!gl) { document.getElementById('loading').textContent = 'WebGL2 is not available in this browser.'; throw new Error('no webgl2'); }
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const RENDERER = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
const SOFT = Q.get('soft') === '1' || (Q.get('soft') !== '0' && /llvmpipe|swiftshader|softpipe|software/i.test(RENDERER));
const tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
const FOV = 60 * Math.PI / 180, H = core.H;
const t0Boot = performance.now();
const NONE = 1021, CLOCK = 1022;

// ------------------------------------------------------------------ state
export const V = {
  gl, RENDERER, SOFT, Q,
  cam: { p: [-9000, 9000, 60000], yaw: 0, pitch: -0.25, speed: 2000 },
  mode: 0, hideInc: true, presMode: 'clock', X: 0, playing: false, speed: 2,   // speed: months per second
  quality: { step: 0 },
  stats: { frames: 0, dt: [], cpu: [], gpu: [], draws: 0, inst: 0 },
  load: { boot: 0, firstFrame: 0, walls: 0, text: 0, meta: false },
  skip: new Set((Q.get('skip') || '').split(',')),
  hover: null, pinned: null, hi: null, flight: null, morph: null, listeners: {},
};
const on = (k, f) => (V.listeners[k] ||= []).push(f);
const off = (k, f) => { const a = V.listeners[k]; if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } };
const emit = (k, ...a) => (V.listeners[k] || []).slice().forEach(f => f(...a));
Object.assign(V, { on, off, emit });

async function gz(url) {
  const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status);
  return new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}
const getJSON = async url => { const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); };
const setLoading = s => { const e = document.getElementById('loading'); e.textContent = s; e.classList.toggle('hidden', !s); };
V.setLoading = setLoading;

// ------------------------------------------------------------------ boot
setLoading('loading layout…');
const [F, layoutBytes, story, metrics, sdf, attractList] = await Promise.all([
  getJSON('data/frames.json'), gz('data/layout.json.gz'), getJSON('data/story.json'), getJSON('data/font/metrics.json'), gz('data/font/sdf.r8.gz'),
  getJSON('data/attract.json').catch(() => ({ items: [] }))]);
const layout = JSON.parse(new TextDecoder().decode(layoutBytes));
const NF = F.frames.length, U = layout.unit.month;
const tm = core.timeMaps(layout);
Object.assign(V, { F, layout, story, attractList, NF, tm, U });
V.load.boot = performance.now() - t0Boot;

// lanes and walls
const LN = layout.lanes.map((L, li) => ({ li, L, name: L.name, frames: L.frames, xs: Float64Array.from(L.frames.map(f => 0)), z0: L.z0, cols: L.cols, rgb: L.rgb }));
const W = new Array(NF).fill(null);
for (const lw of layout.walls) {
  const fr = F.frames[lw.frame], ln = LN[lw.lane];
  W[lw.frame] = { i: lw.frame, lane: lw.lane, x: lw.x, z0: ln.z0, cols: ln.cols, fr, k: fr.k, n: fr.lines, gpu: null, inst: null, loaded: false, imp: null, impKey: '', meta: null, lastUse: 0, wanted: 0 };
}
for (const ln of LN) ln.frames.forEach((f, k) => ln.xs[k] = W[f].x);
const WALLS = W.filter(Boolean);
const marks = new Map(layout.marks.map(m => [m.frame, m]));
for (const w of WALLS) { const m = marks.get(w.i); w.mark = m || null; w.release = !!(m && m.release); }
const laneSlotsSorted = layout.lanes.map(l => core.laneSlots(l));
// solid releases: DreamSTer pins always; tags at most one per month per lane (nullDC4Wii tags several builds a day)
for (const ln of LN) { let last = -1e18; for (const f of ln.frames) { const w = W[f];
  const pin = layout.releases.some(r => r.frames.includes(f));
  if (w.release && (pin || w.x - last >= U)) { w.solidRelease = true; last = w.x; } } }
const xMin = Math.min(...WALLS.map(w => w.x)), xMax = Math.max(...WALLS.map(w => w.x));
Object.assign(V, { W, WALLS, LN, marks, xMin, xMax });
V.X = xMin;

// ------------------------------------------------------------------ GL resources
gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
const POOLW = 4096, POOLH = SOFT ? 768 : 2048;                     // instance pool: rows of 4096 lines (8 bytes each)
const instTex = G.tex2D(gl, POOLW, POOLH, gl.RG32UI, gl.RG_INTEGER, gl.UNSIGNED_INT);
const LW = 2048, LH = Math.ceil(F.raw_lines / LW);
const offsTex = G.tex2D(gl, LW, LH, gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT, new Uint32Array(LW * LH).fill(0xFFFFFFFF));
const metaTex = G.tex2D(gl, LW, LH, gl.RG8UI, gl.RG_INTEGER, gl.UNSIGNED_BYTE, new Uint8Array(LW * LH * 2));
const markArr = new Uint8Array(LW * LH);
const markTex = G.tex2D(gl, LW, LH, gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE, markArr);
const TEXLAYERS = 3;
const textTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D_ARRAY, textTex);
gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8UI, 4096, 4096, TEXLAYERS);
gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
// SDF atlas: mipmapped (limited to the levels where cells stay apart), anisotropic
const atlasTex = G.tex2D(gl, metrics.width, metrics.height, gl.R8, gl.RED, gl.UNSIGNED_BYTE, sdf, gl.LINEAR_MIPMAP_LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, 3); gl.generateMipmap(gl.TEXTURE_2D);
if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
const ATLASM = [metrics.cellW / metrics.width, metrics.cellH / metrics.height, metrics.spread, metrics.cellW];
const MORPHW = 4096, MORPHH = SOFT ? 64 : 128;
const morphTex = G.tex2D(gl, MORPHW, MORPHH, gl.RGBA32UI, gl.RGBA_INTEGER, gl.UNSIGNED_INT);
const wallArr = new Float32Array(1024 * 4);
// a ring of 4: rewriting a texture that queued frames still read makes the driver wait for them (or copy it)
const wallTexRing = [0, 1, 2, 3].map(() => G.tex2D(gl, 1024, 1, gl.RGBA32F, gl.RGBA, gl.FLOAT, wallArr));
let wallTex = wallTexRing[0], wallTexI = 0;
const uploadWallTex = () => { gl.bindTexture(gl.TEXTURE_2D, wallTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 1024, 1, gl.RGBA, gl.FLOAT, wallArr); };
let gpuBytes = POOLW * POOLH * 8 + LW * LH * 7 + 4096 * 4096 * TEXLAYERS + metrics.width * metrics.height * 1.34 + MORPHW * MORPHH * 16;

// palette rows: 0 origin, 1 age, 2 repo of origin, 3 survival ramp (64)
const srgb = c => c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255));
const hex = rgb => '#' + rgb.map(v => v.toString(16).padStart(2, '0')).join('');
const PALW = 512, palArr = new Uint8Array(PALW * 4 * 4);
const setPal = (row, i, rgb) => { const o = (row * PALW + i) * 4; palArr[o] = rgb[0]; palArr[o + 1] = rgb[1]; palArr[o + 2] = rgb[2]; palArr[o + 3] = 255; };
const laneIdx = new Map(F.lanes.map((l, i) => [l.name, i]));
const laneOfOrigin = o => laneIdx.get(F.frames[o].lane) ?? 1;
const dnum = d => { const [y, m, dd] = d.split('-').map(Number); return y + (m - 1) / 12 + ((dd || 1) - 1) / 365; };
const originDate = o => F.frames[o].virtual ? 2007.5 : dnum(F.frames[o].date);
const originName = o => F.frames[o].virtual ? 'nullDC-pre2008' : `${F.frames[o].lane} ${F.frames[o].date.slice(0, 7)}`;
function cividis(t) {
  const s = [[0, 32, 77], [64, 77, 108], [124, 123, 120], [188, 175, 111], [253, 231, 55]].map(c => c.map(v => v / 255));
  const x = Math.max(0, Math.min(0.9999, t)) * 4, i = Math.floor(x), f = x - i; return s[i].map((v, k) => v + (s[i + 1][k] - v) * f);
}
for (let o = 0; o < NF; o++) {
  setPal(0, o, layout.origin_rgb[o] || [128, 128, 128]);
  setPal(1, o, srgb(cividis((originDate(o) - 2003) / 23.9)));
  setPal(2, o, layout.lanes[laneOfOrigin(o)].rgb);
}
for (let i = 0; i < 64; i++) { const t = i / 63; setPal(3, i, srgb([0.85 - 0.65 * t, 0.25 + 0.35 * t, 0.25 + 0.7 * t])); }
const palTex = G.tex2D(gl, PALW, 4, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, palArr);
const possArr = new Uint16Array(PALW * F.lanes.length);
F.possible.forEach((row, o) => row.forEach((v, li) => possArr[li * PALW + o] = v));
const possTex = G.tex2D(gl, PALW, F.lanes.length, gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT, possArr);
V.palette = { origin: o => hex(layout.origin_rgb[o] || [128, 128, 128]), age: o => hex([...palArr.slice((PALW + o) * 4, (PALW + o) * 4 + 3)]), lane: l => hex(layout.lanes[l].rgb), originDate, laneOfOrigin, originName };

const P = {
  line: G.program(gl, SH.lineVS(false), SH.lineFS(), 'line'),
  morph: G.program(gl, SH.lineVS(true), SH.lineFS(), 'morph'),
  rect: G.program(gl, SH.rectVS, SH.rectFS, 'rect'),
  seg: G.program(gl, SH.lineSegVS, SH.lineSegFS, 'seg'),
  label: G.program(gl, SH.labelVS, SH.labelFS, 'label'),
  imp: G.program(gl, SH.impVS, SH.impFS, 'imp'),
  title: G.program(gl, SH.titleVS, SH.titleFS, 'title'),
};

// ------------------------------------------------------------------ geometry buffers
// rect instances: aR(4f) aX(2f) aC(4u8n) aW(2u16) -> 32 bytes
class RectBuf {
  constructor(dynamic = false) { this.f = []; this.dynamic = dynamic; this.n = 0; }
  add(z0, z1, y0, y1, x0, x1, rgba, wall, kind) { this.f.push(z0, z1, y0, y1, x0, x1, rgba, wall, kind); }
  get count() { return this.f.length / 9; }
  build() {
    const n = this.f.length / 9, ab = new ArrayBuffer(Math.max(1, n) * 32), f32 = new Float32Array(ab), u8 = new Uint8Array(ab), u16 = new Uint16Array(ab);
    for (let i = 0; i < n; i++) { const b = 9 * i; for (let k = 0; k < 6; k++) f32[8 * i + k] = this.f[b + k]; u8.set(this.f[b + 6], 32 * i + 24); u16[16 * i + 14] = this.f[b + 7]; u16[16 * i + 15] = this.f[b + 8]; }
    if (!this.vao) { this.vao = gl.createVertexArray(); this.vbo = gl.createBuffer(); }
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo); gl.bufferData(gl.ARRAY_BUFFER, ab, this.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    this.bind(0); gl.bindVertexArray(null); if (!this.dynamic) gpuBytes += n * 32; this.n = n; this.f = []; return this;
  }
  bind(first) {
    const o = first * 32; gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, o); gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 32, o + 16); gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 32, o + 24); gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3); gl.vertexAttribIPointer(3, 2, gl.UNSIGNED_SHORT, 32, o + 28); gl.vertexAttribDivisor(3, 1);
  }
}
const ST_RGB = [[90, 100, 125], [70, 200, 110], [230, 180, 60], [90, 160, 240], [180, 120, 240], [240, 110, 180], [240, 200, 110]];
const mixc = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const K_FLOOR = 1, K_PAL = 2, PUSH1 = 1 << 2, PUSH2 = 2 << 2, PUSH3 = 3 << 2, K_OUTLINE = 16, K_SOLID = 32;
const plates = new RectBuf(), floor = new RectBuf(), t3 = new RectBuf(), t4 = new RectBuf(), t5 = new RectBuf(), pinsR = new RectBuf();
const K_T4 = 64, K_T5 = 128;
const plateRange = new Map();

// labels: aP(4f) aU(3f) aV(3f) aT(2u32) aC(4u8n) aK(2f) -> 64 bytes; decluttered labels also take aD (alpha, shift)
class LabelSet {
  constructor(dynamic) { this.list = []; this.text = []; this.len = 0; this.dynamic = dynamic; }
  str(s) { const o = this.len; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); this.text.push(c >= 32 && c < 127 ? c : 0x7F); } this.len += s.length; return o; }
  add(s, z, y, dx, wall, Uv, Vv, rgba, billboard = 0, maxPx = 0, prio = 0, bg = null) { if (!s.length) return; this.list.push([z, y, dx, wall, ...Uv, ...Vv, this.str(s), s.length, rgba, billboard, maxPx, prio, s, bg]); }
  build() {
    const rows = Math.ceil(this.len / 4096) + 1, arr = new Uint8Array(rows * 4096); arr.set(this.text);
    if (this.tex) gl.deleteTexture(this.tex);
    this.tex = G.tex2D(gl, 4096, rows, gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE, arr);
    const n = this.list.length, ab = new ArrayBuffer(Math.max(1, n) * 64), f32 = new Float32Array(ab), u32 = new Uint32Array(ab), u8 = new Uint8Array(ab);
    this.list.forEach((l, i) => { for (let k = 0; k < 10; k++) f32[i * 16 + k] = l[k]; u32[i * 16 + 10] = l[10]; u32[i * 16 + 11] = l[11]; u8.set(l[12], i * 64 + 48); f32[i * 16 + 13] = l[13]; f32[i * 16 + 14] = l[14]; if (l[17]) u8.set(l[17], i * 64 + 60); });
    if (!this.vao) { this.vao = gl.createVertexArray(); this.vbo = gl.createBuffer(); this.dbuf = gl.createBuffer(); }
    gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo); gl.bufferData(gl.ARRAY_BUFFER, ab, this.dynamic ? gl.DYNAMIC_DRAW : gl.STATIC_DRAW);
    const A = (loc, k, type, off, norm = false, int = false) => { gl.enableVertexAttribArray(loc); if (int) gl.vertexAttribIPointer(loc, k, type, 64, off); else gl.vertexAttribPointer(loc, k, type, norm, 64, off); gl.vertexAttribDivisor(loc, 1); };
    A(0, 4, gl.FLOAT, 0); A(1, 3, gl.FLOAT, 16); A(2, 3, gl.FLOAT, 28); A(3, 2, gl.UNSIGNED_INT, 40, false, true); A(4, 4, gl.UNSIGNED_BYTE, 48, true); A(5, 2, gl.FLOAT, 52); A(7, 4, gl.UNSIGNED_BYTE, 60, true);
    this.dyn = new Float32Array(Math.max(1, n) * 2); for (let i = 0; i < n; i++) this.dyn[2 * i] = 1;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dbuf); gl.bufferData(gl.ARRAY_BUFFER, this.dyn, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(6); gl.vertexAttribPointer(6, 2, gl.FLOAT, false, 8, 0); gl.vertexAttribDivisor(6, 1);
    gl.bindVertexArray(null); this.n = n; return this;
  }
}
const labs = new LabelSet(false);
const segs = [];   // [z, y, s, xabs, wA, wB, rgba]
const seg = (a, b) => segs.push(a, b);
const trunc = (s, n) => s.length <= n ? s : '…' + s.slice(s.length - n + 1);
V.trunc = trunc;

// plates (solid walls only), wall titles
for (const w of WALLS) {
  const ln = LN[w.lane], plate = mixc([13, 15, 20], ln.rgb, 0.06).concat(255), a = plates.count;
  for (let c = 0; c < w.cols; c++) plates.add(w.z0 + c * 128 - 4, w.z0 + c * 128 + 124, -6, 4102, 0, 0, plate, w.i, PUSH3 | K_SOLID);
  plateRange.set(w.i, [a, plates.count - a]);
  // ghost outline: a thin frame around the wall
  pinsR.add(w.z0 - 4, w.z0 + w.cols * 128, -6, 4102, 0, 0, [...ln.rgb, 90], w.i, K_OUTLINE | PUSH1);
  const fr = w.fr, tags = (fr.tags || []).join(', '), what = tags || (fr.kinds || []).filter(k => k !== 'month').join(', ');
  const date = fr.date_range ? `${fr.date_range} (dated ${fr.date})` : fr.date + (fr.approx ? ' (approx.)' : '');
  w.title = `${ln.L.title} | ${date}${what ? ' | ' + what : ''} | ${fr.files} files, ${fr.lines.toLocaleString('en')} lines`;
  if (fr.date_note) labs.add(trunc(fr.date_note, 160), w.z0, 4096 + 80, 0, w.i, [0, 0, 14], [0, 18, 0], [220, 190, 120, 255], 0, 0, 30);
  if (w.mark && w.mark.labels && w.mark.labels.length) labs.add(trunc(w.mark.labels.join('; '), 140), w.z0, 4096 + 330, 0, w.i, [0, 0, 26], [0, 32, 0], [230, 220, 170, 255], 0, 0, 45);
}
// release marks: pin bars + labels (one per frame; DreamSTer releases that share a frame share the label)
const pinLabel = new Map();
for (const r of layout.releases) for (const f of r.frames) { if (!pinLabel.has(f)) pinLabel.set(f, []); pinLabel.get(f).push(r.tag); }
for (const w of WALLS) {
  if (!w.release) continue;
  const tags = pinLabel.has(w.i) ? 'DreamSTer ' + pinLabel.get(w.i).join(' = ') : (w.fr.tags || []).join(', ');
  pinsR.add(w.z0 - 260, w.z0 - 60, -6, 4500, 0, 0, [255, 210, 90, 220], w.i, PUSH1);
  labs.add(tags, w.z0 - 340 - 60 * tags.length, 4096 + 700, 0, w.i, [0, 0, 60], [0, 70, 0], [255, 210, 90, 255], 0, 0, 80);   // ends left of the pin bar
  w.releaseLabel = tags;
}
// wall titles: lane, month (release tag / pin, 'approx' for dc4ever, the date range for nullDCe), commit; drawn in screen
// space by layoutTitles (one instanced draw), anchored to the wall's top edge
const TT = (() => {
  const text = [], st = new Uint8Array(WALLS.length * 16);
  const str = WALLS.map(w => {
    const fr = w.fr, tags = (fr.tags || []).slice(0, 2).join(' / ');
    const when = fr.date_range ? fr.date_range : fr.date.slice(0, 7) + (fr.approx ? ' approx' : '');
    return [LN[w.lane].name, tags, when, (fr.commit || '').slice(0, 7)].filter(Boolean).join('  ');
  });
  const u32 = new Uint32Array(st.buffer);
  WALLS.forEach((w, j) => {
    const t = str[j], o = text.length; for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); text.push(c >= 32 && c < 127 ? c : 0x7F); }
    w.shortTitle = t; w.tj = j; u32[4 * j] = o; u32[4 * j + 1] = t.length;
    const rgb = LN[w.lane].rgb; st.set([...mixc([236, 240, 248], rgb, 0.22), 255], 16 * j + 8); st.set([...rgb, 255], 16 * j + 12);
  });
  const rows = Math.ceil(text.length / 4096) + 1, arr = new Uint8Array(rows * 4096); arr.set(text);
  const tex = G.tex2D(gl, 4096, rows, gl.R8UI, gl.RED_INTEGER, gl.UNSIGNED_BYTE, arr);
  const vao = gl.createVertexArray(), sbuf = gl.createBuffer(), dbuf = gl.createBuffer(), n = WALLS.length;
  gl.bindVertexArray(vao);
  const dyn = new Float32Array(n * 4);
  gl.bindBuffer(gl.ARRAY_BUFFER, dbuf); gl.bufferData(gl.ARRAY_BUFFER, dyn, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0); gl.vertexAttribDivisor(0, 1);
  gl.bindBuffer(gl.ARRAY_BUFFER, sbuf); gl.bufferData(gl.ARRAY_BUFFER, st, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1); gl.vertexAttribIPointer(1, 2, gl.UNSIGNED_INT, 16, 0); gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 16, 8); gl.vertexAttribDivisor(2, 1);
  gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 16, 12); gl.vertexAttribDivisor(3, 1);
  gl.bindVertexArray(null);
  return { tex, vao, dbuf, dyn, n, len: WALLS.map(w => w.shortTitle.length), cur: new Float32Array(n), pos: new Float32Array(n * 4), rects: [], shown: 0 };
})();
// lanes: floor bands + titles
const XMAX = xMax + 12000;
for (const ln of LN) {
  const first = ln.xs[0], L = ln.L;
  floor.add(ln.z0, ln.z0 + L.width, -8, -8, first - 3000, XMAX, [...mixc([12, 14, 19], ln.rgb, 0.12), 255], NONE, K_FLOOR);
  labs.add(L.title, ln.z0, 4096 + 1800, first - 3500, NONE, [0, 0, 160], [0, 180, 0], [...ln.rgb, 255], 15, 0, 90);
  labs.add(L.name, ln.z0, -10, first - 3200, NONE, [0, 0, 260], [260, 0, 0], [...ln.rgb, 200], 0, 0, 20);
}
{ const fz = layout.fpgadc.z0, fx = Math.min(...WALLS.filter(w => LN[w.lane].L.group === 'fpgadc').map(w => w.x));
  labs.add(layout.fpgadc.title, fz, 4096 + 4200, fx - 6000, NONE, [0, 0, 300], [0, 340, 0], [120, 230, 220, 255], 18, 0, 100);
  floor.add(fz - 2900, fz - 100, -12, -12, fx - 8000, XMAX, [30, 60, 64, 255], NONE, K_FLOOR); }
// ruler: years, gaps, brackets
const zR0 = -6000, zR1 = -1500, zTop = LN.at(-1).z0 + LN.at(-1).L.width;
floor.add(zR0, zR1, -10, -10, xMin - 16000, XMAX, [22, 26, 34, 255], NONE, K_FLOOR);
for (const r of layout.ruler) {
  if (r.year) {
    floor.add(zR0, zR1, -6, -6, r.x - 25, r.x + 25, [120, 130, 150, 255], NONE, K_FLOOR);
    labs.add(String(r.year), zR0 + 300, 1500, r.x - 1, NONE, [0, 0, 380], [0, 420, 0], [190, 200, 220, 255], 13, 0, 60);
    seg([zR1, -6, 0, r.x, NONE, NONE, [120, 130, 150, 90]], [zTop, -6, 0, r.x, NONE, NONE, [120, 130, 150, 30]]);
  } else {
    floor.add(zR0, zTop, -9, -9, r.x - 1200, r.x + 1200, [40, 36, 30, 255], NONE, K_FLOOR);
    labs.add(`${r.gap} (${r.from} to ${r.to})`, zR0 + 300, 400, r.x - 1000, NONE, [0, 0, 120], [0, 150, 0], [170, 160, 140, 255], 10, 0, 35);
  }
}
for (const b of layout.brackets) {
  const ln = LN[b.lane];
  for (let x = b.x0; x < b.x1; x += 600) floor.add(ln.z0 - 1400, ln.z0 - 200, -4, -4, x, Math.min(b.x1, x + 300), [200, 150, 60, 200], NONE, K_FLOOR);
  labs.add(`real dates ${b.range}: ${trunc(b.note, 110)}`, ln.z0 - 1350, 2, b.x0, NONE, [0, 0, 22], [40, 0, 0], [230, 190, 120, 255], 0, 0, 0);
}
// the clock: a floor strip and a thin gate across every lane at the current time
floor.add(zR0, zTop, -3, -3, -60, 60, [124, 196, 255, 200], CLOCK, K_FLOOR);
floor.add(zR0, zR0 + 600, -2, -2, -400, 400, [124, 196, 255, 255], CLOCK, K_FLOOR);
// lineage edges (arcs over the lanes, between the frames they join)
const EDGE_RGB = { 'git-fork': [120, 200, 255], 'git-merge': [120, 170, 255], import: [240, 200, 110], concept: [150, 150, 165], copy: [255, 120, 200] };
V.edgeStyle = EDGE_RGB;
layout.edges.forEach((e, ei) => {
  const a = W[e.from], b = W[e.to]; if (!a || !b) return;
  const za = a.z0 + a.cols * 64, zb = b.z0 + b.cols * 64, c = EDGE_RGB[e.kind] || [160, 160, 160];
  const N = 64, top = 4300 + 900 * (ei % 5) + Math.min(6000, Math.abs(zb - za) * 0.08);
  for (let i = 0; i < N; i++) {
    if (e.kind === 'concept' && (i & 1)) continue;
    const pt = s => { const sm = s * s * (3 - 2 * s); return [za + (zb - za) * sm, 4200 + Math.sin(Math.PI * s) * (top - 4200), s, 0, a.i, b.i, [...c, 230]]; };
    seg(pt(i / N), pt((i + 1) / N));
  }
  labs.add(trunc(e.label, 120), (za + zb) / 2, top + 400, (b.x - a.x) / 2, e.from, [0, 0, 40], [0, 50, 0], [...c, 255], 11, 0, e.kind === 'copy' || e.kind === 'git-fork' ? 55 : 50);
});
plates.build(); floor.build(); pinsR.build(); labs.build();
function makeSegBuf(list) {
  const n = list.length, ab = new ArrayBuffer(Math.max(1, n) * 24), f32 = new Float32Array(ab), u16 = new Uint16Array(ab), u8 = new Uint8Array(ab);
  list.forEach((v, i) => { for (let k = 0; k < 4; k++) f32[i * 6 + k] = v[k]; u16[i * 12 + 8] = v[4]; u16[i * 12 + 9] = v[5]; u8.set(v[6], i * 24 + 20); });
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, ab, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 24, 0);
  gl.enableVertexAttribArray(1); gl.vertexAttribIPointer(1, 2, gl.UNSIGNED_SHORT, 24, 16);
  gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.UNSIGNED_BYTE, true, 24, 20);
  gl.bindVertexArray(null); gpuBytes += n * 24; return { vao, n };
}
const segBuf = makeSegBuf(segs);
const emptyVAO = gl.createVertexArray();

// T3 (file quads coloured by the file's dominant origin), built when the per-frame file lists arrive
const t3Range = new Map(), t4Range = new Map(), t5Range = new Map();
function buildT3() {
  for (const w of WALLS) {
    const m = w.meta; if (!m) continue; const a = t3.count, sl = laneSlotsSorted[w.lane];
    for (let k = 0; k < m.slot.length; k++) {
      const s = m.slot[k]; if (s < 0) continue;
      let p = sl.L[s] + core.HDR; const e = p + m.n[k], dom = m.dom[k];
      while (p < e) { const c = Math.floor(p / H), r0 = p % H, r1 = Math.min(H, r0 + (e - p));
        t3.add(w.z0 + c * 128, w.z0 + c * 128 + 110, 4096 - r1 * 2, 4096 - r0 * 2, 0, 0, [dom & 255, dom >> 8, 128, 220], w.i, K_PAL | PUSH2); p += r1 - r0; }
    }
    t3Range.set(w.i, [a, t3.count - a]);
    // T4 (distant): one strip per column, coloured by the column's dominant origin
    const b0 = t4.count, colTop = new Int32Array(w.cols).fill(H), colBot = new Int32Array(w.cols).fill(-1), colDom = new Map();
    for (let k = 0; k < m.slot.length; k++) {
      const s = m.slot[k]; if (s < 0) continue;
      let p = sl.L[s]; const e = p + core.HDR + m.n[k];
      while (p < e) { const c = Math.floor(p / H), r0 = p % H, r1 = Math.min(H, r0 + (e - p));
        if (c < w.cols) { colTop[c] = Math.min(colTop[c], r0); colBot[c] = Math.max(colBot[c], r1); const key = c * 65536 + m.dom[k]; colDom.set(key, (colDom.get(key) || 0) + r1 - r0); }
        p += r1 - r0; }
    }
    const best = new Map(); for (const [key, n] of colDom) { const c = Math.floor(key / 65536); if (!best.has(c) || best.get(c)[1] < n) best.set(c, [key % 65536, n]); }
    for (let c = 0; c < w.cols; c++) if (colBot[c] > colTop[c]) { const dom = best.get(c)[0];
      t4.add(w.z0 + c * 128, w.z0 + c * 128 + 112, 4096 - colBot[c] * 2, 4096 - colTop[c] * 2, 0, 0, [dom & 255, dom >> 8, 110, 200], w.i, K_PAL | PUSH2 | K_T4); }
    t4Range.set(w.i, [b0, t4.count - b0]);
    // T5 (very distant): the whole wall as one quad in its dominant origin colour
    t5Range.set(w.i, [t5.count, 1]); const d5 = domOf(w);
    t5.add(w.z0, w.z0 + w.cols * 128, 0, 4096, 0, 0, [d5 & 255, d5 >> 8, 100, 230], w.i, K_PAL | PUSH2 | K_T5);
  }
  t3.build(); t4.build(); t5.build();
}

// ---- declutter (CPU, per frame): same size rules as labelVS, greedy by priority over a grid of placed screen boxes
const DL = { cur: new Float32Array(labs.list.length), shift: new Int8Array(labs.list.length), shown: 0 };
V.declutter = DL;
const DLS = labs.list.map(l => ({ w: l[3], z: l[0], y: l[1], dx: l[2], lu: Math.hypot(l[4], l[5], l[6]), lv: Math.hypot(l[7], l[8], l[9]),
  U: [l[4], l[5], l[6]], Vv: [l[7], l[8], l[9]], L: l[11], bb: l[13], maxPx: l[14], prio: l[15], wallPlane: l[13] < 0.5 && l[4] === 0 && l[7] === 0, s: l[16] }));
function declutter(dt, rgt, up, minPx) {
  const fp = focalPx(), cw = canvas.width, ch = canvas.height, cam = V.cam.p, M = VP;
  let ox = 0, oy = 0, ok = false;
  const proj = (x, y, z) => { const w = M[3] * x + M[7] * y + M[11] * z + M[15]; if (w <= 1) { ok = false; return; }
    ox = ((M[0] * x + M[4] * y + M[8] * z + M[12]) / w + 1) * 0.5 * cw; oy = (1 - (M[1] * x + M[5] * y + M[9] * z + M[13]) / w) * 0.5 * ch; ok = true; };
  const cand = DL.cand || (DL.cand = []); cand.length = 0;
  const occW = occList;
  for (let i = 0; i < DLS.length; i++) {
    const l = DLS[i], w = l.w, wa = wallArr[4 * w + 1]; if (wa <= 0 || (w < NONE && wallArr[4 * w + 2] < 0.5)) continue;
    const o0 = wallArr[4 * w] + l.dx, o1 = l.y, o2 = l.z;
    if (l.wallPlane && cam[0] > o0) continue;
    const d = Math.hypot(o0 - cam[0], o1 - cam[1], o2 - cam[2]); let px = l.lv * 2 * fp / Math.max(d, 1), k = 1;
    if (l.bb > 1.5 && px < l.bb) { k = l.bb / px; px = l.bb; }
    if (px < minPx || (l.maxPx > 0 && px > l.maxPx)) continue;
    let U0, U1, U2, V0, V1, V2;
    if (l.bb > 0.5) { U0 = rgt[0] * l.lu * k; U1 = rgt[1] * l.lu * k; U2 = rgt[2] * l.lu * k; V0 = up[0] * l.lv * k; V1 = up[1] * l.lv * k; V2 = up[2] * l.lv * k; }
    else { U0 = l.U[0]; U1 = l.U[1]; U2 = l.U[2]; V0 = l.Vv[0]; V1 = l.Vv[1]; V2 = l.Vv[2]; }
    const c0 = o0 + U0 * l.L / 2 - V0, c1 = o1 + U1 * l.L / 2 - V1, c2 = o2 + U2 * l.L / 2 - V2, dx = c0 - cam[0];
    let occluded = false;   // drawn without depth test: hide a label whose centre is behind a solid wall
    if (Math.abs(dx) > 1e-6) for (const ww of occW) {
      if (ww.i === w) continue;
      const t = (wallArr[4 * ww.i] - cam[0]) / dx; if (t <= 0 || t >= 0.999) continue;
      const y = cam[1] + t * (c1 - cam[1]); if (y <= -6 || y >= 4102) continue;
      const z = cam[2] + t * (c2 - cam[2]); if (z > ww.z0 && z < ww.z0 + ww.cols * 128 - 4) { occluded = true; break; }
    }
    if (occluded) continue;
    cand.push({ i, o0, o1, o2, U0, U1, U2, V0, V1, V2, L: l.L, bb: l.bb > 0.5, pr: l.prio + (DL.cur[i] > 0.5 ? 0.5 : 0) });
  }
  cand.sort((a, b) => b.pr - a.pr);
  const grid = new Map(), G0 = 96;
  if (!DL.panels || performance.now() - DL.panelsT > 500) { DL.panelsT = performance.now(); const k = cw / Math.max(1, canvas.clientWidth);
    const att = document.body.classList.contains('attract');
    DL.panels = [...document.querySelectorAll('.panel')].filter(e => e.getClientRects().length && e.id !== 'tip' && e.id !== 'loading' && (!att || e.id === 'caption' || e.id === 'audiogate')).map(e => { const b = e.getBoundingClientRect(); return [b.left * k, b.top * k, b.right * k, b.bottom * k]; }); }
  const hit = r => { for (let gx = Math.floor(r[0] / G0); gx <= Math.floor(r[2] / G0); gx++) for (let gy = Math.floor(r[1] / G0); gy <= Math.floor(r[3] / G0); gy++) {
    const c = grid.get(gx * 65536 + gy); if (c) for (const q of c) if (q[0] < r[2] && r[0] < q[2] && q[1] < r[3] && r[1] < q[3]) return true; } return false; };
  const put = r => { for (let gx = Math.floor(r[0] / G0); gx <= Math.floor(r[2] / G0); gx++) for (let gy = Math.floor(r[1] / G0); gy <= Math.floor(r[3] / G0); gy++) {
    const k = gx * 65536 + gy; let c = grid.get(k); if (!c) grid.set(k, c = []); c.push(r); } };
  for (const r of DL.panels) put(r);
  for (const r of TT.rects) put(r);
  const target = DL.target || (DL.target = new Uint8Array(DLS.length)); target.fill(0);
  const SHF = [0, 0, 1, -1, 2, -2];
  for (const c of cand) {
    const nsh = c.bb ? 6 : 1; SHF[0] = DL.shift[c.i];
    for (let q = 0; q < nsh; q++) {
      const sh = c.bb ? SHF[q] : 0, b0 = c.o0 - 2 * c.V0 * sh, b1 = c.o1 - 2 * c.V1 * sh, b2 = c.o2 - 2 * c.V2 * sh;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9, bad = false;
      for (let e = 0; e < 4 && !bad; e++) { const a = (e & 1) ? c.L : 0, v = (e & 2) ? 2 : 0;
        proj(b0 + c.U0 * a - c.V0 * v, b1 + c.U1 * a - c.V1 * v, b2 + c.U2 * a - c.V2 * v); if (!ok) { bad = true; break; }
        if (ox < x0) x0 = ox; if (ox > x1) x1 = ox; if (oy < y0) y0 = oy; if (oy > y1) y1 = oy; }
      if (bad) break;
      const r = [x0 - 4, y0 - 3, x1 + 4, y1 + 3];
      if (r[2] < 0 || r[0] > cw || r[3] < 0 || r[1] > ch) break;                  // off screen
      if (r[0] < 0 || r[2] > cw) break;                                           // cut by the screen edge: hide, do not clip
      if (!hit(r)) { put(r); target[c.i] = 1; DL.shift[c.i] = sh; break; }
    }
  }
  const k = Math.min(1, dt * 10); let shown = 0; const data = labs.dyn;
  for (let i = 0; i < DLS.length; i++) {
    let cv = DL.cur[i] + (target[i] - DL.cur[i]) * k; if (!target[i] && cv < 0.02) cv = 0; DL.cur[i] = cv;
    if (target[i]) shown++; data[2 * i] = cv; data[2 * i + 1] = DL.shift[i];
  }
  DL.shown = shown; DL.candidates = cand.length;
  gl.bindBuffer(gl.ARRAY_BUFFER, labs.dbuf); gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
}
V.visibleLabels = () => DLS.map((l, i) => DL.cur[i] > 0.5 ? l.s : null).filter(Boolean);

// ---- wall titles (CPU, per frame): anchored above the wall's top edge (stuck to the screen top while the wall covers it),
// size from the distance clamped to [min, max] px per tier; greedy placement, highest tier first (the frame at the clock of
// each lane, then solid walls, then ghosts), nearer first, so nothing overlaps; faded in / out. One instanced draw.
const TSZ = [[12, 15, 0.5, 9], [14, 20, 0.85, 10], [16, 25, 1, 11]];   // per tier: min / max CSS px (cell height), alpha, floor in canvas px
function layoutTitles(dt) {
  const cw = canvas.width, ch = canvas.height, k = cw / Math.max(1, canvas.clientWidth), M = VP, cam = V.cam.p, fp = focalPx();
  const cur = TT.curSet || (TT.curSet = new Set()); cur.clear();
  for (const L of live) cur.add(L.f);
  if (V.pres() === 'gallery') for (let li = 0; li < LN.length; li++) { const f = V.laneFrameAt(li); if (f >= 0) cur.add(f); }
  const clip = (x, y, z) => [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[3] * x + M[7] * y + M[11] * z + M[15], z];
  const cut = (a, b) => { const t = (1 - a[2]) / (b[2] - a[2]); return a.map((v, i) => v + (b[i] - v) * t); };   // a: in front (w >= 1)
  const cand = TT.cand || (TT.cand = []); cand.length = 0;
  for (const w of visList) {
    const j = w.tj, x = wallArr[4 * w.i]; if (wallArr[4 * w.i + 1] <= 0.02) continue;
    const tier = cur.has(w.i) ? 2 : wallArr[4 * w.i + 2] > 0.5 ? 1 : 0, z1 = w.z0 + w.cols * 128;
    let a = clip(x, 4096, w.z0), b = clip(x, 4096, z1);
    if (a[2] < 1 && b[2] < 1) continue;
    if (a[2] < 1) a = cut(b, a); else if (b[2] < 1) b = cut(a, b);
    let ax = (a[0] / a[2] + 1) * 0.5 * cw, ay = (1 - a[1] / a[2]) * 0.5 * ch, bx = (b[0] / b[2] + 1) * 0.5 * cw, by = (1 - b[1] / b[2]) * 0.5 * ch, za = a[3], zb = b[3];
    if (ax > bx) { [ax, bx] = [bx, ax]; [ay, by] = [by, ay]; [za, zb] = [zb, za]; }
    if (bx < 8 || ax > cw - 8) continue;
    const d = G.boxDist(cam, x, 4096, w.z0, x, 4096, z1), [mn, mx, al, fl] = TSZ[tier];
    const size = Math.min(mx * k, Math.max(mn * k, fl, 160 * fp / Math.max(d, 1)));
    const bw = (TT.len[j] + 1.2) * size * 0.5, bh = size * 1.2;
    let tx = Math.max(ax, 6); if (tx + bw > bx) tx = Math.max(ax, bx - bw);
    tx = Math.min(Math.max(tx, 6), cw - bw - 6);
    const s = bx - ax > 1 ? Math.min(1, Math.max(0, (tx - ax) / (bx - ax))) : 0, zw = za + (zb - za) * s;
    let ty = ay + (by - ay) * s - bh - 3 * k, sticky = false;
    if (ty > ch - bh - 4) continue;                                   // the top edge is below the screen
    if (ty < 6) {                                                     // above the screen: stick to the top while the wall covers it
      const q = clip(x, 0, zw), qy = q[2] >= 1 ? (1 - q[1] / q[2]) * 0.5 * ch : ch;
      if (qy < bh + 20) continue; ty = 6; sticky = true;
    }
    cand.push({ w, j, tx, ty, size, bw, bh, al, sticky, x, zw, xmax: Math.min(bx, cw - 6), slope: bx - ax > 1 ? (by - ay) / (bx - ax) : 0, pr: tier * 1e9 - d * (TT.cur[j] > 0.5 ? 0.8 : 1) });
  }
  cand.sort((p, q) => q.pr - p.pr);
  // drawn without depth test: hide a title whose anchor is behind a solid wall (tested only for titles that would fit)
  const occluded = c => {
    if (c.sticky) return false;
    const dx = c.x - cam[0], dy = 4100 - cam[1], dz = c.zw - cam[2];
    if (Math.abs(dx) < 1e-6) return false;
    for (const ww of occList) {
      if (ww === c.w) continue; const t = (wallArr[4 * ww.i] - cam[0]) / dx; if (t <= 0 || t >= 0.999) continue;
      const y = cam[1] + t * dy, z = cam[2] + t * dz; if (y > -6 && y < 4102 && z > ww.z0 && z < ww.z0 + ww.cols * 128 - 4) return true;
    }
    return false;
  };
  const rects = TT.rects; rects.length = 0;
  const obst = DL.panels || [];
  const hitR = r => { for (const q of obst) if (q[0] < r[2] && r[0] < q[2] && q[1] < r[3] && r[1] < q[3]) return q;
    for (const q of rects) if (q[0] < r[2] && r[0] < q[2] && q[1] < r[3] && r[1] < q[3]) return q; return null; };
  const target = TT.target || (TT.target = new Uint8Array(TT.n)); target.fill(0);
  for (const c of cand) {
    // blocked (a panel, a placed title): slide right along the top edge, past the blocker, at most 3 times
    let r = null;
    for (let q = 0; q < 4; q++) {
      const rr = [c.tx - 3, c.ty - 3, c.tx + c.bw + 3, c.ty + c.bh + 3], b = hitR(rr);
      if (!b) { r = rr; break; }
      const nx = b[2] + 4; if (nx + c.bw > c.xmax) break;
      if (!c.sticky) c.ty += (nx - c.tx) * c.slope; c.tx = nx;
    }
    if (!r || occluded(c)) continue;
    rects.push(r); target[c.j] = 1; TT.pos[4 * c.j] = c.tx; TT.pos[4 * c.j + 1] = c.ty; TT.pos[4 * c.j + 2] = c.size; TT.pos[4 * c.j + 3] = c.al;
  }
  const kk = Math.min(1, dt * 12); let shown = 0;
  for (let j = 0; j < TT.n; j++) {
    let cv = TT.cur[j] + (target[j] - TT.cur[j]) * kk; if (!target[j] && cv < 0.03) cv = 0; TT.cur[j] = cv; if (target[j]) shown++;
    TT.dyn[4 * j] = TT.pos[4 * j]; TT.dyn[4 * j + 1] = TT.pos[4 * j + 1]; TT.dyn[4 * j + 2] = TT.pos[4 * j + 2]; TT.dyn[4 * j + 3] = cv * TT.pos[4 * j + 3];
  }
  TT.shown = shown;
  gl.bindBuffer(gl.ARRAY_BUFFER, TT.dbuf); gl.bufferData(gl.ARRAY_BUFFER, TT.dyn, gl.DYNAMIC_DRAW);   // orphan: no wait on queued frames
}
V.titles = TT;
V.visibleTitles = () => WALLS.filter(w => TT.cur[w.tj] > 0.5).map(w => w.shortTitle);

// ------------------------------------------------------------------ instance pool (rows of 4096 lines)
const pool = { free: [[0, POOLH]] };
function palloc(rows) {
  for (let i = 0; i < pool.free.length; i++) { const [a, n] = pool.free[i];
    if (n >= rows) { if (n === rows) pool.free.splice(i, 1); else pool.free[i] = [a + rows, n - rows]; return a; } }
  return -1;
}
function pfree(a, rows) {
  pool.free.push([a, rows]); pool.free.sort((x, y) => x[0] - y[0]);
  const m = []; for (const r of pool.free) { const l = m.at(-1); if (l && l[0] + l[1] === r[0]) l[1] += r[1]; else m.push(r.slice()); } pool.free = m;
}
function evict(w) {
  if (!w.gpu) return; pfree(w.gpu.row0, w.gpu.rows); w.gpu = null; w.loaded = false; w.inst = null; V.load.walls--;
  fw.postMessage({ type: 'evicted', frames: [w.i] });
}
function upload(w, m) {
  const rows = Math.max(1, Math.ceil(m.n / POOLW));
  let r0 = palloc(rows);
  while (r0 < 0) {   // evict the least recently used walls that are not wanted now, then wanted ones farther than this one
    let cand = WALLS.filter(x => x.gpu && x.wanted !== wantEpoch).sort((a, b) => a.lastUse - b.lastUse);
    if (!cand.length && w.wanted === wantEpoch) cand = WALLS.filter(x => x.gpu && x.wanted === wantEpoch && x.wantD > w.wantD * 1.25 + 500).sort((a, b) => b.wantD - a.wantD);
    if (!cand.length) return false;
    evict(cand[0]); r0 = palloc(rows);
  }
  const data = new Uint32Array(rows * POOLW * 2); data.set(m.inst);
  gl.bindTexture(gl.TEXTURE_2D, instTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r0, POOLW, rows, gl.RG_INTEGER, gl.UNSIGNED_INT, data);
  Object.assign(w, { gpu: { row0: r0, rows }, base: r0 * POOLW, inst: m.inst, colStart: m.colStart, fileStart: m.fileStart, fileSlot: m.fileSlot, fileIdent: m.fileIdent,
    paths: m.paths, fst: m.fst, fdom: m.fdom, loaded: true, lastUse: performance.now() });
  const sl = laneSlotsSorted[w.lane]; w.slotToFile = new Map(); for (let k = 0; k < m.fileSlot.length; k++) w.slotToFile.set(m.fileSlot[k], k);
  V.load.walls++;
  return true;
}

// ------------------------------------------------------------------ workers
const fw = new Worker(new URL('./w_frames.js', import.meta.url), { type: 'module' });
const tw = new Worker(new URL('./w_text.js', import.meta.url), { type: 'module' });
fw.postMessage({ type: 'init', F, lanes: layout.lanes });
const morphCache = new Map(); let morphOnGPU = null, wantEpoch = 1; const reqs = new Map(); let reqN = 0;
fw.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'meta') { for (const fm of m.frames) if (W[fm.f]) W[fm.f].meta = fm; }
  else if (m.type === 'metaDone') { buildT3(); V.load.meta = performance.now() - t0Boot; emit('meta'); }
  else if (m.type === 'wall') {
    const w = W[m.f]; if (!w || w.loaded) return;
    if (!upload(w, m)) { fw.postMessage({ type: 'evicted', frames: [m.f] }); return; }
    w.impKey = ''; emit('wall', w);
  } else if (m.type === 'morph') {
    morphCache.set(m.key, m); while (morphCache.size > 6) morphCache.delete(morphCache.keys().next().value);
    pendingMorph.delete(m.key); emit('morph', m);
  } else if (m.type === 'locate') { const f = reqs.get(m.req); reqs.delete(m.req); if (f) f(m.hit); }
  else if (m.type === 'error') console.error('frames worker:', m.error);
};
tw.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'chunk') {
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, textTex);
    let r = 0;
    while (r < m.rows) { const gr = m.row0 + r, layer = gr >> 12, y = gr & 4095, k = Math.min(m.rows - r, 4096 - y);
      if (layer < TEXLAYERS) gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, y, layer, 4096, k, 1, gl.RED_INTEGER, gl.UNSIGNED_BYTE, m.bytes.subarray(r * 4096, (r + k) * 4096)); r += k; }
    G.uploadLinear(gl, offsTex, LW, m.first, m.offs, 1, gl.RED_INTEGER, gl.UNSIGNED_INT);
    V.load.text++; emit('text');
  } else if (m.type === 'textDone') { V.load.allText = performance.now() - t0Boot; }
  else if (m.type === 'text' || m.type === 'search') { const f = reqs.get(m.req); reqs.delete(m.req); if (f) f(m); }
};
V.lineText = ids => new Promise(res => { const req = ++reqN; reqs.set(req, m => res(m.text)); tw.postMessage({ type: 'text', req, ids }); });
V.search = (q, opts) => new Promise(res => { const req = ++reqN; reqs.set(req, res); tw.postMessage({ type: 'search', req, q, ...opts }); });
V.locate = (id, frames) => new Promise(res => { const req = ++reqN; reqs.set(req, res); fw.postMessage({ type: 'locate', req, id, frames }); });
let marksOn = false;
V.setMarks = (ids) => { if (!ids && !marksOn) return; marksOn = !!ids; markArr.fill(0); if (ids) for (const i of ids) markArr[i] = 1;
  gl.bindTexture(gl.TEXTURE_2D, markTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LW, LH, gl.RED_INTEGER, gl.UNSIGNED_BYTE, markArr); invalidateImpostors(); };
const pendingMorph = new Set();
function requestMorph(a, b) {
  const key = `${a}>${b}`; if (morphCache.has(key)) return morphCache.get(key);
  if (!pendingMorph.has(key)) { pendingMorph.add(key); fw.postMessage({ type: 'morph', a, b, key }); }
  return null;
}
gz('data/linemeta.bin.gz').then(meta => {
  const arr = new Uint8Array(LW * LH * 2); arr.set(meta);
  gl.bindTexture(gl.TEXTURE_2D, metaTex); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LW, LH, gl.RG_INTEGER, gl.UNSIGNED_BYTE, arr);
  V.lineMeta = meta; V.load.meta2 = performance.now() - t0Boot; emit('linemeta');
});

// ------------------------------------------------------------------ camera
const keys = new Set();
function camBasis() {
  const c = V.cam, cp = Math.cos(c.pitch);
  const f = [cp * Math.cos(c.yaw), Math.sin(c.pitch), cp * Math.sin(c.yaw)];
  const r = G.norm(G.cross(f, [0, 1, 0])), u = G.cross(r, f);
  return { f, r, u };
}
V.camBasis = camBasis;
function setLook(dir) { const d = G.norm(dir); V.cam.yaw = Math.atan2(d[2], d[0]); V.cam.pitch = Math.asin(Math.max(-1, Math.min(1, d[1]))); }
V.setLook = setLook;
V.flyTo = (p, dir, dur) => {
  const c = V.cam, p0 = c.p.slice(), d0 = camBasis().f, dist = Math.hypot(p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]);
  dur = dur ?? Math.min(2.5, Math.max(0.8, 0.45 * Math.log10(1 + dist)));
  V.flight = { p0, p1: p.slice(), d0, d1: G.norm(dir), t: 0, dur, lift: Math.min(dist * 0.35, 60000) };
};
function stepFlight(dt) {
  const Fl = V.flight; if (!Fl) return;
  Fl.t += dt / Fl.dur; const t = Math.min(1, Fl.t), s = t * t * (3 - 2 * t);
  const p = Fl.p0.map((v, i) => v + (Fl.p1[i] - v) * s); p[1] += Math.sin(Math.PI * s) * Fl.lift;
  V.cam.p = p; setLook(Fl.d0.map((v, i) => v + (Fl.d1[i] - v) * s));
  if (t >= 1) V.flight = null;
}
function focalPx() { return canvas.height / (2 * Math.tan(FOV / 2)); }
V.focalPx = focalPx; V.FOV = FOV;
const dispXOf = w => wallArr[4 * w.i + 1] > 0 ? wallArr[4 * w.i] : w.x;
V.dispX = dispXOf;
const pWOf = w => { const x = wallArr[4 * w.i]; return 2 * focalPx() / Math.max(1, G.boxDist(V.cam.p, x, 0, w.z0, x, 4096, w.z0 + w.cols * 128)); };
// the screen region the panels leave free, in NDC: [x0, x1, y0, y1]
function freeNDC() {
  const W0 = innerWidth, H0 = innerHeight, r = id => { const e = document.getElementById(id); return e && e.getClientRects().length && !document.body.classList.contains('shots') && !document.body.classList.contains('attract') ? e.getBoundingClientRect() : null; };
  const lg = r('legend'), tl = r('timeline'), hud = r('hud');
  const bottom = Math.min(tl ? tl.top : H0, hud ? hud.top : H0);
  return [-0.96, lg ? 2 * (lg.left - 12) / W0 - 1 : 0.96, bottom < H0 ? 1 - 2 * (bottom - 8) / H0 : -0.96, 0.94];
}
V.freeNDC = freeNDC;
// fit points (or the box corners) into the free screen region looking along f: exact, by bisection on the distance
// (for a distance d the feasible sideways / vertical offsets are intervals; the smallest d where both are non-empty wins)
V.fitBox = (bb, f, pts = null) => {
  const aspect = canvas.clientWidth / canvas.clientHeight, [a, b] = bb;
  const box = pts || []; if (!pts) for (const x of [a[0], b[0]]) for (const y of [a[1], b[1]]) for (const z of [a[2], b[2]]) box.push([x, y, z]);
  const free = freeNDC();
  f = G.norm(f); const rgt = G.norm(G.cross(f, [0, 1, 0])), up = G.cross(rgt, f), th = Math.tan(FOV / 2);
  const C = [0, 1, 2].map(i => (a[i] + b[i]) / 2);
  const P = box.map(c => { const v = c.map((q, i) => q - C[i]); return [G.dot(v, rgt), G.dot(v, up), G.dot(v, f)]; });
  const zmin = Math.min(...P.map(p => p[2]));
  const solve = d => { let sxLo = -1e18, sxHi = 1e18, syLo = -1e18, syHi = 1e18;
    for (const [x, y, z] of P) { const kx = (z + d) * th * aspect, ky = (z + d) * th; if (z + d < 1) return null;
      sxLo = Math.max(sxLo, x - free[1] * kx); sxHi = Math.min(sxHi, x - free[0] * kx); syLo = Math.max(syLo, y - free[3] * ky); syHi = Math.min(syHi, y - free[2] * ky); }
    return sxLo <= sxHi && syLo <= syHi ? [(sxLo + sxHi) / 2, (syLo + syHi) / 2] : null; };
  let lo = Math.max(1, 1 - zmin), hi = lo + 10; while (!solve(hi) && hi < 1e9) hi *= 2;
  for (let it = 0; it < 60; it++) { const m = (lo + hi) / 2; if (solve(m)) hi = m; else lo = m; }
  const [sx, sy] = solve(hi) || [0, 0];
  return { p: C.map((v, i) => v + rgt[i] * sx + up[i] * sy - f[i] * hi), dir: f };
};
V.wallsBox = (fs) => { const ws = fs.map(f => W[f]).filter(Boolean);
  return [[Math.min(...ws.map(w => dispXOf(w))) - 2000, 0, Math.min(...ws.map(w => w.z0))], [Math.max(...ws.map(w => dispXOf(w))), 4600, Math.max(...ws.map(w => w.z0 + w.cols * 128))]]; };
V.overview = () => {
  const pts = [];
  for (const ln of LN) for (const k of [0, ln.frames.length - 1]) for (const y of [0, 4600]) pts.push([ln.xs[k], y, ln.z0], [ln.xs[k], y, ln.z0 + ln.L.width]);
  pts.push([xMin - 6000, 0, zR0], [xMax, 0, zR0]);
  return V.fitBox([[xMin - 9000, 0, zR0], [XMAX, 4600, zTop]], Q.get('ovdir') ? Q.get('ovdir').split(',').map(Number) : [0.42, -0.55, -0.72], pts);
};
// camera that reads wall w at (col, row) from `dist`, placed so the point lies in the free screen region (not under the HUD)
V.wallView = (w, col, row, dist) => {
  const free = freeNDC(), th = Math.tan(FOV / 2), asp = canvas.clientWidth / canvas.clientHeight, hw = dist * th * asp;
  const cx = (free[0] + free[1]) / 2, cy = (free[2] + free[3]) / 2, zl = w.z0 + col * 128, y = 4096 - row * 2;
  // the whole column fits: centre it in the free region; else put the line starts at the region's left edge
  const z = (free[1] - free[0]) * hw >= 132 ? zl + 62 - cx * hw : zl - 2 - (free[0] + 0.04) * hw;
  return { p: [dispXOf(w) - dist, y - cy * dist * th, z], dir: [1, 0, 0] };
};
V.fitWall = (w) => { const wid = w.cols * 128; return V.fitBox([[dispXOf(w), 0, w.z0], [dispXOf(w), 4300, w.z0 + wid]], [1, -0.05, 0]); };
V.readDist = (px = 16) => canvas.clientHeight / Math.tan(FOV / 2) / px;   // px: CSS px per line
// view of file slot s (lane slot index) of wall w at file line `line` (1-based; 0 = the header)
V.slotView = (w, s, line = 0, px) => {
  const L0 = laneSlotsSorted[w.lane].L[s] + (line > 0 ? core.HDR + line - 1 : 0), col = Math.floor(L0 / H), row = L0 % H, dist = V.readDist(px);
  return V.wallView(w, col, Math.min(H - 1, row + (line > 0 ? 0 : Math.round(dist * 0.22))), dist);
};
V.slotOf = (w, ident) => laneSlotsSorted[w.lane].byIdent.get(ident);
V.flyToSlot = (w, s, line) => { const v = V.slotView(w, s, line); V.flyTo(v.p, v.dir); };

// input; every input is reported (attract mode exits on any of it)
const activity = (e) => emit('input', e);
addEventListener('keydown', e => {
  activity(e);
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') { if (e.key === 'Escape') e.target.blur(); return; }
  keys.add(e.code); emit('key', e);
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
let drag = null;
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('mousedown', e => { activity(e); drag = { x: e.clientX, y: e.clientY, moved: 0, b: e.button }; });
addEventListener('mouseup', e => { if (drag && drag.moved < 4 && e.target === canvas) emit('click', e); drag = null; });
addEventListener('mousemove', e => {
  V.mouse = { x: e.clientX, y: e.clientY, over: e.target === canvas };
  if (Math.abs(e.movementX) + Math.abs(e.movementY) > 2) activity(e);
  if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.moved += Math.abs(dx) + Math.abs(dy); drag.x = e.clientX; drag.y = e.clientY;
    if (drag.moved >= 4) { V.flight = null; V.cam.yaw += dx * 0.0035; V.cam.pitch = Math.max(-1.55, Math.min(1.55, V.cam.pitch - dy * 0.0035)); } }
});
addEventListener('pointerdown', activity); addEventListener('touchstart', activity, { passive: true });
canvas.addEventListener('dblclick', e => emit('dblclick', e));
canvas.addEventListener('wheel', e => { e.preventDefault(); activity(e); V.cam.speed = Math.max(10, Math.min(100000, V.cam.speed * Math.exp(-e.deltaY * 0.0015))); }, { passive: false });
function moveCam(dt) {
  if (V.flight) { stepFlight(dt); return; }
  const { f, r } = camBasis(); const m = [0, 0, 0]; let any = false;
  const add = (v, s) => { m[0] += v[0] * s; m[1] += v[1] * s; m[2] += v[2] * s; any = true; };
  if (keys.has('KeyW')) add(f, 1); if (keys.has('KeyS')) add(f, -1);
  if (keys.has('KeyD')) add(r, 1); if (keys.has('KeyA')) add(r, -1);
  if (keys.has('KeyE') || keys.has('Space')) add([0, 1, 0], 1); if (keys.has('KeyQ') || keys.has('KeyC')) add([0, 1, 0], -1);
  if (!any) return;
  const sp = V.cam.speed * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 4 : 1) / (keys.has('ControlLeft') ? 4 : 1);
  V.cam.p = V.cam.p.map((v, i) => v + m[i] * sp * dt);
}

// ------------------------------------------------------------------ the shared clock: which walls show, where, how solid
// pres 'now' (playing, or N): one live wall per lane on the clock plane, morphing frame to frame; the lane's other frames
// within GH months are ghosts at their own X; releases stay solid. pres 'gallery' (paused): every wall solid at its X.
const GH = (SOFT ? 3 : 6) * U;
// pres 'clock' (paused, default): each lane's frame at the clock solid at its own X, neighbours ghosted, releases solid.
// 'now' (playing, or chosen): the lane's frame rides on the clock plane and morphs frame to frame. 'gallery': every wall solid.
V.pres = () => V.playing ? 'now' : V.presMode;
V.cyclePres = () => { V.presMode = { clock: 'now', now: 'gallery', gallery: 'clock' }[V.presMode]; emit('time'); };
const lb = (xs, x) => { let lo = 0, hi = xs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m + 1; else hi = m; } return lo - 1; };
V.laneFrameAt = (li, x = V.X) => { const ln = LN[li], k = lb(ln.xs, x + 1e-3); return k >= 0 ? ln.frames[k] : -1; };
V.dateOfX = x => tm.dateOfMonth(tm.monthOfX(x));
let dispList = [], occList = [], visList = [];
const live = [];   // per lane: { f, x, morph }
function updateDisplay() {
  wallArr.fill(0);
  wallArr[4 * NONE] = 0; wallArr[4 * NONE + 1] = 1; wallArr[4 * NONE + 2] = 1;
  wallArr[4 * CLOCK] = V.X; wallArr[4 * CLOCK + 1] = 1; wallArr[4 * CLOCK + 2] = 1;
  V.morph = null; live.length = 0;
  const pres = V.pres(), now = pres === 'now', X = V.X;
  for (const ln of LN) {
    const k = lb(ln.xs, X + 1e-3);
    if (pres === 'gallery') { for (const f of ln.frames) { const o = 4 * f; wallArr[o] = W[f].x; wallArr[o + 1] = 1; wallArr[o + 2] = 1; } continue; }
    // ghosts first (live / releases overwrite)
    for (let q = Math.max(0, lb(ln.xs, X - GH)); q < ln.frames.length && ln.xs[q] <= X + GH; q++) {
      const f = ln.frames[q], o = 4 * f, d = Math.abs(ln.xs[q] - X) / GH;
      if (d > 1) continue; wallArr[o] = ln.xs[q]; wallArr[o + 1] = 0.05 + 0.25 * (1 - d); wallArr[o + 2] = 0;
    }
    for (const f of ln.frames) if (W[f].solidRelease) { const o = 4 * f; wallArr[o] = W[f].x; wallArr[o + 1] = 1; wallArr[o + 2] = 1; }
    if (k < 0) continue;
    const lastX = ln.xs.at(-1), dead = k === ln.frames.length - 1 && X > lastX + 3 * U;
    let f = ln.frames[k], x = now && !dead ? X : ln.xs[k], morph = null;
    // morph into the next frame over the last part of the step; only where the live wall is near enough to read
    const nearLive = now && k + 1 < ln.frames.length && 2 * focalPx() / Math.max(1, G.boxDist(V.cam.p, x, 0, ln.z0, x, 4096, ln.z0 + ln.cols * 128)) >= (V.quality.t1 || 2) * 0.3;
    if (nearLive) {
      const xn = ln.xs[k + 1], mL = Math.min(0.75 * U, xn - ln.xs[k]);
      if (X > xn - mL) {
        const u = (X - (xn - mL)) / Math.max(1, mL), b = ln.frames[k + 1], mm = requestMorph(f, b);
        if (mm) { morph = { a: f, b, u, m: mm, lane: ln.li }; wallArr[4 * f + 1] = 0; f = b; }
      } else if (X > xn - 2.5 * U) requestMorph(f, ln.frames[k + 1]);   // prefetch
    }
    const o = 4 * f; wallArr[o] = x; wallArr[o + 1] = 1; wallArr[o + 2] = 1;
    live.push({ lane: ln.li, f, x, morph });
    // reading the live wall up close: the lane's other walls behind it (ghosts, releases) shine through its transparent
    // background as a second, offset layer of text. Fade them out as the camera comes within reading range.
    const cp = V.cam.p, dx = cp[0] - x;
    if (cp[2] > ln.z0 - 512 && cp[2] < ln.z0 + ln.cols * 128 + 512 && Math.abs(dx) < 3200) {
      const fade = Math.max(0, Math.min(1, (Math.abs(dx) - 500) / 2700));
      for (const g of ln.frames) {
        const o = 4 * g; if (g === f || (morph && g === morph.a) || wallArr[o + 1] <= 0 || (wallArr[o] - x) * dx >= 0) continue;
        wallArr[o + 1] *= fade; if (wallArr[o + 1] < 0.01) wallArr[o + 1] = 0;
      }
    }
    if (morph && (!V.morph || Math.abs(W[morph.b].z0 + W[morph.b].cols * 64 - V.cam.p[2]) < Math.abs(W[V.morph.b].z0 + W[V.morph.b].cols * 64 - V.cam.p[2]))) V.morph = morph;
  }
  dispList = WALLS.filter(w => wallArr[4 * w.i + 1] > 0);
  wallTexI = (wallTexI + 1) % wallTexRing.length; wallTex = wallTexRing[wallTexI]; uploadWallTex();
}
V.live = live;
V.setX = (x, opts = {}) => {
  const x1 = Math.max(xMin - 2 * U, Math.min(xMax + 2 * U, x)), d = x1 - V.X;
  V.X = x1;
  if (opts.follow !== false && V.pres() === 'now' && V.follow !== false && !V.flight) V.cam.p[0] += d;
  emit('time');
};
V.setPlaying = (p) => { if (p && V.X >= xMax) V.X = xMin; V.playing = !!p; emit('time'); };
V.isSolid = w => wallArr[4 * w.i + 2] > 0.5 && wallArr[4 * w.i + 1] > 0;

// ------------------------------------------------------------------ impostors (baked walls): low-res for every loaded wall in
// view, high-res for the nearest ones (refreshed as the camera approaches)
const IMP = SOFT ? { lo: [2, 512], hi: null, capLo: 40 * 1048576, capHi: 0 } : { lo: [4, 1024], hi: [16, 2048], capLo: 192 * 1048576, capHi: 288 * 1048576 };
// LOD distances in px per line at the wall's nearest point (from the camera or from where it is heading): stream the wall's
// lines (want), bake its sharp impostor (hi), show its file cards (card; the nearest `cards` walls), file quads below t3,
// column strips below t4, one quad below t5. look: seconds of travel to look ahead.
const LODP = SOFT ? { want: 0.1, hi: 1e9, hiN: 0, card: 0.3, cards: 4, t4: 0.07, t5: 0.02, look: 1.2 } : { want: 0.045, hi: 0.1, hiN: 6, card: 0.12, cards: 12, t4: 0.03, t5: 0.008, look: 1.5 };
let hiSet = new Set();
V.LODP = LODP;
const NOFADE = new Float32Array([-1, 0]);
const boxFar = (p, x0, y0, z0, x1, y1, z1) => Math.hypot(Math.max(Math.abs(p[0] - x0), Math.abs(p[0] - x1)), Math.max(Math.abs(p[1] - y0), Math.abs(p[1] - y1)), Math.max(Math.abs(p[2] - z0), Math.abs(p[2] - z1)));
// camera velocity (from its motion, whatever moves it: keys, flights, the tour, the benchmark), smoothed; jumps reset it
const vel = { v: [0, 0, 0], p: null };
function aheadPoint(dt) {
  const p = V.cam.p;
  if (vel.p && dt > 0) {
    const d = [0, 1, 2].map(i => (p[i] - vel.p[i]) / dt), sp = Math.hypot(...d);
    if (sp > 300000) vel.v = [0, 0, 0]; else for (let i = 0; i < 3; i++) vel.v[i] += (d[i] - vel.v[i]) * Math.min(1, dt * 5);
  }
  vel.p = p.slice();
  const L = Math.hypot(...vel.v) * LODP.look; if (L < 50) return null;
  const k = Math.min(L, 30000) / L * LODP.look;
  return [p[0] + vel.v[0] * k, p[1] + vel.v[1] * k, p[2] + vel.v[2] * k];
}
let impVersion = 0;
function invalidateImpostors() { impVersion++; }
V.invalidateImpostors = invalidateImpostors;
const impKey = () => `${V.mode}|${V.hideInc}|${impVersion}`;
const impBytes = { lo: 0, hi: 0 };
function freeImp(w) { if (!w.imp) return; gl.deleteTexture(w.imp.tex); gl.deleteFramebuffer(w.imp.fbo); impBytes[w.imp.tier] -= w.imp.bytes; w.imp = null; w.impKey = ''; }
function bake(w, budget, tier) {
  if (w.imp && w.imp.tier !== tier && w.imp.ready && !w.bk) { /* keep showing the old one until the new bake completes */ }
  if (!w.bk || w.bk.key !== impKey() || w.bk.tier !== tier) {
    const [iw, ih] = IMP[tier], bytes = w.cols * iw * ih * 4 * 1.34;
    // memory cap: drop the least recently used impostors of this tier
    const cap = tier === 'hi' ? IMP.capHi : IMP.capLo;
    while (impBytes[tier] + bytes > cap) { const c = WALLS.filter(x => x.imp && x.imp.tier === tier && x !== w).sort((a, b) => a.imp.used - b.imp.used)[0]; if (!c) break; freeImp(c); }
    const tex = G.tex2D(gl, w.cols * iw, ih, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null, gl.LINEAR_MIPMAP_LINEAR);
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, 4);
    const fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    if (w.bk && w.bk.nimp) { gl.deleteTexture(w.bk.nimp.tex); gl.deleteFramebuffer(w.bk.nimp.fbo); impBytes[w.bk.tier] -= w.bk.nimp.bytes; }
    w.bk = { key: impKey(), tier, c: 0, nimp: { tex, fbo, tier, bytes, iw, ih, ready: false, used: performance.now() } }; impBytes[tier] += bytes;
  }
  const B = w.bk, I = B.nimp;
  let c1 = B.c; const a = w.colStart[B.c];
  while (c1 < w.cols && (c1 === B.c || w.colStart[c1 + 1] - a <= budget)) c1++;
  const n = w.colStart[c1] - a;
  gl.bindFramebuffer(gl.FRAMEBUFFER, I.fbo); gl.viewport(0, 0, w.cols * I.iw, I.ih);
  gl.disable(gl.DEPTH_TEST); gl.enable(gl.SCISSOR_TEST); gl.scissor(B.c * I.iw, 0, (c1 - B.c) * I.iw, I.ih);
  gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
  if (n > 0) {
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    setupLineProg(P.line); wallUniforms(P.line, w, 0); gl.uniform1i(P.line.u.uBake, 1); gl.uniform1f(P.line.u.uBakeW, w.cols * 128);
    gl.uniform2i(P.line.u.uHi, -1, -1); gl.uniform1i(P.line.u.uBase, w.base + a); gl.uniform1f(P.line.u.uAlpha, 1);
    gl.bindVertexArray(emptyVAO); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    gl.uniform1i(P.line.u.uBake, 0);
  }
  gl.disable(gl.SCISSOR_TEST);
  B.c = c1;
  if (c1 >= w.cols) {
    gl.bindTexture(gl.TEXTURE_2D, I.tex); gl.generateMipmap(gl.TEXTURE_2D);
    if (w.imp) { gl.deleteTexture(w.imp.tex); gl.deleteFramebuffer(w.imp.fbo); impBytes[w.imp.tier] -= w.imp.bytes; }
    I.ready = true; w.imp = I; w.impKey = B.key; w.bk = null; V.stats.baked = (V.stats.baked || 0) + 1;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return n;
}

// ------------------------------------------------------------------ draw helpers
let VP, camP, camF, planes;
function bindTex(unit, target, tex, prog, name) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(target, tex); if (prog.u[name] !== undefined) gl.uniform1i(prog.u[name], unit); }
function common(prog) {
  gl.useProgram(prog.p);
  if (prog.u.uVP) gl.uniformMatrix4fv(prog.u.uVP, false, VP);
  if (prog.u.uCam) gl.uniform3fv(prog.u.uCam, camP);
  if (prog.u.uFwd) gl.uniform3fv(prog.u.uFwd, camF);
  if (prog.u.uFocal) gl.uniform1f(prog.u.uFocal, focalPx());
  if (prog.u.uAtlasM) gl.uniform4fv(prog.u.uAtlasM, ATLASM);
  bindTex(11, gl.TEXTURE_2D, wallTex, prog, 'uWallTex');
}
function setupLineProg(prog) {
  common(prog);
  bindTex(0, gl.TEXTURE_2D, prog === P.morph ? morphTex : instTex, prog, 'uInst');
  bindTex(1, gl.TEXTURE_2D, metaTex, prog, 'uMeta'); bindTex(2, gl.TEXTURE_2D, offsTex, prog, 'uOffs');
  bindTex(3, gl.TEXTURE_2D_ARRAY, textTex, prog, 'uText'); bindTex(4, gl.TEXTURE_2D, atlasTex, prog, 'uAtlas');
  bindTex(5, gl.TEXTURE_2D, palTex, prog, 'uPal'); bindTex(7, gl.TEXTURE_2D, markTex, prog, 'uMark'); bindTex(8, gl.TEXTURE_2D, possTex, prog, 'uPoss');
  gl.uniform1i(prog.u.uMode, V.mode); gl.uniform1i(prog.u.uHideInc, V.hideInc ? 1 : 0);
  gl.uniform1f(prog.u.uT0, V.quality.t0); gl.uniform1f(prog.u.uT1, V.quality.t1); gl.uniform2fv(prog.u.uLF, V.quality.lf);
  gl.uniform1i(prog.u.uBake, 0); gl.uniform1f(prog.u.uAlpha, 1);
  if (prog.u.uMorphGlyph) gl.uniform1i(prog.u.uMorphGlyph, SOFT && !Q.has('morphglyph') ? 0 : 1);
}
function wallUniforms(prog, w, x) {
  gl.uniform1i(prog.u.uBase, w.base || 0); gl.uniform1f(prog.u.uWallX, x); gl.uniform1f(prog.u.uZ0, w.z0);
  gl.uniform1i(prog.u.uLane, w.lane); gl.uniform1i(prog.u.uDom, F.frames[w.i].by_lane ? domOf(w) : 0);
  const h = V.hi && V.hi.f === w.i ? V.hi : null;
  gl.uniform2i(prog.u.uHi, h ? w.base + h.a : -1, h ? w.base + h.b : -1);
}
const domOf = w => w._dom ?? (w._dom = (() => { const m = w.meta; if (!m) return w.i; const c = new Map(); m.dom.forEach((d, k) => c.set(d, (c.get(d) || 0) + m.n[k])); return [...c].sort((a, b) => b[1] - a[1])[0]?.[0] ?? w.i; })());

// file cards (header bars, outlines, holes, path labels near, grown file-name labels further out) for the nearest solid
// walls, from the frame's file list (chunk metadata, there for every frame from the start).
// Built per wall into its own buffers (updateCards).
const baseName = p => p.slice(p.lastIndexOf('/') + 1);
function wallCards(w) {
  const sl = laneSlotsSorted[w.lane], rects = [], labels = [], m = w.meta, have = new Set();
  for (let k = 0; k < m.slot.length; k++) {
    const slot = m.slot[k]; if (slot < 0) continue; have.add(slot);
    const n = m.n[k], st = m.st[k], path = m.paths[k];
    const L0 = sl.L[slot], col = Math.floor(L0 / H), row = L0 % H, z = w.z0 + col * 128, ytop = 4096 - row * 2, sc = ST_RGB[st] || [128, 128, 128];
    const bar = mixc([20, 24, 32], sc, 0.45);
    rects.push([z, z + 120, ytop - 3.6, ytop, 0, 0, bar.concat(255), w.i, PUSH1]);
    // the card's outline (screen-space width): the file stays a recognisable tile when its lines are sub-pixel
    let p = L0, e = L0 + core.HDR + n;
    while (p < e) { const c = Math.floor(p / H), r0 = p % H, r1 = Math.min(H, r0 + (e - p));
      rects.push([w.z0 + c * 128 - 0.5, w.z0 + c * 128 + 120.5, 4096 - r1 * 2 - 0.5, 4096 - r0 * 2, 0, 0, mixc([60, 66, 80], sc, 0.35).concat(115), w.i, PUSH1 | K_OUTLINE]); p += r1 - r0; }
    const tag = `${n} lines | ${core.ST[st]}`;
    labels.push([trunc(path, Math.floor(118 / 1.25) - tag.length - 3) + '  ' + tag, z + 1, ytop - 0.3, 0, w.i, [0, 0, 1.25], [0, 1.5, 0], [235, 240, 250, 255]]);
    // grown name: as large as the card allows (width 118, height of the file's first column segment)
    const nm = baseName(path), hseg = Math.min(core.HDR + n, H - row) * 2;
    const kmax = Math.min(116 / (nm.length * 1.25), hseg / 3.4);
    if (kmax > 1.3) labels.push([nm, z + 1, ytop - 0.3, 0, w.i, [0, 0, 1.25], [0, 1.5, 0], [240, 244, 252, 255], -1, kmax, 0, [...bar, 215]]);
  }
  for (let s = 0; s < sl.L.length; s++) {   // holes: lane slots without a file in this frame
    if (have.has(s)) continue;
    const col = Math.floor(sl.L[s] / H), row = sl.L[s] % H, rows = Math.min(core.HDR + sl.cap[s], H - row);
    rects.push([w.z0 + col * 128, w.z0 + col * 128 + 120, 4096 - (row + rows) * 2, 4096 - row * 2, 0, 0, [70, 76, 92, 120], w.i, PUSH1 | K_OUTLINE]);
  }
  return { rects, labels };
}
// per-wall card buffers (rects + labels), LRU-cached; at most CARD_BUILDS new walls per frame
const cardCache = new Map(), CARD_BUILDS = SOFT ? 1 : 2, CARD_KEEP = SOFT ? 8 : 28;
let cardList = [];
function freeCards(c) {
  for (const b of [c.deco, c.labs]) { if (b.vao) gl.deleteVertexArray(b.vao); if (b.vbo) gl.deleteBuffer(b.vbo); if (b.dbuf) gl.deleteBuffer(b.dbuf); if (b.tex) gl.deleteTexture(b.tex); }
}
function updateCards(list, now) {
  let built = 0; cardList = [];
  for (const w of list) {
    let c = cardCache.get(w.i);
    if (!c) {
      if (built >= CARD_BUILDS) continue;
      const C = wallCards(w), deco = new RectBuf(true), lab = new LabelSet(false);
      for (const r of C.rects) deco.add(...r);
      for (const l of C.labels) lab.add(...l);
      deco.build(); lab.build(); built++;
      c = { w, deco, labs: lab }; cardCache.set(w.i, c);
    }
    c.used = now; cardList.push(c);
  }
  if (cardCache.size > CARD_KEEP) for (const [k, c] of [...cardCache].sort((a, b) => a[1].used - b[1].used).slice(0, cardCache.size - CARD_KEEP)) { freeCards(c); cardCache.delete(k); }
}

// ------------------------------------------------------------------ pipeline warm-up (lavapipe builds pipelines on first use)
function warmup() {
  const t0 = performance.now();
  VP = new Float32Array(16); camP = new Float32Array(3); camF = new Float32Array([1, 0, 0]); planes = [];
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height);
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.BLEND); gl.depthMask(true);
  common(P.rect); bindTex(5, gl.TEXTURE_2D, palTex, P.rect, 'uPal'); gl.uniform1f(P.rect.u.uMul, 1);
  gl.bindVertexArray(plates.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.bindVertexArray(floor.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
  gl.depthMask(false);
  common(P.imp); gl.bindVertexArray(emptyVAO); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  setupLineProg(P.line); wallUniforms(P.line, WALLS[0], 0); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
  setupLineProg(P.morph); gl.uniform1i(P.morph.u.uStride, 1); gl.uniform1i(P.morph.u.uBase, 0); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
  common(P.seg); gl.bindVertexArray(segBuf.vao); gl.drawArrays(gl.LINES, 0, 2);
  common(P.label); gl.bindVertexArray(labs.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
  gl.disable(gl.DEPTH_TEST); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
  gl.useProgram(P.title.p); gl.bindVertexArray(TT.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1); gl.enable(gl.DEPTH_TEST);
  gl.bindVertexArray(null); gl.depthMask(true);
  const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  V.load.warmupMs = performance.now() - t0;
}

// ------------------------------------------------------------------ frame
// Frame pacing. On a real GPU the browser paces rAF (vsync); WebGL fence status only updates between tasks, so skipping
// rAF ticks while fences are pending (the old scheme) dropped every other vsync: that was the ~20 ms frames at < 1.1 ms of
// GPU time on the Radeon. Now: GPU -> draw every rAF, skip only if 4+ frames are still queued (a browser without vsync);
// llvmpipe -> at most two frames in flight and ~30 fps, or the next synchronous GL call waits for seconds of queued work.
const fences = []; V.stats.skipped = 0;
function gpuBacklog() {
  while (fences.length && gl.getSyncParameter(fences[0], gl.SYNC_STATUS) === gl.SIGNALED) gl.deleteSync(fences.shift());
  return fences.length;
}
const tqRing = []; let lastT = performance.now(), hudT = 0, lastPresent = 0, wantT = 0;
const PROF = { t: 0, cur: [], worst: [] }; V.prof = PROF;
function PM(name) { const t = performance.now(); PROF.cur.push([name, +(t - PROF.t).toFixed(2)]); PROF.t = t; }
function frame(now) {
  requestAnimationFrame(frame);
  const backlog = gpuBacklog();
  if (backlog >= (SOFT ? 2 : 4)) { V.stats.skipped++; return; }
  if (SOFT && !V.bench && now - lastPresent < 30) return;
  lastPresent = now;
  const rawDt = now - lastT, dt = Math.min(0.1, rawDt / 1000); lastT = now;
  const c0 = performance.now(); PROF.t = c0; PROF.cur = [];
  V.stats.dt.push(rawDt); V.lastRawDt = rawDt; if (V.stats.dt.length > 240) V.stats.dt.shift();
  emit('tick', dt);
  if (V.playing) { V.setX(V.X + dt * V.speed * U); if (V.X >= xMax + U) V.setPlaying(false); }
  updateDisplay();
  moveCam(dt);
  const scale = V.quality.scale * (devicePixelRatio || 1);
  const cw = Math.max(1, Math.round(canvas.clientWidth * scale)), ch = Math.max(1, Math.round(canvas.clientHeight * scale));
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
  const { f, r, u } = camBasis(); camP = new Float32Array(V.cam.p); camF = new Float32Array(f);
  let nearest = 1e9;
  for (const w of dispList) { const x = wallArr[4 * w.i]; nearest = Math.min(nearest, G.boxDist(V.cam.p, x - 1, -10, w.z0, x + 1, 4600, w.z0 + w.cols * 128)); }
  const near = Math.max(1, Math.min(4000, nearest * 0.4)), far = Math.max(near * 10, 1.6e6);
  VP = G.mul(G.perspective(FOV, cw / ch, near, far), G.lookDir(V.cam.p, f)); planes = G.frustumPlanes(VP); V.VP = VP;
  let q = null;
  if (tq) { q = gl.createQuery(); gl.beginQuery(tq.TIME_ELAPSED_EXT, q); }
  PM('pre');
  // ---- LOD. The tier of a column comes from its real distance; streaming, impostor upgrades and file cards use the nearer of
  // the real distance and the distance from where the camera will be in LODP.look s (its velocity), so the walls ahead
  // are loaded, baked sharp and carded before the camera reaches them.
  const fp = focalPx(), LF = V.quality.lf, epoch = ++wantEpoch, want = [], cards = [];
  const ah = aheadPoint(dt);
  const lineRuns = [], impRuns = [], t3Walls = [], bakeCand = [], lineWalls = new Set(), hiNext = [];
  let inst = 0;
  const morphB = V.morph ? V.morph.b : -1;
  occList = []; visList = [];
  for (const w of dispList) {
    const x = wallArr[4 * w.i], A = wallArr[4 * w.i + 1], solid = wallArr[4 * w.i + 2] > 0.5, z1 = w.z0 + w.cols * 128;
    if (!G.boxVisible(planes, x - 1, -10, w.z0, x + 1, 4110, z1)) continue;
    visList.push(w);
    if (V.cam.p[0] > x) continue;
    if (solid) occList.push(w);
    const dW = G.boxDist(V.cam.p, x, 0, w.z0, x, 4096, z1), pW = 2 * fp / Math.max(dW, 1);
    const dE = ah ? Math.min(dW, G.boxDist(ah, x, 0, w.z0, x, 4096, z1)) : dW, pE = 2 * fp / Math.max(dE, 1);
    if (solid && pE >= LODP.want) want.push([dE, w]);
    if (solid && pE >= LODP.card && w.meta) cards.push([dE, w]);
    if (w.loaded) w.lastUse = now;
    if (IMP.hi && w.loaded && pE > LODP.hi) hiNext.push([dE, w.i]);
    const stale = w.loaded && (w.impKey !== impKey() || (hiSet.has(w.i) && (!w.imp || w.imp.tier !== 'hi')));
    if (!solid) { if (w.imp && w.imp.ready) impRuns.push([w, 0, w.cols, A, 0]); else t3Walls.push(w); continue; }
    if (!w.loaded || pW < LF[0]) { if (w.imp && w.imp.ready) impRuns.push([w, 0, w.cols, A, 0]); else t3Walls.push(w); if (stale && pE >= LODP.t4) bakeCand.push([dE, w, pE]); continue; }
    if (w.i === morphB) continue;
    let run = null, irun = null;
    for (let c = 0; c < w.cols; c++) {
      const za = w.z0 + c * 128, zb = za + 124;
      if (!G.boxVisible(planes, x - 1, -10, za, x + 1, 4110, zb)) { run = irun = null; continue; }
      const d = G.boxDist(V.cam.p, x, 0, za, x, 4096, zb), ppl = 2 * fp / Math.max(d, 1);
      // lines fade in over the ppl band LF (per pixel); the impostor fades out under them over the same band
      const lines = ppl >= LF[0], imp = !lines || 2 * fp / boxFar(V.cam.p, x, 0, za, x, 4096, zb) < LF[1];
      if (lines) { if (run && run[2] === c) run[2] = c + 1; else { run = [w, c, c + 1, d]; lineRuns.push(run); } run[3] = Math.min(run[3], d); } else run = null;
      if (imp) { if (irun && irun[2] === c) irun[2] = c + 1; else { irun = [w, c, c + 1, 1, 1]; impRuns.push(irun); } } else irun = null;
    }
    if (stale) bakeCand.push([dE, w, pE]);
  }
  // sharp impostors for the nearest LODP.hiN walls in range (next frame): more would evict and re-bake each other
  hiNext.sort((a, b) => a[0] - b[0]); hiSet = new Set(hiNext.slice(0, LODP.hiN).map(h => h[1]));
  // morph target lane: its next frames are wanted too
  for (const L of live) if (L.morph) { want.push([0, W[L.morph.a]], [0, W[L.morph.b]]); }
  lineRuns.sort((a, b) => a[3] - b[3]);
  const drawRuns = [];
  for (const rr of lineRuns) { const w = rr[0], n = w.colStart[rr[2]] - w.colStart[rr[1]]; if (n === 0) continue;
    if (inst + n > V.quality.maxInst && drawRuns.length) { impRuns.push([w, rr[1], rr[2], 1, 0]); continue; } inst += n; drawRuns.push(rr); lineWalls.add(w); }
  // streaming: the wanted walls, nearest first (sent a few times a second; the worker keeps only the newest list)
  want.sort((a, b) => a[0] - b[0]);
  // nearest first, as many as the instance pool holds (more would evict each other and be decoded again and again)
  const wl = []; let poolRows = POOLH * 0.92;
  for (const [d, w] of want) { if (w.wanted === epoch) continue; poolRows -= Math.max(1, Math.ceil(w.n / POOLW)); if (poolRows < 0 && d > 0) break;
    w.wantD = d; w.wanted = epoch; if (!w.loaded) wl.push(w.i); }
  for (const w of WALLS) if (w.wanted === epoch - 1) w.wanted = epoch;   // keep last frame's set while it settles
  if (now - wantT > 200) { wantT = now; fw.postMessage({ type: 'want', frames: wl.slice(0, SOFT ? 12 : 40) }); }
  const t4Walls = [], t5Walls = [];
  for (let i = t3Walls.length - 1; i >= 0; i--) { const w = t3Walls[i], p = pWOf(w);
    if (p < LODP.t5) { t5Walls.push(w); t3Walls.splice(i, 1); wallArr[4 * w.i + 3] = 3; }
    else if (p < LODP.t4) { t4Walls.push(w); t3Walls.splice(i, 1); wallArr[4 * w.i + 3] = 2; } else wallArr[4 * w.i + 3] = 1; }
  uploadWallTex();
  PM('lod');
  bakeCand.sort((a, b) => a[0] - b[0]);
  let bakeBudget = SOFT ? 40000 : 1200000;
  for (let i = 0; i < bakeCand.length && bakeBudget > 0; i++) { const [, w, pW] = bakeCand[i]; bakeBudget -= Math.max(1, bake(w, bakeBudget, hiSet.has(w.i) ? 'hi' : 'lo')); }
  V.stats.pendingBake = bakeCand.length;
  cards.sort((a, b) => a[0] - b[0]);
  updateCards(cards.slice(0, LODP.cards).map(c => c[1]), now);
  PM('bake');
  // ---- draw
  gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, cw, ch);
  gl.clearColor(0.043, 0.051, 0.071, 1); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.disable(gl.BLEND); gl.depthMask(true);
  let draws = 0;
  common(P.rect); bindTex(5, gl.TEXTURE_2D, palTex, P.rect, 'uPal'); gl.uniform1i(P.rect.u.uMode, V.mode); gl.uniform1f(P.rect.u.uMul, 1);
  if (!V.skip.has('plates')) {   // solid walls: opaque plates (depth)
    gl.bindVertexArray(plates.vao);
    for (const w of visList) { if (!V.isSolid(w) || wallArr[4 * w.i + 3] === 3) continue; const [a, n] = plateRange.get(w.i); plates.bind(a); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n); draws++; }
  }
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
  if (!V.skip.has('floor')) { gl.bindVertexArray(floor.vao); floor.bind(0); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, floor.n); draws++;
    gl.bindVertexArray(pinsR.vao); pinsR.bind(0); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, pinsR.n); draws++; }
  const drawRanges = (buf, ranges, list, all) => { if (!list.length || !buf.n) return; gl.bindVertexArray(buf.vao);
    if (list.length > all) { buf.bind(0); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, buf.n); draws++; return; }
    for (const w of list) { const rg = ranges.get(w.i); if (!rg || !rg[1]) continue; buf.bind(rg[0]); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, rg[1]); draws++; } };
  if (!V.skip.has('t3')) { drawRanges(t3, t3Range, t3Walls, 300); drawRanges(t4, t4Range, t4Walls, 300); drawRanges(t5, t5Range, t5Walls, 120); }
  PM('plates');
  if (impRuns.length && !V.skip.has('imp')) { common(P.imp); gl.bindVertexArray(emptyVAO);
    for (const [w, c0, c1, A, fl] of impRuns) {
      if (!w.imp || !w.imp.ready) continue; w.imp.used = now;
      bindTex(0, gl.TEXTURE_2D, w.imp.tex, P.imp, 'uImp'); gl.uniform1f(P.imp.u.uFade, A); gl.uniform2fv(P.imp.u.uLF, fl ? LF : NOFADE);
      gl.uniform1f(P.imp.u.uWallX, wallArr[4 * w.i]); gl.uniform1f(P.imp.u.uZ0, w.z0); gl.uniform1f(P.imp.u.uC0, c0); gl.uniform1f(P.imp.u.uC1, c1); gl.uniform1f(P.imp.u.uCols, w.cols);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); draws++; } }
  PM('imp');
  if (drawRuns.length) { setupLineProg(P.line); gl.bindVertexArray(emptyVAO);
    let cur = null;
    for (const [w, c0, c1] of drawRuns) {
      if (cur !== w) { wallUniforms(P.line, w, wallArr[4 * w.i]); cur = w; }
      const a = w.colStart[c0], n = w.colStart[c1] - a;
      gl.uniform1i(P.line.u.uBase, w.base + a); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n); draws++; } }
  PM('lines');
  // the live morph of the nearest lane (the other lanes show their arriving frame); far away it is the arriving frame's T3 / impostor
  for (const M of V.morph ? [V.morph] : []) {
    const wb = W[M.b], x = wallArr[4 * M.b], pW = pWOf(wb);
    if (V.cam.p[0] > x || !G.boxVisible(planes, x - 1, -10, wb.z0, x + 1, 4400, wb.z0 + wb.cols * 128)) continue;
    if (pW < LF[0]) continue;   // far: the LOD pass drew the arriving frame's impostor / T3
    const m = M.m;
    if (m.inst.length / 4 > MORPHW * MORPHH) continue;
    if (morphOnGPU !== m.key) { G.uploadLinear(gl, morphTex, MORPHW, 0, m.inst, 4, gl.RGBA_INTEGER, gl.UNSIGNED_INT); morphOnGPU = m.key; }
    setupLineProg(P.morph); gl.bindVertexArray(emptyVAO);
    wallUniforms(P.morph, wb, x); gl.uniform1f(P.morph.u.uMorphT, M.u); gl.uniform2i(P.morph.u.uHi, -1, -1); gl.uniform2fv(P.morph.u.uLF, NOFADE);
    const stride = V.morphStride; gl.uniform1i(P.morph.u.uStride, stride);
    const draw = (starts) => {
      let run = -1;
      const flush = c1 => { const a = starts[run], n = Math.floor((starts[c1] - a) / stride); if (n > 0) { gl.uniform1i(P.morph.u.uBase, a); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n); draws++; inst += n; } run = -1; };
      for (let c = 0; c < wb.cols; c++) {
        const za = wb.z0 + (c - 1) * 128, zb = wb.z0 + (c + 2) * 128;
        const vis = G.boxVisible(planes, x - 1, -10, za, x + 1, 4400, zb) && 2 * fp / Math.max(1, G.boxDist(V.cam.p, x, 0, za, x, 4096, zb)) >= LF[0];
        if (vis && run < 0) run = c; else if (!vis && run >= 0) flush(c);
      }
      if (run >= 0) flush(wb.cols);
    };
    draw(m.colB); if (V.morphRemoved) draw(m.colA);
  }
  PM('morph');
  if (cardList.length && !V.skip.has('deco')) { common(P.rect); bindTex(5, gl.TEXTURE_2D, palTex, P.rect, 'uPal'); gl.uniform1f(P.rect.u.uMul, 1);
    for (const c of cardList) if (c.deco.n) { gl.bindVertexArray(c.deco.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, c.deco.n); draws++; } }
  if (!V.skip.has('segs')) { common(P.seg); gl.bindVertexArray(segBuf.vao); gl.drawArrays(gl.LINES, 0, segBuf.n); draws++; }
  PM('segs');
  common(P.label); bindTex(4, gl.TEXTURE_2D, atlasTex, P.label, 'uAtlas');
  gl.uniform3fv(P.label.u.uRight, r); gl.uniform3fv(P.label.u.uUp, u);
  const kpx = cw / Math.max(1, canvas.clientWidth);
  if (cardList.length && !V.skip.has('deco')) {   // file cards: path labels from 12 CSS px per line of text, grown names below that
    gl.uniform1f(P.label.u.uMinPx, Math.max(SOFT ? 6 : 5, 7 * kpx)); gl.uniform1f(P.label.u.uMinFade, 1.3); gl.uniform1f(P.label.u.uCardPx, Math.max(SOFT ? 8 : 7, 12 * kpx));
    for (const c of cardList) if (c.labs.n) { bindTex(9, gl.TEXTURE_2D, c.labs.tex, P.label, 'uLab'); gl.bindVertexArray(c.labs.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, c.labs.n); draws++; } }
  gl.uniform1f(P.label.u.uMinPx, SOFT ? 8 : 5); gl.uniform1f(P.label.u.uMinFade, 1.6); gl.uniform1f(P.label.u.uCardPx, 0);
  PM('cards');
  if (!V.skip.has('titles')) layoutTitles(dt);
  PM('titles');
  if (!V.skip.has('labels')) {
    declutter(dt, r, u, SOFT ? 8 : 5);
    gl.disable(gl.DEPTH_TEST); bindTex(9, gl.TEXTURE_2D, labs.tex, P.label, 'uLab'); gl.bindVertexArray(labs.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, labs.n); draws++; gl.enable(gl.DEPTH_TEST); }
  if (!V.skip.has('titles') && TT.shown + TT.cur.some(v => v > 0)) {   // wall titles: one draw, screen space, over everything
    gl.disable(gl.DEPTH_TEST); gl.useProgram(P.title.p); gl.uniform2f(P.title.u.uView, cw, ch); gl.uniform4fv(P.title.u.uAtlasM, ATLASM);
    bindTex(4, gl.TEXTURE_2D, atlasTex, P.title, 'uAtlas'); bindTex(9, gl.TEXTURE_2D, TT.tex, P.title, 'uLab');
    gl.bindVertexArray(TT.vao); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, TT.n); draws++; gl.enable(gl.DEPTH_TEST); }
  gl.bindVertexArray(null); gl.depthMask(true);
  PM('labels');
  if (q) { gl.endQuery(tq.TIME_ELAPSED_EXT); tqRing.push(q); }
  fences.push(gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)); gl.flush();
  while (tqRing.length && gl.getQueryParameter(tqRing[0], gl.QUERY_RESULT_AVAILABLE)) {
    const qq = tqRing.shift(); if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) { V.stats.gpu.push(gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6); V.stats.gpuN = (V.stats.gpuN || 0) + 1; if (V.stats.gpu.length > 240) V.stats.gpu.shift(); } gl.deleteQuery(qq); }
  if (tqRing.length > 8) gl.deleteQuery(tqRing.shift());
  const cpu = performance.now() - c0;
  if (cpu > 30) { PROF.worst.push([+cpu.toFixed(1), PROF.cur.filter(x => x[1] > 2)]); PROF.worst.sort((a, b) => b[0] - a[0]); PROF.worst.length = Math.min(PROF.worst.length, 12); }
  V.stats.cpu.push(cpu); if (V.stats.cpu.length > 240) V.stats.cpu.shift();
  Object.assign(V.stats, { draws, inst, imp: impRuns.length, t3: t3Walls.length, t4: t4Walls.length, t5: t5Walls.length, lineRuns: drawRuns.length, gpuBytes: gpuBytes + impBytes.lo + impBytes.hi, visibleWalls: dispList.length, wantQueue: wl.length });
  V.stats.frames++;
  if (!V.load.firstFrame) { V.load.firstFrame = performance.now() - t0Boot; setLoading(''); }
  adapt();
  emit('frame', { dt, cpu, rawDt });
  if (now - hudT > 250) { hudT = now; emit('hud'); }
}
// adaptive quality: glyph / token thresholds (px per line) and canvas scale
// lf: the px-per-line band where a column's lines fade in over its impostor (lines are drawn from lf[0])
const STEPS = SOFT ? [{ t0: 8, t1: 2.2, lf: [1, 1.4], scale: 0.5, maxInst: 220000 }, { t0: 9, t1: 2.4, lf: [1.1, 1.5], scale: 0.5, maxInst: 200000 }, { t0: 11, t1: 3, lf: [1.3, 1.8], scale: 0.45, maxInst: 160000 },
  { t0: 13, t1: 3.5, lf: [1.6, 2.2], scale: 0.4, maxInst: 120000 }, { t0: 16, t1: 4, lf: [1.8, 2.5], scale: 0.33, maxInst: 90000 }] :
  [{ t0: 3.8, t1: 1, lf: [0.28, 0.45], scale: 1, maxInst: 3e6 }, { t0: 4.5, t1: 1.3, lf: [0.4, 0.6], scale: 1, maxInst: 2.5e6 }, { t0: 5.5, t1: 1.6, lf: [0.5, 0.8], scale: 1, maxInst: 2e6 },
   { t0: 7, t1: 2, lf: [0.65, 1], scale: 1, maxInst: 1.5e6 }, { t0: 7, t1: 2, lf: [0.65, 1], scale: 0.85, maxInst: 1.2e6 }, { t0: 8, t1: 2.4, lf: [0.8, 1.2], scale: 0.7, maxInst: 1e6 }];
function p90(a) { if (!a.length) return 0; const s = a.slice(-30).sort((x, y) => x - y); return s[Math.floor(s.length * 0.9)]; }
let adaptN = 0;
V.morphStride = SOFT ? 2 : 1; V.morphRemoved = true;
function adapt() {
  if (V.fixedQuality || ++adaptN % (SOFT ? 8 : 30)) return;
  const g = !SOFT && V.stats.gpu.length ? p90(V.stats.gpu) : p90(V.stats.dt) * 0.8;   // GPU: GPU time (presentation is the browser's); llvmpipe: frame time
  if (V.morph) {
    if (g > (SOFT ? 70 : 10) && V.morphStride < 8) V.morphStride *= 2;
    else if (g > (SOFT ? 70 : 10)) V.morphRemoved = false;
    else if (g < (SOFT ? 40 : 5) && (V.morphStride > (SOFT ? 2 : 1) || !V.morphRemoved)) { if (!V.morphRemoved) V.morphRemoved = true; else V.morphStride /= 2; }
  }
  const hi = SOFT ? 60 : 9, lo = SOFT ? 40 : 4.5; let s = V.quality.step;
  if (g > hi && s < STEPS.length - 1) s++; else if (g < lo && s > 0) s--;
  if (s !== V.quality.step) V.setQualityStep(s);
}
V.setQualityStep = s => { V.quality.step = s; Object.assign(V.quality, STEPS[s]); };
V.setQualityStep(0);
if (Q.has('scale')) { V.quality.scale = +Q.get('scale'); V.fixedQuality = true; }
if (Q.has('t0')) { V.quality.t0 = +Q.get('t0'); V.fixedQuality = true; }

// ------------------------------------------------------------------ picking (analytic)
V.pick = (mx, my) => {
  const { f, r, u } = camBasis(), th = Math.tan(FOV / 2), asp = canvas.clientWidth / canvas.clientHeight;
  const nx = (mx / canvas.clientWidth) * 2 - 1, ny = 1 - (my / canvas.clientHeight) * 2;
  const d = G.norm([0, 1, 2].map(i => f[i] + r[i] * nx * th * asp + u[i] * ny * th));
  const o = V.cam.p; let best = null;
  for (const w of dispList) {
    if (!V.isSolid(w) || Math.abs(d[0]) < 1e-9) continue;
    const x = wallArr[4 * w.i]; if (o[0] > x) continue;
    const t = (x - o[0]) / d[0]; if (t <= 0 || (best && t >= best.t)) continue;
    const y = o[1] + t * d[1], z = o[2] + t * d[2];
    if (y < 0 || y > 4096 || z < w.z0 || z >= w.z0 + w.cols * 128) continue;
    best = { t, w, y, z };
  }
  if (!best) return null;
  const w = best.w, col = Math.floor((best.z - w.z0) / 128), zl = best.z - w.z0 - col * 128, row = Math.floor((4096 - best.y) / 2);
  const Pp = col * H + row, sl = laneSlotsSorted[w.lane];
  const res = { f: w.i, w, col, row, zl, char: Math.floor(zl), dist: best.t };
  // slot containing Pp (slots do not overlap; linear scan is fine for a click)
  let s = -1; for (let i = 0; i < sl.L.length; i++) if (sl.L[i] <= Pp && Pp < sl.L[i] + core.HDR + sl.cap[i] && (s < 0 || sl.L[i] > sl.L[s])) s = i;
  if (s < 0 || zl > 124) return { ...res, kind: 'empty' };
  res.slot = s;
  if (!w.loaded) { const m = w.meta; if (m) { const k = [...m.slot].indexOf(s); if (k >= 0) { res.path = m.paths[k]; res.n = m.n[k]; res.ident = m.ident[k]; } } return { ...res, kind: res.path ? 'unloaded' : 'hole' }; }
  const k = w.slotToFile.get(s);
  if (k === undefined) return { ...res, kind: 'hole' };
  res.k = k; res.path = w.paths[k]; res.ident = w.fileIdent[k]; res.n = w.fileStart[k + 1] - w.fileStart[k]; res.st = core.ST[w.fst[k]];
  if (Pp < sl.L[s] + core.HDR) return { ...res, kind: 'header' };
  const l = Pp - sl.L[s] - core.HDR; if (l >= res.n) return { ...res, kind: 'filegap' };
  res.line = l + 1; res.kind = 'line';
  const j = w.fileStart[k] + l; res.j = j; const w0 = w.inst[2 * j], w1 = w.inst[2 * j + 1];
  res.id = w0 & 0xFFFFF; res.origin = (w0 >>> 20) & 511; res.flags = w0 >>> 29; res.keep = (w1 >>> 20) & 511;
  return res;
};
// line index (1-based) of the first line of file k in wall w whose text contains grep
V.findLine = async (w, k, grep) => {
  if (!w.loaded) return 0;
  const a = w.fileStart[k], b = w.fileStart[k + 1], ids = []; for (let j = a; j < b; j++) ids.push(w.inst[2 * j] & 0xFFFFF);
  const t = await V.lineText(ids); const i = t.findIndex(x => x && x.includes(grep)); return i >= 0 ? i + 1 : 0;
};
// load a wall now (for views / tours): resolves when its lines are on the GPU
V.ensureWall = (f, timeout = 30000) => new Promise(res => {
  const w = W[f]; if (!w) return res(null); if (w.loaded) return res(w);
  const t0 = performance.now();
  const chk = () => { if (w.loaded || performance.now() - t0 > timeout) { off('wall', chk2); res(w.loaded ? w : null); } };
  const chk2 = () => chk();
  on('wall', chk2); fw.postMessage({ type: 'want', frames: [f] }); setTimeout(chk, timeout + 10);
});
V.whenReady = (opts = {}) => new Promise(res => {
  const t0 = performance.now(), f0 = V.stats.frames;
  const check = () => {
    const baked = !V.stats.pendingBake || opts.noBake;
    const ok = V.load.meta && V.load.text >= Math.min(F.text_chunks, opts.text ?? F.text_chunks) && (V.stats.wantQueue === 0 || opts.noWalls) && baked && (!opts.morph || V.morph) && V.stats.frames > f0 + 4;
    if (ok || performance.now() - t0 > (opts.timeout || 60000)) res(performance.now() - t0); else setTimeout(check, 100);
  };
  check();
});
V.toast = (s, ms = 2500) => { const e = document.getElementById('toast'); if (!e) return; e.textContent = s; e.classList.remove('hidden'); clearTimeout(V._toastT); V._toastT = setTimeout(() => e.classList.add('hidden'), ms); };

// ------------------------------------------------------------------ start
updateDisplay();
setLoading('preparing shaders…'); warmup();
initUI(V);
if (!V.restoreHash || !V.restoreHash()) {
  const w = WALLS.find(w => w.fr.lane === 'nullDC' && w.fr.date >= '2011-09') || WALLS[0];
  V.X = w.x + 1; const v = V.fitWall(w); V.cam.p = v.p; setLook(v.dir);
}
emit('time');
{ // text chunks: in order of the time at the camera (chunks follow first appearance in time)
  const near = Math.max(0, F.frames.findIndex(fr => fr.date >= V.dateOfX(V.X)));
  const order = [...Array(F.text_chunks).keys()], c0 = near / NF * F.text_chunks;
  order.sort((a, b) => Math.abs(a - c0) - Math.abs(b - c0));
  tw.postMessage({ type: 'init', F: { chunk_lines: F.chunk_lines, raw_lines: F.raw_lines, text_chunks: F.text_chunks }, order });
}
V._hashReady = true;
initBench(V); initAttract(V); initScore(V);
requestAnimationFrame(frame);
window.viewer = V;
