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
export const PRESETS = [
  { key: 'welcome', label: '🚪 ウェルカム点灯', intent: 'ドアを開けたら足元とドアを白くゆっくり点灯' },
  { key: 'drive',   label: '🌙 ナイトドライブ', intent: 'ダッシュとコンソールをアンバーでじんわり呼吸' },
  { key: 'party',   label: '🎉 パーティ',       intent: '全部レインボーで流れるように' },
  { key: 'brake',   label: '🛑 注意喚起(赤点滅)', intent: '全部を赤く速く点滅させて警告' },
  { key: 'chill',   label: '💧 チル',           intent: '足元とドアをシアンでゆっくり呼吸' },
  { key: 'charge',  label: '🔋 充電中',         intent: 'コンソールを緑でパルス' },
];

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
