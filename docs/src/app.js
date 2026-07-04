// app.js — UI配線 + HMI描画ループ
//
// フロー:  意図 → HeuristicPlanner.generate(DSL) → compile(frames)
//          → reviewProgram(安全審査) → 承認ステップを仮想バスへスケジュール送信
//          → AmbientEcu が状態更新 → SVGゾーンを毎フレーム描画

import { VirtualCanBus, scheduleProgram } from './can.js';
import { HeuristicPlanner, compile, PRESETS } from './planner.js';
import { reviewProgram, buildEstopProgram, VERDICT, effectLabel } from './safety.js';
import { AmbientEcu } from './ecu.js';
import {
  ZONES, ZONE_BY_CANID, CAN_ID, GEAR, EFFECT_NAME,
  encodeVehicleState, frameToHex, idToHex, decodeVehicleState, speedToHz,
} from './signals.js';

const $ = (s) => document.querySelector(s);

const bus = new VirtualCanBus();
const ecu = new AmbientEcu();
const planner = new HeuristicPlanner();

let vehicle = { ignition: 1, gear: GEAR.P, speedKmh: 0, doors: 0 };
let cancelRun = null;

// ECU はバス上のフレームを購読して状態更新
bus.subscribe((frame) => ecu.ingest(frame, performance.now()));
// バスモニタも購読
bus.subscribe((frame) => pushBusRow(frame));

// ---- 車両状態 -----------------------------------------------------------
function setSpeed(kmh) {
  vehicle = {
    ...vehicle,
    speedKmh: kmh,
    gear: kmh > 0 ? GEAR.D : GEAR.P,
  };
  const driving = kmh > 5;
  $('#speed-out').textContent = `${kmh} km/h（${driving ? '走行 · D' : '停車 · P'}）`;
  const badge = $('#vehicle-badge');
  badge.textContent = `${driving ? '走行中' : '停車中'} · ${driving ? 'D' : 'P'} · ${kmh} km/h`;
  badge.className = 'badge ' + (driving ? 'badge-drive' : 'badge-park');
  bus.send(encodeVehicleState(vehicle), 'vehicle');
}

// ---- メイン: 生成 → 審査 → 実行 ----------------------------------------
async function runIntent(intent) {
  if (cancelRun) { cancelRun(); cancelRun = null; }

  // ② AI生成 DSL
  const dsl = await planner.generate(intent);
  renderDsl(dsl);

  // コンパイル（信頼された変換: ここだけがCAN IDを知る）
  const compiled = compile(dsl);
  renderFrames(compiled);

  // ③ 安全審査
  const review = reviewProgram(compiled, vehicle);
  renderSafety(review);

  // ④ 承認ステップのみをスケジュール送信
  cancelRun = scheduleProgram(bus, review.approvedSteps, 'safety');
}

function emergencyStop() {
  if (cancelRun) { cancelRun(); cancelRun = null; }
  const estop = buildEstopProgram();
  for (const s of estop.steps) bus.send(s.frame, 'estop');
  flashSafety('E-STOP 実行: 全ゾーン消灯・フェイルセーフ状態へ');
}

// ---- レンダリング: DSL / frames / safety / bus --------------------------
function renderDsl(dsl) {
  $('#dsl-out').textContent = JSON.stringify(dsl, null, 2);
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
  const cls = frame.tag === 'estop' ? 'row-estop' : frame.tag === 'vehicle' ? 'row-veh' : 'row-tx';
  busRows.unshift(
    `<div class="brow ${cls}"><span class="bt">${(frame.t / 1000).toFixed(2)}s</span>` +
    `<span class="bid">${idToHex(frame.id)}</span>` +
    `<span class="bd">${frameToHex(frame)}</span>` +
    `<span class="bn">${z ? z.label : (frame.tag === 'vehicle' ? 'VEHICLE_STATE' : frame.tag === 'estop' ? 'E-STOP' : 'GLOBAL')}</span></div>`,
  );
  if (busRows.length > 40) busRows.pop();
  $('#bus-monitor').innerHTML = busRows.join('');
  $('#bus-count').textContent = `送信 ${bus.txCount} フレーム`;
}

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

buildPresets();
setSpeed(0);
requestAnimationFrame(render);

// 初回デモ: ウェルカム点灯を自動実行
runIntent(PRESETS[0].intent);
$('#intent').value = PRESETS[0].intent;
