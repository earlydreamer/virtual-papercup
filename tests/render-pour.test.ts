import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FRAGMENT_RINGS, PourRenderer } from '../src/render-pour.ts';
import { FLIGHT_TIME_SCALE } from '../src/core/liquid-stream.ts';

test('유출 방향이 회전하는 동안 메시와 법선이 유한하며 초기화 뒤 이전 면이 남지 않는다', () => {
  const scene = new THREE.Scene();
  const renderer = new PourRenderer(scene);
  for (let i = 0; i < 45; i++) {
    const angle = i * 0.035;
    renderer.simulation.update({ x: Math.cos(angle), y: Math.sin(angle) }, [{
      angle, halfArc: 0.5, rate: 0.12,
      velocity: { x: Math.cos(angle), y: 0, z: Math.sin(angle) },
    }], 1 / 90);
    renderer.draw(1 / 90, 720);
  }
  const tubes = scene.children.filter((child): child is THREE.Mesh => child instanceof THREE.Mesh
    && !(child instanceof THREE.InstancedMesh) && child.geometry.getAttribute('position').count === 72 * 24);
  assert.ok(tubes.some(mesh => mesh.geometry.drawRange.count > 0));
  for (const mesh of tubes) {
    for (const attribute of ['position', 'normal']) {
      assert.ok(Array.from(mesh.geometry.getAttribute(attribute).array).every(Number.isFinite));
    }
  }
  renderer.reset();
  renderer.draw(1 / 90, 720);
  for (const mesh of tubes) {
    assert.equal(mesh.geometry.drawRange.count, 0);
    assert.ok(Array.from(mesh.geometry.index!.array).every(value => value === 0));
  }
});

test('분리 직후의 정점은 원래 물줄기와 일치하고 같은 메시가 연속해서 둥글어진다', () => {
  const scene = new THREE.Scene();
  const renderer = new PourRenderer(scene), sim = renderer.simulation;
  const step = 1 / 90 / FLIGHT_TIME_SCALE;
  sim.update({ x: 1, y: 0 }, [{ angle: 0, halfArc: 0.6, rate: 0.12, velocity: { x: 1, y: 0, z: 0 } }], step * 6);
  const neck = sim.lanes[0]![2]!;
  neck.phase = 0.9;
  neck.age = neck.breakupAge * 0.99;
  sim.update({ x: 1, y: 0 }, [], step);
  const f = sim.fragments[0]!;
  // 동결한 분리 직전 표면과 출생 시 분리 표면을 같은 렌더러로 비교합니다.
  sim.lanes[0] = f.parcels;
  renderer.draw(0, 720);
  const tube = scene.children.find((child): child is THREE.Mesh => child instanceof THREE.Mesh && child.name !== 'liquid-fragment')!;
  const fragment = scene.getObjectByName('liquid-fragment') as THREE.Mesh;
  const original = tube.geometry.getAttribute('position');
  const positions = fragment.geometry.getAttribute('position');
  const initial = new Float32Array(positions.array);
  for (let row = 0; row < FRAGMENT_RINGS; row++) {
    const sourceRow = f.start + row / (FRAGMENT_RINGS - 1) * (f.end - 1 - f.start);
    const from = Math.floor(sourceRow), to = Math.min(f.end - 1, from + 1), blend = sourceRow - from;
    for (let k = 0; k < 24; k++) {
      for (let axis = 0; axis < 3; axis++) {
        const expected = original.array[(from * 24 + k) * 3 + axis]! * (1 - blend)
          + original.array[(to * 24 + k) * 3 + axis]! * blend;
        assert.ok(Math.abs(positions.array[(row * 24 + k) * 3 + axis]! - expected) < 1e-6);
      }
    }
  }
  f.age = 0.0225 * FLIGHT_TIME_SCALE;
  renderer.draw(0, 720);
  const halfway = new Float32Array(positions.array);
  f.age = 0.045 * FLIGHT_TIME_SCALE;
  renderer.draw(0, 720);
  for (let j = 0; j < FRAGMENT_RINGS * 24; j++) {
    const distance = Math.hypot(positions.getX(j) - f.position.x, positions.getY(j) - f.position.y, positions.getZ(j) - f.position.z);
    assert.ok(Math.abs(distance - f.radius) < 1e-6);
    for (let axis = 0; axis < 3; axis++) {
      const index = j * 3 + axis;
      assert.ok(Math.abs(halfway[index]! - (initial[index]! + positions.array[index]!) / 2) < 1e-6);
    }
  }
});

test('빠르게 이동하는 독립 방울도 분리 후 구형에 가까운 비율로 렌더한다', () => {
  const scene = new THREE.Scene();
  const renderer = new PourRenderer(scene);
  renderer.simulation.emit({ x: 0, y: 0.4, z: 0 }, { x: 40, y: 0, z: 0 }, 0.02);
  renderer.simulation.update({ x: 0, y: 0 }, [], 0.03);
  renderer.simulation.update({ x: 0, y: 0 }, [], 0.03);
  renderer.draw(0.03, 720);
  const drops = scene.children.find((child): child is THREE.InstancedMesh => child instanceof THREE.InstancedMesh)!;
  assert.equal(drops.count, 1);
  const matrix = new THREE.Matrix4(), scale = new THREE.Vector3();
  drops.getMatrixAt(0, matrix);
  matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
  assert.ok(Math.max(scale.x, scale.y, scale.z) / Math.min(scale.x, scale.y, scale.z) < 1.1);
});
