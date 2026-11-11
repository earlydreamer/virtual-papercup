import type { Tilt } from './types.ts';

/**
 * 컵 안 물의 출렁임.
 *
 * 모델: 컵을 위에서 본 원판에 격자를 깔고, 각 칸의 수면 높이 편차를
 * 스프링-댐퍼로 적분한다. 이웃 칸과의 차이가 파동으로 퍼진다.
 *
 * 왜 유체 시뮬레이션(SPH/FLIP)을 안 쓰는가:
 *  - 컵은 반경이 작고 물은 얕다. 이 규모에서 눈에 보이는 현상은
 *    "수면이 기울고, 출렁이고, 가장자리에서 넘친다" 뿐이다.
 *  - 높이장 모델은 계산이 가볍고 절대 발산하지 않게 튜닝할 수 있다.
 *  - 나중에 네이티브로 옮겨도 같은 수식이 그대로 돈다.
 */

export interface CupConfig {
  /** 격자 한 변의 칸 수. 성능과 부드러움의 타협점. */
  readonly gridSize: number;
  /** 물 채움 비율 0..1. 높을수록 넘치기 쉽다. */
  readonly fill: number;
  /** 평형으로 돌아가려는 힘. 클수록 수면이 빨리 정렬된다. */
  readonly stiffness: number;
  /** 파동 전파 강도. */
  readonly wave: number;
  /** 감쇠. 클수록 출렁임이 빨리 잦아든다. */
  readonly damping: number;
  /**
   * 넘칠 때 초당 잃는 물 비율의 계수.
   * 실제 유량은 벽 위로 솟은 높이의 1.5승에 비례하므로(토리첼리),
   * 이 값에 초과량의 1.2승을 곱해서 쓴다. 0 이면 물이 줄지 않는 연습 모드.
   */
  readonly spillRate: number;
}

export const DEFAULT_CUP: CupConfig = {
  gridSize: 24,
  fill: 0.72,
  stiffness: 90,
  wave: 45,
  damping: 7,
  spillRate: 0.35,
};

/** 한 프레임에 소화할 최대 시간. 탭 복귀 시 폭주를 막는다. */
const MAX_FRAME_MS = 50;
/** 고정 서브스텝 간격. */
const SUBSTEP_MS = 4;
/**
 * 이 아래로 떨어지면 물이 다 쏟아진 것으로 본다.
 * 물이 적으면 같은 기울기에도 넘치기 어려워지므로, 0 까지 기다리면
 * 영원히 한 방울이 남는다. 그래서 여유를 두고 종료로 처리한다.
 */
const DRAINED_LEVEL = 0.12;

export class Cup {
  readonly n: number;
  readonly cfg: CupConfig;

  /** 수면 높이 편차. 컵 반지름을 1로 정규화한 단위. */
  readonly h: Float32Array;
  /** 수직 속도. */
  readonly v: Float32Array;

  /** 원판 내부 여부 (0/1). */
  readonly inside: Uint8Array;
  /** 원판 내부이면서 이웃이 밖인 칸 = 가장자리. */
  readonly edge: Uint8Array;
  /** 정규화 좌표 -1..1 */
  readonly px: Float32Array;
  readonly py: Float32Array;

  /** 채움 비율에서 유도한 기준 수면 높이. 1 이면 컵이 가득. */
  /** 현재 물량 0..1. 넘치면 줄어든다. */
  #fill: number;

  /** 기준 수면 높이. 1 이면 컵이 가득. setFill 로 바뀐다. */
  #base: number;

  get fill(): number {
    return this.#fill;
  }

  get base(): number {
    return this.#base;
  }

  /** 물이 거의 다 쏟아졌는지. */
  get drained(): boolean {
    return this.#fill <= DRAINED_LEVEL;
  }

  /** 누적 넘침 횟수. */
  spills = 0;
  /** 이번 스텝에서 가장 크게 넘친 정도 0..1 (연출용). */
  overflowIntensity = 0;
  /** 누적 손실량 0..1 (결과 표시용). */
  spilledVolume = 0;
  /** 현재 넘치는 중인지 (히스테리시스). */
  private overflowing = false;

  constructor(cfg: Partial<CupConfig> = {}) {
    this.cfg = { ...DEFAULT_CUP, ...cfg };
    this.n = this.cfg.gridSize;
    if (this.n < 3) throw new Error('gridSize 는 3 이상이어야 한다');

    const len = this.n * this.n;
    this.h = new Float32Array(len);
    this.v = new Float32Array(len);
    this.inside = new Uint8Array(len);
    this.edge = new Uint8Array(len);
    this.px = new Float32Array(len);
    this.py = new Float32Array(len);

    this.#fill = clamp01(this.cfg.fill);
    this.#base = 2 * this.#fill - 1;

    for (let j = 0; j < this.n; j++) {
      for (let i = 0; i < this.n; i++) {
        const idx = j * this.n + i;
        const x = (i / (this.n - 1)) * 2 - 1;
        const y = (j / (this.n - 1)) * 2 - 1;
        this.px[idx] = x;
        this.py[idx] = y;
        this.inside[idx] = x * x + y * y <= 1 ? 1 : 0;
      }
    }

    // 가장자리 판정: 내부인데 4방향 이웃 중 하나라도 밖인 칸.
    for (let j = 0; j < this.n; j++) {
      for (let i = 0; i < this.n; i++) {
        const idx = j * this.n + i;
        if (!this.inside[idx]) continue;
        const up = j > 0 ? this.inside[(j - 1) * this.n + i] : 0;
        const down = j < this.n - 1 ? this.inside[(j + 1) * this.n + i] : 0;
        const left = i > 0 ? this.inside[j * this.n + (i - 1)] : 0;
        const right = i < this.n - 1 ? this.inside[j * this.n + (i + 1)] : 0;
        this.edge[idx] = up && down && left && right ? 0 : 1;
      }
    }
  }

  /** 수면 절대 높이. 1.0 이 컵 테두리 높이다. */
  levelAt(idx: number): number {
    return this.base + this.h[idx]!;
  }

  /** 맑은 상태로 되돌린다. */
  reset(): void {
    this.h.fill(0);
    this.v.fill(0);
    this.spills = 0;
    this.overflowing = false;
    this.overflowIntensity = 0;
    this.spilledVolume = 0;
    this.#fill = clamp01(this.cfg.fill);
    this.#base = 2 * this.#fill - 1;
  }

  /**
   * 물 높이를 바꾼다.
   *
   * 컵을 새로 만들지 않고 기준 수면만 옮긴다. 물을 더 붓거나 덜어낸
   * 상황이지 컵을 갈아끼운 게 아니므로, 출렁임 상태와 넘침 누적은
   * 그대로 유지되어야 한다. 재생성하면 카운터가 0 으로 돌아가면서
   * 그 구간의 넘침이 사라진다.
   */
  setFill(fill: number): void {
    this.#fill = clamp01(fill);
    this.#base = 2 * this.#fill - 1;
    // 물 높이가 바뀌면 넘침 구간의 경계도 바뀐다. 여기서 리셋하지 않으면
    // 예전에 넘치는 중이었다는 사실이 남아 새로 넘치는 순간을 놓친다.
    // 누적 횟수(spills)는 건드리지 않는다.
    this.overflowing = false;
  }

  /**
   * 한 프레임 진행.
   * @param tilt 수면 기울기 (core/attitude.ts 산출값)
   * @param dtMs 경과 시간 (ms)
   */
  step(tilt: Tilt, dtMs: number): void {
    const total = Math.min(Math.max(dtMs, 0), MAX_FRAME_MS);
    if (total <= 0) return;

    const seconds = total / 1000;

    // 컵이 뒤집히면 물이 남을 수 없다. 기울기가 아니라 각도로 판정해야
    // 하는 이유는 90도를 넘으면 수평 성분이 0 이 되어 기울기만으로는
    // "평평"과 구분되지 않기 때문이다.
    if (tilt.overturned) {
      this.overflowIntensity = 1;
      if (!this.overflowing) {
        this.overflowing = true;
        this.spills += 1;
      }
      const loss = Math.min(this.#fill, seconds * this.cfg.spillRate * 14);
      if (loss > 0) {
        this.#fill -= loss;
        this.spilledVolume += loss;
        this.#base = 2 * this.#fill - 1;
      }
      return;
    }

    const steps = Math.max(1, Math.ceil(total / SUBSTEP_MS));
    const dt = total / steps / 1000; // 초

    let maxOverflow = 0;

    for (let s = 0; s < steps; s++) {
      const o = this.#integrate(tilt, dt);
      if (o > maxOverflow) maxOverflow = o;
    }

    this.overflowIntensity = Math.min(maxOverflow, 1);
    if (maxOverflow > 0) {
      if (!this.overflowing) {
        this.overflowing = true;
        this.spills += 1;
      }

      // 넘친 만큼 물이 실제로 흘러나간다.
      // 유량은 벽 위로 솟은 높이의 1.5승에 비례한다(토리첼리). 지수를
      // 그대로 쓰면 얕게 넘칠 때는 거의 새지 않고, 크게 넘칠 때는
      // 순식간에 빠진다 — 이게 "조금 기울임"과 "확 기울임"을 가른다.
      const rate = this.cfg.spillRate * Math.pow(maxOverflow, 1.2);
      const loss = Math.min(this.#fill, rate * seconds);
      if (loss > 0) {
        this.#fill -= loss;
        this.spilledVolume += loss;
        this.#base = 2 * this.#fill - 1;
      }
    } else {
      this.overflowing = false;
    }
  }

  /** 서브스텝 하나. 넘친 정도(0..1)를 반환한다. */
  #integrate(tilt: Tilt, dt: number): number {
    const { n, h, v, inside, edge, px, py, base } = this;
    const { stiffness, wave, damping } = this.cfg;

    const k = stiffness;
    const w = wave;
    const d = damping;

    let maxOverflow = 0;

    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        if (!inside[idx]) continue;

        // 경사진 수면의 평형 높이.
        const target = tilt.x * px[idx]! + tilt.y * py[idx]!;

        // 이웃 평균과의 차이를 파동으로 쓴다. 이웃이 없으면 0 기여.
        let sum = 0;
        let cnt = 0;
        if (i > 0) {
          const o = idx - 1;
          if (inside[o]) {
            sum += h[o]!;
            cnt++;
          }
        }
        if (i < n - 1) {
          const o = idx + 1;
          if (inside[o]) {
            sum += h[o]!;
            cnt++;
          }
        }
        if (j > 0) {
          const o = idx - n;
          if (inside[o]) {
            sum += h[o]!;
            cnt++;
          }
        }
        if (j < n - 1) {
          const o = idx + n;
          if (inside[o]) {
            sum += h[o]!;
            cnt++;
          }
        }
        const lap = cnt > 0 ? sum / cnt - h[idx]! : 0;

        const accel = k * (target - h[idx]!) + w * lap - d * v[idx]!;
        let nv = v[idx]! + accel * dt;
        let nh = h[idx]! + nv * dt;

        // 벽에 부딪히면 벽면에서 반사하듯 멈춘다.
        const ceil = 1 - base;

        // 넘침 판정은 클램프보다 먼저 해야 한다. 클램프한 뒤에 재면
        // 초과분이 이미 잘려 나가서 넘침을 영원히 못 본다.
        //
        // 그리고 클램프가 걸리면 h 는 벽 근처에 붙잡혀서 매 스텝 초과분이
        // 0 에 가까워진다. 실제로는 그 상태로도 계속 흘러나가야 하므로,
        // 경사 평형(target)이 벽을 넘는지도 함께 본다. 둘 중 큰 쪽이
        // "지금 얼마나 세게 넘치는가"다.
        if (edge[idx]) {
          const overH = base + nh - 1;
          const overTarget = base + target - 1;
          const excess = Math.max(overH, overTarget);
          if (excess > 0) {
            const norm = Math.min(excess / Math.max(ceil, 1e-6), 1);
            if (norm > maxOverflow) maxOverflow = norm;
          }
        }

        if (nh > ceil) {
          nh = ceil;
          if (nv > 0) nv = 0;
        }
        // 바닥도 있다. 물은 컵 바닥 아래로 내려가지 않는다.
        const floor = -1 - base;
        if (nh < floor) {
          nh = floor;
          if (nv < 0) nv = 0;
        }

        v[idx] = nv;
        h[idx] = nh;
      }
    }

    return maxOverflow;
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
