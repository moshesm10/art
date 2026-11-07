import { PLATFORMS, type PlatformPlace } from '../config';
import { fmtClock, fmtTemp, word } from '../lib/format';
import { tr } from '../lib/i18n';
import type { Spot } from '../lib/locate';
import { Feed, getJson, poll } from '../lib/net';
import { ART, waiting, type Encoding, type Frame, type Label, type Poster, type Tip } from '../lib/poster';
import { clamp, glide, other } from '../lib/stats';
import { alpha, mixHex } from '../lib/theme';

const SUN = globalThis.location?.search.match(/sun=(-?\d+)/)?.[1];

const PAPER = '#07080b';
const INK = '#e8e3d6';
const WARM = '#ffb24d';
const AWNING = '#f0702c';
const SCARF = '#e0452e';
const TRAIN = '#e2ecf4';
const TRAIN_LATE = '#e85430';
const POLL_MS = 2 * 60_000;
const NEAR_MS = 3_600_000;
const SNOW_FULL_MM = 2;
const SNOW_BELOW = 1;
const FLAKES = 1500;
const FALL = 26;
const LATE_MIN = 30;
const ARRIVAL_SEC = 3;
const MOON_MONTH = 29.530588 * 86_400_000;
const NEW_MOON = 947_182_440_000;

// Рисунок живёт на маленьком холсте и растягивается без сглаживания: отсюда пиксель
const PX = 2;
const W = ART.w * PX;
const H = ART.h * PX;
const SKY_BANDS = 12;
const HORIZON = 150;
const DECK = 168;
const RAIL = 187;
const LAMP = { x: 92, y: 84 };
const FIGURE = 112;
const TRAIN_FAR = W;
const TRAIN_NEAR = 44;

interface RawRow {
  stationShortCode: string;
  type: string;
  cancelled: boolean;
  scheduledTime: string;
  liveEstimateTime?: string;
  actualTime?: string;
}

interface RawTrain {
  trainType: string;
  trainNumber: number;
  trainCategory: string;
  cancelled: boolean;
  timeTableRows: RawRow[];
}

export interface Arrival {
  name: string;
  time: number;
  late: number;
}

// Берём ближайший пассажирский поезд, который ещё не пришёл: живая оценка важнее расписания
export function parseArrival(json: RawTrain[], code: string, now: number): Arrival | null {
  const arrivals = json
    .filter((train) => !train.cancelled && train.trainCategory === 'Long-distance')
    .flatMap((train) =>
      train.timeTableRows
        .filter((row) => row.stationShortCode === code && row.type === 'ARRIVAL' && !row.cancelled && !row.actualTime)
        .map((row) => {
          const scheduled = Date.parse(row.scheduledTime);
          const time = Date.parse(row.liveEstimateTime ?? row.scheduledTime);
          return { name: `${train.trainType} ${train.trainNumber}`, time, late: Math.max(0, (time - scheduled) / 60_000) };
        }),
    )
    .filter((arrival) => arrival.time > now);
  return arrivals.sort((a, b) => a.time - b.time)[0] ?? null;
}

interface RawForecast {
  properties: {
    timeseries: {
      data: {
        instant: { details: { air_temperature: number; wind_speed: number; wind_from_direction: number } };
        next_1_hours?: { details: { precipitation_amount: number } };
        next_6_hours?: { details: { precipitation_amount: number } };
      };
    }[];
  };
}

export interface Air {
  temp: number;
  wind: number;
  drift: number;
  snow: number;
}

// Снег на листе — самый густой снегопад из прогноза на ближайшие дни: надежда на него, а не сводка за окном
export function parseAir(json: RawForecast): Air {
  const hours = json.properties.timeseries.map((step) => step.data);
  const { air_temperature: temp, wind_speed: wind, wind_from_direction: from } = hours[0].instant.details;
  const snow = Math.max(
    0,
    ...hours
      .filter((hour) => hour.instant.details.air_temperature <= SNOW_BELOW)
      .map((hour) => hour.next_1_hours?.details.precipitation_amount ?? (hour.next_6_hours?.details.precipitation_amount ?? 0) / 6),
  );
  return { temp, wind, drift: -Math.sin((from * Math.PI) / 180) * wind, snow };
}

// Как в настоящей перспективе: далёкие часы сжаты у горизонта, а последний час пролетает почти весь путь
export const reach = (etaMs: number) => 1 / (1 + Math.max(0, etaMs) / NEAR_MS);

export const flakeCount = (mm: number) => Math.round(FLAKES * Math.sqrt(clamp(mm / SNOW_FULL_MM, 0, 1)));

export function waitText(etaMs: number): string {
  const minutes = Math.max(1, Math.round(etaMs / 60_000));
  const [h, m] = [Math.floor(minutes / 60), minutes % 60];
  const parts = [h ? `${h} ${word(h, ['час', 'часа', 'часов'], ['hour', 'hours'])}` : '', m ? `${m} ${word(m, ['минуту', 'минуты', 'минут'], ['minute', 'minutes'])}` : ''];
  return parts.filter(Boolean).join(' ');
}

// Вовремя огонёк холодный, а с опозданием краснеет
export function trainColor(late: number): string {
  return mixHex(TRAIN, TRAIN_LATE, clamp(late / LATE_MIN, 0, 1));
}

// Снежинкам нужен беспорядок: регулярная последовательность выстраивала их в заметные ряды
const scatter = (n: number) => {
  const v = Math.sin(n * 127.1) * 43758.5453;
  return v - Math.floor(v);
};

export function sunAltitude(lat: number, lon: number, t: number): number {
  const rad = Math.PI / 180;
  const day = t / 86_400_000;
  const year = ((day % 365.2422) + 365.2422) % 365.2422;
  const tilt = -23.44 * Math.cos((2 * Math.PI * (year + 10)) / 365.2422);
  const hour = (((t / 3_600_000) % 24) + 24) % 24;
  const angle = (hour - 12) * 15 + lon;
  const sin = Math.sin(lat * rad) * Math.sin(tilt * rad) + Math.cos(lat * rad) * Math.cos(tilt * rad) * Math.cos(angle * rad);
  return Math.asin(sin) / rad;
}

// Доля лунного месяца: 0 новолуние, 0,5 полнолуние
export const moonPhase = (t: number) => (((t - NEW_MOON) % MOON_MONTH) + MOON_MONTH) % MOON_MONTH / MOON_MONTH;

export interface Sky {
  top: string;
  bottom: string;
  ridge: string;
  snow: string;
  shade: string;
}

const SKIES: [number, Sky][] = [
  [-18, { top: '#081433', bottom: '#17386f', ridge: '#10264f', snow: '#8ea6cc', shade: '#050a1a' }],
  [-9, { top: '#12295e', bottom: '#3f66ac', ridge: '#1d3a72', snow: '#a9bbdc', shade: '#081430' }],
  [-4, { top: '#3a2f78', bottom: '#e0789a', ridge: '#2c2a68', snow: '#d9c3dc', shade: '#120f38' }],
  [1, { top: '#5a4488', bottom: '#f7a083', ridge: '#2a2150', snow: '#f4d9cb', shade: '#1c1538' }],
  [10, { top: '#4f8088', bottom: '#a8c4bb', ridge: '#2c4f5a', snow: '#f1efe4', shade: '#1a3640' }],
];

export function skyAt(altitude: number): Sky {
  const next = SKIES.findIndex(([at]) => altitude <= at);
  if (next === 0) return SKIES[0][1];
  if (next < 0) return SKIES[SKIES.length - 1][1];
  const [[from, a], [to, b]] = [SKIES[next - 1], SKIES[next]];
  const k = (altitude - from) / (to - from);
  return {
    top: mixHex(a.top, b.top, k),
    bottom: mixHex(a.bottom, b.bottom, k),
    ridge: mixHex(a.ridge, b.ridge, k),
    snow: mixHex(a.snow, b.snow, k),
    shade: mixHex(a.shade, b.shade, k),
  };
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

// Небо идёт ступенями с шахматным дизерингом, как в старых играх
function paintSky(ctx: CanvasRenderingContext2D, sky: Sky): void {
  const bands = Array.from({ length: SKY_BANDS + 1 }, (_, i) => mixHex(sky.top, sky.bottom, i / SKY_BANDS));
  for (let y = 0; y < HORIZON; y++) {
    const level = (y / HORIZON) * SKY_BANDS;
    const band = Math.floor(level);
    for (let x = 0; x < W; x++) {
      const up = level - band > (BAYER[(y % 4) * 4 + (x % 4)] + 0.5) / 16;
      ctx.fillStyle = bands[Math.min(SKY_BANDS, band + (up ? 1 : 0))];
      ctx.fillRect(x, y, 1, 1);
    }
  }
}

function paintDisc(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string, bite = 0, biteColor = ''): void {
  for (let y = -r; y <= r; y++) {
    const half = Math.floor(Math.sqrt(r * r - y * y));
    ctx.fillStyle = color;
    ctx.fillRect(cx - half, cy + y, half * 2 + 1, 1);
    if (!bite) continue;
    // Тень на луне идёт эллипсом: так рисуется настоящая фаза
    const edge = Math.round(half * bite);
    ctx.fillStyle = biteColor;
    if (bite > 0) ctx.fillRect(cx - half, cy + y, half + edge, 1);
  }
}

function paintBody(ctx: CanvasRenderingContext2D, altitude: number, now: number, sky: Sky): void {
  if (altitude > -5) {
    const y = Math.round(HORIZON - 12 - clamp(altitude + 4, 0, 16) * 7);
    paintDisc(ctx, 134, y, 34, mixHex('#ef5a3c', '#e8826a', clamp(altitude / 10, 0, 1)));
    return;
  }
  const phase = moonPhase(now);
  const lit = 1 - Math.abs(phase - 0.5) * 2;
  paintDisc(ctx, 122, 46, 19, '#ece6d2', lit < 0.95 ? 1 - lit : 0, mixHex(sky.top, sky.bottom, 0.3));
}

function paintRidge(ctx: CanvasRenderingContext2D, seed: number, sky: Sky): void {
  ctx.fillStyle = sky.ridge;
  for (let x = 0; x < W; x++) {
    const swell = Math.sin(x * 0.031 + seed) * 9 + Math.sin(x * 0.083 + seed * 2) * 4 + Math.sin(x * 0.21 + seed * 3) * 1.4;
    const top = Math.round(HORIZON - 12 + swell);
    ctx.fillRect(x, top, 1, DECK - top);
  }
}

function paintStation(ctx: CanvasRenderingContext2D, sky: Sky): void {
  const box = (color: string, x: number, y: number, w: number, h: number) => {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
  };
  box(sky.shade, 14, 122, 52, DECK - 122);
  box(sky.snow, 8, 112, 64, 5);
  box(sky.snow, 11, 110, 54, 2);
  box(mixHex(sky.shade, '#000000', 0.4), 10, 117, 60, 5);
  box(AWNING, 16, 126, 48, 6);
  box(mixHex(AWNING, '#000000', 0.3), 16, 132, 48, 1);
  box(WARM, 22, 136, 36, DECK - 136);
  box(mixHex(WARM, '#fff2c8', 0.6), 22, 136, 36, 8);
  box(sky.shade, 34, 136, 2, DECK - 136);
  box(sky.shade, 46, 136, 2, DECK - 136);

  box(sky.shade, 0, DECK + 5, W, 11);
  box(sky.snow, 0, DECK, W, 5);
  box(mixHex(sky.snow, WARM, 0.45), 14, DECK, 56, 2);
  box(mixHex(sky.snow, sky.shade, 0.35), 0, DECK + 4, W, 1);

  box(sky.shade, 0, RAIL - 3, W, H - RAIL + 3);
  box(mixHex(sky.snow, sky.shade, 0.45), 0, RAIL, W, 1);
  for (let x = 3; x < W; x += 9) box(mixHex(sky.snow, sky.shade, 0.7), x, RAIL + 1, 4, 2);
  box(mixHex(sky.snow, sky.shade, 0.2), 0, H - 6, W, 6);

  box(sky.shade, LAMP.x - 1, LAMP.y, 2, DECK - LAMP.y);
  box(sky.shade, LAMP.x - 1, LAMP.y, 13, 1);
  box(sky.shade, LAMP.x + 9, LAMP.y + 1, 5, 2);

  ctx.fillStyle = sky.shade;
  for (let x = 0; x < LAMP.x; x++) {
    const sag = ((x / LAMP.x - 0.5) ** 2 - 0.25) * -26;
    ctx.fillRect(x, Math.round(58 + (x / LAMP.x) * 26 + sag), 1, 1);
  }

  box(sky.shade, FIGURE, DECK - 15, 5, 15);
  box(sky.shade, FIGURE + 1, DECK - 19, 3, 4);
  box(SCARF, FIGURE, DECK - 15, 5, 2);
  box(SCARF, FIGURE + 4, DECK - 13, 1, 4);
  box(mixHex(sky.shade, WARM, 0.55), FIGURE, DECK - 13, 1, 13);
  box(mixHex(sky.shade, WARM, 0.55), FIGURE + 1, DECK - 19, 1, 4);
}

interface Stop {
  arrival: Arrival | null;
  air: Air | null;
}

export class Platform implements Poster {
  readonly service = tr('Последний поезд', 'Last Train');
  readonly source = 'Digitraffic · MET Norway';
  readonly kind = tr('другая станция', 'another station');
  readonly align = 'left';
  readonly ink = INK;
  // Зерно трафаретной печати спорит с пикселем и пачкает светлые окна
  readonly clean = true;
  readonly feeds = [new Feed('Digitraffic', POLL_MS * 3)];
  readonly encoding: Encoding = {
    color: tr('Небо — настоящая высота солнца над станцией: синяя ночь, розовые сумерки, бирюзовый день. Тёплые здесь только окно и фонарь, а огонёк поезда холодный и краснеет с опозданием.', 'The sky is the real height of the sun over the station: blue night, pink dusk, turquoise day. Only the window and the lamp are warm here; the train light is cold and reddens as it runs late.'),
    form: tr('Расстояние огонька до платформы — настоящее время до следующего поезда на этой станции: далёкие часы сжаты у горизонта, последний час занимает половину пути.', 'The distance from the light to the platform is the real time until the next train at this station: far-off hours are squeezed at the horizon, the last hour takes half the way.'),
    speed: tr('Густота снега — самый сильный снегопад из прогноза на ближайшие дни, а снос — настоящий ветер. Огонёк едет с настоящей скоростью ожидания: заметить это можно, только вернувшись позже.', 'The density of the snow is the heaviest snowfall forecast for the coming days, its drift the real wind. The light moves at the real speed of waiting: you can only notice it by coming back later.'),
  };

  private place = PLATFORMS[0];
  private stops = new Map<PlatformPlace, Stop>();
  private distance = { x: 0, v: 0 };
  private stage: HTMLCanvasElement | null = null;
  private backdrop: HTMLCanvasElement | null = null;
  private painted = '';

  paper(): string {
    return PAPER;
  }

  start(): void {
    poll(this.feeds[0], POLL_MS, () => this.loadAll(), () => {});
  }

  // Параллельные запросы к Digitraffic из России зависают, поэтому станции идут по очереди, начиная с той, что на листе
  private async loadAll(): Promise<void> {
    let loaded = 0;
    for (const place of [this.place, ...PLATFORMS.filter((p) => p !== this.place)]) {
      try {
        this.stops.set(place, await this.load(place));
        this.feeds[0].ok();
        loaded++;
      } catch {
        // Станция не ответила: на листе остаются её прошлые данные, а следующий опрос попробует снова
      }
    }
    if (!loaded) throw new Error('Digitraffic не отвечает');
  }

  private async load(place: PlatformPlace): Promise<Stop> {
    const code = encodeURIComponent(place.code);
    const trains = await getJson<RawTrain[]>(`https://rata.digitraffic.fi/api/v1/live-trains/station/${code}?arrived_trains=0&arriving_trains=2&departed_trains=0&departing_trains=0&include_nonstopping=false&train_categories=Long-distance`);
    const air = await getJson<RawForecast>(`/api/metno/weatherapi/locationforecast/2.0/compact?lat=${place.lat}&lon=${place.lon}`).catch(() => null);
    return { arrival: parseArrival(trains, place.code, Date.now()), air: air && parseAir(air) };
  }

  shuffle(rand?: () => number): void {
    const ready = PLATFORMS.filter((place) => this.stops.has(place));
    this.place = other(ready.length > 1 ? ready : PLATFORMS, this.place, rand);
  }

  where(): Spot {
    return this.place;
  }

  label(now: number): Label {
    const stop = this.stops.get(this.place);
    const title = tr(this.place.name, this.place.en);
    if (!stop) return { title, print: tr('Следующий поезд и снег', 'Next train and snow') };
    const train = stop.arrival && stop.arrival.time > now ? tr(`Поезд ${stop.arrival.name} через ${waitText(stop.arrival.time - now)}`, `Train ${stop.arrival.name} in ${waitText(stop.arrival.time - now)}`) : tr('Поездов пока нет', 'No trains yet');
    const late = stop.arrival && stop.arrival.late >= 1 ? tr(` · опаздывает на ${Math.round(stop.arrival.late)} мин`, ` · ${Math.round(stop.arrival.late)} min late`) : '';
    const air = stop.air ? ` · ${fmtTemp(stop.air.temp)} · ${tr(`ветер ${Math.round(stop.air.wind)} м/с`, `wind ${Math.round(stop.air.wind)} m/s`)}` : '';
    return { title, print: `${train}${late}${air}.` };
  }

  private trainAt(k: number): { x: number; r: number } {
    return { x: TRAIN_FAR + (TRAIN_NEAR - TRAIN_FAR) * k, r: 1 + Math.round(3 * k ** 2) };
  }

  // Неподвижная часть рисуется заново только когда небо заметно изменилось
  private paintBackdrop(altitude: number, now: number): void {
    const key = `${this.place.code}:${Math.round(altitude * 2)}`;
    if (key === this.painted) return;
    this.painted = key;
    this.backdrop ??= Object.assign(document.createElement('canvas'), { width: W, height: H });
    const ctx = this.backdrop.getContext('2d')!;
    const sky = skyAt(altitude);
    paintSky(ctx, sky);
    paintBody(ctx, altitude, now, sky);
    paintRidge(ctx, this.place.lat, sky);
    paintStation(ctx, sky);
  }

  draw({ ctx, now, dt }: Frame): void {
    const stop = this.stops.get(this.place);
    if (!stop) return waiting(ctx, this.ink);
    const arrival = stop.arrival && stop.arrival.time > now ? stop.arrival : null;
    glide(this.distance, arrival ? reach(arrival.time - now) : 0, dt, ARRIVAL_SEC);

    const altitude = SUN === undefined ? sunAltitude(this.place.lat, this.place.lon, now) : Number(SUN);
    this.paintBackdrop(altitude, now);
    this.stage ??= Object.assign(document.createElement('canvas'), { width: W, height: H });
    const px = this.stage.getContext('2d')!;
    px.drawImage(this.backdrop!, 0, 0);

    const breath = 1 + 0.06 * Math.sin(now / 1700) + 0.03 * Math.sin(now / 410);
    for (const [r, a] of [[26, 0.07], [16, 0.1], [8, 0.16]]) {
      px.fillStyle = alpha(WARM, a * breath);
      px.beginPath();
      px.arc(LAMP.x + 11, LAMP.y + 3, r, 0, Math.PI * 2);
      px.fill();
    }
    px.fillStyle = '#fff2c8';
    px.fillRect(LAMP.x + 10, LAMP.y + 3, 3, 2);

    if (arrival) {
      const { x, r } = this.trainAt(this.distance.x);
      px.fillStyle = trainColor(arrival.late);
      px.fillRect(Math.round(x) - r, RAIL - 3 - r, r * 2 + 1, r * 2 + 1);
      px.fillStyle = alpha(trainColor(arrival.late), 0.35);
      px.fillRect(Math.round(x) - r - 10, RAIL - 3, 10, 1);
    }

    this.snow(px, now, stop.air, skyAt(altitude).snow);

    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.stage, ART.x, ART.y, ART.w, ART.h);
    ctx.restore();
  }

  private snow(px: CanvasRenderingContext2D, now: number, air: Air | null, color: string): void {
    if (!air) return;
    const seconds = now / 1000;
    const count = flakeCount(air.snow);
    px.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const depth = 0.4 + 0.6 * scatter(i);
      const y = (scatter(i + 0.31) * H + seconds * FALL * depth) % H;
      const drift = seconds * air.drift * 4 * depth + Math.sin(seconds * 0.7 + i) * 1.5;
      const x = (((scatter(i + 0.67) * W + drift) % W) + W) % W;
      px.globalAlpha = 0.35 + 0.65 * depth;
      px.fillRect(Math.round(x), Math.round(y), 1, depth > 0.8 ? 2 : 1);
    }
    px.globalAlpha = 1;
  }

  pick(x: number, y: number, now: number): Tip | null {
    const stop = this.stops.get(this.place);
    if (!stop) return null;
    if (stop.arrival && stop.arrival.time > now) {
      const train = this.trainAt(this.distance.x);
      if (Math.hypot(ART.x + train.x / PX - x, ART.y + RAIL / PX - y) < 4) return { value: fmtClock(stop.arrival.time), label: `${tr('Поезд', 'Train')} ${stop.arrival.name}` };
    }
    if (stop.air && Math.hypot(ART.x + (LAMP.x + 11) / PX - x, ART.y + LAMP.y / PX - y) < 4) return { value: fmtTemp(stop.air.temp), label: this.place.name };
    return null;
  }
}
