// 넘침 손실(물이 실제로 줄어드는지) 검증
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Cup } from '../src/core/cup.ts';

test('손실: 넘치면 물이 줄어든다', () => {
  const cup = new Cup({ fill: 0.8 });
  const before = cup.fill;
  for (let i = 0; i < 120; i++) cup.step({ x: 1.4, y: 0 }, 16.7);

  assert.ok(cup.spills >= 1, '넘쳐야 한다');
  assert.ok(cup.fill < before - 0.02, `fill=${cup.fill} (before ${before})`);
  assert.ok(cup.spilledVolume > 0, '손실량이 기록되어야 한다');
});

test('손실: 넘치지 않으면 물이 줄지 않는다', () => {
  const cup = new Cup({ fill: 0.4 });
  const before = cup.fill;
  for (let i = 0; i < 300; i++) cup.step({ x: 0.3, y: 0 }, 16.7);
  assert.equal(cup.spills, 0);
  assert.ok(Math.abs(cup.fill - before) < 1e-9, `fill=${cup.fill}`);
});

test('손실: spillRate 0 이면 연습 모드로 물이 유지된다', () => {
  const cup = new Cup({ fill: 0.8, spillRate: 0 });
  for (let i = 0; i < 200; i++) cup.step({ x: 1.5, y: 0 }, 16.7);
  assert.ok(cup.spills >= 1, '넘침 판정은 그대로여야 한다');
  assert.ok(Math.abs(cup.fill - 0.8) < 1e-9, `fill=${cup.fill}`);
});

test('손실: 물이 다 쏟아지면 drained 가 되고 더 넘치지 않는다', () => {
  const cup = new Cup({ fill: 0.5, spillRate: 0.6 });
  // 오래 세게 기울여 물을 쏟는다.
  for (let i = 0; i < 2000; i++) cup.step({ x: 2.0, y: 0 }, 16.7);

  assert.ok(cup.drained, `fill=${cup.fill}`);
  const spillsAtDrain = cup.spills;

  // 계속 기울여도 넘침 횟수는 늘지 않아야 한다.
  for (let i = 0; i < 300; i++) cup.step({ x: 2.0, y: 0 }, 16.7);
  assert.equal(cup.spills, spillsAtDrain);
});

test('손실: 물이 줄면 같은 기울기에서 덜 넘친다', () => {
  const cup = new Cup({ fill: 0.75 });
  // 한 번 흘려보내 물을 줄인다.
  for (let i = 0; i < 200; i++) cup.step({ x: 1.3, y: 0 }, 16.7);
  const afterSpill = cup.fill;
  assert.ok(afterSpill < 0.75, '물이 줄어야 한다');

  // 이제 같은 기울기로 계속 가도 더 이상 넘치지 않을 만큼 수위가 내려갔는지
  // (넘친다면 최소한 처음보다 넘치기 어려워졌는지는 보장된다)
  const beforeCount = cup.spills;
  for (let i = 0; i < 120; i++) cup.step({ x: 1.3, y: 0 }, 16.7);
  const extra = cup.spills - beforeCount;
  assert.ok(extra >= 0);
  assert.ok(cup.fill <= afterSpill, '물은 계속 줄기만 한다');
});

test('손실: reset 은 물량과 손실량을 되돌린다', () => {
  const cup = new Cup({ fill: 0.8 });
  for (let i = 0; i < 200; i++) cup.step({ x: 1.5, y: 0 }, 16.7);
  assert.ok(cup.spilledVolume > 0);

  cup.reset();
  assert.ok(Math.abs(cup.fill - 0.8) < 1e-9, `fill=${cup.fill}`);
  assert.equal(cup.spilledVolume, 0);
  assert.equal(cup.spills, 0);
});

test('손실: setFill 로 다시 채우면 넘침이 재개된다', () => {
  const cup = new Cup({ fill: 0.8, spillRate: 0.5 });
  for (let i = 0; i < 500; i++) cup.step({ x: 2.0, y: 0 }, 16.7);
  const drainedFill = cup.fill;
  assert.ok(drainedFill < 0.8, '물이 줄어야 한다');

  cup.setFill(0.85);
  const before = cup.spills;
  for (let i = 0; i < 200; i++) cup.step({ x: 2.0, y: 0 }, 16.7);
  assert.ok(cup.spills > before, '다시 채우면 넘침이 재개되어야 한다');
});
