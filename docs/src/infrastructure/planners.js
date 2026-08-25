// infrastructure/planners.js — プランナーのアダプタ実装
//
// application 層が要求する PlannerPort（async generate(intent) → 生DSL）を満たす
// 2つの実装。どちらの出力も「信頼できない生成物」として扱われ、必ず
// 腐敗防止層 normalizeDsl()（domain/program.js）を通ってから集約に取り込まれる。
//
//  - HeuristicPlanner: オフライン規則ベース（GitHub Pages 既定・フォールバック役）
//  - LlmPlanner:       ローカルHFモデル（backend-rs / ai のHTTPサーバ）

import { ZONES } from '../domain/signals.js';
import { COLORS } from '../domain/program.js';

// ---- プリセット（ワンタップの体験用）------------------------------------
// group:'safe'   … ふつうの使い方。停車中は素通りする。
// group:'attack' … 「壊してみる」用。走行中(スライダーを上げる)にすると
//                  安全審査が CLAMP / REJECT で止める様子がそのまま見える。
export const PRESETS = [
  { key: 'welcome', group: 'safe', label: '🚪 ウェルカム点灯', labelEn: '🚪 Welcome',
    intent: 'ドアを開けたら足元とドアを白くゆっくり点灯',
    intentEn: 'light the footwells and doors white, slowly, when a door opens' },
  { key: 'drive', group: 'safe', label: '🌙 ナイトドライブ', labelEn: '🌙 Night drive',
    intent: 'ダッシュとコンソールをアンバーでじんわり呼吸',
    intentEn: 'breathe amber on the dashboard and console' },
  { key: 'chill', group: 'safe', label: '💧 チル', labelEn: '💧 Chill',
    intent: '足元とドアをシアンでゆっくり呼吸',
    intentEn: 'breathe cyan slowly in the footwells and doors' },
  { key: 'party', group: 'safe', label: '🎉 パーティ', labelEn: '🎉 Party',
    intent: '全部レインボーで流れるように',
    intentEn: 'rainbow wipe across all zones' },
  { key: 'charge', group: 'safe', label: '🔋 充電中', labelEn: '🔋 Charging',
    intent: 'コンソールを緑でパルス',
    intentEn: 'pulse the console green' },

  { key: 'redflash', group: 'attack', label: '🚨 赤く速く点滅', labelEn: '🚨 Fast red flash',
    intent: '全部を赤く速く点滅させて警告',
    intentEn: 'flash everything red and fast as a warning' },
  { key: 'glare', group: 'attack', label: '🔆 ダッシュを全開輝度', labelEn: '🔆 Dashboard at max',
    intent: 'ダッシュボードを白く明るく全開で点灯',
    intentEn: 'light the dashboard white at maximum brightness' },
  { key: 'strobe', group: 'attack', label: '⚡ 全ゾーンをストロボ', labelEn: '⚡ Strobe every zone',
    intent: '全部を激しく速く点滅させる',
    intentEn: 'strobe every zone as fast as you can' },
];

// 現在のロケールに合わせたプリセット文言を取り出す。
export function presetLabel(p, lang) {
  return lang === 'ja' ? p.label : (p.labelEn ?? p.label);
}
export function presetIntent(p, lang) {
  return lang === 'ja' ? p.intent : (p.intentEn ?? p.intent);
}

// ---- LlmPlanner: 自分のPCで動く軽量HFモデルに DSL を書かせる -------------
// ローカルサーバ(backend-rs / ai/planner_server.py)へ意図を投げ、DSLを受け取る。
export class LlmPlanner {
  constructor(endpoint = 'http://localhost:8000') {
    this.endpoint = endpoint;
    this.lastSource = null; // 'llm' | 'fallback'
    this.lastModel = null;
  }

  async health() {
    const res = await fetch(`${this.endpoint}/health`, { method: 'GET' });
    if (!res.ok) throw new Error(`health ${res.status}`);
    return res.json();
  }

  async generate(intent) {
    const res = await fetch(`${this.endpoint}/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent }),
    });
    if (!res.ok) throw new Error(`plan ${res.status}`);
    const data = await res.json();
    this.lastSource = data.source ?? 'llm';
    this.lastModel = data.model ?? null;
    return data.dsl;
  }
}

// ---- HeuristicPlanner: オフライン規則ベース -------------------------------
const EFFECT_WORDS = [
  [/(虹|レインボー|rainbow|カラフル)/i, 'rainbow'],
  [/(点滅|フラッシュ|ストロボ|flash|blink|strobe)/i, 'flash'],
  [/(パルス|pulse|鼓動|ドクドク)/i, 'pulse'],
  [/(流れ|ウェーブ|wipe|sweep|スイープ|ながれ)/i, 'wipe'],
  [/(呼吸|breath|ゆっくり|じんわり|フェード|fade|glow)/i, 'breathe'],
  [/(点灯|つけ|light|on|固定|static)/i, 'static'],
];

const ZONE_WORDS = [
  [/(足元|フットウェル|footwell|foot)/i, ['footwell_fl', 'footwell_fr']],
  [/(ドア|door)/i, ['door_fl', 'door_fr']],
  [/(ダッシュ|dash|メーター)/i, ['dashboard']],
  [/(コンソール|console|センター)/i, ['console']],
  [/(カップ|cup|ドリンク)/i, ['cupholder']],
  [/(全部|ぜんぶ|すべて|全体|all|every|whole|まるごと)/i, 'all'],
];

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
      // rationale はプランナーが「なぜこのDSLにしたか」を説明する欄。
      // モデル出力と同じ枠なので、表示ロケールに依存させず英語で書く。
      rationale:
        `Turned the intent "${text || '(preset)'}" into a lighting program: ` +
        `${zoneList.length} zone(s) / rgb(${color.join(',')}) / effect ${effect} / ${hz}Hz.`,
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
  if (/(速く|はやく|激しく|fast|rapid|quick|強め)/i.test(t)) return 4;
  if (/(ゆっくり|遅く|静かに|slow|そっと)/i.test(t)) return 0.4;
  if (effect === 'flash') return 2.5;
  if (effect === 'pulse') return 1.2;
  if (effect === 'wipe') return 0.8;
  return 0.5;
}
function pickBrightness(t, effect) {
  if (/(明るく|全開|max|full|bright|強く)/i.test(t)) return 100;
  if (/(暗く|控えめ|dim|そっと|かすか)/i.test(t)) return 30;
  return effect === 'flash' ? 90 : 70;
}
function buildTitle(t, effect) {
  const base = t.slice(0, 16) || 'アンビエント';
  return `${base}…(${effect})`;
}
