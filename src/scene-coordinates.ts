import type { Tilt } from './core/types.ts';

/**
 * 센서 기준 평면의 +y(화면 위·컵의 먼 쪽)를 장면의 -z로 옮깁니다.
 * Cup 격자의 +y는 3D의 +z(카메라 쪽), 2D 게이지의 아래쪽에 대응합니다.
 * 좌우 부호와 뒤집힘 판정은 유지합니다.
 */
export function sensorTiltToScene(tilt: Tilt): Tilt {
  return { ...tilt, y: -tilt.y };
}
