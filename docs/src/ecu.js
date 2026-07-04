// ecu.js — アンビエント照明ECU（アクチュエータ）のモデル
//
// 検証済みフレームだけを受け取り、各ゾーンの状態を保持する。
// HMI は effectiveColor() を毎フレーム呼んで、時間依存のエフェクトを描画する。

import {
  ZONES, ZONE_BY_CANID, EFFECT, CAN_ID, GLOBAL_CMD, speedToHz,
} from './signals.js';

export class AmbientEcu {
  constructor() {
    this.master = 1; // マスター輝度(0..1)
    this.zones = {};
    for (const z of ZONES) {
      this.zones[z.id] = {
        r: 0, g: 0, b: 0, brightness: 0, effect: EFFECT.STATIC, hz: 0, since: 0,
      };
    }
  }

  // 仮想バスから来たフレームを取り込む（購読コールバックに渡す）
  ingest(frame, nowMs) {
    if (frame.id === CAN_ID.ALM_GLOBAL_CMD) {
      const cmd = frame.data[0];
      if (cmd === GLOBAL_CMD.ALL_OFF) {
        for (const z of ZONES) Object.assign(this.zones[z.id], { brightness: 0, effect: EFFECT.STATIC });
        this.master = 0;
      } else {
        this.master = frame.data[1] / 255;
      }
      return;
    }
    const zone = ZONE_BY_CANID[frame.id];
    if (!zone) return; // 照明ECUの管轄外は無視
    const d = frame.data;
    this.zones[zone.id] = {
      r: d[0], g: d[1], b: d[2], brightness: d[3], effect: d[4],
      hz: speedToHz(d[5]), since: nowMs,
    };
  }

  // 時刻 nowMs におけるゾーンの実効色（0..1 の rgb と輝度）を返す。
  effectiveColor(zoneId, nowMs) {
    const s = this.zones[zoneId];
    const base = { r: s.r / 255, g: s.g / 255, b: s.b / 255 };
    const t = (nowMs - s.since) / 1000; // 秒
    let level = s.brightness / 255;
    let col = base;

    switch (s.effect) {
      case EFFECT.STATIC:
        break;
      case EFFECT.BREATHE: {
        const w = 0.5 + 0.5 * Math.sin(2 * Math.PI * (s.hz || 0.4) * t);
        level *= 0.25 + 0.75 * w;
        break;
      }
      case EFFECT.PULSE: {
        // 鋭い立ち上がり・緩い減衰の鼓動
        const phase = ((s.hz || 1) * t) % 1;
        level *= Math.max(0, 1 - phase) ** 1.5;
        break;
      }
      case EFFECT.WIPE: {
        const w = 0.5 + 0.5 * Math.sin(2 * Math.PI * (s.hz || 0.8) * t - zoneIndex(zoneId));
        level *= 0.3 + 0.7 * w;
        break;
      }
      case EFFECT.FLASH: {
        const on = Math.sin(2 * Math.PI * (s.hz || 2) * t) > 0;
        level *= on ? 1 : 0.05;
        break;
      }
      case EFFECT.RAINBOW: {
        const hue = (t * 60 + zoneIndex(zoneId) * 40) % 360;
        col = hslToRgb(hue / 360, 0.9, 0.55);
        break;
      }
    }
    level *= this.master;
    return { r: col.r, g: col.g, b: col.b, level: Math.max(0, Math.min(1, level)) };
  }

  cssColor(zoneId, nowMs) {
    const c = this.effectiveColor(zoneId, nowMs);
    const r = Math.round(c.r * 255), g = Math.round(c.g * 255), b = Math.round(c.b * 255);
    return { fill: `rgb(${r},${g},${b})`, level: c.level };
  }
}

function zoneIndex(zoneId) {
  return ZONES.findIndex((z) => z.id === zoneId);
}

function hslToRgb(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return { r: f(0), g: f(8), b: f(4) };
}
