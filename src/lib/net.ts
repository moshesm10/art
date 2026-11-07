export type Status = 'connecting' | 'live' | 'stale' | 'offline';

export class Feed {
  lastAt = 0;
  failed = false;

  constructor(
    readonly name: string,
    readonly staleMs: number,
  ) {}

  ok(): void {
    this.lastAt = Date.now();
    this.failed = false;
  }

  fail(): void {
    this.failed = true;
  }

  reset(): void {
    this.lastAt = 0;
    this.failed = false;
  }

  status(now = Date.now()): Status {
    if (this.failed) return 'offline';
    if (!this.lastAt) return 'connecting';
    return now - this.lastAt > this.staleMs ? 'stale' : 'live';
  }
}

const SEVERITY: Status[] = ['live', 'connecting', 'stale', 'offline'];

export function worstFeed(feeds: Feed[], now = Date.now()): Feed {
  return feeds.reduce((a, b) =>
    SEVERITY.indexOf(b.status(now)) > SEVERITY.indexOf(a.status(now)) ? b : a,
  );
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

const RETRY_MS = 3000;

// После сбоя опрос не ждёт полный интервал: у погоды это оставило бы постер пустым на пять минут
export function nextDelay(everyMs: number, failures: number): number {
  return failures ? Math.min(everyMs, RETRY_MS * 2 ** (failures - 1)) : everyMs;
}

// Возвращает функцию внеочередного опроса; ответ, который она обогнала, отбрасывается
export function poll<T>(feed: Feed, everyMs: number, load: () => Promise<T>, onData: (data: T) => void): () => void {
  let timer = 0;
  let latest = 0;
  let failures = 0;
  const tick = async () => {
    const run = ++latest;
    clearTimeout(timer);
    try {
      const data = await load();
      if (run !== latest) return;
      onData(data);
      feed.ok();
      failures = 0;
    } catch (err) {
      if (run !== latest) return;
      console.warn(feed.name, err);
      feed.fail();
      failures++;
    }
    timer = window.setTimeout(tick, nextDelay(everyMs, failures));
  };
  void tick();
  return () => void tick();
}

export function socket(feed: Feed, url: string, onMessage: (raw: string) => void, hello?: string): () => void {
  let retryMs = 1000;
  let closed = false;
  let ws: WebSocket;
  const open = () => {
    ws = new WebSocket(url);
    if (hello) ws.onopen = () => ws.send(hello);
    ws.onmessage = (e) => {
      if (closed) return;
      retryMs = 1000;
      feed.ok();
      onMessage(e.data as string);
    };
    ws.onclose = () => {
      if (closed) return;
      feed.fail();
      setTimeout(open, retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    };
  };
  open();
  return () => {
    closed = true;
    ws.close();
  };
}

export function eventStream(feed: Feed, url: string, onMessage: (raw: string) => void): void {
  const source = new EventSource(url);
  source.onmessage = (e) => {
    feed.ok();
    onMessage(e.data as string);
  };
  source.onerror = () => feed.fail();
}
