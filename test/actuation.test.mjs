// actuation.test.mjs — ユースケース層（ActuationService）の結合テスト
// スケジューラを同期実行に差し替え、意図→点灯までの全経路をNodeで検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VirtualCanBus } from '../docs/src/infrastructure/can.js';
import { HeuristicPlanner } from '../docs/src/infrastructure/planners.js';
import { ActuationService } from '../docs/src/application/actuation-service.js';
import { RuntimeAssuranceMonitor } from '../docs/src/application/runtime-monitor.js';
import { DomainEventBus, EVT } from '../docs/src/domain/events.js';
import { SafetyAuditLog } from '../docs/src/domain/audit.js';
import { PROGRAM_STATUS } from '../docs/src/domain/program.js';
import { encodeVehicleState, ZONE_BY_CANID, CAN_ID } from '../docs/src/domain/signals.js';

const syncScheduler = (sender, steps, tag, onDone) => {
  for (const s of steps) sender.send(s.frame, tag);
  onDone?.();
  return () => {};
};

function setup() {
  const bus = new VirtualCanBus();
  const events = new DomainEventBus();
  const audit = new SafetyAuditLog();
  audit.attach(events);
  const monitor = new RuntimeAssuranceMonitor({ bus, events });
  const service = new ActuationService({
    bus, monitor, events,
    planners: { heuristic: new HeuristicPlanner(), llm: null },
    scheduler: syncScheduler,
  });
  const sent = [];
  bus.subscribe((f) => sent.push(f));
  return { bus, events, audit, monitor, service, sent };
}

test('意図→点灯: 停車中の穏やかな意図は完走し、集約が completed になる', async () => {
  const { bus, service, sent, audit } = setup();
  bus.send(encodeVehicleState({ speedKmh: 0 }), 'vehicle');

  const { program, review } = await service.runIntent('足元をシアンでゆっくり呼吸');
  assert.equal(program.status, PROGRAM_STATUS.COMPLETED);
  assert.equal(review.summary.reject, 0);
  assert.ok(sent.some((f) => ZONE_BY_CANID[f.id]), 'ゾーン指令がバスへ流れる');

  // 監査証跡: 生成→コンパイル→審査→送出→完了 が揃う
  const types = audit.records.map((r) => r.type);
  for (const t of [EVT.INTENT_RECEIVED, EVT.PROGRAM_GENERATED, EVT.PROGRAM_COMPILED,
    EVT.PROGRAM_REVIEWED, EVT.PROGRAM_DISPATCHED, EVT.PROGRAM_COMPLETED]) {
    assert.ok(types.includes(t), `${t} が監査証跡に残る`);
  }
});

test('走行中の赤点滅の意図は rejected になり、バスへ流れない', async () => {
  const { bus, service, sent } = setup();
  bus.send(encodeVehicleState({ speedKmh: 60, gear: 3 }), 'vehicle');
  sent.length = 0;

  // 足元ゾーンのみ（前方視野ゾーンを含まない→ clamp退避が無く全滅する）
  const { program } = await service.runIntent('足元を赤く速く点滅させて警告');
  assert.equal(program.status, PROGRAM_STATUS.REJECTED);
  assert.ok(!sent.some((f) => ZONE_BY_CANID[f.id]), 'ゾーン指令は1枚も流れない');
});

test('LLM未接続時はルールプランナーへグレースフル・フォールバック', async () => {
  const { bus, service } = setup();
  bus.send(encodeVehicleState({ speedKmh: 0 }), 'vehicle');
  service._planners.llm = { generate: async () => { throw new Error('connection refused'); } };

  const { program, source } = await service.runIntent('コンソールを緑でパルス', 'llm');
  assert.ok(source.includes('fallback'));
  assert.equal(program.status, PROGRAM_STATUS.COMPLETED);
});

test('E-STOP: 実行中プログラムを中断し、全消灯フレームを送出する', async () => {
  const { bus, service, sent, audit } = setup();
  bus.send(encodeVehicleState({ speedKmh: 0 }), 'vehicle');
  // hold で点灯し続けるプログラム（同期スケジューラでは即 completed になるため、
  // active のまま残すダミー集約を差し込む代わりに、直後の estop の送出内容を検証）
  await service.runIntent('足元とドアをシアンでゆっくり呼吸');

  sent.length = 0;
  service.estop();
  const global = sent.find((f) => f.id === CAN_ID.ALM_GLOBAL_CMD && f.tag === 'estop');
  assert.ok(global, 'グローバル ALL_OFF が流れる');
  const zoneOffs = sent.filter((f) => ZONE_BY_CANID[f.id] && f.tag === 'estop');
  assert.ok(zoneOffs.length >= 7, '全ゾーンOFFが流れる');
  assert.ok(zoneOffs.every((f) => f.data[3] === 0));
  assert.ok(audit.records.some((r) => r.type === EVT.ESTOP_TRIGGERED));
});

test('新しい意図は実行中プログラムを差し替え、旧集約は aborted 相当で閉じる', async () => {
  const { bus, service, events } = setup();
  bus.send(encodeVehicleState({ speedKmh: 0 }), 'vehicle');

  // 非同期スケジューラ（完了しない）に差し替えて active のまま保持させる
  service._scheduler = () => () => {};
  const first = await service.runIntent('コンソールを緑でパルス');
  assert.equal(first.program.status, PROGRAM_STATUS.ACTIVE);

  const aborted = [];
  events.subscribe(EVT.PROGRAM_ABORTED, (e) => aborted.push(e.programId));
  const second = await service.runIntent('足元を青くゆっくり');
  assert.equal(first.program.status, PROGRAM_STATUS.ABORTED);
  assert.ok(aborted.includes(first.program.id));
  assert.equal(second.program.status, PROGRAM_STATUS.ACTIVE);
});
