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
    // перехватчик летит прямой (цель уже в точке встречи на дуге ракеты);
    // ядерка — по баллистической дуге
    const arc = m.intercept ? 0 : Math.min(dist * 0.4, 140);
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
    // цвет/размер: ядерка — жёлто-оранжевая; перехватчик — бирюзовый;
    // водородная — крупнее (×1.5), ярче, с сильным малиново-оранжевым свечением
    const hydro = m.kind === 'hydro';
    const trail = m.intercept
      ? 'rgba(90,230,255,0.6)'
      : hydro
        ? 'rgba(255,140,60,0.8)'
        : 'rgba(255,215,120,0.55)';
    const glow = m.intercept ? '#4de1ff' : hydro ? '#ff5a2a' : '#ffcf4d';
    const head = m.intercept ? '#d6fbff' : hydro ? '#ffffff' : '#fff2b0';
    // трассер 0..prog (у водородной — толще)
    const steps = 26;
    ctx.beginPath();
    for (let i = 0; i <= steps; i++) {
      const [x, y] = pos((i / steps) * m.prog);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineWidth = hydro ? 3.5 : 2;
    ctx.strokeStyle = trail;
    ctx.stroke();
    // светящаяся голова (у водородной — крупнее и с ореолом-свечением)
    const [hx, hy] = pos(Math.min(1, m.prog));
    const rad = Math.max(3, Math.min(8, z * 1.3)) * (hydro ? 1.5 : 1);
    ctx.save();
    ctx.shadowColor = glow;
    ctx.shadowBlur = hydro ? 34 : 18;
    if (hydro) {
      // мягкий ореол вокруг головы — видно, что летит гидро-бомба
      const halo = ctx.createRadialGradient(hx, hy, 0, hx, hy, rad * 3);
      halo.addColorStop(0, 'rgba(255,120,50,0.55)');
      halo.addColorStop(1, 'rgba(255,120,50,0)');
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(hx, hy, rad * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(hx, hy, rad, 0, Math.PI * 2);
    ctx.fillStyle = head;
    ctx.fill();
    ctx.restore();
  }
}
