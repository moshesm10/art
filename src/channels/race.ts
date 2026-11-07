import { LOCALE, tr } from '../lib/i18n';
import { Feed, getJson, poll } from '../lib/net';
import { ART, clipArt, disc, waiting, type Encoding, type Frame, type Label, type Poster, type Tip } from '../lib/poster';
import { clamp, glide, other, type Glide } from '../lib/stats';
import { INK, PAPER } from '../lib/theme';

const LOOK = globalThis.location?.search.match(/look=(\w+)/)?.[1] ?? 'a';

const API = 'https://api.openf1.org/v1';
const POLL_MS = 30 * 60_000;
const COLS = 5;
const ROWS = 6;
const CELL_W = ART.w / COLS;
const CELL_H = ART.h / ROWS;
const LAP_SEC = 1;
const RED_SLOWDOWN = 4;
const HOLD_SEC = 5;
const TRAIL_SEC = 0.8;
const TOP_SPEED = 360;
const RPM_LOW = 8000;
const RPM_HIGH = 13000;
const GEARS = 8;
const MIN_DROP = 30;
const ZONE_GAP_MS = 600;
const STAMP_SEC = 0.5;
const STAMP_R = 7.5;
const NEEDLE = 7.5;
const WIDE = 7.5;
const THIN = 0.7;
const NIGHT = '#16264a';
const CREAM = '#f3e9d6';
const RED = '#d8392b';
const YELLOW = '#f0b429';
const PINK = '#f2a7b0';
const BLUE = '#2f6fb0';
const GREEN = '#2e9e6b';

// Команды получают цвета афиши, а не фирменные: порядок по оттенку сохраняет родство с настоящими
const TEAM_INKS = ['#d8392b', '#e8743b', '#f0b429', '#2e8b57', '#14594f', '#58b3c9', '#2f6fb0', '#1f3a7a', '#7a5aa6', '#c2478f', '#f2a7b0'];
const LIGHT_INKS = new Set(['#f0b429', '#58b3c9', '#f2a7b0']);

const LIFE: Record<string, number> = { SOFT: 45, MEDIUM: 55, HARD: 70, INTERMEDIATE: 40, WET: 40 };
const COMPOUNDS: Record<string, string> = { SOFT: tr('мягкие', 'soft'), MEDIUM: tr('средние', 'medium'), HARD: tr('жёсткие', 'hard'), INTERMEDIATE: tr('промежуточные', 'intermediate'), WET: tr('дождевые', 'wet') };

const CITIES: Record<string, string> = {
  Austin: 'Остин', Baku: 'Баку', Barcelona: 'Барселона', Budapest: 'Будапешт', 'Kuala Lumpur': 'Куала-Лумпур', 'Las Vegas': 'Лас-Вегас',
  Lusail: 'Лусаил', Madrid: 'Мадрид', 'Marina Bay': 'Марина-Бей', Melbourne: 'Мельбурн', 'Mexico City': 'Мехико', 'Miami Gardens': 'Майами',
  'Monte Carlo': 'Монте-Карло', Montréal: 'Монреаль', Monza: 'Монца', Shanghai: 'Шанхай', Silverstone: 'Сильверстоун', 'Spa-Francorchamps': 'Спа',
  Spielberg: 'Шпильберг', Suzuka: 'Сузука', 'São Paulo': 'Сан-Паулу', 'Yas Marina': 'Абу-Даби', Zandvoort: 'Зандворт',
};

interface RawSession {
  session_key: number;
  session_name: string;
  location: string;
  date_start: string;
  date_end: string;
  is_cancelled: boolean;
}

interface RawDriver {
  driver_number: number;
  name_acronym: string;
  full_name: string;
  team_name: string;
  team_colour: string | null;
}

export interface RawLap {
  driver_number: number;
  lap_number: number;
  date_start: string | null;
  lap_duration: number | null;
  duration_sector_1?: number | null;
}

interface RawPlace {
  date: string;
  driver_number: number;
  position: number;
}

export interface RawStint {
  driver_number: number;
  stint_number: number;
  lap_start: number;
  lap_end: number;
  compound: string;
  tyre_age_at_start: number;
}

interface RawResult {
  driver_number: number;
  position: number | null;
  number_of_laps: number;
  dnf: boolean;
  dns: boolean;
}

interface RawMessage {
  date: string;
  category: string;
  message: string;
}

export interface RawSpot {
  date: string;
  driver_number: number;
  x: number;
  y: number;
}

export interface RawCar {
  date: string;
  speed: number;
  throttle: number;
  brake: number;
  n_gear: number;
  rpm: number;
}

export interface Race {
  key: number;
  city: string;
  date: number;
}

export type Flag = 'green' | 'vsc' | 'sc' | 'red';

export interface Entry {
  number: number;
  code: string;
  name: string;
  ink: string;
  out: number | null;
  places: { lap: number; position: number }[];
  stints: RawStint[];
}

interface Point {
  t: number;
  x: number;
  y: number;
}

export interface Fit {
  angle: number;
  scale: number;
  cx: number;
  cy: number;
}

export interface Reading {
  t: number;
  speed: number;
  throttle: number;
  brake: number;
  gear: number;
  rpm: number;
}

// Спринты и отменённые гонки не считаем, незаконченная ещё не лежит в архиве
export function parseRaces(sessions: RawSession[], now: number): Race[] {
  return sessions
    .filter((s) => s.session_name === 'Race' && !s.is_cancelled && Date.parse(s.date_end) < now)
    .map((s) => ({ key: s.session_key, city: s.location, date: Date.parse(s.date_start) }))
    .sort((a, b) => a.date - b.date);
}

export const cityName = (city: string) => tr(CITIES[city] ?? city, city);

// Начала кругов лидера и финиш: по ним время гонки превращается в круги, и 40 минут красного флага не тянутся впустую
export function lapClock(laps: RawLap[]): number[] {
  const first = new Map<number, number>();
  for (const lap of laps) {
    if (!lap.date_start) continue;
    const t = Date.parse(lap.date_start);
    if (t < (first.get(lap.lap_number) ?? Infinity)) first.set(lap.lap_number, t);
  }
  const numbers = [...first.keys()].sort((a, b) => a - b);
  const starts = numbers.map((n) => first.get(n)!);
  const last = numbers.at(-1);
  const ends = laps.filter((l) => l.lap_number === last && l.date_start && l.lap_duration).map((l) => Date.parse(l.date_start!) + l.lap_duration! * 1000);
  return starts.length ? [...starts, ends.length ? Math.min(...ends) : starts.at(-1)! + 90_000] : [];
}

export function lapAt(clock: number[], t: number): number {
  if (t <= clock[0]) return 1;
  if (t >= clock.at(-1)!) return clock.length;
  const i = clock.findLastIndex((s) => s <= t);
  return i + 1 + (t - clock[i]) / (clock[i + 1] - clock[i]);
}

export function parseFlags(messages: Pick<RawMessage, 'date' | 'category' | 'message'>[], clock: number[]): { lap: number; flag: Flag }[] {
  const flags: { lap: number; flag: Flag }[] = [{ lap: 1, flag: 'green' }];
  const sorted = [...messages].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  for (const m of sorted) {
    const t = Date.parse(m.date);
    if (t <= clock[0]) continue;
    let flag: Flag | null = null;
    if (m.message.startsWith('RED FLAG')) flag = 'red';
    else if (m.message.startsWith('SAFETY CAR DEPLOYED')) flag = 'sc';
    else if (m.message.startsWith('VSC DEPLOYED')) flag = 'vsc';
    else if (m.message.startsWith('VSC ENDING') || m.message.startsWith('SAFETY CAR IN THIS LAP')) flag = 'green';
    else if (m.category === 'SessionStatus' && m.message.includes('STARTED')) flag = 'green';
    if (flag) flags.push({ lap: lapAt(clock, t), flag });
  }
  return flags;
}

export function flagAt(flags: { lap: number; flag: Flag }[], lap: number): Flag {
  return flags.findLast((f) => f.lap <= lap)?.flag ?? 'green';
}

export const placeAt = (entry: Entry, lap: number) => entry.places.findLast((p) => p.lap <= lap)?.position ?? entry.places[0]?.position ?? 99;

// Сошедшие уходят в конец листа: кто выбыл позже, тот стоит выше
export function standings(entries: Entry[], lap: number): Entry[] {
  const running = entries.filter((e) => e.out === null || lap < e.out);
  const gone = entries.filter((e) => e.out !== null && lap >= e.out);
  running.sort((a, b) => placeAt(a, lap) - placeAt(b, lap) || a.number - b.number);
  gone.sort((a, b) => b.out! - a.out!);
  return [...running, ...gone];
}

export function tyreAt(stints: RawStint[], lap: number): { compound: string; age: number } | null {
  const stint = stints.findLast((s) => s.lap_start <= lap) ?? stints[0];
  if (!stint) return null;
  return { compound: stint.compound, age: stint.tyre_age_at_start + Math.max(0, lap - stint.lap_start) };
}

export const tyreLife = (compound: string, age: number) => clamp(1 - age / (LIFE[compound] ?? 50), 0.12, 1);

function hue(hex: string | null): number {
  const n = parseInt(hex ?? '888888', 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255];
  const [hi, lo] = [Math.max(r, g, b), Math.min(r, g, b)];
  if (hi - lo < 24) return 400;
  const d = hi - lo;
  const h = hi === r ? ((g - b) / d + 6) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
}

export function teamInks(drivers: Pick<RawDriver, 'team_name' | 'team_colour'>[]): Map<string, string> {
  const teams = new Map(drivers.map((d) => [d.team_name, d.team_colour]));
  const order = [...teams.keys()].sort((a, b) => hue(teams.get(a)!) - hue(teams.get(b)!) || a.localeCompare(b));
  return new Map(order.map((team, i) => [team, TEAM_INKS[i % TEAM_INKS.length]]));
}

export function buildEntries(drivers: RawDriver[], results: RawResult[], places: RawPlace[], stints: RawStint[], clock: number[]): Entry[] {
  const inks = teamInks(drivers);
  return drivers.map((d) => {
    const result = results.find((r) => r.driver_number === d.driver_number);
    return {
      number: d.driver_number,
      code: d.name_acronym,
      name: d.full_name,
      ink: inks.get(d.team_name)!,
      out: result?.dnf || result?.dns ? result.number_of_laps + 1 : null,
      places: places
        .filter((p) => p.driver_number === d.driver_number)
        .map((p) => ({ t: Date.parse(p.date), position: p.position }))
        .sort((a, b) => a.t - b.t)
        .map((p) => ({ lap: lapAt(clock, p.t), position: p.position })),
      stints: stints.filter((s) => s.driver_number === d.driver_number).sort((a, b) => a.lap_start - b.lap_start),
    };
  });
}

export function parseSpots(rows: RawSpot[]): Map<number, Point[]> {
  const cars = new Map<number, Point[]>();
  for (const row of rows) {
    const list = cars.get(row.driver_number) ?? [];
    list.push({ t: Date.parse(row.date), x: row.x, y: row.y });
    cars.set(row.driver_number, list);
  }
  for (const list of cars.values()) list.sort((a, b) => a.t - b.t);
  return cars;
}

function indexAt(list: { t: number }[], t: number): number {
  let [lo, hi] = [0, list.length - 1];
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function pointAt(list: Point[], t: number): Point {
  const i = indexAt(list, t);
  const [a, b] = [list[i], list[Math.min(i + 1, list.length - 1)]];
  const k = b.t > a.t ? clamp((t - a.t) / (b.t - a.t), 0, 1) : 0;
  return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k };
}

// Лист вытянут вверх, поэтому трассу можно только повернуть: её настоящая форма не меняется
export function fitTrack(points: { x: number; y: number }[], box = ART, margin = 7): Fit {
  let best: Fit = { angle: 0, scale: 0, cx: 0, cy: 0 };
  for (let degrees = 0; degrees < 180; degrees += 3) {
    const angle = (degrees * Math.PI) / 180;
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    const xs = points.map((p) => p.x * cos - p.y * sin);
    const ys = points.map((p) => p.x * sin + p.y * cos);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const scale = Math.min((box.w - margin * 2) / (x1 - x0), (box.h - margin * 2) / (y1 - y0));
    if (scale > best.scale) best = { angle, scale, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  }
  return best;
}

export function place(fit: Fit, x: number, y: number, box = ART): [number, number] {
  const [cos, sin] = [Math.cos(fit.angle), Math.sin(fit.angle)];
  return [box.x + box.w / 2 + (x * cos - y * sin - fit.cx) * fit.scale, box.y + box.h / 2 - (x * sin + y * cos - fit.cy) * fit.scale];
}

// Почерк трассы: чем медленнее машина прошла участок, тем жирнее линия
export function strokeWidths(points: Point[]): number[] {
  const reach = 2;
  const speeds = points.map((_, i) => {
    const [a, b] = [points[Math.max(0, i - reach)], points[Math.min(points.length - 1, i + reach)]];
    return b.t > a.t ? Math.hypot(b.x - a.x, b.y - a.y) / (b.t - a.t) : 0;
  });
  const [lo, hi] = [Math.min(...speeds), Math.max(...speeds)];
  return speeds.map((s) => WIDE + (THIN - WIDE) * Math.sqrt(clamp((s - lo) / (hi - lo || 1), 0, 1)));
}

export function parseCar(rows: RawCar[]): Reading[] {
  return rows
    .map((r) => ({ t: Date.parse(r.date), speed: r.speed, throttle: r.throttle, brake: r.brake, gear: r.n_gear, rpm: r.rpm }))
    .sort((a, b) => a.t - b.t);
}

export function readingAt(list: Reading[], t: number): Reading {
  const i = indexAt(list, t);
  const [a, b] = [list[i], list[Math.min(i + 1, list.length - 1)]];
  const k = b.t > a.t ? clamp((t - a.t) / (b.t - a.t), 0, 1) : 0;
  const mix = (p: number, q: number) => p + (q - p) * k;
  return { t, speed: mix(a.speed, b.speed), throttle: mix(a.throttle, b.throttle), brake: mix(a.brake, b.brake), gear: a.gear, rpm: mix(a.rpm, b.rpm) };
}

export interface Zone {
  t: number;
  apex: number;
  drop: number;
  gear: number;
}

// Торможение: от первого нажатия до самой низкой скорости перед новым разгоном. Короткие подтормаживания не считаем
export function brakeZones(list: Reading[]): Zone[] {
  const zones: Zone[] = [];
  let open: { t: number; last: number; top: number } | null = null;
  const close = (zone: { t: number; last: number; top: number }) => {
    const slice = list.filter((r) => r.t >= zone.t && r.t <= zone.last + 1500);
    const apex = slice.reduce((a, b) => (b.speed < a.speed ? b : a));
    if (zone.top - apex.speed >= MIN_DROP) zones.push({ t: zone.t, apex: apex.t, drop: zone.top - apex.speed, gear: apex.gear });
  };
  for (const r of list) {
    if (r.brake <= 0) continue;
    if (open && r.t - open.last <= ZONE_GAP_MS) open.last = r.t;
    else {
      if (open) close(open);
      open = { t: r.t, last: r.t, top: r.speed };
    }
  }
  if (open) close(open);
  return zones;
}

export const paintOf = (r: Pick<Reading, 'brake' | 'throttle'>) => (r.brake > 0 ? RED : r.throttle >= 95 ? GREEN : YELLOW);

export function bestLap(laps: RawLap[], driver: number | undefined): RawLap | null {
  const timed = laps.filter((l) => l.date_start && l.lap_duration);
  const own = timed.filter((l) => l.driver_number === driver);
  const pool = own.length ? own : timed;
  return pool.length ? pool.reduce((a, b) => (b.lap_duration! < a.lap_duration! ? b : a)) : null;
}

function glyph(ctx: CanvasRenderingContext2D, compound: string, x: number, y: number, r: number, color: string): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.beginPath();
  if (compound === 'SOFT') ctx.arc(x, y, r, 0, Math.PI * 2);
  else if (compound === 'MEDIUM') ctx.arc(x, y + r / 2, r * 1.3, Math.PI, 0);
  else if (compound === 'HARD') {
    ctx.lineWidth = r * 0.42;
    ctx.arc(x, y, r * 0.86, 0, Math.PI * 2);
    ctx.stroke();
    return;
  } else if (compound === 'INTERMEDIATE') {
    ctx.moveTo(x - r * 1.2, y + r);
    ctx.lineTo(x + r * 1.2, y + r);
    ctx.lineTo(x, y - r * 1.2);
    ctx.closePath();
  } else if (compound === 'WET') {
    for (const dy of [-1, 0, 1]) ctx.rect(x - r, y + dy * r * 0.7 - r * 0.2, r * 2, r * 0.4);
  } else ctx.rect(x - r * 0.8, y - r * 0.8, r * 1.6, r * 1.6);
  ctx.fill();
}

interface Tile {
  x: Glide;
  y: Glide;
  life: Glide;
}

interface Season {
  race: Race;
  entries: Entry[];
  clock: number[];
  flags: { lap: number; flag: Flag }[];
}

interface Track extends Season {
  cars: Map<number, Point[]>;
  line: Point[];
  widths: number[];
  fit: Fit;
  from: number;
  to: number;
}

interface Drive extends Season {
  driver: Entry | undefined;
  lap: RawLap;
  readings: Reading[];
  line: Point[];
  dots: [number, number][];
  widths: number[];
  paints: string[];
  zones: Zone[];
  fit: Fit;
}

type Show = Season | Track | Drive;

const cell = (i: number): [number, number] => [ART.x + (i % COLS) * CELL_W, ART.y + Math.floor(i / COLS) * CELL_H];
const iso = (t: number) => new Date(t).toISOString().slice(0, 19);
const date = (t: number) => new Date(t).toLocaleDateString(LOCALE, { day: 'numeric', month: 'long' });

const ENCODINGS: Record<string, Encoding> = {
  a: {
    color: tr('Цвет плитки — команда, напарники одного цвета. Жёлтая штриховка — сейфти-кар, красный — остановленная гонка.', 'Tile colour is the team, teammates share it. Yellow stripes are a safety car, red is a stopped race.'),
    form: tr('Место плитки на листе — место пилота в гонке, лидер в левом верхнем углу. Фигура внутри — тип шин, а её площадь — сколько им осталось: круг мягкие, полукруг средние, кольцо жёсткие. Пит-стоп возвращает фигуре размер.', 'A tile’s place on the sheet is the driver’s place in the race, with the leader top left. The figure inside is the tyre, and its area is the life left: disc for soft, half disc for medium, ring for hard. A pit stop restores the figure.'),
    speed: tr('Один круг идёт секунду, красный флаг растянут в четыре раза. Плитки меняются местами при настоящих обгонах.', 'One lap takes a second, a red flag is stretched fourfold. Tiles swap places at real overtakes.'),
  },
  b: {
    color: tr('Цвет машины — команда, напарники одного цвета.', 'Car colour is the team, teammates share it.'),
    form: tr('Линию трассы рисует скорость настоящего круга: на прямых она тонкая, в медленных поворотах жирная. Клин за машиной — путь за последние 0,8 секунды.', 'The line of the track is drawn by the speed of a real lap: thin on the straights, thick in slow corners. The wedge behind a car is its path over the last 0.8 seconds.'),
    speed: tr('Настоящая скорость: два первых круга гонки от старта идут секунда в секунду по координатам машин.', 'True speed: the first two laps from the start play second by second from car positions.'),
  },
  d: {
    color: tr('Машина красит трассу: красный — тормоз, зелёный — полный газ, жёлтый — всё между ними.', 'The car paints the track: red is the brake, green is full throttle, yellow is everything between.'),
    form: tr('Линию трассы рисует скорость: на прямых она тонкая, в медленных поворотах жирная. Тёмное поле — средняя скорость, полукруг — газ, иглы наверху — передача. Красный полукруг на трассе — торможение, его площадь — сколько скорости сброшено.', 'The line of the track is drawn by speed: thin on the straights, thick in slow corners. The dark field is average speed, the half disc is throttle, the needles above are the gear. A red half disc on the track is a braking zone, its area the speed shed.'),
    speed: tr('Машина идёт в настоящей скорости: лучший круг победителя секунда в секунду. Большие формы нарочно сглажены, чтобы лист дышал, а не мелькал.', 'The car moves at true speed: the winner’s best lap second by second. The large forms are deliberately smoothed so the sheet breathes rather than flickers.'),
  },
  e: {
    color: tr('Машина красит трассу: красный — тормоз, зелёный — полный газ, жёлтый — всё между ними.', 'The car paints the track: red is the brake, green is full throttle, yellow is everything between.'),
    form: tr('Линию трассы рисует скорость: на прямых она тонкая, в медленных поворотах жирная. Красный полукруг смотрит по ходу движения, его площадь — сколько скорости сброшено. Веер игл в повороте — на какой передаче он пройден, по игле на передачу.', 'The line of the track is drawn by speed: thin on the straights, thick in slow corners. A red half disc faces the direction of travel, its area the speed shed. The fan of needles in a corner is the gear it was taken in, one needle per gear.'),
    speed: tr('Настоящая скорость: лучший круг победителя секунда в секунду. Формы остаются на листе, и к финишу круг складывается в афишу.', 'True speed: the winner’s best lap second by second. The forms stay on the sheet, and by the finish the lap has become a poster.'),
  },
  c: {
    color: tr('Красный — тормоз, розовый — газ, жёлтый — передачи, тёмное поле — скорость.', 'Red is the brake, pink the throttle, yellow the gears, the dark field the speed.'),
    form: tr('Высота тёмного поля — скорость. Полукруг растёт с нажатием на газ, красная четверть врывается при торможении, число игл — передача, чёрный диск ходит вслед за оборотами.', 'The height of the dark field is speed. The half disc grows with the throttle, the red quarter bursts in under braking, the number of needles is the gear, the black disc follows the revs.'),
    speed: tr('Настоящая скорость: лучший круг победителя идёт секунда в секунду по телеметрии машины.', 'True speed: the winner’s best lap plays second by second from the car’s telemetry.'),
  },
};

export class Grand implements Poster {
  readonly service = tr('Гонка', 'Race');
  readonly source = 'OpenF1';
  readonly kind = tr('другая гонка', 'another race');
  readonly align = 'left';
  readonly ink = LOOK === 'b' ? CREAM : INK;
  readonly feeds = [new Feed(tr('Архив гонок', 'Race archive'), Infinity)];
  readonly encoding = ENCODINGS[LOOK] ?? ENCODINGS.a;

  private races: Race[] = [];
  private answers = new Map<string, unknown>();
  private wanted: number | null = null;
  private show: Show | null = null;
  private refresh = () => {};
  private clockSec = 0;
  private lap = 1;
  private hold = 0;
  private tiles = new Map<number, Tile>();
  private seen: { x: number; y: number; entry: Entry }[] = [];
  private live: Reading | null = null;
  private field = { x: 0, v: 0 };
  private sun = { x: 0, v: 0 };
  private brake = { x: 0, v: 0 };
  private rev = { x: 0, v: 0 };
  private needles = { x: 0, v: 0 };

  paper(): string {
    return LOOK === 'b' ? NIGHT : LOOK === 'a' ? PAPER : CREAM;
  }

  start(): void {
    this.refresh = poll(this.feeds[0], POLL_MS, () => this.load(), (show) => {
      if (!show) return;
      this.show = show;
      this.clockSec = 0;
      this.lap = 1;
      this.hold = 0;
    });
  }

  shuffle(rand?: () => number): void {
    const shown = this.races.find((r) => r.key === this.show?.race.key);
    if (this.races.length > 1 && shown) this.wanted = other(this.races, shown, rand).key;
    this.feeds[0].reset();
    this.refresh();
  }

  // Архив не меняется, поэтому повтор после сбоя продолжает с того места, где оборвался
  private async ask<T>(url: string): Promise<T> {
    if (this.answers.has(url)) return this.answers.get(url) as T;
    const answer = await getJson<T>(url);
    this.answers.set(url, answer);
    return answer;
  }

  private async load(): Promise<Show | null> {
    this.races = parseRaces(await getJson<RawSession[]>(`${API}/sessions?year=${new Date().getFullYear()}&session_type=Race`), Date.now());
    const race = this.races.find((r) => r.key === this.wanted) ?? this.races.at(-1);
    if (!race || race.key === this.show?.race.key) return null;
    const ask = <T>(path: string) => this.ask<T>(`${API}/${path}${path.includes('?') ? '&' : '?'}session_key=${race.key}`);
    const drivers = await ask<RawDriver[]>('drivers');
    const laps = await ask<RawLap[]>('laps');
    const results = await ask<RawResult[]>('session_result');
    const clock = lapClock(laps);
    if (LOOK === 'b') return this.loadTrack(race, drivers, laps, results, clock, ask);
    if (LOOK === 'c' || LOOK === 'd' || LOOK === 'e') return this.loadDrive(race, drivers, laps, results, clock, ask);
    const places = await ask<RawPlace[]>('position');
    const stints = await ask<RawStint[]>('stints');
    const messages = await ask<RawMessage[]>('race_control');
    return { race, clock, entries: buildEntries(drivers, results, places, stints, clock), flags: parseFlags(messages, clock) };
  }

  private async loadTrack(race: Race, drivers: RawDriver[], laps: RawLap[], results: RawResult[], clock: number[], ask: <T>(path: string) => Promise<T>): Promise<Track> {
    const from = clock[0];
    const to = from + (clock[1] - clock[0]) * 2.1;
    const cars = parseSpots(await ask<RawSpot[]>(`location?date>${iso(from)}&date<${iso(to)}`));
    const leader = laps.find((l) => l.lap_number === 2 && l.date_start && Date.parse(l.date_start) === clock[1])?.driver_number;
    const own = cars.get(leader ?? -1) ?? [...cars.values()][0];
    const flying = own.filter((p) => p.t >= clock[1] && p.t <= clock[2]);
    const line = flying.length > 40 ? flying : own.filter((p) => p.t <= clock[1]);
    return { race, clock, flags: [], entries: buildEntries(drivers, results, [], [], clock), cars, line, widths: strokeWidths(line), fit: fitTrack(line), from, to };
  }

  private async loadDrive(race: Race, drivers: RawDriver[], laps: RawLap[], results: RawResult[], clock: number[], ask: <T>(path: string) => Promise<T>): Promise<Drive | null> {
    const winner = results.find((r) => r.position === 1)?.driver_number;
    const lap = bestLap(laps, winner);
    if (!lap) return null;
    const from = Date.parse(lap.date_start!);
    const to = from + lap.lap_duration! * 1000;
    const rows = await ask<RawCar[]>(`car_data?driver_number=${lap.driver_number}&date>${iso(from)}&date<${iso(to + 1000)}`);
    const spots = await ask<RawSpot[]>(`location?driver_number=${lap.driver_number}&date>${iso(from)}&date<${iso(to + 1000)}`);
    const entries = buildEntries(drivers, results, [], [], clock);
    const readings = parseCar(rows);
    const line = (parseSpots(spots).get(lap.driver_number) ?? []).filter((p) => p.t <= to);
    const fit = fitTrack(line, ART, 11);
    return {
      race, clock, flags: [], entries, driver: entries.find((e) => e.number === lap.driver_number), lap, readings, line, fit,
      dots: line.map((p) => place(fit, p.x, p.y)),
      widths: strokeWidths(line),
      paints: line.map((p) => paintOf(readingAt(readings, p.t))),
      zones: brakeZones(readings),
    };
  }

  label(): Label {
    if (!this.show) return { title: this.service, print: tr('Гонки сезона из открытого архива', 'Season races from an open archive') };
    const { race } = this.show;
    const title = cityName(race.city);
    if ('readings' in this.show) {
      const car = this.live;
      const parts = [`${this.show.driver?.code ?? ''}, ${tr('лучший круг победителя', 'winner’s best lap')}`];
      if (car) parts.push(`${Math.round(car.speed)} ${tr('км/ч', 'km/h')}`, `${tr('передача', 'gear')} ${car.gear}`);
      return { title, print: parts.join(' · ') };
    }
    if ('cars' in this.show) return { title, print: `${date(race.date)} · ${tr('старт гонки, два круга в настоящей скорости', 'the start of the race, two laps at true speed')}` };
    const total = this.show.clock.length - 1;
    const flag = flagAt(this.show.flags, this.lap);
    const note = { green: '', vsc: tr('виртуальный сейфти-кар', 'virtual safety car'), sc: tr('сейфти-кар', 'safety car'), red: tr('красный флаг', 'red flag') }[flag];
    const leader = standings(this.show.entries, this.lap)[0];
    const parts = [date(race.date), `${tr('Круг', 'Lap')} ${Math.min(total, Math.floor(this.lap))} ${tr('из', 'of')} ${total}`, `${tr('лидер', 'leader')} ${leader?.code ?? ''}`];
    if (note) parts.push(note);
    return { title, print: parts.join(' · ') };
  }

  private advance(show: Season, dt: number): void {
    const total = show.clock.length;
    if (this.lap >= total) {
      this.hold += dt;
      if (this.hold < HOLD_SEC) return;
      this.hold = 0;
      this.lap = 1;
      return;
    }
    const slow = flagAt(show.flags, this.lap) === 'red' ? RED_SLOWDOWN : 1;
    this.lap = Math.min(total, this.lap + dt / (LAP_SEC * slow));
  }

  private flagPanel(ctx: CanvasRenderingContext2D, show: Season): void {
    const flag = flagAt(show.flags, this.lap);
    const color = flag === 'red' ? RED : flag === 'green' ? INK : YELLOW;
    const radius = CELL_H * 2;
    const [cx, cy] = [ART.x + ART.w, ART.y + ART.h];
    const done = clamp((this.lap - 1) / (show.clock.length - 1), 0, 1);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, radius, Math.PI, Math.PI + (Math.PI / 2) * done);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
    if (flag !== 'sc' && flag !== 'vsc') return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(ART.x, ART.y + CELL_H * 5, ART.w - radius, CELL_H);
    ctx.clip();
    ctx.fillStyle = YELLOW;
    const step = flag === 'sc' ? 4 : 8;
    for (let x = ART.x - CELL_H; x < ART.x + ART.w; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, ART.y + ART.h);
      ctx.lineTo(x + step / 2, ART.y + ART.h);
      ctx.lineTo(x + step / 2 + CELL_H, ART.y + CELL_H * 5);
      ctx.lineTo(x + CELL_H, ART.y + CELL_H * 5);
      ctx.fill();
    }
    ctx.restore();
  }

  private grid(ctx: CanvasRenderingContext2D, show: Season, dt: number): void {
    this.advance(show, dt);
    this.flagPanel(ctx, show);
    const order = standings(show.entries, this.lap);
    const moving: [Tile, Entry][] = [];
    order.forEach((entry, i) => {
      const [x, y] = cell(i);
      const tile = this.tiles.get(entry.number) ?? { x: { x, v: 0 }, y: { x: y, v: 0 }, life: { x: 1, v: 0 } };
      this.tiles.set(entry.number, tile);
      const tyre = tyreAt(entry.stints, this.lap);
      glide(tile.x, x, dt, 0.32);
      glide(tile.y, y, dt, 0.32);
      glide(tile.life, tyre ? tyreLife(tyre.compound, tyre.age) : 1, dt, 0.2);
      moving.push([tile, entry]);
    });
    moving.sort((a, b) => Math.hypot(a[0].x.v, a[0].y.v) - Math.hypot(b[0].x.v, b[0].y.v));
    this.seen = [];
    for (const [tile, entry] of moving) {
      const [x, y] = [tile.x.x, tile.y.x];
      this.seen.push({ x: x + CELL_W / 2, y: y + CELL_H / 2, entry });
      if (entry.out !== null && this.lap >= entry.out) {
        ctx.strokeStyle = entry.ink;
        ctx.lineWidth = 0.5;
        ctx.strokeRect(x + 0.25, y + 0.25, CELL_W - 0.5, CELL_H - 0.5);
        continue;
      }
      ctx.fillStyle = entry.ink;
      ctx.fillRect(x, y, CELL_W + 0.05, CELL_H + 0.05);
      const tyre = tyreAt(entry.stints, this.lap);
      glyph(ctx, tyre?.compound ?? 'UNKNOWN', x + CELL_W / 2, y + CELL_H / 2, CELL_H * 0.4 * Math.sqrt(tile.life.x), LIGHT_INKS.has(entry.ink) ? INK : CREAM);
    }
  }

  private track(ctx: CanvasRenderingContext2D, show: Track, dt: number): void {
    const span = (show.to - show.from) / 1000;
    this.clockSec += dt;
    if (this.clockSec > span + 1.5) this.clockSec = 0;
    const t = show.from + Math.min(this.clockSec, span) * 1000;
    ctx.strokeStyle = CREAM;
    ctx.lineCap = 'round';
    const dots = show.line.map((p) => place(show.fit, p.x, p.y));
    dots.forEach(([x, y], i) => {
      const [nx, ny] = dots[(i + 1) % dots.length];
      ctx.lineWidth = show.widths[i];
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
    });
    ctx.lineCap = 'butt';
    this.seen = [];
    for (const entry of show.entries) {
      const list = show.cars.get(entry.number);
      if (!list?.length) continue;
      const now = pointAt(list, t);
      const past = pointAt(list, t - TRAIL_SEC * 1000);
      const [x, y] = place(show.fit, now.x, now.y);
      const [px, py] = place(show.fit, past.x, past.y);
      const length = Math.hypot(x - px, y - py);
      this.seen.push({ x, y, entry });
      if (length > 0.2) {
        const [nx, ny] = [(-(y - py) / length) * 1.5, ((x - px) / length) * 1.5];
        ctx.fillStyle = entry.ink;
        ctx.beginPath();
        ctx.moveTo(x + nx, y + ny);
        ctx.lineTo(x - nx, y - ny);
        ctx.lineTo(px, py);
        ctx.closePath();
        ctx.fill();
      }
      disc(ctx, x, y, 1.9, NIGHT);
      disc(ctx, x, y, 1.5, entry.ink);
    }
  }

  private ribbon(ctx: CanvasRenderingContext2D, show: Drive, upTo: number, paint: boolean, base: string): void {
    ctx.lineCap = 'round';
    show.dots.forEach(([x, y], i) => {
      if (paint && show.line[i].t > upTo) return;
      const [nx, ny] = show.dots[(i + 1) % show.dots.length];
      ctx.strokeStyle = paint ? show.paints[i] : base;
      ctx.lineWidth = show.widths[i];
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(nx, ny);
      ctx.stroke();
    });
    ctx.lineCap = 'butt';
  }

  // След торможения: полукруг смотрит по ходу машины, площадь равна сброшенной скорости
  private stamp(ctx: CanvasRenderingContext2D, show: Drive, zone: Zone, t: number, fade: number): void {
    const grow = clamp((t - zone.t) / (STAMP_SEC * 1000), 0, 1) * fade;
    if (grow <= 0) return;
    const at = pointAt(show.line, zone.t);
    const next = pointAt(show.line, zone.t + 250);
    const [x, y] = place(show.fit, at.x, at.y);
    const [nx, ny] = place(show.fit, next.x, next.y);
    const heading = Math.atan2(ny - y, nx - x);
    ctx.fillStyle = RED;
    ctx.beginPath();
    ctx.arc(x, y, STAMP_R * Math.sqrt(zone.drop / 300) * (1 - (1 - grow) ** 3), heading - Math.PI / 2, heading + Math.PI / 2);
    ctx.fill();
  }

  // Веер в повороте: по игле на передачу, наружу от середины листа
  private fan(ctx: CanvasRenderingContext2D, show: Drive, zone: Zone, t: number, fade: number): void {
    const grow = clamp((t - zone.apex) / (STAMP_SEC * 1000), 0, 1) * fade;
    if (grow <= 0) return;
    const at = pointAt(show.line, zone.apex);
    const [x, y] = place(show.fit, at.x, at.y);
    const out = Math.atan2(y - (ART.y + ART.h / 2), x - (ART.x + ART.w / 2));
    ctx.fillStyle = BLUE;
    for (let i = 0; i < zone.gear; i++) {
      const a = out + (i - (zone.gear - 1) / 2) * 0.42;
      const side = 0.2;
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(a - side) * 4, y + Math.sin(a - side) * 4);
      ctx.lineTo(x + Math.cos(a) * (4 + NEEDLE * grow), y + Math.sin(a) * (4 + NEEDLE * grow));
      ctx.lineTo(x + Math.cos(a + side) * 4, y + Math.sin(a + side) * 4);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Большие формы идут за средним, а не за мгновенным: лист дышит и не мелькает
  private fields(ctx: CanvasRenderingContext2D, car: Reading, dt: number): void {
    glide(this.field, car.speed / TOP_SPEED, dt, 1.6);
    glide(this.sun, car.throttle / 100, dt, 1.1);
    glide(this.needles, car.gear, dt, 0.6);
    ctx.fillStyle = BLUE;
    ctx.fillRect(ART.x, ART.y, ART.w, ART.h);
    const needleW = ART.w / GEARS;
    ctx.fillStyle = YELLOW;
    for (let i = 0; i < GEARS; i++) {
      const lit = clamp(this.needles.x - i, 0, 1);
      if (lit <= 0) continue;
      const x = ART.x + i * needleW;
      ctx.beginPath();
      ctx.moveTo(x, ART.y);
      ctx.lineTo(x + needleW, ART.y);
      ctx.lineTo(x + needleW / 2, ART.y + 26 * lit);
      ctx.closePath();
      ctx.fill();
    }
    const horizon = ART.y + ART.h * (1 - clamp(this.field.x, 0, 1) * 0.86);
    ctx.fillStyle = PINK;
    ctx.beginPath();
    ctx.arc(ART.x + ART.w / 2, horizon, 9 + 33 * Math.sqrt(clamp(this.sun.x, 0, 1)), Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = NIGHT;
    ctx.fillRect(ART.x, horizon, ART.w, ART.y + ART.h - horizon);
  }

  private painted(ctx: CanvasRenderingContext2D, show: Drive, dt: number): void {
    const lapSec = show.lap.lap_duration!;
    this.clockSec = (this.clockSec + dt) % (lapSec + HOLD_SEC);
    const t = Date.parse(show.lap.date_start!) + Math.min(this.clockSec, lapSec) * 1000;
    const fade = clamp(lapSec + HOLD_SEC - this.clockSec, 0, 1);
    const car = readingAt(show.readings, t);
    this.live = car;
    ctx.save();
    clipArt(ctx);
    if (LOOK === 'd') this.fields(ctx, car, dt);
    this.ribbon(ctx, show, t, false, LOOK === 'd' ? CREAM : NIGHT);
    ctx.globalAlpha = fade;
    this.ribbon(ctx, show, t, true, CREAM);
    ctx.globalAlpha = 1;
    for (const zone of show.zones) {
      this.stamp(ctx, show, zone, t, fade);
      if (LOOK === 'e') this.fan(ctx, show, zone, t, fade);
    }
    const head = pointAt(show.line, t);
    const [x, y] = place(show.fit, head.x, head.y);
    disc(ctx, x, y, 2.6, LOOK === 'd' ? INK : CREAM);
    disc(ctx, x, y, 1.5, LOOK === 'd' ? CREAM : INK);
    ctx.restore();
  }

  private drive(ctx: CanvasRenderingContext2D, show: Drive, dt: number): void {
    const lapSec = show.lap.lap_duration!;
    this.clockSec = (this.clockSec + dt) % (lapSec + 1);
    const car = readingAt(show.readings, Date.parse(show.lap.date_start!) + Math.min(this.clockSec, lapSec) * 1000);
    this.live = car;
    glide(this.field, car.speed / TOP_SPEED, dt, 0.16);
    glide(this.sun, car.throttle / 100, dt, 0.14);
    glide(this.brake, car.brake / 100, dt, 0.07);
    glide(this.rev, clamp((car.rpm - RPM_LOW) / (RPM_HIGH - RPM_LOW), 0, 1), dt, 0.1);
    glide(this.needles, car.gear, dt, 0.1);

    ctx.save();
    clipArt(ctx);
    ctx.fillStyle = BLUE;
    ctx.fillRect(ART.x, ART.y, ART.w, ART.h);

    const needleW = ART.w / GEARS;
    ctx.fillStyle = YELLOW;
    for (let i = 0; i < GEARS; i++) {
      const lit = clamp(this.needles.x - i, 0, 1);
      if (lit <= 0) continue;
      const x = ART.x + i * needleW;
      ctx.beginPath();
      ctx.moveTo(x, ART.y);
      ctx.lineTo(x + needleW, ART.y);
      ctx.lineTo(x + needleW / 2, ART.y + 34 * lit);
      ctx.closePath();
      ctx.fill();
    }

    const horizon = ART.y + ART.h * (1 - clamp(this.field.x, 0, 1) * 0.86);
    const radius = 9 + 33 * Math.sqrt(clamp(this.sun.x, 0, 1));
    ctx.fillStyle = PINK;
    ctx.beginPath();
    ctx.arc(ART.x + ART.w / 2, horizon, radius, Math.PI, 0);
    ctx.fill();

    ctx.fillStyle = NIGHT;
    ctx.fillRect(ART.x, horizon, ART.w, ART.y + ART.h - horizon);
    disc(ctx, ART.x + 9 + clamp(this.rev.x, 0, 1) * (ART.w - 18), Math.min(horizon + 9, ART.y + ART.h - 9), 7, CREAM);

    const brake = 66 * Math.sqrt(clamp(this.brake.x, 0, 1));
    if (brake > 0.5) {
      ctx.fillStyle = RED;
      ctx.beginPath();
      ctx.moveTo(ART.x + ART.w, ART.y);
      ctx.arc(ART.x + ART.w, ART.y, brake, Math.PI / 2, Math.PI);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  draw({ ctx, dt }: Frame): void {
    const show = this.show;
    if (!show) return waiting(ctx, this.ink);
    if ('readings' in show) {
      if (!show.readings.length) return waiting(ctx, this.ink);
      return LOOK === 'c' || show.line.length < 2 ? this.drive(ctx, show, dt) : this.painted(ctx, show, dt);
    }
    if ('cars' in show) return this.track(ctx, show, dt);
    this.grid(ctx, show, dt);
  }

  pick(x: number, y: number): Tip | null {
    const show = this.show;
    if (!show) return null;
    if ('readings' in show) return this.live && { value: `${Math.round(this.live.speed)} ${tr('км/ч', 'km/h')}`, label: `${show.driver?.name ?? ''}, ${tr('круг', 'lap')} ${show.lap.lap_number}` };
    const near = this.seen.findLast((s) => Math.abs(s.x - x) < CELL_W / 2 && Math.abs(s.y - y) < CELL_H / 2 && ('cars' in show ? Math.hypot(s.x - x, s.y - y) < 4 : true));
    if (!near) return null;
    if ('cars' in show) return { value: near.entry.code, label: near.entry.name };
    const tyre = tyreAt(near.entry.stints, this.lap);
    return { value: `${near.entry.code} · ${Math.round(placeAt(near.entry, this.lap))}`, label: tyre ? `${COMPOUNDS[tyre.compound] ?? tyre.compound}, ${tr('шинам кругов', 'tyre age')}: ${Math.floor(tyre.age)}` : near.entry.name };
  }
}
