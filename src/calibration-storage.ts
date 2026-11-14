import { calibrate } from './core/attitude.ts';
import type { Calibration } from './core/attitude.ts';

export const CALIBRATION_KEY = 'papercup-calibration';

// 기준 중력 벡터만 저장하고 복원할 때 직교 기저를 다시 계산합니다.
export function loadCalibration(storage: Pick<Storage, 'getItem'>): Calibration | null {
  try {
    const raw = storage.getItem(CALIBRATION_KEY);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.version !== 1 || !record.acc || typeof record.acc !== 'object' || Array.isArray(record.acc)) return null;
    const acc = record.acc as Record<string, unknown>;
    if (![acc.x, acc.y, acc.z].every(v => typeof v === 'number' && Number.isFinite(v))) return null;
    const vector = { x: acc.x as number, y: acc.y as number, z: acc.z as number };
    if (Math.hypot(vector.x, vector.y, vector.z) > 30) return null;
    return calibrate([{ acc: vector, t: 0 }]);
  } catch { return null; }
}

export function saveCalibration(storage: Pick<Storage, 'setItem'>, calibration: Calibration): boolean {
  try {
    const { up, gMag } = calibration;
    const acc = { x: up.x * gMag, y: up.y * gMag, z: up.z * gMag };
    storage.setItem(CALIBRATION_KEY, JSON.stringify({ version: 1, acc }));
    return true;
  } catch { return false; }
}
