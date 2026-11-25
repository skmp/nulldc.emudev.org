// w_text.js: text chunks -> folded rows for the R8UI text texture + per-line offsets; search and line text
import * as core from './core.js';
const BASE = new URL('../', import.meta.url).href;
const ROWW = 4096;
let F, lines = [], done = 0, nextRow = 0;
async function gunzip(url) {
  const r = await fetch(url); if (!r.ok) throw new Error(url + ' ' + r.status);
  return new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}
async function loadChunk(c) {
  const t0 = performance.now();
  const b = await gunzip(BASE + `data/text/lines-${String(c).padStart(3, '0')}.txt.gz`);
  const CH = F.chunk_lines, cnt = Math.min(CH, F.raw_lines - c * CH);
  const starts = new Uint32Array(cnt + 1); let a = 0;
  for (let i = 0; i < cnt; i++) { starts[i] = a; let e = b.indexOf(10, a); if (e < 0) e = b.length; a = e + 1; }
  starts[cnt] = b.length + 1;
  const tmp = new Uint8Array(cnt * core.TEXMAX); const offs = new Uint32Array(cnt); let n = 0;
  for (let i = 0; i < cnt; i++) {
    const L = core.foldInto(b, starts[i], starts[i + 1] - 1, tmp, n, core.TEXMAX);
    offs[i] = n; n += Math.min(L, core.TEXMAX);
  }
  const rows = Math.ceil(n / ROWW) || 1;
  const row0 = nextRow; nextRow += rows;
  const bytes = new Uint8Array(rows * ROWW); bytes.set(tmp.subarray(0, n));
  const base = row0 * ROWW; for (let i = 0; i < cnt; i++) offs[i] += base;
  const str = new TextDecoder().decode(b).split('\n');
  for (let i = 0; i < cnt; i++) lines[c * CH + i] = str[i];
  done++;
  postMessage({ type: 'chunk', c, first: c * CH, count: cnt, row0, rows, bytes, offs, ms: performance.now() - t0 }, [bytes.buffer, offs.buffer]);
}
onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    F = m.F; lines = new Array(F.raw_lines);
    const order = m.order && m.order.length ? m.order : [...Array(F.text_chunks).keys()];
    for (const c of order) await loadChunk(c);
    postMessage({ type: 'textDone' });
  } else if (m.type === 'text') {
    postMessage({ type: 'text', req: m.req, text: m.ids.map(i => lines[i] ?? null) });
  } else if (m.type === 'search') {
    const t0 = performance.now(); const hits = []; const max = m.max || 5000;
    let re = null; if (m.regex) { try { re = new RegExp(m.q, m.ci ? 'i' : ''); } catch (err) { postMessage({ type: 'search', req: m.req, error: String(err) }); return; } }
    const q = m.ci ? m.q.toLowerCase() : m.q;
    for (let i = 0; i < lines.length && hits.length < max; i++) {
      const s = lines[i]; if (s === undefined) continue;
      if (re ? re.test(s) : (m.ci ? s.toLowerCase().includes(q) : s.includes(q))) hits.push(i);
    }
    postMessage({ type: 'search', req: m.req, hits, text: hits.slice(0, 200).map(i => lines[i]), ms: performance.now() - t0, partial: done < F.text_chunks });
  }
};
