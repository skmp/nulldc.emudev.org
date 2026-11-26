// shaders.js: GLSL ES 3.0 sources (format 2 data: walls are frames, displayed X / alpha per wall come from uWallTex)
const HEAD = `#version 300 es
precision highp float; precision highp int;
precision highp usampler2D; precision highp usampler2DArray; precision highp sampler2D;
`;
// uWallTex: RGBA32F, 1024 wide, texel (w & 1023, w >> 10) = (display x, alpha, solid, 0) of wall w (frame index;
// NONE = static and CLOCK = clock: the two indices after the last frame, see main.js)
const COMMON = `
uniform mat4 uVP; uniform vec3 uCam; uniform vec3 uFwd; uniform float uFocal; uniform sampler2D uWallTex;
vec4 wallOf(uint w) { return texelFetch(uWallTex, ivec2(int(w & 1023u), int(w >> 10)), 0); }
vec3 pushK(vec3 p, float k) { return uCam + (p - uCam) * k; }
`;
// ---- glyphs: high-res SDF atlas (64x128 cells, spread 12 px), mipmapped + anisotropic; explicit gradients from the
// continuous cell coordinate (fract() would break the implicit ones at cell borders); 4-tap supersampling when small
const GLYPH = `
uniform sampler2D uAtlas; uniform vec4 uAtlasM;   // cellW / W, cellH / H, spread px, cellW px
float sdfAt(vec2 uv, vec2 gx, vec2 gy) { return textureGrad(uAtlas, uv, gx, gy).r; }
float glyphCov(uint ch, vec2 l) {   // l: x in cells (fract = within cell), y 0..2 top -> bottom
  if (ch <= 32u) return 0.;
  float gi = float(ch - 32u);
  vec2 cell = vec2(mod(gi, 16.), floor(gi / 16.)), sc = uAtlasM.xy;
  vec2 lx = dFdx(l), ly = dFdy(l);
  vec2 gx = vec2(lx.x, lx.y * 0.5) * sc, gy = vec2(ly.x, ly.y * 0.5) * sc;
  vec2 uv = (cell + vec2(fract(l.x), l.y * 0.5)) * sc;
  // screen px per atlas px (along the more minified axis) -> width of the AA ramp in SDF units
  float apx = uAtlasM.w * max(length(vec2(lx.x, ly.x)), 0.5 * length(vec2(lx.y, ly.y)));
  float w = clamp(0.5 * apx * (127. / uAtlasM.z) / 255., 0.003, 0.5);
  vec2 lo = (cell + vec2(0.02, 0.)) * sc, hi = (cell + vec2(0.98, 1.)) * sc;
  if (apx < 3.) return smoothstep(0.5 - w, 0.5 + w, sdfAt(clamp(uv, lo, hi), gx, gy));
  // small on screen: 4 taps at +-1/4 px (rotated grid), each with half the ramp
  vec2 dx = (gx * 0.25 + gy * 0.125), dy = (gy * 0.25 - gx * 0.125);
  float c = 0.;
  c += smoothstep(0.5 - w, 0.5 + w, sdfAt(clamp(uv + dx, lo, hi), gx * 0.5, gy * 0.5));
  c += smoothstep(0.5 - w, 0.5 + w, sdfAt(clamp(uv - dx, lo, hi), gx * 0.5, gy * 0.5));
  c += smoothstep(0.5 - w, 0.5 + w, sdfAt(clamp(uv + dy, lo, hi), gx * 0.5, gy * 0.5));
  c += smoothstep(0.5 - w, 0.5 + w, sdfAt(clamp(uv - dy, lo, hi), gx * 0.5, gy * 0.5));
  return c * 0.25;
}
`;

// ---- code lines: one quad per line; per pixel: SDF glyphs (near), SDF token / word shapes (middle), bar (far) ----
export function lineVS(morph) {
  return HEAD + (morph ? '#define MORPH 1\n' : '') + COMMON + `
uniform usampler2D uInst; uniform usampler2D uMeta; uniform usampler2D uOffs;
uniform int uBase; uniform float uWallX; uniform float uZ0; uniform int uBake; uniform float uBakeW; uniform float uAlpha;
uniform ivec2 uHi; uniform float uMorphT; uniform int uStride; uniform int uMorphGlyph;
out vec2 vL; out float vDist;
flat out uvec4 vInfo;  // id, origin, flags, keep
flat out uint vOff; flat out float vLen; flat out vec4 vTint; flat out float vAlpha; flat out float vHi; flat out float vNoGlyph; flat out float vInd;
void main() {
#ifdef MORPH
  int idx = uBase + gl_InstanceID * uStride;
#else
  int idx = uBase + gl_InstanceID;
#endif
  ivec2 tc = ivec2(idx & 4095, idx >> 12);
#ifdef MORPH
  uvec4 w = texelFetch(uInst, tc, 0);
  uint kind = (w.y >> 20) & 3u, keep = w.w, flags = 0u;
  float seed = float((w.y >> 22) & 255u) / 255.;
  uint pos = kind == 2u ? w.z : (w.y & 0xFFFFFu);
#else
  uvec2 w = texelFetch(uInst, tc, 0).xy;
  uint pos = w.y & 0xFFFFFu, keep = ((w.y >> 20) & 1023u) | ((w.x >> 31) << 10), flags = w.y >> 30;
#endif
  uint id = w.x & 0xFFFFFu;
  ivec2 lc = ivec2(int(id & 2047u), int(id >> 11));
  uvec2 m = texelFetch(uMeta, lc, 0).xy;
  float ind = float(m.x), len = float(m.y & 127u);
  if (len <= ind) { gl_Position = vec4(2., 2., 2., 1.); return; }
  vec2 cr = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  float xe = min(len, 124.);
  vec4 tint = vec4(0.); float alpha = 1.; float lift = 0.; float noGlyph = 0.;
  float zCol = uZ0 + float(pos & 511u) * 128., rowF = float((pos >> 9) & 2047u);
#ifdef MORPH
  float t = uMorphT;
  if (kind == 0u) {          // kept: slide from A to B (rows within the file's slot)
    vec2 a = vec2(float(w.z & 511u), float((w.z >> 9) & 2047u)), b = vec2(float(pos & 511u), float((pos >> 9) & 2047u));
    float s0 = 0.2 + 0.15 * seed; float u = clamp((t - s0) / 0.45, 0., 1.); u = u * u * (3. - 2. * u);
    zCol = mix(uZ0 + a.x * 128., uZ0 + b.x * 128., u); rowF = mix(a.y, b.y, u);
    lift = sin(3.14159 * u) * (a.x != b.x ? 260. : 0.);
    if (uMorphGlyph == 0 && u > 0. && u < 1. && a != b) noGlyph = 1.;
  } else if (kind == 2u) {   // removed: tint red, fade, collapse right to left
    float r = clamp((t - 0.05 * seed) / 0.3, 0., 1.);
    tint = vec4(1., 0.25, 0.2, 0.8); alpha = 1. - smoothstep(0.55, 1., r);
    xe = mix(xe, ind + 0.5, smoothstep(0.3, 1., r));
    if (uMorphGlyph == 0) noGlyph = 1.;
  } else {                   // added: grow left to right in green, then settle
    float s = clamp((t - 0.6 - 0.1 * seed) / 0.28, 0., 1.);
    xe = mix(ind + 0.01, xe, s); alpha = s > 0. ? 1. : 0.;
    tint = vec4(0.35, 1., 0.45, 0.85 * (1. - smoothstep(0.85, 1., t)));
    if (uMorphGlyph == 0 && s < 1.) noGlyph = 1.;
  }
#endif
  float zl = mix(ind, xe, cr.x);
  vec3 p = vec3(uWallX, 4096. - rowF * 2. - cr.y * 2. + lift, zCol + zl);
  if (uBake == 1) gl_Position = vec4((p.z - uZ0) / uBakeW * 2. - 1., p.y / 4096. * 2. - 1., 0., 1.);
  else gl_Position = uVP * vec4(p, 1.);
  vL = vec2(zl, cr.y * 2.);
  vDist = max(dot(p - uCam, uFwd), 0.5);
  vInfo = uvec4(id, (w.x >> 20) & 2047u, flags, keep);
  vOff = texelFetch(uOffs, lc, 0).x; vLen = len; vInd = ind;
  vTint = tint; vAlpha = alpha * uAlpha * (m.y >= 128u ? 0.78 : 1.);
  vHi = (idx >= uHi.x && idx < uHi.y) ? 1. : 0.;
  vNoGlyph = noGlyph;
}`;
}
export function lineFS() {
  return HEAD + COMMON + GLYPH + `
uniform usampler2DArray uText; uniform sampler2D uPal; uniform usampler2D uMark; uniform usampler2D uPoss;
uniform int uMode; uniform int uLane; uniform int uHideInc; uniform float uT0; uniform float uT1; uniform int uBake; uniform int uDom; uniform vec2 uLF;
in vec2 vL; in float vDist;
flat in uvec4 vInfo; flat in uint vOff; flat in float vLen; flat in vec4 vTint; flat in float vAlpha; flat in float vHi; flat in float vNoGlyph; flat in float vInd;
out vec4 oC;
vec3 pal(int row, uint i) { return texelFetch(uPal, ivec2(int(i), row), 0).rgb; }
uint charAt(float cell) {
  if (cell < 0. || cell >= min(vLen, 124.) || vOff == 0xFFFFFFFFu) return 32u;
  uint o = vOff + uint(cell);
  return texelFetch(uText, ivec3(int(o & 4095u), int((o >> 12) & 4095u), int(o >> 24)), 0).r;
}
void main() {
  uint id = vInfo.x, origin = vInfo.y, flags = vInfo.z, keep = vInfo.w;
  if (uHideInc == 1 && (flags & 1u) != 0u) origin = uint(uDom);
  vec3 c;
  if (uMode == 0) c = pal(0, origin);
  else if (uMode == 1) c = pal(1, origin);
  else if (uMode == 2) {
    if (keep == 2047u) c = pal(0, origin) * 0.4;   // TRIV (core.js)
    else { float poss = float(texelFetch(uPoss, ivec2(int(origin), uLane), 0).r);
      float r = poss > 0. ? clamp(float(keep) / poss, 0., 1.) : 1.; c = pal(3, uint(r * 63. + 0.5)); }
  } else if (uMode == 3) c = (flags & 2u) != 0u ? vec3(0.3, 0.95, 0.4) : vec3(0.40, 0.42, 0.47);
  else c = pal(2, origin);
  c = mix(c, vTint.rgb, vTint.a);
  float ppl = 2. * uFocal / max(vDist, 1e-3);           // px per line (2 world units)
  float fwy = max(fwidth(vL.y), 1e-4), fwx = max(fwidth(vL.x), 1e-4);
  // bar: the line's extent (far)
  float bar = clamp((0.6 - abs(vL.y - 1.0)) / fwy + 0.5, 0., 1.);
  bar = uBake == 1 ? 0.8 : mix(bar, 0.6, smoothstep(0.5, 1.5, fwy)) * 0.9;
  // tier weights: wide bands, so glyphs dissolve into word shapes and word shapes into bars over a long stretch of distance
  float tg = uBake == 1 ? 0. : smoothstep(uT0 * 0.62, uT0 * 1.08, ppl);   // glyph weight
  float tt = uBake == 1 ? 0. : smoothstep(uT1 * 0.55, uT1 * 1.1, ppl);    // token weight
  if (vNoGlyph > 0.) { tg = 0.; tt = 0.; }
  float cov = bar;
  if (tt > 0.) {
    float cell = floor(vL.x), fx = vL.x - cell;
    uint ch = charAt(cell);
    float g = 0.;
    if (tg > 0.) g = glyphCov(ch, vL);
    // token shape: non-space cells joined into word bars (x-height band), edges anti-aliased against the neighbours
    float on = ch > 32u ? 1. : 0., onL = charAt(cell - 1.) > 32u ? 1. : 0., onR = charAt(cell + 1.) > 32u ? 1. : 0.;
    float ex = on;
    if (fx < fwx) ex = mix(mix(onL, on, 0.5), on, clamp(fx / fwx, 0., 1.));
    else if (fx > 1. - fwx) ex = mix(mix(onR, on, 0.5), on, clamp((1. - fx) / fwx, 0., 1.));
    float band = clamp((0.42 - abs(vL.y - 1.12)) / fwy + 0.5, 0., 1.);
    float tok = ex * band * 0.85;
    cov = mix(mix(bar, tok, tt), g, tg);
  }
  cov *= (1. - smoothstep(116., 120., vL.x)) * vAlpha;
  if (uBake == 0) cov *= smoothstep(uLF.x, uLF.y, ppl);   // lines <-> impostor crossfade (impFS fades out over the same band)
  uint mk = texelFetch(uMark, ivec2(int(id & 2047u), int(id >> 11)), 0).r;
  vec4 res = vec4(c * cov, cov);
  if (vHi > 0.) res = vec4(res.rgb * 1.25, res.a) + vec4(0.10, 0.12, 0.16, 0.2) * (1. - res.a);
  if ((mk & 1u) != 0u) res = vec4(mix(res.rgb, vec3(1., 0.9, 0.2) * res.a, 0.6), res.a) + vec4(0.45, 0.38, 0.0, 0.5) * (1. - res.a);
  if ((mk & 2u) != 0u) res = vec4(mix(res.rgb, vec3(0.85, 0.6, 1.) * res.a, 0.6), res.a) + vec4(0.34, 0.16, 0.5, 0.5) * (1. - res.a);   // unique to one lineage
  if (res.a < 0.004) discard;
  oC = res;
}`;
}

// ---- rects: plates, T3 file quads, header bars, holes, floor strips, pins, clock ----
// aR = (z0, z1, y0, y1)  aX = (x0, x1)  aC = rgba8  aW = (wall u16, kind u16)
// kind bits: 0-1 type (0 wall-plane, 1 floor, 2 wall-plane palette colour [origin = aC.r | aC.g << 8, brightness aC.b]),
//            2-3 push level, 4 outline, 5 solid-only (hidden on ghost walls), 6 ghost-only
export const rectVS = HEAD + COMMON + `
layout(location=0) in vec4 aR; layout(location=1) in vec2 aX; layout(location=2) in vec4 aC; layout(location=3) in uvec2 aW;
uniform sampler2D uPal; uniform int uMode; uniform float uMul;
out vec4 vC; out vec2 vUV; flat out float vOutline;
void main() {
  vec2 cr = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  uint k = aW.y & 3u, push = (aW.y >> 2) & 3u;
  vec4 W = wallOf(aW.x);
  float wa = W.y * uMul;
  if ((aW.y & 32u) != 0u && W.z <= 0.) wa = 0.;   // plates: none on ghosts (z 0); z PLATE_FADE: a fading plate (drawn blended at its alpha)
  if (k == 2u) wa *= (aW.y & 128u) != 0u ? float(W.w == 3.) : (aW.y & 64u) != 0u ? float(W.w == 2.) : float(W.w == 1.);   // T3 file quads / T4 column strips: only on walls drawn that way
  if (wa <= 0.) { gl_Position = vec4(2., 2., 2., 1.); return; }
  vec3 p;
  if (k == 1u) p = vec3(W.x + mix(aX.x, aX.y, cr.x), aR.z, mix(aR.x, aR.y, cr.y));
  else p = vec3(W.x + aX.x, mix(aR.z, aR.w, cr.y), mix(aR.x, aR.y, cr.x));
  p = pushK(p, push == 0u ? 1. : push == 1u ? 1.0012 : push == 2u ? 1.0025 : 1.004);
  gl_Position = uVP * vec4(p, 1.);
  vec4 c = aC;
  if (k == 2u) { int row = uMode == 1 ? 1 : uMode == 4 ? 2 : 0; int o = int(aC.r * 255. + 0.5) + 256 * int(aC.g * 255. + 0.5);
    c = vec4(texelFetch(uPal, ivec2(o, row), 0).rgb * aC.b * 2., aC.a); }
  vC = vec4(c.rgb * c.a, c.a) * wa; vUV = cr; vOutline = float((aW.y >> 4) & 1u);
}`;
export const rectFS = HEAD + `
in vec4 vC; in vec2 vUV; flat in float vOutline; out vec4 oC;
void main() {
  if (vOutline > 0.) { vec2 f = fwidth(vUV) * 1.5; if (vUV.x > f.x && vUV.x < 1. - f.x && vUV.y > f.y && vUV.y < 1. - f.y) discard; }
  oC = vC;
}`;

// ---- segments: edges, ruler lines ----  aP = (z, y, s, xabs)  aW = (wallA, wallB) u16  aC
export const lineSegVS = HEAD + COMMON + `
layout(location=0) in vec4 aP; layout(location=1) in uvec2 aW; layout(location=2) in vec4 aC;
out vec4 vC;
void main() {
  vec4 A = wallOf(aW.x), B = wallOf(aW.y);
  float a = min(A.y, B.y), x = mix(A.x, B.x, aP.z) + aP.w;
  if (a <= 0.) { gl_Position = vec4(2., 2., 2., 1.); return; }
  gl_Position = uVP * vec4(x, aP.y, aP.x, 1.);
  vC = vec4(aC.rgb * aC.a, aC.a) * min(1., a * 1.5);
}`;
export const lineSegFS = HEAD + `in vec4 vC; out vec4 oC; void main() { oC = vC; }`;

// ---- labels: SDF text quads; aP = (z, y, dx, wall) aU advance/char  aV up/char-height  aT = (offset, len)  aK = (billboard / min px, max px)
// aD (per frame, decluttered labels): (alpha, line shift)
export const labelVS = HEAD + COMMON + `
layout(location=0) in vec4 aP; layout(location=1) in vec3 aU; layout(location=2) in vec3 aV; layout(location=3) in uvec2 aT; layout(location=4) in vec4 aC; layout(location=5) in vec2 aK; layout(location=6) in vec2 aD;
layout(location=7) in vec4 aB;
uniform float uMinPx; uniform float uMinFade; uniform float uCardPx; uniform vec3 uRight; uniform vec3 uUp;
out vec2 vL; flat out uint vOff; flat out float vLen; flat out vec4 vC; flat out vec4 vB;
void main() {
  vec2 cr = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec4 W = wallOf(uint(aP.w));
  vec3 o = vec3(W.x + aP.z, aP.y, aP.x);
  vec3 U = aU, V = aV;
  if (aK.x > 0.5) { U = uRight * length(aU); V = uUp * length(aV); }
  bool wallPlane = aK.x < 0.5 && aU.x == 0. && aV.x == 0.;
  float d = length(o - uCam);
  float px = length(V) * 2. * uFocal / max(d, 1.);
  // file cards (uCardPx > 0): the path label fades in over [uCardPx, 1.15 uCardPx] px; below that the card's name label
  // (aK.x < 0) takes over, grown in the wall plane to 1.15 uCardPx (at most aK.y times its size) and fading out above it
  float cardA = 1., maxPx = aK.y, lo = uMinPx, hi = uMinPx * uMinFade;
  if (aK.x < -0.5) {
    float k = clamp(uCardPx * 1.15 / px, 1., aK.y); cardA = 1. - smoothstep(uCardPx, uCardPx * 1.15, px); U *= k; V *= k; px *= k; maxPx = 0.; wallPlane = true;
  } else if (uCardPx > 0.) { lo = uCardPx; hi = uCardPx * 1.15; }
  if (aK.x > 1.5 && px < aK.x) { float k = aK.x / px; U *= k; V *= k; px = aK.x; }
  if (W.y <= 0. || aD.x < 0.01 || cardA <= 0. || px < lo || (wallPlane && uCam.x > o.x) || (maxPx > 0. && px > maxPx)) { gl_Position = vec4(2., 2., 2., 1.); return; }
  float L = float(aT.y), pad = aB.a > 0. ? 0.3 : 0.;
  vec2 l = vec2(mix(-pad, L + pad, cr.x), mix(-pad * 0.5, 2. + pad * 0.5, cr.y));
  vec3 p = o + U * l.x - V * (l.y + 2. * aD.y);
  p = pushK(p, 0.9995);
  gl_Position = uVP * vec4(p, 1.);
  vL = l; vOff = aT.x; vLen = L;
  float a = min(1., W.y * 1.4) * aD.x * smoothstep(lo, hi, px) * cardA;
  vC = vec4(aC.rgb, aC.a * a); vB = vec4(aB.rgb, aB.a * a);
}`;
export const labelFS = HEAD + GLYPH + `
uniform usampler2D uLab;
in vec2 vL; flat in uint vOff; flat in float vLen; flat in vec4 vC; flat in vec4 vB; out vec4 oC;
void main() {
  float cell = floor(vL.x);
  uint ch = 32u;
  if (cell >= 0. && cell < vLen && vL.y >= 0. && vL.y <= 2.) { uint o = vOff + uint(cell); ch = texelFetch(uLab, ivec2(int(o & 4095u), int(o >> 12)), 0).r; }
  float g = glyphCov(ch, vec2(vL.x, clamp(vL.y, 0., 2.))) * vC.a;
  vec4 res = vec4(vC.rgb * g, g) + vec4(vB.rgb * vB.a, vB.a) * (1. - g);
  if (res.a < 0.004) discard;
  oC = res;
}`;

// ---- impostor quads (baked walls) ----
export const impVS = HEAD + COMMON + `
uniform float uWallX, uZ0, uC0, uC1, uCols;
out vec2 vUV; out float vDist;
void main() {
  vec2 cr = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  float c = mix(uC0, uC1, cr.x);
  vec3 p = vec3(uWallX, (1. - cr.y) * 4096., uZ0 + c * 128.);
  gl_Position = uVP * vec4(pushK(p, 1.0008), 1.);
  vUV = vec2(c / uCols, 1. - cr.y); vDist = max(dot(p - uCam, uFwd), 0.5);
}`;
export const impFS = HEAD + `
uniform sampler2D uImp; uniform float uFade; uniform float uFocal; uniform vec2 uLF; in vec2 vUV; in float vDist; out vec4 oC;
void main() {
  vec4 c = texture(uImp, vUV); if (c.a < 0.003) discard; float a = sqrt(c.a) * 0.92;
  float f = uLF.y > 0. ? 1. - smoothstep(uLF.x, uLF.y, 2. * uFocal / vDist) : 1.;   // uLF = 0: no lines over this run
  if (f <= 0.) discard;
  oC = vec4(c.rgb / c.a * 1.1 * a, a) * uFade * f; }`;

// ---- wall titles: one instanced quad per wall, positioned in canvas px by the CPU (main.js layoutTitles)
// aS = (x, y top-left px, cell height px, alpha)  aT = (offset, len)  aC = text rgba8  aE = accent (lane) rgba8
export const titleVS = HEAD + `
layout(location=0) in vec4 aS; layout(location=1) in uvec2 aT; layout(location=2) in vec4 aC; layout(location=3) in vec4 aE;
uniform vec2 uView;
out vec2 vL; flat out uint vOff; flat out float vLen; flat out vec4 vC; flat out vec4 vE; flat out float vA;
void main() {
  vec2 cr = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  if (aS.w < 0.01) { gl_Position = vec4(2., 2., 2., 1.); return; }
  float L = float(aT.y);
  vec2 l = vec2(mix(-0.75, L + 0.45, cr.x), mix(-0.2, 2.2, cr.y));   // cells (x), half-cells (y: 0..2 = the text row)
  vec2 px = aS.xy + vec2((l.x + 0.75) * aS.z * 0.5, (l.y + 0.2) * aS.z * 0.5);
  gl_Position = vec4(px.x / uView.x * 2. - 1., 1. - px.y / uView.y * 2., 0., 1.);
  vL = l; vOff = aT.x; vLen = L; vC = aC; vE = aE; vA = aS.w;
}`;
export const titleFS = HEAD + GLYPH + `
uniform usampler2D uLab;
in vec2 vL; flat in uint vOff; flat in float vLen; flat in vec4 vC; flat in vec4 vE; flat in float vA; out vec4 oC;
void main() {
  float cell = floor(vL.x);
  uint ch = 32u;
  if (cell >= 0. && cell < vLen && vL.y >= 0. && vL.y <= 2.) { uint o = vOff + uint(cell); ch = texelFetch(uLab, ivec2(int(o & 4095u), int(o >> 12)), 0).r; }
  float g = glyphCov(ch, vec2(vL.x, clamp(vL.y, 0., 2.)));
  float fw = fwidth(vL.x);
  float acc = 1. - smoothstep(-0.52, -0.52 + fw, vL.x);              // lane-coloured accent bar on the left
  vec4 bg = vec4(0.035, 0.043, 0.06, 0.74);
  bg = mix(bg, vec4(vE.rgb, 1.), acc);
  vec4 res = vec4(vC.rgb * g, g) + vec4(bg.rgb * bg.a, bg.a) * (1. - g);
  oC = res * vA;
}`;
