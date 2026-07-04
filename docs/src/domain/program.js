// domain/program.js — 照明プログラム（集約ルート）と DSL 契約
//
// ● LightingProgram はこのドメインの集約ルート:
//   ID とライフサイクル（生成→コンパイル→審査→実行→完了/中断）を持ち、
//   状態遷移の不変条件（審査前に実行できない等）を自身で守る。
//
// ● normalizeDsl() は腐敗防止層（Anti-Corruption Layer）:
//   LLM という「信頼できない外部モデル」の出力を、ドメインが受け入れられる
//   形へ矯正してから集約に取り込む。ここで例外を出さないことで
//   後段のコンパイラ・安全審査が必ず動く（フェイルセーフ）。

import { ZONES, ZONE_BY_ID } from './signals.js';

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

// ---- 色の語彙（ユビキタス言語の一部。プランナーとコンパイラで共有）-------
export const COLORS = {
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

// ---- 腐敗防止層: 信頼できない入力(LLM出力)を安全な形へ矯正 ----------------
const VALID_EFFECTS = new Set(['static', 'breathe', 'pulse', 'wipe', 'flash', 'rainbow']);

export function normalizeDsl(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  let actions = Array.isArray(r.actions) ? r.actions.map(normalizeAction).filter(Boolean) : [];
  if (actions.length === 0) {
    actions = [{ zones: 'all', color: { r: 255, g: 170, b: 30 }, brightness: 60, effect: 'breathe', hz: 0.5, startMs: 0 }];
  }
  const anyFlash = actions.some((a) => a.effect === 'flash');
  return {
    title: String(r.title ?? 'ambient').slice(0, 60),
    rationale: String(r.rationale ?? ''),
    durationMs: clampInt(r.durationMs, 200, 30000, anyFlash ? 6000 : 12000),
    endState: r.endState === 'off' ? 'off' : (anyFlash ? 'off' : 'hold'),
    actions,
  };
}

function normalizeAction(a) {
  if (!a || typeof a !== 'object') return null;
  let zones;
  if (a.zones === 'all') zones = 'all';
  else if (Array.isArray(a.zones)) {
    zones = a.zones.filter((z) => ZONE_BY_ID[z]);
    if (zones.length === 0) zones = 'all';
  } else zones = 'all';
  return {
    zones,
    color: normalizeColorField(a.color),
    brightness: clampInt(a.brightness, 0, 100, 70),
    effect: VALID_EFFECTS.has(a.effect) ? a.effect : 'breathe',
    hz: clampNum(a.hz, 0, 8, 0.5),
    startMs: clampInt(a.startMs, 0, 30000, 0),
  };
}

function normalizeColorField(c) {
  if (typeof c === 'string') {
    const rgb = COLORS[c.toLowerCase()] || COLORS[c] || COLORS.amber;
    return { r: rgb[0], g: rgb[1], b: rgb[2] };
  }
  if (c && typeof c === 'object') {
    return { r: clampInt(c.r, 0, 255, 255), g: clampInt(c.g, 0, 255, 170), b: clampInt(c.b, 0, 255, 30) };
  }
  return { r: COLORS.amber[0], g: COLORS.amber[1], b: COLORS.amber[2] };
}

function clampInt(v, lo, hi, def) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
}
function clampNum(v, lo, hi, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
}

// ---- 集約ルート: LightingProgram ------------------------------------------
// ライフサイクル:
//   generated ──compile──► compiled ──review──► approved ─dispatch─► active ─► completed
//                                        └────► rejected                └─abort─► aborted
export const PROGRAM_STATUS = {
  GENERATED: 'generated',
  COMPILED: 'compiled',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  ABORTED: 'aborted',
};

const TRANSITIONS = {
  [PROGRAM_STATUS.GENERATED]: [PROGRAM_STATUS.COMPILED],
  [PROGRAM_STATUS.COMPILED]: [PROGRAM_STATUS.APPROVED, PROGRAM_STATUS.REJECTED],
  [PROGRAM_STATUS.APPROVED]: [PROGRAM_STATUS.ACTIVE],
  [PROGRAM_STATUS.REJECTED]: [],
  [PROGRAM_STATUS.ACTIVE]: [PROGRAM_STATUS.COMPLETED, PROGRAM_STATUS.ABORTED],
  [PROGRAM_STATUS.COMPLETED]: [],
  [PROGRAM_STATUS.ABORTED]: [],
};

let programSeq = 0;

export class LightingProgram {
  // 信頼できない生成物（LLM/ルール出力）から集約を作る唯一の入口。
  // 必ず腐敗防止層 normalizeDsl() を通す。
  static fromUntrusted({ intent, rawDsl, source }) {
    const p = new LightingProgram();
    p.id = `LP-${String(++programSeq).padStart(4, '0')}`;
    p.intent = String(intent ?? '');
    p.source = String(source ?? 'unknown');
    p.dsl = normalizeDsl(rawDsl);
    p.status = PROGRAM_STATUS.GENERATED;
    p.compiled = null;
    p.review = null;
    p.history = [{ status: p.status, at: Date.now() }];
    return p;
  }

  _transition(next, note) {
    const allowed = TRANSITIONS[this.status] ?? [];
    if (!allowed.includes(next)) {
      throw new Error(`invalid transition: ${this.status} -> ${next} (${this.id})`);
    }
    this.status = next;
    this.history.push({ status: next, at: Date.now(), ...(note ? { note } : {}) });
  }

  markCompiled(compiled) {
    this.compiled = compiled;
    this._transition(PROGRAM_STATUS.COMPILED);
  }

  // 審査結果を受理。審査対象フレームが1つも生き残らなければ rejected
  // （フェイルセーフの全消灯テールだけが残るケースは「承認」とみなさない）。
  markReviewed(review) {
    this.review = review;
    const survivors = review.summary.total - review.summary.reject;
    if (survivors > 0) this._transition(PROGRAM_STATUS.APPROVED);
    else this._transition(PROGRAM_STATUS.REJECTED, '全フレームが安全審査で破棄');
  }

  markActive() {
    this._transition(PROGRAM_STATUS.ACTIVE);
  }

  markCompleted() {
    if (this.status === PROGRAM_STATUS.ACTIVE) this._transition(PROGRAM_STATUS.COMPLETED);
  }

  markAborted(reason) {
    if (this.status === PROGRAM_STATUS.ACTIVE) this._transition(PROGRAM_STATUS.ABORTED, reason);
  }

  get isTerminal() {
    return (TRANSITIONS[this.status] ?? []).length === 0;
  }
}
