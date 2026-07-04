// domain/compiler.js — 信頼コンパイラ（ドメインサービス）: DSL → CAN フレーム列
//
// ここだけが CAN ID を知っている。DSL は ID を指定できないので、
// 生成されるフレームは必ずアンビエント系 ID に限定される（構造的サンドボックス）。
// 純粋関数であり I/O を持たない = ドメイン層に置ける。

import {
  ZONES, ZONE_BY_ID, EFFECT, encodeZoneFrame, hzToSpeed, clampByte,
} from './signals.js';
import { COLORS } from './program.js';

const EFFECT_ENUM = {
  static: EFFECT.STATIC, breathe: EFFECT.BREATHE, pulse: EFFECT.PULSE,
  wipe: EFFECT.WIPE, flash: EFFECT.FLASH, rainbow: EFFECT.RAINBOW,
};

export function compile(program) {
  const steps = [];
  let counter = 0;
  for (const action of program.actions) {
    const zoneIds = action.zones === 'all'
      ? ZONES.map((z) => z.id)
      : action.zones.filter((z) => ZONE_BY_ID[z]);
    const { r, g, b } = normalizeColor(action.color);
    const brightness = clampByte(Math.round((action.brightness / 100) * 255));
    const effect = EFFECT_ENUM[action.effect] ?? EFFECT.STATIC;
    const speed = hzToSpeed(action.hz ?? 0.5);
    const atMs = action.startMs ?? 0;
    for (const zoneId of zoneIds) {
      steps.push({
        atMs,
        frame: encodeZoneFrame({
          zoneId, r, g, b, brightness, effect, speed,
          counter: counter++ & 0x0f,
        }),
      });
    }
  }
  return { steps, durationMs: program.durationMs, endState: program.endState };
}

function normalizeColor(color) {
  if (typeof color === 'string') {
    const rgb = COLORS[color.toLowerCase()] || COLORS[color] || COLORS.amber;
    return { r: rgb[0], g: rgb[1], b: rgb[2] };
  }
  return { r: clampByte(color.r), g: clampByte(color.g), b: clampByte(color.b) };
}
