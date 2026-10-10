// viewport.js — WebGL2 renderer + orbit camera + picking for Workspace parts.
//
// Input is the engine's render buffer (BobloxEngine.parts()): kPartStride (21)
// doubles per BasePart —
//   [0] id  [1] shape  [2] transparency  [3..5] color  [6..8] size  [9..20] CFrame
// Rendering is instanced: one draw call per shape for opaque parts, then the
// transparent ones sorted back to front.

const STRIDE = 21; // keep in sync with kPartStride (web/src/boblox.h)
const INSTANCE_FLOATS = 24; // mat4 (16) + rgba (4) + 1/size² (3, padded to 4)

// ---------------------------------------------------------------------------
// tiny math
// ---------------------------------------------------------------------------

function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function lookAt(eye, target, up) {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let l = Math.hypot(zx, zy, zz) || 1;
  zx /= l; zy /= l; zz /= l;
  let xx = up[1] * zz - up[2] * zy, xy = up[2] * zx - up[0] * zz, xz = up[0] * zy - up[1] * zx;
  l = Math.hypot(xx, xy, xz) || 1;
  xx /= l; xy /= l; xz /= l;
  const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
  return new Float32Array([
    xx, yx, zx, 0,
    xy, yy, zy, 0,
    xz, yz, zz, 0,
    -(xx * eye[0] + xy * eye[1] + xz * eye[2]),
    -(yx * eye[0] + yy * eye[1] + yz * eye[2]),
    -(zx * eye[0] + zy * eye[1] + zz * eye[2]),
    1,
  ]);
}

function multiply(a, b) { // a * b, column-major
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

function invert(m) {
  const inv = new Float64Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (!det) return null;
  const out = new Float32Array(16);
  for (let i = 0; i < 16; i++) out[i] = inv[i] / det;
  return out;
}

function transformPoint(m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}

// ---------------------------------------------------------------------------
// unit meshes (scaled by the part's Size in the vertex shader's model matrix)
// ---------------------------------------------------------------------------

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }

class MeshBuilder {
  constructor() { this.pos = []; this.nrm = []; this.idx = []; }
  // a convex polygon with a flat normal; winding is fixed to face the normal
  face(corners, normal) {
    const base = this.pos.length / 3;
    const n = norm(normal);
    let c = corners;
    const w = cross(sub(c[1], c[0]), sub(c[2], c[0]));
    if (w[0] * n[0] + w[1] * n[1] + w[2] * n[2] < 0) c = [...c].reverse();
    for (const p of c) { this.pos.push(...p); this.nrm.push(...n); }
    for (let i = 1; i < c.length - 1; i++) this.idx.push(base, base + i, base + i + 1);
  }
  vertex(p, n) { this.pos.push(...p); this.nrm.push(...n); return this.pos.length / 3 - 1; }
  build() {
    return {
      pos: new Float32Array(this.pos),
      nrm: new Float32Array(this.nrm),
      idx: new Uint16Array(this.idx),
    };
  }
}

function cubeMesh() {
  const b = new MeshBuilder();
  const h = 0.5;
  b.face([[h, -h, -h], [h, h, -h], [h, h, h], [h, -h, h]], [1, 0, 0]);
  b.face([[-h, -h, -h], [-h, h, -h], [-h, h, h], [-h, -h, h]], [-1, 0, 0]);
  b.face([[-h, h, -h], [h, h, -h], [h, h, h], [-h, h, h]], [0, 1, 0]);
  b.face([[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]], [0, -1, 0]);
  b.face([[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]], [0, 0, 1]);
  b.face([[-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h]], [0, 0, -1]);
  return b.build();
}

// Wedge: vertical wall at +Z, slope falling to the front-bottom edge (-Z).
function wedgeMesh() {
  const b = new MeshBuilder();
  const h = 0.5;
  b.face([[-h, -h, -h], [h, -h, -h], [h, -h, h], [-h, -h, h]], [0, -1, 0]); // bottom
  b.face([[-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]], [0, 0, 1]);      // back wall
  b.face([[-h, -h, -h], [h, -h, -h], [h, h, h], [-h, h, h]], [0, 1, -1]);   // slope
  b.face([[h, -h, -h], [h, -h, h], [h, h, h]], [1, 0, 0]);                  // sides
  b.face([[-h, -h, -h], [-h, -h, h], [-h, h, h]], [-1, 0, 0]);
  return b.build();
}

function sphereMesh(seg = 28, rings = 18) {
  const b = new MeshBuilder();
  for (let r = 0; r <= rings; r++) {
    const phi = (r / rings) * Math.PI;
    for (let s = 0; s <= seg; s++) {
      const th = (s / seg) * Math.PI * 2;
      const n = [Math.sin(phi) * Math.cos(th), Math.cos(phi), Math.sin(phi) * Math.sin(th)];
      b.vertex([n[0] * 0.5, n[1] * 0.5, n[2] * 0.5], n);
    }
  }
  for (let r = 0; r < rings; r++) {
    for (let s = 0; s < seg; s++) {
      const a = r * (seg + 1) + s, c = a + seg + 1;
      b.idx.push(a, a + 1, c, a + 1, c + 1, c); // CCW seen from outside
    }
  }
  return b.build();
}

// Roblox cylinders run along the part's X axis.
function cylinderMesh(seg = 32) {
  const b = new MeshBuilder();
  for (let s = 0; s <= seg; s++) {
    const th = (s / seg) * Math.PI * 2;
    const y = Math.cos(th) * 0.5, z = Math.sin(th) * 0.5;
    const n = [0, Math.cos(th), Math.sin(th)];
    b.vertex([-0.5, y, z], n);
    b.vertex([0.5, y, z], n);
  }
  for (let s = 0; s < seg; s++) {
    const a = s * 2;
    b.idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1); // CCW seen from outside
  }
  for (const [x, nx] of [[0.5, 1], [-0.5, -1]]) {
    const center = b.vertex([x, 0, 0], [nx, 0, 0]);
    const ring = [];
    for (let s = 0; s <= seg; s++) {
      const th = (s / seg) * Math.PI * 2;
      ring.push(b.vertex([x, Math.cos(th) * 0.5, Math.sin(th) * 0.5], [nx, 0, 0]));
    }
    for (let s = 0; s < seg; s++) {
      if (nx > 0) b.idx.push(center, ring[s], ring[s + 1]);
      else b.idx.push(center, ring[s + 1], ring[s]);
    }
  }
  return b.build();
}

const CUBE_EDGES = {
  pos: new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, 0.5, -0.5, -0.5, 0.5, -0.5,
    -0.5, -0.5, 0.5, 0.5, -0.5, 0.5, 0.5, 0.5, 0.5, -0.5, 0.5, 0.5,
  ]),
  idx: new Uint16Array([0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7]),
};
const WEDGE_EDGES = {
  pos: new Float32Array([
    -0.5, -0.5, -0.5, 0.5, -0.5, -0.5, 0.5, -0.5, 0.5, -0.5, -0.5, 0.5,
    -0.5, 0.5, 0.5, 0.5, 0.5, 0.5,
  ]),
  idx: new Uint16Array([0, 1, 1, 2, 2, 3, 3, 0, 3, 4, 2, 5, 4, 5, 0, 4, 1, 5]),
};

// ---------------------------------------------------------------------------
// shaders
// ---------------------------------------------------------------------------

const INSTANCE_ATTRIBS = `
layout(location = 2) in vec4 aM0;
layout(location = 3) in vec4 aM1;
layout(location = 4) in vec4 aM2;
layout(location = 5) in vec4 aM3;
layout(location = 6) in vec4 aColor;
layout(location = 7) in vec3 aIss;
`;

const VS_LIT = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
${INSTANCE_ATTRIBS}
uniform mat4 uViewProj;
out vec3 vN;
out vec3 vWorld;
out vec4 vColor;
void main() {
  mat4 model = mat4(aM0, aM1, aM2, aM3);
  vec4 w = model * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vN = mat3(model) * (aNormal * aIss);   // (R S) * (n / s^2) = R * (n / s)
  vColor = aColor;
  gl_Position = uViewProj * w;
}`;

const FS_LIT = `#version 300 es
precision highp float;
in vec3 vN;
in vec3 vWorld;
in vec4 vColor;
uniform vec3 uLightDir;
uniform vec3 uCamPos;
uniform vec3 uFog;
out vec4 outColor;
void main() {
  vec3 n = normalize(vN);
  if (!gl_FrontFacing) n = -n;
  float ndl = max(dot(n, uLightDir), 0.0);
  float hemi = 0.5 + 0.5 * n.y;
  vec3 lit = vColor.rgb * (0.32 + 0.28 * hemi + 0.62 * ndl);
  float fog = clamp((length(uCamPos - vWorld) - 120.0) / 500.0, 0.0, 0.55);
  outColor = vec4(mix(lit, uFog, fog), vColor.a);
}`;

const VS_LINE = `#version 300 es
layout(location = 0) in vec3 aPos;
${INSTANCE_ATTRIBS}
uniform mat4 uViewProj;
uniform vec3 uFadeCenter;
uniform float uFadeRadius;
out float vFade;
void main() {
  mat4 model = mat4(aM0, aM1, aM2, aM3);
  vec4 w = model * vec4(aPos, 1.0);
  vFade = uFadeRadius > 0.0 ? 1.0 - clamp(length(w.xz - uFadeCenter.xz) / uFadeRadius, 0.0, 1.0) : 1.0;
  gl_Position = uViewProj * w;
}`;

const FS_LINE = `#version 300 es
precision highp float;
in float vFade;
uniform vec4 uColor;
out vec4 outColor;
void main() { outColor = vec4(uColor.rgb, uColor.a * vFade); }`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('shader: ' + gl.getShaderInfoLog(sh));
  return sh;
}

function program(gl, vs, fs) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('program: ' + gl.getProgramInfoLog(p));
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    uniforms[info.name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u: uniforms };
}

function parseColor(css, fallback) {
  const m = /^#?([0-9a-f]{6})$/i.exec(css.trim());
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
}

// ---------------------------------------------------------------------------
// viewport
// ---------------------------------------------------------------------------

export class Viewport {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {{ onPick?: (id: number | null) => void, onUnsupported?: (why: string) => void }} [options]
   */
  constructor(canvas, { onPick, onUnsupported } = {}) {
    this.canvas = canvas;
    this.onPick = onPick ?? (() => {});
    this.parts = new Float64Array(0);
    this.selected = null;
    this.camera = { yaw: 0.78, pitch: 0.5, dist: 34, target: [0, 3, 0] };
    this.userMovedCamera = false;
    this.dirty = true;
    this.frames = 0;
    this.supported = false;
    this._raf = 0;

    const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true });
    if (!gl) {
      onUnsupported?.('WebGL 2 is not available in this browser, so the 3D viewport is disabled. Everything else still works.');
      return;
    }
    this.gl = gl;
    try {
      this._init();
    } catch (e) {
      onUnsupported?.('The 3D viewport could not start: ' + (e?.message ?? e));
      return;
    }
    this.supported = true;
    this._bindInput();
    this._observeResize();
    this.requestRender();
  }

  // ---- public API -----------------------------------------------------------

  /** Replace the render buffer (a Float64Array of STRIDE doubles per part). */
  setParts(parts) {
    this.parts = parts;
    this.requestRender();
  }

  setSelected(id) {
    if (this.selected === id) return;
    this.selected = id;
    this.requestRender();
  }

  get partCount() { return this.parts.length / STRIDE; }

  /** Fit the camera to everything in the scene. */
  frameAll() {
    const p = this.parts;
    if (!p.length) {
      Object.assign(this.camera, { target: [0, 3, 0], dist: 34 });
      this.requestRender();
      return;
    }
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += STRIDE) {
      // world-space half extent of the rotated box on each axis: sum_j |R[a][j]| * half_j
      const hx = p[i + 6] / 2, hy = p[i + 7] / 2, hz = p[i + 8] / 2;
      for (let a = 0; a < 3; a++) {
        const e = Math.abs(p[i + 12 + a * 3]) * hx + Math.abs(p[i + 13 + a * 3]) * hy + Math.abs(p[i + 14 + a * 3]) * hz;
        lo[a] = Math.min(lo[a], p[i + 9 + a] - e);
        hi[a] = Math.max(hi[a], p[i + 9 + a] + e);
      }
    }
    const center = lo.map((v, a) => (v + hi[a]) / 2);
    const radius = Math.max(2, 0.5 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]));
    this.camera.target = center;
    this.camera.dist = Math.min(1500, radius / Math.sin(0.5 * this.fov) * 1.05);
    this.requestRender();
  }

  /** Frame the camera automatically the first time content appears, unless the user already moved it. */
  autoFrameOnce() {
    if (!this.userMovedCamera && this.partCount > 0) this.frameAll();
  }

  /** Id of the nearest part under a canvas-relative pixel, or null. */
  pick(px, py) {
    const ray = this._ray(px, py);
    if (!ray) return null;
    const p = this.parts;
    let best = null;
    let bestT = Infinity;
    for (let i = 0; i < p.length; i += STRIDE) {
      const c = [p[i + 9], p[i + 10], p[i + 11]];
      const ax = [p[i + 12], p[i + 15], p[i + 18]];
      const ay = [p[i + 13], p[i + 16], p[i + 19]];
      const az = [p[i + 14], p[i + 17], p[i + 20]];
      const oc = sub(ray.o, c);
      const o = [dot(oc, ax), dot(oc, ay), dot(oc, az)];
      const d = [dot(ray.d, ax), dot(ray.d, ay), dot(ray.d, az)];
      const half = [p[i + 6] / 2, p[i + 7] / 2, p[i + 8] / 2];
      let t0 = 0, t1 = Infinity, miss = false;
      for (let a = 0; a < 3 && !miss; a++) {
        if (Math.abs(d[a]) < 1e-12) {
          if (o[a] < -half[a] || o[a] > half[a]) miss = true;
        } else {
          let ta = (-half[a] - o[a]) / d[a];
          let tb = (half[a] - o[a]) / d[a];
          if (ta > tb) [ta, tb] = [tb, ta];
          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tb);
          if (t0 > t1) miss = true;
        }
      }
      if (!miss && t0 < bestT) { bestT = t0; best = p[i]; }
    }
    return best;
  }

  /** Look at a part (used on double-click). */
  focusPart(id) {
    const p = this.parts;
    for (let i = 0; i < p.length; i += STRIDE) {
      if (p[i] === id) {
        this.camera.target = [p[i + 9], p[i + 10], p[i + 11]];
        this.requestRender();
        return;
      }
    }
  }

  requestRender() {
    if (!this.supported || this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this._ro?.disconnect();
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }

  // ---- setup ----------------------------------------------------------------------

  get fov() { return (50 * Math.PI) / 180; }

  _init() {
    const gl = this.gl;
    this.lit = program(gl, VS_LIT, FS_LIT);
    this.line = program(gl, VS_LINE, FS_LINE);

    this.instBuf = gl.createBuffer();
    this.meshes = [sphereMesh(), cubeMesh(), cylinderMesh(), wedgeMesh()].map((m) => this._litVao(m)); // by shape code
    this.edgeMeshes = { 1: this._lineVao(CUBE_EDGES), 3: this._lineVao(WEDGE_EDGES) };

    // Ground grid: 5-stud cells out to 100 studs, plus the X (red) and Z (blue) axes.
    // Every line is built from short 5-stud segments: a long segment that crosses
    // the camera's near plane is mishandled by some software rasterizers, while a
    // short one confines any such error to a few pixels next to the camera.
    const grid = [], axisX = [], axisZ = [];
    const segments = (out, x0, z0, x1, z1) => {
      const n = 40;
      for (let k = 0; k < n; k++) {
        const a = k / n, b = (k + 1) / n;
        out.push(x0 + (x1 - x0) * a, 0, z0 + (z1 - z0) * a, x0 + (x1 - x0) * b, 0, z0 + (z1 - z0) * b);
      }
    };
    for (let i = -20; i <= 20; i++) {
      if (i === 0) continue;
      segments(grid, i * 5, -100, i * 5, 100);
      segments(grid, -100, i * 5, 100, i * 5);
    }
    segments(axisX, -100, 0, 100, 0);
    segments(axisZ, 0, -100, 0, 100);
    this.grid = this._rawLines(grid);
    this.axisX = this._rawLines(axisX);
    this.axisZ = this._rawLines(axisZ);

    const cs = getComputedStyle(this.canvas.parentElement);
    this.fog = parseColor(cs.getPropertyValue('--viewport-bottom'), [0.06, 0.07, 0.11]);
    this.gridRgb = cs.getPropertyValue('--grid-rgb').trim() || '255,255,255';

    // a single identity instance, for the grid
    this.identity = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.identity);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]), gl.STATIC_DRAW);
  }

  _vertexVao(pos, nrm, idx) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const pb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pb);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    if (nrm) {
      const nb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, nb);
      gl.bufferData(gl.ARRAY_BUFFER, nrm, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    }
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: idx.length };
  }

  _litVao(mesh) { return this._vertexVao(mesh.pos, mesh.nrm, mesh.idx); }
  _lineVao(mesh) { return this._vertexVao(mesh.pos, null, mesh.idx); }

  _rawLines(pos) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return { vao, count: pos.length / 3 };
  }

  // Point the six per-instance attributes of `vao` at `buffer`, starting at `floatOffset`.
  _instances(vao, buffer, floatOffset) {
    const gl = this.gl;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const stride = INSTANCE_FLOATS * 4;
    const base = floatOffset * 4;
    const attr = (loc, size, off) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, base + off * 4);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr(2, 4, 0); attr(3, 4, 4); attr(4, 4, 8); attr(5, 4, 12); attr(6, 4, 16); attr(7, 3, 20);
  }

  _observeResize() {
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
      const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
        this.requestRender();
      }
    };
    this._ro = new ResizeObserver(resize);
    this._ro.observe(this.canvas);
    resize();
  }

  // ---- camera / input ----------------------------------------------------------

  _eye() {
    const { yaw, pitch, dist, target } = this.camera;
    return [
      target[0] + dist * Math.cos(pitch) * Math.sin(yaw),
      target[1] + dist * Math.sin(pitch),
      target[2] + dist * Math.cos(pitch) * Math.cos(yaw),
    ];
  }

  _matrices() {
    const aspect = this.canvas.width / Math.max(1, this.canvas.height);
    const far = Math.max(2000, this.camera.dist * 8);
    const proj = perspective(this.fov, aspect, Math.max(0.05, this.camera.dist / 2000), far);
    const view = lookAt(this._eye(), this.camera.target, [0, 1, 0]);
    return { viewProj: multiply(proj, view), eye: this._eye() };
  }

  _ray(px, py) {
    const { viewProj, eye } = this._matrices();
    const inv = invert(viewProj);
    if (!inv) return null;
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const nx = (px / w) * 2 - 1, ny = 1 - (py / h) * 2;
    const far = transformPoint(inv, nx, ny, 1);
    const d = norm(sub(far, eye));
    return { o: eye, d };
  }

  _bindInput() {
    const c = this.canvas;
    const pointers = new Map();
    let moved = 0, downAt = 0, mode = 'orbit';
    let pinch = null;

    const rect = () => c.getBoundingClientRect();
    const touchCamera = () => { this.userMovedCamera = true; this.requestRender(); };

    c.addEventListener('pointerdown', (e) => {
      c.focus({ preventScroll: true });
      c.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        moved = 0;
        downAt = performance.now();
        mode = e.button === 2 || e.shiftKey || e.button === 1 ? 'pan' : 'orbit';
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      }
    });

    c.addEventListener('pointermove', (e) => {
      const prev = pointers.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved += Math.abs(dx) + Math.abs(dy);
      if (pointers.size === 2 && pinch) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        this.camera.dist = Math.min(3000, Math.max(0.5, this.camera.dist * (pinch.d / Math.max(d, 1))));
        this._pan(cx - pinch.cx, cy - pinch.cy);
        pinch = { d, cx, cy };
        touchCamera();
      } else if (pointers.size === 1) {
        if (mode === 'pan') this._pan(dx, dy);
        else {
          this.camera.yaw -= dx * 0.008;
          this.camera.pitch = Math.max(-1.5, Math.min(1.5, this.camera.pitch + dy * 0.008));
        }
        touchCamera();
      }
    });

    const end = (e) => {
      const wasOne = pointers.size === 1;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (e.type === 'pointerup' && wasOne && moved < 5 && performance.now() - downAt < 600) {
        const r = rect();
        this.onPick(this.pick(e.clientX - r.left, e.clientY - r.top));
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('dblclick', (e) => {
      const r = rect();
      const id = this.pick(e.clientX - r.left, e.clientY - r.top);
      if (id !== null) { this.focusPart(id); this.userMovedCamera = true; }
    });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : 1;
      this.camera.dist = Math.min(3000, Math.max(0.5, this.camera.dist * Math.exp(e.deltaY * unit * 0.0012)));
      touchCamera();
    }, { passive: false });

    c.addEventListener('keydown', (e) => {
      const step = 0.12;
      if (e.key === 'ArrowLeft') this.camera.yaw += step;
      else if (e.key === 'ArrowRight') this.camera.yaw -= step;
      else if (e.key === 'ArrowUp') this.camera.pitch = Math.min(1.5, this.camera.pitch + step);
      else if (e.key === 'ArrowDown') this.camera.pitch = Math.max(-1.5, this.camera.pitch - step);
      else if (e.key === '+' || e.key === '=') this.camera.dist = Math.max(0.5, this.camera.dist * 0.88);
      else if (e.key === '-') this.camera.dist = Math.min(3000, this.camera.dist / 0.88);
      else if (e.key === 'f' || e.key === 'F') { this.frameAll(); return; }
      else return;
      e.preventDefault();
      touchCamera();
    });
  }

  _pan(dx, dy) {
    const { yaw, pitch, dist, target } = this.camera;
    const k = dist * 0.0016;
    const right = [Math.cos(yaw), 0, -Math.sin(yaw)];
    const up = [-Math.sin(pitch) * Math.sin(yaw), Math.cos(pitch), -Math.sin(pitch) * Math.cos(yaw)];
    for (let a = 0; a < 3; a++) target[a] += (-dx * right[a] + dy * up[a]) * k;
  }

  // ---- drawing --------------------------------------------------------------------

  _writeInstance(buf, o, p, i, sizeAdd) {
    const sx = Math.max(p[i + 6] + sizeAdd, 1e-3), sy = Math.max(p[i + 7] + sizeAdd, 1e-3), sz = Math.max(p[i + 8] + sizeAdd, 1e-3);
    // CFrame rotation columns are the part's local axes: R[row][col] at i+12+row*3+col
    buf[o] = p[i + 12] * sx; buf[o + 1] = p[i + 15] * sx; buf[o + 2] = p[i + 18] * sx; buf[o + 3] = 0;
    buf[o + 4] = p[i + 13] * sy; buf[o + 5] = p[i + 16] * sy; buf[o + 6] = p[i + 19] * sy; buf[o + 7] = 0;
    buf[o + 8] = p[i + 14] * sz; buf[o + 9] = p[i + 17] * sz; buf[o + 10] = p[i + 20] * sz; buf[o + 11] = 0;
    buf[o + 12] = p[i + 9]; buf[o + 13] = p[i + 10]; buf[o + 14] = p[i + 11]; buf[o + 15] = 1;
    buf[o + 16] = p[i + 3]; buf[o + 17] = p[i + 4]; buf[o + 18] = p[i + 5]; buf[o + 19] = 1 - p[i + 2];
    buf[o + 20] = 1 / (sx * sx); buf[o + 21] = 1 / (sy * sy); buf[o + 22] = 1 / (sz * sz); buf[o + 23] = 0;
  }

  _draw() {
    const gl = this.gl;
    const { viewProj, eye } = this._matrices();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    // ---- bucket parts: opaque by shape, transparent sorted back to front
    const p = this.parts;
    const n = p.length / STRIDE;
    const opaque = [[], [], [], []];
    const clear = [];
    let selectedAt = -1;
    for (let k = 0; k < n; k++) {
      const i = k * STRIDE;
      const shape = Math.min(3, Math.max(0, p[i + 1] | 0));
      if (p[i] === this.selected) selectedAt = i;
      if (p[i + 2] > 0.02) {
        const d = (p[i + 9] - eye[0]) ** 2 + (p[i + 10] - eye[1]) ** 2 + (p[i + 11] - eye[2]) ** 2;
        clear.push([d, i, shape]);
      } else {
        opaque[shape].push(i);
      }
    }
    clear.sort((a, b) => b[0] - a[0]);

    const total = opaque.reduce((s, a) => s + a.length, 0) + clear.length + 2;
    const data = new Float32Array(total * INSTANCE_FLOATS);
    let cursor = 0;
    const groups = []; // {shape, first, count}
    for (let s = 0; s < 4; s++) {
      if (!opaque[s].length) continue;
      groups.push({ shape: s, first: cursor, count: opaque[s].length });
      for (const i of opaque[s]) { this._writeInstance(data, cursor * INSTANCE_FLOATS, p, i, 0); cursor++; }
    }
    const clearFirst = cursor;
    for (const [, i] of clear) { this._writeInstance(data, cursor * INSTANCE_FLOATS, p, i, 0); cursor++; }
    const exactAt = cursor; // the selected part as-is (depth-only pre-pass) ...
    const outlineAt = cursor + 1; // ... and slightly inflated (the outline hull)
    if (selectedAt >= 0) {
      this._writeInstance(data, cursor * INSTANCE_FLOATS, p, selectedAt, 0);
      this._writeInstance(data, (cursor + 1) * INSTANCE_FLOATS, p, selectedAt, 0.14);
      cursor += 2;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, Math.max(cursor, 1) * INSTANCE_FLOATS), gl.DYNAMIC_DRAW);

    // ---- grid + axes
    const L = this.line;
    gl.useProgram(L.p);
    gl.uniformMatrix4fv(L.u.uViewProj, false, viewProj);
    gl.uniform3f(L.u.uFadeCenter, this.camera.target[0], 0, this.camera.target[2]);
    gl.uniform1f(L.u.uFadeRadius, 110);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const rgb = this.gridRgb.split(',').map((v) => Number(v) / (Number(v) > 1 ? 255 : 1));
    const drawLines = (mesh, color) => {
      this._instances(mesh.vao, this.identity, 0);
      gl.uniform4f(L.u.uColor, ...color);
      gl.bindVertexArray(mesh.vao);
      gl.drawArraysInstanced(gl.LINES, 0, mesh.count, 1);
    };
    drawLines(this.grid, [rgb[0], rgb[1], rgb[2], 0.28]);
    drawLines(this.axisX, [0.95, 0.35, 0.35, 0.8]);
    drawLines(this.axisZ, [0.35, 0.55, 0.98, 0.8]);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);

    // ---- opaque parts (pushed back a touch so the edge lines never z-fight the faces)
    const P = this.lit;
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1, 1);
    gl.useProgram(P.p);
    gl.uniformMatrix4fv(P.u.uViewProj, false, viewProj);
    gl.uniform3f(P.u.uLightDir, ...norm([0.45, 0.85, 0.35]));
    gl.uniform3f(P.u.uCamPos, eye[0], eye[1], eye[2]);
    gl.uniform3f(P.u.uFog, ...this.fog);
    for (const g of groups) {
      const mesh = this.meshes[g.shape];
      this._instances(mesh.vao, this.instBuf, g.first * INSTANCE_FLOATS);
      gl.bindVertexArray(mesh.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0, g.count);
    }

    // ---- crisp edges on boxes and wedges
    gl.useProgram(L.p);
    gl.uniform1f(L.u.uFadeRadius, 0);
    gl.uniform4f(L.u.uColor, 0, 0, 0, 0.45);
    gl.enable(gl.BLEND);
    gl.depthMask(false);
    for (const g of groups) {
      const edges = this.edgeMeshes[g.shape];
      if (!edges) continue;
      this._instances(edges.vao, this.instBuf, g.first * INSTANCE_FLOATS);
      gl.bindVertexArray(edges.vao);
      gl.drawElementsInstanced(gl.LINES, edges.count, gl.UNSIGNED_SHORT, 0, g.count);
    }

    // ---- transparent parts, far to near
    gl.useProgram(P.p);
    gl.enable(gl.BLEND);
    for (let k = 0; k < clear.length; k++) {
      const mesh = this.meshes[clear[k][2]];
      this._instances(mesh.vao, this.instBuf, (clearFirst + k) * INSTANCE_FLOATS);
      gl.bindVertexArray(mesh.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0, 1);
    }
    gl.depthMask(true);
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // ---- selection: an inflated back-face hull in the accent color
    if (selectedAt >= 0) {
      const shape = Math.min(3, Math.max(0, p[selectedAt + 1] | 0));
      const mesh = this.meshes[shape];
      gl.useProgram(L.p); // flat program; it only reads location 0 + the instance attributes
      gl.uniform1f(L.u.uFadeRadius, 0);
      gl.disable(gl.BLEND);
      gl.depthFunc(gl.LEQUAL);
      // Depth-only pass of the part itself. Transparent parts never wrote depth, so
      // without this the hull would paint straight over them instead of only
      // showing as a ring around the silhouette.
      gl.colorMask(false, false, false, false);
      gl.depthMask(true);
      this._instances(mesh.vao, this.instBuf, exactAt * INSTANCE_FLOATS);
      gl.bindVertexArray(mesh.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0, 1);
      gl.colorMask(true, true, true, true);
      // the hull: back faces of the inflated mesh
      gl.uniform4f(L.u.uColor, 0.35, 0.65, 1, 1);
      gl.cullFace(gl.FRONT);
      this._instances(mesh.vao, this.instBuf, outlineAt * INSTANCE_FLOATS);
      gl.bindVertexArray(mesh.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0, 1);
      gl.cullFace(gl.BACK);
    }
    gl.bindVertexArray(null);
    this.frames++;
  }
}

function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
