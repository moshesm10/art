import type { Spot } from './locate';
import { worstFeed, type Feed, type Status } from './net';
import { tr } from './i18n';
import { alpha, FONT } from './theme';

// Каждый постер рисуется в своих единицах: лист 100 × 140, разрешение решает оболочка
export const SHEET_W = 100;
export const SHEET_H = 140;
export const ART = { x: 8, y: 8, w: 84, h: 100 };

export interface Frame {
  ctx: CanvasRenderingContext2D;
  now: number;
  dt: number;
}

export interface Tip {
  value: string;
  label: string;
}

export interface Label {
  title: string;
  print: string;
}

export interface Encoding {
  color: string;
  form: string;
  speed: string;
}

export interface Poster {
  readonly service: string;
  readonly source: string;
  readonly feeds: Feed[];
  readonly encoding: Encoding;
  readonly kind: string;
  readonly align: 'left' | 'right';
  readonly ink: string;
  readonly clean?: boolean;
  paper(): string;
  start(): void;
  shuffle(rand?: () => number): void;
  label(now: number): Label;
  draw(frame: Frame): void;
  pick(x: number, y: number, now: number): Tip | null;
  open?(x: number, y: number, now: number): string | null;
  where?(): Spot | null;
}

export function clipArt(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.rect(ART.x, ART.y, ART.w, ART.h);
  ctx.clip();
}

export function disc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0, r), 0, Math.PI * 2);
  ctx.fill();
}

export function waiting(ctx: CanvasRenderingContext2D, ink: string): void {
  ctx.font = `400 2.6px ${FONT}`;
  ctx.fillStyle = alpha(ink, 0.55);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(tr('Ждём первые данные', 'Waiting for first data'), ART.x + ART.w / 2, ART.y + ART.h / 2);
}

export function wrap(ctx: CanvasRenderingContext2D, value: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of value.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxWidth) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1].replace(/[,.·\s]+$/, '')}…`;
  return kept;
}

// Значок вместо строки статуса: полный круг в эфире, кольцо при ожидании, перечёркнутый без связи
function mark(ctx: CanvasRenderingContext2D, x: number, y: number, ink: string, state: Status): void {
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.32;
  ctx.beginPath();
  ctx.arc(x, y, 2.1, 0, Math.PI * 2);
  ctx.stroke();
  if (state === 'live') {
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.arc(x, y, 1.15, 0, Math.PI * 2);
    ctx.fill();
  } else if (state === 'offline' || state === 'stale') {
    ctx.beginPath();
    ctx.moveTo(x - 1.5, y + 1.5);
    ctx.lineTo(x + 1.5, y - 1.5);
    ctx.stroke();
  }
}

export function caption(ctx: CanvasRenderingContext2D, poster: Poster, label: Label, state: Status): void {
  const { ink, align } = poster;
  const right = align === 'right';
  const notice = state === 'offline' ? tr('Нет связи. ', 'No connection. ') : state === 'stale' ? tr('Данные устарели. ', 'Data is stale. ') : '';
  const printW = right ? 36 : ART.w - 8;
  const printY = right ? 124.6 : 126.4;

  ctx.textBaseline = 'alphabetic';
  ctx.font = `400 1.85px ${FONT}`;
  ctx.fillStyle = alpha(ink, 0.82);
  ctx.textAlign = 'left';
  wrap(ctx, notice + label.print, printW, 3).forEach((line, i) => {
    ctx.fillText(line, ART.x + 6.2, printY + i * 2.5);
  });
  mark(ctx, ART.x + 2.1, printY + 1.6, ink, state);

  const title = label.title.toUpperCase();
  const room = right ? ART.w - printW - 8 : ART.w;
  ctx.font = `700 100px ${FONT}`;
  const size = Math.min(right ? 9 : 12.5, (100 * room) / ctx.measureText(title).width);
  ctx.font = `700 ${size}px ${FONT}`;
  ctx.fillStyle = ink;
  ctx.textAlign = right ? 'right' : 'left';
  ctx.fillText(title, right ? ART.x + ART.w : ART.x - size * 0.04, right ? 131 : 122.5);
}

const TILE = 512;

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Плиточный шум: решётка замкнута, поэтому текстура ложится без швов
function lattice(cells: number, rand: () => number): (x: number, y: number) => number {
  const grid = Float32Array.from({ length: cells * cells }, rand);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const at = (x: number, y: number) => grid[(y % cells) * cells + (x % cells)];
  return (x, y) => {
    const [fx, fy] = [(x / TILE) * cells, (y / TILE) * cells];
    const [ix, iy] = [Math.floor(fx), Math.floor(fy)];
    const [sx, sy] = [smooth(fx - ix), smooth(fy - iy)];
    const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * sx;
    const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * sx;
    return top + (bottom - top) * sy;
  };
}

function wearTile(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILE;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(TILE, TILE);
  const rand = rng(7);
  const [wide, mid, fine] = [lattice(5, rand), lattice(64, rand), lattice(256, rand)];
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const v = wide(x, y) * 0.24 + mid(x, y) * 0.3 + fine(x, y) * 0.3 + rand() * 0.16;
      const worn = Math.min(1, Math.max(0, (v - 0.56) / 0.16));
      image.data[(y * TILE + x) * 4 + 3] = worn * 92;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

const MAX_TILES = 48;
const tiles = new Map<string, HTMLCanvasElement>();
let wear: HTMLCanvasElement | null = null;

// Шум считается один раз, а под цвет бумаги только перекрашивается: у погоды цвет меняется каждый кадр
function tinted(paper: string): HTMLCanvasElement {
  const known = tiles.get(paper);
  if (known) return known;
  if (tiles.size >= MAX_TILES) tiles.clear();
  wear ??= wearTile();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILE;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(wear, 0, 0);
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, TILE, TILE);
  tiles.set(paper, canvas);
  return canvas;
}

// Зерно цвета бумаги не видно на бумаге и съедает краску на фигурах, как в трафаретной печати
export function grain(ctx: CanvasRenderingContext2D, paper: string, width: number, height: number): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = ctx.createPattern(tinted(paper), 'repeat')!;
  ctx.fillRect(0, 0, width, height);
}

// Один кадр листа целиком: бумага, рисунок, зерно и подпись
export function paintSheet(ctx: CanvasRenderingContext2D, poster: Poster, now: number, dt: number): void {
  const { width, height } = ctx.canvas;
  const k = width / SHEET_W;
  const paper = poster.paper();
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, width, height);
  poster.draw({ ctx, now, dt });
  if (!poster.clean) grain(ctx, paper, width, height);
  ctx.setTransform(k, 0, 0, k, 0, 0);
  caption(ctx, poster, poster.label(now), worstFeed(poster.feeds, now).status(now));
}
