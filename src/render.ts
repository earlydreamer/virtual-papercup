import type { Cup } from './core/cup.ts';
import type { Tilt } from './core/types.ts';

/**
 * 컵 장면 렌더링. 정면 단면 뷰.
 *
 * 왜 위에서 본 원판이 아니라 측면인가:
 *  - 사람이 "넘친다"를 읽는 건 테두리 위로 물이 솟는 순간이다.
 *  - 이니셜 D 장면도 옆에서 본 컵이다.
 *  - 2D 격자의 좌우 단면(y 평균)만 쓰므로 그리기가 가볍다.
 */

export interface SceneOptions {
  readonly ctx: CanvasRenderingContext2D;
  readonly w: number;
  readonly h: number;
  readonly cup: Cup;
  readonly tilt: Tilt;
  /** 넘친 직후 1 → 0 으로 감소하는 플래시 강도. */
  readonly flash: number;
  readonly running: boolean;
  /** 애니메이션 시간 (ms). 거품·물방울 위상에 쓴다. */
  readonly now: number;
}

/** 컵 내부 좌우 단면 프로파일 (컬럼별 높이 편차). 1회 평활. */
function profile(cup: Cup): Float32Array {
  const n = cup.n;
  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let cnt = 0;
    for (let j = 0; j < n; j++) {
      const idx = j * n + i;
      if (cup.inside[idx]) {
        sum += cup.h[idx]!;
        cnt++;
      }
    }
    raw[i] = cnt > 0 ? sum / cnt : 0;
  }

  // 이웃 평균으로 한 번 다듬어 계단 현상을 줄인다.
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = raw[Math.max(i - 1, 0)]!;
    const b = raw[i]!;
    const c = raw[Math.min(i + 1, n - 1)]!;
    out[i] = (a + b * 2 + c) / 4;
  }
  return out;
}

export function drawScene(o: SceneOptions): void {
  const { ctx, w, h, cup, flash, now } = o;

  ctx.clearRect(0, 0, w, h);

  // 배경: 위에서 내려오는 은은한 조명.
  ctx.fillStyle = '#07080b';
  ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(w / 2, h * 0.16, 0, w / 2, h * 0.16, h * 0.72);
  glow.addColorStop(0, 'rgba(74, 108, 148, 0.22)');
  glow.addColorStop(0.55, 'rgba(30, 42, 58, 0.10)');
  glow.addColorStop(1, 'rgba(7, 8, 11, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);

  if (flash > 0.001) {
    ctx.fillStyle = `rgba(255, 72, 72, ${0.16 * flash})`;
    ctx.fillRect(0, 0, w, h);
  }

  const cx = w / 2;
  const cupH = h * 0.56;
  const topY = h * 0.2;
  const botY = topY + cupH;
  const wTop = w * 0.26;
  const wBot = w * 0.185;
  const rimH = wTop * 0.16;

  const halfWidthAt = (y: number): number => {
    const t = Math.min(Math.max((botY - y) / (botY - topY), 0), 1);
    return wBot + (wTop - wBot) * t;
  };

  const waterYAt = (level: number): number => botY - ((level + 1) / 2) * cupH;

  const outline = new Path2D();
  outline.moveTo(cx - wTop, topY);
  outline.lineTo(cx + wTop, topY);
  outline.lineTo(cx + wBot, botY);
  outline.lineTo(cx - wBot, botY);
  outline.closePath();

  // 받침 그림자 (바닥에 닿는 느낌).
  ctx.save();
  const shadow = ctx.createRadialGradient(cx, botY + 4, 0, cx, botY + 4, wBot * 1.5);
  shadow.addColorStop(0, 'rgba(0,0,0,0.72)');
  shadow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.ellipse(cx, botY + 4, wBot * 1.5, wBot * 0.34, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.clip(outline);

  // 종이 몸통: 왼쪽은 그늘, 중앙은 밝게.
  const body = ctx.createLinearGradient(cx - wTop, 0, cx + wTop, 0);
  body.addColorStop(0, 'rgba(180, 175, 164, 0.26)');
  body.addColorStop(0.18, 'rgba(240, 236, 226, 0.16)');
  body.addColorStop(0.42, 'rgba(255, 253, 247, 0.10)');
  body.addColorStop(0.72, 'rgba(214, 208, 196, 0.15)');
  body.addColorStop(1, 'rgba(150, 145, 134, 0.28)');
  ctx.fillStyle = body;
  ctx.fillRect(cx - wTop, topY, wTop * 2, cupH);

  // 물.
  const prof = profile(cup);
  const n = cup.n;
  const waterPath = new Path2D();
  let started = false;
  let maxLevel = -Infinity;

  const surface: Array<{ x: number; y: number }> = [];

  for (let i = 0; i < n; i++) {
    const level = cup.base + prof[i]!;
    if (level > maxLevel) maxLevel = level;
    const y = waterYAt(level);
    const half = halfWidthAt(y);
    const x = cx + ((i / (n - 1)) * 2 - 1) * half;
    surface.push({ x, y });
    if (!started) {
      waterPath.moveTo(x, y);
      started = true;
    } else {
      waterPath.lineTo(x, y);
    }
  }

  if (started) {
    waterPath.lineTo(cx + wBot, botY);
    waterPath.lineTo(cx - wBot, botY);
    waterPath.closePath();

    const water = ctx.createLinearGradient(0, waterYAt(maxLevel), 0, botY);
    water.addColorStop(0, 'rgba(122, 214, 255, 0.95)');
    water.addColorStop(0.28, 'rgba(72, 172, 232, 0.94)');
    water.addColorStop(0.72, 'rgba(34, 112, 176, 0.95)');
    water.addColorStop(1, 'rgba(18, 68, 118, 0.96)');
    ctx.fillStyle = water;
    ctx.fill(waterPath);

    // 수면 바로 아래의 밝은 띠.
    ctx.save();
    ctx.clip(waterPath);
    const sheen = ctx.createLinearGradient(0, waterYAt(maxLevel), 0, waterYAt(maxLevel) + cupH * 0.1);
    sheen.addColorStop(0, 'rgba(230, 250, 255, 0.34)');
    sheen.addColorStop(1, 'rgba(230, 250, 255, 0)');
    ctx.fillStyle = sheen;
    const top = waterYAt(maxLevel);
    ctx.fillRect(cx - wTop, top, wTop * 2, cupH * 0.12);

    // 거품 몇 점. 위치는 컬럼 인덱스에 묶어 결정적으로 만든다.
    for (let i = 0; i < surface.length; i++) {
      if (i % 5 !== 0) continue;
      const p = surface[i]!;
      const wob = Math.sin(now / 620 + i) * 1.8;
      const r = 1.1 + ((i * 7) % 3) * 0.6;
      ctx.fillStyle = 'rgba(232, 250, 255, 0.5)';
      ctx.beginPath();
      ctx.arc(p.x + wob, p.y + 3.5, r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // 수면 선.
    ctx.save();
    ctx.strokeStyle = 'rgba(225, 248, 255, 0.8)';
    ctx.lineWidth = 1.6;
    ctx.stroke(waterPath);
    ctx.restore();
  }

  // 종이 접힘선.
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.055)';
  ctx.lineWidth = 1;
  for (const f of [-0.62, -0.22, 0.22, 0.62]) {
    ctx.beginPath();
    ctx.moveTo(cx + f * wTop, topY);
    ctx.lineTo(cx + f * wBot, botY);
    ctx.stroke();
  }
  ctx.restore();

  ctx.restore(); // clip 해제

  // 몸통 외곽선.
  ctx.save();
  ctx.strokeStyle = 'rgba(255, 253, 247, 0.5)';
  ctx.lineWidth = 1.8;
  ctx.stroke(outline);
  ctx.restore();

  // 윗 테두리: 안쪽 면과 바깥 면을 나눠 두께를 준다.
  ctx.save();
  ctx.beginPath();
  ctx.ellipse(cx, topY, wTop, rimH, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 253, 247, 0.06)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255, 253, 247, 0.78)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.beginPath();
  ctx.ellipse(cx, topY, wTop - 3, rimH - 1, 0, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 253, 247, 0.22)';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.restore();

  // 넘침 연출.
  if (maxLevel > 1) {
    const overshoot = Math.min(maxLevel - 1, 1);
    drawSpill(o, cx, topY, wTop, overshoot);
  }

  // 대기 중에는 기준선을 보여준다.
  if (!o.running) {
    const baseY = waterYAt(cup.base);
    ctx.save();
    ctx.setLineDash([7, 7]);
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, baseY);
    ctx.lineTo(w, baseY);
    ctx.stroke();
    ctx.restore();
  }
}

function drawSpill(
  o: SceneOptions,
  cx: number,
  topY: number,
  wTop: number,
  amount: number,
): void {
  const { ctx, w, now } = o;
  // 수면이 높은 쪽에서 넘친다. tilt.x > 0 이면 +x(오른쪽)가 높다.
  const dir = o.tilt.x >= 0 ? 1 : -1;
  const edgeX = cx + dir * wTop;

  ctx.save();
  // 테두리를 타고 흐르는 자국.
  ctx.strokeStyle = `rgba(140, 220, 255, ${0.22 + 0.3 * amount})`;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(edgeX - dir * 2, topY + 1);
  ctx.quadraticCurveTo(edgeX + dir * 7, topY + 12 * amount, edgeX + dir * 5, topY + 26 * amount);
  ctx.stroke();

  // 떨어지는 물방울.
  ctx.fillStyle = 'rgba(140, 220, 255, 0.9)';
  for (let i = 0; i < 4; i++) {
    const phase = ((now / 430 + i * 0.27) % 1 + 1) % 1;
    const y = topY + 6 + phase * (20 + 52 * amount);
    const x = edgeX + dir * (5 + phase * 13);
    const r = 1.9 + (1 - phase) * 2.6 * amount;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 1.4, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 경고 프레임.
  ctx.save();
  ctx.strokeStyle = `rgba(255, 96, 96, ${0.35 + 0.35 * amount})`;
  ctx.lineWidth = Math.max(1.5, w * 0.007 * amount);
  ctx.strokeRect(w * 0.004, 0.004 * w, w - w * 0.008, o.h - 0.008 * w);
  ctx.restore();
}

/** 현재 기울기 게이지 (원 + 점). */
export function drawGauge(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  tilt: Tilt,
): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();

  const mag = Math.hypot(tilt.x, tilt.y);
  const clamped = Math.min(mag, 1);
  const px = mag > 1e-6 ? (tilt.x / mag) * clamped : 0;
  const py = mag > 1e-6 ? (tilt.y / mag) * clamped : 0;

  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath();
  ctx.moveTo(x - r, y);
  ctx.lineTo(x + r, y);
  ctx.moveTo(x, y - r);
  ctx.lineTo(x, y + r);
  ctx.stroke();

  ctx.fillStyle = clamped > 0.7 ? '#ff6b6b' : clamped > 0.4 ? '#ffd166' : '#6fd8ff';
  ctx.beginPath();
  ctx.arc(x + px * r, y + py * r, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/**
 * 기준 설정용 수평계. 현재 각도와 안정도를 크게 보여준다.
 * @param deg 기울기 각도
 * @param stable 0..1 (1 이면 매우 안정)
 */
export function drawLevelDial(
  ctx: CanvasRenderingContext2D,
  size: number,
  deg: number,
  stable: number,
): void {
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 10;

  ctx.clearRect(0, 0, size, size);

  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // 중심 십자.
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx, cy + r);
  ctx.stroke();

  // 안정도 링.
  ctx.strokeStyle = stable > 0.8 ? 'rgba(111,216,255,0.85)' : 'rgba(255,209,102,0.8)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * stable);
  ctx.stroke();

  ctx.fillStyle = 'rgba(238,242,247,0.92)';
  ctx.font = `600 ${Math.round(size * 0.19)}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${deg.toFixed(1)}°`, cx, cy + 2);
  ctx.restore();
}
