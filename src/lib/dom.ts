import { LANG, LANGS, setLang } from './i18n';

// На GitHub Pages сайт живёт в подпапке, на дев-сервере в корне
export const HOME = import.meta.env.BASE_URL;
export const sitePath = (pathname: string) => pathname.slice(HOME.length - 1);

// Киоск показывает работы без зрителя за экраном и на слабом устройстве
export const KIOSK = typeof location !== 'undefined' && sitePath(location.pathname).startsWith('/kiosk');

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  parent?.append(node);
  return node;
}

export function setText(node: HTMLElement, value: string): void {
  if (node.textContent !== value) node.textContent = value;
}

export function button(label: string, parent: HTMLElement, onClick: () => void): HTMLButtonElement {
  const b = el('button', '', parent);
  b.type = 'button';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
}

export function link(label: string, href: string, parent: HTMLElement, className = 'action'): HTMLAnchorElement {
  const a = el('a', className, parent);
  a.href = href;
  a.textContent = label;
  return a;
}

export function langSwitch(parent: HTMLElement): void {
  const group = el('span', 'lang', parent);
  for (const lang of LANGS) {
    const b = button(lang.toUpperCase(), group, () => setLang(lang));
    b.setAttribute('aria-pressed', String(lang === LANG));
    b.lang = lang;
  }
}

export const toggleFullscreen = () =>
  document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
