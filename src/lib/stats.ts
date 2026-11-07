// Счётчик событий по секундам в кольцевом буфере
export class Rolling {
  private readonly counts: Float64Array;
  private readonly stamps: Float64Array;

  constructor(private readonly size = 120) {
    this.counts = new Float64Array(size);
    this.stamps = new Float64Array(size);
  }

  add(n = 1, t = Date.now()): void {
    const sec = Math.floor(t / 1000);
    const i = sec % this.size;
    if (this.stamps[i] !== sec) {
      this.stamps[i] = sec;
      this.counts[i] = 0;
    }
    this.counts[i] += n;
  }

  // Среднее в секунду по завершённым секундам: текущая ещё не досчитана
  rate(windowSec: number, t = Date.now()): number {
    const sec = Math.floor(t / 1000);
    let sum = 0;
    for (let s = sec - windowSec; s < sec; s++) {
      const i = ((s % this.size) + this.size) % this.size;
      if (this.stamps[i] === s) sum += this.counts[i];
    }
    return sum / windowSec;
  }
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function sample<T>(pool: T[], count: number, rand: () => number): T[] {
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

// Новый выбор всегда отличается от текущего, иначе нажатие выглядело бы как сбой
export function other<T>(pool: T[], current: T, rand: () => number = Math.random): T {
  return sample(pool.filter((v) => v !== current), 1, rand)[0];
}

// Список идёт от славных к безвестным: первая десятая часть выпадает почти в половине случаев, но очередь доходит до всех
export function famous<T>(pool: T[], current?: T, rand: () => number = Math.random): T {
  const rest = pool.filter((v) => v !== current);
  return rest[Math.floor(rest.length * rand() ** 3)];
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// Шаг сглаживания, не зависящий от частоты кадров
export const ease = (dt: number, perSecond: number) => 1 - Math.exp(-dt * perSecond);

export interface Glide {
  x: number;
  v: number;
}

// Критически демпфированная пружина: плавный разгон и остановка без перелёта
export function glide(g: Glide, target: number, dt: number, seconds: number): void {
  const omega = 2 / seconds;
  const step = omega * dt;
  const decay = 1 / (1 + step + 0.48 * step ** 2 + 0.235 * step ** 3);
  const gap = g.x - target;
  const pull = (g.v + omega * gap) * dt;
  g.v = (g.v - omega * pull) * decay;
  g.x = target + (gap + pull) * decay;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
