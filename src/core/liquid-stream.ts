import type { Tilt, Vec3 } from './types.ts';
import { cupGravity, spillFlight } from './spill-flight.ts';

// 독립된 넘침 구간의 보관 한도이며 각도 분할 수가 아닙니다.
export const MAX_STREAMS = 4;
export const HISTORY = 72;
export const PARTICLES = 900;
export const FRAGMENT_SECONDS = 0.12;
const STEP = 1 / 90;
const FLOOR = -1.65;
const TAU = Math.PI * 2;
export interface Source { angle: number; halfArc: number; rate: number; velocity: Vec3 }
export interface Parcel { position: Vec3; velocity: Vec3; age: number; volume: number; radius: number; chain: number; phase: number; angle: number; halfArc: number; breakupAge: number }
export interface Particle { position: Vec3; velocity: Vec3; life: number; duration: number; size: number; fine: boolean }
export interface Impact { x: number; z: number; strength: number }
const vec = (): Vec3 => ({ x: 0, y: 0, z: 0 });

/** Q = 면적 × 속도. 물줄기가 빨라지면 단면이 좁아집니다. */
export function streamRadius(rate: number, speed: number): number {
  return Math.min(0.24, Math.sqrt(Math.max(0, rate) / (Math.PI * Math.max(0.2, speed))));
}

/** 각도 축과 무관하게 원형 테두리의 연결된 넘침 구간을 찾습니다. */
export function streamSources(tilt: Tilt, flow: Float32Array, head: Float32Array, rise: Float32Array, rate: number): Source[] {
  const weights = new Float64Array(flow.length);
  let total = 0;
  for (let i = 0; i < flow.length; i++) {
    const angle = i / flow.length * TAU;
    const flight = spillFlight(tilt, angle, head[i]!, rise[i]!);
    const pressureWeight = flow[i]! * Math.pow(Math.max(0, head[i]!), 1.5);
    weights[i] = pressureWeight * flight.detached;
    total += pressureWeight;
  }
  if (total <= 0 || rate <= 0) return [];
  const threshold = Math.max(1e-8, Math.max(...weights) * 0.015);
  // 빈 칸 뒤에서 시작하면 359도와 0도를 가로지르는 구간도 하나로 묶입니다.
  const gap = weights.findIndex(w => w <= threshold);
  const groups: number[][] = [];
  let group: number[] = [];
  for (let n = 1; n <= weights.length; n++) {
    const i = (gap + n) % weights.length;
    if (weights[i]! > threshold) group.push(i);
    else if (group.length) { groups.push(group); group = []; }
  }
  if (group.length) groups.push(group);
  return groups.map(indices => {
    let x = 0, z = 0, sum = 0, h = 0, r = 0;
    for (const i of indices) {
      const w = weights[i]!, a = i / weights.length * TAU;
      x += Math.cos(a) * w; z += Math.sin(a) * w; sum += w;
      h += head[i]! * w; r += rise[i]! * w;
    }
    const angle = Math.hypot(x, z) > 1e-8 ? Math.atan2(z, x) : Math.atan2(tilt.y, tilt.x);
    let variance = 0;
    for (const i of indices) {
      const delta = Math.atan2(Math.sin(i / weights.length * TAU - angle), Math.cos(i / weights.length * TAU - angle));
      variance += weights[i]! * delta * delta;
    }
    return { angle, halfArc: Math.min(1.2, Math.max(TAU / weights.length / 2, Math.sqrt(variance / sum) * 1.65)),
      rate: rate * sum / total, velocity: spillFlight(tilt, angle, h / sum, r / sum).velocity };
  }).sort((a, b) => b.rate - a.rate).slice(0, MAX_STREAMS);
}

/** 입구의 폭이 빠르게 모인 뒤, 목이 불규칙하게 좁아지며 분열합니다. */
export function parcelSection(p: Parcel): { width: number; depth: number; bend: number; breakup: number; pinched: boolean } {
  const gather = Math.exp(-p.age * 21);
  const breakup = Math.max(0, Math.min(1, (p.age / p.breakupAge - 0.58) / 0.42));
  const ripple = Math.sin(p.phase + p.age * 17) * 0.11 + Math.sin(p.phase * 0.43 - p.age * 29) * 0.07;
  const instability = 0.5 + 0.5 * Math.sin(p.phase * 1.7 + Math.sin(p.phase * 0.31) * 0.45);
  const fragment = Math.max(0, Math.min(1, (p.age - p.breakupAge) / FRAGMENT_SECONDS));
  const neck = (1 + ripple * Math.min(1, p.age * 12))
    * (1 - breakup * (0.1 + 0.88 * instability)) * (1 - fragment * 0.3);
  const pinched = breakup > 0.9 && instability > 0.86;
  const width = (p.radius + Math.max(0, Math.sin(p.halfArc) * 1.025 - p.radius) * gather) * neck;
  const depth = Math.max(0.006, p.radius * p.radius / Math.max(width, 0.01)) * neck * neck;
  return { width: pinched ? 0.001 : width, depth: pinched ? 0.001 : depth, bend: gather, breakup, pinched };
}

/** 고정 시간 간격으로 방출된 물의 위치·속도를 보존하는 시각용 유출 모델입니다. */
export class LiquidStream {
  readonly lanes: Parcel[][] = Array.from({ length: MAX_STREAMS }, () => []);
  readonly particles: Particle[] = Array.from({ length: PARTICLES }, () => ({ position: vec(), velocity: vec(), life: 0, duration: 1, size: 0, fine: false }));
  readonly impacts: Impact[] = [];
  private accumulator = 0;
  private cursor = 0;
  private seed = 731;
  private time = 0;
  private chains = new Uint32Array(MAX_STREAMS);
  private active = new Uint8Array(MAX_STREAMS);

  private random(): number {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  reset(): void {
    this.lanes.forEach(lane => { lane.length = 0; });
    this.particles.forEach(p => { p.life = 0; });
    this.impacts.length = 0;
    this.accumulator = 0;
    this.active.fill(0);
    this.chains.fill(0);
    this.time = 0;
  }

  emit(position: Vec3, velocity: Vec3, size: number, fine = false): void {
    const p = this.particles[this.cursor++ % PARTICLES]!;
    Object.assign(p.position, position);
    Object.assign(p.velocity, velocity);
    p.size = size;
    p.fine = fine;
    p.life = p.duration = fine ? 0.18 + this.random() * 0.22 : 0.6 + this.random() * 0.6;
  }

  private impact(position: Vec3, velocity: Vec3, strength: number, splash: boolean): void {
    if (this.impacts.length < 24) this.impacts.push({ x: position.x, z: position.z, strength });
    if (!splash) return;
    for (let j = 0; j < 5; j++) {
      const angle = this.random() * TAU;
      const speed = 0.2 + this.random() * Math.min(1.2, Math.abs(velocity.y) * 0.3);
      this.emit({ x: position.x, y: FLOOR + 0.015, z: position.z },
        { x: velocity.x * 0.13 + Math.cos(angle) * speed, y: 0.2 + this.random() * 0.65, z: velocity.z * 0.13 + Math.sin(angle) * speed },
        0.002 + this.random() * 0.006, true);
    }
  }

  update(tilt: Tilt, sources: Source[], seconds: number): void {
    this.impacts.length = 0;
    this.accumulator += Math.min(Math.max(seconds, 0), 0.05);
    const gravity = cupGravity(tilt);
    // 구간의 세기 순서가 바뀌어도 기존 궤적은 가까운 출발 구간에 연결합니다.
    const assigned: (Source | undefined)[] = Array(MAX_STREAMS);
    for (const source of sources) {
      let best = -1, score = Infinity;
      for (let i = 0; i < MAX_STREAMS; i++) {
        if (assigned[i]) continue;
        const last = this.lanes[i]![0];
        const distance = last && this.active[i]
          ? Math.abs(Math.atan2(Math.sin(source.angle - last.angle), Math.cos(source.angle - last.angle))) : 10 + i;
        if (distance < score) { score = distance; best = i; }
      }
      if (best >= 0) assigned[best] = source;
    }
    while (this.accumulator + 1e-10 >= STEP) {
      this.accumulator = Math.max(0, this.accumulator - STEP);
      this.time += STEP;
      for (const p of this.particles) {
        if (p.life <= 0) continue;
        p.life -= STEP;
        this.advance(p.position, p.velocity, gravity);
        if (p.position.y <= FLOOR + p.size) {
          this.impact(p.position, p.velocity, p.size * 2, !p.fine && p.velocity.y < -1);
          p.life = 0;
        }
      }
      for (let i = 0; i < MAX_STREAMS; i++) {
        const lane = this.lanes[i]!;
        for (let j = lane.length - 1; j >= 0; j--) {
          const p = lane[j]!;
          p.age += STEP;
          this.advance(p.position, p.velocity, gravity);
          p.radius = streamRadius(p.volume / STEP, Math.hypot(p.velocity.x, p.velocity.y, p.velocity.z));
          if (p.position.y <= FLOOR + p.radius) {
            this.impact(p.position, p.velocity, p.radius, true);
            lane.splice(j, 1);
          } else if (p.age > p.breakupAge + FRAGMENT_SECONDS) {
            // 작은 대표 입자로 분열을 표시합니다. 표시 입자의 부피 합은 실제 유출량과 별개입니다.
            for (let k = 0; k < 2; k++) {
              const fine = k === 1;
              if (fine && this.random() > 0.3) continue;
              const spread = p.radius * 0.9;
              const across = (this.random() - 0.5) * spread;
              const dx = -Math.sin(p.angle) * across;
              const dz = Math.cos(p.angle) * across;
              const size = fine ? 0.002 + this.random() * 0.004 : 0.006 + Math.pow(this.random(), 2) * Math.min(0.024, p.radius * 0.3);
              this.emit({ x: p.position.x + dx, y: p.position.y + (this.random() - 0.5) * spread, z: p.position.z + dz },
                { x: p.velocity.x + dx * 3, y: p.velocity.y + (this.random() - 0.5) * 0.2, z: p.velocity.z + dz * 3 }, size, fine);
            }
            lane.splice(j, 1);
          }
        }
        const source = assigned[i];
        if (!source || source.rate < 0.0003) { this.active[i] = 0; continue; }
        const position = { x: Math.cos(source.angle) * 1.025, y: 0.395, z: Math.sin(source.angle) * 1.025 };
        const last = lane[0];
        if (!this.active[i] || (last && Math.hypot(last.position.x - position.x, last.position.z - position.z) > 0.25)) this.chains[i]!++;
        this.active[i] = 1;
        const radius = streamRadius(source.rate, Math.hypot(source.velocity.x, source.velocity.y, source.velocity.z));
        const phase = this.time * 32 + source.angle * 2;
        lane.unshift({ position, velocity: { ...source.velocity }, age: 0, volume: source.rate * STEP,
          radius, chain: this.chains[i]!, phase, angle: source.angle, halfArc: source.halfArc,
          breakupAge: 0.28 + Math.min(0.22, radius * 0.9) + 0.035 * Math.sin(phase * 0.63) });
        if (lane.length > HISTORY) lane.length = HISTORY;
      }
    }
  }

  private advance(p: Vec3, v: Vec3, g: Vec3): void {
    p.x += v.x * STEP + g.x * STEP * STEP / 2;
    p.y += v.y * STEP + g.y * STEP * STEP / 2;
    p.z += v.z * STEP + g.z * STEP * STEP / 2;
    v.x += g.x * STEP; v.y += g.y * STEP; v.z += g.z * STEP;
  }
}
