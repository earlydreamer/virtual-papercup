import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { PourRenderer } from '../src/render-pour.ts';

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
