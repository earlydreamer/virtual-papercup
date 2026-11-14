import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrate } from '../src/core/attitude.ts';
import { CALIBRATION_KEY, loadCalibration, saveCalibration } from '../src/calibration-storage.ts';

test('기준 중력 벡터를 저장하고 새 브라우저 세션에서 기저를 복원한다', () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const original = calibrate([{ acc: { x: 2, y: 4, z: 8 }, t: 0 }]);
  assert.equal(saveCalibration(storage, original), true);
  const restored = loadCalibration(storage)!;
  assert.ok(restored);
  for (const axis of ['up', 'ex', 'ey'] as const) for (const component of ['x', 'y', 'z'] as const) {
    assert.ok(Math.abs(restored[axis][component] - original[axis][component]) < 1e-12);
  }
  assert.ok(Math.abs(restored.gMag - original.gMag) < 1e-12);
});

test('없는 값과 손상된 기준은 복원하지 않는다', () => {
  for (const value of [null, '{broken', '{}', '{"version":2,"acc":{"x":0,"y":0,"z":9}}',
    '{"version":1,"acc":{"x":0,"y":0,"z":0}}', '{"version":1,"acc":{"x":0,"y":0,"z":300}}',
    '{"version":1,"acc":{"x":"0","y":0,"z":9}}']) {
    assert.equal(loadCalibration({ getItem: key => key === CALIBRATION_KEY ? value : null }), null);
  }
  assert.equal(loadCalibration({ getItem: () => { throw new Error('blocked'); } }), null);
  assert.equal(saveCalibration({ setItem: () => { throw new Error('full'); } }, calibrate([{ acc: { x: 0, y: 0, z: 9.8 }, t: 0 }])), false);
});
