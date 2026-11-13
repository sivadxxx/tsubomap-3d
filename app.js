// ツボマップ3D：皮膚・筋肉・骨の 3 層の人体図に、自分のツボを打って名前と説明を残す
// ツボはログインした人だけが見られる。編集できる人と、見るだけの人がいる（backend-firebase.js）
import * as THREE from 'three';
import { OrbitControls } from './lib/OrbitControls.js';
import { firebaseConfig } from './config.js';
import { createBackend, explain } from './backend-firebase.js';
import { measure } from './kotsudo.js';

const $ = id => document.getElementById(id);
const stage = $('stage'), canvas = $('gl');
const skinIn = $('skin'), muscleIn = $('muscle');
const statusEl = $('status'), loadingEl = $('loading');
const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } } };

// ---------------------------------------------------------------- 描画の準備
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
renderer.setClearColor(0x000000, 0);
renderer.autoClear = false;
const PR = () => Math.min(window.devicePixelRatio || 1, 2);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(26, 1, 40, 30000);
scene.add(camera);
// 光：全体をやわらかく照らす光と、見ている向きに合わせて動く光
scene.add(new THREE.HemisphereLight(0xffffff, 0xcbbfb6, 1.55));
const key = new THREE.DirectionalLight(0xffffff, 1.9);
key.position.set(0.55, 0.75, 1.4);
camera.add(key); camera.add(key.target); key.target.position.set(0, 0, -1);
const fill = new THREE.DirectionalLight(0xffffff, 0.45);
fill.position.set(-1.2, 0.1, 0.6);
camera.add(fill); camera.add(fill.target); fill.target.position.set(0, 0, -1);

// 素材（番号は 人体図3D の export3d.py と同じ）
const COLORS = { 0: 0xf7d6c0, 1: 0xece2c2, 2: 0xf4f0e4, 3: 0xe3e5d6, 4: 0xd97f6e, 5: 0xf2e9d6 };
const materials = {};
for (const k in COLORS) {
  const m = new THREE.MeshStandardMaterial({ color: COLORS[k], roughness: 0.82, metalness: 0, side: THREE.DoubleSide, vertexColors: true });
  // 元データは面の表裏が部品ごとにまちまちなので、表裏に関係なく、いつも見ている側を向いた面として光を当てる
  m.onBeforeCompile = sh => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>',
      '#include <normal_fragment_begin>\n\tnormal = faceforward( normal, - normalize( vViewPosition ), normal );\n\tnonPerturbedNormal = normal;');
  };
  materials[k] = m;
}
const groups = { skin: new THREE.Group(), muscle: new THREE.Group(), bone: new THREE.Group() };
for (const k in groups) { groups[k].visible = false; scene.add(groups[k]); }
const loaded = { skin: false, muscle: false, bone: false };

// 層を 1 枚ずつ別の画面に描いてから、透け具合を掛けて重ねる（半透明どうしの前後が乱れないように）
let target = new THREE.WebGLRenderTarget(4, 4, { samples: 4, depthBuffer: true });
const quadScene = new THREE.Scene(), quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const quadMat = new THREE.ShaderMaterial({
  uniforms: { t: { value: target.texture }, opacity: { value: 1 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: `uniform sampler2D t; uniform float opacity; varying vec2 vUv;
    vec3 toSRGB(vec3 c){ return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c)); }
    void main(){ vec4 c = texture2D(t, vUv); vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
      gl_FragColor = vec4(toSRGB(rgb) * c.a * opacity, c.a * opacity); }`,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  depthTest: false, depthWrite: false, transparent: true,
});
quadScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), quadMat));

// ツボが体の向こう側に回ったら隠すために、皮膚までの距離を小さな画面に描いて読み取る
const depthTarget = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: true });
let depthBuf = new Uint8Array(64), dw = 4, dh = 4;
const depthMat = new THREE.ShaderMaterial({
  uniforms: { far: { value: camera.far } },
  vertexShader: 'varying float vz; void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vz = -mv.z; gl_Position = projectionMatrix * mv; }',
  fragmentShader: `uniform float far; varying float vz;
    void main(){ float v = clamp(vz / far, 0.0, 0.99999) * 255.0; float lo = fract(v) * 255.0;
      gl_FragColor = vec4(floor(v) / 255.0, floor(lo) / 255.0, fract(lo), 1.0); }`,
  side: THREE.DoubleSide,
});
function depthPass() {
  for (const k in groups) groups[k].visible = k === 'skin';
  scene.overrideMaterial = depthMat;
  renderer.setRenderTarget(depthTarget);
  renderer.clear();
  renderer.render(scene, camera);
  scene.overrideMaterial = null;
  renderer.readRenderTargetPixels(depthTarget, 0, 0, dw, dh, depthBuf);
  renderer.setRenderTarget(null);
}

// 部位の選択：'all' = 全身、0 = 体幹、1 = 右腕、2 = 左腕、3 = 右脚、4 = 左脚
let part = 'all';
function applyPart() {
  for (const k in groups) for (const m of groups[k].children) {
    const r = m.userData.region;
    m.visible = part === 'all' ? r !== undefined && (k !== 'skin' || r === 255) : r === part;
    // 陰影は、全身用と「その部位だけ」用を持っている（腕や脚の内側が体幹の陰で暗くならないように）
    m.geometry.setAttribute('color', part === 'all' ? m.userData.colFull : m.userData.colPart);
  }
  dirty = true;
}
function pass(show, opacity) {
  for (const k in groups) groups[k].visible = show.indexOf(k) >= 0 && loaded[k];
  renderer.setRenderTarget(target);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  quadMat.uniforms.opacity.value = opacity;
  renderer.render(quadScene, quadCam);
}
function draw() {
  const s = skinIn.value / 100, m = muscleIn.value / 100;
  const tags = loaded.skin && (anyTagShown() || !!ruler.a);
  if (tags) depthPass();
  renderer.setRenderTarget(null);
  renderer.clear();
  // 上の層に完全に隠れる層は描かない
  if (s < 1 && m < 1 && loaded.bone) pass(['bone'], 1);
  if (s < 1 && m > 0 && loaded.muscle) pass(['muscle', 'bone'], m);      // 筋肉の層には骨も一緒に描いて、前後関係を正しくする
  if (s > 0 && loaded.skin) pass(['skin'], s);
  placeTags(tags);
}

// ---------------------------------------------------------------- 視点の操作
const CENTER = new THREE.Vector3(0, 780, 95);     // 体の中心（mm）
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.rotateSpeed = 0.9;
controls.zoomSpeed = 1.1;
controls.zoomToCursor = true;
controls.screenSpacePanning = true;
controls.minDistance = 180;
controls.maxDistance = 9000;
const DIRS = { front: [0, 0, 1], back: [0, 0, -1], right: [-1, 0, 0], left: [1, 0, 0] };   // 右側 = 本人の右から見る
function fitDistance() {            // 全身が入る距離
  const h = 1840, w = 800, t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  return Math.max(h / 2 / t, w / 2 / (t * camera.aspect)) * 1.03;
}
let anim = null;
let dirty = true;
let focus = { center: CENTER.clone(), dist: null };     // いま見ている部位の中心と、全体が入る距離
function goTo(dir, instant) {
  const d = dir ? new THREE.Vector3(...DIRS[dir]) : camera.position.clone().sub(controls.target).normalize();
  const to = focus.center.clone().addScaledVector(d, focus.dist || fitDistance());
  if (instant) { camera.position.copy(to); controls.target.copy(focus.center); controls.update(); dirty = true; return; }
  anim = { t0: performance.now(), p0: camera.position.clone(), p1: to, c0: controls.target.clone(), c1: focus.center.clone() };
}
function setPart(p, stay) {
  part = p;
  document.querySelectorAll('[data-part]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.part === String(p))));
  applyPart();
  renderList();
  if (p === 'all') { focus = { center: CENTER.clone(), dist: null }; }
  else {      // 選んだ部位を囲む球が画面に収まる距離
    const box = new THREE.Box3();
    for (const k in groups) for (const m of groups[k].children) if (m.userData.region === p) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrix)); }
    if (box.isEmpty()) return;
    const sph = box.getBoundingSphere(new THREE.Sphere());
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    focus = { center: sph.center, dist: sph.radius / Math.sin(Math.atan(t * Math.min(1, camera.aspect))) * 1.02 };
  }
  if (!stay) goTo(null);
}
document.querySelectorAll('[data-part]').forEach(b => b.addEventListener('click', () => setPart(b.dataset.part === 'all' ? 'all' : +b.dataset.part)));
document.querySelectorAll('[data-dir]').forEach(b => b.addEventListener('click', () => goTo(b.dataset.dir)));
$('zreset').addEventListener('click', () => goTo('front'));
function dolly(f) {
  const v = camera.position.clone().sub(controls.target);
  v.setLength(THREE.MathUtils.clamp(v.length() * f, controls.minDistance, controls.maxDistance));
  camera.position.copy(controls.target).add(v); dirty = true;
}
$('zin').addEventListener('click', () => dolly(1 / 1.35));
$('zout').addEventListener('click', () => dolly(1.35));

// ---------------------------------------------------------------- 透過スライダー
function applyLayers() {
  $('skinOut').textContent = skinIn.value + '%';
  $('muscleOut').textContent = muscleIn.value + '%';
  store.set('tsubomap3d-layers', skinIn.value + ',' + muscleIn.value);
  dirty = true;
}
skinIn.addEventListener('input', applyLayers); muscleIn.addEventListener('input', applyLayers);
document.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
  const p = b.dataset.preset.split(','); skinIn.value = p[0]; muscleIn.value = p[1]; applyLayers();
}));
const savedLayers = store.get('tsubomap3d-layers');
if (savedLayers && /^\d+,\d+$/.test(savedLayers)) { const p = savedLayers.split(','); skinIn.value = p[0]; muscleIn.value = p[1]; }
applyLayers();

// ================================================================ ツボ
// ツボは体の表面（皮膚）に付く。位置は図の座標（mm）で持ち、共有の保存先（Firebase）に置く
// 「図に表示する・隠す」は人それぞれなので、端末ごとに覚える
const HIDE = 'tsubomap3d-hidden';
const DRAFT = '__draft';
let backend = null;         // ログインと保存先
let role = null;            // 'owner'（管理者）・'editor'（編集もできる）・'viewer'（見るだけ）。ログイン前は null
const canEdit = () => role === 'owner' || role === 'editor';
let hiddenIds = new Set();
try { hiddenIds = new Set(JSON.parse(store.get(HIDE) || '[]')); } catch (e) {}
let points = [];            // { id, name, note, p:[x,y,z], n:[x,y,z], region, created, show }
let draft = null;           // 打ったばかりで、まだ保存していないツボ { p, n, region }
let selId = null;           // カードを開いているツボ（DRAFT のこともある）
let pen = false;            // ペン（ツボを打つ）を使っているか
let movingId = null;        // 位置を直しているツボ
let ready = false;          // モデルがそろって、ツボを打てる状態か
const tagEls = new Map();
const tagsEl = $('tags'), listEl = $('list'), guideEl = $('guide'), cardEl = $('card');

const num = v => typeof v === 'number' && isFinite(v);
const vec3ok = a => Array.isArray(a) && a.length === 3 && a.every(num);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function clean(o) {         // 保存データ・読み込んだファイルの 1 件を確かめて整える
  if (!o || typeof o !== 'object' || !vec3ok(o.p)) return null;
  const n = vec3ok(o.n) ? new THREE.Vector3(...o.n) : new THREE.Vector3(0, 0, 1);
  if (n.lengthSq() < 1e-6) n.set(0, 0, 1);
  n.normalize();
  const region = Number.isInteger(o.region) && o.region >= 0 && o.region <= 4 ? o.region : (partVerts ? nearestRegion(new THREE.Vector3(...o.p)) : 0);
  const id = typeof o.id === 'string' && o.id && o.id !== DRAFT ? o.id.slice(0, 40) : uid();
  return {
    id, created: num(o.created) ? o.created : Date.now(),
    name: String(o.name == null ? '' : o.name).slice(0, 40) || 'ツボ',
    note: String(o.note == null ? '' : o.note).slice(0, 1000),
    p: o.p.map(v => Math.round(v * 10) / 10), n: n.toArray().map(v => Math.round(v * 1000) / 1000),
    region, show: !hiddenIds.has(id),
  };
}
const byAge = (a, b) => a.created - b.created || (a.id < b.id ? -1 : 1);
function setPoints(arr) {   // 保存先から届いたツボで、画面を作り直す（ほかの人・ほかの端末の編集もここに届く）
  points = arr.map(clean).filter(Boolean).sort(byAge);
  if (selId && selId !== DRAFT && !points.some(p => p.id === selId)) closeCard();
  if (movingId && !points.some(p => p.id === movingId)) { movingId = null; stage.classList.toggle('penon', pen); showGuide(); }
  syncTags(); renderList();
  const pt = points.find(p => p.id === selId);
  if (pt) { select(selId); if (!$('cardView').hidden) { cvName.textContent = pt.name; cvNote.textContent = pt.note || '説明はまだありません'; cvNote.classList.toggle('none', !pt.note); } }
}
function pushPoint(pt) {    // 1 件を保存先に送る
  if (!backend || !canEdit()) return;
  backend.savePoint(pt).catch(e => toast('保存できませんでした：' + explain(e)));
}
function saveHidden() {
  hiddenIds = new Set(points.filter(p => !p.show).map(p => p.id));
  store.set(HIDE, JSON.stringify([...hiddenIds]));
}

// ---- 図の上のタグ
function makeTag(id) {
  const el = document.createElement('div'); el.className = 'tag'; el.hidden = true;
  const pin = document.createElement('span'); pin.className = 'pin';
  const name = document.createElement('button'); name.type = 'button'; name.className = 'name';
  el.append(pin, name);
  const open = e => {
    e.stopPropagation();
    if (id === DRAFT || movingId) return;
    const pt = points.find(q => q.id === id);
    if (ruler.on && pt) rulerAdd({ p: pt.p, n: pt.n });      // ものさしを使っているときは、ツボを測る点として選ぶ
    else openView(id);
  };
  pin.addEventListener('click', open); name.addEventListener('click', open);
  tagsEl.append(el); tagEls.set(id, el);
  return el;
}
function syncTags() {       // ツボの増減・名前の変更をタグに反映する
  const want = new Set(points.map(p => p.id)); if (draft) want.add(DRAFT);
  for (const [id, el] of tagEls) if (!want.has(id)) { el.remove(); tagEls.delete(id); }
  for (const pt of points) {
    const el = tagEls.get(pt.id) || makeTag(pt.id);
    el.lastChild.textContent = pt.name; el.lastChild.title = pt.note;
    el.classList.toggle('sel', selId === pt.id);
  }
  if (draft) { const el = tagEls.get(DRAFT) || makeTag(DRAFT); el.classList.add('draft'); el.lastChild.textContent = '新しいツボ'; }
  dirty = true;
}
const shownHere = pt => pt.show && (part === 'all' || pt.region === part);
function anyTagShown() { return !!draft || points.some(shownHere); }
const _v = new THREE.Vector3(), _c = new THREE.Vector3();
function project(p, n) {    // 画面上の位置を返す。体の向こう側・画面の外なら null
  _v.set(p[0], p[1], p[2]);
  const dx = _c.x - _v.x, dy = _c.y - _v.y, dz = _c.z - _v.z;
  if (n && (n[0] * dx + n[1] * dy + n[2] * dz) / Math.hypot(dx, dy, dz) < -0.15) return null;      // 面が向こうを向いている
  _v.applyMatrix4(camera.matrixWorldInverse);
  const vz = -_v.z;
  if (vz < camera.near) return null;
  _v.applyMatrix4(camera.projectionMatrix);
  if (Math.abs(_v.x) > 1.02 || Math.abs(_v.y) > 1.02) return null;
  const u = _v.x * 0.5 + 0.5, w = _v.y * 0.5 + 0.5;
  const px = Math.floor(u * dw), py = Math.floor(w * dh);
  let far = -1;             // まわり 3×3 のうち、いちばん遠い皮膚までの距離
  for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
    const x = px + i, y = py + j;
    if (x < 0 || y < 0 || x >= dw || y >= dh) continue;
    const o = (y * dw + x) * 4;
    if (!depthBuf[o + 3]) continue;
    const d = (depthBuf[o] + (depthBuf[o + 1] + depthBuf[o + 2] / 255) / 255) / 255 * camera.far;
    if (d > far) far = d;
  }
  if (far >= 0 && vz > far + 8) return null;       // 手前に体がある
  return { x: u * stage.clientWidth, y: (1 - w) * stage.clientHeight };
}
function placeTags(on) {
  if (on) _c.setFromMatrixPosition(camera.matrixWorld);
  for (const pt of points) {
    const el = tagEls.get(pt.id); if (!el) continue;
    const s = on && shownHere(pt) ? project(pt.p, pt.n) : null;
    el.hidden = !s;
    if (s) el.style.transform = `translate(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px)`;
  }
  if (draft) {
    const el = tagEls.get(DRAFT), s = on && el ? project(draft.p, draft.n) : null;
    if (el) { el.hidden = !s; if (s) el.style.transform = `translate(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px)`; }
  }
  placeRuler(on);
}

// ---- 一覧
function renderList() {
  listEl.textContent = '';
  for (const pt of points) {
    const li = document.createElement('li'); li.classList.toggle('sel', selId === pt.id);
    const b = document.createElement('button'); b.type = 'button'; b.className = 'btn item';
    b.classList.toggle('other', part !== 'all' && pt.region !== part);
    b.setAttribute('aria-pressed', String(pt.show)); b.title = pt.show ? '図から隠す' : '図に表示する';
    const dot = document.createElement('span'); dot.className = 'dot';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = pt.name;
    b.append(dot, nm);
    b.addEventListener('click', () => { pt.show = !pt.show; saveHidden(); renderList(); dirty = true; });
    const more = document.createElement('button'); more.type = 'button'; more.className = 'btn more'; more.textContent = '詳細';
    more.setAttribute('aria-label', pt.name + ' の詳細');
    more.addEventListener('click', () => { openView(pt.id); lookAt(pt); });
    li.append(b, more); listEl.append(li);
  }
  $('count').textContent = points.length ? `${points.length} 件` : '';
  $('empty').hidden = points.length > 0;
  $('showAll').disabled = $('hideAll').disabled = $('exportBtn').disabled = !points.length;
  $('two1').hidden = !points.length && !canEdit();
}
function setAll(on) { for (const pt of points) pt.show = on; saveHidden(); renderList(); dirty = true; }
$('showAll').addEventListener('click', () => setAll(true));
$('hideAll').addEventListener('click', () => setAll(false));
function lookAt(pt) {       // そのツボを正面から見る位置へ回り込む
  if (part !== 'all' && pt.region !== part) setPart('all', true);
  const c1 = new THREE.Vector3(...pt.p), dist = Math.min(camera.position.distanceTo(controls.target), 1400);
  anim = { t0: performance.now(), p0: camera.position.clone(), p1: c1.clone().addScaledVector(new THREE.Vector3(...pt.n), dist), c0: controls.target.clone(), c1 };
}

// ---- 案内
let toastTimer = 0, toasting = false;
function showGuide() {      // カードを開いている間は、じゃまにならないように案内を消す
  if (toasting) return;
  const msg = !cardEl.hidden ? '' : movingId ? '新しい位置をタップしてください' : pen ? '体の表面をタップするとツボを打てます'
    : !ruler.on ? '' : !ruler.a ? '測りはじめの点をタップしてください（ツボのタグも選べます）' : !ruler.b ? '測り終わりの点をタップしてください' : '';
  guideEl.classList.remove('warn');
  guideEl.textContent = msg; guideEl.hidden = !msg;
}
function toast(msg) {
  clearTimeout(toastTimer); toasting = true;
  guideEl.classList.add('warn'); guideEl.textContent = msg; guideEl.hidden = false;
  toastTimer = setTimeout(() => { toasting = false; showGuide(); }, 2800);
}

// ---- ペン
function setPen(on) {
  pen = on && ready && canEdit();
  if (pen && ruler.on) setRuler(false);
  if (!pen && draft) { draft = null; if (selId === DRAFT) closeCard(); syncTags(); }
  if (pen) movingId = null;
  for (const id of ['penBtn', 'penBtn2']) $(id).setAttribute('aria-pressed', String(pen));
  $('penLabel').textContent = pen ? 'ペンを終了' : 'ツボを打つ';
  $('penBtn2').setAttribute('aria-label', pen ? 'ペンを終了' : 'ツボを打つ');
  stage.classList.toggle('penon', pen || !!movingId);
  showGuide();
}
$('penBtn').addEventListener('click', () => setPen(!pen));
$('penBtn2').addEventListener('click', () => setPen(!pen));

// ---- ものさし：体の表面の 2 点の間を、表面に沿って測り、その部位の骨度で寸に直す
const ruler = { on: false, a: null, b: null, path: null };      // a, b: { p:[x,y,z], n:[x,y,z] }、path: 表面に沿った点の並び
let skinTri = null;         // 全身の皮膚の三角形（頂点 9 個ずつ）と、その中心
function buildSkinTris() {
  const m = groups.skin.children.find(x => x.userData.region === 255);
  const pos = m.geometry.attributes.position, idx = m.geometry.index.array, n = idx.length / 3;
  const V = new Float32Array(n * 9), C = new Float32Array(n * 3), v = new THREE.Vector3();
  for (let i = 0; i < idx.length; i++) { v.fromBufferAttribute(pos, idx[i]).applyMatrix4(m.matrix); V[i * 3] = v.x; V[i * 3 + 1] = v.y; V[i * 3 + 2] = v.z; }
  for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) C[t * 3 + k] = (V[t * 9 + k] + V[t * 9 + 3 + k] + V[t * 9 + 6 + k]) / 3;
  skinTri = { V, C, n };
}
function lineHit(o, d, sub) {       // 点 o を通る向き d の直線が皮膚と交わるところ。前向き・後ろ向きそれぞれ、いちばん近いもの
  const V = skinTri.V; let tp = Infinity, ip = -1, tm = Infinity, im = -1;
  for (let s = 0; s < sub.length; s++) {
    const k = sub[s] * 9;
    const ax = V[k], ay = V[k + 1], az = V[k + 2];
    const e1x = V[k + 3] - ax, e1y = V[k + 4] - ay, e1z = V[k + 5] - az, e2x = V[k + 6] - ax, e2y = V[k + 7] - ay, e2z = V[k + 8] - az;
    const px = d.y * e2z - d.z * e2y, py = d.z * e2x - d.x * e2z, pz = d.x * e2y - d.y * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-9 && det < 1e-9) continue;
    const inv = 1 / det, tx = o.x - ax, ty = o.y - ay, tz = o.z - az;
    const u = (tx * px + ty * py + tz * pz) * inv; if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const w = (d.x * qx + d.y * qy + d.z * qz) * inv; if (w < 0 || u + w > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t >= 0) { if (t < tp) { tp = t; ip = sub[s]; } } else if (-t < tm) { tm = -t; im = sub[s]; }
  }
  return { tp, ip, tm, im };
}
function surfacePath(a, b) {        // 2 点の間を半分ずつに割りながら、まん中の点を皮膚の上へ押し出していく
  const A = new THREE.Vector3(...a.p), B = new THREE.Vector3(...b.p), len = A.distanceTo(B);
  if (len < 0.5) return [A, B];
  const ab = B.clone().sub(A), R = len * 0.6 + 25, R2 = R * R, C = skinTri.C, sub = [];
  for (let t = 0; t < skinTri.n; t++) {      // 2 点を結ぶ線の近くにある三角形だけを相手にする
    const cx = C[t * 3] - A.x, cy = C[t * 3 + 1] - A.y, cz = C[t * 3 + 2] - A.z;
    const u = Math.min(1, Math.max(0, (cx * ab.x + cy * ab.y + cz * ab.z) / (len * len)));
    const dx = cx - ab.x * u, dy = cy - ab.y * u, dz = cz - ab.z * u;
    if (dx * dx + dy * dy + dz * dz < R2) sub.push(t);
  }
  const V = skinTri.V, view = camera.position.clone();
  const split = (p0, n0, p1, n1, depth, out) => {
    if (!depth) return;
    const mid = p0.clone().add(p1).multiplyScalar(0.5), dir = n0.clone().add(n1);
    if (dir.length() < 0.35) {      // 体をはさんで反対側どうし：見ている側を回る道にする
      const e = p1.clone().sub(p0).normalize(); dir.copy(view).sub(mid); dir.addScaledVector(e, -dir.dot(e));
    }
    dir.normalize();
    const h = lineHit(mid, dir, sub);
    // まん中の点は、ふつうは体の中にある（外へ向かって皮膚に出る）。くぼんだ所では体の外にある（内へ向かって皮膚に当たる）
    const fwd = h.ip >= 0 && (h.im < 0 || h.tp <= 2.5 * h.tm + 5), tri = fwd ? h.ip : h.im;
    let pm = mid, nm = dir;
    if (tri >= 0) {
      pm = mid.clone().addScaledVector(dir, fwd ? h.tp : -h.tm);
      const k = tri * 9, e1 = new THREE.Vector3(V[k + 3] - V[k], V[k + 4] - V[k + 1], V[k + 5] - V[k + 2]), e2 = new THREE.Vector3(V[k + 6] - V[k], V[k + 7] - V[k + 1], V[k + 8] - V[k + 2]);
      nm = e1.cross(e2).normalize(); if (nm.dot(dir) < 0) nm.negate();
    }
    split(p0, n0, pm, nm, depth - 1, out); out.push(pm); split(pm, nm, p1, n1, depth - 1, out);
  };
  const out = [A];
  split(A, new THREE.Vector3(...a.n), B, new THREE.Vector3(...b.n), len < 12 ? 2 : len < 50 ? 3 : len < 160 ? 4 : 5, out);
  out.push(B);
  return out;
}
const _rp = new THREE.Vector3();
function rulerAdd(h) {
  if (!ruler.a || ruler.b) { ruler.a = h; ruler.b = null; ruler.path = null; }
  else {
    ruler.b = h; ruler.path = surfacePath(ruler.a, h);
    const r = measure(ruler.path, (x, y, z) => nearestRegion(_rp.set(x, y, z)));
    $('mSun').textContent = r.sun.toFixed(1) + '寸'; $('mCm').textContent = (r.mm / 10).toFixed(1) + ' cm';
    $('rlabel').textContent = r.sun.toFixed(1) + '寸';
    const ul = $('mZones'); ul.textContent = '';
    for (const z of r.zones) { const li = document.createElement('li'); li.textContent = z; ul.append(li); }
    ruler.result = r;
  }
  $('measure').hidden = !ruler.b;
  showGuide(); dirty = true;
}
function clearRuler() { ruler.a = ruler.b = ruler.path = ruler.result = null; $('measure').hidden = true; showGuide(); dirty = true; }
function setRuler(on) {
  ruler.on = on && ready && session.state === 'in';
  if (ruler.on && pen) setPen(false);
  if (ruler.on) { movingId = null; if (!cardEl.hidden) closeCard(); }
  if (!ruler.on && !ruler.b) clearRuler();        // 測りかけはやめる。測り終えた結果は、消すまで残す
  for (const id of ['rulerBtn', 'rulerBtn2']) $(id).setAttribute('aria-pressed', String(ruler.on));
  $('rulerLabel').textContent = ruler.on ? '測るのを終了' : '寸を測る';
  $('rulerBtn2').setAttribute('aria-label', ruler.on ? '測るのを終了' : '寸を測る');
  stage.classList.toggle('penon', ruler.on || pen || !!movingId);
  showGuide();
}
$('rulerBtn').addEventListener('click', () => setRuler(!ruler.on));
$('rulerBtn2').addEventListener('click', () => setRuler(!ruler.on));
$('mClear').addEventListener('click', clearRuler);
function placeRuler(on) {           // 測った線と両端の点を、図の上に重ねて描く（体の向こう側に回った部分は描かない）
  const A = $('rpinA'), B = $('rpinB'), lab = $('rlabel'), line = $('rline');
  const put = (el, q) => { const s = on && q ? project(q, null) : null; el.hidden = !s; if (s) el.style.transform = `translate(${s.x.toFixed(1)}px,${s.y.toFixed(1)}px)`; return s; };
  put(A, ruler.a && ruler.a.p); put(B, ruler.b && ruler.b.p);
  let d = '', pen2 = false;
  if (on && ruler.path) for (const q of ruler.path) {
    const s = project([q.x, q.y, q.z], null);
    if (s) { d += (pen2 ? 'L' : 'M') + s.x.toFixed(1) + ' ' + s.y.toFixed(1); pen2 = true; } else pen2 = false;
  }
  line.setAttribute('d', d);
  const mid = ruler.path && ruler.path[ruler.path.length >> 1];
  put(lab, mid && [mid.x, mid.y, mid.z]);
}

// ---- 体の表面を探す
const ray = new THREE.Raycaster(), _ndc = new THREE.Vector2();
let partVerts = null;       // 部位ごとの皮膚の頂点（どの部位のツボかを決めるのに使う）
function buildPartVerts() {
  partVerts = groups.skin.children.filter(m => m.userData.region !== 255).map(m => {
    const pos = m.geometry.attributes.position, a = new Float32Array(pos.count * 3), v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(m.matrix); a[i * 3] = v.x; a[i * 3 + 1] = v.y; a[i * 3 + 2] = v.z; }
    return { region: m.userData.region, a };
  });
}
function nearestRegion(p) {
  let best = Infinity, region = 0;
  for (const pv of partVerts) {
    const a = pv.a;
    for (let i = 0; i < a.length; i += 3) {
      const dx = a[i] - p.x, dy = a[i + 1] - p.y, dz = a[i + 2] - p.z, d = dx * dx + dy * dy + dz * dz;
      if (d < best) { best = d; region = pv.region; }
    }
  }
  return region;
}
function pick(cx, cy) {     // 画面の点から体の表面を探す。{p, n, region}、切り口なら {cap:true}、体の外なら null
  const r = canvas.getBoundingClientRect();
  _ndc.set((cx - r.left) / r.width * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
  camera.updateMatrixWorld();
  ray.setFromCamera(_ndc, camera);
  const full = groups.skin.children.filter(m => m.userData.region === 255);
  const shown = part === 'all' ? full : groups.skin.children.filter(m => m.userData.region === part);
  const hit = ray.intersectObjects(shown, false)[0];
  if (!hit) return null;
  // 部位だけを表示しているとき、切り口（体の中）には打てない：全身の皮膚の上にある点だけを受け付ける
  if (part !== 'all' && !ray.intersectObjects(full, false).some(f => f.point.distanceTo(hit.point) < 4)) return { cap: true };
  const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
  if (n.dot(ray.ray.direction) > 0) n.negate();       // いつも見ている側を向ける
  return { p: hit.point.toArray().map(v => Math.round(v * 10) / 10), n: n.toArray().map(v => Math.round(v * 1000) / 1000), region: part === 'all' ? nearestRegion(hit.point) : part };
}
function onTap(cx, cy) {
  if (!ready) return;
  if (ruler.on) {
    const h = pick(cx, cy);
    if (!h) toast('体の表面をタップしてください'); else if (h.cap) toast('切り口は測れません。皮膚の上をタップしてください'); else rulerAdd(h);
    return;
  }
  if (!canEdit() || (!pen && !movingId)) { if (selId && $('cardEdit').hidden) closeCard(); return; }
  const h = pick(cx, cy);
  if (!h) { toast('体の表面をタップしてください'); return; }
  if (h.cap) { toast('切り口には打てません。皮膚の上をタップしてください'); return; }
  if (movingId) {
    const pt = points.find(q => q.id === movingId);
    movingId = null; stage.classList.toggle('penon', pen);
    if (pt) { pt.p = h.p; pt.n = h.n; pt.region = h.region; pt.show = true; saveHidden(); pushPoint(pt); renderList(); openView(pt.id); }
    showGuide(); dirty = true;
    return;
  }
  const fresh = !draft;
  draft = h;
  if (fresh || selId !== DRAFT) openEdit(DRAFT);      // 入力中にもう一度タップしたら、位置だけ打ち直す
  else sideCard(draft.p);
  syncTags();
}
// タップとドラッグ（回転）を見分ける
let down = null; const active = new Set();
canvas.addEventListener('pointerdown', e => {
  active.add(e.pointerId);
  down = active.size === 1 && e.button === 0 ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), type: e.pointerType } : null;
});
canvas.addEventListener('pointerup', e => {
  active.delete(e.pointerId);
  const d = down; down = null;
  if (d && d.id === e.pointerId && performance.now() - d.t < 700 && Math.hypot(e.clientX - d.x, e.clientY - d.y) < (d.type === 'mouse' ? 4 : 10)) onTap(e.clientX, e.clientY);
});
canvas.addEventListener('pointercancel', e => { active.delete(e.pointerId); down = null; });

// ---- 名前と説明のカード
const cvName = $('cvName'), cvNote = $('cvNote'), ceName = $('ceName'), ceNote = $('ceNote'), ceDelete = $('ceDelete');
let armTimer = 0;
function disarm() { clearTimeout(armTimer); ceDelete.classList.remove('armed'); ceDelete.textContent = '削除'; }
function select(id) {
  selId = id;
  for (const [k, el] of tagEls) el.classList.toggle('sel', k === id);
  for (const li of listEl.children) li.classList.remove('sel');
  const i = points.findIndex(p => p.id === id);
  if (i >= 0 && listEl.children[i]) { listEl.children[i].classList.add('sel'); listEl.children[i].scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
}
function sideCard(p) {       // カードは、ツボと反対側に出す（打った点が隠れないように）
  _v.set(p[0], p[1], p[2]).project(camera);
  cardEl.classList.toggle('left', _v.x > 0);
}
function openView(id) {
  const pt = points.find(p => p.id === id); if (!pt) return;
  if (draft) { draft = null; syncTags(); }
  select(id); disarm();
  cvName.textContent = pt.name;
  cvNote.textContent = pt.note || '説明はまだありません'; cvNote.classList.toggle('none', !pt.note);
  $('cardView').hidden = false; $('cardEdit').hidden = true; cardEl.hidden = false;
  sideCard(pt.p); showGuide();
}
function openEdit(id) {
  const pt = id === DRAFT ? { name: '', note: '' } : points.find(p => p.id === id); if (!pt) return;
  select(id); disarm();
  ceName.value = pt.name; ceNote.value = pt.note;
  $('ceMore').hidden = id === DRAFT;
  $('cardView').hidden = true; $('cardEdit').hidden = false; cardEl.hidden = false;
  sideCard(id === DRAFT ? draft.p : pt.p); showGuide();
  ceName.focus({ preventScroll: true }); if (id !== DRAFT) ceName.select();
}
function closeCard() {
  disarm(); cardEl.hidden = true; select(null);
  if (draft) { draft = null; syncTags(); }
  showGuide();
}
function autoName() { let i = points.length + 1; while (points.some(p => p.name === 'ツボ' + i)) i++; return 'ツボ' + i; }
function applyEdit() {      // 入力中の名前と説明を保存する。保存したツボを返す
  const name = ceName.value.trim().slice(0, 40), note = ceNote.value.trim().slice(0, 1000);
  let pt;
  if (selId === DRAFT) {
    if (!draft) return null;
    pt = { id: uid(), created: Date.now(), name: name || autoName(), note, p: draft.p, n: draft.n, region: draft.region, show: true };
    points.push(pt); draft = null;
  } else {
    pt = points.find(p => p.id === selId); if (!pt) return null;
    pt.name = name || pt.name; pt.note = note;
  }
  pushPoint(pt); syncTags(); renderList();
  return pt;
}
$('cardEdit').addEventListener('submit', e => {
  e.preventDefault();
  const wasNew = selId === DRAFT, pt = applyEdit();
  if (!pt) { closeCard(); return; }
  if (wasNew) { closeCard(); canvas.focus({ preventScroll: true }); }      // 続けて次のツボを打てるように閉じる
  else openView(pt.id);
});
$('ceCancel').addEventListener('click', () => { if (selId === DRAFT) closeCard(); else openView(selId); });
$('cvEdit').addEventListener('click', () => { if (canEdit()) openEdit(selId); });
$('cvClose').addEventListener('click', closeCard);
$('ceMove').addEventListener('click', () => {
  const pt = applyEdit(); if (!pt) return;
  if (pen) setPen(false);
  if (ruler.on) setRuler(false);
  movingId = pt.id; closeCard();
  stage.classList.add('penon'); showGuide();
});
ceDelete.addEventListener('click', () => {
  if (!ceDelete.classList.contains('armed')) {       // 押し間違いで消えないように、2 回押して削除する
    ceDelete.classList.add('armed'); ceDelete.textContent = 'もう一度押すと削除';
    armTimer = setTimeout(disarm, 4000);
    return;
  }
  const id = selId;
  points = points.filter(p => p.id !== id);
  if (backend) backend.deletePoint(id).catch(e => toast('削除できませんでした：' + explain(e)));
  closeCard(); syncTags(); renderList();
});
window.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!membersEl.hidden) closeMembers();
  else if (!cardEl.hidden) { if (selId === DRAFT || $('cardEdit').hidden) closeCard(); else openView(selId); }
  else if (movingId) { movingId = null; stage.classList.toggle('penon', pen); showGuide(); }
  else if (pen) setPen(false);
  else if (ruler.on) setRuler(false);
});

// ---- ファイルへの書き出しと読み込み（控え・ほかの端末への引っ越し用）
$('exportBtn').addEventListener('click', () => {
  const d = new Date(), z = v => String(v).padStart(2, '0');
  const out = points.map(({ show, ...rest }) => rest);
  const blob = new Blob([JSON.stringify({ app: 'tsubomap3d', version: 1, exported: d.toISOString(), points: out }, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `tsubo-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const d = JSON.parse(await f.text());
    const got = (Array.isArray(d) ? d : d && Array.isArray(d.points) ? d.points : null);
    if (!got) throw new Error('形式が違います');
    const add = got.map(clean).filter(Boolean);
    if (!add.length) throw new Error('ツボが入っていません');
    let fresh = 0;      // 同じツボ（同じ番号）は上書きし、それ以外は追加する
    if (!canEdit()) throw new Error('編集できる人だけが読み込めます');
    for (const pt of add) { const i = points.findIndex(q => q.id === pt.id); if (i >= 0) points[i] = pt; else { points.push(pt); fresh++; } pushPoint(pt); }
    points.sort(byAge); closeCard(); syncTags(); renderList();
    toast(`${add.length} 件を読み込みました（新しく追加 ${fresh} 件）`);
  } catch (err) { toast('読み込めませんでした：' + (err.message || err)); }
});

syncTags(); renderList();

// ---- ログインの仕組みを入れる前に、この端末だけに保存していたツボを、共有の保存先へ取り込む
const OLD = 'tsubomap3d-points-v1';
const isMock = location.hostname === 'localhost' && new URLSearchParams(location.search).has('mock');     // 動作確認用
function oldLocal() { try { const d = JSON.parse(store.get(OLD) || 'null'); return d && Array.isArray(d.points) ? d.points : []; } catch (e) { return []; } }
function renderCarry() {
  const n = canEdit() && !isMock ? oldLocal().length : 0;
  $('carryBtn').hidden = !n; $('carryBtn').textContent = `この端末に残っているツボ ${n} 件を取り込む`;
}
$('carryBtn').addEventListener('click', () => {
  const raw = store.get(OLD), add = oldLocal().map(clean).filter(Boolean);
  for (const pt of add) { if (!points.some(q => q.id === pt.id)) points.push(pt); pushPoint(pt); }
  points.sort(byAge);
  store.set(OLD + '-moved', raw); try { localStorage.removeItem(OLD); } catch (e) {}      // 元のデータは別名で残しておく
  syncTags(); renderList(); renderCarry(); toast(`${add.length} 件を取り込みました`);
});

// ================================================================ ログイン
const gate = $('gate'), gateMsg = $('gateMsg'), gateErr = $('gateErr'), authForm = $('authForm'), gateWait = $('gateWait');
const auEmail = $('auEmail'), auPw = $('auPw');
const ROLE_NAMES = { owner: '管理者', editor: '編集もできる', viewer: '見るだけ' };
let session = { state: 'loading' }, authMode = 'login', unsubPoints = null, unsubMembers = null;
function note(el, msg, ok) { el.textContent = msg || ''; el.classList.toggle('ok', !!ok); }
function renderGate() {
  const s = session.state;
  gate.hidden = s === 'in';
  authForm.hidden = s !== 'out'; gateWait.hidden = !(s === 'unverified' || s === 'denied');
  $('resendBtn').hidden = s !== 'unverified';
  if (s === 'out') {
    const m = authMode;
    gateMsg.textContent = m === 'signup' ? '登録するメールアドレスと、パスワード（8文字以上）を決めて入れてください。管理者の許可が出ているアドレスだけが、ツボを見られます。'
      : m === 'reset' ? '登録したメールアドレスを入れてください。パスワードを決め直すためのメールを送ります。'
      : 'メールアドレスとパスワードでログインしてください。';
    $('auPwField').hidden = m === 'reset';
    auPw.autocomplete = m === 'signup' ? 'new-password' : 'current-password';
    $('auSubmit').textContent = m === 'signup' ? '登録する' : m === 'reset' ? 'メールを送る' : 'ログイン';
    $('toSignup').hidden = $('toReset').hidden = m !== 'login'; $('toLogin').hidden = m === 'login';
  } else if (s === 'unverified') gateMsg.textContent = `${session.email} に確認のメールを送りました。メールの中のリンクを開いてから、「確かめる」を押してください。届かないときは、迷惑メールの中も見てください。`;
  else if (s === 'denied') gateMsg.textContent = `${session.email} には、まだツボを見る許可が出ていません。管理者にこのメールアドレスを伝えて、許可をもらってください。許可が出たら「確かめる」を押してください。`;
  else if (s === 'setup') gateMsg.textContent = 'まだ準備中です（ログインの設定が済んでいません）。';
  else if (s === 'error') gateMsg.textContent = '始められませんでした。通信の状態を確かめて、開き直してください。';
  else if (s === 'loading') gateMsg.textContent = '読み込み中…';
}
function onSession(s) {
  const was = session.state;
  session = s; role = s.state === 'in' ? s.role : null;
  document.body.dataset.role = role || '';
  if (unsubPoints) { unsubPoints(); unsubPoints = null; }
  if (s.state === 'in') {
    $('acctWho').textContent = s.email; $('acctWho').title = s.email; $('acctRole').textContent = ROLE_NAMES[role]; $('acct').hidden = false;
    if (!canEdit()) { setPen(false); movingId = null; stage.classList.remove('penon'); if (!cardEl.hidden && $('cardView').hidden) closeCard(); showGuide(); }
    if (role !== 'owner') closeMembers();
    unsubPoints = backend.onPoints(setPoints, e => toast('ツボを読み込めませんでした：' + explain(e)));
    auPw.value = '';
  } else {
    $('acct').hidden = true; setPen(false); setRuler(false); clearRuler(); movingId = null; closeCard(); closeMembers(); setPoints([]);
    if (s.state === 'out' && was !== 'out' && was !== 'loading') authMode = 'login';
  }
  if (was !== s.state) note(gateErr, '');
  renderGate(); renderList(); renderCarry();
}
async function busy(btn, fn, errEl) {      // ボタンを押している間は二度押しできないようにして、失敗したら理由を出す
  btn.disabled = true; note(errEl, '');
  try { await fn(); } catch (e) { note(errEl, explain(e)); }
  btn.disabled = false;
}
authForm.addEventListener('submit', e => {
  e.preventDefault();
  const email = auEmail.value.trim(), pw = auPw.value;
  busy($('auSubmit'), async () => {
    if (authMode === 'reset') { await backend.reset(email); authMode = 'login'; renderGate(); note(gateErr, 'メールを送りました。届いたメールからパスワードを決め直して、ログインしてください。', true); return 'keep'; }
    if (authMode === 'signup') { if (pw.length < 8) throw { code: 'auth/weak-password' }; await backend.signUp(email, pw); }
    else await backend.signIn(email, pw);
  }, gateErr);
});
for (const [id, m] of [['toSignup', 'signup'], ['toReset', 'reset'], ['toLogin', 'login']]) $(id).addEventListener('click', () => { authMode = m; note(gateErr, ''); renderGate(); });
$('recheckBtn').addEventListener('click', () => busy($('recheckBtn'), async () => {
  const before = session.state; await backend.recheck();
  setTimeout(() => { if (session.state === before) note(gateErr, before === 'unverified' ? 'まだ確認が済んでいません。メールの中のリンクを開いてください。' : 'まだ許可が出ていません。'); }, 1500);
}, gateErr));
$('resendBtn').addEventListener('click', () => busy($('resendBtn'), async () => { await backend.resend(); note(gateErr, '確認のメールをもう一度送りました。', true); }, gateErr));
$('gateOut').addEventListener('click', () => backend.signOut());
$('signOutBtn').addEventListener('click', () => backend.signOut());

// ---- メンバー（ツボを見られる人）の管理：管理者だけ
const membersEl = $('members'), memberList = $('memberList'), memberErr = $('memberErr');
function closeMembers() { membersEl.hidden = true; if (unsubMembers) { unsubMembers(); unsubMembers = null; } }
function renderMembers(list) {
  memberList.textContent = '';
  list.sort((a, b) => (a.role === 'owner' ? 0 : 1) - (b.role === 'owner' ? 0 : 1) || (a.email < b.email ? -1 : 1));
  for (const m of list) {
    const li = document.createElement('li');
    const who = document.createElement('div'); who.className = 'who'; who.textContent = m.email;
    if (m.memo) { const sm = document.createElement('small'); sm.textContent = m.memo; who.append(sm); }
    li.append(who);
    if (m.role === 'owner') { const t = document.createElement('span'); t.className = 'tagrole'; t.textContent = '管理者'; li.append(t); }
    else {
      const sel = document.createElement('select'); sel.setAttribute('aria-label', m.email + ' ができること');
      for (const r of ['viewer', 'editor']) { const o = document.createElement('option'); o.value = r; o.textContent = ROLE_NAMES[r]; sel.append(o); }
      sel.value = m.role === 'editor' ? 'editor' : 'viewer';
      sel.addEventListener('change', () => backend.setMember(m.email, sel.value, m.memo).catch(e => note(memberErr, explain(e))));
      const del = document.createElement('button'); del.type = 'button'; del.className = 'btn'; del.textContent = '取り消し';
      del.addEventListener('click', () => {       // 押し間違いで消えないように、2 回押して取り消す
        if (!del.classList.contains('armed')) { del.classList.add('armed'); del.textContent = 'もう一度押す'; setTimeout(() => { del.classList.remove('armed'); del.textContent = '取り消し'; }, 4000); return; }
        backend.removeMember(m.email).catch(e => note(memberErr, explain(e)));
      });
      li.append(sel, del);
    }
    memberList.append(li);
  }
}
$('membersBtn').addEventListener('click', () => {
  if (role !== 'owner') return;
  note(memberErr, ''); membersEl.hidden = false;
  unsubMembers = backend.onMembers(renderMembers, e => note(memberErr, explain(e)));
});
$('membersClose').addEventListener('click', closeMembers);
membersEl.addEventListener('click', e => { if (e.target === membersEl) closeMembers(); });
$('memberForm').addEventListener('submit', e => {
  e.preventDefault();
  const email = $('mEmail').value.trim().toLowerCase();
  busy(e.submitter || $('membersClose'), async () => {
    await backend.setMember(email, $('mRole').value, $('mMemo').value.trim());
    $('mEmail').value = ''; $('mMemo').value = ''; note(memberErr, email + ' を追加しました。', true);
  }, memberErr);
});

(async () => {              // ログインと保存先につなぐ
  try {
    if (isMock) backend = await (await import('./src/backend-mock.js')).createBackend();
    else if (!firebaseConfig) { session = { state: 'setup' }; renderGate(); return; }
    else backend = await createBackend(firebaseConfig);
    backend.onSession(onSession);
  } catch (e) { session = { state: 'error' }; renderGate(); note(gateErr, String(e && e.message || e)); }
})();

// ---------------------------------------------------------------- 大きさの調整と描画ループ
function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setPixelRatio(PR());
  renderer.setSize(w, h, false);
  const s = renderer.getDrawingBufferSize(new THREE.Vector2());
  target.setSize(s.x, s.y);
  const k = 448 / Math.max(w, h);
  dw = Math.max(4, Math.round(w * k)); dh = Math.max(4, Math.round(h * k));
  depthTarget.setSize(dw, dh); depthBuf = new Uint8Array(dw * dh * 4);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  dirty = true;
}
new ResizeObserver(resize).observe(stage);
resize();
goTo('front', true);

function frame(now) {
  if (anim) {
    let u = Math.min(1, (now - anim.t0) / 420); u = u * u * (3 - 2 * u);
    // 体のまわりを回り込むように動かす（中心からの距離を保つ）
    const a = anim.p0.clone().sub(anim.c0), b = anim.p1.clone().sub(anim.c1);
    const dir = a.clone().normalize().lerp(b.clone().normalize(), u);
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);          // 真反対へ回るとき
    dir.normalize().multiplyScalar(THREE.MathUtils.lerp(a.length(), b.length(), u));
    controls.target.lerpVectors(anim.c0, anim.c1, u);
    camera.position.copy(controls.target).add(dir);
    if (u >= 1) anim = null;
    dirty = true;
  }
  if (controls.update() || dirty) { draw(); dirty = false; }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- モデルの読み込み
function parse(buf) {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x44334d42) throw new Error('形式が違います');       // 'BM3D'
  const n = dv.getUint32(8, true);
  const origin = [dv.getFloat32(12, true), dv.getFloat32(16, true), dv.getFloat32(20, true)], extent = dv.getFloat32(24, true);
  let o = 28;
  const al = () => { o = (o + 3) & ~3; };
  const out = [];
  for (let i = 0; i < n; i++) {
    const nv = dv.getUint32(o, true), nt = dv.getUint32(o + 4, true), mat = dv.getUint32(o + 8, true), region = dv.getUint32(o + 12, true); o += 16;
    const pos = new Uint16Array(buf, o, nv * 3); o += nv * 6; al();
    const nrm = new Int8Array(buf, o, nv * 3); o += nv * 3; al();
    const ao = new Uint8Array(buf, o, nv); o += nv; al();
    const ao2 = new Uint8Array(buf, o, nv); o += nv; al();
    const idx = new Uint16Array(buf, o, nt * 3); o += nt * 6; al();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3, true));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3, true));
    const gray = a => { const c = new Uint8Array(nv * 3); for (let j = 0; j < nv; j++) { c[j * 3] = c[j * 3 + 1] = c[j * 3 + 2] = a[j]; } return new THREE.BufferAttribute(c, 3, true); };
    const colFull = gray(ao), colPart = gray(ao2);
    g.setAttribute('color', colFull);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, materials[mat]);
    mesh.position.set(origin[0], origin[1], origin[2]);
    mesh.scale.setScalar(extent);
    mesh.matrixAutoUpdate = false; mesh.updateMatrix(); mesh.updateMatrixWorld(true);
    mesh.userData = { region, colFull, colPart };
    out.push(mesh);
  }
  return out;
}
async function load(name, into) {
  const r = await fetch('models/' + name + '.bin');
  if (!r.ok) throw new Error(name + ' を読み込めません');
  for (const m of parse(await r.arrayBuffer())) groups[into || name].add(m);
  loaded[into || name] = true; applyPart();
}
let modelsReady = false, swReady = false;
function showOffline() { statusEl.textContent = (modelsReady && swReady) ? 'オフラインでも使えます' : (modelsReady ? '' : statusEl.textContent); }
(async () => {
  try {
    statusEl.textContent = 'モデルを読み込み中… 1/4';
    await load('skin');
    loadingEl.hidden = true;
    statusEl.textContent = 'モデルを読み込み中… 2/4';
    await load('muscle');
    statusEl.textContent = 'モデルを読み込み中… 3/4';
    await load('bone');
    statusEl.textContent = 'モデルを読み込み中… 4/4';
    await load('skin_parts', 'skin');          // 部位ごとに切り分けた皮膚
    buildPartVerts(); buildSkinTris();
    document.querySelectorAll('[data-part]').forEach(b => { b.disabled = false; });
    ready = true; $('penBtn').disabled = $('penBtn2').disabled = $('rulerBtn').disabled = $('rulerBtn2').disabled = false;
    modelsReady = true; showOffline();
  } catch (e) {
    loadingEl.hidden = false; loadingEl.textContent = '読み込みに失敗しました。通信状態を確かめて、開き直してください。';
    statusEl.textContent = String(e.message || e);
  }
})();

// 一度開いたら電波がなくても使えるようにする（https か localhost のときだけ）
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(() => { swReady = true; showOffline(); }).catch(() => {});
  });
}
window.__viewer = { camera, controls, goTo, setPart, setPen, onTap, pick, renderer, groups, loaded, get points() { return points; }, get ready() { return ready; }, get session() { return session; }, get backend() { return backend; }, ruler, setRuler, rulerAdd, redraw: () => { dirty = true; } };   // 動作確認用
