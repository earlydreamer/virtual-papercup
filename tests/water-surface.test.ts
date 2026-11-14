import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cup } from '../src/core/cup.ts';
import { collectRimFlow, sampleWaterLevel } from '../src/core/water-surface.ts';

for (const [name, x, y] of [['오른쪽', 1, 0], ['왼쪽', -1, 0], ['앞쪽', 0, 1], ['뒤쪽', 0, -1]] as const) {
  test(`${name} 기울기는 같은 방향 테두리로 넘친다`, () => {
    const cup = new Cup({ keepFill: true });
    for (let i = 0; i < 90; i++) cup.step({ x, y }, 16);
    const sectors = new Float32Array(40);
    collectRimFlow(cup, sectors);
    const forward = ((Math.round(Math.atan2(y, x) / (Math.PI * 2) * 40) % 40) + 40) % 40;
    assert.ok(sectors[forward]! > 0.1);
    assert.equal(sectors[(forward + 20) % 40], 0);
    assert.ok(sampleWaterLevel(cup, x * 0.7, y * 0.7) > sampleWaterLevel(cup, -x * 0.7, -y * 0.7) + 0.5);
    assert.ok(cup.spilledVolume > 0);
  });
}

test('수평의 원판 경계까지 빈 칸에 끌려가지 않고 같은 수위를 유지한다', () => {
  const cup = new Cup();
  for (let i = 0; i < 180; i++) {
    const angle = i * Math.PI / 90;
    assert.ok(Math.abs(sampleWaterLevel(cup, Math.cos(angle), Math.sin(angle)) - cup.base) < 1e-6);
  }
  cup.step({ x: 0, y: 0 }, 16);
  assert.equal(cup.edgeOverflow.some((v) => v > 0), false);
});

test('넘침 표시는 물 보충·초기화와 다음 수평 프레임에 남지 않는다', () => {
  const cup = new Cup();
  cup.step({ x: 1.5, y: 0 }, 16);
  assert.ok(cup.edgeOverflow.some((v) => v > 0));
  cup.setFill(0.3);
  assert.equal(cup.overflowIntensity, 0);
  assert.equal(cup.edgeOverflow.some((v) => v > 0), false);
  cup.step({ x: 0, y: 0 }, 16);
  assert.equal(cup.edgeOverflow.some((v) => v > 0), false);
  cup.step({ x: 0, y: 0, overturned: true }, 16);
  assert.ok(cup.edgeOverflow.some((v) => v > 0));
  cup.reset();
  assert.equal(cup.edgeOverflow.some((v) => v > 0), false);
});
