import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceRunoff, runoffProfile, runoffTrail } from '../src/runoff.ts';

test('물막은 말린 테두리와 컵 바깥면을 관통하지 않고 아래까지 이어진다', () => {
  for (let i = 0; i <= 100; i++) {
    const p = i / 100;
    const { radius, height } = runoffProfile(p);
    assert.ok(Number.isFinite(radius) && Number.isFinite(height));
    if (p < 0.12) {
      assert.ok(Math.hypot(radius - 0.985, height - 1) > 0.044);
    } else {
      const wall = 0.735 + (height + 0.98) / 1.96 * 0.265;
      assert.ok(radius > wall && radius < wall + 0.04);
    }
  }
  assert.ok(runoffProfile(1).height < -0.9);
  const before = runoffProfile(0.12 - 1e-6);
  const after = runoffProfile(0.12);
  assert.ok(Math.hypot(before.radius - after.radius, before.height - after.height) < 0.001);
});

test('넘친 물은 옆면을 따라 늦게 도착하고 공급이 멎은 뒤 배수된다', () => {
  const column = new Float32Array(29);
  advanceRunoff(column, 0.6, 1 / 60);
  assert.ok(column[0]! > 0);
  assert.equal(column[28], 0);
  for (let i = 0; i < 90; i++) advanceRunoff(column, 0.6, 1 / 60);
  assert.ok(column[28]! > 0.5);
  advanceRunoff(column, 0, 1 / 60);
  assert.equal(column[0], 0);
  assert.ok(column[28]! > 0.5);
  for (let i = 0; i < 180; i++) advanceRunoff(column, 0, 1 / 60);
  assert.ok(column.every(value => value >= 0 && value < 0.001));
});

test('물길의 위치는 시간에 흔들리지 않고 이웃 물길은 아래쪽에서 만난다', () => {
  for (let i = 0; i < 40; i++) {
    assert.ok(Math.abs(runoffTrail(i, 0, 0, 40).angle - i / 40 * Math.PI * 2) < 1e-12);
    const groupStart = Math.floor(i / 5) * 5;
    assert.equal(runoffTrail(i, 1, 0, 40).angle, runoffTrail(groupStart, 1, 0, 40).angle);
    for (const p of [0.2, 0.5, 0.8]) {
      assert.equal(runoffTrail(i, p, 0, 40).angle, runoffTrail(i, p, 1800, 40).angle);
    }
  }
});

test('물길의 굵기는 이동하며 연속된 선과 끊어진 구간을 모두 만든다', () => {
  const widths = Array.from({ length: 150 }, (_, i) => runoffTrail(12, 0.5, i * 40, 40).width);
  assert.ok(widths.some(width => width === 0));
  assert.ok(widths.some(width => width > 0.5));
  assert.ok(widths.every(width => Number.isFinite(width) && width >= 0));
});
