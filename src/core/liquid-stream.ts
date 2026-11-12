import type { Tilt, Vec3 } from './types.ts';
import { cupGravity, spillFlight } from './spill-flight.ts';

export const LANES = 8;
export const HISTORY = 72;
export const PARTICLES = 900;
const STEP = 1 / 90;
const FLOOR = -1.65;
const TAU = Math.PI * 2;
export interface Source { angle: number; rate: number; velocity: Vec3 }
export interface Parcel { position: Vec3; velocity: Vec3; age: number; volume: number; radius: number; chain: number; phase: number }
export interface Particle { position: Vec3; velocity: Vec3; life: number; duration: number; size: number; fine: boolean }
export interface Impact { x: number; z: number; strength: number }
const vec = (): Vec3 => ({ x: 0, y: 0, z: 0 });

/** Q = 면적 × 속도. 물줄기가 빨라지면 단면이 좁아집니다. */
export function streamRadius(rate: number, speed: number): number {
  return Math.min(0.24, Math.sqrt(Math.max(0, rate) / (Math.PI * Math.max(0.2, speed))));
}

/** 테두리의 인접 유출을 모으되 서로 떨어진 구역 사이에 면을 만들지 않습니다. */
export function streamSources(tilt: Tilt, flow: Float32Array, head: Float32Array, rise: Float32Array, rate: number): Source[] {
  const sums = Array.from({ length: LANES }, () => ({ x: 0, z: 0, weight: 0, head: 0, rise: 0 }));
  let total = 0;
  for (let i = 0; i < flow.length; i++) {
    const angle = i / flow.length * TAU;
    const flight = spillFlight(tilt, angle, head[i]!, rise[i]!);
    const pressureWeight = flow[i]! * Math.pow(Math.max(0, head[i]!), 1.5);
    const weight = pressureWeight * flight.detached;
    total += pressureWeight;
    const sum = sums[Math.round(i / flow.length * LANES) % LANES]!;
    sum.x += Math.cos(angle) * weight;
    sum.z += Math.sin(angle) * weight;
    sum.weight += weight;
    sum.head += head[i]! * weight;
    sum.rise += rise[i]! * weight;
  }
  return sums.map(sum => {
    const angle = Math.atan2(sum.z, sum.x);
    return { angle, rate: total > 0 ? rate * sum.weight / total : 0,
      velocity: spillFlight(tilt, angle, sum.head / (sum.weight || 1), sum.rise / (sum.weight || 1)).velocity };
  });
}

/** 고정 시간 간격으로 방출된 물의 위치·속도를 보존하는 시각용 유출 모델입니다. */
export class LiquidStream {
  readonly lanes: Parcel[][] = Array.from({ length: LANES }, () => []);
  readonly particles: Particle[] = Array.from({ length: PARTICLES }, () => ({ position: vec(), velocity: vec(), life: 0, duration: 1, size: 0, fine: false }));
  readonly impacts: Impact[] = [];
  private accumulator = 0;
  private cursor = 0;
  private seed = 731;
  private chains = new Uint32Array(LANES);
  private active = new Uint8Array(LANES);

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
    while (this.accumulator + 1e-10 >= STEP) {
      this.accumulator = Math.max(0, this.accumulator - STEP);
      for (const p of this.particles) {
        if (p.life <= 0) continue;
        p.life -= STEP;
        this.advance(p.position, p.velocity, gravity);
        if (p.position.y <= FLOOR + p.size) {
          this.impact(p.position, p.velocity, p.size * 2, !p.fine && p.velocity.y < -1);
          p.life = 0;
        }
      }
      for (let i = 0; i < LANES; i++) {
        const lane = this.lanes[i]!;
        for (let j = lane.length - 1; j >= 0; j--) {
          const p = lane[j]!;
          p.age += STEP;
          this.advance(p.position, p.velocity, gravity);
          p.radius = streamRadius(p.volume / STEP, Math.hypot(p.velocity.x, p.velocity.y, p.velocity.z));
          const breakup = 0.18 + Math.min(0.25, p.radius * 2.2) + 0.035 * Math.sin(p.phase);
          if (p.position.y <= FLOOR + p.radius) {
            this.impact(p.position, p.velocity, p.radius, true);
            lane.splice(j, 1);
          } else if (p.age > breakup) {
            // 작은 대표 입자로 분열을 표시합니다. 표시 입자의 부피 합은 실제 유출량과 별개입니다.
            for (let k = 0; k < 6; k++) {
              const spread = p.radius * 0.65;
              const dx = (this.random() - 0.5) * spread;
              const dz = (this.random() - 0.5) * spread;
              const fine = k > 0;
              const size = fine ? 0.002 + this.random() * 0.004 : 0.006 + Math.pow(this.random(), 2) * Math.min(0.016, p.radius * 0.3);
              this.emit({ x: p.position.x + dx, y: p.position.y + (this.random() - 0.5) * spread, z: p.position.z + dz },
                { x: p.velocity.x + dx * 3, y: p.velocity.y + (this.random() - 0.5) * 0.22, z: p.velocity.z + dz * 3 }, size, fine);
            }
            lane.splice(j, 1);
          }
        }
        const source = sources[i];
        if (!source || source.rate < 0.0003) { this.active[i] = 0; continue; }
        const position = { x: Math.cos(source.angle) * 1.025, y: 0.395, z: Math.sin(source.angle) * 1.025 };
        const last = lane[0];
        if (!this.active[i] || (last && Math.hypot(last.position.x - position.x, last.position.z - position.z) > 0.25)) this.chains[i]!++;
        this.active[i] = 1;
        lane.unshift({ position, velocity: { ...source.velocity }, age: 0, volume: source.rate * STEP,
          radius: streamRadius(source.rate, Math.hypot(source.velocity.x, source.velocity.y, source.velocity.z)), chain: this.chains[i]!, phase: this.random() * TAU });
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
