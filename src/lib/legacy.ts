import { directUrl } from '../routes';

// Киоск живёт на iPad mini 2: там iOS 12, и этих методов в браузере ещё нет
const patch = <T extends object>(target: T, name: string, value: unknown) => {
  if (!(name in target)) Object.defineProperty(target, name, { value, writable: true, configurable: true });
};

patch(Array.prototype, 'at', function (this: unknown[], i: number) {
  return this[i < 0 ? this.length + i : i];
});

patch(Array.prototype, 'findLast', function (this: unknown[], test: (item: unknown) => boolean) {
  for (let i = this.length - 1; i >= 0; i--) if (test(this[i])) return this[i];
  return undefined;
});

patch(Promise, 'allSettled', (items: Promise<unknown>[]) =>
  Promise.all(
    items.map((item) =>
      Promise.resolve(item).then(
        (value) => ({ status: 'fulfilled', value }),
        (reason) => ({ status: 'rejected', reason }),
      ),
    ),
  ),
);

patch(AbortSignal, 'timeout', (ms: number) => {
  const control = new AbortController();
  setTimeout(() => control.abort(), ms);
  return control.signal;
});

patch(window, 'createImageBitmap', (blob: Blob) => {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  return new Promise((resolve, reject) => {
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => reject(new Error('Картинка не разобрана'));
    image.src = url;
  });
});

patch(CanvasRenderingContext2D.prototype, 'roundRect', function (
  this: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radii: number | number[] = 0,
) {
  const [tl, tr = tl, br = tl, bl = tr] = typeof radii === 'number' ? [radii] : radii;
  this.moveTo(x + tl, y);
  this.arcTo(x + w, y, x + w, y + h, tr);
  this.arcTo(x + w, y + h, x, y + h, br);
  this.arcTo(x, y + h, x, y, bl);
  this.arcTo(x, y, x + w, y, tl);
  this.closePath();
});

// На статичном хостинге нет прокси Vite, поэтому адреса /api ведут прямо к источникам
if (import.meta.env.PROD) {
  const send = window.fetch.bind(window);
  window.fetch = (input, init) => send(typeof input === 'string' ? directUrl(input) : input, init);
}
