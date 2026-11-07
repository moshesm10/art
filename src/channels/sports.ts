import { LEAGUES, type League } from '../config';
import { fmtKickoff, word } from '../lib/format';
import { tr } from '../lib/i18n';
import { Feed, getJson, poll } from '../lib/net';
import { ART, disc, waiting, type Encoding, type Frame, type Label, type Poster, type Tip } from '../lib/poster';
import { clamp, other } from '../lib/stats';
import { INK, nearest, PAPER } from '../lib/theme';

const MAX_TILES = 20;
const FLASH_MS = 1400;
const SEAM = 0.04;
const MAX_PIPS = 12;
const DAY_MS = 86_400_000;

const CORAL = '#e8624e';
const BLUE = '#2b7ea8';
const AMBER = '#f0a42f';
const PINK = '#f3bad0';
const GREEN = '#2f7c62';
const INKS = [CORAL, BLUE, AMBER, PINK, GREEN, INK];

export interface Match {
  id: string;
  league: string;
  home: string;
  away: string;
  homeColor: string;
  awayColor: string;
  homeScore: number;
  awayScore: number;
  state: 'pre' | 'in' | 'post';
  detail: string;
  start: number;
  progress: number;
  span: number;
}

interface RawStatus {
  clock?: number;
  displayClock?: string;
  period?: number;
  type: { state: 'pre' | 'in' | 'post'; shortDetail: string };
}

interface RawEvent {
  id: string;
  date: string;
  status: RawStatus;
  competitions: {
    competitors: { homeAway: string; score?: string; team: { shortDisplayName: string; color?: string } }[];
  }[];
}

export function matchProgress(path: string, s: RawStatus): number {
  const period = s.period ?? 1;
  const clock = s.clock ?? 0;
  let share: number;
  if (path.startsWith('basketball')) share = (period - 1 + 1 - clock / 720) / 4;
  else if (path.startsWith('hockey')) share = (period - 1 + 1 - clock / 1200) / 3;
  else share = (parseInt(s.displayClock ?? '0', 10) || 0) / 90;
  return clamp(share, 0, 1);
}

// Разгромный перевес в каждом виде спорта свой: 3 гола в футболе весят как 20 очков в баскетболе
export function leadSpan(path: string): number {
  if (path.startsWith('basketball')) return 20;
  if (path.startsWith('football')) return 17;
  if (path.startsWith('baseball')) return 5;
  return 3;
}

export function leadShare(m: Pick<Match, 'homeScore' | 'awayScore' | 'span'>): number {
  return clamp((m.awayScore - m.homeScore) / m.span, -1, 1);
}

// Клубный цвет приводится к ближайшей краске постера, у совпавших команд вторая берёт следующую
export function teamInks(home?: string, away?: string): [string, string] {
  const a = nearest(`#${home ?? '1f1e1c'}`, INKS);
  const b = nearest(`#${away ?? '1f1e1c'}`, INKS);
  return [a, a === b ? INKS[(INKS.indexOf(a) + 1) % INKS.length] : b];
}

export function parseScoreboard(json: { events?: RawEvent[] }, path: string, league: string): Match[] {
  return (json.events ?? []).flatMap((e) => {
    const teams = e.competitions[0]?.competitors ?? [];
    const home = teams.find((t) => t.homeAway === 'home');
    const away = teams.find((t) => t.homeAway === 'away');
    if (!home || !away) return [];
    const [homeColor, awayColor] = teamInks(home.team.color, away.team.color);
    return [
      {
        id: e.id,
        league,
        home: home.team.shortDisplayName,
        away: away.team.shortDisplayName,
        homeColor,
        awayColor,
        homeScore: Number(home.score ?? 0),
        awayScore: Number(away.score ?? 0),
        state: e.status.type.state,
        detail: e.status.displayClock && path.startsWith('soccer') ? e.status.displayClock : e.status.type.shortDetail,
        start: Date.parse(e.date),
        progress: e.status.type.state === 'in' ? matchProgress(path, e.status) : 0,
        span: leadSpan(path),
      },
    ];
  });
}

// Сначала идущие матчи, затем ближайшие, затем недавно завершённые
export function rankMatches(matches: Match[]): Match[] {
  const order = { in: 0, pre: 1, post: 2 };
  return [...matches].sort((a, b) => {
    if (a.state !== b.state) return order[a.state] - order[b.state];
    return a.state === 'post' ? b.start - a.start : a.start - b.start;
  });
}

export function gridFor(count: number): { cols: number; rows: number; side: number } {
  const cols = Math.max(1, Math.ceil(Math.sqrt((count * ART.w) / ART.h)));
  const rows = Math.max(1, Math.ceil(count / cols));
  return { cols, rows, side: Math.min(ART.w / cols, ART.h / rows) };
}

const hash = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

const onInk = (color: string) => (color === AMBER || color === PINK ? INK : PAPER);

// Голы считаются глазами: одна точка — один гол. В баскетболе очков слишком много, там говорит только размер
function pips(ctx: CanvasRenderingContext2D, n: number, x: number, y: number, dx: number, dy: number, s: number, color: string): void {
  const gap = Math.min(s * 0.085, (s * 0.5) / Math.max(1, n - 1));
  for (let i = 0; i < n; i++) {
    const shift = (i - (n - 1) / 2) * gap;
    disc(ctx, x + dx * shift, y + dy * shift, s * 0.026, color);
  }
}

const countable = (m: Match) => m.homeScore + m.awayScore <= MAX_PIPS;

function preTile(ctx: CanvasRenderingContext2D, m: Match, s: number, now: number): void {
  const bars = clamp(Math.round((m.start - now) / 3_600_000), 3, 11);
  disc(ctx, 0, s / 2, s / 2, m.homeColor);
  ctx.fillStyle = INK;
  const step = s / bars;
  for (let i = 0; i < bars; i++) ctx.fillRect(-s / 2 + i * step + step * 0.3, -s / 2, step * 0.4, s);
}

// Победитель хозяев занимает левый нижний угол, победитель гостей правый верхний
function postTile(ctx: CanvasRenderingContext2D, m: Match, s: number): void {
  const h = s / 2;
  const row = Math.SQRT1_2;
  if (m.homeScore === m.awayScore) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, h * 0.86, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = m.homeColor;
    ctx.fillRect(-h, -h, s, s);
    ctx.fillStyle = m.awayColor;
    ctx.beginPath();
    ctx.moveTo(-h, -h);
    ctx.lineTo(h, h);
    ctx.lineTo(-h, h);
    ctx.fill();
    ctx.restore();
    if (countable(m)) {
      pips(ctx, m.homeScore, s * 0.14, -s * 0.14, row, row, s, onInk(m.homeColor));
      pips(ctx, m.awayScore, -s * 0.14, s * 0.14, row, row, s, onInk(m.awayColor));
    }
    return;
  }
  const homeWon = m.homeScore > m.awayScore;
  const [winner, loser] = homeWon ? [m.homeColor, m.awayColor] : [m.awayColor, m.homeColor];
  const [won, lost] = homeWon ? [m.homeScore, m.awayScore] : [m.awayScore, m.homeScore];
  const margin = Math.abs(leadShare(m));
  if (!homeWon) ctx.rotate(Math.PI);
  ctx.fillStyle = loser;
  ctx.fillRect(-h, -h, s, s);
  ctx.fillStyle = winner;
  ctx.beginPath();
  ctx.moveTo(-h, h);
  ctx.arc(-h, h, s * (0.6 + 0.4 * margin), -Math.PI / 2, 0);
  ctx.closePath();
  ctx.fill();
  if (countable(m)) {
    pips(ctx, won, -s * 0.22, s * 0.22, row, row, s, onInk(winner));
    pips(ctx, lost, s * 0.27, -s * 0.27, row, row, s, onInk(loser));
  }
}

// Идущий матч смотрит на тех, кто ведёт; кольцо вокруг радужки показывает прошедшую часть игры
function liveTile(ctx: CanvasRenderingContext2D, m: Match, s: number, now: number, flash: number): void {
  const h = s / 2;
  ctx.fillStyle = m.homeColor;
  ctx.fillRect(-h, -h, s, s);
  if (countable(m)) {
    pips(ctx, m.homeScore, -s * 0.25, s * 0.39, 1, 0, s * 0.8, onInk(m.homeColor));
    pips(ctx, m.awayScore, s * 0.25, s * 0.39, 1, 0, s * 0.8, onInk(m.homeColor));
  }

  const goals = m.homeScore + m.awayScore;
  const beat = 7000 / (1 + Math.min(goals, 8) * 0.5);
  const blink = Math.max(flash, 1 - Math.min(1, ((now + hash(m.id)) % beat) / 240));
  const open = h * 0.56 * (1 - blink * 0.92);
  const w = h * 0.9;
  ctx.fillStyle = PAPER;
  ctx.beginPath();
  ctx.moveTo(-w, 0);
  ctx.quadraticCurveTo(0, -open * 2, w, 0);
  ctx.quadraticCurveTo(0, open * 2, -w, 0);
  ctx.fill();
  if (open < h * 0.1) return;

  ctx.save();
  ctx.clip();
  const x = leadShare(m) * h * 0.3;
  disc(ctx, x, 0, h * 0.42, m.awayColor);
  disc(ctx, x, 0, h * 0.18, INK);
  ctx.strokeStyle = INK;
  ctx.lineWidth = s * 0.024;
  ctx.beginPath();
  ctx.arc(x, 0, h * 0.32, -Math.PI / 2, -Math.PI / 2 + m.progress * Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

export class Sports implements Poster {
  readonly service = tr('Спорт', 'Sport');
  readonly source = 'ESPN';
  readonly kind = tr('другая лига', 'another league');
  readonly align = 'right';
  readonly ink = INK;
  readonly feeds = [new Feed('ESPN', 120_000)];
  readonly encoding: Encoding = {
    color: tr('Настоящие клубные цвета, приведённые к шести краскам постера.', 'Real club colours, reduced to the six inks of the poster.'),
    form: tr('Плитка — матч в программе лиги. Штрихи — матч впереди, полос тем больше, чем дольше ждать, а штрихи одного игрового дня лежат в одну сторону. Четверть круга — победа: растёт с разницей в счёте, слева снизу побеждают хозяева, справа сверху гости. Рассечённый круг — ничья. Глаз — матч идёт. Точка — один гол.', 'A tile is a match on the league programme. Hatching is a match ahead: more stripes the longer the wait, and the hatching of one matchday lies in one direction. A quarter circle is a win: it grows with the margin, home wins at lower left, away wins at upper right. A split circle is a draw. An eye is a match in play. A dot is one goal.'),
    speed: tr('Глаз смотрит на ведущую команду, тем сильнее, чем больше отрыв, а кольцо вокруг зрачка показывает, сколько матча прошло. Чем больше голов, тем чаще он моргает, а на новый гол моргает сразу.', 'The eye looks towards the leading team, harder the bigger the lead, and the ring around the pupil shows how much of the match has passed. The more goals, the more it blinks, and a new goal makes it blink at once.'),
  };

  private league: League | null = null;
  private all = new Map<string, Match[]>();
  private flashes = new Map<string, number>();
  private shown: { match: Match; x: number; y: number; side: number }[] = [];

  paper(): string {
    return PAPER;
  }

  private get matches(): Match[] {
    return this.league ? (this.all.get(this.league.path) ?? []) : [];
  }

  start(): void {
    const base = '/api/espn/apis/site/v2/sports';
    const load = async () => {
      const results = await Promise.allSettled(
        LEAGUES.map(async (l) => [l.path, parseScoreboard(await getJson(`${base}/${l.path}/scoreboard`), l.path, l.title)] as const),
      );
      const loaded = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      if (!loaded.length) throw new Error('ESPN: все лиги недоступны');
      return loaded;
    };
    poll(this.feeds[0], 30_000, load, (list) => this.merge(list));
  }

  shuffle(rand?: () => number): void {
    const playing = this.playing();
    if (playing.length > 1) this.league = other(playing, this.league as League, rand);
  }

  // Случайный выбор идёт только среди лиг с программой, иначе постер оказался бы пустым
  private playing(): League[] {
    return LEAGUES.filter((l) => this.all.get(l.path)?.length);
  }

  private merge(list: readonly (readonly [string, Match[]])[]): void {
    const previous = new Map([...this.all.values()].flat().map((m) => [m.id, m]));
    const now = Date.now();
    for (const [path, matches] of list) {
      for (const m of matches) {
        const old = previous.get(m.id);
        if (old && m.state === 'in' && old.homeScore + old.awayScore !== m.homeScore + m.awayScore) {
          this.flashes.set(m.id, now);
        }
      }
      this.all.set(path, rankMatches(matches));
    }
    if (!this.matches.length) {
      const count = (l: League, state?: Match['state']) =>
        (this.all.get(l.path) ?? []).filter((m) => !state || m.state === state).length;
      const best = this.playing().sort((a, b) => count(b, 'in') - count(a, 'in') || count(b) - count(a));
      this.league = best[0] ?? null;
    }
  }

  label(now: number): Label {
    const matches = this.matches;
    if (!this.league) return { title: this.service, print: tr('Программа лиг', 'League programme') };
    const live = matches.filter((m) => m.state === 'in').length;
    const parts: string[] = [];
    if (live) parts.push(`${live} ${word(live, ['матч идёт', 'матча идут', 'матчей идут'], ['match in play', 'matches in play'])}`);
    const next = matches.find((m) => m.state === 'pre' && m.start > now);
    if (next) parts.push(`${tr('дальше', 'next')} ${next.home} — ${next.away}, ${fmtKickoff(next.start, now)}`);
    const n = matches.length;
    parts.push(`${n} ${word(n, ['матч', 'матча', 'матчей'], ['match', 'matches'])} ${tr('в программе', 'on the programme')}`);
    return { title: tr(this.league.title, this.league.en), print: parts.join(' · ') };
  }

  draw({ ctx, now }: Frame): void {
    const matches = this.matches.slice(0, MAX_TILES);
    if (!matches.length) return waiting(ctx, this.ink);

    const { cols, rows, side } = gridFor(matches.length);
    const left = ART.x + (ART.w - cols * side) / 2;
    const top = ART.y + (ART.h - rows * side) / 2;

    this.shown = matches.map((match, i) => ({
      match,
      x: left + (i % cols) * side,
      y: top + Math.floor(i / cols) * side,
      side,
    }));

    for (const { match: m, x, y } of this.shown) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x - SEAM, y - SEAM, side + SEAM * 2, side + SEAM * 2);
      ctx.clip();
      ctx.translate(x + side / 2, y + side / 2);
      ctx.scale(1 + (SEAM * 2) / side, 1 + (SEAM * 2) / side);
      if (m.state === 'in') {
        const at = this.flashes.get(m.id);
        liveTile(ctx, m, side, now, at && now - at < FLASH_MS ? 1 - (now - at) / FLASH_MS : 0);
      } else {
        if (m.state === 'pre') {
          // Штрихи одного игрового дня лежат в одну сторону, соседний день лежит поперёк
          if (Math.floor(m.start / DAY_MS) % 2) ctx.rotate(Math.PI / 2);
          preTile(ctx, m, side, now);
        } else postTile(ctx, m, side);
      }
      ctx.restore();
    }
  }

  pick(x: number, y: number, now: number): Tip | null {
    const tile = this.shown.find((t) => x >= t.x && x < t.x + t.side && y >= t.y && y < t.y + t.side);
    if (!tile) return null;
    const m = tile.match;
    const score = m.state === 'pre' ? fmtKickoff(m.start, now) : `${m.homeScore} : ${m.awayScore}`;
    return { value: score, label: `${m.home} — ${m.away}${m.state === 'in' ? ` · ${m.detail}` : ''}` };
  }
}
