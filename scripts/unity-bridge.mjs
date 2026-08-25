// scripts/unity-bridge.mjs — Unity 向けヘッドレスホスト + UDP ブリッジ
//
// ブラウザ UI の代わりに Unity をアクチュエータ描画層（信頼されない表示装置）として
// 接続するための合成ルート。ドメイン/アプリケーション層は docs/src のものをそのまま使い、
// 安全審査・実行時保証はすべてこの Node プロセス側（信頼側）で行う。
//
//   使い方:  npm run bridge            （UDP :9200 で待ち受け）
//            BRIDGE_PORT=9300 npm run bridge
//
// プロトコル仕様: unity/PROTOCOL.md

import dgram from 'node:dgram';

import { VirtualCanBus, scheduleProgram } from '../docs/src/infrastructure/can.js';
import { AmbientEcu } from '../docs/src/infrastructure/ecu.js';
import { HeuristicPlanner, LlmPlanner } from '../docs/src/infrastructure/planners.js';
import { ActuationService } from '../docs/src/application/actuation-service.js';
import { RuntimeAssuranceMonitor } from '../docs/src/application/runtime-monitor.js';
import { DomainEventBus } from '../docs/src/domain/events.js';
import { SafetyAuditLog } from '../docs/src/domain/audit.js';
import { encodeVehicleState } from '../docs/src/domain/signals.js';
import { POLICY } from '../docs/src/domain/safety.js';
import { formatReasonsEn } from '../docs/src/i18n.js';

import {
  welcomeMessage, frameMessage, zonesMessage, eventMessage,
  resultMessage, errorMessage, parseClientMessage, encodeMessage,
} from './bridge-protocol.mjs';

const PORT = Number(process.env.BRIDGE_PORT ?? process.argv[2] ?? 9200);
const CLIENT_TIMEOUT_MS = 10_000; // hello が途絶えたクライアントは切り離す

// --- 合成ルート（app.js のヘッドレス版）------------------------------------
const bus = new VirtualCanBus();
const events = new DomainEventBus();
const audit = new SafetyAuditLog();
audit.attach(events);
// ブリッジのログ/HUDは英語固定（表示ロケールを持たないヘッドレス環境のため）
const monitor = new RuntimeAssuranceMonitor({ bus, events, formatReasons: formatReasonsEn });
const ecu = new AmbientEcu();
bus.subscribe((frame) => ecu.ingest(frame, performance.now()));
const service = new ActuationService({
  bus, monitor, events,
  planners: { heuristic: new HeuristicPlanner(), llm: new LlmPlanner() },
  scheduler: scheduleProgram,
});

// --- UDP ブリッジ -----------------------------------------------------------
const sock = dgram.createSocket('udp4');
let client = null; // { address, port, lastSeen }

function push(msg) {
  if (!client) return;
  sock.send(encodeMessage(msg), client.port, client.address);
}

// バスの全フレームと、それを取り込んだ後の ECU 状態を転送する。
// （ecu.ingest の購読が先に登録済みなので、この時点のスナップショットは最新）
bus.subscribe((frame) => {
  push(frameMessage(frame));
  push(zonesMessage(ecu, performance.now()));
});

// 全ドメインイベントを Unity のデバッグ HUD へ転送 + コンソールにも記録
events.subscribe('*', (evt) => {
  push(eventMessage(evt));
  console.log(`[event] ${evt.type}${evt.detail ? ` — ${evt.detail}` : ''}`);
});

sock.on('message', async (buf, rinfo) => {
  const msg = parseClientMessage(buf);
  if (!msg) return;

  if (!client || client.address !== rinfo.address || client.port !== rinfo.port) {
    if (msg.type !== 'hello') return; // 未接続の相手からの指令は無視（hello で接続してから）
    client = { address: rinfo.address, port: rinfo.port, lastSeen: Date.now() };
    console.log(`[bridge] client connected: ${rinfo.address}:${rinfo.port}`);
  } else {
    client.lastSeen = Date.now();
  }

  switch (msg.type) {
    case 'hello':
      push(welcomeMessage(POLICY.version));
      push(zonesMessage(ecu, performance.now()));
      break;
    case 'vehicle':
      bus.send(encodeVehicleState(msg), 'vehicle');
      break;
    case 'intent':
      console.log(`[intent] (${msg.mode}) ${msg.text}`);
      try {
        push(resultMessage(await service.runIntent(msg.text, msg.mode)));
      } catch (err) {
        console.error('[intent] failed:', err);
        push(errorMessage(err));
      }
      break;
    case 'estop':
      service.estop();
      break;
  }
});

setInterval(() => {
  if (client && Date.now() - client.lastSeen > CLIENT_TIMEOUT_MS) {
    console.log(`[bridge] client timed out: ${client.address}:${client.port}`);
    client = null;
  }
}, 5_000).unref();

sock.bind(PORT, () => {
  // 初期状態: 停車中（Unity 接続後は VehicleStateReporter が上書きしてくる）
  bus.send(encodeVehicleState({ speedKmh: 0 }), 'vehicle');
  console.log(`LLM-on-the-CAN-bus Unity bridge listening on udp://0.0.0.0:${PORT}`);
  console.log(`safety envelope: v${POLICY.version} — Unity 側の手順は unity/README.md 参照`);
});
