export const INK = '#1f1e1c';
export const PAPER = '#f1ede4';
export const FONT = '"Jost Variable", "Futura", "Century Gothic", system-ui, sans-serif';

function rgb(hex: string): number[] {
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
}

export function mixHex(a: string, b: string, k: number): string {
  const [ca, cb] = [rgb(a), rgb(b)];
  const t = Math.min(1, Math.max(0, k));
  const parts = ca.map((v, i) => Math.round(v + (cb[i] - v) * t));
  return `#${parts.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export function alpha(hex: string, a: number): string {
  return `rgb(${rgb(hex).join(' ')} / ${a})`;
}

export function nearest(hex: string, palette: string[]): string {
  const c = rgb(hex);
  const distance = (p: string) => rgb(p).reduce((sum, v, i) => sum + (v - c[i]) ** 2, 0);
  return palette.reduce((a, b) => (distance(b) < distance(a) ? b : a));
}

// Бумага теплеет вместе с городом
const PAPER_RAMP: [number, string][] = [
  [-25, '#c9d6dc'],
  [0, '#dfe0da'],
  [15, '#e9e0cf'],
  [28, '#e6cdaa'],
  [42, '#e0a981'],
];

export function tempPaper(t: number): string {
  const i = PAPER_RAMP.findIndex(([edge]) => t <= edge);
  if (i === 0) return PAPER_RAMP[0][1];
  if (i === -1) return PAPER_RAMP[PAPER_RAMP.length - 1][1];
  const [[t0, c0], [t1, c1]] = [PAPER_RAMP[i - 1], PAPER_RAMP[i]];
  return mixHex(c0, c1, (t - t0) / (t1 - t0));
}
