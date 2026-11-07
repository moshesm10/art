import { Feed, getJson, poll } from '../lib/net';
import { ART, disc, waiting, type Encoding, type Frame, type Label, type Poster, type Tip } from '../lib/poster';
import { ease, other } from '../lib/stats';
import { INK } from '../lib/theme';

const PAPER = '#efe9dd';
const ACCENT = '#e63c1e';
const POLL_MS = 15 * 60_000;
const VARIANTS = ['первый', 'второй'];

export interface Reading {
  t: number;
  value: number;
}

interface RawReading {
  time_tag: string;
  Kp: number;
}

// Разбор чистый и живёт отдельно от рисования: только его можно проверить тестом на реальном ответе
export function parseReadings(json: RawReading[]): Reading[] {
  return json.map((r) => ({ t: Date.parse(`${r.time_tag}Z`), value: r.Kp }));
}

export class Sample implements Poster {
  readonly service = 'Название';
  readonly source = 'Источник';
  readonly kind = 'другой вариант';
  readonly align = 'left';
  readonly ink = INK;
  readonly feeds = [new Feed('Источник', POLL_MS * 3)];
  readonly encoding: Encoding = {
    color: 'Что значит каждый цвет, по одному предложению на смысл.',
    form: 'Что значат положение и размер. Главная величина занимает положение на листе.',
    speed: 'Что движется, с какой настоящей скоростью и почему именно так.',
  };

  private variant = VARIANTS[0];
  private refresh = () => {};
  private readings: Reading[] = [];
  private shown: number[] = [];

  paper(): string {
    return PAPER;
  }

  start(): void {
    this.refresh = poll(
      this.feeds[0],
      POLL_MS,
      () => getJson<RawReading[]>('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'),
      (json) => {
        this.readings = parseReadings(json);
      },
    );
  }

  shuffle(rand?: () => number): void {
    this.variant = other(VARIANTS, this.variant, rand);
    this.feeds[0].reset();
    this.refresh();
  }

  label(): Label {
    const last = this.readings.at(-1);
    if (!last) return { title: this.service, print: 'Описание данных' };
    return { title: this.service, print: `Значение ${last.value}` };
  }

  private x(i: number): number {
    return ART.x + ((i + 0.5) / this.readings.length) * ART.w;
  }

  private y(value: number): number {
    return ART.y + ART.h * (1 - value / 9);
  }

  draw({ ctx, dt }: Frame): void {
    if (!this.readings.length) return waiting(ctx, this.ink);
    const k = ease(dt, 2);
    this.readings.forEach((r, i) => {
      this.shown[i] = (this.shown[i] ?? 0) + (r.value - (this.shown[i] ?? 0)) * k;
      disc(ctx, this.x(i), this.y(this.shown[i]), 2, ACCENT);
    });
  }

  pick(x: number, y: number): Tip | null {
    const i = this.readings.findIndex((r, n) => Math.hypot(this.x(n) - x, this.y(r.value) - y) < 3);
    if (i < 0) return null;
    return { value: String(this.readings[i].value), label: new Date(this.readings[i].t).toLocaleString('ru-RU') };
  }
}
