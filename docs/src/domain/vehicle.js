// domain/vehicle.js — 車両状態（Value Object）
//
// 「走行中かどうか」の判断はドメイン知識であり、UI やインフラに散らばらせない。
// VehicleState は不変（freeze）で、比較・派生値だけを提供する。
// センシング経路: VEHICLE_STATE フレーム → decodeVehicleState() → VehicleState.of()

import { GEAR, GEAR_NAME } from './signals.js';

export class VehicleState {
  constructor({ ignition = 1, gear = GEAR.P, speedKmh = 0, doors = 0 } = {}) {
    this.ignition = ignition & 0x01;
    this.gear = gear & 0x03;
    this.speedKmh = Math.max(0, Math.min(0xffff, Math.round(speedKmh)));
    this.doors = doors & 0xff;
    Object.freeze(this);
  }

  static of(raw) {
    return raw instanceof VehicleState ? raw : new VehicleState(raw ?? {});
  }

  // 「走行中」の閾値はセーフティ・エンベロープ（policy）が持つ
  isDriving(policy) {
    return this.speedKmh > policy.drivingSpeedKmh;
  }

  gearName() {
    return GEAR_NAME[this.gear] ?? '?';
  }

  equals(other) {
    return (
      other instanceof VehicleState &&
      this.ignition === other.ignition &&
      this.gear === other.gear &&
      this.speedKmh === other.speedKmh &&
      this.doors === other.doors
    );
  }
}

export const PARKED_DEFAULT = new VehicleState({});
