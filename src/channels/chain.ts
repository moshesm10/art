import { fmtInt, word } from '../lib/format';
import { tr } from '../lib/i18n';
import { Feed, getJson, poll } from '../lib/net';
import { ART, disc, waiting, type Encoding, type Frame, type Label, type Poster, type Tip } from '../lib/poster';
import { clamp, famous, glide } from '../lib/stats';
import { INK, PAPER } from '../lib/theme';

const LOOK = globalThis.location?.search.match(/look=(\w+)/)?.[1] ?? 'a';

const TICK_MS = 3000;
const MAX_DOTS = 5000;
const OVERFLOW = 1.5;
const BURST_SEC = 0.9;
const CHAIN_LENGTH = 12;
const NIGHT = '#08080a';
const RPC_TIP = [
  { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] },
  { jsonrpc: '2.0', id: 2, method: 'eth_getBlockTransactionCountByNumber', params: ['latest'] },
];

export interface Reading {
  height: number;
  txs: number;
  at?: number;
}

interface Chain {
  name: string;
  en: string;
  color: string;
  blockSec: number;
  pollSec: number;
  batch: number;
  typical: number;
  load: () => Promise<Reading>;
}

interface RpcReply<T = string> {
  id: number;
  result: T;
}

export function parseMempool(blocks: { height: number; tx_count: number; timestamp: number }[]): Reading {
  return { height: blocks[0].height, txs: blocks[0].tx_count, at: blocks[0].timestamp * 1000 };
}

export function parseRpc(replies: RpcReply[]): Reading {
  const [height, txs] = [1, 2].map((id) => parseInt(replies.find((r) => r.id === id)!.result, 16));
  return { height, txs };
}

export function parseXrp(json: { result: { ledger: { ledger_index: string; transactions?: string[] } } }): Reading {
  const { ledger_index, transactions = [] } = json.result.ledger;
  return { height: Number(ledger_index), txs: transactions.length };
}

export function parseKoios(blocks: { block_height: number; tx_count: number; block_time: number }[]): Reading {
  return { height: blocks[0].block_height, txs: blocks[0].tx_count, at: blocks[0].block_time * 1000 };
}

// Solana не отдаёт блок дёшево: число транзакций на блок берётся из минутной сводки сети
export function parseSolana(replies: (RpcReply<number> | RpcReply<{ numSlots: number; numTransactions: number }[]>)[]): Reading {
  const height = replies.find((r) => r.id === 1)!.result as number;
  const [sample] = replies.find((r) => r.id === 2)!.result as { numSlots: number; numTransactions: number }[];
  return { height, txs: sample.numTransactions / sample.numSlots };
}

function parseDoge(json: { data: { id: number; transaction_count: number; time: string }[] }): Reading {
  const [block] = json.data;
  return { height: block.id, txs: block.transaction_count, at: Date.parse(`${block.time.replace(' ', 'T')}Z`) };
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const evm = (route: string) => async () => parseRpc(await post<RpcReply[]>(`/api/${route}/`, RPC_TIP));

async function tron(): Promise<Reading> {
  const [block, count] = await Promise.all([
    post<{ block_header: { raw_data: { number: number } } }>('/api/grid/wallet/getblock', { detail: false }),
    post<RpcReply>('/api/evm-tron/', RPC_TIP[1]),
  ]);
  return { height: block.block_header.raw_data.number, txs: parseInt(count.result, 16) };
}

// Порядок по известности. Быстрые сети сбрасывают лист раз в несколько блоков: разряд на каждый блок стал бы стробоскопом
const CHAINS: Chain[] = [
  { name: 'Биткоин', en: 'Bitcoin', color: '#f5902b', blockSec: 600, pollSec: 20, batch: 1, typical: 3500, load: async () => parseMempool(await getJson('/api/btc/api/blocks')) },
  { name: 'Эфириум', en: 'Ethereum', color: '#6d8fd9', blockSec: 12, pollSec: 3, batch: 1, typical: 150, load: evm('eth') },
  { name: 'Solana', en: 'Solana', color: '#9a6df0', blockSec: 0.21, pollSec: 3, batch: 40, typical: 320, load: async () => parseSolana(await post('/api/sol/', [{ jsonrpc: '2.0', id: 1, method: 'getSlot' }, { jsonrpc: '2.0', id: 2, method: 'getRecentPerformanceSamples', params: [1] }])) },
  { name: 'XRP', en: 'XRP', color: '#3fb6c4', blockSec: 3.9, pollSec: 3, batch: 2, typical: 100, load: async () => parseXrp(await post('/api/xrp/', { method: 'ledger', params: [{ ledger_index: 'validated', transactions: true }] })) },
  { name: 'BNB', en: 'BNB', color: '#fbdf63', blockSec: 0.45, pollSec: 3, batch: 18, typical: 45, load: evm('bsc') },
  { name: 'Tron', en: 'Tron', color: '#e63c1e', blockSec: 3, pollSec: 3, batch: 3, typical: 300, load: tron },
  { name: 'Dogecoin', en: 'Dogecoin', color: '#d8b45a', blockSec: 60, pollSec: 60, batch: 1, typical: 30, load: async () => parseDoge(await getJson('/api/doge/dogecoin/blocks?limit=1')) },
  { name: 'Cardano', en: 'Cardano', color: '#4a6fe0', blockSec: 20, pollSec: 6, batch: 1, typical: 10, load: async () => parseKoios(await getJson('/api/koios/api/v1/blocks?limit=1')) },
  { name: 'Avalanche', en: 'Avalanche', color: '#ef6a6a', blockSec: 0.82, pollSec: 3, batch: 9, typical: 5, load: evm('avax') },
  { name: 'Litecoin', en: 'Litecoin', color: '#a9b4c2', blockSec: 150, pollSec: 20, batch: 1, typical: 90, load: async () => parseMempool(await getJson('/api/ltc/api/blocks')) },
];

// Заряд копится со скоростью сети, а разряжает его только настоящий новый блок
export class Charge {
  height: number | null = null;
  txs = 0;
  private rate: number;
  private from = 0;
  private base = 0;

  constructor(
    private readonly batch: number,
    private readonly blockSec: number,
    typical: number,
  ) {
    this.rate = typical / blockSec;
  }

  read(reading: Reading, now: number): boolean {
    if (this.height === null) {
      this.from = Math.min(reading.at ?? now, now);
      this.base = reading.height;
    } else if (reading.height > this.height) {
      this.rate += (reading.txs / this.blockSec - this.rate) * 0.3;
    }
    this.height = reading.height;
    this.txs = reading.txs;
    if (reading.height - this.base < this.batch) return false;
    this.base = reading.height;
    this.from = now;
    return true;
  }

  expected(): number {
    return this.rate * this.blockSec * this.batch;
  }

  pending(now: number): number {
    return this.rate * Math.max(0, now - this.from) / 1000;
  }

  tension(now: number): number {
    return this.pending(now) / Math.max(1, this.expected());
  }
}

// Последовательность R2 заполняет лист ровно: новая точка всегда ложится в самое пустое место
const seat = (i: number) => [(0.5 + i * 0.7548776662) % 1, (0.5 + i * 0.5698402910) % 1];

export class Blocks implements Poster {
  readonly service = tr('Блокчейн', 'Blockchain');
  readonly source = 'Mempool, PublicNode, XRPL, Koios';
  readonly kind = tr('другая сеть', 'another network');
  readonly align = 'left';
  readonly ink = LOOK === 'a' ? PAPER : INK;
  readonly feeds = [new Feed(tr('Сеть', 'Network'), 5 * 60_000)];
  readonly encoding: Encoding = {
    color: tr('Цвет — сеть. Лист копит заряд её цветом, а новый блок забирает всё разом.', 'Colour is the network. The sheet charges in its colour, and a new block takes it all at once.'),
    form: tr('Точка — транзакция, ждущая блока: лист заполняется со скоростью сети. У самых быстрых сетей одна точка значит несколько транзакций.', 'A dot is a transaction waiting for a block: the sheet fills at the speed of the network. On the fastest networks one dot stands for several transactions.'),
    speed: tr('Разрядка настоящая: её вызывает новый блок. Биткоин копит примерно 10 минут, Эфириум 12 секунд, а быстрые сети разряжаются раз в несколько блоков, примерно раз в 8 секунд.', 'The discharge is real: a new block triggers it. Bitcoin charges for about 10 minutes, Ethereum for 12 seconds, and fast networks discharge every few blocks, about every 8 seconds.'),
  };

  private chain = famous(CHAINS);
  private charge = this.fresh();
  private refresh = () => {};
  private fetched = 0;
  private burst = { left: 0, count: 0 };
  private past: number[] = [];
  private size = { x: 0, v: 0 };

  private fresh(): Charge {
    return new Charge(this.chain.batch, this.chain.blockSec, this.chain.typical);
  }

  paper(): string {
    return LOOK === 'a' ? NIGHT : PAPER;
  }

  start(): void {
    this.refresh = poll(
      this.feeds[0],
      TICK_MS,
      async () => {
        const chain = this.chain;
        if (Date.now() - this.fetched < chain.pollSec * 1000) return null;
        this.fetched = Date.now();
        return { chain, reading: await chain.load() };
      },
      (data) => {
        if (!data || data.chain !== this.chain) return;
        const now = Date.now();
        const shown = this.dots(now);
        if (!this.charge.read(data.reading, now)) return;
        this.burst = { left: 1, count: shown };
        this.past = [...this.past, this.charge.txs].slice(-CHAIN_LENGTH);
      },
    );
  }

  shuffle(rand?: () => number): void {
    this.chain = famous(CHAINS, this.chain, rand);
    this.charge = this.fresh();
    this.burst = { left: 0, count: 0 };
    this.past = [];
    this.fetched = 0;
    this.feeds[0].reset();
    this.refresh();
  }

  private perDot(): number {
    return Math.max(1, Math.ceil(this.charge.expected() / MAX_DOTS));
  }

  private expectedDots(): number {
    return Math.max(1, this.charge.expected() / this.perDot());
  }

  // Сети с редкими транзакциями рисуются крупнее: полный заряд заполняет лист одинаково у всех
  private dotSize(): number {
    return clamp(Math.sqrt((ART.w * ART.h * 0.16) / this.expectedDots()), 0.34, 4);
  }

  private dots(now: number): number {
    return Math.min(MAX_DOTS * OVERFLOW, Math.floor(this.charge.pending(now) / this.perDot()));
  }

  label(now: number): Label {
    const title = tr(this.chain.name, this.chain.en);
    if (this.charge.height === null) return { title, print: tr('Новый блок разряжает лист', 'A new block discharges the sheet') };
    const txs = Math.round(this.charge.txs);
    const parts = [
      `${tr('Блок', 'Block')} ${fmtInt(this.charge.height)}`,
      `${fmtInt(txs)} ${word(txs, ['транзакция', 'транзакции', 'транзакций'], ['transaction', 'transactions'])}`,
      `${tr('заряд', 'charge')} ${Math.round(this.charge.tension(now) * 100)}%`,
    ];
    return { title, print: parts.join(' · ') };
  }

  private sparks(ctx: CanvasRenderingContext2D, count: number, now: number): void {
    const shake = clamp(this.charge.tension(now) - 1, 0, 1) * 0.5;
    const size = this.dotSize();
    ctx.fillStyle = this.chain.color;
    for (let i = 0; i < count; i++) {
      const [u, v] = seat(i);
      const wobble = shake * Math.sin(i * 12.9 + now / 90);
      ctx.fillRect(ART.x + u * ART.w + wobble, ART.y + v * ART.h, size, size);
    }
  }

  // Точки сжимаются в центр: так очередь становится блоком
  private collapse(ctx: CanvasRenderingContext2D, tx: number, ty: number): void {
    const t = 1 - this.burst.left;
    const pull = t * t * (3 - 2 * t);
    const size = this.dotSize();
    ctx.fillStyle = this.chain.color;
    ctx.globalAlpha = 1 - pull * 0.6;
    for (let i = 0; i < this.burst.count; i++) {
      const [u, v] = seat(i);
      const x = ART.x + u * ART.w;
      const y = ART.y + v * ART.h;
      ctx.fillRect(x + (tx - x) * pull, y + (ty - y) * pull, size, size);
    }
    ctx.globalAlpha = 1;
  }

  private vessel(ctx: CanvasRenderingContext2D, count: number): void {
    const top = ART.y + 12;
    const height = ART.y + ART.h - top;
    ctx.fillStyle = this.chain.color;
    const full = this.expectedDots() * OVERFLOW;
    const size = this.dotSize();
    for (let i = 0; i < count; i++) {
      const [u] = seat(i);
      ctx.fillRect(ART.x + u * (ART.w - size), ART.y + ART.h - size - Math.min(1, i / full) * (height - size), size, size);
    }
  }

  private links(ctx: CanvasRenderingContext2D): void {
    const biggest = Math.max(1, ...this.past);
    const step = ART.w / CHAIN_LENGTH;
    ctx.fillStyle = this.chain.color;
    this.past.forEach((txs, i) => {
      const side = 1.2 + 4.6 * Math.sqrt(txs / biggest);
      ctx.fillRect(ART.x + i * step, ART.y + 7 - side, side, side);
    });
  }

  private balloon(ctx: CanvasRenderingContext2D, now: number, dt: number): void {
    const radius = 30;
    const cx = ART.x + ART.w / 2;
    const cy = ART.y + ART.h / 2;
    glide(this.size, Math.sqrt(clamp(this.charge.tension(now), 0, OVERFLOW)), dt, this.burst.left > 0 ? 0.25 : 0.8);
    ctx.strokeStyle = this.ink;
    ctx.lineWidth = 0.18;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    disc(ctx, cx, cy, radius * this.size.x, this.chain.color);
    if (this.burst.left <= 0) return;
    ctx.globalAlpha = this.burst.left;
    ctx.strokeStyle = this.chain.color;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius * (1 + (1 - this.burst.left) * 0.5), 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  draw({ ctx, now, dt }: Frame): void {
    if (this.charge.height === null) return waiting(ctx, this.ink);
    this.burst.left = Math.max(0, this.burst.left - dt / BURST_SEC);
    const count = this.dots(now);
    if (LOOK === 'c') return this.balloon(ctx, now, dt);
    if (LOOK === 'b') {
      this.links(ctx);
      this.vessel(ctx, count);
      if (this.burst.left > 0) this.collapse(ctx, ART.x + (Math.min(this.past.length, CHAIN_LENGTH) - 0.5) * (ART.w / CHAIN_LENGTH), ART.y + 5);
      return;
    }
    this.sparks(ctx, count, now);
    if (this.burst.left > 0) this.collapse(ctx, ART.x + ART.w / 2, ART.y + ART.h / 2);
  }

  pick(_x: number, _y: number, now: number): Tip | null {
    if (this.charge.height === null) return null;
    const dot = this.perDot();
    return { value: `${fmtInt(Math.round(this.charge.pending(now)))} ${tr('в очереди', 'in queue')}`, label: dot > 1 ? tr(`Точка — ${dot} транзакции`, `One dot is ${dot} transactions`) : tr('Точка — транзакция', 'One dot is a transaction') };
  }
}
