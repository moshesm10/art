import type { City } from '../config';
import { CITIES } from '../data/cities';
import { fmtDec, fmtInt, fmtTemp } from '../lib/format';
import { LOCALE, tr } from '../lib/i18n';
import { locate, nearest } from '../lib/locate';
import { Feed, getJson, poll } from '../lib/net';
import { ART, clipArt, disc, waiting, type Encoding, type Frame, type Label, type Poster, type Tip } from '../lib/poster';
import { clamp, famous } from '../lib/stats';
import { alpha, INK, mixHex, tempPaper } from '../lib/theme';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const LOOP_HOURS = 24;
const SEC_PER_HOUR = 1;
const STEPS_PER_HOUR = 6;
const UNITS_PER_DEGREE = 4;
const SEAM_HOURS = 5;
const BAND_MAX_W = 56;
const LINE_GAP = 2.5;
const LINE_SLOTS = 8;
const BOTTOM = ART.y + ART.h;
const SUN_LEFT = ART.x + 14;
const SUN_RIGHT = ART.x + ART.w - 14;
const MAX_DROPS = 130;
const CALM_RAIN = 50;
const DRIFT_SPEED = 5;
const CALM_SPEED = 13;
const DOWNPOUR_SPEED = 70;
const SNOW_PACE = 0.4;
const AIR_RING_GAP = 1.7;
const MAX_AIR_RINGS = 5;
const MS_TO_KMH = 3.6;
const NO_RAIN_MM = 0.05;
const POLL_MS = 15 * 60_000;

const OVERCAST = '#c8c8c4';
const NIGHT = '#20242d';
const MOONLIGHT = '#ece7dc';

export interface Hour {
  t: number;
  temp: number;
  rain: number;
  mm: number;
  wind: number;
  cloud: number;
  aqi: number | null;
}

export interface Forecast {
  name: string;
  tz: string;
  sunrise: number;
  sunset: number;
  hours: Hour[];
}

interface MetForecast {
  properties: {
    timeseries: {
      time: string;
      data: {
        instant: { details: { air_temperature: number; wind_speed: number; cloud_area_fraction: number } };
        next_1_hours?: { details: { precipitation_amount?: number } };
      };
    }[];
  };
}

interface AirForecast {
  hourly: { time: number[]; us_aqi: (number | null)[] };
}

// MET Norway отдаёт миллиметры, а не вероятность: 1 мм в час — середина шкалы, 4 мм и больше — ливень
export function rainLevel(mm: number): number {
  return Math.min(100, 50 * Math.sqrt(mm));
}

// Восход и закат считаются на месте по уравнению восхода: это на один сетевой запрос меньше
export function sunTimes(lat: number, lon: number, t: number): { sunrise: number; sunset: number } {
  const rad = Math.PI / 180;
  const julian = t / DAY_MS + 2440587.5;
  const noon = Math.round(julian - 2451545 + lon / 360) - lon / 360;
  const anomaly = (357.5291 + 0.98560028 * noon) % 360;
  const centre = 1.9148 * Math.sin(anomaly * rad) + 0.02 * Math.sin(2 * anomaly * rad) + 0.0003 * Math.sin(3 * anomaly * rad);
  const ecliptic = (anomaly + centre + 180 + 102.9372) % 360;
  const transit = 2451545 + noon + 0.0053 * Math.sin(anomaly * rad) - 0.0069 * Math.sin(2 * ecliptic * rad);
  const declination = Math.asin(Math.sin(ecliptic * rad) * Math.sin(23.4397 * rad));
  const hourAngle =
    (Math.sin(-0.833 * rad) - Math.sin(lat * rad) * Math.sin(declination)) / (Math.cos(lat * rad) * Math.cos(declination));
  // Полярные день и ночь: дуга не вырождается в ноль, чтобы орбита солнца оставалась определена
  const arc = clamp(Math.acos(clamp(hourAngle, -1, 1)) / rad, 0.5, 179.5);
  const toMs = (j: number) => (j - 2440587.5) * DAY_MS;
  return { sunrise: toMs(transit - arc / 360), sunset: toMs(transit + arc / 360) };
}

export function parseWeather(place: City, met: MetForecast, air: AirForecast | null): Forecast {
  const aqi = new Map(air?.hourly.time.map((t, i) => [t * 1000, air.hourly.us_aqi[i]]));
  const series = met.properties.timeseries.filter((s) => s.data.next_1_hours).slice(0, LOOP_HOURS);
  const hours = series.map(({ time, data }) => {
    const t = Date.parse(time);
    const mm = data.next_1_hours?.details.precipitation_amount ?? 0;
    const { air_temperature, wind_speed, cloud_area_fraction } = data.instant.details;
    return {
      t,
      temp: air_temperature,
      rain: rainLevel(mm),
      mm,
      wind: wind_speed * MS_TO_KMH,
      cloud: cloud_area_fraction,
      aqi: aqi.get(t) ?? null,
    };
  });
  return { name: place.name, tz: place.tz, ...sunTimes(place.lat, place.lon, hours[0].t), hours };
}

export function aqiLabel(aqi: number): string {
  if (aqi <= 50) return tr('воздух чистый', 'clean air');
  if (aqi <= 100) return tr('воздух умеренный', 'moderate air');
  if (aqi <= 150) return tr('вредно для чувствительных', 'unhealthy for sensitive groups');
  return tr('воздух вредный', 'unhealthy air');
}

// Час между соседними значениями; последний час плавно переходит в первый, поэтому петля без скачка
export function atHour(hours: Hour[], h: number): Hour {
  const i = Math.floor(h) % hours.length;
  const k = h - Math.floor(h);
  const [a, b] = [hours[i], hours[(i + 1) % hours.length]];
  const mix = (x: number, y: number) => x + (y - x) * k;
  return {
    t: hours[0].t + h * HOUR_MS,
    temp: mix(a.temp, b.temp),
    rain: mix(a.rain, b.rain),
    mm: mix(a.mm, b.mm),
    wind: mix(a.wind, b.wind),
    cloud: mix(a.cloud, b.cloud),
    aqi: a.aqi === null || b.aqi === null ? (a.aqi ?? b.aqi) : mix(a.aqi, b.aqi),
  };
}

// height: −1 глубокая ночь, 0 горизонт, 1 полдень. across: 0 восток, 1 запад, ночью путь идёт обратно
export function sunOrbit(t: number, sunrise: number, sunset: number): { height: number; across: number } {
  const light = sunset - sunrise;
  const since = (((t - sunrise) % DAY_MS) + DAY_MS) % DAY_MS;
  if (since <= light) return { height: Math.sin((Math.PI * since) / light), across: since / light };
  const dark = (since - light) / (DAY_MS - light);
  return { height: -Math.sin(Math.PI * dark), across: 1 - dark };
}

function smooth(values: number[], radius: number): number[] {
  const n = values.length;
  return values.map((_, i) => {
    let sum = 0;
    let weight = 0;
    for (let j = -radius; j <= radius; j++) {
      const w = radius + 1 - Math.abs(j);
      sum += values[(i + j + n) % n] * w;
      weight += w;
    }
    return sum / weight;
  });
}

function upsample(values: number[]): number[] {
  const out: number[] = [];
  values.forEach((v, i) => {
    const next = values[(i + 1) % values.length];
    for (let s = 0; s < STEPS_PER_HOUR; s++) out.push(v + ((next - v) * s) / STEPS_PER_HOUR);
  });
  return out;
}

export interface Point {
  x: number;
  y: number;
}

// Завтра в этот час не так, как сегодня: последние часы плавно подводятся к началу, иначе на стыке петли будет излом
export function closeLoop(values: number[], span: number): number[] {
  const n = values.length;
  const gap = values[0] - values[n - 1];
  return values.map((v, i) => {
    const k = clamp((i - (n - span)) / (span - 1), 0, 1);
    return v + gap * k * k * (3 - 2 * k);
  });
}

// Русло — температура: шаг на градус общий для всех городов, поэтому ровные сутки и правда выглядят ровными.
// Только сутки с размахом больше 14° сжимаются, чтобы река осталась на листе. Час всегда занимает одну высоту.
export function riverPath(temps: number[]): { path: Point[]; period: number } {
  const [lo, hi] = [Math.min(...temps), Math.max(...temps)];
  const scale = Math.min(UNITS_PER_DEGREE, BAND_MAX_W / Math.max(1e-9, hi - lo));
  const cx = ART.x + ART.w / 2;
  return {
    path: temps.map((t, i) => ({ x: cx + (t - (lo + hi) / 2) * scale, y: ((i + 1) / temps.length) * ART.h })),
    period: ART.h,
  };
}

// Кольца вокруг солнца: чистый воздух без колец, дальше новое кольцо на каждые 50 пунктов индекса
export function airRings(aqi: number | null): number {
  return clamp(((aqi ?? 0) - 50) / 50, 0, MAX_AIR_RINGS);
}

interface Course {
  path: Point[];
  period: number;
  rain: number[];
  wind: number[];
}

interface Sample extends Point {
  rain: number;
  wind: number;
  hour: number;
}

function course(hours: Hour[]): Course {
  const series = (pick: (h: Hour) => number, radius: number) => smooth(upsample(hours.map(pick)), radius);
  return {
    ...riverPath(smooth(closeLoop(upsample(hours.map((h) => h.temp)), STEPS_PER_HOUR * SEAM_HOURS), STEPS_PER_HOUR * 2)),
    rain: series((h) => h.rain, STEPS_PER_HOUR),
    wind: series((h) => h.wind, STEPS_PER_HOUR),
  };
}

// Река течёт вниз: у нижнего края листа играющий час, выше по течению следующие часы
export function reach({ path, period, rain, wind }: Course, h: number): Sample[] {
  const n = path.length;
  const at = (i: number) => path[((i % n) + n) % n].y + Math.floor(i / n) * period;
  const f = h * STEPS_PER_HOUR;
  const i0 = Math.floor(f);
  const base = at(i0) + (at(i0 + 1) - at(i0)) * (f - i0);
  const samples: Sample[] = [];
  for (let i = i0 - STEPS_PER_HOUR * 4; i < i0 + n * 3; i++) {
    const j = ((i % n) + n) % n;
    const y = BOTTOM - (at(i) - base);
    samples.push({ x: path[j].x, y, rain: rain[j], wind: wind[j], hour: j / STEPS_PER_HOUR });
    if (y < ART.y - 16) break;
  }
  return samples;
}

// Ветер сильнее — линий больше: крайние линии проявляются и сходят на нет прямо вдоль русла
export function lineVisibility(slot: number, wind: number): number {
  const count = clamp(3 + wind / 4, 3, LINE_SLOTS);
  return clamp(count / 2 - Math.abs(slot - (LINE_SLOTS - 1) / 2) + 0.5, 0, 1);
}

// Количество и скорость разведены: морось редкая и медленная, быстрым дождь становится только после 1 мм в час
export function precipFeel(rain: number, mm: number): { share: number; speed: number; length: number } {
  const share = (rain / 100) ** 2;
  const calm = clamp(rain / CALM_RAIN, 0, 1);
  const fast = clamp((rain - CALM_RAIN) / (100 - CALM_RAIN), 0, 1);
  const heavy = fast * Math.min(mm, 6);
  return {
    share,
    speed: DRIFT_SPEED + (CALM_SPEED - DRIFT_SPEED) * calm + (DOWNPOUR_SPEED - CALM_SPEED) * fast + heavy * 10,
    length: 0.5 + calm * 0.7 + fast * 1.8 + heavy * 0.4,
  };
}

function scatter(count: number): Point[] {
  let seed = 11;
  const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  return Array.from({ length: count }, () => ({ x: ART.x + next() * ART.w, y: ART.y + next() * ART.h }));
}

const DROPS = scatter(MAX_DROPS);

export class Weather implements Poster {
  readonly service = tr('Погода', 'Weather');
  readonly source = 'MET Norway';
  readonly kind = tr('другой город', 'another city');
  readonly align = 'right';
  readonly feeds = [new Feed('MET Norway', 40 * 60_000)];
  readonly encoding: Encoding = {
    color: tr('Бумага теплеет с температурой часа, сереет от облаков, а после заката лист уходит в ночь.', 'The paper warms with the temperature of the hour, greys with cloud, and after sunset the sheet slips into night.'),
    form: tr('Река — 24 часа прогноза, все часы одной высоты. Русло — температура: теплее вправо, холоднее влево, шаг на градус общий для всех городов. Больше ветра — больше линий, осадки их утолщают. Солнце мельчает при облаках, ночью становится кольцом. Кольца вокруг него — загрязнение воздуха, новое на каждые 50 пунктов индекса выше 50.', 'The river is 24 hours of forecast, every hour the same height. Its course is temperature: warmer to the right, colder to the left, with one step per degree for all cities. More wind means more lines, rain thickens them. The sun shrinks under cloud and becomes a ring at night. Rings around it are air pollution, a new one for every 50 index points above 50.'),
    speed: tr('Час прогноза — секунда, петля 24 секунды, нижний край листа — играющий час. Ветер ускоряет рябь и наклоняет дождь. До 1 мм в час капли редкие и медленные, выше дождь густеет и разгоняется. При +0,5° и ниже идёт снег.', 'An hour of forecast is a second, the loop 24 seconds, the bottom edge of the sheet the hour now playing. Wind speeds the ripple and tilts the rain. Below 1 mm an hour drops are rare and slow, above that the rain thickens and quickens. At +0.5° and below it snows.'),
  };

  private place = famous(CITIES);
  private settled = false;
  private refresh = () => {};
  private forecast: Forecast | null = null;
  private course: Course | null = null;
  private origin = 0;
  private shown: Sample[] = [];
  private ripple = 0;
  private fall = 0;

  private playhead(now: number): number {
    return (((now - this.origin) / 1000 / SEC_PER_HOUR) % LOOP_HOURS + LOOP_HOURS) % LOOP_HOURS;
  }

  private moment(now: number): { hour: Hour; height: number; across: number; night: number } | null {
    const f = this.forecast;
    if (!f) return null;
    const hour = atHour(f.hours, this.playhead(now));
    const { height, across } = sunOrbit(hour.t, f.sunrise, f.sunset);
    return { hour, height, across, night: clamp(0.5 - height * 3.5, 0, 1) };
  }

  paper(): string {
    const m = this.moment(Date.now());
    if (!m) return tempPaper(10);
    const day = mixHex(tempPaper(m.hour.temp), OVERCAST, (m.hour.cloud / 100) * 0.3);
    return mixHex(day, NIGHT, m.night * 0.94);
  }

  get ink(): string {
    return mixHex(INK, MOONLIGHT, this.moment(Date.now())?.night ?? 0);
  }

  start(): void {
    void locate().then((spot) => {
      if (spot && !this.settled) this.place = nearest(CITIES, spot);
      this.settled = true;
      this.refresh = poll(
        this.feeds[0],
        POLL_MS,
        () => {
          const place = this.place;
          const air = `latitude=${place.lat}&longitude=${place.lon}&forecast_hours=${LOOP_HOURS}&timeformat=unixtime&hourly=us_aqi`;
          return Promise.all([
            place,
            getJson<MetForecast>(`/api/metno/weatherapi/locationforecast/2.0/complete?lat=${place.lat}&lon=${place.lon}`),
            getJson<AirForecast>(`/api/air/v1/air-quality?${air}`).catch(() => null),
          ]);
        },
        ([place, met, air]) => {
          if (!this.forecast) this.origin = Date.now();
          this.forecast = parseWeather(place, met, air);
          this.course = course(this.forecast.hours);
        },
      );
    });
  }

  shuffle(rand?: () => number): void {
    this.place = famous(CITIES, this.place, rand);
    this.settled = true;
    this.forecast = this.course = null;
    this.shown = [];
    this.feeds[0].reset();
    this.refresh();
  }

  private clock(t: number): string {
    const time = new Intl.DateTimeFormat(LOCALE, { timeZone: this.place.tz, hour: '2-digit', minute: '2-digit' });
    return time.format(t - (t % HOUR_MS));
  }

  private rainText(mm: number): string {
    return mm < NO_RAIN_MM ? tr('без осадков', 'no rain') : tr(`осадки ${fmtDec(mm)} мм`, `rain ${fmtDec(mm)} mm`);
  }

  where(): City | null {
    return this.settled ? this.place : null;
  }

  label(now: number): Label {
    const m = this.moment(now);
    if (!m) return { title: this.settled ? tr(this.place.name, this.place.en) : this.service, print: tr('Прогноз на сутки', '24-hour forecast') };
    const { hour } = m;
    const parts = [this.clock(hour.t), fmtTemp(hour.temp), tr(`ветер ${fmtInt(hour.wind)} км/ч`, `wind ${fmtInt(hour.wind)} km/h`), this.rainText(hour.mm)];
    if (hour.aqi !== null) parts.push(aqiLabel(hour.aqi));
    return { title: tr(this.place.name, this.place.en), print: `${parts.join(' · ')}. ${tr('Час прогноза за секунду.', 'An hour of forecast per second.')}` };
  }

  private lines(ctx: CanvasRenderingContext2D, samples: Sample[], ink: string): void {
    ctx.fillStyle = ink;
    for (let k = 0; k < LINE_SLOTS; k++) {
      const shift = (k - (LINE_SLOTS - 1) / 2) * LINE_GAP;
      const side = (i: number, sign: number) => {
        const s = samples[i];
        const amp = 0.02 + Math.min(s.wind, 60) * 0.0045;
        const wave = amp * (Math.sin(s.hour * 1.02 * Math.PI * 2 + k * 1.9 - this.ripple) + Math.sin(s.hour * Math.PI * 0.72 - this.ripple * 0.6 + k));
        const half = (0.24 + precipFeel(s.rain, 0).share * 0.62) * lineVisibility(k, s.wind);
        // Сдвиг вдоль времени невозможен, поэтому линии расходятся по горизонтали: на крутом изгибе они не пересекаются
        return { x: s.x + shift + wave + half * sign, y: s.y };
      };
      ctx.beginPath();
      for (let i = 0; i < samples.length; i++) {
        const p = side(i, 1);
        if (i) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      }
      for (let i = samples.length - 1; i >= 0; i--) {
        const p = side(i, -1);
        ctx.lineTo(p.x, p.y);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  private precipitation(ctx: CanvasRenderingContext2D, hour: Hour, ink: string): void {
    const { share, length } = precipFeel(hour.rain, hour.mm);
    const count = Math.round(share * MAX_DROPS);
    const snow = hour.temp <= 0.5;
    const slant = Math.min(hour.wind, 50) * 0.018;
    const wrap = (v: number, from: number, size: number) => from + (((v - from) % size) + size) % size;
    ctx.fillStyle = ink;
    ctx.strokeStyle = alpha(ink, 0.8);
    ctx.lineWidth = 0.16;
    ctx.beginPath();
    for (const p of DROPS.slice(0, count)) {
      const y = wrap(p.y + this.fall, ART.y, ART.h);
      const x = wrap(p.x - (y - ART.y) * slant, ART.x, ART.w);
      if (snow) {
        ctx.moveTo(x + 0.3, y);
        ctx.arc(x, y, 0.3, 0, Math.PI * 2);
      } else {
        ctx.moveTo(x, y);
        ctx.lineTo(x - length * slant, y + length);
      }
    }
    if (snow) ctx.fill();
    else ctx.stroke();
  }

  draw({ ctx, now, dt }: Frame): void {
    const m = this.moment(now);
    const way = this.course;
    const f = this.forecast;
    if (!m || !way || !f) return waiting(ctx, this.ink);

    const { hour, height, across } = m;
    const ink = this.ink;
    this.ripple += dt * hour.wind * 0.3;
    this.fall += dt * precipFeel(hour.rain, hour.mm).speed * (hour.temp <= 0.5 ? SNOW_PACE : 1);

    ctx.save();
    clipArt(ctx);
    this.precipitation(ctx, hour, ink);

    this.shown = reach(way, this.playhead(now));
    this.lines(ctx, this.shown, ink);

    const x = SUN_LEFT + (SUN_RIGHT - SUN_LEFT) * across;
    const y = ART.y + ART.h * (0.5 - height * 0.34);
    const r = 12 - (hour.cloud / 100) * 5.5;
    disc(ctx, x, y, r, ink);
    disc(ctx, x, y, r * clamp(-height * 7, 0, 0.92), this.paper());
    const rings = airRings(hour.aqi);
    ctx.lineWidth = 0.3;
    for (let i = 0; i < rings; i++) {
      ctx.strokeStyle = alpha(ink, Math.min(1, rings - i));
      ctx.beginPath();
      ctx.arc(x, y, r + AIR_RING_GAP * (i + 1), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  pick(x: number, y: number): Tip | null {
    const f = this.forecast;
    if (!f) return null;
    let best: Sample | null = null;
    let bestDist = 9;
    for (const s of this.shown) {
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bestDist) {
        best = s;
        bestDist = d;
      }
    }
    if (!best) return null;
    const hour = f.hours[Math.floor(best.hour) % f.hours.length];
    return {
      value: this.clock(hour.t),
      label: `${fmtTemp(hour.temp)} · ${tr(`ветер ${fmtInt(hour.wind)} км/ч`, `wind ${fmtInt(hour.wind)} km/h`)} · ${this.rainText(hour.mm)}`,
    };
  }
}
