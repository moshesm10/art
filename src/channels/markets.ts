import { COINS } from '../config';
import { fmtClock, fmtDec, fmtHundredths, fmtPrice, fmtSigned } from '../lib/format';
import { tr } from '../lib/i18n';
import { Feed, getJson, socket } from '../lib/net';
import { ART, disc, waiting, type Encoding, type Frame, type Label, type Poster, type Tip } from '../lib/poster';
import { clamp, ease, famous, glide, Rolling, type Glide } from '../lib/stats';
import { INK, PAPER } from '../lib/theme';

const SPAN_MS = 300_000;
const CELL_SEC = 10;
const CELLS = SPAN_MS / 1000 / CELL_SEC;
const R_MAX = 7;
const R_MIN = 0.9;
const EDGE = 7;
const STEP = (ART.w - EDGE * 2) / (CELLS - 1);
const MIN_SPAN = 0.001;
const REVEAL_SEC = 2.4;
const GROW_SEC = 2.4;
const MOVE_SEC = 1.2;
const FADE_CELLS = 5;
const LEAVE_SEC = 1.2;
const BREATH = 0.1;

const SKY = '#6d8fd9';
const DEEP = '#33409f';
const RED = '#e63c1e';
const ORANGE = '#f5902b';
const YELLOW = '#fbdf63';

const REST = '/api/okx/api/v5/market';
const MIN_VOLUME = 300_000;
const PEGGED = new Set(['USDC', 'USDG', 'DAI', 'FDUSD', 'TUSD', 'USDE', 'PYUSD', 'USD1', 'RLUSD', 'EURC', 'EURT', 'USDD', 'USDP', 'BUSD', 'XAUT', 'PAXG']);
// Токенизированные акции OKX: XTSLA, XNVDA, XMU. Это не крипта
const STOCK = /^X[A-Z]{3,}$|^XMU$/;

// Монета без оборота рисовала бы пустой лист, а привязанная к доллару или золоту стоит на месте по определению
export function parseCoins(data: { instId: string; volCcy24h: string }[]): string[] {
  return data
    .filter((d) => d.instId.endsWith('-USDT') && Number(d.volCcy24h) >= MIN_VOLUME)
    .sort((a, b) => Number(b.volCcy24h) - Number(a.volCcy24h))
    .map((d) => d.instId.slice(0, -'-USDT'.length))
    .filter((coin) => !PEGGED.has(coin) && !STOCK.test(coin))
    .flatMap((coin, i) => (i === 2 ? ['USDT', coin] : [coin]));
}

// Сам USDT не торгуется к себе, поэтому его цена считается в долларах
export const quoteOf = (coin: string) => (coin === 'USDT' ? 'USD' : 'USDT');

export interface Bar {
  t: number;
  close: number;
  buy: number;
  sell: number;
}

export type Tick =
  | { kind: 'trade'; symbol: string; price: number; qty: number; time: number; sell: boolean }
  | { kind: 'mini'; symbol: string; open: number; close: number };

export interface RawTrade {
  instId: string;
  tradeId: string;
  px: string;
  sz: string;
  side: 'buy' | 'sell';
  ts: string;
}

// Ответ на подписку и служебные сообщения приходят без data и просто пропускаются
export function parseTicks(raw: string): Tick[] {
  const { arg, data } = JSON.parse(raw);
  if (!data) return [];
  if (arg?.channel === 'trades') {
    return (data as RawTrade[]).map((d) => ({
      kind: 'trade',
      symbol: d.instId,
      price: +d.px,
      qty: +d.sz,
      time: +d.ts,
      sell: d.side === 'sell',
    }));
  }
  if (arg?.channel === 'tickers') {
    return data.map((d: { instId: string; open24h: string; last: string }) => ({
      kind: 'mini',
      symbol: d.instId,
      open: +d.open24h,
      close: +d.last,
    }));
  }
  return [];
}

// У OKX нет секундных свечей с разделением на покупки и продажи, поэтому они собираются из сделок
export function barsFromTrades(trades: RawTrade[]): Bar[] {
  const bars = new Map<number, Bar>();
  for (const trade of [...trades].sort((a, b) => +a.ts - +b.ts)) {
    const t = Math.floor(+trade.ts / 1000);
    const bar = bars.get(t) ?? { t, close: +trade.px, buy: 0, sell: 0 };
    bar.close = +trade.px;
    bar[trade.side] += +trade.sz;
    bars.set(t, bar);
  }
  return [...bars.values()];
}

// Свечи дают всю ширину одним запросом, но не делят объём: секунда роста считается покупками, падения продажами
export function barsFromCandles(rows: string[][]): Bar[] {
  return rows
    .map(([ts, open, , , close, volume]) => {
      const [o, c, v] = [+open, +close, +volume];
      return { t: +ts / 1000, close: c, buy: c > o ? v : c < o ? 0 : v / 2, sell: c < o ? v : c > o ? 0 : v / 2 };
    })
    .sort((a, b) => a.t - b.t);
}

export class Tape {
  bars: Bar[] = [];
  private liveFrom = Infinity;

  add(price: number, qty: number, timeMs: number, sell: boolean): void {
    const t = Math.floor(timeMs / 1000);
    this.liveFrom = Math.min(this.liveFrom, t);
    let bar = this.bars.at(-1);
    if (!bar || bar.t < t) {
      bar = { t, close: price, buy: 0, sell: 0 };
      this.bars.push(bar);
    }
    bar.close = price;
    if (sell) bar.sell += qty;
    else bar.buy += qty;
    const cutoff = t - SPAN_MS / 1000 - 10;
    while (this.bars[0].t < cutoff) this.bars.shift();
  }

  // Живые секунды не трогаем, а в истории более точный источник приходит вторым и заменяет оценку
  seed(history: Bar[]): void {
    const known = new Map(this.bars.map((b) => [b.t, b]));
    for (const b of history) if (b.t < this.liveFrom) known.set(b.t, b);
    this.bars = [...known.values()].sort((a, b) => a.t - b.t);
  }
}

export interface Cell {
  slot: number;
  buy: number;
  sell: number;
  open: number;
  close: number;
}

// Окна идут по времени: положение на листе — самый точный канал, и он отдан времени и цене
export function windows(bars: Bar[], nowSec: number): Cell[] {
  const cells = new Map<number, Cell>();
  const current = Math.floor(nowSec / CELL_SEC);
  for (const b of bars) {
    const slot = Math.floor(b.t / CELL_SEC);
    if (slot <= current - CELLS || slot > current) continue;
    const cell = cells.get(slot) ?? { slot, buy: 0, sell: 0, open: b.close, close: b.close };
    cell.buy += b.buy;
    cell.sell += b.sell;
    cell.close = b.close;
    cells.set(slot, cell);
  }
  return [...cells.values()].sort((a, b) => a.slot - b.slot);
}

export interface Span {
  lo: number;
  hi: number;
}

// Высота листа не меньше 0,1% цены: иначе движение на копейки выглядело бы обвалом
export function priceSpan(cells: Cell[]): Span {
  const prices = cells.flatMap((c) => [c.open, c.close]);
  const [lo, hi] = [Math.min(...prices), Math.max(...prices)];
  const mid = (lo + hi) / 2;
  const room = Math.max(hi - lo, mid * MIN_SPAN) / 2;
  return { lo: mid - room, hi: mid + room };
}

export function priceY(price: number, { lo, hi }: Span): number {
  return ART.y + R_MAX + (1 - (price - lo) / (hi - lo)) * (ART.h - R_MAX * 2);
}

// Площадь круга пропорциональна объёму: крупная сделка заметна, а тихое окно остаётся бусиной
export function cellRadius(volume: number, peak: number): number {
  return Math.max(R_MIN, R_MAX * Math.sqrt(volume / peak));
}

// Круг дышит вокруг своего размера, у каждого своя фаза, поэтому цепочка колышется, а не пульсирует хором
export const breath = (phase: number, i: number) => 1 + BREATH * Math.sin(phase + i * 1.7);

// Темп дыхания растёт со сделками, но остаётся спокойным: от 10 до 3,5 секунды на вдох
export const breathRate = (tradesPerSec: number) => 0.6 + Math.min(tradesPerSec, 20) * 0.06;

const fadeStep = (cells: number) => {
  const k = clamp(cells / FADE_CELLS, 0, 1);
  return k * k * (3 - 2 * k);
};

// Вход зеркален выходу: окно проявляется у правого края так же долго, как растворяется у левого
export function edgeFade(cellsOld: number): number {
  return fadeStep(cellsOld) * fadeStep(CELLS - cellsOld);
}

interface Spot {
  cell: Cell;
  x: number;
  y: number;
  tail: number;
  r: number;
  core: number;
  alpha: number;
}

interface Shown {
  r: Glide;
  core: Glide;
  y: Glide;
  tail: Glide;
}

export class Markets implements Poster {
  readonly service = tr('Рынки', 'Markets');
  readonly source = 'OKX';
  readonly kind = tr('другая монета', 'another coin');
  readonly align = 'left';
  readonly ink = INK;
  readonly feeds = [new Feed('OKX', 15_000)];
  readonly encoding: Encoding = {
    color: tr('Площадь тёмного ядра — доля покупок в окне. Красный, оранжевый и жёлтый след тянется к цене, с которой окно открылось.', 'The area of the dark core is the share of buys in the window. The red, orange and yellow trail reaches back to the price the window opened at.'),
    form: tr('Цепочка — 5 минут торгов, круг — 10 секунд. Высота круга — цена закрытия окна, площадь — объём. Лист вмещает размах цены за 5 минут, но не меньше 0,1%, поэтому в тихом рынке цепочка лежит ровно.', 'The chain is 5 minutes of trading, each circle 10 seconds. A circle\'s height is the closing price of its window, its area the volume. The sheet holds the 5-minute price range, never less than 0.1%, so in a quiet market the chain lies flat.'),
    speed: tr('Цепочка ползёт влево вместе со временем: новое окно проявляется у правого края, старое растворяется у левого. Круги дышат на 10% вокруг своего размера, и чем чаще сделки, тем быстрее.', 'The chain creeps left with time: a new window appears at the right edge, the old one dissolves at the left. Circles breathe 10% around their size, faster when trades come faster.'),
  };

  private coins = COINS;
  private coin = famous(COINS);
  private closeStream = () => {};
  private session = 0;
  private tape = new Tape();
  private trades = new Rolling();
  private price: number | null = null;
  private change: number | null = null;
  private span: Span | null = null;
  private shown = new Map<number, Shown>();
  private spots: Spot[] = [];
  private leaving: Spot[] = [];
  private leavingFade = 0;
  private reveal = { x: 0, v: 0 };
  private phase = 0;

  paper(): string {
    return PAPER;
  }

  start(): void {
    this.connect();
    getJson<{ data: { instId: string; volCcy24h: string }[] }>(`${REST}/tickers?instType=SPOT`)
      .then(({ data }) => {
        const coins = parseCoins(data);
        if (coins.length > 1) this.coins = coins;
      })
      .catch((err) => console.warn('OKX coins', err));
  }

  shuffle(rand?: () => number): void {
    this.closeStream();
    this.feeds[0].reset();
    this.coin = famous(this.coins, this.coin, rand);
    this.tape = new Tape();
    this.trades = new Rolling();
    this.price = this.change = this.span = null;
    this.shown = new Map();
    this.leaving = this.spots;
    this.leavingFade = 1;
    this.reveal = { x: 0, v: 0 };
    this.spots = [];
    this.connect();
  }

  private connect(): void {
    const instId = `${this.coin}-${quoteOf(this.coin)}`;
    const session = ++this.session;
    this.history(instId, session).catch((err) => console.warn('OKX history', err));

    const hello = JSON.stringify({ op: 'subscribe', args: [{ channel: 'trades', instId }, { channel: 'tickers', instId }] });
    const onMessage = (raw: string) => {
      for (const tick of parseTicks(raw)) {
        if (tick.kind === 'mini') {
          this.change = ((tick.close - tick.open) / tick.open) * 100;
        } else {
          this.price = tick.price;
          this.trades.add();
          this.tape.add(tick.price, tick.qty, tick.time, tick.sell);
        }
      }
    };
    this.closeStream = socket(this.feeds[0], 'wss://ws.okx.com:8443/ws/v5/public', onMessage, hello);
  }

  // Свечи сразу заполняют всю ширину, затем настоящие сделки уточняют столько окон, сколько покрывают
  private async history(instId: string, session: number): Promise<void> {
    const load = <T>(query: string) => getJson<{ data: T[] }>(`${REST}/${query}`).then((r) => r.data);
    const candles = await load<string[]>(`candles?instId=${instId}&bar=1s&limit=${SPAN_MS / 1000}`);
    if (session !== this.session) return;
    this.tape.seed(barsFromCandles(candles));
    const trades = await load<RawTrade>(`trades?instId=${instId}&limit=500`);
    if (session !== this.session) return;
    // Самая старая секунда страницы могла попасть в неё не целиком
    this.tape.seed(barsFromTrades(trades).slice(1));
  }

  label(now: number): Label {
    const price = this.price ?? this.tape.bars.at(-1)?.close;
    if (price === undefined) return { title: this.coin, print: `${this.coin}/${quoteOf(this.coin)}` };
    const parts = [`${fmtPrice(price)} ${quoteOf(this.coin)}`];
    if (this.change !== null) parts.push(`${fmtSigned(this.change)}% ${tr('за сутки', 'in 24 h')}`);
    const closes = this.tape.bars.filter((b) => b.t * 1000 >= now - SPAN_MS).map((b) => b.close);
    if (closes.length > 1) parts.push(`${tr('размах за 5 минут', '5-minute range')} ${fmtHundredths(((Math.max(...closes) - Math.min(...closes)) / price) * 100)}%`);
    parts.push(`${fmtDec(this.trades.rate(30, now))} ${tr('сделки в секунду', 'trades per second')}`);
    return { title: this.coin, print: `${parts.join(' · ')}.` };
  }

  draw({ ctx, now, dt }: Frame): void {
    const bars = this.tape.bars.filter((b) => b.t * 1000 >= now - SPAN_MS);
    this.leavingFade = Math.max(0, this.leavingFade - dt / LEAVE_SEC);
    if (this.leavingFade) this.paintSpots(ctx, this.leaving, this.leavingFade);
    if (bars.length < 2) {
      if (!this.leavingFade) waiting(ctx, this.ink);
      return;
    }

    const cells = windows(bars, now / 1000);
    const peak = Math.max(1e-9, ...cells.map((c) => c.buy + c.sell));
    const target = priceSpan(cells);
    const span = (this.span ??= target);
    const k = ease(dt, 1.2);
    span.lo += (target.lo - span.lo) * k;
    span.hi += (target.hi - span.hi) * k;
    this.phase += dt * breathRate(this.trades.rate(10, now));

    const head = now / 1000 / CELL_SEC;
    const shown = new Map<number, Shown>();
    glide(this.reveal, 1, dt, REVEAL_SEC);
    this.spots = cells.map((cell) => {
      const [y, tail] = [priceY(cell.close, span), priceY(cell.open, span)];
      const s = this.shown.get(cell.slot) ?? { r: { x: 0, v: 0 }, core: { x: 0, v: 0 }, y: { x: y, v: 0 }, tail: { x: tail, v: 0 } };
      const total = cell.buy + cell.sell;
      glide(s.r, cellRadius(total, peak), dt, GROW_SEC);
      glide(s.core, total ? Math.sqrt(cell.buy / total) : 0, dt, GROW_SEC);
      glide(s.y, y, dt, MOVE_SEC);
      glide(s.tail, tail, dt, MOVE_SEC);
      shown.set(cell.slot, s);
      return {
        cell,
        x: ART.x + ART.w - EDGE - (head - cell.slot - 0.5) * STEP,
        y: s.y.x,
        tail: s.tail.x,
        r: s.r.x,
        core: s.core.x,
        alpha: clamp(this.reveal.x, 0, 1) * edgeFade(head - cell.slot),
      };
    });
    this.shown = shown;
    this.paintSpots(ctx, this.spots, 1);
  }

  private paintSpots(ctx: CanvasRenderingContext2D, spots: Spot[], fade: number): void {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    for (const [color, share] of [
      [YELLOW, 1],
      [ORANGE, 0.66],
      [RED, 0.33],
    ] as const) {
      spots.forEach(({ cell, x, y, tail, r, alpha }) => {
        ctx.globalAlpha = alpha * fade;
        disc(ctx, x, y + (tail - y) * share, r * breath(this.phase, cell.slot), color);
      });
    }
    ctx.restore();

    // Порядок всегда по времени: сортировка по размеру мгновенно меняла бы местами соседние круги
    for (const { cell, x, y, r, core, alpha } of spots) {
      const size = r * breath(this.phase, cell.slot);
      ctx.globalAlpha = 0.9 * alpha * fade;
      disc(ctx, x, y, size, SKY);
      ctx.globalAlpha = alpha * fade;
      disc(ctx, x, y, size * core, DEEP);
    }
    ctx.globalAlpha = 1;
  }

  pick(x: number, y: number): Tip | null {
    const spot = this.spots.findLast((s) => Math.hypot(s.x - x, s.y - y) < Math.max(s.r, 2));
    if (!spot) return null;
    const c = spot.cell;
    return {
      value: `${fmtClock(c.slot * CELL_SEC * 1000)}:${String((c.slot * CELL_SEC) % 60).padStart(2, '0')}`,
      label: `${fmtPrice(c.close)} ${quoteOf(this.coin)} · ${tr('покупки', 'buys')} ${c.buy.toFixed(3)} · ${tr('продажи', 'sells')} ${c.sell.toFixed(3)} ${this.coin}`,
    };
  }
}
