// planner.js — 「AIが制御プログラムを書く」層 と 信頼コンパイラ
//
// ● 設計の肝（構造的サンドボックス）:
//   AI が出力できるのは “照明DSL(JSON)” だけ。生の CAN ID やバイト列は
//   一切表現できない。DSL を CAN フレームへ落とすのは信頼された compile()
//   のみで、生成先 ID はアンビエント系に限定される。
//   → AI が暴走しても、そもそもブレーキやステアの ID を発火できない。
//
// ● 実機への発展:
//   HeuristicPlanner（オフライン規則ベース。GitHub Pages 既定）を
//   LlmPlanner（Claude API 等に DSL_SCHEMA/SYSTEM_PROMPT を渡す）へ
//   差し替えるだけ。出力する DSL の契約は同一。

import {
  ZONES, ZONE_BY_ID, EFFECT, encodeZoneFrame, hzToSpeed, clampByte,
} from './signals.js';

// ---- DSL 契約（実LLMにも渡すスキーマ）-----------------------------------
export const DSL_SCHEMA = {
  type: 'object',
  required: ['title', 'durationMs', 'actions', 'endState'],
  properties: {
    title: { type: 'string' },
    rationale: { type: 'string' },
    durationMs: { type: 'integer', minimum: 200, maximum: 30000 },
    endState: { enum: ['hold', 'off'] },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['zones', 'color', 'brightness', 'effect'],
        properties: {
          zones: { description: "'all' か ZONE id の配列" },
          color: { description: '{r,g,b} 0-255 か 色名' },
          brightness: { type: 'integer', minimum: 0, maximum: 100 },
          effect: { enum: ['static', 'breathe', 'pulse', 'wipe', 'flash', 'rainbow'] },
          hz: { type: 'number', minimum: 0, maximum: 8 },
          startMs: { type: 'integer', minimum: 0 },
        },
      },
    },
  },
};

export const LLM_SYSTEM_PROMPT = `あなたは車載アンビエント照明の制御プランナーです。
ユーザーの意図を、指定された JSON スキーマ(DSL)の照明プログラムに変換してください。
制約:
- 出力できるのは照明ゾーンの色/輝度/エフェクトのみ。CAN ID やバイト列は書かない。
- 走行中の安全性は後段のスーパーバイザーが担保するため、意図を素直に表現してよい。
- 触れてよいゾーン: ${ZONES.map((z) => z.id).join(', ')}。
必ず DSL_SCHEMA に厳密準拠した JSON のみを返すこと。`;

// ---- 色・語彙 -----------------------------------------------------------
const COLORS = {
  red: [255, 40, 40], 赤: [255, 40, 40],
  blue: [40, 90, 255], 青: [40, 90, 255],
  green: [40, 220, 90], 緑: [40, 220, 90], みどり: [40, 220, 90],
  white: [255, 245, 230], 白: [255, 245, 230], しろ: [255, 245, 230],
  purple: [170, 60, 255], 紫: [170, 60, 255], むらさき: [170, 60, 255],
  pink: [255, 80, 180], ピンク: [255, 80, 180],
  orange: [255, 130, 20], オレンジ: [255, 130, 20],
  amber: [255, 170, 30], アンバー: [255, 170, 30], 琥珀: [255, 170, 30],
  yellow: [255, 220, 40], 黄: [255, 220, 40], きいろ: [255, 220, 40],
  cyan: [40, 220, 235], シアン: [40, 220, 235], 水色: [40, 220, 235],
  teal: [30, 200, 180],
};

const EFFECT_WORDS = [
  [/(虹|レインボー|rainbow|カラフル)/i, 'rainbow'],
  [/(点滅|フラッシュ|flash|blink)/i, 'flash'],
  [/(パルス|pulse|鼓動|ドクドク)/i, 'pulse'],
  [/(流れ|ウェーブ|wipe|sweep|スイープ|ながれ)/i, 'wipe'],
  [/(呼吸|breath|ゆっくり|じんわり|フェード|fade)/i, 'breathe'],
  [/(点灯|つけ|light|on|固定|static)/i, 'static'],
];

const ZONE_WORDS = [
  [/(足元|フットウェル|footwell|foot)/i, ['footwell_fl', 'footwell_fr']],
  [/(ドア|door)/i, ['door_fl', 'door_fr']],
  [/(ダッシュ|dash|メーター)/i, ['dashboard']],
  [/(コンソール|console|センター)/i, ['console']],
  [/(カップ|cup|ドリンク)/i, ['cupholder']],
  [/(全部|ぜんぶ|すべて|全体|all|まるごと)/i, 'all'],
];

// ---- プリセット（ワンタップの体験用）------------------------------------
export const PRESETS = [
  { key: 'welcome', label: '🚪 ウェルカム点灯', intent: 'ドアを開けたら足元とドアを白くゆっくり点灯' },
  { key: 'drive',   label: '🌙 ナイトドライブ', intent: 'ダッシュとコンソールをアンバーでじんわり呼吸' },
  { key: 'party',   label: '🎉 パーティ',       intent: '全部レインボーで流れるように' },
  { key: 'brake',   label: '🛑 注意喚起(赤点滅)', intent: '全部を赤く速く点滅させて警告' },
  { key: 'chill',   label: '💧 チル',           intent: '足元とドアをシアンでゆっくり呼吸' },
  { key: 'charge',  label: '🔋 充電中',         intent: 'コンソールを緑でパルス' },
];

// ---- Planner インターフェース -------------------------------------------
export class HeuristicPlanner {
  // 返り値: DSL プログラム(JSON)。async にして LlmPlanner と同一契約。
  async generate(intent) {
    const text = (intent || '').trim();
    const color = pickColor(text);
    const effect = pickEffect(text);
    const zones = pickZones(text);
    const hz = pickHz(text, effect);
    const brightness = pickBrightness(text, effect);

    const zoneList = zones === 'all' ? ZONES.map((z) => z.id) : zones;
    const title = buildTitle(text, effect);

    return {
      title,
      rationale:
        `意図「${text || '（プリセット）'}」を、${zoneList.length}ゾーン / ` +
        `色rgb(${color.join(',')}) / エフェクト:${effect} / ${hz}Hz の照明プログラムに変換しました。`,
      durationMs: effect === 'flash' ? 6000 : 12000,
      endState: effect === 'flash' ? 'off' : 'hold',
      actions: [
        {
          zones: zones === 'all' ? 'all' : zoneList,
          color: { r: color[0], g: color[1], b: color[2] },
          brightness,
          effect,
          hz,
          startMs: 0,
        },
      ],
    };
  }
}

function pickColor(t) {
  for (const [word, rgb] of Object.entries(COLORS)) {
    if (t.includes(word)) return rgb;
  }
  // 指定なし → 落ち着いたアンバー（車載アンビエントの定番）
  return COLORS.amber;
}
function pickEffect(t) {
  for (const [re, name] of EFFECT_WORDS) if (re.test(t)) return name;
  return 'breathe';
}
function pickZones(t) {
  const hits = [];
  for (const [re, zs] of ZONE_WORDS) {
    if (re.test(t)) {
      if (zs === 'all') return 'all';
      hits.push(...zs);
    }
  }
  return hits.length ? [...new Set(hits)] : 'all';
}
function pickHz(t, effect) {
  if (/(速く|はやく|激しく|fast|強め)/i.test(t)) return 4;
  if (/(ゆっくり|遅く|静かに|slow|そっと)/i.test(t)) return 0.4;
  if (effect === 'flash') return 2.5;
  if (effect === 'pulse') return 1.2;
  if (effect === 'wipe') return 0.8;
  return 0.5;
}
function pickBrightness(t, effect) {
  if (/(明るく|全開|max|強く)/i.test(t)) return 100;
  if (/(暗く|控えめ|dim|そっと|かすか)/i.test(t)) return 30;
  return effect === 'flash' ? 90 : 70;
}
function buildTitle(t, effect) {
  const base = t.slice(0, 16) || 'アンビエント';
  return `${base}…(${effect})`;
}

// ---- 信頼コンパイラ: DSL → CAN フレーム列 --------------------------------
// ここだけが CAN ID を知っている。DSL は ID を指定できないので、
// 生成されるフレームは必ずアンビエント系 ID に限定される。
const EFFECT_ENUM = {
  static: EFFECT.STATIC, breathe: EFFECT.BREATHE, pulse: EFFECT.PULSE,
  wipe: EFFECT.WIPE, flash: EFFECT.FLASH, rainbow: EFFECT.RAINBOW,
};

export function compile(program) {
  const steps = [];
  let counter = 0;
  for (const action of program.actions) {
    const zoneIds = action.zones === 'all'
      ? ZONES.map((z) => z.id)
      : action.zones.filter((z) => ZONE_BY_ID[z]);
    const { r, g, b } = normalizeColor(action.color);
    const brightness = clampByte(Math.round((action.brightness / 100) * 255));
    const effect = EFFECT_ENUM[action.effect] ?? EFFECT.STATIC;
    const speed = hzToSpeed(action.hz ?? 0.5);
    const atMs = action.startMs ?? 0;
    for (const zoneId of zoneIds) {
      steps.push({
        atMs,
        frame: encodeZoneFrame({
          zoneId, r, g, b, brightness, effect, speed,
          counter: counter++ & 0x0f,
        }),
      });
    }
  }
  return { steps, durationMs: program.durationMs, endState: program.endState };
}

function normalizeColor(color) {
  if (typeof color === 'string') {
    const rgb = COLORS[color.toLowerCase()] || COLORS[color] || COLORS.amber;
    return { r: rgb[0], g: rgb[1], b: rgb[2] };
  }
  return { r: clampByte(color.r), g: clampByte(color.g), b: clampByte(color.b) };
}
