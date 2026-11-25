import * as THREE from 'three';
import { HISTORY, MAX_STREAMS, MAX_FRAGMENTS, PARTICLES, LiquidStream, parcelSection, parcelCenter, particleStretch, fragmentRoundness } from './core/liquid-stream.ts';
import type { Fragment, Parcel } from './core/liquid-stream.ts';
const SIDES = 24;
export const FRAGMENT_RINGS = 18;
const FLOOR = -1.65;

/** 연속 단면 메시, 굴절 방울, 잔물보라를 각각 제한된 버퍼에 그립니다. */
export class PourRenderer {
  readonly simulation = new LiquidStream();
  private readonly tubes: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>[] = [];
  private readonly fragments: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>[] = [];
  private readonly drops: THREE.InstancedMesh;
  private readonly spray: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly rings: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>[] = [];
  private readonly wet: THREE.Mesh<THREE.CircleGeometry, THREE.MeshPhysicalMaterial>[] = [];
  private readonly ringAges = new Float32Array(20).fill(1);
  private impactCursor = 0;
  private wetCursor = 0;
  private readonly dummy = new THREE.Object3D();
  private readonly tangent = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();
  private readonly centers = Array.from({ length: HISTORY }, () => new THREE.Vector3());
  private readonly fragmentSource = new Float32Array(HISTORY * SIDES * 3);
  private readonly up = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene) {
    const material = new THREE.MeshPhysicalMaterial({ color: '#eef8fa', roughness: 0.035,
      transmission: 1, opacity: 1, thickness: 0.13, ior: 1.333,
      attenuationColor: new THREE.Color('#b8e0df'), attenuationDistance: 3, envMapIntensity: 0.85, fog: false });
    for (let i = 0; i < MAX_STREAMS + MAX_FRAGMENTS; i++) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(HISTORY * SIDES * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(HISTORY * SIDES * 3), 3).setUsage(THREE.DynamicDrawUsage));
      geometry.setIndex(new THREE.BufferAttribute(new Uint16Array((HISTORY + 1) * SIDES * 6), 1).setUsage(THREE.DynamicDrawUsage));
      geometry.setDrawRange(0, 0);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.frustumCulled = false;
      if (i < MAX_STREAMS) this.tubes.push(mesh);
      else { mesh.name = 'liquid-fragment'; mesh.visible = false; this.fragments.push(mesh); }
      scene.add(mesh);
    }
    const dropMaterial = material.clone();
    dropMaterial.thickness = 0.018;
    dropMaterial.roughness = 0.1;
    dropMaterial.transmission = 0.98;
    dropMaterial.envMapIntensity = 0.55;
    this.drops = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 10), dropMaterial, PARTICLES);
    this.drops.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.drops.frustumCulled = false;
    this.drops.count = 0;
    scene.add(this.drops);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PARTICLES * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('size', new THREE.BufferAttribute(new Float32Array(PARTICLES), 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('fade', new THREE.BufferAttribute(new Float32Array(PARTICLES), 1).setUsage(THREE.DynamicDrawUsage));
    const sprayMaterial = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: { pixelScale: { value: 500 } },
      vertexShader: `attribute float size; attribute float fade; varying float vFade; uniform float pixelScale;
        void main() { vec4 p = modelViewMatrix * vec4(position, 1.0); vFade = fade;
          gl_PointSize = clamp(size * pixelScale / max(0.1, -p.z), 1.0, 3.2); gl_Position = projectionMatrix * p; }`,
      fragmentShader: `varying float vFade;
        void main() { vec2 p = (gl_PointCoord - 0.5) * 2.0; float r = dot(p,p);
          if (r > 1.0) discard; float a = (1.0 - smoothstep(0.08, 1.0, r)) * vFade * 0.32;
          gl_FragColor = vec4(vec3(0.62, 0.77, 0.79), a); }`,
    });
    this.spray = new THREE.Points(geometry, sprayMaterial);
    this.spray.frustumCulled = false;
    scene.add(this.spray);
    for (let i = 0; i < 20; i++) {
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 40), new THREE.MeshBasicMaterial({ color: '#8faeb3', transparent: true, opacity: 0, depthWrite: false }));
      ring.rotation.x = -Math.PI / 2;
      this.rings.push(ring);
      scene.add(ring);
      const patch = new THREE.Mesh(new THREE.CircleGeometry(1, 32), new THREE.MeshPhysicalMaterial({ color: '#162f36', transparent: true, opacity: 0, roughness: 0.13, clearcoat: 0.8, depthWrite: false }));
      patch.rotation.x = -Math.PI / 2;
      patch.visible = false;
      this.wet.push(patch);
      scene.add(patch);
    }
  }

  reset(): void {
    this.simulation.reset();
    this.ringAges.fill(1);
    this.wet.forEach(p => { p.visible = false; p.material.opacity = 0; });
  }

  private drawTube(mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>, lane: Parcel[], sourceOnly = false): void {
    const positions = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const indices = mesh.geometry.index!;
    let count = 0;
    // 프레임마다 바뀌는 입력이 90Hz 표본에 계단처럼 남지 않도록 표시 곡선만 보간합니다.
    // 물리 위치와 입자 속도는 그대로 유지합니다.
    for (let j = 0; j < lane.length; j++) {
      const center = parcelCenter(lane, j);
      this.centers[j]!.set(center.x, center.y, center.z);
    }
    for (let j = 0; j < lane.length; j++) {
      const p = lane[j]!;
      const center = this.centers[j]!;
      const previous = lane[j - 1]?.chain === p.chain ? this.centers[j - 1]! : center;
      const next = lane[j + 1];
      const after = next?.chain === p.chain ? this.centers[j + 1]! : center;
      // 방출 방향이 변하면 속도와 이력 곡선의 접선이 달라집니다.
      // 실제 이웃 중심점을 따라 단면을 놓아 회전 중 면이 접히는 현상을 줄입니다.
      this.tangent.subVectors(after, previous);
      if (this.tangent.lengthSq() < 1e-8) this.tangent.set(p.velocity.x, p.velocity.y, p.velocity.z);
      this.tangent.normalize();
      this.side.set(-Math.sin(p.angle), 0, Math.cos(p.angle));
      this.side.addScaledVector(this.tangent, -this.side.dot(this.tangent)).normalize();
      this.normal.crossVectors(this.side, this.tangent).normalize();
      const section = parcelSection(p);
      const connected = next?.chain === p.chain;
      const tail = Math.min(1, (lane.length - 1 - j) / 3);
      const taper = Math.sqrt(Math.max(0.02, tail));
      for (let k = 0; k < SIDES; k++) {
        const angle = k / SIDES * Math.PI * 2;
        const c = Math.cos(angle), s = Math.sin(angle);
        // 처음에는 둥근 컵 테두리에 닿는 한 덩어리이며 짧은 거리에서 중앙으로 모입니다.
        const curved = Math.sin(c * p.halfArc) / Math.max(0.001, Math.sin(p.halfArc));
        const across = (c + (curved - c) * section.bend) * section.width;
        const bend = (Math.cos(c * p.halfArc) - 1) * 1.025 * section.bend;
        const lobe = 1 + section.breakup * 0.24 * Math.sin(angle * 3 + p.phase * 0.7);
        const depth = s * section.depth * lobe;
        const drift = Math.sin(p.phase * 0.37) * 0.035 * section.breakup;
        positions.setXYZ(j * SIDES + k,
          center.x + (this.side.x * (across + drift) + this.normal.x * depth + Math.cos(p.angle) * bend) * taper,
          center.y + (this.side.y * across + this.normal.y * depth) * taper,
          center.z + (this.side.z * (across + drift) + this.normal.z * depth + Math.sin(p.angle) * bend) * taper);
        if (connected && !sourceOnly) {
          const a = j * SIDES + k, b = j * SIDES + (k + 1) % SIDES;
          indices.setX(count++, a); indices.setX(count++, a + SIDES); indices.setX(count++, b);
          indices.setX(count++, b); indices.setX(count++, a + SIDES); indices.setX(count++, b + SIDES);
        }
      }
    }
    if (sourceOnly) return;
    mesh.geometry.setDrawRange(0, count);
    // 종료된 삼각형을 비워 법선 계산에 이전 프레임의 면이 섞이지 않게 합니다.
    indices.array.fill(0, count);
    positions.needsUpdate = indices.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  }

  private drawFragment(mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>, f: Fragment): void {
    this.drawTube(mesh, f.parcels, true);
    const positions = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const indices = mesh.geometry.index!;
    this.fragmentSource.set(positions.array);
    const start = parcelCenter(f.parcels, f.start), end = parcelCenter(f.parcels, f.end - 1);
    this.tangent.set(end.x - start.x, end.y - start.y, end.z - start.z);
    if (this.tangent.lengthSq() < 1e-8) this.tangent.set(f.velocity.x, f.velocity.y, f.velocity.z);
    this.tangent.normalize();
    const angle = f.parcels[f.start]!.angle;
    this.side.set(-Math.sin(angle), 0, Math.cos(angle));
    this.side.addScaledVector(this.tangent, -this.side.dot(this.tangent)).normalize();
    this.normal.crossVectors(this.side, this.tangent).normalize();
    const roundness = fragmentRoundness(f.age);
    let count = 0;
    // 원래 표면을 세로 방향으로 보간해 구형으로 수축할 때 면이 접히거나 각지지 않게 합니다.
    for (let row = 0; row < FRAGMENT_RINGS; row++) {
      const t = row / (FRAGMENT_RINGS - 1);
      const sourceRow = f.start + t * (f.end - 1 - f.start);
      const from = Math.floor(sourceRow), to = Math.min(f.end - 1, from + 1), blend = sourceRow - from;
      const radial = Math.sin(t * Math.PI), axial = -Math.cos(t * Math.PI);
      for (let k = 0; k < SIDES; k++) {
        const c = Math.cos(k / SIDES * Math.PI * 2), sn = Math.sin(k / SIDES * Math.PI * 2);
        const a = (from * SIDES + k) * 3, b = (to * SIDES + k) * 3;
        const x = this.fragmentSource[a]! * (1 - blend) + this.fragmentSource[b]! * blend - f.origin.x;
        const y = this.fragmentSource[a + 1]! * (1 - blend) + this.fragmentSource[b + 1]! * blend - f.origin.y;
        const z = this.fragmentSource[a + 2]! * (1 - blend) + this.fragmentSource[b + 2]! * blend - f.origin.z;
        positions.setXYZ(row * SIDES + k,
          f.position.x + x * (1 - roundness) + f.radius * roundness * ((this.side.x * c + this.normal.x * sn) * radial + this.tangent.x * axial),
          f.position.y + y * (1 - roundness) + f.radius * roundness * ((this.side.y * c + this.normal.y * sn) * radial + this.tangent.y * axial),
          f.position.z + z * (1 - roundness) + f.radius * roundness * ((this.side.z * c + this.normal.z * sn) * radial + this.tangent.z * axial));
        if (row < FRAGMENT_RINGS - 1) {
          const v = row * SIDES + k, next = row * SIDES + (k + 1) % SIDES;
          indices.setX(count++, v); indices.setX(count++, v + SIDES); indices.setX(count++, next);
          indices.setX(count++, next); indices.setX(count++, v + SIDES); indices.setX(count++, next + SIDES);
        }
      }
    }
    for (const row of [0, FRAGMENT_RINGS - 1]) {
      for (let k = 1; k < SIDES - 1; k++) {
        const base = row * SIDES;
        indices.setX(count++, base);
        indices.setX(count++, base + (row === 0 ? k + 1 : k));
        indices.setX(count++, base + (row === 0 ? k : k + 1));
      }
    }
    indices.array.fill(0, count);
    mesh.geometry.setDrawRange(0, count);
    positions.needsUpdate = indices.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  }

  draw(dt: number, pixelHeight: number): void {
    for (let i = 0; i < MAX_STREAMS; i++) this.drawTube(this.tubes[i]!, this.simulation.lanes[i]!);
    for (let i = 0; i < MAX_FRAGMENTS; i++) {
      const mesh = this.fragments[i]!, fragment = this.simulation.fragments[i];
      mesh.visible = !!fragment;
      if (fragment) this.drawFragment(mesh, fragment);
      else { mesh.geometry.setDrawRange(0, 0); mesh.geometry.index!.array.fill(0); }
    }
    let drops = 0, fine = 0;
    const positions = this.spray.geometry.getAttribute('position') as THREE.BufferAttribute;
    const sizes = this.spray.geometry.getAttribute('size') as THREE.BufferAttribute;
    const fades = this.spray.geometry.getAttribute('fade') as THREE.BufferAttribute;
    for (const p of this.simulation.particles) {
      if (p.life <= 0) continue;
      const fade = Math.min(1, p.life / 0.12, (p.duration - p.life) / 0.025);
      if (p.fine) {
        positions.setXYZ(fine, p.position.x, p.position.y, p.position.z);
        sizes.setX(fine, p.size * 2);
        fades.setX(fine++, fade);
      } else {
        this.dummy.position.set(p.position.x, p.position.y, p.position.z);
        this.tangent.set(p.velocity.x, p.velocity.y, p.velocity.z);
        const stretch = particleStretch(p);
        this.dummy.quaternion.setFromUnitVectors(this.up, this.tangent.normalize());
        const size = p.size * Math.sqrt(fade);
        this.dummy.scale.set(size / Math.sqrt(stretch), size * stretch, size / Math.sqrt(stretch));
        this.dummy.updateMatrix();
        this.drops.setMatrixAt(drops++, this.dummy.matrix);
      }
    }
    this.drops.count = drops;
    this.drops.instanceMatrix.needsUpdate = true;
    this.spray.geometry.setDrawRange(0, fine);
    positions.needsUpdate = sizes.needsUpdate = fades.needsUpdate = true;
    this.spray.material.uniforms.pixelScale!.value = pixelHeight * 1.5;
    for (const impact of this.simulation.impacts) {
      if (Math.hypot(impact.x, impact.z) > 7) continue;
      let patch = this.wet.find(p => p.visible && Math.hypot(p.position.x - impact.x, p.position.z - impact.z) < 0.4);
      if (!patch) {
        patch = this.wet[this.wetCursor++ % this.wet.length]!;
        patch.position.set(impact.x, FLOOR + 0.006, impact.z);
        patch.scale.set(0.13, 0.1, 1);
        patch.material.opacity = 0.1;
        patch.visible = true;
      }
      patch.scale.x = Math.min(0.65, patch.scale.x + impact.strength * 0.05);
      patch.scale.y = patch.scale.x * 0.8;
      patch.material.opacity = Math.min(0.28, patch.material.opacity + 0.006);
      if (impact.strength < 0.014) continue;
      const idx = this.impactCursor++ % this.rings.length;
      this.rings[idx]!.position.set(impact.x, FLOOR + 0.012, impact.z);
      this.ringAges[idx] = 0;
    }
    for (let i = 0; i < this.rings.length; i++) {
      this.ringAges[i]! += dt;
      const age = this.ringAges[i]!;
      const ring = this.rings[i]!;
      ring.material.opacity = Math.max(0, 1 - age / 0.4) * 0.13;
      ring.scale.setScalar(0.03 + age * 0.55);
    }
  }
}
