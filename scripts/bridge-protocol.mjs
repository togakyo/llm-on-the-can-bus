// scripts/bridge-protocol.mjs — Unity ブリッジのメッセージ変換（純粋関数）
//
// UDP データグラム 1 通 = JSON メッセージ 1 個。トランスポート(dgram)には依存しない。
// Unity 側は JsonUtility でデシリアライズするため、マップは使わず配列で表現する
// （JsonUtility は Dictionary を扱えない）。仕様は unity/PROTOCOL.md を参照。

import {
  ZONES, ZONE_BY_CANID, EFFECT_NAME, idToHex, clampByte,
} from '../docs/src/domain/signals.js';

// --- ホスト → Unity -------------------------------------------------------

// hello への応答。ゾーンカタログの並び順が Unity 側の zoneIndex（WIPE/RAINBOW の位相）になる。
export function welcomeMessage(policyVersion) {
  return {
    type: 'welcome',
    policyVersion,
    zones: ZONES.map((z) => ({
      id: z.id, canId: z.canId, label: z.label, forwardField: z.forwardField,
    })),
  };
}

// バスを流れた 1 フレーム（Unity 側バスモニタ用）
export function frameMessage(frame) {
  return {
    type: 'frame',
    seq: frame.seq ?? 0,
    tag: frame.tag ?? 'tx',
    id: frame.id,
    idHex: idToHex(frame.id),
    dlc: frame.dlc ?? frame.data.length,
    data: [...frame.data],
    zone: ZONE_BY_CANID[frame.id]?.id ?? '',
  };
}

// ECU にラッチ済みの全ゾーン状態のスナップショット。
// エフェクトの時間変化は Unity 側が (nowMs - sinceMs) を自分の時計に貼り直して再生する。
export function zonesMessage(ecu, nowMs) {
  return {
    type: 'zones',
    master: ecu.master,
    nowMs,
    zones: ZONES.map((z) => {
      const s = ecu.zones[z.id];
      return {
        id: z.id,
        r: s.r, g: s.g, b: s.b,
        brightness: s.brightness,
        effect: s.effect,
        effectName: EFFECT_NAME[s.effect] ?? 'STATIC',
        hz: s.hz,
        sinceMs: s.since,
      };
    }),
  };
}

// ドメインイベント（監査証跡と同じ内容を Unity のデバッグ HUD へ）
// JSON キーは C# の予約語を避けて `name` にする。
export function eventMessage(evt) {
  return {
    type: 'event',
    name: evt.type,
    at: evt.at ?? Date.now(),
    detail: evt.detail ?? '',
    verdict: evt.verdict ?? '',
    phase: evt.phase ?? '',
    policyVersion: evt.policyVersion ?? '',
    programId: evt.programId ?? '',
  };
}

// runIntent の結果サマリ
export function resultMessage({ program, source, review }) {
  return {
    type: 'result',
    ok: true,
    programId: program.id,
    status: program.status,
    title: program.dsl?.title ?? '',
    source,
    pass: review.summary.pass,
    clamp: review.summary.clamp,
    reject: review.summary.reject,
    driving: !!review.summary.driving,
    error: '',
  };
}

export function errorMessage(err) {
  return {
    type: 'result',
    ok: false,
    programId: '', status: 'error', title: '', source: '',
    pass: 0, clamp: 0, reject: 0, driving: false,
    error: String(err?.message ?? err),
  };
}

// --- Unity → ホスト -------------------------------------------------------

// 受信データグラムの検証・正規化。不正なら null（黙って破棄できるように）。
export function parseClientMessage(buf) {
  let msg;
  try {
    msg = JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;

  switch (msg.type) {
    case 'hello':
      return { type: 'hello', client: String(msg.client ?? 'unknown') };
    case 'intent': {
      const text = String(msg.text ?? '').trim();
      if (!text) return null;
      return { type: 'intent', text, mode: msg.mode === 'llm' ? 'llm' : 'heuristic' };
    }
    case 'estop':
      return { type: 'estop' };
    case 'vehicle':
      return {
        type: 'vehicle',
        ignition: msg.ignition ? 1 : 0,
        gear: Math.max(0, Math.min(3, Number(msg.gear) || 0)),
        speedKmh: Math.max(0, Math.min(500, Math.round(Number(msg.speedKmh) || 0))),
        doors: clampByte(Number(msg.doors) || 0),
      };
    default:
      return null;
  }
}

export function encodeMessage(msg) {
  return Buffer.from(JSON.stringify(msg), 'utf8');
}
