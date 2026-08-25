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
//
// 表示言語(EN/JA)はこの層だけの関心事。ドメインは言語を知らず、審査理由を
// 構造データ({code,...})で返すので、切替は「描き直すだけ」で成立する。

import { VirtualCanBus, scheduleProgram } from './infrastructure/can.js';
import { HeuristicPlanner, LlmPlanner, PRESETS, presetLabel, presetIntent } from './infrastructure/planners.js';
import { AmbientEcu } from './infrastructure/ecu.js';
import { Cabin3D } from './infrastructure/cabin3d.js';
import { DomainEventBus, EVT } from './domain/events.js';
import { SafetyAuditLog } from './domain/audit.js';
import { ActuationService } from './application/actuation-service.js';
import { RuntimeAssuranceMonitor } from './application/runtime-monitor.js';
import {
  ZONES, ZONE_BY_CANID, CAN_ID, GEAR,
  encodeVehicleState, frameToHex, idToHex,
} from './domain/signals.js';
import {
  t, getLang, setLang, onLangChange, applyDom,
  zoneLabel, formatReasons, formatReasonsEn,
} from './i18n.js';

const $ = (s) => document.querySelector(s);

// ---- 合成ルート（Composition Root）: 依存をここで一度だけ組み立てる ------
const bus = new VirtualCanBus();
const ecu = new AmbientEcu();
const events = new DomainEventBus();
const audit = new SafetyAuditLog({ capacity: 120 });
audit.attach(events);
// 監査証跡は「機械が読むログ」なので理由文は英語固定にする（UIロケールに依存させない）。
const monitor = new RuntimeAssuranceMonitor({ bus, events, formatReasons: formatReasonsEn });
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
  renderVehicle();
  // センサ値としてバスへ流す → RuntimeAssuranceMonitor が受信して再保証する
  bus.send(encodeVehicleState(vehicleUi), 'vehicle');
}

function renderVehicle() {
  const kmh = vehicleUi.speedKmh;
  const driving = kmh > 5;
  const state = t(driving ? 'veh.driving' : 'veh.parked');
  const gear = driving ? 'D' : 'P';
  $('#speed-out').textContent = `${kmh} km/h · ${state} · ${gear}`;
  const badge = $('#vehicle-badge');
  badge.textContent = `${state} · ${gear} · ${kmh} km/h`;
  badge.className = 'badge ' + (driving ? 'badge-drive' : 'badge-park');
}

// ---- メイン: 生成 → 審査 → 実行 ----------------------------------------
// 最後の結果を保持しておき、言語切替時に「再審査せず」描き直せるようにする。
let last = { program: null, source: null, review: null };

async function runIntent(intent) {
  const { program, source, review } = await service.runIntent(intent, mode);
  last = { program, source, review };
  renderDsl();
  renderFrames();
  renderSafety();
}

function emergencyStop() {
  service.estop();
  last = { program: null, source: null, review: null };
  flashSafety(t('safety.estop'));
}

// ---- レンダリング: DSL / frames / safety / bus / audit -------------------
function renderDsl() {
  const { program, source } = last;
  const src = $('#dsl-source');
  if (src) src.textContent = program ? `${program.id} · ${t('dsl.source')}: ${source}` : '';
  $('#dsl-out').textContent = program
    ? JSON.stringify(program.dsl, null, 2)
    : t('dsl.empty');
}

function renderFrames() {
  const compiled = last.program?.compiled;
  if (!compiled) { $('#frames-out').textContent = '—'; return; }
  const lines = compiled.steps.map((s) => {
    const z = ZONE_BY_CANID[s.frame.id];
    return `+${String(s.atMs).padStart(5)}ms  ${idToHex(s.frame.id)} [${s.frame.dlc}]  ${frameToHex(s.frame)}  ; ${z ? zoneLabel(z) : '-'}`;
  });
  $('#frames-out').textContent = lines.join('\n') || '—';
}

function renderSafety() {
  const list = $('#safety-list');
  if (!last.review) {
    list.innerHTML = `<li class="muted">${t('safety.empty')}</li>`;
    $('#safety-summary').textContent = '';
    return;
  }
  const { results, summary } = last.review;
  $('#safety-summary').textContent =
    `${t(summary.driving ? 'safety.policyD' : 'safety.policyP')} · ` +
    `PASS ${summary.pass} / CLAMP ${summary.clamp} / REJECT ${summary.reject}`;

  list.innerHTML = '';
  for (const r of results) {
    const zone = r.zoneId ? ZONES.find((x) => x.id === r.zoneId) : null;
    const z = zone ? zoneLabel(zone)
      : (r.frame.id === CAN_ID.ALM_GLOBAL_CMD ? 'GLOBAL' : idToHex(r.frame.id));
    const li = document.createElement('li');
    li.className = `sv sv-${r.verdict}`;
    const tag = { pass: 'PASS', clamp: 'CLAMP', reject: 'REJECT' }[r.verdict];
    li.innerHTML = `<span class="sv-tag">${tag}</span><span class="sv-zone">${z}</span><span class="sv-reason">${formatReasons(r.reasons)}</span>`;
    list.appendChild(li);
  }
  for (const w of summary.watchdog) {
    const li = document.createElement('li');
    li.className = 'sv sv-clamp';
    li.innerHTML = `<span class="sv-tag">WDT</span><span class="sv-zone">watchdog</span><span class="sv-reason">${formatReasons([w])}</span>`;
    list.appendChild(li);
  }
  if (!results.length) list.innerHTML = `<li class="muted">${t('safety.none')}</li>`;
}

function flashSafety(msg) {
  const list = $('#safety-list');
  list.innerHTML = `<li class="sv sv-reject"><span class="sv-tag">STOP</span><span class="sv-reason">${msg}</span></li>`;
  $('#safety-summary').textContent = '';
}

// バス行は「言語に依存しない生データ」で保持し、描画時に文言化する。
const busRows = [];
function pushBusRow(frame) {
  busRows.unshift(frame);
  if (busRows.length > 40) busRows.pop();
  renderBus();
}

function busRowName(frame) {
  if (frame.tag === 'monitor') return t('bus.rta');
  const z = ZONE_BY_CANID[frame.id];
  if (z) return zoneLabel(z);
  if (frame.tag === 'vehicle') return 'VEHICLE_STATE';
  if (frame.tag === 'estop') return t('bus.estop');
  return 'GLOBAL';
}

function renderBus() {
  $('#bus-monitor').innerHTML = busRows.map((frame) => {
    const cls = frame.tag === 'estop' || frame.tag === 'monitor' ? 'row-estop'
      : frame.tag === 'vehicle' ? 'row-veh'
      : 'row-tx';
    return `<div class="brow ${cls}"><span class="bt">${(frame.t / 1000).toFixed(2)}s</span>` +
      `<span class="bid">${idToHex(frame.id)}</span>` +
      `<span class="bd">${frameToHex(frame)}</span>` +
      `<span class="bn">${busRowName(frame)}</span></div>`;
  }).join('');
  $('#bus-count').textContent = `${bus.txCount} ${t('bus.count')}`;
}

// ---- 実行時保証（RTA）ステータス + 監査証跡 -------------------------------
const auditRows = [];
audit.onAppend((rec) => {
  const time = new Date(rec.at).toLocaleTimeString('en-GB', { hour12: false });
  const cls = rec.type === EVT.RUNTIME_INTERVENTION || rec.type === EVT.ESTOP_TRIGGERED
    ? 'arow-alert'
    : rec.type === EVT.PROGRAM_REVIEWED ? 'arow-review' : '';
  auditRows.unshift(
    `<div class="arow ${cls}"><span class="at">#${rec.seq} ${time}</span>` +
    `<span class="aev">${rec.type}</span>` +
    `<span class="apid">${rec.programId ?? ''}${rec.policyVersion ? ` · policy v${rec.policyVersion}` : ''}</span>` +
    `<span class="adet">${rec.detail}</span></div>`,
  );
  if (auditRows.length > 60) auditRows.pop();
  $('#audit-log').innerHTML = auditRows.join('');
});

function renderRta() {
  const el = $('#rta-status');
  if (monitor.interventions > 0) {
    el.textContent = t('rta.intervened', { n: monitor.interventions });
    el.className = 'rta-status rta-intervened';
  } else {
    el.textContent = t('rta.nominal');
    el.className = 'rta-status rta-nominal';
  }
}

events.subscribe(EVT.RUNTIME_INTERVENTION, renderRta);
events.subscribe(EVT.PROGRAM_DISPATCHED, renderRta);

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
  c.innerHTML = '<i></i><b></b>';
  chipsWrap.appendChild(c);
  chipEls[z.id] = c;
}
function renderChipLabels() {
  for (const z of ZONES) chipEls[z.id].querySelector('b').textContent = zoneLabel(z);
}

function render() {
  const now = performance.now();
  if (cabin3d && viewMode === '3d') {
    cabin3d.render(ecu, now);
  }
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
  for (const [group, sel] of [['safe', '#presets-safe'], ['attack', '#presets-attack']]) {
    const wrap = $(sel);
    wrap.innerHTML = '';
    for (const p of PRESETS.filter((x) => x.group === group)) {
      const b = document.createElement('button');
      b.className = group === 'attack' ? 'chip chip-attack' : 'chip';
      b.textContent = presetLabel(p, getLang());
      b.addEventListener('click', () => {
        const intent = presetIntent(p, getLang());
        $('#intent').value = intent;
        runIntent(intent);
      });
      wrap.appendChild(b);
    }
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
      note.textContent = t('llm.checking');
      note.className = 'mode-note';
      try {
        const h = await llmPlanner.health();
        note.textContent = t('llm.ok', { m: h.model ?? 'model', d: h.device ?? 'cpu' });
        note.className = 'mode-note ok';
      } catch {
        note.textContent = t('llm.down');
        note.className = 'mode-note warn';
      }
    } else {
      note.textContent = '';
      note.className = 'mode-note';
    }
  });
}

// ---- 2D / 3D ビュー切替 --------------------------------------------------
// 3Dは SVG とまったく同じ「表示アダプタ」なので、切り替えても審査やバスには一切影響しない。
// WebGL が使えない環境では 3D ボタン自体を出さず、2D のまま動かす。
const VIEW_KEY = 'canai.view';
let viewMode = '2d';
const cabin3d = Cabin3D.create($('#cabin3d'));

function applyView(next) {
  if (next === '3d' && !cabin3d) return;
  viewMode = next;
  const on3d = next === '3d';
  // #cabin は SVGElement で、HTML の hidden プロパティを実装しない → display で消す
  $('#cabin').style.display = on3d ? 'none' : '';
  $('#cabin3d').hidden = !on3d;
  $('#cam-presets').hidden = !on3d;
  for (const b of document.querySelectorAll('#view-switch button')) {
    b.classList.toggle('active', b.dataset.view === next);
  }
  try { localStorage.setItem(VIEW_KEY, next); } catch { /* non-fatal */ }
}

function applyCam(name) {
  cabin3d?.setView(name);
  for (const b of document.querySelectorAll('#cam-presets button')) {
    b.classList.toggle('active', b.dataset.cam === name);
  }
}

if (cabin3d) {
  $('#view-switch').hidden = false;
  for (const b of document.querySelectorAll('#view-switch button')) {
    b.addEventListener('click', () => applyView(b.dataset.view));
  }
  for (const b of document.querySelectorAll('#cam-presets button')) {
    b.addEventListener('click', () => applyCam(b.dataset.cam));
  }
  let saved = null;
  try { saved = localStorage.getItem(VIEW_KEY); } catch { /* non-fatal */ }
  applyCam('overview');
  applyView(saved === '2d' ? '2d' : '3d'); // 既定は3D（デモGIFと同じ絵を最初に見せる）
} else {
  applyView('2d');
}

// ---- 言語切替 -----------------------------------------------------------
function markLangButtons() {
  for (const b of document.querySelectorAll('.lang-switch button')) {
    b.classList.toggle('active', b.dataset.lang === getLang());
  }
}
for (const b of document.querySelectorAll('.lang-switch button')) {
  b.addEventListener('click', () => setLang(b.dataset.lang));
}
onLangChange(() => {
  applyDom();
  markLangButtons();
  buildPresets();
  renderChipLabels();
  renderVehicle();
  renderDsl();
  renderFrames();
  renderSafety();
  renderBus();
  renderRta();
});

// ---- 起動 ---------------------------------------------------------------
applyDom();
markLangButtons();
buildPresets();
renderChipLabels();
setSpeed(0);
requestAnimationFrame(render);

// ---- 起動時のディープリンク --------------------------------------------
// ?speed=60&preset=redflash のように指定すると、その車両状態のままプリセットを
// 実行した状態で開く。README から「REJECTされる瞬間」へ直接リンクするために使う。
// 例: ?lang=en&speed=60&preset=redflash
const params = new URLSearchParams(location.search);

const speedParam = Number(params.get('speed'));
if (Number.isFinite(speedParam) && speedParam > 0) {
  const kmh = Math.max(0, Math.min(120, Math.round(speedParam / 5) * 5));
  $('#speed').value = String(kmh);
  setSpeed(kmh);
}

const preset = PRESETS.find((p) => p.key === params.get('preset')) ?? PRESETS[0];
const first = presetIntent(preset, getLang());
$('#intent').value = first;
runIntent(first);
