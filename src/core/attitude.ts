import type { MotionSample, Tilt, Vec3 } from './types.ts';

/**
 * 자세 보정 — 폰 장착 각도를 흡수해서 "컵 좌표계" 기울기를 뽑는다.
 *
 * ## 문제
 * 폰은 대시보드에 비스듬히 거치되고, 종이컵은 컵홀더에 (차체 기준으로) 서 있다.
 * 둘의 각도는 다르다. 가속도계는 폰 좌표계로 값을 주므로, 폰의 x/y 를 그대로
 * 컵 평면으로 쓰면 축이 틀어지고 수직 성분까지 오염된다. 폰을 45도 눕혀
 * 거치한 상태에서 급가속하면 기울기가 실제보다 과장된다.
 *
 * ## 해법
 * 출발 시점에 차가 정지해 있으면 물은 편평하다. 즉 그 순간의 유효 중력
 * 방향이 곧 "컵의 아래"다. 이 방향을 기준으로 잡고, 그 축에 수직인 평면의
 * 직교 기저 두 개를 만든다. 폰이 얼마나 기울어 거치됐든 이 기저는
 * 시작 시점의 컵 평면이 되고, 이후 가속도는 이 기저에 투영해 분해한다.
 *
 * ## 남는 한계
 * 중력 벡터는 회전 2자유도만 알려준다. 폰이 차체 전후축에 대해 돌아가
 * 거치됐다면(옆으로 눕혀 거치 등) 나머지 1자유도(요)는 알 수 없다.
 * 그래서 "폰 화면의 세로가 차의 앞쪽"이라는 가정을 둔다. 이 가정을
 * 뒤집으려면 사용자에게 방향을 묻거나 자기장 센서가 필요하다.
 */

export const GRAVITY = 9.80665;

/** 폰 좌표계의 화면 오른쪽 축. */
const SCREEN_X: Vec3 = { x: 1, y: 0, z: 0 };
/** 폰 좌표계의 화면 위쪽 축. */
const SCREEN_Y: Vec3 = { x: 0, y: 1, z: 0 };

/** 캘리브레이션 결과. 모두 폰 좌표계의 단위 벡터다. */
export interface Calibration {
  /** 컵의 아래 → 위 방향 (정지 시 가속도계가 읽는 방향). */
  readonly up: Vec3;
  /** 컵 평면의 오른쪽 축. */
  readonly ex: Vec3;
  /** 컵 평면의 앞쪽 축. */
  readonly ey: Vec3;
  /** 기준 상태의 중력 크기. 기울기 정규화에 쓴다. */
  readonly gMag: number;
}

/**
 * 정지 상태 샘플로 기준 자세를 만든다.
 * @throws 샘플이 비었거나 중력 크기가 비정상이면
 */
export function calibrate(samples: readonly MotionSample[]): Calibration {
  if (samples.length === 0) {
    throw new Error('캘리브레이션 샘플이 없습니다');
  }

  let ax = 0;
  let ay = 0;
  let az = 0;
  for (const s of samples) {
    ax += s.acc.x;
    ay += s.acc.y;
    az += s.acc.z;
  }
  const n = samples.length;
  const a0: Vec3 = { x: ax / n, y: ay / n, z: az / n };

  const gMag = length(a0);
  if (!Number.isFinite(gMag) || gMag < 1) {
    throw new Error(`중력 크기가 비정상입니다 (${gMag.toFixed(2)})`);
  }

  const up = scale(a0, 1 / gMag);

  // 화면 x 축을 중력 축에 직교화한다.
  let ex = rejectFrom(SCREEN_X, up);
  if (length(ex) < 1e-6) {
    // 화면이 중력과 나란하면(폰을 세로로 세운 경우) 화면 y 축을 대신 쓴다.
    ex = rejectFrom(SCREEN_Y, up);
  }
  if (length(ex) < 1e-6) {
    throw new Error('폰 자세가 너무 수직이라 기준 평면을 만들 수 없습니다');
  }
  ex = normalize(ex);
  const ey = normalize(cross(up, ex));

  return { up, ex, ey, gMag };
}

/**
 * 측정 샘플을 컵 평면 기울기로 변환한다.
 *
 * 유효 중력은 측정값의 음수다 (가속도계는 proper acceleration 을 읽는다).
 * 수면은 유효 중력에 수직이므로, 수평 성분 / 수직 성분이 기울기다.
 *
 * 여기에 더해 컵이 뒤집혔는지를 따로 판정한다. 뒤집히면 중력이 컵의
 * 입구 쪽으로 작용해 물이 남을 수 없다. 그런데 그 상태에서는 중력의
 * 수평 성분이 0 이라 기울기 값만 보면 "평평"과 구분되지 않는다.
 * 그래서 유효 중력과 컵 축의 내적(cosTilt) 부호를 본다.
 */
export function tiltFrom(cal: Calibration, sample: MotionSample): Tilt {
  const g: Vec3 = { x: -sample.acc.x, y: -sample.acc.y, z: -sample.acc.z };

  const sx = dot(g, cal.ex);
  const sy = dot(g, cal.ey);
  const sn = dot(g, cal.up);
  const gLen = Math.hypot(g.x, g.y, g.z);

  // cosTilt 1 = 컵이 똑바로, 0 = 옆으로 누움, -1 = 완전히 뒤집힘.
  //
  // 부호 주의: g_eff 는 중력 방향(아래)이고 cal.up 은 컵의 위쪽이다.
  // 똑바로 선 상태에서는 둘이 반대라 내적이 음수다. 그래서 부호를
  // 뒤집어야 "똑바로 = 1" 이 된다.
  // 약 83도 이상 기울면 물이 입구로 쏟아져 남지 않는다.
  const cosTilt = gLen > 1e-6 ? -sn / gLen : 1;
  const overturned = cosTilt < OVERTURN_COS;

  // 수직 성분이 작으면 나눗셈이 폭발한다. 다만 하한을 낮게 잡아야
  // 90도 근처에서 기울기가 실제로 커진다 (그래야 빠르게 쏟아진다).
  const denom = Math.max(Math.abs(sn), cal.gMag * 0.15);

  const tilt: Tilt = { x: sx / denom, y: sy / denom };
  if (overturned) tilt.overturned = true;
  return tilt;
}

/** 이보다 코사인이 작으면 뒤집힌 것으로 본다 (약 83도). */
const OVERTURN_COS = 0.12;

/** 기준 대비 폰이 얼마나 기울어졌는가 (도). UI 수평계에 쓴다. */
export function tiltAngleDeg(cal: Calibration, sample: MotionSample): number {
  const t = tiltFrom(cal, sample);
  return (Math.atan(Math.hypot(t.x, t.y)) * 180) / Math.PI;
}

/**
 * 저역통과 필터. 센서 노이즈로 물이 파르르 떠는 것을 막는다.
 * alpha 가 작을수록 부드럽다 (0..1).
 */
export class LowPassTilt {
  #x = 0;
  #y = 0;
  #primed = false;
  readonly #alpha: number;

  constructor(alpha: number = 0.25) {
    this.#alpha = alpha;
  }

  push(tilt: Tilt): Tilt {
    // 뒤집힘은 순간 사건이라 필터를 태우면 안 된다. 그대로 통과시킨다.
    if (tilt.overturned) {
      this.#primed = false;
      return { x: 0, y: 0, overturned: true };
    }
    if (!this.#primed) {
      this.#x = tilt.x;
      this.#y = tilt.y;
      this.#primed = true;
      return { x: this.#x, y: this.#y };
    }
    this.#x += (tilt.x - this.#x) * this.#alpha;
    this.#y += (tilt.y - this.#y) * this.#alpha;
    return { x: this.#x, y: this.#y };
  }

  reset(): void {
    this.#primed = false;
    this.#x = 0;
    this.#y = 0;
  }
}

export function tiltMagnitude(t: Tilt): number {
  return Math.hypot(t.x, t.y);
}

// --- 벡터 유틸 ---

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

function scale(v: Vec3, k: number): Vec3 {
  return { x: v.x * k, y: v.y * k, z: v.z * k };
}

function normalize(v: Vec3): Vec3 {
  const l = length(v);
  if (l === 0) return { x: 0, y: 0, z: 0 };
  return scale(v, 1 / l);
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

/** v 에서 unit 방향 성분을 제거한 벡터 (v - (v·u)u). */
export function rejectFrom(v: Vec3, unit: Vec3): Vec3 {
  const k = dot(v, unit);
  return { x: v.x - unit.x * k, y: v.y - unit.y * k, z: v.z - unit.z * k };
}
