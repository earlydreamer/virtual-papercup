import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY, MAX_STREAMS, PARTICLES, LiquidStream, parcelSection, streamRadius, streamSources } from '../src/core/liquid-stream.ts';
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
  sim.update({ x: -1, y: 0 }, [source(Math.PI)], 1 / 90);
  assert.ok(old.position.x > x);
  assert.ok(old.velocity.x < vx);
  assert.ok(Math.abs(old.position.x - x) < 0.03);
  assert.notEqual(old.chain, sim.lanes[0]![0]!.chain);
});

test('방출이 끝나면 줄기는 배수되고 분열 입자는 작고 불규칙하며 수가 제한된다', () => {
  const sim = new LiquidStream();
  for (let i = 0; i < 100; i++) sim.update(tilt, Array.from({ length: MAX_STREAMS }, (_, i) => source(i)), 0.02);
  assert.ok(sim.lanes.every(lane => lane.length <= HISTORY));
  assert.equal(sim.particles.length, PARTICLES);
  const alive = sim.particles.filter(p => p.life > 0);
  assert.ok(alive.some(p => p.fine) && alive.some(p => !p.fine));
  assert.ok(alive.every(p => p.size < 0.031));
  assert.ok(new Set(alive.map(p => p.size)).size > 20);
  for (let i = 0; i < 200; i++) sim.update({ x: 0, y: 0 }, [], 0.02);
  assert.ok(sim.lanes.every(lane => lane.length === 0));
  assert.ok(sim.particles.every(p => p.life <= 0));
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
