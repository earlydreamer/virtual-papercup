import type { Vec3 } from './core/types.ts';

/**
 * devicemotion 래퍼.
 *
 * 주의: iOS 13+ 와 토스 미니앱 WebView 에서는 사용자 제스처 안에서
 * DeviceMotionEvent.requestPermission() 을 호출해야 이벤트가 온다.
 * 이걸 빼먹으면 "센서가 안 된다"처럼 보인다 — 실기기에서 가장 흔한 함정.
 */

type MotionCtor = typeof DeviceMotionEvent & {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
};

export function isMotionSupported(): boolean {
  return typeof window !== 'undefined' && 'DeviceMotionEvent' in window;
}

export async function requestMotionPermission(): Promise<boolean> {
  if (!isMotionSupported()) return false;
  const ctor = window.DeviceMotionEvent as MotionCtor;
  if (typeof ctor.requestPermission !== 'function') return true; // Android 등
  try {
    const state = await ctor.requestPermission();
    return state === 'granted';
  } catch {
    return false;
  }
}

export interface MotionSubscription {
  close(): void;
}

/**
 * 가속도 샘플을 구독한다. 값이 없는 축은 0 으로 채운다.
 * @param onSample 중력 포함 가속도 (m/s²) 와 타임스탬프
 */
export function subscribeMotion(
  onSample: (acc: Vec3, t: number) => void,
): MotionSubscription {
  const handler = (e: DeviceMotionEvent): void => {
    const a = e.accelerationIncludingGravity;
    if (!a) return;
    onSample(
      { x: a.x ?? 0, y: a.y ?? 0, z: a.z ?? 0 },
      e.timeStamp || performance.now(),
    );
  };
  window.addEventListener('devicemotion', handler);
  return {
    close: () => window.removeEventListener('devicemotion', handler),
  };
}
