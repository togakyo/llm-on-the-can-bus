// safety.js — セーフティ・スーパーバイザー（安全審査層）
//
// コンパイル済み CAN フレーム列を「実バスへ流す前に」1フレームずつ検査する。
// 判定は pass / clamp（値を安全側へ丸めて通す）/ reject（破棄）の3種。
// 判定は車両状態(停車/走行/ギア/ドア)に依存する ＝ 状況認識のある安全制御。
//
// この層はデモの中で最も安全上重要なので、Nodeの単体テスト対象にしている。

import {
  ALLOWED_TX_IDS, ZONE_BY_CANID, EFFECT, EFFECT_NAME, CAN_ID, GLOBAL_CMD,
  encodeZoneFrame, encodeGlobalFrame, verifyChecksum, speedToHz, hzToSpeed,
  clampByte, idToHex,
} from './signals.js';

export const POLICY = {
  drivingSpeedKmh: 5,        // これを超えたら「走行中」扱い
  maxFlashHz: 5,            // 常時: 光過敏対策の上限周波数
  maxFlashHzDriving: 3,    // 走行中: さらに厳しく
  forwardFieldMaxBrightnessDriving: 0.4, // 前方視野ゾーンの走行中輝度上限(比率)
  masterMaxBrightnessDriving: 0.6,       // 走行中のマスター輝度上限(比率)
  maxDurationMs: 30000,    // ウォッチドッグ: 単一プログラムの最大継続時間
};

export const VERDICT = { PASS: 'pass', CLAMP: 'clamp', REJECT: 'reject' };

// フレーム1枚を検査。clampされた場合は checksum を張り直した新フレームを返す。
export function inspectFrame(frame, vehicle) {
  const reasons = [];
  const driving = vehicle.speedKmh > POLICY.drivingSpeedKmh;

  // (1) メッセージ完全性
  if (!verifyChecksum(frame)) {
    return { verdict: VERDICT.REJECT, frame, reasons: ['チェックサム不一致（改ざん/破損の疑い）'] };
  }

  // (2) 送信ID allowlist（コンパイラで保証済みだが二重チェック=多層防御）
  if (!ALLOWED_TX_IDS.has(frame.id)) {
    return {
      verdict: VERDICT.REJECT, frame,
      reasons: [`許可外ID ${idToHex(frame.id)} — 安全系/他ドメインへの送信は禁止`],
    };
  }

  // グローバル指令は輝度上限のみ確認
  if (frame.id === CAN_ID.ALM_GLOBAL_CMD) {
    return inspectGlobal(frame, driving, reasons);
  }

  // (3) ゾーン指令の検査
  const zone = ZONE_BY_CANID[frame.id];
  const d = frame.data;
  let [r, g, b, brightness, effect, speed] = [d[0], d[1], d[2], d[3], d[4], d[5]];
  const counter = (d[7] >> 4) & 0x0f;
  let changed = false;

  // 常時: フラッシュ/パルスの周波数上限（光過敏対策）
  const hzCap = driving ? POLICY.maxFlashHzDriving : POLICY.maxFlashHz;
  if ((effect === EFFECT.FLASH || effect === EFFECT.PULSE) && speedToHz(speed) > hzCap) {
    reasons.push(`点滅周波数 ${speedToHz(speed)}Hz → ${hzCap}Hz に制限`);
    speed = hzToSpeed(hzCap);
    changed = true;
  }

  if (driving) {
    // (a) 前方視野ゾーンの点滅は注意散漫 → 呼吸(BREATHE)へ格下げ
    if (zone.forwardField && effect === EFFECT.FLASH) {
      reasons.push(`走行中の${zone.label}の点滅は禁止 → 呼吸へ変更`);
      effect = EFFECT.BREATHE;
      changed = true;
    }
    // (b) 前方視野ゾーンの輝度上限（グレア対策）
    const maxB = Math.round(POLICY.forwardFieldMaxBrightnessDriving * 255);
    if (zone.forwardField && brightness > maxB) {
      reasons.push(`走行中の${zone.label}輝度 ${pct(brightness)} → ${pct(maxB)} に制限`);
      brightness = maxB;
      changed = true;
    }
    // (c) 走行中の「赤い点滅」は警告灯と誤認するため全ゾーンで禁止
    if (isRed(r, g, b) && effect === EFFECT.FLASH) {
      return {
        verdict: VERDICT.REJECT, frame, zoneId: zone.id,
        reasons: [`走行中の赤色点滅は警告表示と誤認するため禁止（${zone.label}）`],
      };
    }
  }

  if (!changed) {
    return { verdict: VERDICT.PASS, frame, zoneId: zone.id, reasons: ['適合'] };
  }
  const clamped = encodeZoneFrame({
    zoneId: zone.id, r, g, b, brightness, effect, speed, counter,
  });
  return { verdict: VERDICT.CLAMP, frame: clamped, original: frame, zoneId: zone.id, reasons };
}

function inspectGlobal(frame, driving, reasons) {
  const cmd = frame.data[0];
  let master = frame.data[1];
  const counter = (frame.data[7] >> 4) & 0x0f;
  if (driving) {
    const cap = Math.round(POLICY.masterMaxBrightnessDriving * 255);
    if (master > cap) {
      reasons.push(`走行中マスター輝度 ${pct(master)} → ${pct(cap)} に制限`);
      const clamped = encodeGlobalFrame({ cmd, masterBrightness: cap, counter });
      return { verdict: VERDICT.CLAMP, frame: clamped, original: frame, reasons };
    }
  }
  return { verdict: VERDICT.PASS, frame, reasons: ['適合'] };
}

// プログラム全体（コンパイル済み）を審査。承認されたステップのみ返す。
export function reviewProgram(compiled, vehicle) {
  const results = [];
  const approvedSteps = [];
  for (const step of compiled.steps) {
    const res = inspectFrame(step.frame, vehicle);
    results.push(res);
    if (res.verdict !== VERDICT.REJECT) {
      approvedSteps.push({ atMs: step.atMs, frame: res.frame });
    }
  }

  // ウォッチドッグ: 継続時間の上限と、明示的な終了状態を強制
  let durationMs = compiled.durationMs ?? POLICY.maxDurationMs;
  const watchdog = [];
  if (durationMs > POLICY.maxDurationMs) {
    watchdog.push(`継続時間 ${durationMs}ms → ${POLICY.maxDurationMs}ms に制限`);
    durationMs = POLICY.maxDurationMs;
  }
  // 終了時にOFFへ落とす指定なら、末尾に全消灯を必ず追加（フェイルセーフ）
  const endOff = compiled.endState === 'off';
  if (endOff) {
    for (const step of buildAllOffSteps()) {
      approvedSteps.push({ atMs: durationMs, frame: step.frame });
    }
  }

  const summary = {
    total: results.length,
    pass: results.filter((r) => r.verdict === VERDICT.PASS).length,
    clamp: results.filter((r) => r.verdict === VERDICT.CLAMP).length,
    reject: results.filter((r) => r.verdict === VERDICT.REJECT).length,
    driving: vehicle.speedKmh > POLICY.drivingSpeedKmh,
    watchdog,
  };
  return { results, approvedSteps, durationMs, summary };
}

// E-STOP: グローバル全消灯 ＋ 各ゾーンOFF を即時送出するフォールバック。
export function buildEstopProgram() {
  const steps = [{ atMs: 0, frame: encodeGlobalFrame({ cmd: GLOBAL_CMD.ALL_OFF, masterBrightness: 0 }) }];
  for (const s of buildAllOffSteps()) steps.push({ atMs: 0, frame: s.frame });
  return { steps, durationMs: 0, endState: 'off' };
}

function buildAllOffSteps() {
  return Object.values(ZONE_BY_CANID).map((zone) => ({
    atMs: 0,
    frame: encodeZoneFrame({
      zoneId: zone.id, r: 0, g: 0, b: 0, brightness: 0, effect: EFFECT.STATIC, speed: 0,
    }),
  }));
}

function isRed(r, g, b) {
  return r > 160 && g < 100 && b < 100;
}
function pct(v) {
  return Math.round((v / 255) * 100) + '%';
}
export function effectLabel(e) {
  return EFFECT_NAME[e] ?? String(e);
}
