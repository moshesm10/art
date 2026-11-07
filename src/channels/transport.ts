import { RADAR_RADIUS_NM, RADARS } from '../config';
import { fmtInt, word } from '../lib/format';
import { tr } from '../lib/i18n';
import type { Spot } from '../lib/locate';
import { Feed, getJson, poll } from '../lib/net';
import { ART, clipArt, disc, waiting, type Encoding, type Frame, type Label, type Poster, type Tip } from '../lib/poster';
import { clamp, ease, glide, median, other, type Glide } from '../lib/stats';
import { INK } from '../lib/theme';

const MAX_ALT_M = 12_500;
const FT_TO_M = 0.3048;
const KT_TO_KMH = 1.852;
const LEVEL_FPM = 300;
const BANDS = 10;
const CX = 50;
const CY = 56;
const R_INNER = 5.2;
const R_GAP = 3.2;
const BOTTOM = ART.y + ART.h;
const LAP_SEC = 90;
const CRUISE_KT = 450;
const DISC_GLIDE_SEC = 2.2;
const DISC_NEAR = 15;
const DISC_FAR = 34;
const ARCH_MIN_W = 0.26;
const ARCH_MAX_W = 2.8;

const PAPER = '#ebe6df';
const TEAL = '#477a84';
const SUN = '#e9b54e';
const CLAY = '#b5683a';
const RUST = '#8e4a24';

export interface Plane {
  hex: string;
  flight: string;
  type: string;
  lat: number;
  lon: number;
  altM: number;
  knots: number;
  track: number;
  climbFpm: number;
}

interface RawAircraft {
  hex: string;
  flight?: string;
  t?: string;
  lat?: number;
  lon?: number;
  alt_baro?: number | 'ground';
  gs?: number;
  track?: number;
  baro_rate?: number;
}

export function parseAircraft(json: { ac?: RawAircraft[] }): Plane[] {
  const planes: Plane[] = [];
  for (const a of json.ac ?? []) {
    if (a.lat === undefined || a.lon === undefined || typeof a.alt_baro !== 'number') continue;
    planes.push({
      hex: a.hex,
      flight: a.flight?.trim() || a.hex.toUpperCase(),
      type: a.t ?? '—',
      lat: a.lat,
      lon: a.lon,
      altM: a.alt_baro * FT_TO_M,
      knots: a.gs ?? 0,
      track: a.track ?? 0,
      climbFpm: a.baro_rate ?? 0,
    });
  }
  return planes;
}

// Пеленг от центра радара в градусах: 0 на север, по часовой стрелке
export function bearing(lat: number, lon: number, center: { lat: number; lon: number }): number {
  const x = (lon - center.lon) * Math.cos((center.lat * Math.PI) / 180);
  const y = lat - center.lat;
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

export const bandOf = (altM: number) => clamp(Math.floor((altM / MAX_ALT_M) * BANDS), 0, BANDS - 1);

export type Phase = 'climb' | 'level' | 'descent';

export function phaseOf(climbFpm: number): Phase {
  if (climbFpm > LEVEL_FPM) return 'climb';
  return climbFpm < -LEVEL_FPM ? 'descent' : 'level';
}

// Средний пеленг на окружности: у 350° и 10° среднее 0°, а не 180°
export function meanBearing(values: number[]): number | null {
  if (!values.length) return null;
  const rad = (d: number) => (d * Math.PI) / 180;
  const x = values.reduce((sum, v) => sum + Math.sin(rad(v)), 0);
  const y = values.reduce((sum, v) => sum + Math.cos(rad(v)), 0);
  return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

// Сплочённость пеленгов: 1 — все с одной стороны, 0 — равномерно вокруг и средний пеленг ничего не значит
export function bearingFocus(values: number[]): number {
  if (!values.length) return 0;
  const rad = (d: number) => (d * Math.PI) / 180;
  const x = values.reduce((sum, v) => sum + Math.sin(rad(v)), 0);
  const y = values.reduce((sum, v) => sum + Math.cos(rad(v)), 0);
  return Math.hypot(x, y) / values.length;
}

// Кратчайшая дуга: с 350° на 10° диск идёт через север, а не обратно через весь круг
export function shortestTurn(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

// Арка как развёрнутый компас: юг у левой ножки, север в зените, снова юг у правой
export function archPoint(radius: number, p: number): { x: number; y: number } {
  const straight = BOTTOM - CY;
  const arc = Math.PI * radius;
  const s = clamp(p, 0, 1) * (straight * 2 + arc);
  if (s < straight) return { x: CX - radius, y: BOTTOM - s };
  if (s < straight + arc) {
    const angle = (s - straight) / radius;
    return { x: CX - radius * Math.cos(angle), y: CY - radius * Math.sin(angle) };
  }
  return { x: CX + radius, y: CY + (s - straight - arc) };
}

const PHASE_INK: Record<Phase, string> = { climb: SUN, level: INK, descent: CLAY };

const bandRadius = (band: number) => R_INNER + band * R_GAP;

interface Bead {
  plane: Plane;
  p: number;
  dir: number;
  radius: number;
  x: number;
  y: number;
}

export class Transport implements Poster {
  readonly service = tr('Небо', 'Sky');
  readonly source = 'adsb.lol · ADS-B';
  readonly kind = tr('другой аэропорт', 'another airport');
  readonly align = 'left';
  readonly ink = INK;
  readonly feeds = [new Feed('adsb.lol', 45_000)];
  readonly encoding: Encoding = {
    color: tr('Бирюзовый диск — борта на эшелоне, жёлтый — в наборе, терракотовый — на снижении, бусины окрашены так же. Ржавая колонна — медианная высота.', 'The turquoise disc is aircraft at cruise, yellow climbing, terracotta descending; beads are coloured the same. The rust column is the median altitude.'),
    form: tr('Десять арок — высоты от земли до 12,5 км, толщина пропорциональна числу бортов. Площадь диска — доля бортов. Жёлтый и терракотовый стоят на среднем пеленге: чем дальше от центра, тем дружнее борта идут с этой стороны. Диски плавно плывут к новым значениям за несколько секунд.', 'Ten arches are altitudes from the ground to 12.5 km, their thickness proportional to the number of aircraft. A disc\'s area is the share of aircraft. Yellow and terracotta sit on the mean bearing: the farther from the centre, the more aircraft come from that side together. Discs drift to new values over a few seconds.'),
    speed: tr('Бусина — настоящий борт. Появляется на арке по пеленгу и бежит со скоростью самолёта: на восток вправо, на запад влево.', 'A bead is a real aircraft. It appears on an arch by its bearing and runs at the speed of the plane: right for east, left for west.'),
  };

  private radar = RADARS[0];
  private refresh = () => {};
  private planes: Plane[] = [];
  private beads = new Map<string, Bead>();
  private discs = {
    level: { x: 0, v: 0 },
    climb: { x: 0, v: 0 },
    descent: { x: 0, v: 0 },
    climbAt: { x: 90, v: 0 },
    descentAt: { x: 270, v: 0 },
    climbReach: { x: 0, v: 0 },
    descentReach: { x: 0, v: 0 },
  };

  paper(): string {
    return PAPER;
  }

  start(): void {
    const url = () => `/api/adsb/v2/lat/${this.radar.lat}/lon/${this.radar.lon}/dist/${RADAR_RADIUS_NM}`;
    this.refresh = poll(this.feeds[0], 5_000, () => getJson<{ ac?: RawAircraft[] }>(url()), (json) => this.merge(parseAircraft(json)));
  }

  shuffle(rand?: () => number): void {
    this.radar = other(RADARS, this.radar, rand);
    this.planes = [];
    this.beads = new Map();
    this.feeds[0].reset();
    this.refresh();
  }

  private merge(planes: Plane[]): void {
    this.planes = planes;
    const next = new Map<string, Bead>();
    for (const plane of planes) {
      const known = this.beads.get(plane.hex);
      if (known) {
        known.plane = plane;
        next.set(plane.hex, known);
        continue;
      }
      const b = bearing(plane.lat, plane.lon, this.radar);
      const p = (b > 180 ? b - 360 : b) / 360 + 0.5;
      const radius = bandRadius(bandOf(plane.altM));
      next.set(plane.hex, { plane, p, dir: plane.track < 180 ? 1 : -1, radius, x: 0, y: 0 });
    }
    this.beads = next;
  }

  where(): Spot {
    return this.radar;
  }

  label(): Label {
    const n = this.planes.length;
    const title = tr(this.radar.name, this.radar.en);
    if (!n) return { title, print: tr(`Радиус ${RADAR_RADIUS_NM} морских миль вокруг ${this.radar.around}`, `${RADAR_RADIUS_NM} nautical miles around ${this.radar.en}`) };
    const altitude = median(this.planes.map((p) => p.altM)) ?? 0;
    const planes = word(n, ['борт', 'борта', 'бортов'], ['aircraft', 'aircraft']);
    return { title, print: tr(`${fmtInt(n)} ${planes} в радиусе ${RADAR_RADIUS_NM} морских миль вокруг ${this.radar.code} · медианная высота ${fmtInt(altitude)} м`, `${fmtInt(n)} ${planes} within ${RADAR_RADIUS_NM} nautical miles of ${this.radar.code} · median altitude ${fmtInt(altitude)} m`) };
  }

  private drawDiscs(ctx: CanvasRenderingContext2D, dt: number): void {
    const groups: Record<Phase, Plane[]> = { climb: [], level: [], descent: [] };
    for (const p of this.planes) groups[phaseOf(p.climbFpm)].push(p);
    const total = this.planes.length;
    const size = (n: number) => Math.sqrt(n / total);
    // Пока диска не видно, он сразу встаёт на место, а дальше только плывёт вслед за данными
    const steer = (angle: Glide, radius: number, group: Plane[]) => {
      const target = meanBearing(group.map((p) => bearing(p.lat, p.lon, this.radar)));
      if (target === null) return glide(angle, angle.x, dt, DISC_GLIDE_SEC);
      const goal = angle.x + shortestTurn(angle.x, target);
      if (radius < 0.5) Object.assign(angle, { x: goal, v: 0 });
      else glide(angle, goal, dt, DISC_GLIDE_SEC);
    };

    const d = this.discs;
    const focus = (group: Plane[]) => bearingFocus(group.map((p) => bearing(p.lat, p.lon, this.radar)));
    steer(d.climbAt, d.climb.x, groups.climb);
    steer(d.descentAt, d.descent.x, groups.descent);
    glide(d.climbReach, focus(groups.climb), dt, DISC_GLIDE_SEC);
    glide(d.descentReach, focus(groups.descent), dt, DISC_GLIDE_SEC);
    glide(d.level, size(groups.level.length) * 50, dt, DISC_GLIDE_SEC);
    glide(d.climb, size(groups.climb.length) * 36, dt, DISC_GLIDE_SEC);
    glide(d.descent, size(groups.descent.length) * 36, dt, DISC_GLIDE_SEC);

    const around = (deg: number, r: number, focused: number) => {
      const reach = DISC_NEAR + (DISC_FAR - DISC_NEAR) * focused;
      return {
        x: clamp(CX + Math.sin((deg * Math.PI) / 180) * reach, ART.x + r, ART.x + ART.w - r),
        y: CY - 4 - Math.cos((deg * Math.PI) / 180) * reach,
      };
    };
    disc(ctx, CX, ART.y - 4, d.level.x, TEAL);
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    const climb = around(d.climbAt.x, d.climb.x, d.climbReach.x);
    const descent = around(d.descentAt.x, d.descent.x, d.descentReach.x);
    disc(ctx, climb.x, climb.y, d.climb.x, SUN);
    disc(ctx, descent.x, descent.y, d.descent.x, CLAY);
    ctx.restore();
  }

  draw({ ctx, dt }: Frame): void {
    if (!this.planes.length) return waiting(ctx, this.ink);

    ctx.save();
    clipArt(ctx);
    this.drawDiscs(ctx, dt);

    const counts = new Array<number>(BANDS).fill(0);
    for (const p of this.planes) counts[bandOf(p.altM)]++;
    const peak = Math.max(...counts);
    ctx.strokeStyle = this.ink;
    ctx.lineCap = 'butt';
    counts.forEach((n, band) => {
      const r = bandRadius(band);
      ctx.lineWidth = ARCH_MIN_W + (ARCH_MAX_W - ARCH_MIN_W) * (n / peak);
      ctx.beginPath();
      ctx.moveTo(CX - r, BOTTOM + 1);
      ctx.lineTo(CX - r, CY);
      ctx.arc(CX, CY, r, Math.PI, 0);
      ctx.lineTo(CX + r, BOTTOM + 1);
      ctx.stroke();
    });

    const altitude = median(this.planes.map((p) => p.altM)) ?? 0;
    const top = BOTTOM - clamp(altitude / MAX_ALT_M, 0.08, 1) * (BOTTOM - CY + R_INNER - 1.8);
    ctx.fillStyle = RUST;
    ctx.beginPath();
    ctx.roundRect(CX - 2.5, top, 5, BOTTOM - top + 4, [2.5, 2.5, 0, 0]);
    ctx.fill();

    const k = ease(dt, 1);
    for (const bead of this.beads.values()) {
      const { knots, altM, climbFpm } = bead.plane;
      bead.radius += (bandRadius(bandOf(altM)) - bead.radius) * k;
      bead.p += (bead.dir * dt * knots) / CRUISE_KT / LAP_SEC;
      if (bead.p > 1 || bead.p < 0) {
        bead.dir = -bead.dir;
        bead.p = clamp(bead.p, 0, 1);
      }
      const { x, y } = archPoint(bead.radius, bead.p);
      bead.x = x;
      bead.y = y;
      disc(ctx, x, y, 0.8, PAPER);
      disc(ctx, x, y, 0.52, PHASE_INK[phaseOf(climbFpm)]);
    }
    ctx.restore();
  }

  pick(x: number, y: number): Tip | null {
    let best: Bead | null = null;
    let bestDist = 3;
    for (const bead of this.beads.values()) {
      const d = Math.hypot(bead.x - x, bead.y - y);
      if (d < bestDist) {
        best = bead;
        bestDist = d;
      }
    }
    if (!best) return null;
    const p = best.plane;
    return { value: p.flight, label: `${p.type} · ${fmtInt(p.altM)} ${tr('м', 'm')} · ${fmtInt(p.knots * KT_TO_KMH)} ${tr('км/ч', 'km/h')}` };
  }
}
