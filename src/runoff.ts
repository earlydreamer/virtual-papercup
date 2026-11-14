/** 컵 바깥면의 물막 연출입니다. 실제 물 손실량은 Cup이 계산합니다. */
export function runoffProfile(progress: number): { radius: number; height: number } {
  const p = Math.max(0, Math.min(1, progress));
  if (p < 0.12) {
    // 말린 테두리를 안쪽에서 위로 넘어 바깥쪽까지 감쌉니다.
    const angle = Math.PI * (1 - p / 0.12);
    return { radius: 0.985 + 0.052 * Math.cos(angle), height: 1 + 0.052 * Math.sin(angle) };
  }
  const down = (p - 0.12) / 0.88;
  const height = 1 - down * 1.95;
  const wall = 0.735 + (height + 0.98) / 1.96 * 0.265;
  // 테두리 바깥에서 벽으로 붙고, 바닥 가까이에서 살짝 두꺼워집니다.
  const lip = 0.026 * Math.exp(-down * 35);
  return { radius: wall + 0.008 + lip + 0.006 * down ** 6, height };
}

/** 위쪽 유량을 아래로 운반해 젖기 시작하는 지점과 남은 물의 배수를 표현합니다. */
export function advanceRunoff(column: Float32Array, inflow: number, dt: number): void {
  const rate = (column.length - 1) / 0.85;
  const substeps = Math.max(1, Math.ceil(dt * rate / 0.7));
  const mix = Math.min(0.7, dt * rate / substeps);
  for (let s = 0; s < substeps; s++) {
    for (let j = column.length - 1; j > 0; j--) {
      column[j] = column[j]! + (column[j - 1]! - column[j]!) * mix;
    }
    column[0] = Math.max(0, inflow);
  }
}

function random(seed: number): number {
  const value = Math.sin(seed * 127.1 + 311.7) * 43758.5453;
  return value - Math.floor(value);
}

function smooth(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function noise(position: number, seed: number): number {
  const cell = Math.floor(position);
  const a = random(cell + seed);
  return a + (random(cell + 1 + seed) - a) * smooth(position - cell);
}

/** 고정된 불규칙 물길을 따라 굵기가 이동합니다. 아래쪽에서는 이웃 물길이 합류합니다. */
export function runoffTrail(index: number, progress: number, time: number, count: number): { angle: number; width: number } {
  const p = Math.max(0, Math.min(1, progress));
  const step = Math.PI * 2 / count;
  const group = Math.floor(index / 5);
  const leader = group * 5 + 2;
  const seed = random(index * 3.19);
  const start = index * step;
  const develop = smooth((p - 0.1) / 0.25);
  const merge = smooth((p - 0.38) / 0.52);
  const wandering = (noise(p * 5.3, index * 13) - 0.5) * 0.36 * develop;
  const shared = (leader + (random(group + 91) - 0.5) * 1.3) * step
    + (noise(p * 3.7, group * 23 + 17) - 0.5) * 0.23;
  const angle = (start + wandering) * (1 - merge) + shared * merge;
  // 가는 가지는 중간에 끊어지거나 아래쪽의 굵은 물길에 합류합니다.
  const active = index === leader || seed > 0.68;
  const packet = noise(p * 5.5 - time / 950, index * 7 + 41);
  const breakup = Math.max(0, (packet - 0.24) / 0.76);
  const branch = index === leader ? 1 : 1 - smooth((p - 0.58) / 0.32);
  return { angle, width: active ? develop * branch * (0.45 + seed) * breakup * 1.8 : 0 };
}
