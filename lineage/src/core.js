// core.js: pure data logic for the frame data (format 2, agents/frames/FORMAT.md), shared by the decode worker and
// Node checks (no DOM, no GL).
export const H = 2048, HDR = 2, GAP = 2, TEXMAX = 124, COLP = 128;
export const F_INC = 1, F_ADD = 2;                 // instance flags (2 bits at w1 >> 30)
export const M_KEPT = 0, M_ADDED = 1, M_REMOVED = 2;
export const TRIV = 2047;                          // keep value of trivial lines (blank, brackets); keeps are 11 bits
export const ST = ['same', 'new', 'edit', 'move', 'move+edit', 'copy', 'import'];
export const stCode = s => Math.max(0, ST.indexOf(s));

// ---- folding (identical to tools/viewer_prep.py fold) ----
// tab -> next multiple of 4, < 0x20 -> space, one 0x7F per non-ASCII code point. Writes at most `max` bytes to out[o..];
// returns the full folded length.
export function foldInto(src, a, b, out, o, max) {
  let n = 0, prevhi = false;
  for (let i = a; i < b; i++) {
    const x = src[i];
    if (x === 9) { const k = 4 - (n & 3); for (let j = 0; j < k; j++) { if (n < max) out[o + n] = 32; n++; } prevhi = false; }
    else if (x < 0x20) { if (n < max) out[o + n] = 32; n++; prevhi = false; }
    else if (x < 0x80) { if (n < max) out[o + n] = x; n++; prevhi = false; }
    else { if (!(x <= 0xBF && prevhi)) { if (n < max) out[o + n] = 0x7F; n++; } prevhi = true; }
  }
  return n;
}

// ---- lane slots: identity -> slot (linear position L = col * H + row, cap = longest version) ----
export function laneSlots(lane) {
  const byIdent = new Map(), L = new Uint32Array(lane.slots.length), cap = new Uint32Array(lane.slots.length);
  lane.slots.forEach(([id, , col, row, c], i) => { byIdent.set(id, i); L[i] = col * H + row; cap[i] = c; });
  return { byIdent, L, cap };
}

// ---- chunk decoding ----
// returns per frame: { f, key, ops, script: Uint32Array, line: Uint32Array, origin: Uint16Array, keep: Uint16Array }
export function decodeChunk(json, bin) {
  const out = [];
  for (const fr of json.frames) {
    const nw = fr.nw, nl = fr.nl, buf = bin.buffer, b0 = bin.byteOffset + fr.off;
    const script = new Uint32Array(buf.slice(b0, b0 + 4 * nw));
    const line = new Uint32Array(buf.slice(b0 + 4 * nw, b0 + 4 * nw + 4 * nl));
    const oo = b0 + 4 * nw + 4 * nl;
    const origin = new Uint16Array(buf.slice(oo, oo + 2 * nl));
    const ko = oo + 2 * nl;   // keep follows origin directly (tools/provenance/frames.cpp writes no padding)
    const keep = new Uint16Array(buf.slice(ko, ko + 2 * nl));
    out.push({ f: fr.f, key: !!fr.key, ops: fr.ops, script, line, origin, keep });
  }
  return out;
}

// per-frame file lists from the chunk JSON alone (no lines): for T3 quads, header bars, holes
// state: Map ident -> {n, st, dom, path}; returns the state after applying the frame
export function applyMeta(state, fr) {
  const s2 = new Map();
  if (!fr.key) for (const [k, v] of state) s2.set(k, v.st === 0 ? v : { ...v, st: 0 });
  for (const op of fr.ops) {
    if (op[0] === 'D') { s2.delete(op[1]); continue; }
    s2.set(op[1], { n: op[3], st: stCode(op[4]), dom: op[5], path: op[2] });
  }
  return s2;
}

// ---- lane state with lines ----
// file: { ids: Uint32Array, og: Uint16Array, kp: Uint16Array, add: Uint8Array|null (inserted in this frame), path, st, dom }
// prev: the state of the lane's previous frame (or null when unknown / the lane's first frame)
export function applyFrame(prev, fr) {
  const state = new Map();
  if (!fr.key && prev) for (const [k, v] of prev) state.set(k, v.add || v.st !== 0 ? { ...v, add: null, st: 0 } : v);
  let sw = 0, li = 0;
  for (const op of fr.ops) {
    const [kind, ident, path, n] = op;
    if (kind === 'D') { state.delete(ident); continue; }
    const st = stCode(op[4]), dom = op[5], ns = op[10], ni = op[11];
    if (kind === 'K' || kind === 'A') {
      const f = { ids: fr.line.slice(li, li + ni), og: fr.origin.slice(li, li + ni), kp: fr.keep.slice(li, li + ni), add: null, path, st, dom };
      if (kind === 'A') f.add = new Uint8Array(ni).fill(1);
      else if (prev && prev.has(ident)) { const o = prev.get(ident); f.add = o.ids.length === ni && o.ids.every((x, i) => x === f.ids[i]) ? null : diffAdd(o.ids, f.ids); if (!f.add) f.st = 0; }
      else if (prev) f.add = new Uint8Array(ni).fill(1);
      state.set(ident, f); li += ni; sw += ns; continue;
    }
    // E: edit script against the previous version
    const old = prev && prev.get(ident);
    const ids = new Uint32Array(n), og = new Uint16Array(n), kp = new Uint16Array(n), add = new Uint8Array(n);
    let a = 0, b = 0;
    for (let s = 0; s < ns; s++) {
      const w = fr.script[sw + s], opc = w >>> 30, c = w & 0x3FFFFFFF;
      if (opc === 0) { if (old) { ids.set(old.ids.subarray(a, a + c), b); og.set(old.og.subarray(a, a + c), b); kp.set(old.kp.subarray(a, a + c), b); } a += c; b += c; }
      else if (opc === 1) a += c;
      else { ids.set(fr.line.subarray(li, li + c), b); og.set(fr.origin.subarray(li, li + c), b); kp.set(fr.keep.subarray(li, li + c), b); add.fill(1, b, b + c); li += c; b += c; }
    }
    sw += ns;
    state.set(ident, { ids, og, kp, add, path, st, dom });
  }
  state.f = fr.f;
  return state;
}
// lines of b not matched (multiset by id) in a
function diffAdd(a, b) {
  const cnt = new Map(); for (const x of a) cnt.set(x, (cnt.get(x) || 0) + 1);
  const add = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) { const c = cnt.get(b[i]) || 0; if (c > 0) cnt.set(b[i], c - 1); else add[i] = 1; }
  return add;
}

// ---- relatedness (incidental matches): origin frame o counts as related for a wall of lane li ----
export function relatedMask(F, li) {
  const laneIdx = new Map(F.lanes.map((l, i) => [l.name, i]));
  const anc = F.lanes[li].anc, m = new Uint8Array(F.frames.length);
  const nulldc = laneIdx.get('nullDC'), nulldce = laneIdx.get('nullDCe'), dc4 = laneIdx.get('dc4ever');
  const fam = anc.some(([l]) => l === nulldc || l === nulldce);
  for (const fr of F.frames) {
    if (fr.virtual) { m[fr.i] = fam ? 1 : 0; continue; }
    const l = laneIdx.get(fr.lane);
    for (const [al, cut] of anc) if (al === l && (cut < 0 || fr.i <= cut)) { m[fr.i] = 1; break; }
    if (fam && l === dc4) m[fr.i] = 1;
  }
  return m;
}

// ---- wall instances: RG32UI per line, sorted by linear position ----
// w0 = id (20) | origin (11) << 20 | keep bit 10 << 31 ; w1 = col (9) | row (11) << 9 | keep bits 0-9 << 20 | flags (2) << 30
// (origin = frame index and keep = frames: 11 bits each, up to 2047 frames; keep 2047 = trivial)
export function buildWall(state, slots, cols, related, runMin = 3) {
  const files = [];
  for (const [ident, f] of state) { const s = slots.byIdent.get(ident); if (s === undefined) throw new Error('no slot for identity ' + ident); files.push([slots.L[s], ident, f, s]); }
  files.sort((a, b) => a[0] - b[0]);
  let n = 0; for (const x of files) n += x[2].ids.length;
  const nf = files.length;
  const inst = new Uint32Array(2 * n), fileStart = new Uint32Array(nf + 1), fileSlot = new Int32Array(nf), fileIdent = new Int32Array(nf);
  const paths = [], fst = new Uint8Array(nf), fdom = new Uint16Array(nf);
  let j = 0;
  files.forEach(([L0, ident, f, s], k) => {
    fileStart[k] = j; fileSlot[k] = s; fileIdent[k] = ident; paths.push(f.path); fst[k] = f.st; fdom[k] = f.dom;
    const base = L0 + HDR, nn = f.ids.length, j0 = j;
    for (let l = 0; l < nn; l++) {
      const P = base + l, col = (P / H) | 0, row = P % H, kp = f.kp[l];
      const flags = (f.add && f.add[l] ? F_ADD : 0);
      const k11 = kp === 0xFFFF ? TRIV : Math.min(TRIV - 1, kp);
      inst[2 * j] = ((f.ids[l] & 0xFFFFF) | ((f.og[l] & 2047) << 20) | ((k11 >> 10) << 31)) >>> 0;
      inst[2 * j + 1] = ((col & 511) | ((row & 2047) << 9) | ((k11 & 1023) << 20) | (flags << 30)) >>> 0;
      j++;
    }
    let a = -1;   // incidental: unrelated-origin runs shorter than runMin
    for (let l = 0; l <= nn; l++) {
      const un = l < nn && f.kp[l] !== 0xFFFF && !related[f.og[l]];
      if (un && a < 0) a = l;
      if (!un && a >= 0) { if (l - a < runMin) for (let q = a; q < l; q++) inst[2 * (j0 + q) + 1] = (inst[2 * (j0 + q) + 1] | (F_INC << 30)) >>> 0; a = -1; }
    }
  });
  fileStart[nf] = n;
  const colStart = new Uint32Array(cols + 1);
  { let c = 0; for (let i = 0; i < n; i++) { const col = inst[2 * i + 1] & 511; while (c <= col) colStart[c++] = i; } while (c <= cols) colStart[c++] = n; }
  return { n, inst, colStart, fileStart, fileSlot, fileIdent, paths, fst, fdom };
}

// ---- morph a -> b within one lane (slots are per identity, so kept lines only move within their slot) ----
// RGBA32UI: x = w0, y = posB | kind << 20 | seed << 22, z = posA, w = keep ; pos = col (9) | row (11) << 9
export function buildMorph(sa, sb, slots) {
  let cap = 0; for (const f of sb.values()) cap += f.ids.length; if (sa) for (const f of sa.values()) cap += f.ids.length;
  const out = new Uint32Array(4 * cap); let m = 0;
  const pos = (s, l) => { const P = slots.L[s] + HDR + l; return (((P / H) | 0) & 511) | ((P % H) << 9); };
  const seed = p => (Math.imul(p ^ 0x9E3779B9, 0x85EBCA6B) >>> 24) & 0xFF;
  const push = (id, og, kp, pb, pa, kind) => { const o = 4 * m++;
    out[o] = ((id & 0xFFFFF) | ((og & 2047) << 20)) >>> 0; out[o + 1] = ((pb & 0xFFFFF) | (kind << 20) | (seed(kind === M_REMOVED ? pa : pb) << 22)) >>> 0;
    out[o + 2] = pa; out[o + 3] = kp === 0xFFFF ? TRIV : Math.min(TRIV - 1, kp); };
  let kept = 0, added = 0, removed = 0;
  for (const [ident, fb] of sb) {
    const s = slots.byIdent.get(ident), fa = sa ? sa.get(ident) : null;
    if (!fa) { for (let l = 0; l < fb.ids.length; l++) push(fb.ids[l], fb.og[l], fb.kp[l], pos(s, l), 0, M_ADDED); added += fb.ids.length; continue; }
    if (!fb.add && fa.ids.length === fb.ids.length) {   // unchanged
      for (let l = 0; l < fb.ids.length; l++) { const p = pos(s, l); push(fb.ids[l], fb.og[l], fb.kp[l], p, p, M_KEPT); } kept += fb.ids.length; continue;
    }
    // pair by id in order; lines the edit script inserted (fb.add) are never paired
    const q = new Map(); for (let l = 0; l < fa.ids.length; l++) { let v = q.get(fa.ids[l]); if (!v) q.set(fa.ids[l], v = []); v.push(l); }
    const used = new Uint8Array(fa.ids.length), ptr = new Map();
    for (let l = 0; l < fb.ids.length; l++) {
      let la = -1;
      if (!(fb.add && fb.add[l])) { const v = q.get(fb.ids[l]); if (v) { const p = ptr.get(fb.ids[l]) || 0; if (p < v.length) { la = v[p]; used[la] = 1; ptr.set(fb.ids[l], p + 1); } } }
      if (la >= 0) { push(fb.ids[l], fb.og[l], fb.kp[l], pos(s, l), pos(s, la), M_KEPT); kept++; }
      else { push(fb.ids[l], fb.og[l], fb.kp[l], pos(s, l), 0, M_ADDED); added++; }
    }
    for (let l = 0; l < fa.ids.length; l++) if (!used[l]) { push(fa.ids[l], fa.og[l], fa.kp[l], 0, pos(s, l), M_REMOVED); removed++; }
  }
  if (sa) for (const [ident, fa] of sa) {
    if (sb.has(ident)) continue; const s = slots.byIdent.get(ident); if (s === undefined) continue;
    for (let l = 0; l < fa.ids.length; l++) push(fa.ids[l], fa.og[l], fa.kp[l], 0, pos(s, l), M_REMOVED); removed += fa.ids.length;
  }
  const inst = out.subarray(0, 4 * m);
  // group by column for culling: kept + added by B column, removed by A column
  const cols = 512, cntB = new Uint32Array(cols + 1), cntA = new Uint32Array(cols + 1);
  let nKA = 0;
  for (let i = 0; i < m; i++) { const k = (inst[4 * i + 1] >>> 20) & 3; if (k === M_REMOVED) cntA[(inst[4 * i + 2] & 511) + 1]++; else { cntB[(inst[4 * i + 1] & 511) + 1]++; nKA++; } }
  for (let c = 0; c < cols; c++) { cntB[c + 1] += cntB[c]; cntA[c + 1] += cntA[c]; }
  const colB = cntB.slice(), colA = cntA.map(v => v + nKA), o2 = new Uint32Array(4 * m), pB = cntB.slice(), pA = cntA.slice();
  for (let i = 0; i < m; i++) { const k = (inst[4 * i + 1] >>> 20) & 3;
    const d = k === M_REMOVED ? nKA + pA[inst[4 * i + 2] & 511]++ : pB[inst[4 * i + 1] & 511]++; o2.set(inst.subarray(4 * i, 4 * i + 4), 4 * d); }
  return { inst: o2, colB, colA, nKA, kept, added, removed };
}

// ---- time: x (layout units) <-> month index (since layout.time.month0) ----
export function timeMaps(layout) {
  const K = layout.time.knots, [y0, m0] = layout.time.month0.split('-').map(Number), U = layout.unit.month;
  // binary search: the knots are dense where the axis is stretched (hundreds of them)
  const seg = (v, c) => { let lo = 0, hi = K.length - 1; while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (K[mid][c] <= v) lo = mid; else hi = mid; } return lo; };
  const xOfMonth = m => { if (m <= K[0][0]) return K[0][1] + (m - K[0][0]) * U;
    if (m >= K.at(-1)[0]) { const [ma, xa] = K.at(-1); return xa + (m - ma) * U; }
    const i = seg(m, 0), [ma, xa] = K[i], [mb, xb] = K[i + 1]; return xa + (xb - xa) * (m - ma) / (mb - ma); };
  const monthOfX = x => { if (x <= K[0][1]) return K[0][0] + (x - K[0][1]) / U;
    if (x >= K.at(-1)[1]) { const [ma, xa] = K.at(-1); return ma + (x - xa) / U; }
    const i = seg(x, 1), [ma, xa] = K[i], [mb, xb] = K[i + 1]; return ma + (mb - ma) * (x - xa) / Math.max(1e-9, xb - xa); };
  const monthOfDate = d => { const [y, m, dd] = d.split('-').map(Number); return (y - y0) * 12 + (m - m0) + ((dd || 1) - 1) / 31; };
  const dateOfMonth = mm => { const t = Math.floor(mm + 1e-3)   /* walls sit at rounded x: up to half a unit left of their date */, y = y0 + Math.floor((m0 - 1 + t) / 12), m = ((m0 - 1 + t) % 12 + 12) % 12 + 1; return `${y}-${String(m).padStart(2, '0')}`; };
  return { xOfMonth, monthOfX, monthOfDate, dateOfMonth, xOfDate: d => xOfMonth(monthOfDate(d)) };
}
