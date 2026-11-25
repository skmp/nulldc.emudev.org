// w_frames.js: frame streaming worker. Fetches lane chunks (keyframe + deltas), reconstructs lane states, builds wall
// instance arrays and morphs (agents/frames/FORMAT.md). The main thread sends the wanted frames in priority order.
import * as core from './core.js';
const BASE = new URL('../', import.meta.url).href;
let F, lanes, slots = [], related = [], frameLane, frameK, frameChunk;
const chunkJSON = [];                 // [lane][chunk] -> json
const binCache = new Map();           // `${lane}/${chunk}` -> Promise<decoded frames>
const laneState = [];                 // [lane] -> { k, state }
const stateLRU = new Map();           // frame -> state (recent, for morphs)
let queue = [], busy = false; const sent = new Set();
let initDone, ready = new Promise(r => initDone = r);

async function gunzip(url) {
  const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status);
  return new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}
const pad = c => String(c).padStart(3, '0');
const jsonOf = async url => JSON.parse(new TextDecoder().decode(await gunzip(url)));

function chunkFrames(li, c) {
  const key = `${li}/${c}`;
  if (!binCache.has(key)) {
    binCache.set(key, gunzip(BASE + `data/lanes/${F.lanes[li].name}/c${pad(c)}.bin.gz`).then(bin => core.decodeChunk(chunkJSON[li][c], bin)));
    while (binCache.size > 10) binCache.delete(binCache.keys().next().value);
  }
  return binCache.get(key);
}
async function frameRec(f) {
  const li = frameLane[f], c = frameChunk[f], fr = await chunkFrames(li, c);
  return fr.find(x => x.f === f);
}
// state of frame f (lane-local order); reuses the lane's last state when it is earlier in the lane
async function reach(f) {
  if (stateLRU.has(f)) { const s = stateLRU.get(f); stateLRU.delete(f); stateLRU.set(f, s); return s; }
  const li = frameLane[f], k = frameK[f], lf = F.lanes[li].frames;
  let ls = laneState[li];
  let start;
  const kc = lf.indexOf(chunkJSON[li][frameChunk[f]].frames[0].f);   // keyframe of f's chunk (lane-local)
  if (ls && ls.k <= k && ls.k >= kc - 1 && ls.k >= 0) start = ls.k + 1;
  else if (kc === k && k > 0) { const p = await reach(lf[k - 1]); ls = { k: k - 1, state: p }; start = k; }   // keyframe: diff flags need the previous frame
  else { ls = { k: -1, state: null }; start = kc; }
  let st = ls.state;
  for (let q = start; q <= k; q++) {
    const rec = await frameRec(lf[q]);
    st = core.applyFrame(q === start && ls.k !== q - 1 ? null : st, rec);
    stateLRU.set(lf[q], st); while (stateLRU.size > 24) stateLRU.delete(stateLRU.keys().next().value);
  }
  laneState[li] = { k, state: st };
  return st;
}

async function pump() {
  if (busy) return; busy = true;
  await ready;
  try {
    while (queue.length) {
      const job = queue.shift();
      if (job.type === 'wall') {
        if (sent.has(job.f)) continue;
        const t0 = performance.now(), li = frameLane[job.f];
        const st = await reach(job.f);
        const w = core.buildWall(st, slots[li], F.lanes[li].cols ?? lanes[li].cols, related[li]);
        sent.add(job.f);
        postMessage({ type: 'wall', f: job.f, ms: performance.now() - t0, ...w }, [w.inst.buffer, w.colStart.buffer, w.fileStart.buffer, w.fileSlot.buffer, w.fileIdent.buffer, w.fst.buffer, w.fdom.buffer]);
      } else if (job.type === 'morph') {
        const t0 = performance.now(), li = frameLane[job.b];
        const sa = job.a >= 0 ? await reach(job.a) : null, sb = await reach(job.b);
        const m = core.buildMorph(sa, sb, slots[li]);
        postMessage({ type: 'morph', key: job.key, a: job.a, b: job.b, ms: performance.now() - t0, ...m }, [m.inst.buffer]);
      } else if (job.type === 'locate') {
        postMessage({ type: 'locate', req: job.req, hit: await locate(job.id, job.frames) });
      }
    }
  } catch (e) { postMessage({ type: 'error', error: String(e && e.stack || e) }); }
  busy = false;
}
// first of the given frames whose state holds line id: { f, ident, line }
async function locate(id, frames) {
  for (const f of frames) {
    const st = await reach(f);
    for (const [ident, file] of st) { const l = file.ids.indexOf(id); if (l >= 0) return { f, ident, line: l }; }
  }
  return null;
}

onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    F = m.F; lanes = m.lanes;
    slots = lanes.map(l => core.laneSlots(l));
    related = F.lanes.map((_, li) => core.relatedMask(F, li));
    frameLane = new Int16Array(F.frames.length).fill(-1); frameK = new Int16Array(F.frames.length).fill(-1); frameChunk = new Int16Array(F.frames.length).fill(-1);
    F.lanes.forEach((l, li) => l.frames.forEach((f, k) => { frameLane[f] = li; frameK[f] = k; }));
    for (const fr of F.frames) if (fr.chunk >= 0) frameChunk[fr.i] = fr.chunk;
    // all chunk JSONs (small): per-frame file lists for the far tiers
    await Promise.all(F.lanes.map(async (l, li) => { chunkJSON[li] = await Promise.all(l.chunks.map((_, c) => jsonOf(BASE + `data/lanes/${l.name}/c${pad(c)}.json.gz`))); }));
    F.lanes.forEach((l, li) => {
      let st = new Map(); const out = [];
      for (const cj of chunkJSON[li]) for (const fr of cj.frames) {
        st = core.applyMeta(st, fr);
        const nf = st.size, slot = new Int32Array(nf), n = new Uint32Array(nf), dom = new Uint16Array(nf), stc = new Uint8Array(nf), ident = new Int32Array(nf), paths = [];
        let k = 0; for (const [id, v] of st) { slot[k] = slots[li].byIdent.get(id) ?? -1; n[k] = v.n; dom[k] = v.dom; stc[k] = v.st; ident[k] = id; paths.push(v.path); k++; }
        out.push({ f: fr.f, slot, n, dom, st: stc, ident, paths });
      }
      postMessage({ type: 'meta', lane: li, frames: out });
    });
    postMessage({ type: 'metaDone' }); initDone();
  } else if (m.type === 'want') {   // replaces the queue of wall jobs; morph / locate jobs are kept in front
    const keep = queue.filter(j => j.type !== 'wall');
    queue = keep.concat(m.frames.filter(f => !sent.has(f)).map(f => ({ type: 'wall', f })));
    pump();
  } else if (m.type === 'evicted') { for (const f of m.frames) sent.delete(f); }
  else if (m.type === 'morph') { queue.unshift({ type: 'morph', a: m.a, b: m.b, key: m.key }); pump(); }
  else if (m.type === 'locate') { queue.unshift({ type: 'locate', id: m.id, frames: m.frames, req: m.req }); pump(); }
};
