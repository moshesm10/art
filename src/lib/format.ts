import { LOCALE, tr } from './i18n';

const int = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const dec = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
const hundredths = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const clock = new Intl.DateTimeFormat(LOCALE, { hour: '2-digit', minute: '2-digit' });
const weekday = new Intl.DateTimeFormat(LOCALE, { weekday: 'short' });

const day = new Intl.DateTimeFormat(LOCALE, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export const fmtDay = (iso: string) => day.format(Date.parse(iso)).replace(' г.', '');
export const fmtInt = (n: number) => int.format(n);
export const fmtDec = (n: number) => dec.format(n);
export const fmtHundredths = (n: number) => hundredths.format(n);
export const fmtClock = (t: number) => clock.format(t);

// Табло ESPN охватывает неделю вперёд, поэтому дня недели достаточно
export function fmtKickoff(t: number, now: number): string {
  const sameDay = new Date(t).toDateString() === new Date(now).toDateString();
  return sameDay ? clock.format(t) : `${weekday.format(t)} ${clock.format(t)}`;
}

export function fmtPrice(n: number): string {
  // У монет дешевле цента важны первые значащие цифры, а не четыре нуля
  if (n > 0 && n < 0.01) return n.toLocaleString(LOCALE, { maximumSignificantDigits: 4 });
  const digits = n >= 1000 ? 0 : n >= 1 ? 2 : 4;
  return n.toLocaleString(LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const fmtSigned = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${dec.format(Math.abs(n))}`;
export const fmtTemp = (t: number) => `${Math.round(t) < 0 ? '−' : ''}${int.format(Math.abs(Math.round(t)))}°`;

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  return b >= 2 && b <= 4 ? few : many;
}

// Число со словом на языке зрителя: в русском три формы, в английском две
export function word(n: number, ru: [string, string, string], en: [string, string]): string {
  return tr(plural(n, ...ru), Math.abs(n) === 1 ? en[0] : en[1]);
}
