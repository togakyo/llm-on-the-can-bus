// safety.test.mjs — セーフティ・スーパーバイザーの単体テスト
// 実行: node --test  (または npm test)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EFFECT, GLOBAL_CMD, CAN_ID, encodeZoneFrame, checksum, speedToHz, hzToSpeed,
} from '../docs/src/domain/signals.js';
import { HeuristicPlanner } from '../docs/src/infrastructure/planners.js';
import { compile } from '../docs/src/domain/compiler.js';
import { reviewProgram, buildEstopProgram, VERDICT, POLICY } from '../docs/src/domain/safety.js';

const PARKED = { ignition: 1, gear: 0, speedKmh: 0, doors: 0 };
const DRIVING = { ignition: 1, gear: 3, speedKmh: 60, doors: 0 };

test('停車中の穏やかなプログラムは全て pass', async () => {
  const planner = new HeuristicPlanner();
  const dsl = await planner.generate('足元をシアンでゆっくり呼吸');
  const { results, summary } = reviewProgram(compile(dsl), PARKED);
  assert.equal(summary.reject, 0);
  assert.equal(summary.clamp, 0);
  assert.ok(results.every((r) => r.verdict === VERDICT.PASS));
});

test('走行中の赤色点滅は reject される', async () => {
  const planner = new HeuristicPlanner();
  const dsl = await planner.generate('全部を赤く速く点滅させて警告');
  const { summary } = reviewProgram(compile(dsl), DRIVING);
  assert.ok(summary.reject > 0, '走行中の赤点滅は破棄されるべき');
});

test('走行中のダッシュボード高輝度点滅は clamp（点滅→呼吸・輝度制限）', () => {
  // 白の高輝度フラッシュをダッシュボードへ（赤ではないので reject ではなく clamp）
  const frame = encodeZoneFrame({
    zoneId: 'dashboard', r: 255, g: 245, b: 230,
    brightness: 255, effect: EFFECT.FLASH, speed: hzToSpeed(4),
  });
  const compiled = { steps: [{ atMs: 0, frame }], durationMs: 5000, endState: 'off' };
  const { results } = reviewProgram(compiled, DRIVING);
  const res = results[0];
  assert.equal(res.verdict, VERDICT.CLAMP);
  // 効果は BREATHE に格下げ、輝度は上限以下
  assert.equal(res.frame.data[4], EFFECT.BREATHE);
  const maxB = Math.round(POLICY.forwardFieldMaxBrightnessDriving * 255);
  assert.ok(res.frame.data[3] <= maxB);
});

test('高周波パルスは走行中に上限Hzへ clamp される', () => {
  const frame = encodeZoneFrame({
    zoneId: 'console', r: 40, g: 220, b: 90,
    brightness: 180, effect: EFFECT.PULSE, speed: hzToSpeed(8),
  });
  const compiled = { steps: [{ atMs: 0, frame }], durationMs: 5000, endState: 'hold' };
  const { results } = reviewProgram(compiled, DRIVING);
  assert.equal(results[0].verdict, VERDICT.CLAMP);
  assert.ok(speedToHz(results[0].frame.data[5]) <= POLICY.maxFlashHzDriving + 1e-6);
});

test('許可外CAN ID（例: ブレーキ系 0x0A0）は reject される', () => {
  // 有効なチェックサム付きで「許可されていないID」のフレームを捏造
  const data = [1, 2, 3, 4, 5, 6, 0, 0];
  data[7] = checksum(data, 0x0a0);
  const frame = { id: 0x0a0, dlc: 8, data };
  const compiled = { steps: [{ atMs: 0, frame }], durationMs: 1000, endState: 'off' };
  const { results, summary } = reviewProgram(compiled, PARKED);
  assert.equal(results[0].verdict, VERDICT.REJECT);
  assert.ok(summary.reject >= 1);
});

test('チェックサム不一致フレームは reject される', () => {
  const frame = encodeZoneFrame({
    zoneId: 'door_fl', r: 10, g: 10, b: 10, brightness: 100, effect: EFFECT.STATIC, speed: 0,
  });
  frame.data[3] = (frame.data[3] + 1) & 0xff; // 中身を改ざん
  const compiled = { steps: [{ atMs: 0, frame }], durationMs: 1000, endState: 'off' };
  const { results } = reviewProgram(compiled, PARKED);
  assert.equal(results[0].verdict, VERDICT.REJECT);
});

test('E-STOP プログラムは全ゾーンを輝度0にする', () => {
  const estop = buildEstopProgram();
  const zoneFrames = estop.steps.filter((s) => s.frame.id >= CAN_ID.ZONE_BASE);
  assert.ok(zoneFrames.length >= 7);
  for (const s of zoneFrames) assert.equal(s.frame.data[3], 0, '輝度は0であるべき');
  const global = estop.steps.find((s) => s.frame.id === CAN_ID.ALM_GLOBAL_CMD);
  assert.equal(global.frame.data[0], GLOBAL_CMD.ALL_OFF);
});

test('ウォッチドッグ: 長すぎる継続時間は上限へ clamp される', () => {
  const frame = encodeZoneFrame({
    zoneId: 'door_fl', r: 10, g: 200, b: 10, brightness: 80, effect: EFFECT.STATIC, speed: 0,
  });
  const compiled = { steps: [{ atMs: 0, frame }], durationMs: 60000, endState: 'hold' };
  const { durationMs, summary } = reviewProgram(compiled, PARKED);
  assert.equal(durationMs, POLICY.maxDurationMs);
  assert.ok(summary.watchdog.length >= 1);
});

test('endState:off はプログラム末尾に全消灯ステップを追加する', async () => {
  const planner = new HeuristicPlanner();
  const dsl = await planner.generate('全部を赤く速く点滅'); // flash → endState off
  const compiled = compile(dsl);
  const { approvedSteps, durationMs } = reviewProgram(compiled, PARKED);
  const tail = approvedSteps.filter((s) => s.atMs === durationMs);
  assert.ok(tail.length >= 7, '末尾に全ゾーンOFFが入るべき');
});
