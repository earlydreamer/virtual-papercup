import { Cup } from './core/cup.ts';
import { calibrate, LowPassTilt, tiltAngleDeg, tiltFrom, GRAVITY } from './core/attitude.ts';
import type { Calibration } from './core/attitude.ts';
import type { MotionSample, Tilt } from './core/types.ts';
import { drawGauge, drawLevelDial, drawScene } from './render.ts';
import {
  isMotionSupported,
  requestMotionPermission,
  subscribeMotion,
} from './sensor.ts';
import { initAudio, playSpill, playStart, vibrate } from './audio.ts';

/** 세션 상태. 전이는 전부 사용자 조작이나 명시적 완료로만 일어난다. */
type Mode = 'idle' | 'leveling' | 'ready' | 'running' | 'stopped';

const canvas = must<HTMLCanvasElement>('#scene');
const ctx = context2d(canvas);
const gaugeCanvas = must<HTMLCanvasElement>('#gauge');
const gctx = context2d(gaugeCanvas);
const levelDial = must<HTMLCanvasElement>('#levelDial');
const lctx = context2d(levelDial);
const readyDial = must<HTMLCanvasElement>('#readyDial');
const rctx = context2d(readyDial);

const elSpills = must<HTMLElement>('#spills');
const elClock = must<HTMLElement>('#clock');
const elWater = must<HTMLElement>('#water');
const elState = must<HTMLElement>('#state');
const elFill = must<HTMLInputElement>('#fill');
const elKeepFill = must<HTMLInputElement>('#keepFill');
const elFillLabel = must<HTMLElement>('#fillLabel');
const elOverlay = must<HTMLElement>('#overlay');
const elNotice = must<HTMLElement>('#notice');
const elStability = must<HTMLElement>('#stability');
const elCountdown = must<HTMLElement>('#countdown');
const elProgress = must<HTMLElement>('#progress');
const elLevelHint = must<HTMLElement>('#levelHint');
const elReadyTilt = must<HTMLElement>('#readyTilt');
const elReadyG = must<HTMLElement>('#readyG');
const elBtnStop = must<HTMLButtonElement>('#btnStop');

const cards = {
  intro: must<HTMLElement>('#cardIntro'),
  level: must<HTMLElement>('#cardLevel'),
  ready: must<HTMLElement>('#cardReady'),
  result: must<HTMLElement>('#cardResult'),
};

const LEVEL_MS = 1500;

let cup = new Cup({ fill: fillRatio() });
let calibration: Calibration | null = null;
let mode: Mode = 'idle';
let levelStart = 0;
let levelSamples: MotionSample[] = [];
let lastSample: MotionSample | null = null;
let lastT = 0;
let flash = 0;
let reportedSpills = 0;
let smoothed: Tilt = { x: 0, y: 0 };
let runStart = 0;
let runElapsed = 0;
let maxTiltDeg = 0;
const lp = new LowPassTilt(0.22);

/** 데스크톱·권한 거부 시 마우스/터치로 기울기를 흉내낸다. */
let pointerTilt: Tilt | null = null;
let sensorReady = false;

// 합성 입력과 자동 시작은 개발 서버에서만 사용합니다.
const params = new URLSearchParams(import.meta.env.DEV ? location.search : '');
const forcedTilt: Tilt | null = import.meta.env.DEV && params.has('tx')
  ? { x: Number(params.get('tx')), y: Number(params.get('ty') ?? 0) }
  : null;
// 검증용: ?flip=1 이면 뒤집힌 상태를 강제한다.
if (import.meta.env.DEV && forcedTilt && params.has('flip')) forcedTilt.overturned = true;

function must<T extends Element>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`${sel} 를 찾을 수 없습니다`);
  return el;
}

function context2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = c.getContext('2d');
  if (!g) throw new Error('2d context 를 만들 수 없습니다');
  return g;
}

function fillRatio(): number {
  return Number(elFill.value) / 100;
}

function resize(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function sceneSize(): { w: number; h: number } {
  const rect = canvas.getBoundingClientRect();
  return { w: rect.width, h: rect.height };
}

function showCard(name: keyof typeof cards | null): void {
  for (const [k, el] of Object.entries(cards)) {
    el.hidden = k !== name;
  }
  elOverlay.classList.toggle('hidden', name === null);
  elBtnStop.hidden = name !== null;
}

function setState(text: string): void {
  elState.textContent = text;
}

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function getStability(samples: readonly MotionSample[]): number {
  if (samples.length < 5) return 0;
  const recent = samples.slice(-24);
  const n = recent.length;
  let mx = 0;
  let my = 0;
  let mz = 0;
  for (const s of recent) {
    mx += s.acc.x;
    my += s.acc.y;
    mz += s.acc.z;
  }
  mx /= n;
  my /= n;
  mz /= n;
  let sum = 0;
  for (const s of recent) {
    sum += Math.hypot(s.acc.x - mx, s.acc.y - my, s.acc.z - mz);
  }
  const sd = sum / n;
  // 0.35 m/s² 정도 흔들리면 안정도 0 으로 본다.
  return Math.max(0, Math.min(1, 1 - sd / 0.35));
}

// --- 세션 절차 ---

function beginLeveling(): void {
  initAudio();
  mode = 'leveling';
  levelStart = performance.now();
  levelSamples = [];
  lastSample = null;
  lp.reset();
  showCard('level');
  setState('기준 설정 중');
  elStability.textContent = '—';
  elCountdown.textContent = `${(LEVEL_MS / 1000).toFixed(1)}s`;
  elProgress.style.width = '0%';
  elLevelHint.textContent = sensorReady ? '측정 중…' : '센서 없이 체험 모드로 진행합니다';
}

function finishLeveling(): void {
  let cal: Calibration;
  if (levelSamples.length >= 5) {
    try {
      cal = calibrate(levelSamples);
    } catch (err) {
      elLevelHint.textContent = `기준을 잡지 못했습니다: ${String(err)}`;
      mode = 'idle';
      showCard('intro');
      return;
    }
  } else {
    // 센서가 없으면 표준 자세를 기준으로 둔다. 실기기에서는 도달하지 않는다.
    cal = calibrate([{ acc: { x: 0, y: 0, z: GRAVITY }, t: 0 }]);
  }
  calibration = cal;
  mode = 'ready';
  showCard('ready');
  setState('준비 완료');
  elReadyG.textContent = cal.gMag.toFixed(2);
  elReadyTilt.textContent = '0.0°';
  drawLevelDial(rctx, 140, 0, 1);
}

function beginRunning(): void {
  if (!calibration) return;
  cup = new Cup({ fill: fillRatio(), keepFill: elKeepFill.checked });
  lp.reset();
  flash = 0;
  mode = 'running';
  runStart = performance.now();
  runElapsed = 0;
  maxTiltDeg = 0;
  reportedSpills = 0;
  elSpills.textContent = '0';
  elClock.textContent = '0:00';
  showCard(null);
  setState('주행 중');
  playStart();
}

function stopRunning(reason: string = '종료'): void {
  if (mode !== 'running') return;
  runElapsed = performance.now() - runStart;
  mode = 'stopped';
  showCard('result');
  setState(reason);
  must<HTMLElement>('#resSpills').textContent = String(cup.spills);
  must<HTMLElement>('#resTime').textContent = fmtClock(runElapsed);
  must<HTMLElement>('#resMaxTilt').textContent = `${maxTiltDeg.toFixed(1)}°`;
  const cups = cup.spilledVolume.toLocaleString('ko-KR', { maximumFractionDigits: 2 });
  must<HTMLElement>('#resSpilled').textContent = `${cups}컵`;
}

function resetAll(): void {
  cup = new Cup({ fill: fillRatio() });
  calibration = null;
  mode = 'idle';
  smoothed = { x: 0, y: 0 };
  lp.reset();
  reportedSpills = 0;
  runElapsed = 0;
  maxTiltDeg = 0;
  flash = 0;
  elSpills.textContent = '0';
  elClock.textContent = '0:00';
  elWater.textContent = `${Math.round(cup.fill * 100)}%`;
  setState('대기');
  showCard('intro');
}

// --- 샘플 처리 ---

function tiltFromSensor(): Tilt {
  if (forcedTilt) return forcedTilt;
  if (sensorReady && calibration && lastSample) {
    return tiltFrom(calibration, lastSample);
  }
  if (pointerTilt) return pointerTilt;
  return { x: 0, y: 0 };
}

function currentDeg(): number {
  if (sensorReady && calibration && lastSample) {
    return tiltAngleDeg(calibration, lastSample);
  }
  if (pointerTilt) {
    return (Math.atan(Math.hypot(pointerTilt.x, pointerTilt.y)) * 180) / Math.PI;
  }
  return 0;
}

function onSpill(): void {
  playSpill();
  vibrate([40, 60, 40]);
  flash = 1;
}

// --- 프레임 ---

function frame(t: number): void {
  const dt = lastT === 0 ? 16.7 : Math.min(t - lastT, 50);
  lastT = t;

  if (mode === 'leveling') {
    const elapsed = t - levelStart;
    const p = Math.min(elapsed / LEVEL_MS, 1);
    elProgress.style.width = `${p * 100}%`;
    elCountdown.textContent = `${Math.max(0, (LEVEL_MS - elapsed) / 1000).toFixed(1)}s`;

    const stab = sensorReady ? getStability(levelSamples) : 1;
    elStability.textContent = `${Math.round(stab * 100)}%`;
    drawLevelDial(lctx, 140, currentDeg(), stab);

    if (sensorReady) {
      elLevelHint.textContent =
        stab > 0.8 ? '좋습니다. 그대로 유지하세요' : '차가 흔들리고 있습니다. 정지 상태를 유지하세요';
    }

    if (elapsed >= LEVEL_MS) finishLeveling();
    smoothed = lp.push({ x: 0, y: 0 });
  } else if (mode === 'ready') {
    const deg = currentDeg();
    elReadyTilt.textContent = `${deg.toFixed(1)}°`;
    drawLevelDial(rctx, 140, deg, sensorReady ? getStability(levelSamples) : 1);
    smoothed = lp.push({ x: 0, y: 0 });
  } else if (mode === 'running') {
    smoothed = lp.push(tiltFromSensor());
    runElapsed = t - runStart;
    elClock.textContent = fmtClock(runElapsed);
    // 뒤집힘은 기울기 수치가 0 으로 나오므로 각도 표시를 따로 둔다.
    const deg = smoothed.overturned
      ? 90
      : (Math.atan(Math.hypot(smoothed.x, smoothed.y)) * 180) / Math.PI;
    if (deg > maxTiltDeg) maxTiltDeg = deg;
  } else {    smoothed = lp.push({ x: 0, y: 0 });
  }

  cup.step(smoothed, dt);

  elWater.textContent = `${Math.round(cup.fill * 100)}%`;

  if (cup.spills > reportedSpills) {
    reportedSpills = cup.spills;
    elSpills.textContent = String(cup.spills);
    if (mode === 'running') onSpill();
  }

  // 물을 다 쏟으면 주행을 끝낸다.
  if (mode === 'running' && cup.drained) {
    stopRunning('물을 다 쏟았습니다');
  }

  if (flash > 0) flash = Math.max(0, flash - dt / 420);

  const { w, h } = sceneSize();
  drawScene({ ctx, w, h, cup, tilt: smoothed, flash, running: mode === 'running', now: t });

  if (mode === 'running') {
    gaugeCanvas.style.opacity = '1';
    const gs = gaugeCanvas.getBoundingClientRect();
    gctx.clearRect(0, 0, gs.width, gs.height);
    drawGauge(gctx, gs.width / 2, gs.height / 2, Math.min(gs.width, gs.height) / 2 - 6, smoothed);
  } else {
    gaugeCanvas.style.opacity = '0';
  }

  requestAnimationFrame(frame);
}

// --- 입력 ---

function updatePointerTilt(e: PointerEvent): void {
  if (sensorReady) return;
  const rect = canvas.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  pointerTilt = {
    x: ((e.clientX - cx) / rect.width) * 2.2,
    y: ((e.clientY - cy) / rect.height) * 2.2,
  };
}

canvas.addEventListener('pointermove', (e) => {
  if (mode !== 'running') return;
  updatePointerTilt(e);
});
canvas.addEventListener('pointerleave', () => {
  if (!sensorReady) pointerTilt = null;
});

window.addEventListener('keydown', (e) => {
  if (mode !== 'running' || sensorReady) return;
  const step = 0.12;
  const cur = pointerTilt ?? { x: 0, y: 0 };
  if (e.key === 'ArrowLeft') pointerTilt = { x: cur.x - step, y: cur.y };
  else if (e.key === 'ArrowRight') pointerTilt = { x: cur.x + step, y: cur.y };
  else if (e.key === 'ArrowUp') pointerTilt = { x: cur.x, y: cur.y - step };
  else if (e.key === 'ArrowDown') pointerTilt = { x: cur.x, y: cur.y + step };
  else if (e.key === ' ') pointerTilt = { x: 0, y: 0 };
});

// 센서는 시작 전부터 구독해야 기준 설정에서 샘플을 모을 수 있다.
if (isMotionSupported()) {
  subscribeMotion((acc, t) => {
    lastSample = { acc, t };
    if (mode === 'leveling' && levelSamples.length < 400) {
      levelSamples.push({ acc, t });
    }
  });
}

// --- 버튼 ---

must<HTMLButtonElement>('#btnLevel').addEventListener('click', () => {
  void (async () => {
    initAudio();
    if (isMotionSupported() && !sensorReady) {
      sensorReady = await requestMotionPermission();
      if (!sensorReady) {
        elNotice.textContent = '센서 권한이 없어 마우스·방향키 체험 모드로 진행합니다';
      }
    }
    beginLeveling();
  })();
});

must<HTMLButtonElement>('#btnStart').addEventListener('click', () => {
  beginRunning();
});
must<HTMLButtonElement>('#btnRelevel').addEventListener('click', () => {
  beginLeveling();
});
must<HTMLButtonElement>('#btnRelevel2').addEventListener('click', () => {
  beginLeveling();
});
must<HTMLButtonElement>('#btnAgain').addEventListener('click', () => {
  beginRunning();
});
must<HTMLButtonElement>('#btnReset').addEventListener('click', () => {
  resetAll();
});
elBtnStop.addEventListener('click', () => {
  stopRunning();
});

elFill.addEventListener('input', () => {
  // 컵을 새로 만들지 않는다. 재생성하면 넘침 카운터가 0 으로 돌아가
  // UI 기준선(reportedSpills)과 어긋나면서 넘침이 조용히 묻힌다.
  cup.setFill(fillRatio());
  elFillLabel.textContent = `${Math.round(Number(elFill.value))}%`;
  elWater.textContent = `${Math.round(cup.fill * 100)}%`;
  elSpills.textContent = String(cup.spills);
});

window.addEventListener('resize', resize);

resize();
elFillLabel.textContent = `${Math.round(Number(elFill.value))}%`;
setState('대기');
showCard('intro');
requestAnimationFrame(frame);

// --- 검증용 경로 (헤드리스 확인용, 실제 흐름에는 영향 없음) ---

if (import.meta.env.DEV && params.has('card')) {
  const c = params.get('card');
  if (c === 'level' || c === 'ready' || c === 'result' || c === 'intro') {
    showCard(c);
    if (c === 'level') {
      elProgress.style.width = '62%';
      elStability.textContent = '94%';
      elCountdown.textContent = '0.6s';
      drawLevelDial(lctx, 140, 3.4, 0.94);
    } else if (c === 'ready') {
      drawLevelDial(rctx, 140, 0.6, 0.97);
      elReadyTilt.textContent = '0.6°';
      elReadyG.textContent = '9.81';
    } else if (c === 'result') {
      must<HTMLElement>('#resSpills').textContent = '3';
      must<HTMLElement>('#resTime').textContent = '12:40';
      must<HTMLElement>('#resMaxTilt').textContent = '18.4°';
    }
  }
}

if (import.meta.env.DEV && params.has('auto')) {
  calibration = calibrate([{ acc: { x: 0, y: 0, z: GRAVITY }, t: 0 }]);
  mode = 'running';
  runStart = performance.now();
  showCard(null);
  setState('주행 중');

  if (params.has('warm')) {
    const steps = Number(params.get('warm') || 180);
    const t = forcedTilt ?? { x: 0, y: 0 };
    smoothed = t;
    for (let k = 0; k < steps; k++) cup.step(t, 16.7);
    reportedSpills = cup.spills;
    elSpills.textContent = String(cup.spills);
    flash = cup.overflowIntensity > 0 ? 1 : 0;
  }
}
