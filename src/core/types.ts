/**
 * 공용 타입. 프레임워크 의존이 없어야 한다 — 웹·미니앱·네이티브 호스트가
 * 모두 이 모듈을 그대로 import 한다.
 */

/** 3축 벡터. 단위는 m/s². */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * 컵 평면 기준 수면 기울기.
 * 값 1.0 은 "가장자리에서 중심보다 한 컵 반지름만큼 높다"는 뜻이다.
 * 즉 무차원 tan(기울기 각).
 */
export interface Tilt {
  x: number;
  y: number;
  /** 보정된 컵 좌표의 유효 중력(m/s²). x·y는 원판 평면, z는 컵 입구 방향입니다. */
  gravity?: Vec3;
  /**
   * 컵이 거의 뒤집혀 물이 남을 수 없는 상태.
   *
   * 이걸 별도로 두는 이유: 컵을 완전히 뒤집으면 중력의 수평 성분이 0 이라
   * 기울기가 0 으로 나온다. 그런데 그건 "평평"이 아니라 "물이 전부
   * 쏟아진" 상태다. 기울기 크기만으로는 둘을 구분할 수 없다.
   */
  overturned?: boolean;
}

/** 센서 샘플 하나. t 는 밀리초 타임스탬프. */
export interface MotionSample {
  /** 중력을 포함한 가속도 (devicemotion 의 accelerationIncludingGravity) */
  readonly acc: Vec3;
  readonly t: number;
}
