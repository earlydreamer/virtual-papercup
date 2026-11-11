import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  calibrate,
  tiltFrom,
  tiltAngleDeg,
  LowPassTilt,
  GRAVITY,
} from '../src/core/attitude.ts';
import { Cup } from '../src/core/cup.ts';
import type { MotionSample } from '../src/core/types.ts';

const sample = (x: number, y: number, z: number, t = 0): MotionSample => ({
  acc: { x, y, z },
  t,
});

/** 정지 상태: 화면이 위를 향하면 가속도계는 위쪽으로 중력 크기를 읽는다. */
const REST = sample(0, 0, GRAVITY);

// --- 캘리브레이션 ---

test('calibrate: 정지 샘플의 평균으로 기준 자세를 만든다', () => {
  const cal = calibrate([sample(0.1, -0.2, 9.7), sample(0.3, -0.4, 9.9)]);
  assert.ok(Math.abs(cal.gMag - Math.hypot(0.2, -0.3, 9.8)) < 1e-9);
  assert.ok(Math.abs(Math.hypot(cal.up.x, cal.up.y, cal.up.z) - 1) < 1e-9);
  assert.ok(Math.abs(Math.hypot(cal.ex.x, cal.ex.y, cal.ex.z) - 1) < 1e-9);
  assert.ok(Math.abs(Math.hypot(cal.ey.x, cal.ey.y, cal.ey.z) - 1) < 1e-9);
});

test('calibrate: 샘플이 없으면 거부한다', () => {
  assert.throws(() => calibrate([]), /샘플/);
});

test('calibrate: 중력이 비정상이면 거부한다', () => {
  assert.throws(() => calibrate([sample(0, 0, 0.2)]), /중력/);
});

test('calibrate: 기저 세 축이 서로 직교한다', () => {
  const cal = calibrate([sample(0.4, 0.3, 9.6)]);
  const dot = (a: { x: number; y: number; z: number }, b: typeof a) =>
    a.x * b.x + a.y * b.y + a.z * b.z;
  assert.ok(Math.abs(dot(cal.up, cal.ex)) < 1e-9);
  assert.ok(Math.abs(dot(cal.up, cal.ey)) < 1e-9);
  assert.ok(Math.abs(dot(cal.ex, cal.ey)) < 1e-9);
});

// --- 기울기 변환 ---

test('tiltFrom: 기준 자세 그대로면 기울기 0', () => {
  const cal = calibrate([REST]);
  const tilt = tiltFrom(cal, REST);
  assert.ok(Math.abs(tilt.x) < 1e-9);
  assert.ok(Math.abs(tilt.y) < 1e-9);
});

test('tiltFrom: 0.3g 전방 가속이면 수면은 뒤로 0.3 기운다', () => {
  const cal = calibrate([REST]);
  const tilt = tiltFrom(cal, sample(0.3 * GRAVITY, 0, GRAVITY));
  assert.ok(tilt.x < -0.25 && tilt.x > -0.35, `got ${tilt.x}`);
  assert.ok(Math.abs(tilt.y) < 1e-9);
});

test('tiltFrom: 횡가속은 부호가 반대 방향으로 나타난다', () => {
  const cal = calibrate([REST]);
  const right = tiltFrom(cal, sample(0, 0.3 * GRAVITY, GRAVITY));
  const left = tiltFrom(cal, sample(0, -0.3 * GRAVITY, GRAVITY));
  assert.ok(right.y < 0);
  assert.ok(left.y > 0);
  assert.ok(Math.abs(right.y + left.y) < 1e-9);
});

// --- 장착 각도 보정 ---

/**
 * 폰을 차체 y축 둘레로 45도 눕혀 거치한 상황.
 * world 기준 위(z)가 폰 로컬에서 (sin45,0,cos45) 로 보인다.
 */
const ROLL45 = Math.PI / 4;

/** world 축 벡터를 폰 로컬 좌표로 옮긴다 (롤 45도 회전). */
function worldToLocal45(wx: number, wy: number, wz: number): MotionSample {
  const c = Math.cos(ROLL45);
  const s = Math.sin(ROLL45);
  const x = wx * c + wz * s;
  const y = wy;
  const z = -wx * s + wz * c;
  return sample(x, y, z);
}

test('장착 각도: 45도 눕혀 거치해도 정지 상태는 기울기 0', () => {
  const rest = worldToLocal45(0, 0, GRAVITY);
  const cal = calibrate([rest]);
  const tilt = tiltFrom(cal, rest);
  assert.ok(Math.abs(tilt.x) < 1e-9, `got ${tilt.x}`);
  assert.ok(Math.abs(tilt.y) < 1e-9);
});

test('장착 각도: 눕혀 거치해도 전방 가속의 기울기가 과장되지 않는다', () => {
  const rest = worldToLocal45(0, 0, GRAVITY);
  const cal = calibrate([rest]);

  // world x(차의 오른쪽)로 0.3g 가속
  const accel = worldToLocal45(0.3 * GRAVITY, 0, GRAVITY);
  const tilt = tiltFrom(cal, accel);

  // 폰이 눕혀져 있어도 결과는 0.3 이어야 한다. 폰의 x/y 를 그대로 썼다면
  // 여기서 값이 틀어지거나 과장된다.
  assert.ok(tilt.x < -0.29 && tilt.x > -0.31, `got ${tilt.x}`);
  assert.ok(Math.abs(tilt.y) < 1e-6, `got ${tilt.y}`);
});

test('장착 각도: 눕혀 거치해도 정면/횡 방향이 섞이지 않는다', () => {
  const rest = worldToLocal45(0, 0, GRAVITY);
  const cal = calibrate([rest]);

  // world y(차의 앞쪽)로만 가속 → 기울기는 ey 쪽에만 나타나야 한다.
  const accel = worldToLocal45(0, 0.3 * GRAVITY, GRAVITY);
  const tilt = tiltFrom(cal, accel);
  assert.ok(Math.abs(tilt.x) < 1e-6, `x=${tilt.x}`);
  assert.ok(tilt.y < -0.29 && tilt.y > -0.31, `y=${tilt.y}`);
});

test('장착 각도: 폰을 평평히 눕혀도 수직으로 세워도 결과가 같다', () => {
  const flat = calibrate([sample(0, 0, GRAVITY)]);
  const flatTilt = tiltFrom(flat, sample(0.3 * GRAVITY, 0, GRAVITY));

  // 폰을 세워 거치: 화면 위가 world 위와 일치
  const upright = calibrate([sample(0, GRAVITY, 0)]);
  const uprightTilt = tiltFrom(upright, sample(0.3 * GRAVITY, GRAVITY, 0));

  assert.ok(Math.abs(flatTilt.x - uprightTilt.x) < 1e-6);
});

test('tiltAngleDeg: 0.3g 가속은 약 16.7도', () => {
  const cal = calibrate([REST]);
  const deg = tiltAngleDeg(cal, sample(0.3 * GRAVITY, 0, GRAVITY));
  assert.ok(deg > 16 && deg < 17.5, `got ${deg}`);
});

test('LowPassTilt: 첫 샘플은 그대로, 이후는 alpha 만큼 접근', () => {
  const lp = new LowPassTilt(0.5);
  assert.deepEqual(lp.push({ x: 1, y: 0 }), { x: 1, y: 0 });
  const next = lp.push({ x: 0, y: 0 });
  assert.ok(Math.abs(next.x - 0.5) < 1e-9);
});

// --- 컵 물리 ---

test('Cup: 정지 상태에서는 수면이 평평하게 수렴한다', () => {
  const cup = new Cup({ fill: 0.6 });
  for (let i = 0; i < 200; i++) cup.step({ x: 0, y: 0 }, 16.7);
  let maxAbs = 0;
  for (let i = 0; i < cup.h.length; i++) {
    if (cup.inside[i]) maxAbs = Math.max(maxAbs, Math.abs(cup.h[i]!));
  }
  assert.ok(maxAbs < 1e-3, `maxAbs=${maxAbs}`);
  assert.equal(cup.spills, 0);
});

test('Cup: 일정한 기울기에서 평형 수면으로 수렴하고 넘치지 않는다', () => {
  const cup = new Cup({ fill: 0.6 });
  const tilt = { x: 0.3, y: 0 };
  for (let i = 0; i < 600; i++) cup.step(tilt, 16.7);

  let worst = 0;
  for (let j = 0; j < cup.n; j++) {
    for (let i = 0; i < cup.n; i++) {
      const idx = j * cup.n + i;
      if (!cup.inside[idx]) continue;
      const expected = tilt.x * cup.px[idx]!;
      worst = Math.max(worst, Math.abs(cup.h[idx]! - expected));
    }
  }
  assert.ok(worst < 0.02, `worst=${worst}`);
  assert.equal(cup.spills, 0);
});

test('Cup: 큰 기울기에서 가장자리가 넘치고 넘침을 한 번만 센다', () => {
  const cup = new Cup({ fill: 0.72 });
  for (let i = 0; i < 300; i++) cup.step({ x: 1.2, y: 0 }, 16.7);
  assert.ok(cup.spills >= 1, '넘침이 감지되어야 한다');
  for (let i = 0; i < 300; i++) cup.step({ x: 1.2, y: 0 }, 16.7);
  assert.equal(cup.spills, 1);
});

test('Cup: 물이 적으면 같은 기울기에도 덜 넘친다', () => {
  const run = (fill: number) => {
    const cup = new Cup({ fill });
    for (let i = 0; i < 300; i++) cup.step({ x: 0.8, y: 0 }, 16.7);
    return cup.spills;
  };
  assert.ok(run(0.3) <= run(0.9), '채울수록 넘치기 쉬워야 한다');
});

test('Cup: 격한 입력에도 발산하지 않는다 (NaN 없음, 유한 범위)', () => {
  const cup = new Cup({ fill: 0.5 });
  for (let i = 0; i < 2000; i++) {
    const t = (i / 2000) * Math.PI * 8;
    cup.step({ x: Math.sin(t) * 3, y: Math.cos(t * 1.7) * 3 }, 16.7);
  }
  for (let i = 0; i < cup.h.length; i++) {
    assert.ok(Number.isFinite(cup.h[i]!));
    assert.ok(Math.abs(cup.h[i]!) < 20, `h[${i}]=${cup.h[i]}`);
  }
});

test('Cup: reset 은 물리 상태를 초기화한다', () => {
  const cup = new Cup();
  for (let i = 0; i < 100; i++) cup.step({ x: 0.9, y: 0 }, 16.7);
  cup.reset();
  assert.equal(cup.spills, 0);
  for (let i = 0; i < cup.h.length; i++) assert.equal(cup.h[i], 0);
});

// --- 물 높이 변경 (회귀) ---

test('Cup: 물 높이를 중간에 바꿔도 넘침 카운트가 이어진다', () => {
  const cup = new Cup({ fill: 0.35 });
  // 낮은 수위에서는 같은 기울기에도 넘치지 않는다.
  for (let i = 0; i < 200; i++) cup.step({ x: 0.6, y: 0 }, 16.7);
  assert.equal(cup.spills, 0);

  // 물을 채운다 — 컵은 갈아끼우지 않는다.
  cup.setFill(0.9);
  for (let i = 0; i < 300; i++) cup.step({ x: 0.6, y: 0 }, 16.7);
  assert.ok(cup.spills >= 1, `spills=${cup.spills}`);
});

test('Cup: setFill 은 출렁임과 넘침 누적을 초기화하지 않는다', () => {
  const cup = new Cup({ fill: 0.5 });
  for (let i = 0; i < 60; i++) cup.step({ x: 0.5, y: 0 }, 16.7);
  const before = Array.from(cup.h);
  const spillsBefore = cup.spills;

  cup.setFill(0.8);

  for (let i = 0; i < cup.h.length; i++) {
    assert.equal(cup.h[i], before[i], `h[${i}] 가 바뀌었다`);
  }
  assert.equal(cup.spills, spillsBefore);
  assert.ok(Math.abs(cup.base - 0.6) < 1e-9);
});
