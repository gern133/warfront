import cityUrl from '../icons/city.svg';
import factoryUrl from '../icons/factory.svg';
import portUrl from '../icons/port.svg';
import hqUrl from '../icons/hq.svg';
import siloUrl from '../icons/silo.svg';
import samUrl from '../icons/sam.svg';
import warshipUrl from '../icons/warship.svg';
import nukeUrl from '../icons/nuke.svg';
import hydroUrl from '../icons/hydro.svg';

// URL иконок по ключу — для HTML (тулбар, тултип) и загрузки на canvas
export const ICON_URLS: Record<string, string> = {
  city: cityUrl,
  factory: factoryUrl,
  port: portUrl,
  hq: hqUrl,
  silo: siloUrl,
  sam: samUrl,
  warship: warshipUrl,
  nuke: nukeUrl,
  hydro: hydroUrl,
};

// Тонированные спрайты для canvas: SVG грузится в <img>, перекрашивается в один
// цвет (source-in) и кэшируется по ключу|цвету|размеру. До загрузки get() вернёт
// null — иконку нарисуем позже (бейдж-подложка уже видна).
export class IconSet {
  private raw = new Map<string, HTMLImageElement>();
  private tinted = new Map<string, HTMLCanvasElement>();
  constructor(urls: Record<string, string>) {
    for (const [name, url] of Object.entries(urls)) {
      const img = new Image();
      img.src = url;
      this.raw.set(name, img);
    }
  }
  get(name: string, color: string, size = 64): HTMLCanvasElement | null {
    const key = `${name}|${color}|${size}`;
    const cached = this.tinted.get(key);
    if (cached) return cached;
    const img = this.raw.get(name);
    if (!img || !img.complete) return null; // ещё грузится
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const c = cv.getContext('2d')!;
    const pad = size * 0.06;
    const box = size - pad * 2;
    // у некоторых SVG нет intrinsic-размера (naturalWidth=0) — считаем квадратными
    const iw = img.naturalWidth || 100, ih = img.naturalHeight || 100;
    const sc = Math.min(box / iw, box / ih);
    const dw = iw * sc, dh = ih * sc;
    c.drawImage(img, (size - dw) / 2, (size - dh) / 2, dw, dh);
    c.globalCompositeOperation = 'source-in'; // красим силуэт в один цвет
    c.fillStyle = color;
    c.fillRect(0, 0, size, size);
    this.tinted.set(key, cv);
    return cv;
  }
}
