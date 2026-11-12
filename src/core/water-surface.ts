import type { Cup } from './cup.ts';

/** 원판 밖의 빈 격자 칸은 제외하고 인접 수면을 보간합니다. */
export function sampleWaterLevel(cup: Cup, x: number, y: number): number {
  const gx = (x + 1) * (cup.n - 1) / 2;
  const gy = (y + 1) * (cup.n - 1) / 2;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  let sum = 0;
  let weight = 0;
  for (let j = iy - 1; j <= iy + 2; j++) {
    for (let i = ix - 1; i <= ix + 2; i++) {
      if (i < 0 || j < 0 || i >= cup.n || j >= cup.n) continue;
      const k = j * cup.n + i;
      if (!cup.inside[k]) continue;
      const w = Math.max(0, 1.5 - Math.abs(gx - i)) * Math.max(0, 1.5 - Math.abs(gy - j));
      sum += cup.levelAt(k) * w;
      weight += w;
    }
  }
  return Math.max(-0.99, Math.min(1, weight > 0 ? sum / weight : cup.base));
}

/** 경계 칸의 각도를 유지해 물줄기의 출발 지점을 정합니다. */
export function collectRimFlow(cup: Cup, sectors: Float32Array): void {
  sectors.fill(0);
  for (let i = 0; i < cup.edge.length; i++) {
    if (!cup.edge[i] || cup.edgeOverflow[i]! <= 0) continue;
    const angle = Math.atan2(cup.py[i]!, cup.px[i]!);
    const sector = Math.round((angle / (2 * Math.PI) + 1) * sectors.length) % sectors.length;
    sectors[sector] = Math.max(sectors[sector]!, cup.edgeOverflow[i]!);
  }
}
