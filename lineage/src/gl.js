// gl.js: tiny WebGL2 helpers + math
export function program(gl, vs, fs, name) {
  const sh = (type, src) => {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s); console.error(name, log, src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
      throw new Error(`${name}: ${log}`);
    }
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name}: ${gl.getProgramInfoLog(p)}`);
  const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); const k = a.name.replace(/\[0\]$/, ''); u[k] = gl.getUniformLocation(p, a.name); }
  return { p, u };
}

export function tex2D(gl, w, h, ifmt, fmt, type, data = null, filter = gl.NEAREST) {
  const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, data);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === gl.LINEAR_MIPMAP_LINEAR ? gl.LINEAR : filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

// upload a linear run of texels (row-major, width W) starting at texel index `base`
export function uploadLinear(gl, tex, W, base, data, comps, fmt, type) {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  let n = data.length / comps, o = 0, idx = base;
  while (n > 0) {
    const x = idx % W, y = (idx / W) | 0;
    if (x !== 0 || n < W) {
      const k = Math.min(W - x, n);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, k, 1, fmt, type, data.subarray(o * comps, (o + k) * comps));
      n -= k; o += k; idx += k;
    } else {
      const rows = (n / W) | 0;
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, W, rows, fmt, type, data.subarray(o * comps, (o + rows * W) * comps));
      n -= rows * W; o += rows * W; idx += rows * W;
    }
  }
}

// ---- math (column-major mat4 in Float32Array) ----
export function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far), m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f; m[10] = (far + near) * nf; m[11] = -1; m[14] = 2 * far * near * nf; return m;
}
export function lookDir(eye, fwd, up = [0, 1, 0]) {
  const f = norm(fwd); let s = norm(cross(f, up)); const u = cross(s, f), m = new Float32Array(16);
  m[0] = s[0]; m[4] = s[1]; m[8] = s[2];
  m[1] = u[0]; m[5] = u[1]; m[9] = u[2];
  m[2] = -f[0]; m[6] = -f[1]; m[10] = -f[2];
  m[12] = -dot(s, eye); m[13] = -dot(u, eye); m[14] = dot(f, eye); m[15] = 1; return m;
}
export function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
  }
  return o;
}
export function frustumPlanes(m) { // Gribb-Hartmann, planes as [a,b,c,d] with inside >= 0
  const r = (i) => [m[i], m[4 + i], m[8 + i], m[12 + i]];
  const r0 = r(0), r1 = r(1), r2 = r(2), r3 = r(3), P = [];
  const add = (a, s) => P.push([r3[0] + s * a[0], r3[1] + s * a[1], r3[2] + s * a[2], r3[3] + s * a[3]]);
  add(r0, 1); add(r0, -1); add(r1, 1); add(r1, -1); add(r2, 1); add(r2, -1);
  for (const p of P) { const l = Math.hypot(p[0], p[1], p[2]); p[0] /= l; p[1] /= l; p[2] /= l; p[3] /= l; }
  return P;
}
export function boxVisible(P, x0, y0, z0, x1, y1, z1) {
  for (const p of P) {
    const x = p[0] >= 0 ? x1 : x0, y = p[1] >= 0 ? y1 : y0, z = p[2] >= 0 ? z1 : z0;
    if (p[0] * x + p[1] * y + p[2] * z + p[3] < 0) return false;
  }
  return true;
}
export function boxDist(c, x0, y0, z0, x1, y1, z1) {
  const dx = Math.max(x0 - c[0], 0, c[0] - x1), dy = Math.max(y0 - c[1], 0, c[1] - y1), dz = Math.max(z0 - c[2], 0, c[2] - z1);
  return Math.hypot(dx, dy, dz);
}
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
