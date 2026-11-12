import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HISTORY, LANES, PARTICLES, LiquidStream, streamRadius, streamSources } from '../src/core/liquid-stream.ts';
import type { Source } from '../src/core/liquid-stream.ts';

const source = (angle = 0): Source => ({ angle, rate: 0.12, velocity: { x: Math.cos(angle), y: 0, z: Math.sin(angle) } });
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
  for (let i = 0; i < 100; i++) sim.update(tilt, Array.from({ length: LANES }, (_, i) => source(i)), 0.02);
  assert.ok(sim.lanes.every(lane => lane.length <= HISTORY));
  assert.equal(sim.particles.length, PARTICLES);
  const alive = sim.particles.filter(p => p.life > 0);
  assert.ok(alive.some(p => p.fine) && alive.some(p => !p.fine));
  assert.ok(alive.every(p => p.size < 0.023));
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
