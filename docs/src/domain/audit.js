// domain/audit.js — 安全監査証跡（Audit Trail）
//
// 車載の機能安全では「なぜその制御が許可/拒否されたか」を後から追跡できること
// （トレーサビリティ）が必須。ここではドメインイベントを購読して
// 追記専用（append-only）の監査レコードに変換する。
// レコードには判定時のセーフティ・エンベロープのバージョンを必ず刻む。

export class SafetyAuditLog {
  constructor({ capacity = 200 } = {}) {
    this._records = [];
    this._seq = 0;
    this.capacity = capacity;
    this._listeners = [];
  }

  // DomainEventBus に接続: すべてのイベントを監査レコード化する
  attach(eventBus) {
    return eventBus.subscribe('*', (event) => this.append(event));
  }

  append(event) {
    const record = Object.freeze({
      seq: ++this._seq,
      at: event.at ?? Date.now(),
      type: event.type,
      programId: event.programId ?? null,
      policyVersion: event.policyVersion ?? null,
      detail: event.detail ?? '',
    });
    this._records.push(record);
    if (this._records.length > this.capacity) this._records.shift();
    for (const fn of this._listeners) {
      try {
        fn(record);
      } catch {
        // 表示側の失敗は無視（追記自体は成立している）
      }
    }
    return record;
  }

  onAppend(fn) {
    this._listeners.push(fn);
    return () => {
      this._listeners = this._listeners.filter((f) => f !== fn);
    };
  }

  get records() {
    return [...this._records];
  }

  byProgram(programId) {
    return this._records.filter((r) => r.programId === programId);
  }
}
