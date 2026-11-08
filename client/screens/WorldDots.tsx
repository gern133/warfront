import { useEffect, useRef } from 'react';
import landUrl from 'world-atlas/land-110m.json?url';
import { playerColorCSS } from '../../shared/color';

// Фон главного экрана: карта мира точечным растром (как печать на штабной карте)
// и несколько «территорий» в цветах игроков — намёк на то, что происходит в игре.
// Рисуется один раз и при ресайзе: без анимации, чтобы меню не грузило кадры.

type Topo = {
  transform?: { scale: [number, number]; translate: [number, number] };
  arcs: number[][][];
  objects: Record<string, Geom>;
};
type Geom = { type: string; arcs?: unknown; geometries?: Geom[] };

const LAT_TOP = 84;
const LAT_BOT = -58; // Антарктиду не показываем — только место занимает
const STEP = 7; // шаг точек в CSS-пикселях
// «Территории»: центр (долгота, широта), радиус в градусах, id игрока для цвета
const TERRITORIES = [
  { lon: -98, lat: 42, r: 13, id: 3 },
  { lon: 18, lat: 50, r: 10, id: 7 },
  { lon: 104, lat: 34, r: 14, id: 12 },
  { lon: 24, lat: 2, r: 11, id: 21 },
];

// TopoJSON → массив полигонов (кольца точек [lon, lat]), без внешних библиотек
function topoToPolygons(t: Topo): [number, number][][][] {
  const arcs = t.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      if (t.transform) {
        x += dx;
        y += dy;
        return [x * t.transform.scale[0] + t.transform.translate[0], y * t.transform.scale[1] + t.transform.translate[1]] as [number, number];
      }
      return [dx, dy] as [number, number];
    });
  });
  // Кольцо + «разворот» долгот: контуры, пересекающие 180-й меридиан (Чукотка,
  // Фиджи), иначе прыгают с +180 на −180 и при заливке дают полосу через всю карту.
  // Делаем долготу непрерывной (может выйти за ±180) — при отрисовке кольцо
  // рисуется ещё и со сдвигом на ±360°, так обе половины попадают на место.
  const ring = (ids: number[]) => {
    const pts = ids.flatMap((i) => (i >= 0 ? arcs[i] : arcs[~i].slice().reverse()));
    for (let k = 1; k < pts.length; k++) {
      let lon = pts[k][0];
      while (lon - pts[k - 1][0] > 180) lon -= 360;
      while (lon - pts[k - 1][0] < -180) lon += 360;
      pts[k] = [lon, pts[k][1]];
    }
    // Контур Евразии в данных начинается на Чукотке (−180°), и после разворота
    // весь материк уезжает на −360°. Возвращаем основную массу на место, чтобы
    // она рисовалась без сдвига, а за край выходил только кончик Чукотки.
    const mid = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const fix = mid < -180 ? 360 : mid > 180 ? -360 : 0;
    return fix ? pts.map(([lon, lat]) => [lon + fix, lat] as [number, number]) : pts;
  };
  const out: [number, number][][][] = [];
  const walk = (g: Geom) => {
    if (g.type === 'Polygon') out.push((g.arcs as number[][]).map(ring));
    else if (g.type === 'MultiPolygon') for (const p of g.arcs as number[][][]) out.push(p.map(ring));
    else if (g.type === 'GeometryCollection') g.geometries?.forEach(walk);
  };
  Object.values(t.objects).forEach(walk);
  return out;
}

export function WorldDots({ className }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current!;
    let polygons: [number, number][][][] | null = null;
    let raf = 0;
    let alive = true;

    const draw = () => {
      if (!polygons || !alive) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      const ctx = canvas.getContext('2d')!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      // карта прижата вправо: слева её закрывает колонка меню
      const aspect = 360 / (LAT_TOP - LAT_BOT);
      const mapW = Math.min(cssW * 0.96, cssH * 0.92 * aspect);
      const mapH = mapW / aspect;
      const x0 = cssW - mapW - cssW * 0.02;
      const y0 = (cssH - mapH) / 2;
      const cols = Math.floor(mapW / STEP);
      const rows = Math.floor(mapH / STEP);

      // маска суши в разрешении сетки точек
      const mask = document.createElement('canvas');
      mask.width = cols;
      mask.height = rows;
      const m = mask.getContext('2d', { willReadFrequently: true })!;
      m.fillStyle = '#fff';
      const px = (lon: number) => ((lon + 180) / 360) * cols;
      const py = (lat: number) => ((LAT_TOP - lat) / (LAT_TOP - LAT_BOT)) * rows;
      for (const poly of polygons) {
        // Кольцо, обходящее полюс (Антарктида), после разворота не замкнуто по
        // долготе — его пропускаем: она и так за нижней границей карты.
        const outer = poly[0];
        if (Math.abs(outer[outer.length - 1][0] - outer[0][0]) > 180) continue;
        for (const shift of [-360, 0, 360]) {
          m.beginPath();
          for (const r of poly) {
            r.forEach(([lon, lat], i) =>
              i ? m.lineTo(px(lon + shift), py(lat)) : m.moveTo(px(lon + shift), py(lat)),
            );
            m.closePath();
          }
          m.fill('evenodd');
        }
      }
      const data = m.getImageData(0, 0, cols, rows).data;

      const land = 'rgba(185, 194, 138, 0.42)';
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          if (data[(r * cols + c) * 4 + 3] < 128) continue;
          const lon = ((c + 0.5) / cols) * 360 - 180;
          const lat = LAT_TOP - ((r + 0.5) / rows) * (LAT_TOP - LAT_BOT);
          let color = land;
          let size = 1.3;
          for (const t of TERRITORIES) {
            const dx = (lon - t.lon) * Math.cos((lat * Math.PI) / 180);
            const dy = lat - t.lat;
            if (dx * dx + dy * dy < t.r * t.r) {
              color = playerColorCSS(t.id);
              size = 1.7;
              break;
            }
          }
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(x0 + (c + 0.5) * STEP, y0 + (r + 0.5) * STEP, size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };

    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(draw);
    };

    fetch(landUrl)
      .then((r) => r.json())
      .then((t: Topo) => {
        polygons = topoToPolygons(t);
        schedule();
      })
      .catch(() => {
        /* без карты меню просто останется на тёмном фоне */
      });
    window.addEventListener('resize', schedule);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  return <canvas ref={ref} className={className} aria-hidden="true" />;
}
