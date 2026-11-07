import { SEISMIC_RADIUS_KM, STATIONS } from '../config';
import { fmtClock, fmtDec, fmtInt, word } from '../lib/format';
import { LOCALE, tr } from '../lib/i18n';
import type { Spot } from '../lib/locate';
import { Feed, getJson, poll } from '../lib/net';
import { ART, disc, type Encoding, type Frame, type Label, type Poster, type Tip } from '../lib/poster';
import { other } from '../lib/stats';
import { alpha, INK } from '../lib/theme';

const WEEK_MS = 7 * 86_400_000;
const LOOP_MS = 42_000;
const RIPPLE_MS = 2200;
const EARTH_KM = 6371;
const CX = 50;
const CY = ART.y + ART.h / 2;
const R_MAP = 41.5;
const RING_KM = 1000;
const DAYS = 7;
const GHOST = 0.16;
const SETTLED = 0.5;
const AFTERGLOW_MS = 1.5 * 86_400_000;

const PAPER = '#efe9dd';
const SHALLOW = '#ec5f3f';
const MIDDLE = '#f2b632';
const DEEP = '#2f6fa8';

export interface Quake {
  id: string;
  mag: number;
  place: string;
  time: number;
  lon: number;
  lat: number;
  depthKm: number;
}

interface RawQuakes {
  features: {
    id: string;
    properties: { mag: number | null; place: string | null; time: number };
    geometry: { coordinates: [number, number, number] };
  }[];
}

export function parseQuakes(json: RawQuakes): Quake[] {
  return json.features
    .filter((f) => f.properties.mag !== null)
    .map((f) => ({
      id: f.id,
      mag: f.properties.mag as number,
      place: f.properties.place ?? tr('неизвестно', 'unknown'),
      time: f.properties.time,
      lon: f.geometry.coordinates[0],
      lat: f.geometry.coordinates[1],
      depthKm: f.geometry.coordinates[2],
    }))
    .sort((a, b) => a.time - b.time);
}

export function quakeRadius(mag: number): number {
  return Math.max(0.55, mag * mag * 0.15);
}

export function depthInk(km: number): string {
  if (km < 70) return SHALLOW;
  return km < 300 ? MIDDLE : DEEP;
}

// Толчок ещё впереди — тень, в момент удара полная краска, за полтора дня она оседает: видны серии и афтершоки
export function presence(sinceMs: number): number {
  if (sinceMs < 0) return GHOST;
  return SETTLED + (1 - SETTLED) * Math.max(0, 1 - sinceMs / AFTERGLOW_MS);
}

// Азимутальная проекция: расстояние и направление от точки наблюдения сохраняются честно
export function azimuthal(lat: number, lon: number, center: { lat: number; lon: number }): { km: number; bearing: number } {
  const rad = Math.PI / 180;
  const [p1, p2, dl] = [center.lat * rad, lat * rad, (lon - center.lon) * rad];
  const cos = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dl);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return { km: Math.acos(Math.min(1, Math.max(-1, cos))) * EARTH_KM, bearing: Math.atan2(y, x) };
}

const REPLAY_DAY = new Intl.DateTimeFormat(LOCALE, { weekday: 'short', day: 'numeric', month: 'long' });

interface Mark {
  quake: Quake;
  x: number;
  y: number;
  r: number;
}

export class Sensors implements Poster {
  readonly service = tr('Земля', 'Earth');
  readonly source = 'USGS';
  readonly kind = tr('другая точка наблюдения', 'another viewpoint');
  readonly align = 'right';
  readonly ink = INK;
  readonly feeds = [new Feed('USGS', 15 * 60_000)];
  readonly encoding: Encoding = {
    color: tr('Глубина очага: красный — до 70 км, жёлтый — до 300 км, синий — глубже. Где толчки накладываются, краска темнеет.', 'Depth of the focus: red down to 70 km, yellow down to 300 km, blue deeper. Where quakes overlap, the paint darkens.'),
    form: tr('Диск — толчок сильнее M 2,5 за неделю, площадь растёт с магнитудой. Положение честное: направление и расстояние от точки наблюдения, кольца — каждая тысяча километров.', 'A disc is a quake above M 2.5 in the past week, its area growing with magnitude. Position is true: direction and distance from the viewpoint, with a ring for every thousand kilometres.'),
    speed: tr('Неделя проигрывается за 42 секунды, засечки на внешнем кольце — дни. Диск ждёт бледной тенью, вспыхивает в момент толчка с волной вокруг и оседает: серии и афтершоки видны как вспышки подряд.', 'The week replays in 42 seconds; ticks on the outer ring are days. A disc waits as a pale shadow, flares at the moment of the quake with a wave around it, then settles: swarms and aftershocks show as flashes in a row.'),
  };

  private station = STATIONS[0];
  private quakes: Quake[] = [];
  private marks: Mark[] = [];
  private loaded = false;

  paper(): string {
    return PAPER;
  }

  start(): void {
    poll(
      this.feeds[0],
      300_000,
      () => getJson<RawQuakes>('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson'),
      (json) => {
        this.quakes = parseQuakes(json);
        this.loaded = true;
        this.project();
      },
    );
  }

  shuffle(rand?: () => number): void {
    this.station = other(STATIONS, this.station, rand);
    this.project();
  }

  private project(): void {
    this.marks = this.quakes.flatMap((quake) => {
      const { km, bearing } = azimuthal(quake.lat, quake.lon, this.station);
      if (km > SEISMIC_RADIUS_KM) return [];
      const d = (km / SEISMIC_RADIUS_KM) * R_MAP;
      return [{ quake, x: CX + Math.sin(bearing) * d, y: CY - Math.cos(bearing) * d, r: quakeRadius(quake.mag) }];
    });
  }

  private head(now: number): number {
    return now - WEEK_MS + ((now % LOOP_MS) / LOOP_MS) * WEEK_MS;
  }

  where(): Spot {
    return this.station;
  }

  label(now: number): Label {
    const title = tr(this.station.name, this.station.en);
    if (!this.loaded) return { title, print: tr('Толчки за неделю', 'Quakes this week') };
    const n = this.marks.length;
    const radius = fmtInt(SEISMIC_RADIUS_KM);
    const quakes = word(n, ['толчок', 'толчка', 'толчков'], ['quake', 'quakes']);
    const count = tr(`${fmtInt(n)} ${quakes} за неделю в ${radius} км вокруг ${this.station.around}`, `${fmtInt(n)} ${quakes} this week within ${radius} km of ${this.station.en}`);
    if (!n) return { title, print: count };
    const top = this.marks.reduce((a, b) => (b.quake.mag > a.quake.mag ? b : a)).quake;
    return { title, print: `${REPLAY_DAY.format(this.head(now))} · ${count}. ${tr('Сильнейший', 'Strongest')} M ${fmtDec(top.mag)}, ${top.place}` };
  }

  draw({ ctx, now }: Frame): void {
    ctx.strokeStyle = alpha(this.ink, 0.55);
    ctx.lineWidth = 0.14;
    for (let km = RING_KM; km <= SEISMIC_RADIUS_KM; km += RING_KM) {
      ctx.beginPath();
      ctx.arc(CX, CY, (km / SEISMIC_RADIUS_KM) * R_MAP, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Часы повтора: точка обходит внешнее кольцо за неделю, засечки отмеряют дни
    const k = (now % LOOP_MS) / LOOP_MS;
    const head = this.head(now);
    for (let day = 0; day < DAYS; day++) {
      const a = (day / DAYS) * Math.PI * 2 - Math.PI / 2;
      ctx.beginPath();
      ctx.moveTo(CX + Math.cos(a) * R_MAP, CY + Math.sin(a) * R_MAP);
      ctx.lineTo(CX + Math.cos(a) * (R_MAP + 1.3), CY + Math.sin(a) * (R_MAP + 1.3));
      ctx.stroke();
    }

    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    for (const m of this.marks) {
      ctx.globalAlpha = presence(head - m.quake.time);
      disc(ctx, m.x, m.y, m.r, depthInk(m.quake.depthKm));
    }
    ctx.restore();

    for (const m of this.marks) {
      const age = ((head - m.quake.time) / WEEK_MS) * LOOP_MS;
      if (age < 0 || age > RIPPLE_MS) continue;
      const t = age / RIPPLE_MS;
      ctx.strokeStyle = alpha(depthInk(m.quake.depthKm), 1 - t);
      ctx.lineWidth = 0.3;
      ctx.beginPath();
      ctx.arc(m.x, m.y, m.r + t * (2 + m.quake.mag * 1.4), 0, Math.PI * 2);
      ctx.stroke();
    }
    const angle = k * Math.PI * 2 - Math.PI / 2;
    disc(ctx, CX + Math.cos(angle) * R_MAP, CY + Math.sin(angle) * R_MAP, 0.8, this.ink);
    disc(ctx, CX, CY, 1.5, this.ink);
  }

  pick(x: number, y: number): Tip | null {
    let best: Mark | null = null;
    let bestDist = 3;
    for (const m of this.marks) {
      const d = Math.hypot(m.x - x, m.y - y) - m.r;
      if (d < bestDist) {
        best = m;
        bestDist = d;
      }
    }
    if (!best) return null;
    const q = best.quake;
    return { value: `M ${fmtDec(q.mag)}`, label: `${q.place} · ${tr(`глубина ${fmtInt(q.depthKm)} км`, `depth ${fmtInt(q.depthKm)} km`)} · ${fmtClock(q.time)}` };
  }
}
