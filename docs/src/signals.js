// signals.js — 車載アンビエント照明ECUの CAN シグナル定義（DBC相当）
//
// このデモが扱うのは「快適系（コンフォート）」の照明ECU 1ノードだけ。
// パワートレインやブレーキなど安全系のバス／IDには一切アクセスしない、
// というのがアーキテクチャ上の大前提（後段の Safety Supervisor でも二重に検査）。

// --- CAN ID マップ（11bit 標準ID）---------------------------------------
// 0x0C0        : VEHICLE_STATE   （他ECUがブロードキャストする車両状態。読むだけ）
// 0x3BF        : ALM_GLOBAL_CMD  （マスター輝度 / 全消灯 / E-STOP）
// 0x3C0..0x3C6 : ALM_ZONE_CMD    （各イルミゾーンへの色・輝度・エフェクト指令）
export const CAN_ID = {
  VEHICLE_STATE: 0x0c0,
  ALM_GLOBAL_CMD: 0x3bf,
  ZONE_BASE: 0x3c0,
};

// 生成プログラムが触れてよい ID の範囲（Safety の allowlist と一致させる）
export const ALLOWED_TX_IDS = new Set([
  CAN_ID.ALM_GLOBAL_CMD,
  0x3c0, 0x3c1, 0x3c2, 0x3c3, 0x3c4, 0x3c5, 0x3c6,
]);

// --- イルミネーションゾーン定義 ------------------------------------------
// forwardField: 運転者の前方視野内にあり、グレア/注意散漫の観点で
//               走行中は特に厳しく制限すべきゾーン。
export const ZONES = [
  { id: 'footwell_fl', canId: 0x3c0, label: '足元 左前', forwardField: false },
  { id: 'footwell_fr', canId: 0x3c1, label: '足元 右前', forwardField: false },
  { id: 'door_fl',     canId: 0x3c2, label: 'ドアトリム 左', forwardField: false },
  { id: 'door_fr',     canId: 0x3c3, label: 'ドアトリム 右', forwardField: false },
  { id: 'dashboard',   canId: 0x3c4, label: 'ダッシュボード', forwardField: true },
  { id: 'console',     canId: 0x3c5, label: 'センターコンソール', forwardField: false },
  { id: 'cupholder',   canId: 0x3c6, label: 'カップホルダー', forwardField: false },
];

export const ZONE_BY_ID = Object.fromEntries(ZONES.map((z) => [z.id, z]));
export const ZONE_BY_CANID = Object.fromEntries(ZONES.map((z) => [z.canId, z]));

// --- エフェクト種別 -------------------------------------------------------
export const EFFECT = {
  STATIC: 0,   // 点灯（固定）
  BREATHE: 1,  // ゆっくり呼吸
  PULSE: 2,    // パルス
  WIPE: 3,     // 流れる
  FLASH: 4,    // 点滅（走行中は制限対象）
  RAINBOW: 5,  // レインボー
};
export const EFFECT_NAME = Object.fromEntries(
  Object.entries(EFFECT).map(([k, v]) => [v, k]),
);

// グローバル指令コード
export const GLOBAL_CMD = {
  NORMAL: 0,
  ALL_OFF: 1,   // 全ゾーン即時消灯（E-STOP のフォールバック）
  MASTER_DIM: 2,
};

// 車両ギア
export const GEAR = { P: 0, R: 1, N: 2, D: 3 };
export const GEAR_NAME = { 0: 'P', 1: 'R', 2: 'N', 3: 'D' };

// speed(0..255) を Hz に変換（FLASH/PULSE の周波数）。255 ≒ 8Hz。
export function speedToHz(speed) {
  return +(speed / 32).toFixed(2);
}
export function hzToSpeed(hz) {
  return clampByte(Math.round(hz * 32));
}

export function clampByte(v) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

// --- フレーム生成ヘルパ ---------------------------------------------------
// ゾーン指令ペイロード(8byte):
//   [0]R [1]G [2]B [3]brightness [4]effect [5]speed [6]reserved
//   [7] = rollingCounter(上位4bit) | checksum(下位4bit)   ← メッセージ完全性
export function encodeZoneFrame({ zoneId, r, g, b, brightness, effect, speed, counter = 0 }) {
  const zone = ZONE_BY_ID[zoneId];
  if (!zone) throw new Error(`unknown zone: ${zoneId}`);
  const data = [
    clampByte(r), clampByte(g), clampByte(b),
    clampByte(brightness), effect & 0xff, clampByte(speed), 0, 0,
  ];
  data[7] = ((counter & 0x0f) << 4) | checksum(data, zone.canId);
  return { id: zone.canId, dlc: 8, data, meta: { zoneId } };
}

export function encodeGlobalFrame({ cmd, masterBrightness = 255, counter = 0 }) {
  const data = [cmd & 0xff, clampByte(masterBrightness), 0, 0, 0, 0, 0, 0];
  data[7] = ((counter & 0x0f) << 4) | checksum(data, CAN_ID.ALM_GLOBAL_CMD);
  return { id: CAN_ID.ALM_GLOBAL_CMD, dlc: 8, data, meta: { global: true } };
}

export function encodeVehicleState({ ignition = 1, gear = GEAR.P, speedKmh = 0, doors = 0 }) {
  const data = [
    ignition & 0x01, gear & 0x03,
    speedKmh & 0xff, (speedKmh >> 8) & 0xff,
    doors & 0xff, 0, 0, 0,
  ];
  data[7] = checksum(data, CAN_ID.VEHICLE_STATE);
  return { id: CAN_ID.VEHICLE_STATE, dlc: 8, data, meta: { vehicleState: true } };
}

export function decodeVehicleState(frame) {
  const d = frame.data;
  return {
    ignition: d[0] & 0x01,
    gear: d[1] & 0x03,
    speedKmh: d[2] | (d[3] << 8),
    doors: d[4],
  };
}

// 簡易チェックサム（4bit）。実車の CRC ではないがメッセージ完全性の考え方を再現。
export function checksum(data, canId) {
  let sum = (canId & 0xff) ^ ((canId >> 8) & 0xff);
  for (let i = 0; i < 7; i++) sum = (sum + data[i]) & 0xff;
  return sum & 0x0f;
}

export function verifyChecksum(frame) {
  const expected = checksum(frame.data, frame.id);
  return (frame.data[7] & 0x0f) === expected;
}

export function frameToHex(frame) {
  return frame.data.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}

export function idToHex(id) {
  return '0x' + id.toString(16).toUpperCase().padStart(3, '0');
}
