import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrate, GRAVITY, LowPassTilt, tiltFrom } from '../src/core/attitude.ts';
import { Cup } from '../src/core/cup.ts';
import { collectRimFlow } from '../src/core/water-surface.ts';
import { cupGravity, sampleSpillFlight, spillFlight } from '../src/core/spill-flight.ts';
import { rotateTiltByYaw, sensorTiltToScene } from '../src/scene-coordinates.ts';

const sample = (x: number, y: number, z: number) => ({ acc: { x, y, z }, t: 0 });
const calibration = calibrate([sample(0, 0, GRAVITY)]);
const sensor = (degrees: number) => {
  const angle = degrees * Math.PI / 180;
  return sensorTiltToScene(tiltFrom(calibration, sample(-Math.sin(angle) * GRAVITY, 0, Math.cos(angle) * GRAVITY)));
};

test('센서의 15·45·75·95·150도 방향이 보정과 필터를 거쳐 자유 유출 가속도까지 유지된다', () => {
  for (const degrees of [15, 45, 75, 95, 150]) {
    const tilt = new LowPassTilt().push(sensor(degrees));
    const gravity = cupGravity(tilt);
    assert.ok(Math.abs(Math.atan2(gravity.x, -gravity.y) * 180 / Math.PI - degrees) < 1e-9);
    assert.ok(Math.abs(Math.hypot(gravity.x, gravity.y, gravity.z) - GRAVITY) < 1e-9);
  }
});

test('카메라 수평 회전은 유출 방향만 바꾸고 중력의 수직 성분과 크기를 보존한다', () => {
  const original = sensor(60);
  const base = spillFlight(original, 0, 0.3, 0);
  const basePoint = sampleSpillFlight(base, 0, 0.3);
  for (const yaw of [Math.PI / 2, Math.PI, -0.7]) {
    const rotated = spillFlight(rotateTiltByYaw(original, yaw), -yaw, 0.3, 0);
    const point = sampleSpillFlight(rotated, -yaw, 0.3);
    assert.ok(Math.abs(point.y - basePoint.y) < 1e-9);
    assert.ok(Math.abs(point.x - basePoint.x * Math.cos(yaw)) < 1e-9);
    assert.ok(Math.abs(point.z + basePoint.x * Math.sin(yaw)) < 1e-9);
    assert.ok(Math.abs(rotated.detached - base.detached) < 1e-9);
  }
});

test('약한 넘침은 외벽에 남고 큰 각도에서는 물리 유출 지점에서 바로 떨어져 나온다', () => {
  const outflow = (degrees: number) => {
    const tilt = sensor(degrees);
    const cup = new Cup({ fill: 0.96, keepFill: true });
    for (let i = 0; i < 150; i++) cup.step(tilt, 16);
    const flow = new Float32Array(40), head = new Float32Array(40), rise = new Float32Array(40);
    collectRimFlow(cup, flow, head, rise);
    assert.ok(flow[0]! > 0);
    assert.equal(flow[20], 0);
    return spillFlight(tilt, 0, head[0]!, rise[0]!);
  };
  assert.ok(outflow(12).detached < 0.1);
  const strong = outflow(60);
  assert.equal(strong.detached, 1);
  const point = sampleSpillFlight(strong, 0, 0.3);
  assert.ok(point.x > 1.7 && point.y < 1.025);
});

test('같은 각도에서 수두와 수면 상승 속도가 커지면 유출 초기 속도가 커진다', () => {
  const tilt = sensor(30);
  const weak = spillFlight(tilt, 0, 0.02, 0);
  const deep = spillFlight(tilt, 0, 0.4, 0);
  const abrupt = spillFlight(tilt, 0, 0.02, 3);
  assert.ok(deep.velocity.x > weak.velocity.x * 3);
  assert.ok(abrupt.velocity.x > weak.velocity.x);
  assert.equal(spillFlight(tilt, 0, 0, 0).detached, 0);
});

test('가로로 넘어져도 센서의 방향을 잃지 않고 한쪽 테두리로 쏟아진다', () => {
  const tilt = new LowPassTilt().push(sensor(95));
  const cup = new Cup({ keepFill: true });
  cup.step(tilt, 16);
  const flow = new Float32Array(40);
  collectRimFlow(cup, flow);
  assert.ok(flow[0]! > 0.9);
  assert.equal(flow[20], 0);
  cup.reset();
  assert.ok(cup.edgeHead.every(value => value === 0));
  assert.ok(cup.edgeRiseSpeed.every(value => value === 0));
});
