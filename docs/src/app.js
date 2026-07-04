// app.js — UI配線 + HMI描画ループ（プレゼンテーション層）
//
// DDD 構成: ここは「描画とDOMイベント」だけを持ち、業務フローは
// application/ActuationService に、安全知識は domain/ に委譲する。
//
// フロー:  意図 → ActuationService.runIntent()
//            ② プランナー生成 → ACL(normalizeDsl) → LightingProgram 集約
//            ③ 信頼コンパイラ → ④ 安全審査 → ⑤ TXゲート経由でバスへ
//          RuntimeAssuranceMonitor が車両状態をセンシングし、実行中も再保証
//          AmbientEcu が状態更新 → SVGゾーンを毎フレーム描画

import { VirtualCanBus, scheduleProgram } from './infrastructure/can.js';
import { HeuristicPlanner, LlmPlanner, PRESETS } from './infrastructure/planners.js';
import { AmbientEcu } from './infrastructure/ecu.js';
import { DomainEventBus, EVT } from './domain/events.js';
import { SafetyAuditLog } from './domain/audit.js';
import { ActuationService } from './application/actuation-service.js';
import { RuntimeAssuranceMonitor } from './application/runtime-monitor.js';
import {
  ZONES, ZONE_BY_CANID, CAN_ID, GEAR,
  encodeVehicleState, frameToHex, idToHex,
} from './domain/signals.js';

const $ = (s) => document.querySelector(s);

// ---- 合成ルート（Composition Root）: 依存をここで一度だけ組み立てる ------
const bus = new VirtualCanBus();
const ecu = new AmbientEcu();
const events = new DomainEventBus();
const audit = new SafetyAuditLog({ capacity: 120 });
audit.attach(events);
const monitor = new RuntimeAssuranceMonitor({ bus, events });
const llmPlanner = new LlmPlanner('http://localhost:8000');
const service = new ActuationService({
  bus,
  monitor,
  events,
  planners: { heuristic: new HeuristicPlanner(), llm: llmPlanner },
  scheduler: scheduleProgram,
});
let mode = 'heuristic'; // 'heuristic' | 'llm'

// ECU はバス上のフレームを購読して状態更新
bus.subscribe((frame) => ecu.ingest(frame, performance.now()));
// バスモニタも購読
bus.subscribe((frame) => pushBusRow(frame));

// ---- 車両状態 -----------------------------------------------------------
let vehicleUi = { ignition: 1, gear: GEAR.P, speedKmh: 0, doors: 0 };

function setSpeed(kmh) {
  vehicleUi = { ...vehicleUi, speedKmh: kmh, gear: kmh > 0 ? GEAR.D : GEAR.P };
  const driving = kmh > 5;
  $('#speed-out').textContent = `${kmh} km/h（${driving ? '走行 · D' : '停車 · P'}）`;
  const badge = $('#vehicle-badge');
  badge.textContent = `${driving ? '走行中' : '停車中'} · ${driving ? 'D' : 'P'} · ${kmh} km/h`;
  badge.className = 'badge ' + (driving ? 'badge-drive' : 'badge-park');
  // センサ値としてバスへ流す → RuntimeAssuranceMonitor が受信して再保証する
  bus.send(encodeVehicleState(vehicleUi), 'vehicle');
}

// ---- メイン: 生成 → 審査 → 実行 ----------------------------------------
async function runIntent(intent) {
  const { program, source, review } = await service.runIntent(intent, mode);
  renderDsl(program, source);
  renderFrames(program.compiled);
  renderSafety(review);
}

function emergencyStop() {
  service.estop();
  flashSafety('E-STOP 実行: 全ゾーン消灯・フェイルセーフ状態へ');
}

// ---- レンダリング: DSL / frames / safety / bus / audit -------------------
function renderDsl(program, source) {
  const src = $('#dsl-source');
  if (src) src.textContent = `${program.id} · 生成元: ${source}`;
  $('#dsl-out').textContent = JSON.stringify(program.dsl, null, 2);
}

function renderFrames(compiled) {
  const lines = compiled.steps.map((s) => {
    const z = ZONE_BY_CANID[s.frame.id];
    return `+${String(s.atMs).padStart(5)}ms  ${idToHex(s.frame.id)} [${s.frame.dlc}]  ${frameToHex(s.frame)}  ; ${z ? z.label : '-'}`;
  });
  $('#frames-out').textContent = lines.join('\n') || '—';
}

function renderSafety(review) {
  const { results, summary } = review;
  $('#safety-summary').textContent =
    `${summary.driving ? '走行中ポリシー' : '停車中ポリシー'} · ` +
    `PASS ${summary.pass} / CLAMP ${summary.clamp} / REJECT ${summary.reject}`;

  const list = $('#safety-list');
  list.innerHTML = '';
  for (const r of results) {
    const z = r.zoneId ? (ZONES.find((x) => x.id === r.zoneId)?.label ?? r.zoneId) : (r.frame.id === CAN_ID.ALM_GLOBAL_CMD ? 'グローバル' : idToHex(r.frame.id));
    const li = document.createElement('li');
    li.className = `sv sv-${r.verdict}`;
    const tag = { pass: 'PASS', clamp: 'CLAMP', reject: 'REJECT' }[r.verdict];
    li.innerHTML = `<span class="sv-tag">${tag}</span><span class="sv-zone">${z}</span><span class="sv-reason">${r.reasons.join(' / ')}</span>`;
    list.appendChild(li);
  }
  for (const w of summary.watchdog) {
    const li = document.createElement('li');
    li.className = 'sv sv-clamp';
    li.innerHTML = `<span class="sv-tag">WDT</span><span class="sv-zone">watchdog</span><span class="sv-reason">${w}</span>`;
    list.appendChild(li);
  }
  if (!results.length) list.innerHTML = '<li class="muted">審査対象なし</li>';
}

function flashSafety(msg) {
  const list = $('#safety-list');
  list.innerHTML = `<li class="sv sv-reject"><span class="sv-tag">STOP</span><span class="sv-reason">${msg}</span></li>`;
  $('#safety-summary').textContent = '';
}

const busRows = [];
function pushBusRow(frame) {
  const z = ZONE_BY_CANID[frame.id];
  const cls = frame.tag === 'estop' ? 'row-estop'
    : frame.tag === 'vehicle' ? 'row-veh'
    : frame.tag === 'monitor' ? 'row-estop'
    : 'row-tx';
  busRows.unshift(
    `<div class="brow ${cls}"><span class="bt">${(frame.t / 1000).toFixed(2)}s</span>` +
    `<span class="bid">${idToHex(frame.id)}</span>` +
    `<span class="bd">${frameToHex(frame)}</span>` +
    `<span class="bn">${frame.tag === 'monitor' ? 'RTA介入' : z ? z.label : (frame.tag === 'vehicle' ? 'VEHICLE_STATE' : frame.tag === 'estop' ? 'E-STOP' : 'GLOBAL')}</span></div>`,
  );
  if (busRows.length > 40) busRows.pop();
  $('#bus-monitor').innerHTML = busRows.join('');
  $('#bus-count').textContent = `送信 ${bus.txCount} フレーム`;
}

// ---- 実行時保証（RTA）ステータス + 監査証跡 -------------------------------
const auditRows = [];
audit.onAppend((rec) => {
  const t = new Date(rec.at).toLocaleTimeString('ja-JP', { hour12: false });
  const cls = rec.type === EVT.RUNTIME_INTERVENTION || rec.type === EVT.ESTOP_TRIGGERED
    ? 'arow-alert'
    : rec.type === EVT.PROGRAM_REVIEWED ? 'arow-review' : '';
  auditRows.unshift(
    `<div class="arow ${cls}"><span class="at">#${rec.seq} ${t}</span>` +
    `<span class="aev">${rec.type}</span>` +
    `<span class="apid">${rec.programId ?? ''}${rec.policyVersion ? ` · policy v${rec.policyVersion}` : ''}</span>` +
    `<span class="adet">${rec.detail}</span></div>`,
  );
  if (auditRows.length > 60) auditRows.pop();
  $('#audit-log').innerHTML = auditRows.join('');
});

events.subscribe(EVT.RUNTIME_INTERVENTION, () => {
  const el = $('#rta-status');
  el.textContent = `⚠ 介入 ${monitor.interventions} 件（安全側へ矯正済み）`;
  el.className = 'rta-status rta-intervened';
});
events.subscribe(EVT.PROGRAM_DISPATCHED, () => {
  if (monitor.interventions === 0) {
    const el = $('#rta-status');
    el.textContent = '● NOMINAL — 逸脱なし';
    el.className = 'rta-status rta-nominal';
  }
});

// ---- SVG イルミ描画ループ ----------------------------------------------
const zoneEls = {};
for (const z of ZONES) {
  zoneEls[z.id] = [...document.querySelectorAll(`[data-zone="${z.id}"]`)];
}
const chipsWrap = $('#zone-chips');
const chipEls = {};
for (const z of ZONES) {
  const c = document.createElement('span');
  c.className = 'zchip';
  c.innerHTML = `<i></i>${z.label}`;
  chipsWrap.appendChild(c);
  chipEls[z.id] = c;
}

function render() {
  const now = performance.now();
  for (const z of ZONES) {
    const { fill, level } = ecu.cssColor(z.id, now);
    for (const el of zoneEls[z.id]) {
      const stroke = el.classList.contains('lit-stroke');
      if (stroke) el.style.stroke = fill; else el.style.fill = fill;
      el.style.opacity = (0.12 + 0.88 * level).toFixed(3);
      el.style.filter = level > 0.02 ? `drop-shadow(0 0 ${(4 + 22 * level).toFixed(1)}px ${fill})` : 'none';
    }
    const chip = chipEls[z.id];
    const dot = chip.querySelector('i');
    dot.style.background = fill;
    dot.style.boxShadow = level > 0.05 ? `0 0 8px ${fill}` : 'none';
    chip.style.opacity = (0.35 + 0.65 * level).toFixed(2);
  }
  requestAnimationFrame(render);
}

// ---- UI 配線 ------------------------------------------------------------
function buildPresets() {
  const wrap = $('#presets');
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.textContent = p.label;
    b.addEventListener('click', () => {
      $('#intent').value = p.intent;
      runIntent(p.intent);
    });
    wrap.appendChild(b);
  }
}

$('#generate').addEventListener('click', () => runIntent($('#intent').value));
$('#intent').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') runIntent($('#intent').value);
});
$('#estop').addEventListener('click', emergencyStop);
$('#speed').addEventListener('input', (e) => setSpeed(+e.target.value));

// プランナーのモード切替（ルール / ローカルAI）
for (const radio of document.querySelectorAll('input[name="mode"]')) {
  radio.addEventListener('change', async (e) => {
    mode = e.target.value;
    const note = $('#mode-note');
    if (mode === 'llm') {
      note.textContent = '接続確認中…';
      try {
        const h = await llmPlanner.health();
        note.textContent = `✅ 接続OK: ${h.model ?? 'model'}（${h.device ?? 'cpu'}）`;
        note.className = 'mode-note ok';
      } catch {
        note.textContent = '⚠️ localhost:8000 に未接続。backend-rs か ai/planner_server.py を起動してください（未接続時はルールにフォールバック）';
        note.className = 'mode-note warn';
      }
    } else {
      note.textContent = '';
      note.className = 'mode-note';
    }
  });
}

buildPresets();
setSpeed(0);
requestAnimationFrame(render);

// 初回デモ: ウェルカム点灯を自動実行
runIntent(PRESETS[0].intent);
$('#intent').value = PRESETS[0].intent;
