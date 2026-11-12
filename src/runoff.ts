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
