import { NUKES } from '../../../shared/protocol';
import { playerColorCSS } from '../../../shared/color';
import type { GameClient } from '../GameClient';

// Трейд-корабли: кружки без следа (для производительности)
export function drawShips(gc: GameClient, ctx: CanvasRenderingContext2D, dpr: number) {
  if (!gc.ships.length) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rad = Math.max(2.5, Math.min(6, gc.zoom * 0.9));
  ctx.lineWidth = 1.5;
  for (const s of gc.ships) {
    const sx = gc.panX + s.x * gc.zoom;
    const sy = gc.panY + s.y * gc.zoom;
    if (sx < -20 || sy < -20 || sx > vw + 20 || sy > vh + 20) continue;
    ctx.beginPath();
    ctx.arc(sx, sy, rad, 0, Math.PI * 2);
    ctx.fillStyle = playerColorCSS(s.owner);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.stroke();
  }
}

// Ракеты: баллистическая дуга, трассер за головой, светящийся кружок, кольцо
// радиуса поражения в цели
export function drawMissiles(gc: GameClient, ctx: CanvasRenderingContext2D, dpr: number) {
  if (!gc.missiles.length) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const px = gc.panX;
  const py = gc.panY;
  const z = gc.zoom;
  for (const m of gc.missiles) {
    const dist = Math.hypot(m.tx - m.sx, m.ty - m.sy);
    const arc = Math.min(dist * 0.4, 140); // высота дуги в клетках
    const pos = (t: number): [number, number] => {
      const gx = m.sx + (m.tx - m.sx) * t;
      const gy = m.sy + (m.ty - m.sy) * t;
      const lift = arc * Math.sin(Math.PI * t);
      return [px + gx * z, py + gy * z - lift * z];
    };
    // кольцо радиуса поражения в цели
    const spec = NUKES[m.kind];
    if (spec) {
      const [tx, ty] = pos(1);
      ctx.beginPath();
      ctx.arc(tx, ty, spec.radius * z, 0, Math.PI * 2);
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255,80,40,0.5)';
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // трассер 0..prog
    const steps = 26;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const [x, y] = pos((i / steps) * m.prog);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(255,215,120,0.55)';
    ctx.stroke();
    // светящаяся голова
    const [hx, hy] = pos(Math.min(1, m.prog));
    const rad = Math.max(3, Math.min(8, z * 1.3));
    ctx.save();
    ctx.shadowColor = '#ffcf4d';
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.arc(hx, hy, rad, 0, Math.PI * 2);
    ctx.fillStyle = '#fff2b0';
    ctx.fill();
    ctx.restore();
  }
}
