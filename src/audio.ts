/**
 * 넘침 알림음.
 *
 * 운전 중에는 화면을 보면 안 되므로 소리가 1차 피드백이다.
 * 사용자 제스처에서 AudioContext 를 깨워야 모바일에서 소리가 난다.
 */

let ctx: AudioContext | null = null;

export function initAudio(): void {
  if (ctx) return;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  ctx = new Ctor();
}

/** 두 번 삑. 넘칠 때. */
export function playSpill(): void {
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();
  const now = ctx.currentTime;
  beep(now, 880, 0.09, 0.25);
  beep(now + 0.13, 660, 0.12, 0.25);
}

/** 한 번 낮게. 세션 시작. */
export function playStart(): void {
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();
  beep(ctx.currentTime, 523.25, 0.12, 0.18);
}

function beep(at: number, freq: number, dur: number, gain: number): void {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.value = freq;
  // 딸깍 소리를 막기 위한 짧은 어택/릴리스.
  amp.gain.setValueAtTime(0, at);
  amp.gain.linearRampToValueAtTime(gain, at + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(amp).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

export function vibrate(ms: number | number[]): void {
  if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
    navigator.vibrate(ms);
  }
}
