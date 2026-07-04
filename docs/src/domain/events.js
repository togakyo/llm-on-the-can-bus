// domain/events.js — ドメインイベント
//
// 「何が起きたか」をユビキタス言語のまま記録・配信する。
// 監査ログ（audit.js）と UI はイベントの購読者であり、
// ユースケース（application 層）が唯一の発行者。
// 発行は同期・例外は握りつぶす（購読者の失敗が制御経路を壊さないように）。

export const EVT = {
  INTENT_RECEIVED: 'IntentReceived',             // ① 意図を受理
  PROGRAM_GENERATED: 'ProgramGenerated',         // ② プランナーが DSL を生成
  PROGRAM_COMPILED: 'ProgramCompiled',           // ③ 信頼コンパイラが CAN 化
  PROGRAM_REVIEWED: 'ProgramReviewed',           // ④ 安全審査の判定が出た
  PROGRAM_DISPATCHED: 'ProgramDispatched',       // ⑤ 承認ステップの送出開始
  PROGRAM_COMPLETED: 'ProgramCompleted',         // 送出完了
  PROGRAM_ABORTED: 'ProgramAborted',             // 中断（E-STOP / 差し替え / 監視介入）
  VEHICLE_STATE_CHANGED: 'VehicleStateChanged',  // センシング: 車両状態が変化
  RUNTIME_INTERVENTION: 'RuntimeIntervention',   // 実行時監視が介入（clamp/reject/degrade）
  ESTOP_TRIGGERED: 'EstopTriggered',             // フェイルセーフ発動
};

export class DomainEventBus {
  constructor() {
    this._subs = new Map(); // type -> fn[]  ('*' は全イベント)
  }

  subscribe(type, fn) {
    if (!this._subs.has(type)) this._subs.set(type, []);
    this._subs.get(type).push(fn);
    return () => {
      this._subs.set(type, this._subs.get(type).filter((f) => f !== fn));
    };
  }

  publish(type, payload = {}) {
    const event = { type, at: Date.now(), ...payload };
    for (const fn of [...(this._subs.get(type) ?? []), ...(this._subs.get('*') ?? [])]) {
      try {
        fn(event);
      } catch {
        // 購読者（UI/ログ）の失敗で制御経路を止めない
      }
    }
    return event;
  }
}
