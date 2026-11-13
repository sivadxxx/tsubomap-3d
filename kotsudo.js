// 骨度法：体の部位ごとに「1寸が何 mm か」を決めて、体の表面の長さを寸に直す
//
// 値は、このアプリの人体モデル（BodyParts3D）の骨と皮膚から測ったもの（測り方は src/kotsudo/ の測定スクリプト）。
// 座標は図の座標（mm）：x = 本人の左が＋、y = 上、z = 前。
//
//   基準にした区間                         長さ(mm)   寸    1寸(mm)
//   眉間〜大椎（頭頂を通る皮膚の上）        513.1      18    28.5
//   左右の乳様突起の間（後頭部を回る）      206.9       9    23.0
//   天突〜胸骨体下端                        143.6       9    16.0
//   胸骨体下端〜臍                          220.3       8    27.5
//   臍〜恥骨結合上縁                        153.0       5    30.6
//   両乳頭の間                              218         8    27.3
//   大椎〜尾骨端                            585.6      30    19.5
//   肩甲骨内側縁〜後正中線                   57.1       3    19.0
//   腋窩横紋前端〜肘横紋                    198.9       9    22.1
//   肘横紋〜手関節横紋                      255.8      12    21.3
//   恥骨結合上縁〜膝蓋骨上縁                405.6      18    22.5
//   膝窩横紋〜外果尖                        399.1      16    24.9
//   外果尖〜足底                             49.9       3    16.6
export const ZONES = {
  head:     { v: 28.5,  t: 23.0,  text: '頭・首：眉間〜大椎 18寸、左右の乳様突起の間 9寸' },
  chest:    { v: 15.96, t: 27.25, text: '胸：天突〜胸骨体下端 9寸、両乳頭の間 8寸' },
  upperAbd: { v: 27.54, t: 27.25, text: '上腹部：胸骨体下端〜臍 8寸、両乳頭の間 8寸' },
  lowerAbd: { v: 30.6,  t: 27.25, text: '下腹部：臍〜恥骨結合上縁 5寸、両乳頭の間 8寸' },
  back:     { v: 19.52, t: 19.03, text: '背・腰：大椎〜尾骨端 30寸、肩甲骨内側縁〜後正中線 3寸' },
  upperArm: { v: 22.1,  t: 22.1,  text: '上腕：腋窩横紋前端〜肘横紋 9寸' },
  forearm:  { v: 21.3,  t: 21.3,  text: '前腕：肘横紋〜手関節横紋 12寸' },
  hand:     { v: 21.3,  t: 21.3,  text: '手：前腕と同じ寸（肘横紋〜手関節横紋 12寸）' },
  thigh:    { v: 22.5,  t: 22.5,  text: '大腿：恥骨結合上縁〜膝蓋骨上縁 18寸' },
  lowerLeg: { v: 24.9,  t: 24.9,  text: '下腿：膝窩横紋〜外果尖 16寸' },
  foot:     { v: 16.6,  t: 16.6,  text: '足：外果尖〜足底 3寸' },
};
// 部位の境目
const Y_NECK = 1368.4;                 // 大椎の高さ。これより上は頭・首
const Y_STERNUM_END = 1179.7;          // 胸骨体下端
const Y_NAVEL = 959.4;                 // 臍
const Y_KNEE = 373.9;                  // 膝の関節の高さ（膝窩横紋）
const Y_MALLEOLUS = -25.2;             // 外果尖
const ELBOW = [210.9, 1054.5, 67.5];   // 肘横紋の高さ（上腕骨の上顆）。右は x を反転して使う
const WRIST = [253.2, 806.8, 115.6];   // 手関節横紋
const AX_UPPER = [0.178, -0.983, -0.042];   // 肩 → 肘 の向き
const AX_FORE = [0.165, -0.968, 0.188];     // 肘 → 手首 の向き
const ELBOW_N = (() => { const v = [AX_UPPER[0] + AX_FORE[0], AX_UPPER[1] + AX_FORE[1], AX_UPPER[2] + AX_FORE[2]], l = Math.hypot(...v); return v.map(c => c / l); })();
const sstep = t => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };

// 点 (x, y, z) と、その点が属する部位（0 体幹、1 右腕、2 左腕、3 右脚、4 左脚）から、そこでの寸の物差しを返す
//   id … どの骨度を使ったか、v … 縦（体・手足の軸に沿う向き）の 1寸、t … 横の 1寸、head … 頭（縦 = 前後と上下、横 = 左右）
export function localScale(x, y, z, region) {
  if (region === 3 || region === 4) {
    const id = y > Y_KNEE ? 'thigh' : y > Y_MALLEOLUS ? 'lowerLeg' : 'foot';
    return { id, v: ZONES[id].v, t: ZONES[id].t };
  }
  if (region === 1 || region === 2) {
    const ax = Math.abs(x);
    const de = (ax - ELBOW[0]) * ELBOW_N[0] + (y - ELBOW[1]) * ELBOW_N[1] + (z - ELBOW[2]) * ELBOW_N[2];
    const dw = (ax - WRIST[0]) * AX_FORE[0] + (y - WRIST[1]) * AX_FORE[1] + (z - WRIST[2]) * AX_FORE[2];
    const id = de < 0 ? 'upperArm' : dw < 0 ? 'forearm' : 'hand';
    return { id, v: ZONES[id].v, t: ZONES[id].t };
  }
  if (y > Y_NECK) return { id: 'head', v: ZONES.head.v, t: ZONES.head.t, head: true };
  const band = y >= Y_STERNUM_END ? 'chest' : y >= Y_NAVEL ? 'upperAbd' : 'lowerAbd';
  const w = sstep((z - 50) / 60);          // 0 = 背中側、1 = 前側。脇腹ではなだらかに切り替える
  return { id: w > 0.5 ? band : 'back', v: ZONES.back.v + (ZONES[band].v - ZONES.back.v) * w, t: ZONES.back.t + (ZONES[band].t - ZONES.back.t) * w };
}

// 体の表面に沿った道すじ（点の並び）の長さを、寸と mm で返す。regionOf(x, y, z) は部位の番号を返す関数
export function measure(path, regionOf) {
  let sun = 0, mm = 0; const used = new Map();
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], b = path[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, d = Math.hypot(dx, dy, dz);
    if (!d) continue;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, mz = (a.z + b.z) / 2;
    const s = localScale(mx, my, mz, regionOf(mx, my, mz));
    // 頭は「左右」が横。体幹と手足は「上下」が縦（手足はどの向きも同じ寸）
    const ds = s.head ? Math.hypot(dx / s.t, Math.hypot(dy, dz) / s.v) : Math.hypot(dy / s.v, Math.hypot(dx, dz) / s.t);
    sun += ds; mm += d;
    used.set(s.id, (used.get(s.id) || 0) + d);
  }
  const zones = [...used.entries()].sort((p, q) => q[1] - p[1]).filter(([, len]) => len > mm * 0.08).map(([id]) => ZONES[id].text);
  return { sun, mm, zones };
}
