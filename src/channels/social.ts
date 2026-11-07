import { fmtDec, fmtInt, plural } from '../lib/format';
import { tr } from '../lib/i18n';
import { eventStream, Feed, socket } from '../lib/net';
import { ART, disc, waiting, type Encoding, type Frame, type Label, type Poster, type Tip } from '../lib/poster';
import { clamp, ease, other, Rolling } from '../lib/stats';
import { INK } from '../lib/theme';

export const LANGS = ['en', 'ja', 'pt', 'es', 'de', 'fr', 'ru', 'другие'] as const;
const OTHER = LANGS.length - 1;
const NAMES = tr(
  ['Английский', 'Японский', 'Португальский', 'Испанский', 'Немецкий', 'Французский', 'Русский'],
  ['English', 'Japanese', 'Portuguese', 'Spanish', 'German', 'French', 'Russian'],
);
const RATE_WINDOW_SEC = 30;
const GAP = 0.45;
const MIN_SHARE = 0.02;
const TRACE_MS = 20_000;
const MAX_SPARKS = 1600;
const MAX_EDITS = 300;
const MAX_DISC = 11;

const PAPER = '#f4f1ea';
const RED = '#ea5a4c';

export interface Band {
  y: number;
  h: number;
}

export function langColumn(langs: string[] | undefined): number {
  const code = langs?.[0]?.slice(0, 2).toLowerCase();
  const i = LANGS.findIndex((l) => l === code);
  return i === -1 ? OTHER : i;
}

// Текст постов сразу отбрасывается: поток не модерируется, на стенде только агрегаты
export function parsePost(raw: string): number | null {
  const e = JSON.parse(raw);
  if (e.kind !== 'commit' || e.commit?.operation !== 'create') return null;
  return langColumn(e.commit.record?.langs);
}

export function parseEdit(raw: string): { lang: string; bytes: number } | null {
  const e = JSON.parse(raw);
  const lang = /^([a-z-]+)\.wikipedia\.org$/.exec(e.server_name ?? '')?.[1];
  return e.type === 'edit' && lang ? { lang, bytes: (e.length?.new ?? 0) - (e.length?.old ?? 0) } : null;
}

// Площадь точки растёт с объёмом правки: опечатка — пылинка, новый раздел статьи — заметный диск
export function editRadius(bytes: number): number {
  return Math.min(5, 0.45 + Math.sqrt(Math.abs(bytes)) * 0.035);
}

// Полосы делят лист по долям и всегда идут в одном порядке, поэтому язык узнаётся по месту
export function stack(weights: number[], y: number, h: number): Band[] {
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  let top = y;
  return weights.map((w) => {
    const band = { y: top, h: (h * w) / total };
    top += band.h;
    return band;
  });
}

// x на листе: у правого края только что случившееся, у левого то, что было 20 секунд назад
export const traceX = (ageMs: number) => ART.x + ART.w * (1 - ageMs / TRACE_MS);

export class Social implements Poster {
  readonly service = tr('Сеть', 'Network');
  readonly source = 'Bluesky · Wikipedia';
  readonly kind = tr('другой язык', 'another language');
  readonly align = 'left';
  readonly ink = INK;
  readonly feeds = [new Feed('Bluesky', 15_000), new Feed('Wikipedia', 30_000)];
  readonly encoding: Encoding = {
    color: tr('Чёрное — посты Bluesky. Красное — правки Wikipedia на выбранном языке.', 'Black is Bluesky posts. Red is Wikipedia edits in the chosen language.'),
    form: tr('Полоса — язык, порядок постоянный: английский, японский, португальский, испанский, немецкий, французский, русский, остальные. Высота — доля постов за полминуты. Красный диск стоит на выбранном языке, его площадь — правки в секунду. Красная точка — одна правка, площадь — сколько байт изменено: залитая дописала текст, кольцо убрала.', 'Each band is a language, in fixed order: English, Japanese, Portuguese, Spanish, German, French, Russian, the rest. Height is the share of posts over half a minute. The red disc sits on the chosen language, its area is edits per second. A red dot is one edit, its area the bytes changed: filled added text, a ring removed it.'),
    speed: tr('Лента времени: каждая искра — один настоящий пост, она рождается у правого края и за 20 секунд доходит до левого, поэтому ритм языка виден как морзянка. Правки плывут с той же скоростью.', 'A timeline: every spark is one real post, born at the right edge and reaching the left in 20 seconds, so the rhythm of a language reads like Morse code. Edits drift at the same speed.'),
  };

  private lang = 6;
  private readonly columns = LANGS.map(() => new Rolling());
  private readonly posts = new Rolling();
  private readonly edits = new Map<string, Rolling>(LANGS.slice(0, OTHER).map((l) => [l, new Rolling()]));
  private bands: Band[] = [];
  private readonly shares = LANGS.map(() => 0);
  private sparks: { column: number; y: number; born: number }[] = [];
  private changes: { lang: string; bytes: number; born: number }[] = [];
  private radius = 0;
  private kick = 0;

  paper(): string {
    return PAPER;
  }

  start(): void {
    socket(this.feeds[0], 'wss://jetstream2.us-east.bsky.network/subscribe?wantedCollections=app.bsky.feed.post', (raw) => {
      const column = parsePost(raw);
      if (column === null) return;
      this.columns[column].add();
      this.posts.add();
      if (this.sparks.length < MAX_SPARKS) {
        this.sparks.push({ column, y: Math.random(), born: Date.now() });
      }
    });
    eventStream(this.feeds[1], 'https://stream.wikimedia.org/v2/stream/recentchange', (raw) => {
      const edit = parseEdit(raw);
      if (!edit) return;
      this.edits.get(edit.lang)?.add();
      if (edit.lang === LANGS[this.lang]) this.kick = 1;
      if (this.edits.has(edit.lang) && this.changes.length < MAX_EDITS) this.changes.push({ ...edit, born: Date.now() });
    });
  }

  shuffle(rand?: () => number): void {
    this.lang = other(NAMES.map((_, i) => i), this.lang, rand);
    this.kick = 1;
  }

  private editRate(now: number): number {
    return this.edits.get(LANGS[this.lang])?.rate(RATE_WINDOW_SEC, now) ?? 0;
  }

  label(now: number): Label {
    const title = NAMES[this.lang];
    const posts = this.columns[this.lang].rate(RATE_WINDOW_SEC, now);
    const total = this.posts.rate(RATE_WINDOW_SEC, now);
    if (!total) return { title, print: tr('Посты Bluesky и правки Wikipedia', 'Bluesky posts and Wikipedia edits') };
    const perMinute = Math.round(this.editRate(now) * 60);
    const share = fmtDec((posts / total) * 100);
    return {
      title,
      print: tr(
        `${share}% из ${fmtInt(total)} постов в секунду в Bluesky · ${fmtInt(perMinute)} ${plural(perMinute, 'правка', 'правки', 'правок')} в минуту в Wikipedia`,
        `${share}% of ${fmtInt(total)} posts per second on Bluesky · ${fmtInt(perMinute)} ${perMinute === 1 ? 'edit' : 'edits'} per minute on Wikipedia`,
      ),
    };
  }

  draw({ ctx, now, dt }: Frame): void {
    const rates = this.columns.map((c) => c.rate(RATE_WINDOW_SEC, now));
    const total = rates.reduce((a, b) => a + b, 0);
    if (!total) return waiting(ctx, this.ink);

    const k = this.bands.length ? ease(dt, 0.9) : 1;
    rates.forEach((r, i) => {
      this.shares[i] += (Math.max(r / total, MIN_SHARE) - this.shares[i]) * k;
    });
    const bands = (this.bands = stack(this.shares, ART.y, ART.h));

    ctx.fillStyle = this.ink;
    const capsule = ({ y, h }: Band) => {
      ctx.beginPath();
      ctx.roundRect(ART.x, y + GAP / 2, ART.w, h - GAP, (h - GAP) / 2);
    };
    for (const band of bands) {
      capsule(band);
      ctx.fill();
    }

    this.sparks = this.sparks.filter((s) => now - s.born < TRACE_MS);
    bands.forEach((band, column) => {
      ctx.save();
      capsule(band);
      ctx.clip();
      const inset = Math.min(band.h * 0.2, 2);
      const r = Math.min(0.34, band.h * 0.16);
      for (const s of this.sparks) {
        if (s.column !== column) continue;
        const age = now - s.born;
        ctx.globalAlpha = 1 - 0.6 * (age / TRACE_MS);
        disc(ctx, traceX(age), band.y + inset + s.y * (band.h - inset * 2), r, PAPER);
      }
      ctx.restore();
    });
    ctx.globalAlpha = 1;

    const home = bands[this.lang];
    const y = home.y + home.h / 2;
    this.changes = this.changes.filter((c) => now - c.born < TRACE_MS);
    ctx.strokeStyle = RED;
    ctx.lineWidth = 0.3;
    for (const c of this.changes) {
      if (c.lang !== LANGS[this.lang]) continue;
      const r = editRadius(c.bytes);
      const x = traceX(now - c.born);
      if (c.bytes >= 0) disc(ctx, x, y, r, RED);
      else {
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    const size = clamp(Math.sqrt(this.editRate(now)) * 6, 1.2, MAX_DISC);
    this.radius += (size - this.radius) * ease(dt, 1.5);
    this.kick *= 1 - ease(dt, 7);
    const r = this.radius * (1 + this.kick * 0.09);
    disc(ctx, ART.x + ART.w - r, clamp(y, ART.y + r, ART.y + ART.h - r), r, RED);
  }

  pick(_x: number, y: number, now: number): Tip | null {
    const i = this.bands.findIndex((b) => y >= b.y && y < b.y + b.h);
    if (i < 0) return null;
    return { value: `${fmtDec(this.columns[i].rate(RATE_WINDOW_SEC, now))} ${tr('в секунду', 'per second')}`, label: `${tr('Посты', 'Posts')}: ${NAMES[i] ?? tr('другие языки', 'other languages')}` };
  }
}
