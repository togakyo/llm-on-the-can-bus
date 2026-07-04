// infrastructure/can.js — 仮想 CAN バス（アダプタ）
//
// DDD 上はインフラ層。実機では SocketCAN(can0) 等のアダプタに差し替わる。
//
// フレームを購読者（ECUモデル / バスモニタ）へ配信するだけの薄い層。
// 実機では SocketCAN(can0) や python-can に置き換わる想定の抽象化ポイント。

export class VirtualCanBus {
  constructor() {
    this._subscribers = [];
    this._txCount = 0;
  }

  subscribe(fn) {
    this._subscribers.push(fn);
    return () => {
      this._subscribers = this._subscribers.filter((s) => s !== fn);
    };
  }

  // 1フレーム送信。tag は 'planner' | 'safety' | 'estop' | 'vehicle' など発信元。
  send(frame, tag = 'tx') {
    const stamped = { ...frame, t: performance.now(), tag, seq: ++this._txCount };
    for (const fn of this._subscribers) fn(stamped);
    return stamped;
  }

  get txCount() {
    return this._txCount;
  }
}

// タイムスタンプ付きのフレーム列を、指定した実時間スケジュールで送信する。
// steps: [{ atMs, frame }]  返り値: cancel()
export function scheduleProgram(bus, steps, tag, onDone) {
  const timers = [];
  let remaining = steps.length;
  if (remaining === 0) { onDone?.(); return () => {}; }
  for (const step of steps) {
    timers.push(
      setTimeout(() => {
        bus.send(step.frame, tag);
        if (--remaining === 0) onDone?.();
      }, step.atMs),
    );
  }
  return () => timers.forEach(clearTimeout);
}
