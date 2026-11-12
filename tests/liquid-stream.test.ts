import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FLIGHT_TIME_SCALE, METERS_PER_UNIT, MAX_FRAGMENTS, fragmentRoundness, HISTORY, MAX_STREAMS, PARTICLES, LiquidStream, parcelSection, particleStretch, streamRadius, streamSources } from '../src/core/liquid-stream.ts';
import type { Source } from '../src/core/liquid-stream.ts';
import { Cup } from '../src/core/cup.ts';
import { collectRimFlow } from '../src/core/water-surface.ts';

const source = (angle = 0): Source => ({ angle, halfArc: 0.65, rate: 0.12, velocity: { x: Math.cos(angle), y: 0, z: Math.sin(angle) } });
const tilt = { x: 1, y: 0 };

test('같은 유량의 빠른 물줄기는 좁아지고 유량이 늘면 단면적이 비례한다', () => {
  assert.ok(Math.abs(streamRadius(0.1, 2) ** 2 * 2 - streamRadius(0.1, 1) ** 2) < 1e-12);
  assert.ok(Math.abs(streamRadius(0.1, 2) ** 2 * 2 - streamRadius(0.2, 2) ** 2) < 1e-12);
  assert.equal(streamRadius(0, 1), 0);
});

test('0도 양쪽 경계는 같은 물줄기로 모이고 총 유량은 공급을 넘지 않는다', () => {
  const flow = new Float32Array(40), head = new Float32Array(40), rise = new Float32Array(40);
  for (const i of [0, 1, 39]) { flow[i] = 1; head[i] = 0.4; }
  const sources = streamSources(tilt, flow, head, rise, 0.2);
  assert.equal(sources.filter(s => s.rate > 0).length, 1);
  assert.ok(Math.abs(sources[0]!.angle) < 1e-9);
  assert.ok(Math.abs(sources.reduce((n, s) => n + s.rate, 0) - 0.2) < 1e-9);
  assert.ok(streamSources(tilt, flow, head, rise, 0).every(s => s.rate === 0));
});

test('기울기를 반전해도 이미 나온 물의 위치와 속도가 순간 이동하지 않는다', () => {
  const sim = new LiquidStream();
  sim.update(tilt, [source()], 0.05);
  const old = sim.lanes[0]![0]!;
  const x = old.position.x, vx = old.velocity.x;
  sim.update({ x: -1, y: 0 }, [source(Math.PI)], 1 / 90 / FLIGHT_TIME_SCALE);
  assert.ok(old.position.x > x);
  assert.ok(old.velocity.x < vx);
  assert.ok(Math.abs(old.position.x - x) < 0.03);
  assert.notEqual(old.chain, sim.lanes[0]![0]!.chain);
});

test('방출이 끝나면 줄기와 덩어리가 배수되고 잔물보라는 작고 불규칙하며 수가 제한된다', () => {
  const sim = new LiquidStream();
  for (let i = 0; i < 100; i++) sim.update(tilt, Array.from({ length: MAX_STREAMS }, (_, i) => source(i)), 0.02);
  assert.ok(sim.lanes.every(lane => lane.length <= HISTORY));
  assert.equal(sim.particles.length, PARTICLES);
  const alive = sim.particles.filter(p => p.life > 0);
  assert.ok(alive.some(p => p.fine));
  assert.ok(sim.fragments.length > 0 && sim.fragments.length <= MAX_FRAGMENTS);
  assert.ok(sim.fragments.every(f => Number.isFinite(f.radius) && f.radius > 0));
  assert.ok(alive.every(p => p.size < 0.031));
  assert.ok(new Set(alive.map(p => p.size)).size > 20);
  for (let i = 0; i < 200; i++) sim.update({ x: 0, y: 0 }, [], 0.02);
  assert.ok(sim.lanes.every(lane => lane.length === 0));
  assert.ok(sim.particles.every(p => p.life <= 0));
  assert.equal(sim.fragments.length, 0);
});

test('충돌은 실제 바닥 위치에서 발생하고 초기화는 모든 잔류물을 지운다', () => {
  const sim = new LiquidStream();
  sim.emit({ x: 2, y: -1.6, z: 0.7 }, { x: 0, y: -2, z: 0 }, 0.01);
  sim.update({ x: 0, y: 0 }, [], 0.05);
  assert.ok(sim.impacts.some(p => p.x === 2 && p.z === 0.7));
  sim.reset();
  assert.equal(sim.impacts.length, 0);
  assert.ok(sim.particles.every(p => p.life === 0));
});

test('고정 시간 적분은 30fps와 90fps 입력에서 같은 궤적을 만든다', () => {
  const a = new LiquidStream(), b = new LiquidStream();
  for (let i = 0; i < 9; i++) a.update(tilt, [source()], 1 / 90);
  for (let i = 0; i < 3; i++) b.update(tilt, [source()], 1 / 30);
  assert.deepEqual(a.lanes, b.lanes);
});

test('실제 컵의 한쪽 넘침은 방위각에 관계없이 하나의 유출 덩어리가 된다', () => {
  for (const angle of [0, 0.37, Math.PI / 4, Math.PI / 2, Math.PI, Math.PI * 1.9]) {
    const input = { x: Math.cos(angle) * 1.7, y: Math.sin(angle) * 1.7 };
    const cup = new Cup({ keepFill: true });
    for (let i = 0; i < 150; i++) cup.step(input, 16);
    const flow = new Float32Array(40), head = new Float32Array(40), rise = new Float32Array(40);
    collectRimFlow(cup, flow, head, rise);
    const sources = streamSources(input, flow, head, rise, 0.5);
    assert.equal(sources.length, 1, `angle=${angle}`);
    const error = Math.atan2(Math.sin(sources[0]!.angle - angle), Math.cos(sources[0]!.angle - angle));
    assert.ok(Math.abs(error) < 0.08);
    assert.ok(sources[0]!.halfArc > 0.3);
  }
});

test('테두리의 떨어진 넘침 구간은 하나의 넓은 막으로 연결하지 않는다', () => {
  const flow = new Float32Array(40), head = new Float32Array(40), rise = new Float32Array(40);
  for (const i of [0, 1, 39, 18, 19, 20]) { flow[i] = 1; head[i] = 1.5; }
  const sources = streamSources({ x: 0, y: 0 }, flow, head, rise, 0.5);
  assert.equal(sources.length, 2);
  assert.ok(sources.every(s => s.halfArc < 0.3));
});

test('입구의 연결된 폭은 짧은 거리에서 모이고 분열 전 목과 굵기가 변한다', () => {
  const sim = new LiquidStream();
  sim.update(tilt, [source()], 1 / 90);
  const p = sim.lanes[0]![0]!;
  const lip = parcelSection(p);
  const body = parcelSection({ ...p, age: 0.15 });
  const end = parcelSection({ ...p, age: p.breakupAge * 0.95 });
  assert.ok(lip.width > body.width * 1.8);
  assert.ok(body.depth > lip.depth);
  assert.ok(end.breakup > 0.8 && end.width < body.width);
  assert.ok(lip.depth > 0 && end.depth > 0);
});

test('분리된 구간의 유량 순서가 바뀌어도 기존 궤적을 서로 바꿔 잇지 않는다', () => {
  const sim = new LiquidStream();
  const a = source(0), b = source(Math.PI);
  sim.update(tilt, [a, b], 0.05);
  const chainA = sim.lanes[0]![0]!.chain;
  sim.update(tilt, [b, a], 0.02);
  assert.equal(sim.lanes[0]![0]!.angle, 0);
  assert.equal(sim.lanes[0]![0]!.chain, chainA);
  assert.equal(sim.lanes[1]![0]!.angle, Math.PI);
});

test('분열 직전에는 가는 목과 굵은 부분이 함께 존재한다', () => {
  const sim = new LiquidStream();
  sim.update(tilt, [source()], 1 / 90);
  const p = sim.lanes[0]![0]!;
  const sections = Array.from({ length: 60 }, (_, i) => parcelSection({
    ...p, age: p.breakupAge * 0.99, phase: i * 0.2,
  }));
  assert.ok(sections.some(s => s.pinched));
  assert.ok(sections.some(s => !s.pinched && s.width > p.radius * 0.5));
  assert.ok(sections.every(s => Number.isFinite(s.width) && Number.isFinite(s.depth)));
});

test('가는 목이 끊길 때 기존 형상과 가중 평균 속도를 보존한 덩어리를 만든다', () => {
  const sim = new LiquidStream();
  const step = 1 / 90 / FLIGHT_TIME_SCALE;
  sim.update(tilt, [source()], 6 * step);
  const original = sim.lanes[0]!.slice();
  const neck = original[2]!;
  neck.phase = 0.9;
  neck.age = neck.breakupAge * 0.85;
  sim.update(tilt, [], step);
  assert.equal(sim.fragments.length, 0);
  neck.age = neck.breakupAge * 0.99;
  sim.update(tilt, [], step);
  assert.deepEqual(sim.lanes[0], original.slice(0, 2));
  const f = sim.fragments[0]!;
  assert.deepEqual(f.parcels, original);
  assert.deepEqual(f.position, f.origin);
  assert.equal(f.age, 0);
  assert.equal(f.start, 2);
  assert.equal(f.end, 6);
  assert.ok(f.radius > 0.005);
  for (const axis of ['x', 'y', 'z'] as const) {
    const speeds = original.slice(2).map(p => p.velocity[axis]);
    assert.ok(f.velocity[axis] >= Math.min(...speeds) - 1e-10 && f.velocity[axis] <= Math.max(...speeds) + 1e-10);
  }
  const y = f.position.y, vy = f.velocity.y;
  sim.update(tilt, [], step);
  assert.ok(f.position.y < y && f.velocity.y < vy);
  assert.equal(sim.particles.filter(p => p.life > 0).length, 0);
});

test('형태 전환은 원래 표면에서 시작해 중간 형상을 거쳐 약 45ms에 구형이 된다', () => {
  assert.equal(fragmentRoundness(0), 0);
  assert.ok(Math.abs(fragmentRoundness(0.0225 * FLIGHT_TIME_SCALE) - 0.5) < 1e-10);
  assert.equal(fragmentRoundness(0.045 * FLIGHT_TIME_SCALE), 1);
  assert.equal(fragmentRoundness(0.2 * FLIGHT_TIME_SCALE), 1);
  let previous = 0;
  for (let i = 0; i <= 45; i++) {
    const value = fragmentRoundness(i / 1000 * FLIGHT_TIME_SCALE);
    assert.ok(value >= previous && value - previous < 0.04);
    previous = value;
  }
});

test('10cm 컵 기준 자유 낙하는 가속되며 약 0.14초 후 바닥에 닿는다', () => {
  const sim = new LiquidStream();
  sim.emit({ x: 0, y: 0.395, z: 0 }, { x: 0, y: 0, z: 0 }, 0.01);
  const drop = sim.particles[0]!;
  sim.update({ x: 0, y: 0 }, [], 0.05);
  const firstFall = 0.395 - drop.position.y;
  sim.update({ x: 0, y: 0 }, [], 0.05);
  const secondFall = 0.395 - drop.position.y - firstFall;
  assert.ok(secondFall > firstFall * 2.8);
  const actualMeters = (0.395 - drop.position.y) * METERS_PER_UNIT;
  assert.ok(Math.abs(actualMeters - 9.81 * 0.1 ** 2 / 2) < 0.002);
  sim.update({ x: 0, y: 0 }, [], 0.03);
  assert.ok(drop.life > 0);
  sim.update({ x: 0, y: 0 }, [], 0.02);
  assert.ok(drop.life <= 0);
  assert.ok(sim.impacts.length > 0);
});

test('독립 방울은 빠르게 둥글어지고 빠른 속도에서도 길게 늘어나지 않는다', () => {
  const sim = new LiquidStream();
  sim.emit({ x: 0, y: 0.4, z: 0 }, { x: 20, y: -20, z: 0 }, 0.02);
  const p = sim.particles[0]!;
  assert.equal(particleStretch(p), 1.5);
  p.life = p.duration - 0.06 * FLIGHT_TIME_SCALE;
  assert.ok(particleStretch(p) < 1.04);
  const rounded = particleStretch(p);
  p.velocity.x *= 10;
  assert.equal(particleStretch(p), rounded);
});
