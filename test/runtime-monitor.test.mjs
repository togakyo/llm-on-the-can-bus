// runtime-monitor.test.mjs — 実行時保証モニタ（Simplex / RTA）のテスト
//
// 「停車中に承認された点灯状態が、走行開始した瞬間に再審査される」という
// 生成時一括審査だけでは防げないシナリオを検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VirtualCanBus } from '../docs/src/infrastructure/can.js';
import { RuntimeAssuranceMonitor } from '../docs/src/application/runtime-monitor.js';
import { DomainEventBus, EVT } from '../docs/src/domain/events.js';
import { SafetyAuditLog } from '../docs/src/domain/audit.js';
import {
  EFFECT, GLOBAL_CMD, encodeZoneFrame, encodeGlobalFrame, encodeVehicleState,
  hzToSpeed, ZONE_BY_CANID,
} from '../docs/src/domain/signals.js';
import { POLICY } from '../docs/src/domain/safety.js';

function setup() {
  const bus = new VirtualCanBus();
  const events = new DomainEventBus();
  const audit = new SafetyAuditLog();
  audit.attach(events);
  const monitor = new RuntimeAssuranceMonitor({ bus, events });
  const sent = [];
  bus.subscribe((f) => sent.push(f));
  return { bus, events, audit, monitor, sent };
}

const redFlash = () => encodeZoneFrame({
  zoneId: 'console', r: 255, g: 40, b: 40, brightness: 200,
  effect: EFFECT.FLASH, speed: hzToSpeed(2.5),
});

test('継続再保証: 停車中に点灯した赤点滅は、走行開始で消灯される', () => {
  const { bus, monitor, sent } = setup();

  // 停車中: 赤点滅はTXゲートを通過してECUへラッチされる
  bus.send(encodeVehicleState({ speedKmh: 0, gear: 0 }), 'vehicle');
  const passed = monitor.send(redFlash(), 'safety');
  assert.ok(passed, '停車中の赤点滅は通る');

  // 走行開始 → モニタが再保証し、違反ゾーンを消灯（フォールバック）
  sent.length = 0;
  bus.send(encodeVehicleState({ speedKmh: 60, gear: 3 }), 'vehicle');
  const off = sent.find((f) => f.tag === 'monitor' && ZONE_BY_CANID[f.id]?.id === 'console');
  assert.ok(off, 'モニタが介入フレームを送出する');
  assert.equal(off.data[3], 0, '輝度0（消灯）へフォールバック');
  assert.ok(monitor.interventions >= 1);
});

test('継続再保証: 前方視野ゾーンの高輝度は走行開始でclampされる', () => {
  const { bus, monitor, sent } = setup();
  bus.send(encodeVehicleState({ speedKmh: 0 }), 'vehicle');
  monitor.send(encodeZoneFrame({
    zoneId: 'dashboard', r: 255, g: 245, b: 230, brightness: 255,
    effect: EFFECT.STATIC, speed: 0,
  }), 'safety');

  sent.length = 0;
  bus.send(encodeVehicleState({ speedKmh: 40, gear: 3 }), 'vehicle');
  const clamped = sent.find((f) => f.tag === 'monitor' && ZONE_BY_CANID[f.id]?.id === 'dashboard');
  assert.ok(clamped, 'clamp介入フレームが送出される');
  const maxB = Math.round(POLICY.forwardFieldMaxBrightnessDriving * 255);
  assert.ok(clamped.data[3] <= maxB, `輝度は上限 ${maxB} 以下`);
  assert.ok(clamped.data[3] > 0, '消灯ではなく安全側へ矯正');
});

test('TXゲート: 送信の瞬間に走行中なら、承認済みでも赤点滅は破棄される', () => {
  const { bus, monitor, sent } = setup();
  bus.send(encodeVehicleState({ speedKmh: 60, gear: 3 }), 'vehicle');
  sent.length = 0;
  const result = monitor.send(redFlash(), 'safety');
  assert.equal(result, null, 'ゲートで破棄され、バスへは流れない');
  assert.equal(sent.length, 0);
});

test('走行中でも問題ない点灯には介入しない（誤介入の抑制）', () => {
  const { bus, monitor, sent } = setup();
  bus.send(encodeVehicleState({ speedKmh: 0 }), 'vehicle');
  monitor.send(encodeZoneFrame({
    zoneId: 'footwell_fl', r: 40, g: 220, b: 235, brightness: 120,
    effect: EFFECT.BREATHE, speed: hzToSpeed(0.5),
  }), 'safety');

  sent.length = 0;
  bus.send(encodeVehicleState({ speedKmh: 60, gear: 3 }), 'vehicle');
  assert.ok(!sent.some((f) => f.tag === 'monitor'), '適合状態への介入は無い');
});

test('介入は監査証跡にポリシー版数つきで記録される', () => {
  const { bus, monitor, audit } = setup();
  bus.send(encodeVehicleState({ speedKmh: 0 }), 'vehicle');
  monitor.send(redFlash(), 'safety');
  bus.send(encodeVehicleState({ speedKmh: 60, gear: 3 }), 'vehicle');

  const interventions = audit.records.filter((r) => r.type === EVT.RUNTIME_INTERVENTION);
  assert.ok(interventions.length >= 1);
  assert.equal(interventions[0].policyVersion, POLICY.version);
  assert.ok(interventions[0].detail.includes('reassure'));
});

test('E-STOP(ALL_OFF)後はラッチが消え、走行開始しても介入対象が無い', () => {
  const { bus, monitor, sent } = setup();
  bus.send(encodeVehicleState({ speedKmh: 0 }), 'vehicle');
  monitor.send(redFlash(), 'safety');

  // E-STOP 相当のグローバル ALL_OFF
  bus.send(encodeGlobalFrame({ cmd: GLOBAL_CMD.ALL_OFF, masterBrightness: 0 }), 'estop');
  sent.length = 0;
  bus.send(encodeVehicleState({ speedKmh: 60, gear: 3 }), 'vehicle');
  assert.ok(!sent.some((f) => f.tag === 'monitor'), 'ラッチ済み状態が無いので介入しない');
});
