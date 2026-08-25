// infrastructure/cabin3d.js — 車内の3Dビュー（WebGL・依存ライブラリなし）
//
// DDD 上の位置づけは SVG ビューとまったく同じ「信頼されない表示アダプタ」。
// ドメインにもアプリケーション層にも一切触れず、AmbientEcu が返す
// effectiveColor(zoneId, now) → {r,g,b,level} だけを読んで描く。
//
// 形状は Unity 版 unity/Scripts/CabinMockRig.cs と同じ座標・同じスケールで、
// 直方体だけで組んである（床/ダッシュ/コンソール/ドア×2/シート×4 + LED×7）。
// そのため Unity クライアントとブラウザで「同じ車内」が出る。
//
// 座標系: Unity は左手系(+x=右)、WebGLのこのカメラは右手系なので、
// シーン構築時に x を反転して見た目の左右を一致させる（v3() が担当）。

// ---- CabinMockRig.cs と一致させたシーン定義 --------------------------------
const v3 = (x, y, z) => [-x, y, z]; // Unity座標 → このレンダラのワールド座標

// 内装はほぼ黒に落としてある。主役は形状ではなく「LEDに照らされた面」なので、
// 素の明るさを持たせるとプリミティブの粗さだけが目立つ。
const TRIM = [0.075, 0.075, 0.090];
const SEAT = [0.090, 0.090, 0.105];
const FLOOR = [0.055, 0.055, 0.068];

const BLOCKS = [
  { pos: v3(0, 0.10, 0), scale: [2.1, 0.05, 3.0], color: FLOOR },
  { pos: v3(0, 0.85, 0.95), scale: [1.9, 0.38, 0.45], color: TRIM },
  { pos: v3(0, 0.42, 0.10), scale: [0.34, 0.42, 1.20], color: TRIM },
  { pos: v3(-1.02, 0.70, 0.10), scale: [0.08, 1.10, 2.6], color: TRIM },
  { pos: v3(1.02, 0.70, 0.10), scale: [0.08, 1.10, 2.6], color: TRIM },
  // シート（左右）
  { pos: v3(-0.45, 0.42, -0.55), scale: [0.55, 0.24, 0.60], color: SEAT },
  { pos: v3(-0.45, 0.82, -0.86), scale: [0.55, 0.80, 0.18], color: SEAT },
  { pos: v3(0.45, 0.42, -0.55), scale: [0.55, 0.24, 0.60], color: SEAT },
  { pos: v3(0.45, 0.82, -0.86), scale: [0.55, 0.80, 0.18], color: SEAT },
  // 以下は Unity のリグには無いが、「車内である」ことが一目で伝わるための手掛かり。
  { pos: v3(0, 1.34, 1.28), scale: [1.94, 0.86, 0.03], color: [0.04, 0.05, 0.08] },   // フロントガラス
  { pos: v3(-0.45, 1.02, 0.80), scale: [0.42, 0.16, 0.06], color: [0.03, 0.04, 0.06] }, // メータークラスタ
  { pos: v3(0.10, 0.99, 0.76), scale: [0.34, 0.21, 0.05], color: [0.03, 0.04, 0.06] },  // センターディスプレイ
  { pos: v3(-0.45, 0.90, 0.56), scale: [0.09, 0.09, 0.09], color: [0.10, 0.10, 0.12] }, // ステアリングのハブ
  ...steeringRim(),
];

// ステアリングのリム。シェーダが回転を持たない（軸並行ボックスのみ）ので、
// 小さなキューブを円周上に並べて輪に見せる。
function steeringRim() {
  const out = [];
  const R = 0.175;
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    out.push({
      pos: v3(-0.45 + R * Math.cos(a), 0.90 + R * Math.sin(a), 0.56),
      scale: [0.05, 0.05, 0.045],
      color: [0.10, 0.10, 0.12],
    });
  }
  return out;
}

// LEDストリップ（= ゾーン）。lightOffset は光源を板の内側に埋めないためのずらし量。
const STRIPS = [
  { id: 'footwell_fl', pos: v3(-0.45, 0.28, 0.55), scale: [0.50, 0.02, 0.05], light: v3(-0.45, 0.16, 0.45) },
  { id: 'footwell_fr', pos: v3(0.45, 0.28, 0.55), scale: [0.50, 0.02, 0.05], light: v3(0.45, 0.16, 0.45) },
  { id: 'door_fl', pos: v3(-0.94, 0.78, 0.10), scale: [0.03, 0.02, 1.40], light: v3(-0.82, 0.83, 0.10) },
  { id: 'door_fr', pos: v3(0.94, 0.78, 0.10), scale: [0.03, 0.02, 1.40], light: v3(0.82, 0.83, 0.10) },
  { id: 'dashboard', pos: v3(0, 1.04, 0.80), scale: [1.70, 0.02, 0.05], light: v3(0, 1.12, 0.65) },
  { id: 'console', pos: v3(0, 0.64, 0.15), scale: [0.06, 0.02, 0.90], light: v3(0, 0.76, 0.15) },
  { id: 'cupholder', pos: v3(0.22, 0.64, -0.25), scale: [0.12, 0.02, 0.12], light: v3(0.22, 0.74, -0.25) },
];

const LIGHT_RANGE = 1.6; // CabinMockRig の lightRange 相当（少し広げてある）

export const VIEWS = {
  // 座席の背もたれ越しに車内を見下ろす角度。ダッシュ/コンソール/足元/ドアが同時に入る。
  overview: { yaw: 0.28, pitch: 0.62, radius: 3.40, target: v3(0, 0.60, 0.35) },
  // 運転席（左座席）から前方を見る視点
  driver: { yaw: 0.10, pitch: 0.10, radius: 1.05, target: v3(-0.30, 0.88, 0.95) },
};

// ---- 最小限の mat4 -------------------------------------------------------
function perspective(fovy, aspect, near, far) {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
}

function lookAt(eye, target, up) {
  const z = norm(sub(eye, target));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ];
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function norm(a) {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

// ---- シェーダ -------------------------------------------------------------
const VERT = `
attribute vec3 aPos;
attribute vec3 aNormal;
uniform mat4 uProj, uView;
uniform vec3 uTranslate, uScale;
varying vec3 vWorld, vNormal;
void main() {
  vec3 world = aPos * uScale + uTranslate;
  vWorld = world;
  // 回転を持たない軸並行ボックスなので、法線はスケールで割るだけでよい
  vNormal = normalize(aNormal / uScale);
  gl_Position = uProj * uView * vec4(world, 1.0);
}`;

const FRAG = `
precision mediump float;
uniform vec3 uBaseColor;
uniform vec3 uEmissive;
uniform vec3 uLightPos[7];
uniform vec3 uLightColor[7];
uniform float uRange;
uniform float uAlpha;
uniform float uUnlit;   // >0.5 でグロー用（陰影・トーンマップを通さず素の色を加算する）
varying vec3 vWorld, vNormal;
void main() {
  if (uUnlit > 0.5) {
    gl_FragColor = vec4(uEmissive, uAlpha);
    return;
  }
  vec3 n = normalize(vNormal);
  vec3 lit = uBaseColor * 0.035;              // 環境光（夜の車内なので暗め）
  for (int i = 0; i < 7; i++) {
    vec3 d = uLightPos[i] - vWorld;
    float dist = length(d);
    float att = max(0.0, 1.0 - dist / uRange);
    att *= att;
    float ndl = max(0.0, dot(n, d / max(dist, 0.0001)));
    lit += uBaseColor * uLightColor[i] * ndl * att;
  }
  vec3 c = lit + uEmissive;
  c = c / (c + vec3(1.4));                    // Reinhard: 明るいゾーンが白飛びしない
  c = pow(c, vec3(1.0 / 2.2));
  gl_FragColor = vec4(c, uAlpha);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) ?? 'shader compile failed');
  }
  return s;
}

// 単位キューブ（-0.5..0.5）。面ごとに法線を持たせるため 24 頂点。
function cubeGeometry() {
  const faces = [
    [[0, 0, 1], [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
    [[0, 0, -1], [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
    [[0, 1, 0], [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]],
    [[0, -1, 0], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
    [[1, 0, 0], [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]],
    [[-1, 0, 0], [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
  ];
  const pos = [];
  const nrm = [];
  const idx = [];
  let base = 0;
  for (const [n, quad] of faces) {
    for (const p of quad) {
      pos.push(p[0] * 0.5, p[1] * 0.5, p[2] * 0.5);
      nrm.push(...n);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    base += 4;
  }
  return { pos: new Float32Array(pos), nrm: new Float32Array(nrm), idx: new Uint16Array(idx) };
}

// ---- レンダラ -------------------------------------------------------------
export class Cabin3D {
  // 初期化に失敗（WebGL非対応など）した場合は create() が null を返す。
  static create(canvas) {
    try {
      const gl = canvas.getContext('webgl', { antialias: true, alpha: false })
        ?? canvas.getContext('experimental-webgl');
      if (!gl) return null;
      return new Cabin3D(canvas, gl);
    } catch {
      return null;
    }
  }

  constructor(canvas, gl) {
    this.canvas = canvas;
    this.gl = gl;
    this.view = 'overview';
    this.cam = { ...VIEWS.overview };

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(prog) ?? 'link failed');
    }
    this.prog = prog;
    gl.useProgram(prog);

    const geo = cubeGeometry();
    this.posBuf = buffer(gl, gl.ARRAY_BUFFER, geo.pos);
    this.nrmBuf = buffer(gl, gl.ARRAY_BUFFER, geo.nrm);
    this.idxBuf = buffer(gl, gl.ELEMENT_ARRAY_BUFFER, geo.idx);
    this.idxCount = geo.idx.length;

    this.aPos = gl.getAttribLocation(prog, 'aPos');
    this.aNormal = gl.getAttribLocation(prog, 'aNormal');
    this.u = {};
    for (const name of ['uProj', 'uView', 'uTranslate', 'uScale', 'uBaseColor', 'uEmissive', 'uRange', 'uAlpha', 'uUnlit']) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }
    this.uLightPos = [];
    this.uLightColor = [];
    for (let i = 0; i < 7; i++) {
      this.uLightPos.push(gl.getUniformLocation(prog, `uLightPos[${i}]`));
      this.uLightColor.push(gl.getUniformLocation(prog, `uLightColor[${i}]`));
    }

    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.02, 0.025, 0.04, 1);

    this._bindDrag();
  }

  setView(name) {
    if (!VIEWS[name]) return;
    this.view = name;
    this.cam = { ...VIEWS[name] };
  }

  // ドラッグで視点回転、ホイールで寄り引き
  _bindDrag() {
    let dragging = false;
    let lx = 0;
    let ly = 0;
    const down = (e) => {
      dragging = true;
      lx = e.clientX ?? e.touches[0].clientX;
      ly = e.clientY ?? e.touches[0].clientY;
    };
    const move = (e) => {
      if (!dragging) return;
      const x = e.clientX ?? e.touches?.[0]?.clientX;
      const y = e.clientY ?? e.touches?.[0]?.clientY;
      if (x == null) return;
      this.cam.yaw += (x - lx) * 0.006;
      this.cam.pitch = Math.max(-0.35, Math.min(1.05, this.cam.pitch + (y - ly) * 0.005));
      lx = x;
      ly = y;
      e.preventDefault();
    };
    const up = () => { dragging = false; };
    this.canvas.addEventListener('mousedown', down);
    this.canvas.addEventListener('touchstart', down, { passive: true });
    window.addEventListener('mousemove', move);
    this.canvas.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('mouseup', up);
    window.addEventListener('touchend', up);
    this.canvas.addEventListener('wheel', (e) => {
      this.cam.radius = Math.max(0.5, Math.min(6, this.cam.radius + e.deltaY * 0.002));
      e.preventDefault();
    }, { passive: false });
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (w > 0 && h > 0 && (this.canvas.width !== w || this.canvas.height !== h)) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    return this.canvas.width / Math.max(1, this.canvas.height);
  }

  // ecu: AmbientEcu（effectiveColor(zoneId, now) を持つもの）
  render(ecu, nowMs) {
    const gl = this.gl;
    const aspect = this._resize();
    gl.useProgram(this.prog);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const { yaw, pitch, radius, target } = this.cam;
    const eye = [
      target[0] + radius * Math.cos(pitch) * Math.sin(yaw),
      target[1] + radius * Math.sin(pitch),
      target[2] - radius * Math.cos(pitch) * Math.cos(yaw),
    ];
    gl.uniformMatrix4fv(this.u.uProj, false, perspective(0.9, aspect, 0.05, 60));
    gl.uniformMatrix4fv(this.u.uView, false, lookAt(eye, target, [0, 1, 0]));
    gl.uniform1f(this.u.uRange, LIGHT_RANGE);

    // 各ゾーンの実効色を1回だけ引いて、光源とストリップ発光の両方に使う
    const zoneColors = STRIPS.map((s) => ecu.effectiveColor(s.id, nowMs));
    for (let i = 0; i < STRIPS.length; i++) {
      const c = zoneColors[i];
      gl.uniform3fv(this.uLightPos[i], STRIPS[i].light);
      const g = c.level * 1.9;
      gl.uniform3fv(this.uLightColor[i], [c.r * g, c.g * g, c.b * g]);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nrmBuf);
    gl.enableVertexAttribArray(this.aNormal);
    gl.vertexAttribPointer(this.aNormal, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);

    // 1) 車内の構造物
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    gl.uniform1f(this.u.uAlpha, 1);
    gl.uniform1f(this.u.uUnlit, 0);
    gl.uniform3f(this.u.uEmissive, 0, 0, 0);
    for (const b of BLOCKS) this._draw(b.pos, b.scale, b.color);

    // 2) LEDストリップ本体（発光）
    for (let i = 0; i < STRIPS.length; i++) {
      const c = zoneColors[i];
      gl.uniform3f(this.u.uEmissive, c.r * c.level * 2.4, c.g * c.level * 2.4, c.b * c.level * 2.4);
      this._draw(STRIPS[i].pos, STRIPS[i].scale, [0.05, 0.05, 0.06]);
    }
    gl.uniform3f(this.u.uEmissive, 0, 0, 0);

    // 3) 加算合成のシェルでハロー（安価なグロー）。奥行き書き込みは切る。
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.depthMask(false);
    gl.uniform1f(this.u.uUnlit, 1);
    // ストリップは最短辺が 0.02 しかないので、膨張量は倍率ではなく絶対値で与える。
    for (const [grow, gain] of [[0.05, 0.5], [0.14, 0.22], [0.34, 0.08]]) {
      for (let i = 0; i < STRIPS.length; i++) {
        const c = zoneColors[i];
        if (c.level < 0.02) continue;
        const s = STRIPS[i].scale;
        gl.uniform1f(this.u.uAlpha, gain * c.level);
        gl.uniform3f(this.u.uEmissive, c.r, c.g, c.b);
        this._draw(STRIPS[i].pos, [s[0] + grow, s[1] + grow, s[2] + grow], [0, 0, 0]);
      }
    }
    gl.uniform1f(this.u.uUnlit, 0);
    gl.uniform1f(this.u.uAlpha, 1);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  _draw(pos, scale, color) {
    const gl = this.gl;
    gl.uniform3fv(this.u.uTranslate, pos);
    gl.uniform3fv(this.u.uScale, scale);
    gl.uniform3fv(this.u.uBaseColor, color);
    gl.drawElements(gl.TRIANGLES, this.idxCount, gl.UNSIGNED_SHORT, 0);
  }
}

function buffer(gl, target, data) {
  const b = gl.createBuffer();
  gl.bindBuffer(target, b);
  gl.bufferData(target, data, gl.STATIC_DRAW);
  return b;
}
