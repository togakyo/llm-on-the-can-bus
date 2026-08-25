// application/runtime-monitor.js — 実行時保証モニタ（Run-Time Assurance / Simplex）
//
// Physical AI のベストプラクティス「Simplex アーキテクチャ」の Decision Module に相当:
//   - 信頼できない高性能コントローラ（LLMプランナー）の出力を、
//   - 信頼された監視器（このモニタ + domain/safety.js）が常時監視し、
//   - 安全逸脱時は信頼されたフォールバック（clamp / 消灯 / E-STOP）へ切り替える。
//
// 生成時の一括審査（reviewProgram）だけでは不十分な2つの穴を塞ぐ:
//  (1) TXゲート: スケジュール済みフレームは「送信の瞬間」の車両状態で再検査する。
//      （停車中に承認 → 数秒後には走行中かもしれない）
//  (2) 継続再保証: ECU にラッチ済みの点灯状態（例: 赤点滅で hold 中）を
//      車両状態が変わるたびに再検査し、違反は安全側へ矯正 / 消灯する。
//
// センシングはバス経由: VEHICLE_STATE フレームを購読して車両状態を得る。
// （UI の変数を直接見ない＝実機で SocketCAN に差し替えても成立する構造）

import {
  CAN_ID, GLOBAL_CMD, ZONE_BY_CANID, EFFECT,
  decodeVehicleState, encodeZoneFrame,
} from '../domain/signals.js';
import { inspectFrame, VERDICT, POLICY } from '../domain/safety.js';
import { VehicleState, PARKED_DEFAULT } from '../domain/vehicle.js';
import { EVT } from '../domain/events.js';

export class RuntimeAssuranceMonitor {
  // formatReasons: 審査理由({code,...})を1行の文字列にする関数（監査ログ用）。
  // ドメインは言語を持たないので、文言化は合成ルートから注入する。
  constructor({ bus, events, policy = POLICY, formatReasons = defaultFormatReasons }) {
    this._bus = bus;
    this._events = events;
    this._policy = policy;
    this._formatReasons = formatReasons;
    this._vehicle = PARKED_DEFAULT;
    this._latched = new Map(); // canId -> 最後にECUへ流れたゾーン指令フレーム
    this.interventions = 0;
    bus.subscribe((frame) => this._onBusFrame(frame));
  }

  get vehicle() {
    return this._vehicle;
  }

  // --- TXゲート -----------------------------------------------------------
  // scheduleProgram() には bus の代わりにこのモニタを渡す。
  // 送信の瞬間の車両状態で再検査してからバスへ流す（Simplex の切替点その1）。
  send(frame, tag = 'safety') {
    const res = inspectFrame(frame, this._vehicle);
    if (res.verdict === VERDICT.REJECT) {
      this.interventions++;
      this._publishIntervention('tx-gate', res);
      return null; // 破棄（バスへは流さない）
    }
    if (res.verdict === VERDICT.CLAMP) {
      this.interventions++;
      this._publishIntervention('tx-gate', res);
    }
    return this._bus.send(res.frame, tag);
  }

  // --- センシングとラッチ状態の追跡 ----------------------------------------
  _onBusFrame(frame) {
    if (frame.id === CAN_ID.VEHICLE_STATE) {
      const next = new VehicleState(decodeVehicleState(frame));
      if (!next.equals(this._vehicle)) {
        const prev = this._vehicle;
        this._vehicle = next;
        this._events?.publish(EVT.VEHICLE_STATE_CHANGED, {
          detail: `${prev.speedKmh}km/h(${prev.gearName()}) -> ${next.speedKmh}km/h(${next.gearName()})`,
        });
        this._reassure();
      }
      return;
    }
    if (frame.id === CAN_ID.ALM_GLOBAL_CMD) {
      if (frame.data[0] === GLOBAL_CMD.ALL_OFF) this._latched.clear();
      return;
    }
    if (ZONE_BY_CANID[frame.id]) this._latched.set(frame.id, frame);
  }

  // --- 継続再保証（Simplex の切替点その2）----------------------------------
  // 車両状態が変わった瞬間、点灯し続けている全ゾーンを新ポリシーで再検査。
  _reassure() {
    for (const [canId, frame] of [...this._latched.entries()]) {
      const res = inspectFrame(frame, this._vehicle);
      if (res.verdict === VERDICT.PASS) continue;
      this.interventions++;
      if (res.verdict === VERDICT.CLAMP) {
        this._publishIntervention('reassure', res);
        this._bus.send(res.frame, 'monitor'); // 安全側へ矯正した指令で上書き
      } else {
        this._publishIntervention('reassure', res);
        const zone = ZONE_BY_CANID[canId];
        // フォールバック: 違反ゾーンを消灯（安全状態へ復帰）
        this._bus.send(
          encodeZoneFrame({
            zoneId: zone.id, r: 0, g: 0, b: 0, brightness: 0,
            effect: EFFECT.STATIC, speed: 0,
          }),
          'monitor',
        );
      }
    }
  }

  _publishIntervention(phase, res) {
    const zone = res.zoneId ? ZONE_BY_CANID[res.frame?.id]?.labelEn ?? res.zoneId : 'global';
    this._events?.publish(EVT.RUNTIME_INTERVENTION, {
      policyVersion: this._policy.version,
      detail: `[${phase}] ${res.verdict.toUpperCase()} ${zone}: ${this._formatReasons(res.reasons)}`,
      verdict: res.verdict,
      phase,
    });
  }
}

// 既定の文言化: 依存を持たない最小実装（コードとパラメータをそのまま並べる）。
// UI からは docs/src/i18n.js の formatReasonsEn を注入して読みやすくする。
function defaultFormatReasons(reasons) {
  return (reasons ?? [])
    .map((r) => (typeof r === 'string' ? r : r.code))
    .join(' / ');
}
