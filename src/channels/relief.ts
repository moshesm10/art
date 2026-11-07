import type { ReliefPlace } from '../config';
import { MOUNTAINS } from '../data/mountains';
import { fmtInt } from '../lib/format';
import { tr } from '../lib/i18n';
import { Feed, poll } from '../lib/net';
import { ART, waiting, type Encoding, type Frame, type Label, type Poster, type Tip } from '../lib/poster';
import { clamp, famous, glide } from '../lib/stats';

const TILE = 256;
const SPAN_TILES = 2;
const GRID_W = 168;
const GRID_H = 200;
const SHADE_W = 112;
const SHADE_H = 134;
const SHADE_STEPS = 32;
const SHADE_SOFT = 0.08;
const AHEAD = 3;
const COUNT = 45_000;
const VIEW_ANGLE = 60;
const BEAM = 0.85;
const SWEEP_MS = 26_000;
const TURN = 0.9;
const AMBIENT = 0.06;
const SOFTNESS = 14;
const LEVELS = 4;
const REVEAL_SEC = 1.6;
const POLL_MS = 6 * 3_600_000;
const PHI = 1.32471795724474602596;

const PAPER = '#08080a';
const LIGHT = '#f2f1ea';

// Плитка хранит высоту в цвете пикселя
export const elevation = (r: number, g: number, b: number) => r * 256 + g + b / 256 - 32768;

export function tileOf(lat: number, lon: number, zoom: number): { x: number; y: number } {
  const n = 2 ** zoom;
  const rad = (lat * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  };
}

// Последовательность R2: любые первые N точек ровно покрывают лист, поэтому яркость — это просто доля показанных точек
export function r2(n: number): { u: number; v: number } {
  return { u: (0.5 + n / PHI) % 1, v: (0.5 + n / PHI ** 2) % 1 };
}

export interface Terrain {
  heights: Float32Array;
  w: number;
  h: number;
  lo: number;
  hi: number;
}

export function terrain(pixels: Uint8ClampedArray, size: number): Terrain {
  const cropW = Math.round((size * ART.w) / ART.h);
  const left = (size - cropW) / 2;
  const heights = new Float32Array(GRID_W * GRID_H);
  let [lo, hi] = [Infinity, -Infinity];
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const px = Math.floor(left + (x / GRID_W) * cropW);
      const py = Math.floor((y / GRID_H) * size);
      const i = (py * size + px) * 4;
      // Дно моря не участвует: вода остаётся ровной темнотой
      const height = Math.max(0, elevation(pixels[i], pixels[i + 1], pixels[i + 2]));
      heights[y * GRID_W + x] = height;
      lo = Math.min(lo, height);
      hi = Math.max(hi, height);
    }
  }
  return { heights, w: GRID_W, h: GRID_H, lo, hi };
}

export interface Scene {
  count: number;
  x: Float32Array;
  y: Float32Array;
  u: Float32Array;
  nx: Float32Array;
  ny: Float32Array;
  nz: Float32Array;
  rank: Float32Array;
  height: Float32Array;
  cell: Int32Array;
}

export type Project = (u: number, v: number, height: number) => { x: number; y: number };

// Настоящий вид с воздуха под углом: высота и расстояния в одном масштабе
export function oblique(t: Terrain, widthKm: number, degrees: number): Project {
  const angle = (degrees * Math.PI) / 180;
  const scale = ART.w / widthKm;
  const band = ART.h * Math.sin(angle);
  const top = ART.y + (ART.h - band) / 2;
  return (u, v, height) => ({
    x: ART.x + u * ART.w,
    y: top + v * band - ((height - t.lo) / 1000) * scale * Math.cos(angle),
  });
}

// Круг и нормали считаются один раз на место: в кадре остаётся только умножение на направление света
export function buildScene(t: Terrain, count: number, project: Project): Scene {
  const at = (x: number, y: number) => t.heights[clamp(y, 0, t.h - 1) * t.w + clamp(x, 0, t.w - 1)];
  const smooth = (x: number, y: number) => {
    const [x0, y0] = [Math.floor(x), Math.floor(y)];
    const [fx, fy] = [x - x0, y - y0];
    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    return top * (1 - fy) + bottom * fy;
  };
  const slopes: number[] = [];
  for (let i = 0; i < 4000; i++) {
    const { u, v } = r2(i);
    const [x, y] = [Math.floor(u * t.w), Math.floor(v * t.h)];
    slopes.push(Math.hypot(at(x + 1, y) - at(x - 1, y), at(x, y + 1) - at(x, y - 1)));
  }
  slopes.sort((a, b) => a - b);
  const steep = Math.max(1e-6, slopes[Math.floor(slopes.length * 0.9)]);

  const scene: Scene = {
    count,
    x: new Float32Array(count),
    y: new Float32Array(count),
    u: new Float32Array(count),
    nx: new Float32Array(count),
    ny: new Float32Array(count),
    nz: new Float32Array(count),
    rank: new Float32Array(count),
    height: new Float32Array(count),
    cell: new Int32Array(count),
  };
  for (let n = 0; n < count; n++) {
    const { u, v } = r2(n);
    const [gx, gy] = [Math.floor(u * t.w), Math.floor(v * t.h)];
    const height = smooth(u * (t.w - 1), v * (t.h - 1));
    const { x, y } = project(u, v, height);
    const [dx, dy] = [(at(gx + 1, gy) - at(gx - 1, gy)) / steep, (at(gx, gy + 1) - at(gx, gy - 1)) / steep];
    const length = Math.hypot(dx, dy, 1);
    scene.x[n] = x;
    scene.y[n] = y;
    scene.u[n] = u;
    scene.nx[n] = -dx / length;
    scene.ny[n] = -dy / length;
    scene.nz[n] = 1 / length;
    scene.rank[n] = n / count;
    scene.height[n] = height;
    scene.cell[n] = Math.floor(v * SHADE_H) * SHADE_W + Math.floor(u * SHADE_W);
  }
  return scene;
}

export function coarse(t: Terrain): Float32Array {
  const heights = new Float32Array(SHADE_W * SHADE_H);
  for (let y = 0; y < SHADE_H; y++) {
    for (let x = 0; x < SHADE_W; x++) {
      const i = Math.floor((y / SHADE_H) * t.h) * t.w + Math.floor((x / SHADE_W) * t.w);
      heights[y * SHADE_W + x] = t.heights[i] / 1000;
    }
  }
  return heights;
}

// От каждой клетки идём к солнцу: если рельеф на пути выше луча, клетка лежит в падающей тени
export function castShadows(heights: Float32Array, w: number, h: number, cellKm: number, sunX: number, sunY: number, rise: number, out: Float32Array): void {
  const top = heights.reduce((a, b) => Math.max(a, b), 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const base = heights[y * w + x];
      const step = (top - base) / rise / SHADE_STEPS;
      let shade = 0;
      for (let s = 1; s <= SHADE_STEPS && shade < 1; s++) {
        const reach = s * step;
        const px = Math.round(x + (sunX * reach) / cellKm);
        const py = Math.round(y + (sunY * reach) / cellKm);
        if (px < 0 || py < 0 || px >= w || py >= h) break;
        shade = Math.max(shade, (heights[py * w + px] - base - rise * reach) / SHADE_SOFT);
      }
      out[y * w + x] = Math.min(1, shade);
    }
  }
}

// Луч идёт почти ровно и лишь у края коротко разворачивается: чистый синус слишком долго топтался бы на месте
export function beamAt(now: number): number {
  const phase = (now / SWEEP_MS) * Math.PI * 2;
  return 0.5 + (0.62 * Math.asin(TURN * Math.sin(phase))) / Math.asin(TURN);
}

// Точка проступает мягко: у порога своей доли она ещё прозрачна, поэтому свет не щёлкает
export const dotAlpha = (light: number, rank: number) => clamp((light - rank) * SOFTNESS, 0, 1);

interface View {
  place: ReliefPlace;
  terrain: Terrain;
  scene: Scene;
  heights: Float32Array;
  cellKm: number;
}

async function mosaic(lat: number, lon: number, zoom: number): Promise<Uint8ClampedArray> {
  const center = tileOf(lat, lon, zoom);
  const [left, top] = [center.x - SPAN_TILES / 2, center.y - SPAN_TILES / 2];
  const size = TILE * SPAN_TILES;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  // Вершина стоит в центре листа, поэтому окно почти всегда задевает на плитку больше
  const side = SPAN_TILES + 1;
  const cells = Array.from({ length: side ** 2 }, (_, i) => ({ x: Math.floor(left) + (i % side), y: Math.floor(top) + Math.floor(i / side) }));
  await Promise.all(
    cells.map(async ({ x, y }) => {
      const res = await fetch(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${x}/${y}.png`);
      if (!res.ok) throw new Error(`Плитка ${zoom}/${x}/${y}: HTTP ${res.status}`);
      ctx.drawImage(await createImageBitmap(await res.blob()), Math.round((x - left) * TILE), Math.round((y - top) * TILE));
    }),
  );
  return ctx.getImageData(0, 0, size, size).data;
}

export class Relief implements Poster {
  readonly service = tr('Рельеф', 'Relief');
  readonly source = 'Terrain Tiles · AWS Open Data';
  readonly kind = tr('другое место', 'another place');
  readonly align = 'left';
  readonly ink = LIGHT;
  readonly feeds = [new Feed('Terrain Tiles', Infinity)];
  readonly encoding: Encoding = {
    color: tr('Только свет и темнота: белые точки на чёрном, как проекция инфракрасного сенсора на тело.', 'Only light and dark: white dots on black, like an infrared sensor projected onto a body.'),
    form: tr('Настоящая карта высот, вид с воздуха без растяжения: высота и расстояния в одном масштабе. Точки стоят на последовательности R2: чем ярче склон, тем большая их доля зажжена.', 'A real elevation map seen from the air, unstretched: height and distance share one scale. Dots follow the R2 sequence: the brighter the slope, the larger the share of them lit.'),
    speed: tr('Низкое солнце ходит над местом за 26 секунд: горы отбрасывают настоящие тени, и те ползут по долинам вслед за светом.', 'A low sun crosses the place in 26 seconds: the mountains cast real shadows, and they creep through the valleys after the light.'),
  };

  private place = MOUNTAINS[0];
  private refresh = () => {};
  private next: View[] = [];
  private view: View | null = null;
  private warming = false;
  private reveal = { x: 0, v: 0 };
  private shade = new Float32Array(SHADE_W * SHADE_H);

  paper(): string {
    return PAPER;
  }

  start(): void {
    this.refresh = poll(
      this.feeds[0],
      POLL_MS,
      async () => {
        const place = this.place;
        return { place, pixels: await mosaic(place.lat, place.lon, place.zoom) };
      },
      ({ place, pixels }) => {
        const view = this.store(place, pixels);
        if (place === this.place) this.view = view;
        void this.warm();
      },
    );
  }

  shuffle(rand?: () => number): void {
    const view = this.next.shift();
    this.place = view?.place ?? famous(MOUNTAINS, this.place, rand);
    if (view) this.view = view;
    else this.refresh();
    void this.warm();
  }

  private store(place: ReliefPlace, pixels: Uint8ClampedArray): View {
    const t = terrain(pixels, TILE * SPAN_TILES);
    const widthKm = (((SPAN_TILES * 40_075 * Math.cos((place.lat * Math.PI) / 180)) / 2 ** place.zoom) * ART.w) / ART.h;
    const scene = buildScene(t, COUNT, oblique(t, widthKm, VIEW_ANGLE));
    return { place, terrain: t, scene, heights: coarse(t), cellKm: widthKm / SHADE_W };
  }

  // Несколько случайных мест готовятся заранее, пока зритель смотрит текущее: кнопка меняет лист без ожидания
  private async warm(): Promise<void> {
    if (this.warming) return;
    this.warming = true;
    while (this.next.length < AHEAD) {
      const place = famous(MOUNTAINS, this.place);
      try {
        this.next.push(this.store(place, await mosaic(place.lat, place.lon, place.zoom)));
      } catch {
        // Не догрузилось: кнопка возьмёт другое место
      }
    }
    this.warming = false;
  }

  where(): ReliefPlace | null {
    return this.view?.place ?? null;
  }

  label(): Label {
    if (!this.view) return { title: tr(this.place.name, this.place.en), print: tr('Карта высот и свет', 'Elevation map and light') };
    const { place, terrain: t, scene } = this.view;
    const title = tr(place.name, place.en);
    return { title, print: tr(`Высшая точка ${fmtInt(t.hi)} м · перепад ${fmtInt(t.hi - t.lo)} м · ${fmtInt(scene.count)} точек света.`, `Highest point ${fmtInt(t.hi)} m · relief ${fmtInt(t.hi - t.lo)} m · ${fmtInt(scene.count)} points of light.`) };
  }

  draw({ ctx, now, dt }: Frame): void {
    glide(this.reveal, this.view ? 1 : 0, dt, REVEAL_SEC);
    if (!this.view) return waiting(ctx, this.ink);
    const s = this.view.scene;

    const beam = beamAt(now);
    const azimuth = (beam - 0.5) * 2.2;
    const [lx, ly, lz] = [Math.sin(azimuth) * 0.92, -0.3, 0.24];
    const length = Math.hypot(lx, ly);
    castShadows(this.view.heights, SHADE_W, SHADE_H, this.view.cellKm, lx / length, ly / length, 0.14 + 0.2 * Math.cos(azimuth), this.shade);
    const levels = Array.from({ length: LEVELS }, () => [] as number[]);
    const reveal = clamp(this.reveal.x, 0, 1);
    for (let i = 0; i < s.count; i++) {
      const lit = Math.max(0, s.nx[i] * lx + s.ny[i] * ly + s.nz[i] * lz);
      const gap = (s.u[i] - beam) / BEAM;
      const open = 1 - this.shade[s.cell[i]];
      const light = (AMBIENT * (0.5 + 0.5 * open) + lit * 1.7 * Math.exp(-gap * gap) * open) * reveal;
      const alpha = dotAlpha(light, s.rank[i]);
      if (alpha > 0) levels[Math.min(LEVELS - 1, Math.floor(alpha * LEVELS))].push(i);
    }

    ctx.fillStyle = LIGHT;
    levels.forEach((dots, level) => {
      ctx.globalAlpha = (level + 1) / LEVELS;
      ctx.beginPath();
      for (const i of dots) ctx.rect(s.x[i], s.y[i], 0.24, 0.24);
      ctx.fill();
    });
    ctx.globalAlpha = 1;
  }

  pick(x: number, y: number): Tip | null {
    if (!this.view) return null;
    const s = this.view.scene;
    let [best, bestDist] = [-1, 2];
    for (let i = 0; i < s.count; i++) {
      const d = Math.hypot(s.x[i] - x, s.y[i] - y);
      if (d < bestDist) [best, bestDist] = [i, d];
    }
    if (best < 0) return null;
    return { value: `${fmtInt(s.height[best])} ${tr('м', 'm')}`, label: tr(this.view.place.name, this.view.place.en) };
  }
}
