import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calibrate, GRAVITY, tiltFrom } from '../src/core/attitude.ts';
import { Cup } from '../src/core/cup.ts';
import { collectRimFlow, sampleWaterLevel } from '../src/core/water-surface.ts';
import { rotateTiltByYaw, sensorTiltToScene } from '../src/scene-coordinates.ts';

const sample = (x: number, y: number, z: number) => ({ acc: { x, y, z }, t: 0 });
const flat = calibrate([sample(0, 0, GRAVITY)]);
const s = Math.sin(Math.PI / 4) * GRAVITY;
const c = Math.cos(Math.PI / 4) * GRAVITY;

// 화면이 위를 향한 기준에서 지정한 가장자리를 45도 낮춘 정지 샘플입니다.
// 입력 → 센서 기울기 → 장면 변환 → 높이장 → 실제 유출 구간을 연결해 확인합니다.
for (const [name, acc, x, z, sector] of [
  ['폰 위쪽(먼 쪽)', sample(0, -s, c), 0, -1, 30],
  ['폰 아래쪽(가까운 쪽)', sample(0, s, c), 0, 1, 10],
  ['폰 오른쪽', sample(-s, 0, c), 1, 0, 0],
  ['폰 왼쪽', sample(s, 0, c), -1, 0, 20],
] as const) {
  test(`${name}을 낮추면 같은 쪽 수면이 올라와 그 테두리로 넘친다`, () => {
    const tilt = sensorTiltToScene(tiltFrom(flat, acc));
    const cup = new Cup({ keepFill: true });
    for (let i = 0; i < 90; i++) cup.step(tilt, 16);
    assert.ok(sampleWaterLevel(cup, x * 0.7, z * 0.7) > sampleWaterLevel(cup, -x * 0.7, -z * 0.7) + 0.5);
    const flow = new Float32Array(40);
    collectRimFlow(cup, flow);
    assert.ok(flow[sector]! > 0.1);
    assert.equal(flow[(sector + 20) % 40], 0);
  });
}

test('세워서 기준을 잡은 폰도 윗부분을 멀리 숙이면 컵의 먼 쪽으로 쏠린다', () => {
  const upright = calibrate([sample(0, GRAVITY, 0)]);
  const tilt = sensorTiltToScene(tiltFrom(upright, sample(0, c, s)));
  assert.ok(Math.abs(tilt.x) < 1e-6);
  assert.ok(tilt.y < -0.99);
});

test('좌표 변환은 원본과 뒤집힘 판정을 보존한다', () => {
  const original = { x: 0.2, y: 0.4, overturned: true };
  assert.deepEqual(sensorTiltToScene(original), { x: 0.2, y: -0.4, overturned: true });
  assert.deepEqual(original, { x: 0.2, y: 0.4, overturned: true });
});

test('시점의 수평 회전은 화면 기준 방향과 기울기 크기·뒤집힘을 보존한다', () => {
  const input = { x: 0.4, y: -0.7, overturned: true };
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.73]) {
    const scene = rotateTiltByYaw(input, yaw);
    // 수평면에서 카메라의 오른쪽·가까운 쪽으로 재투영합니다.
    const right = scene.x * Math.cos(yaw) - scene.y * Math.sin(yaw);
    const near = scene.x * Math.sin(yaw) + scene.y * Math.cos(yaw);
    assert.ok(Math.abs(right - input.x) < 1e-12);
    assert.ok(Math.abs(near - input.y) < 1e-12);
    assert.ok(Math.abs(Math.hypot(scene.x, scene.y) - Math.hypot(input.x, input.y)) < 1e-12);
    assert.equal(scene.overturned, true);
    const level = rotateTiltByYaw({ x: 0, y: 0 }, yaw);
    assert.equal(Math.hypot(level.x, level.y), 0);
  }
  assert.deepEqual(input, { x: 0.4, y: -0.7, overturned: true });
});

for (const [yaw, sector] of [[0, 0], [Math.PI / 2, 30], [Math.PI, 20], [-Math.PI / 2, 10]] as const) {
  test(`시점 방위각 ${yaw}에서도 폰 오른쪽을 낮추면 보는 방향의 오른쪽으로 넘친다`, () => {
    const tilt = rotateTiltByYaw(sensorTiltToScene(tiltFrom(flat, sample(-s, 0, c))), yaw);
    const cup = new Cup({ keepFill: true });
    for (let i = 0; i < 90; i++) cup.step(tilt, 16);
    const flow = new Float32Array(40);
    collectRimFlow(cup, flow);
    assert.ok(flow[sector]! > 0.1);
    assert.equal(flow[(sector + 20) % 40], 0);
  });
}
