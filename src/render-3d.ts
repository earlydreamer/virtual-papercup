import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Cup } from './core/cup.ts';
import { collectRimFlow, sampleWaterLevel } from './core/water-surface.ts';
import { advanceRunoff, runoffProfile, runoffTrail } from './runoff.ts';

const TAU = Math.PI * 2;
const RINGS = 22;
const SEGMENTS = 80;
const STREAMS = 40;
const STEPS = 28;
const SIDES = 7;
const FLOOR = -1.65;

interface Drop {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  life: number;
  size: number;
}

/** 컵 좌표의 높이장과 경계 유량을 조명·굴절·중력 궤적으로 표시합니다. */
export class CupRenderer3D {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(36, 1, 0.1, 70);
  private readonly controls: OrbitControls;
  private readonly homePosition = new THREE.Vector3();
  private viewReady = false;
  private readonly cupGroup = new THREE.Group();
  private readonly waterGeometry = new THREE.BufferGeometry();
  private readonly waterPositions = new Float32Array((RINGS + 1) * (SEGMENTS + 1) * 3);
  private readonly streams: THREE.Mesh[] = [];
  private readonly sheetGeometry = new THREE.BufferGeometry();
  private readonly sheetPositions = new Float32Array((STREAMS + 1) * (STEPS + 1) * 3);
  private readonly sheetColors = new Float32Array((STREAMS + 1) * (STEPS + 1) * 4);
  private readonly runoff = Array.from({ length: STREAMS }, () => new Float32Array(STEPS + 1));
  private readonly flow = new Float32Array(STREAMS);
  private readonly smoothFlow = new Float32Array(STREAMS);
  private readonly drops: Drop[] = Array.from({ length: 220 }, () => ({
    position: new THREE.Vector3(), velocity: new THREE.Vector3(), life: 0, size: 0,
  }));
  private readonly dropMesh: THREE.InstancedMesh;
  private readonly runoffBeads: THREE.InstancedMesh;
  private readonly puddle: THREE.Mesh<THREE.CircleGeometry, THREE.MeshPhysicalMaterial>;
  private readonly dummy = new THREE.Object3D();
  private readonly origin = new THREE.Vector3();
  private readonly environment: THREE.WebGLRenderTarget;
  private lastCup: Cup | null = null;
  private dropCursor = 0;
  private emission = 0;
  private wetness = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.9;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.transmissionResolutionScale = 0.6;
    this.scene.background = new THREE.Color('#111a21');
    this.scene.fog = new THREE.Fog('#111a21', 13, 30);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.environment = pmrem.fromScene(room, 0.04);
    this.scene.environment = this.environment.texture;
    this.scene.environmentIntensity = 0.55;
    room.dispose();
    pmrem.dispose();

    this.scene.add(new THREE.HemisphereLight('#d8edff', '#6e5d43', 0.9));
    const key = new THREE.DirectionalLight('#fff1d8', 2.6);
    key.position.set(-3, 7, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -4;
    key.shadow.camera.right = 4;
    key.shadow.camera.top = 4;
    key.shadow.camera.bottom = -4;
    key.shadow.normalBias = 0.025;
    key.shadow.bias = -0.0003;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight('#91cfff', 1.1);
    fill.position.set(3, 4, -5);
    this.scene.add(fill);

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(100, 100),
      new THREE.MeshStandardMaterial({ color: '#15232a', roughness: 0.66, metalness: 0.12 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = FLOOR;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.scene.add(this.cupGroup);
    // 컵은 고정하고 센서 입력은 수면·넘침 계산에만 반영합니다.
    this.cupGroup.position.y = FLOOR + 1 + 0.02;
    this.makeCup();

    const indices: number[] = [];
    for (let r = 0; r < RINGS; r++) {
      for (let s = 0; s < SEGMENTS; s++) {
        const a = r * (SEGMENTS + 1) + s;
        const b = a + SEGMENTS + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    this.waterGeometry.setAttribute('position', new THREE.BufferAttribute(this.waterPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.waterGeometry.setIndex(indices);
    const water = new THREE.MeshPhysicalMaterial({
      color: '#93c6ce', roughness: 0.035, metalness: 0, transmission: 0.8,
      thickness: 0.7, ior: 1.333, clearcoat: 1, clearcoatRoughness: 0.04,
      attenuationColor: new THREE.Color('#3e9ba8'), attenuationDistance: 1.6,
      side: THREE.DoubleSide, envMapIntensity: 1.25,
    });
    const surface = new THREE.Mesh(this.waterGeometry, water);
    surface.frustumCulled = false;
    this.cupGroup.add(surface);

    const streamMaterial = new THREE.MeshPhysicalMaterial({
      color: '#b5d2da', roughness: 0.065, metalness: 0,
      transparent: true, opacity: 0.64, clearcoat: 1, depthWrite: false,
      envMapIntensity: 1.3, side: THREE.DoubleSide,
    });
    this.sheetGeometry.setAttribute('position', new THREE.BufferAttribute(this.sheetPositions, 3).setUsage(THREE.DynamicDrawUsage));
    this.sheetGeometry.setAttribute('color', new THREE.BufferAttribute(this.sheetColors, 4).setUsage(THREE.DynamicDrawUsage));
    const sheetIndices: number[] = [];
    for (let i = 0; i < STREAMS; i++) {
      for (let j = 0; j < STEPS; j++) {
        const a = i * (STEPS + 1) + j;
        const b = a + STEPS + 1;
        sheetIndices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
    this.sheetGeometry.setIndex(sheetIndices);
    const sheetMaterial = streamMaterial.clone();
    sheetMaterial.color.set('#78979c');
    sheetMaterial.opacity = 0.36;
    sheetMaterial.roughness = 0.16;
    sheetMaterial.vertexColors = true;
    sheetMaterial.depthWrite = false;
    const sheet = new THREE.Mesh(this.sheetGeometry, sheetMaterial);
    sheet.frustumCulled = false;
    this.scene.add(sheet);
    for (let i = 0; i < STREAMS; i++) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array((STEPS + 1) * SIDES * 3), 3).setUsage(THREE.DynamicDrawUsage));
      const triangles: number[] = [];
      for (let j = 0; j < STEPS; j++) {
        for (let k = 0; k < SIDES; k++) {
          const a = j * SIDES + k;
          const b = j * SIDES + (k + 1) % SIDES;
          triangles.push(a, b, a + SIDES, b, b + SIDES, a + SIDES);
        }
      }
      geometry.setIndex(triangles);
      const mesh = new THREE.Mesh(geometry, streamMaterial);
      mesh.visible = false;
      mesh.frustumCulled = false;
      this.streams.push(mesh);
      this.scene.add(mesh);
    }
    this.dropMesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 7, 5), streamMaterial, this.drops.length);
    this.dropMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.dropMesh.frustumCulled = false;
    this.scene.add(this.dropMesh);
    this.runoffBeads = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 7, 5), streamMaterial, STREAMS * 2);
    this.runoffBeads.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.runoffBeads.frustumCulled = false;
    this.scene.add(this.runoffBeads);

    this.puddle = new THREE.Mesh(new THREE.CircleGeometry(1, 80), new THREE.MeshPhysicalMaterial({
      color: '#1d3941', transparent: true, opacity: 0, roughness: 0.08,
      metalness: 0.2, clearcoat: 1, depthWrite: false,
    }));
    this.puddle.rotation.x = -Math.PI / 2;
    this.puddle.position.set(0, FLOOR + 0.012, 0);
    this.scene.add(this.puddle);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, -0.55, 0);
    this.controls.enablePan = false;
    this.controls.enableZoom = false;
    this.controls.enableDamping = false;
    this.controls.rotateSpeed = 0.6;
    this.controls.minPolarAngle = 0.12;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.08;
    this.controls.cursorStyle = 'grab';
  }

  private makeCup(): void {
    const textureCanvas = document.createElement('canvas');
    textureCanvas.width = 512;
    textureCanvas.height = 512;
    const ctx = textureCanvas.getContext('2d')!;
    ctx.fillStyle = '#f0e9dc';
    ctx.fillRect(0, 0, 512, 512);
    // 고정 시드로 종이 섬유를 생성합니다. 외부 이미지는 사용하지 않습니다.
    let seed = 731;
    for (let i = 0; i < 26000; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const x = seed % 512;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const y = seed % 512;
      ctx.fillStyle = i % 2 ? 'rgba(94,76,46,0.045)' : 'rgba(255,255,255,0.2)';
      ctx.fillRect(x, y, 1, 2);
    }
    ctx.fillStyle = 'rgba(84,69,46,0.10)';
    ctx.fillRect(502, 0, 2, 512);
    const paperTexture = new THREE.CanvasTexture(textureCanvas);
    paperTexture.colorSpace = THREE.SRGBColorSpace;
    const paper = new THREE.MeshStandardMaterial({ map: paperTexture, roughness: 0.86, bumpMap: paperTexture, bumpScale: 0.014, side: THREE.DoubleSide });
    const profile = [
      [0, -1], [0.70, -1], [0.735, -0.98], [1, 0.98], [1.005, 1.01],
      [0.975, 1.01], [0.955, 0.97], [0.695, -0.93], [0, -0.93],
    ].map(([r, y]) => new THREE.Vector2(r!, y!));
    const body = new THREE.Mesh(new THREE.LatheGeometry(profile, 96), paper);
    body.castShadow = true;
    body.receiveShadow = true;
    this.cupGroup.add(body);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.985, 0.044, 12, 96),
      new THREE.MeshStandardMaterial({ color: '#fffaed', roughness: 0.58 }));
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 1;
    rim.castShadow = true;
    this.cupGroup.add(rim);
    const foot = new THREE.Mesh(new THREE.TorusGeometry(0.715, 0.023, 8, 80), paper);
    foot.rotation.x = Math.PI / 2;
    foot.position.y = -0.98;
    this.cupGroup.add(foot);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(height, 1);
    // 세로 화면에서도 컵과 양옆 물줄기를 담습니다.
    const distance = this.camera.aspect < 0.8 ? 8.8 / Math.max(this.camera.aspect / 0.65, 0.55) : 7.9;
    this.homePosition.set(0, distance * 0.72, distance * 0.72);
    if (this.viewReady) {
      // 화면 회전·모드 전환 때 직접 고른 방위각과 고도를 보존합니다.
      const radius = this.homePosition.distanceTo(this.controls.target);
      this.camera.position.sub(this.controls.target).setLength(radius).add(this.controls.target);
      this.controls.update();
    } else {
      this.resetView();
      this.viewReady = true;
    }
    this.camera.updateProjectionMatrix();
  }

  get viewAzimuth(): number {
    return this.controls.getAzimuthalAngle();
  }

  resetView(): void {
    this.camera.position.copy(this.homePosition);
    this.controls.update();
  }

  render(cup: Cup, dtMs: number, now: number): void {
    const dt = Math.min(dtMs, 50) / 1000;
    if (this.lastCup !== cup) {
      this.smoothFlow.fill(0);
      for (const column of this.runoff) column.fill(0);
      for (const drop of this.drops) drop.life = 0;
      this.wetness = 0;
      this.lastCup = cup;
    }
    for (let r = 0; r <= RINGS; r++) {
      const fraction = r / RINGS;
      for (let s = 0; s <= SEGMENTS; s++) {
        const angle = s / SEGMENTS * TAU;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        let level = sampleWaterLevel(cup, cos * fraction, sin * fraction);
        let radius = 0;
        // 원뿔 모양의 내벽과 높이장의 교점에 수면을 맞춥니다.
        for (let k = 0; k < 3; k++) {
          radius = (0.695 + (level + 0.93) / 1.90 * 0.26) * fraction;
          level = sampleWaterLevel(cup, cos * radius, sin * radius);
        }
        const idx = (r * (SEGMENTS + 1) + s) * 3;
        this.waterPositions[idx] = cos * radius;
        const ripple = Math.sin(cos * radius * 24 + now / 650) * Math.sin(sin * radius * 19 - now / 730)
          * 0.002 * (1 - fraction * fraction);
        this.waterPositions[idx + 1] = Math.max(-0.925, Math.min(0.994, level + ripple));
        this.waterPositions[idx + 2] = sin * radius;
      }
    }
    this.waterGeometry.attributes.position!.needsUpdate = true;
    this.waterGeometry.computeVertexNormals();
    collectRimFlow(cup, this.flow);
    this.emission += dt * 24;
    const emit = this.emission >= 1;
    if (emit) this.emission %= 1;

    for (let i = 0; i < STREAMS; i++) {
      const flow = this.smoothFlow[i]! + (this.flow[i]! - this.smoothFlow[i]!) * Math.min(1, dt * 18);
      this.smoothFlow[i] = flow;
      const mesh = this.streams[i]!;
      const column = this.runoff[i]!;
      advanceRunoff(column, flow, dt);
      mesh.visible = column.some(value => value > 0.015);
      const angle = i / STREAMS * TAU;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const positions = mesh.geometry.attributes.position as THREE.BufferAttribute;
      for (let j = 0; j <= STEPS; j++) {
        const p = j / STEPS;
        const localFlow = column[j]!;
        const coverage = THREE.MathUtils.smoothstep(localFlow, 0.004, 0.12);
        const profile = runoffProfile(p);
        // 아래로 이동하는 잔물결과 가는 물길을 외벽 위에 겹칩니다.
        const wave = Math.sin(p * 35 - now / 130 + i * 1.7);
        const radius = profile.radius + wave * 0.0015 * coverage;
        const sheetIndex = (i * (STEPS + 1) + j) * 3;
        this.sheetPositions[sheetIndex] = cos * radius;
        this.sheetPositions[sheetIndex + 1] = profile.height + this.cupGroup.position.y;
        this.sheetPositions[sheetIndex + 2] = sin * radius;
        const colorIndex = (i * (STEPS + 1) + j) * 4;
        this.sheetColors[colorIndex] = 0.86;
        this.sheetColors[colorIndex + 1] = 0.95;
        this.sheetColors[colorIndex + 2] = 1;
        this.sheetColors[colorIndex + 3] = coverage * (0.68 + wave * 0.12)
          * (1 - p * 0.35 * (0.5 + 0.5 * Math.sin(i * 2.3)));
        const trail = runoffTrail(i, p, now, STREAMS);
        const streamAngle = trail.angle;
        const streamCos = Math.cos(streamAngle);
        const streamSin = Math.sin(streamAngle);
        const width = coverage * (0.012 + Math.min(localFlow, 1) * 0.035) * trail.width;
        const x = streamCos * (radius + 0.003);
        const y = profile.height + this.cupGroup.position.y;
        const z = streamSin * (radius + 0.003);
        // 가는 물길이 종이 표면에서 뜨지 않도록 단면의 두께를 줄입니다.
        const sideX = -streamSin;
        const sideZ = streamCos;
        for (let k = 0; k < SIDES; k++) {
          const a = k / SIDES * TAU;
          const u = Math.cos(a) * width;
          const v = Math.sin(a) * Math.min(width * 0.3, 0.004);
          positions.setXYZ(j * SIDES + k, x + sideX * u + streamCos * v,
            y, z + sideZ * u + streamSin * v);
        }
      }
      positions.needsUpdate = true;
      if (mesh.visible) mesh.geometry.computeVertexNormals();
      for (let bead = 0; bead < 2; bead++) {
        const p = (now / 1100 + i * 0.618 + bead * 0.5) % 1;
        const beadFlow = column[Math.floor(p * STEPS)]!;
        const profile = runoffProfile(p);
        const trail = runoffTrail(i, p, now, STREAMS);
        const size = THREE.MathUtils.smoothstep(beadFlow, 0.01, 0.14)
          * Math.min(1, trail.width * 3) * (0.012 + 0.005 * Math.sin(i * 3.7));
        this.dummy.position.set(Math.cos(trail.angle) * (profile.radius + 0.004), profile.height + this.cupGroup.position.y,
          Math.sin(trail.angle) * (profile.radius + 0.004));
        this.dummy.rotation.set(0, -trail.angle, 0);
        this.dummy.scale.set(size * 0.5, size * 2.5, size);
        this.dummy.updateMatrix();
        this.runoffBeads.setMatrixAt(i * 2 + bead, this.dummy.matrix);
      }
      const bottomFlow = column[STEPS]!;
      if (emit && bottomFlow > 0.02 && (i + this.dropCursor) % 3 === 0) {
        const drop = this.drops[this.dropCursor++ % this.drops.length]!;
        const bottom = runoffProfile(1);
        const endAngle = runoffTrail(i, 1, now, STREAMS).angle;
        this.origin.set(Math.cos(endAngle) * bottom.radius, bottom.height + this.cupGroup.position.y, Math.sin(endAngle) * bottom.radius);
        drop.position.copy(this.origin);
        drop.velocity.set(Math.cos(endAngle) * 0.12, -0.65 - bottomFlow * 0.3, Math.sin(endAngle) * 0.12);
        drop.life = 1.3;
        drop.size = (0.009 + Math.min(bottomFlow, 1) * 0.012) * (0.8 + 0.2 * Math.sin(this.dropCursor * 2.7));
      }
    }
    this.sheetPositions.copyWithin(STREAMS * (STEPS + 1) * 3, 0, (STEPS + 1) * 3);
    this.sheetColors.copyWithin(STREAMS * (STEPS + 1) * 4, 0, (STEPS + 1) * 4);
    this.sheetGeometry.attributes.position!.needsUpdate = true;
    this.sheetGeometry.attributes.color!.needsUpdate = true;
    this.sheetGeometry.computeVertexNormals();
    this.runoffBeads.instanceMatrix.needsUpdate = true;
    this.dummy.rotation.set(0, 0, 0);
    for (let i = 0; i < this.drops.length; i++) {
      const drop = this.drops[i]!;
      if (drop.life > 0) {
        drop.life -= dt;
        drop.velocity.y -= 9.8 * dt;
        drop.position.addScaledVector(drop.velocity, dt);
        if (drop.position.y < FLOOR + drop.size) {
          this.wetness = Math.min(1, this.wetness + 0.004);
          if (drop.velocity.y < -0.8 && drop.life > 0.6) {
            drop.position.y = FLOOR + drop.size;
            drop.velocity.y *= -0.19;
            drop.velocity.x *= 1.8;
            drop.velocity.z *= 1.8;
            drop.life = 0.35;
          } else drop.life = 0;
        }
      }
      this.dummy.position.copy(drop.position);
      const size = drop.life > 0 ? drop.size : 0;
      this.dummy.scale.set(size, size * (1 + Math.abs(drop.velocity.y) * 0.10), size);
      this.dummy.updateMatrix();
      this.dropMesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.dropMesh.instanceMatrix.needsUpdate = true;
    this.puddle.scale.set(0.8 + this.wetness * 1.6, 0.6 + this.wetness * 1.3, 1);
    this.puddle.material.opacity = this.wetness * 0.30;
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.controls.dispose();
    const materials = new Set<THREE.Material>();
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
    });
    for (const material of materials) {
      if (material instanceof THREE.MeshStandardMaterial) material.map?.dispose();
      material.dispose();
    }
    this.environment.dispose();
    this.renderer.dispose();
  }
}
