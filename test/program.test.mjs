// program.test.mjs — LightingProgram 集約と腐敗防止層(normalizeDsl)のテスト
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LightingProgram, PROGRAM_STATUS, normalizeDsl } from '../docs/src/domain/program.js';
import { compile } from '../docs/src/domain/compiler.js';
import { reviewProgram } from '../docs/src/domain/safety.js';

const PARKED = { ignition: 1, gear: 0, speedKmh: 0, doors: 0 };
const DRIVING = { ignition: 1, gear: 3, speedKmh: 60, doors: 0 };

test('腐敗防止層: 壊れたLLM出力でも安全な既定DSLに矯正される', () => {
  const dsl = normalizeDsl({ actions: 'garbage', durationMs: 999999 });
  assert.ok(dsl.actions.length >= 1);
  assert.ok(dsl.durationMs <= 30000);
  assert.ok(['hold', 'off'].includes(dsl.endState));
});

test('腐敗防止層: 未知ゾーン・範囲外の値は既定へ丸められる', () => {
  const dsl = normalizeDsl({
    title: 'x'.repeat(200),
    actions: [{ zones: ['brake_line', 'engine'], color: { r: 9999, g: -5, b: 128 }, brightness: 500, effect: 'explode', hz: 99 }],
  });
  assert.ok(dsl.title.length <= 60);
  const a = dsl.actions[0];
  assert.equal(a.zones, 'all'); // 未知ゾーンのみ → all にフォールバック
  assert.equal(a.color.r, 255);
  assert.equal(a.color.g, 0);
  assert.equal(a.brightness, 100);
  assert.equal(a.effect, 'breathe'); // 未知エフェクト → 安全な breathe
  assert.ok(a.hz <= 8);
});

test('集約ライフサイクル: generated→compiled→approved→active→completed', () => {
  const p = LightingProgram.fromUntrusted({
    intent: 'テスト', source: 'test',
    rawDsl: { title: 't', durationMs: 1000, endState: 'off', actions: [{ zones: ['console'], color: 'green', brightness: 50, effect: 'static' }] },
  });
  assert.match(p.id, /^LP-\d{4}$/);
  assert.equal(p.status, PROGRAM_STATUS.GENERATED);

  p.markCompiled(compile(p.dsl));
  assert.equal(p.status, PROGRAM_STATUS.COMPILED);

  p.markReviewed(reviewProgram(p.compiled, PARKED));
  assert.equal(p.status, PROGRAM_STATUS.APPROVED);

  p.markActive();
  p.markCompleted();
  assert.equal(p.status, PROGRAM_STATUS.COMPLETED);
  assert.ok(p.isTerminal);
  assert.ok(p.history.length >= 5, '全遷移が履歴に残る');
});

test('集約: 不正な状態遷移は例外（審査前に実行できない）', () => {
  const p = LightingProgram.fromUntrusted({ intent: 'x', rawDsl: {}, source: 'test' });
  assert.throws(() => p.markActive(), /invalid transition/);
});

test('集約: 全フレーム破棄なら rejected になり実行へ進めない', () => {
  const p = LightingProgram.fromUntrusted({
    intent: '赤点滅', source: 'test',
    // 前方視野ゾーン(dashboard)を含めない: dashboard は「点滅→呼吸」への
    // clamp で生き残るため、全滅させるには非前方視野ゾーンのみにする
    rawDsl: { title: 'r', durationMs: 3000, endState: 'off', actions: [{ zones: ['console', 'door_fl'], color: 'red', brightness: 90, effect: 'flash', hz: 3 }] },
  });
  p.markCompiled(compile(p.dsl));
  p.markReviewed(reviewProgram(p.compiled, DRIVING));
  assert.equal(p.status, PROGRAM_STATUS.REJECTED);
  assert.throws(() => p.markActive(), /invalid transition/);
});
