import type { Tilt, Vec3 } from './types.ts';

export interface SpillFlight {
  gravity: Vec3;
  velocity: Vec3;
  detached: number;
}

/** 컵 평면 x·y와 입구 축 z를 장면 x·z와 위쪽 y로 옮깁니다. */
export function cupGravity(tilt: Tilt): Vec3 {
  if (tilt.gravity) return { x: tilt.gravity.x, y: tilt.gravity.z, z: tilt.gravity.y };
  // 방향키·개발용 입력에도 같은 중력 방향을 구성합니다.
  const normal = tilt.overturned ? 1 : -1;
  const scale = 9.81 / Math.hypot(tilt.x, tilt.y, normal);
  return { x: tilt.x * scale, y: normal * scale, z: tilt.y * scale };
}

/** 수두의 위치 에너지를 유출 속도로 바꾸고 외벽 바깥 방향의 힘으로 부착량을 줄입니다. */
export function spillFlight(tilt: Tilt, angle: number, head: number, riseSpeed: number): SpillFlight {
  const gravity = cupGravity(tilt);
  const magnitude = Math.hypot(gravity.x, gravity.y, gravity.z);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const horizontal = Math.hypot(gravity.x, gravity.z);
  const alongX = horizontal > 0.01 ? gravity.x / horizontal : cos;
  const alongZ = horizontal > 0.01 ? gravity.z / horizontal : sin;
  // 정규화한 컵 단위의 손실 계수와 상한입니다. 완전한 유체 해석은 아닙니다.
  const speed = Math.hypot(0.65 * Math.sqrt(2 * magnitude * Math.min(Math.max(head, 0), 1.5)),
    Math.min(Math.max(riseSpeed, 0), 4) * 0.35);
  const wallSlope = 0.265 / 1.96;
  const outward = (gravity.x * cos + gravity.z * sin + gravity.y * wallSlope) / Math.hypot(1, wallSlope);
  // 작은 유량의 부착력을 근사합니다. 중력과 관성이 커지면 외벽 경로에서 완전히 분리됩니다.
  const release = Math.max(0, Math.min(1, (outward + speed * speed / 4 - 1.3) / 2.2));
  return {
    gravity,
    velocity: {
      x: (cos * 0.2 + alongX * 0.8) * speed,
      y: Math.min(Math.max(riseSpeed, 0), 1) * 0.1,
      z: (sin * 0.2 + alongZ * 0.8) * speed,
    },
    detached: head > 0 ? release * release * (3 - 2 * release) : 0,
  };
}

/** 테두리 이후에는 컵 표면에 붙이지 않고 등가속도 궤적을 사용합니다. */
export function sampleSpillFlight(flight: SpillFlight, angle: number, seconds: number): Vec3 {
  const t = Math.max(0, seconds);
  return {
    x: Math.cos(angle) * 1.04 + flight.velocity.x * t + flight.gravity.x * t * t / 2,
    y: 1.025 + flight.velocity.y * t + flight.gravity.y * t * t / 2,
    z: Math.sin(angle) * 1.04 + flight.velocity.z * t + flight.gravity.z * t * t / 2,
  };
}
