// 뒤집힘(90도 초과)과 기울기 크기에 따른 넘침 반응 검증
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { calibrate, tiltFrom, GRAVITY } from '../src/core/attitude.ts';
import { Cup } from '../src/core/cup.ts';
import type { MotionSample } from '../src/core/types.ts';

const sample = (x: number, y: number, z: number): MotionSample => ({
  acc: { x, y, z },
  t: 0,
});

/** 컵을 world y 축 둘레로 deg 만큼 기울인 상태의 가속도계 값. */
function tilted(deg: number): MotionSample {
  const r = (deg * Math.PI) / 180;
  // 폰 로컬에서 world 위 방향이 (sin, 0, cos) 으로 보인다.
  return sample(Math.sin(r) * GRAVITY, 0, Math.cos(r) * GRAVITY);
}

const CAL = calibrate([sample(0, 0, GRAVITY)]);

test('뒤집힘: 90도를 넘으면 overturned 로 표시된다', () => {
  for (const deg of [95, 120, 150, 180]) {
    const t = tiltFrom(CAL, tilted(deg));
    assert.equal(t.overturned, true, `${deg}도`);
  }
});

test('뒤집힘: 60도 이하는 overturned 가 아니다', () => {
  for (const deg of [0, 30, 60, 80]) {
    const t = tiltFrom(CAL, tilted(deg));
    assert.ok(!t.overturned, `${deg}도 에서 뒤집힘으로 오판`);
  }
});

test('뒤집힘: 완전히 뒤집으면 기울기는 0 이지만 overturned 다', () => {
  const t = tiltFrom(CAL, tilted(180));
  // 수평 성분이 0 이라 기울기 크기만 보면 평평해 보인다.
  assert.ok(Math.hypot(t.x, t.y) < 0.01, `tilt=${t.x},${t.y}`);
  assert.equal(t.overturned, true);
});

test('뒤집힘: 뒤집으면 물이 빠르게 전부 쏟아진다', () => {
  const cup = new Cup({ fill: 0.8 });
  const t = tiltFrom(CAL, tilted(180));

  // 0.3초(약 18프레임)만에 사실상 비어야 한다.
  for (let i = 0; i < 18; i++) cup.step(t, 16.7);

  assert.ok(cup.drained, `fill=${cup.fill}`);
  assert.ok(cup.spilledVolume > 0.6, `spilled=${cup.spilledVolume}`);
});

test('뒤집힘: 계속 뒤집혀 있어도 넘침은 한 번만 센다', () => {
  const cup = new Cup({ fill: 0.8 });
  const t = tiltFrom(CAL, tilted(180));
  for (let i = 0; i < 200; i++) cup.step(t, 16.7);
  assert.equal(cup.spills, 1);
});

test('기울기 크기: 많이 기울일수록 물이 빨리 준다', () => {
  const run = (deg: number, frames: number): number => {
    const cup = new Cup({ fill: 0.85 });
    const t = tiltFrom(CAL, tilted(deg));
    for (let i = 0; i < frames; i++) cup.step(t, 16.7);
    return cup.fill;
  };

  const slow = run(55, 60); // 1초
  const fast = run(78, 60); // 1초

  assert.ok(fast < slow, `78도 fill=${fast} 는 55도 fill=${slow} 보다 작아야 한다`);
  assert.ok(slow - fast > 0.05, `차이가 너무 작다: ${slow} vs ${fast}`);
});

test('기울기 크기: 90도 근처에서는 1초 안에 대부분 쏟아진다', () => {
  // 90도는 수직 성분이 0 에 가깝다. 여기서 기울기가 폭발하지 않도록
  // 하한을 두되, 충분히 커야 한다.
  const cup = new Cup({ fill: 0.85 });
  const t = tiltFrom(CAL, tilted(88));
  for (let i = 0; i < 60; i++) cup.step(t, 16.7);
  assert.ok(cup.fill < 0.45, `fill=${cup.fill}`);
});

test('기울기 크기: 살짝 기울이면 천천히 준다', () => {
  const cup = new Cup({ fill: 0.85 });
  const t = tiltFrom(CAL, tilted(35));
  for (let i = 0; i < 60; i++) cup.step(t, 16.7);
  // 1초에 절반 이상 날아가면 너무 예민하다.
  assert.ok(cup.fill > 0.5, `fill=${cup.fill}`);
});
