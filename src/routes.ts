// Источники за префиксами /api. На дев-сервере их проксирует Vite, в сборке браузер идёт к ним напрямую
export const ROUTES: Record<string, string> = {
  '/api/adsb': 'https://api.adsb.lol',
  '/api/okx': 'https://www.okx.com',
  '/api/espn': 'https://site.api.espn.com',
  '/api/metno': 'https://api.met.no',
  '/api/air': 'https://air-quality-api.open-meteo.com',
  '/api/webcams': 'https://webcams.windy.com',
  '/api/koios': 'https://api.koios.rest',
  // Из браузера в России эти хосты часто зависают, с сервера отвечают стабильно
  '/api/btc': 'https://mempool.space',
  '/api/ltc': 'https://litecoinspace.org',
  '/api/doge': 'https://api.blockchair.com',
  '/api/xrp': 'https://xrplcluster.com',
  '/api/eth': 'https://ethereum-rpc.publicnode.com',
  '/api/bsc': 'https://bsc-rpc.publicnode.com',
  '/api/avax': 'https://avalanche-c-chain-rpc.publicnode.com',
  '/api/sol': 'https://solana-rpc.publicnode.com',
  '/api/grid': 'https://api.trongrid.io',
  '/api/evm-tron': 'https://tron-evm-rpc.publicnode.com',
};

export function directUrl(url: string): string {
  const prefix = Object.keys(ROUTES).find((p) => url.startsWith(`${p}/`));
  return prefix ? ROUTES[prefix] + url.slice(prefix.length) : url;
}
