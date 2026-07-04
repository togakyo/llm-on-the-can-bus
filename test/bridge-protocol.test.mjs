// bridge-protocol.test.mjs — Unity ブリッジのメッセージ変換の単体テスト
// トランスポート(UDP)には触れず、純粋関数だけを検証する。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  welcomeMessage, frameMessage, zonesMessage, eventMessage,
  resultMessage, parseClientMessage,
} from '../scripts/bridge-protocol.mjs';
import { AmbientEcu } from '../docs/src/infrastructure/ecu.js';
import { ZONES, EFFECT, encodeZoneFrame } from '../docs/src/domain/signals.js';

test('welcome: 全ゾーンカタログを ZONES と同じ並びで含む', () => {
  const msg = welcomeMessage('1.1.0');
  assert.equal(msg.type, 'welcome');
  assert.equal(msg.policyVersion, '1.1.0');
  assert.deepEqual(msg.zones.map((z) => z.id), ZONES.map((z) => z.id));
  assert.equal(msg.zones.find((z) => z.id === 'dashboard').forwardField, true);
});

test('frame: ゾーン指令フレームを ID 解決つきで JSON 化する', () => {
  const frame = encodeZoneFrame({
    zoneId: 'footwell_fl', r: 0, g: 255, b: 255, brightness: 200,
    effect: EFFECT.BREATHE, speed: 13,
  });
  const msg = frameMessage({ ...frame, tag: 'safety', seq: 7 });
  assert.equal(msg.type, 'frame');
  assert.equal(msg.idHex, '0x3C0');
  assert.equal(msg.zone, 'footwell_fl');
  assert.equal(msg.data.length, 8);
  assert.equal(msg.data[1], 255);
});

test('zones: ECU にラッチされた状態のスナップショットを配列で返す', () => {
  const ecu = new AmbientEcu();
  ecu.ingest(encodeZoneFrame({
    zoneId: 'console', r: 0, g: 200, b: 0, brightness: 180,
    effect: EFFECT.PULSE, speed: 32,
  }), 1000);
  const msg = zonesMessage(ecu, 1500);
  assert.equal(msg.type, 'zones');
  assert.equal(msg.nowMs, 1500);
  assert.equal(msg.zones.length, ZONES.length);
  const consoleZone = msg.zones.find((z) => z.id === 'console');
  assert.equal(consoleZone.g, 200);
  assert.equal(consoleZone.effectName, 'PULSE');
  assert.equal(consoleZone.sinceMs, 1000);
  // JsonUtility 互換: マップではなく配列
  assert.ok(Array.isArray(msg.zones));
});

test('event: ドメインイベントを C# 予約語を避けた形へ変換する', () => {
  const msg = eventMessage({
    type: 'RuntimeIntervention', at: 123, detail: 'clamp dashboard',
    verdict: 'clamp', phase: 'tx-gate', policyVersion: '1.1.0',
  });
  assert.equal(msg.type, 'event');
  assert.equal(msg.name, 'RuntimeIntervention');
  assert.equal(msg.verdict, 'clamp');
  assert.equal(msg.programId, ''); // undefined は空文字へ正規化（JsonUtility 対策）
});

test('result: runIntent の返り値からサマリを組み立てる', () => {
  const msg = resultMessage({
    program: { id: 'p1', status: 'completed', dsl: { title: 'テスト' } },
    source: 'ルール（オフライン）',
    review: { summary: { pass: 5, clamp: 1, reject: 0, driving: false } },
  });
  assert.equal(msg.ok, true);
  assert.equal(msg.status, 'completed');
  assert.equal(msg.pass, 5);
  assert.equal(msg.clamp, 1);
});

test('parse: intent/vehicle は正規化され、不正入力は null になる', () => {
  const intent = parseClientMessage(Buffer.from(JSON.stringify({
    type: 'intent', text: ' 足元を青く ', mode: 'llm',
  })));
  assert.deepEqual(intent, { type: 'intent', text: '足元を青く', mode: 'llm' });

  // mode が不明なら heuristic に落とす
  const fallback = parseClientMessage(Buffer.from(JSON.stringify({ type: 'intent', text: 'x', mode: 'evil' })));
  assert.equal(fallback.mode, 'heuristic');

  // vehicle は範囲外をクランプ
  const vehicle = parseClientMessage(Buffer.from(JSON.stringify({
    type: 'vehicle', ignition: 1, gear: 9, speedKmh: 99999, doors: -5,
  })));
  assert.deepEqual(vehicle, { type: 'vehicle', ignition: 1, gear: 3, speedKmh: 500, doors: 0 });

  assert.equal(parseClientMessage(Buffer.from('not json')), null);
  assert.equal(parseClientMessage(Buffer.from('{"type":"unknown"}')), null);
  assert.equal(parseClientMessage(Buffer.from('{"type":"intent","text":""}')), null);
});
