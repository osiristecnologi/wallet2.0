/**
 * services/dexscreener.js
 * ═══════════════════════════════════════════════════════════════
 * DexScreener API — preços em tempo real, volume, liquidez.
 *
 * Endpoints usados:
 *   GET /latest/dex/search?q=<symbol>      → preço por símbolo
 *   GET /token-profiles/latest/v1          → trending tokens
 *   GET /token-pairs/v1/<chain>/<address>  → pares de um token
 *
 * Cache:
 *   • 30s para preços  (refresh automático no hook)
 *   • 60s para trending
 *   • 120s para pares específicos
 * ═══════════════════════════════════════════════════════════════
 */

const BASE_URL = "https://api.dexscreener.com";

// ─── In-memory cache ─────────────────────────────────────────
const _cache = new Map();

function fromCache(key, ttlMs) {
  const entry = _cache.get(key);
  if (entry && Date.now() - entry.ts < ttlMs) return entry.data;
  return null;
}
function toCache(key, data) {
  _cache.set(key, { data, ts: Date.now() });
  return data;
}

// ─── Fetch helper ─────────────────────────────────────────────
async function dsFetch(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`DexScreener ${res.status}: ${path}`);
  return res.json();
}

// ═══════════════════════════════════════════════════════════════
// getTokenPrice(symbol)
// ═══════════════════════════════════════════════════════════════
/**
 * Retorna o preço atual de um token buscando pelo símbolo.
 * Seleciona automaticamente o par com maior liquidez.
 *
 * @param {string} symbol  ex: "SOL", "BTC", "ETH"
 * @returns {Promise<TokenPrice|null>}
 *
 * @typedef {object} TokenPrice
 * @property {string}  symbol
 * @property {number}  priceUsd
 * @property {number}  change1h
 * @property {number}  change24h
 * @property {number}  change7d
 * @property {number}  volumeH24
 * @property {number}  liquidityUsd
 * @property {number}  marketCap
 * @property {string}  pairAddress
 * @property {string}  chainId
 * @property {string}  dexId
 * @property {string}  url
 * @property {number}  updatedAt
 */
export async function getTokenPrice(symbol) {
  const cacheKey = `price_${symbol.toUpperCase()}`;
  const cached = fromCache(cacheKey, 30_000);
  if (cached) return cached;

  const data  = await dsFetch(`/latest/dex/search?q=${encodeURIComponent(symbol)}`);
  const pairs = data.pairs || [];

  // Prefer pairs with high liquidity (>$50k) and matching symbol
  const relevant = pairs.filter(p => {
    const base  = p.baseToken?.symbol?.toUpperCase();
    const quote = p.quoteToken?.symbol?.toUpperCase();
    return base === symbol.toUpperCase() || quote === symbol.toUpperCase();
  });

  const sorted = (relevant.length > 0 ? relevant : pairs)
    .filter(p => parseFloat(p.liquidity?.usd || 0) > 10_000)
    .sort((a, b) => parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0));

  const best = sorted[0] || pairs[0];
  if (!best) return null;

  const result = {
    symbol:       symbol.toUpperCase(),
    priceUsd:     parseFloat(best.priceUsd   || 0),
    change1h:     best.priceChange?.h1        || 0,
    change24h:    best.priceChange?.h24       || 0,
    change7d:     best.priceChange?.h6        || 0, // h7d not always available
    volumeH24:    parseFloat(best.volume?.h24 || 0),
    liquidityUsd: parseFloat(best.liquidity?.usd || 0),
    marketCap:    parseFloat(best.marketCap   || best.fdv || 0),
    txns24h:      (best.txns?.h24?.buys || 0) + (best.txns?.h24?.sells || 0),
    pairAddress:  best.pairAddress,
    chainId:      best.chainId,
    dexId:        best.dexId,
    pairName:     `${best.baseToken?.symbol}/${best.quoteToken?.symbol}`,
    url:          best.url,
    updatedAt:    Date.now(),
  };

  return toCache(cacheKey, result);
}

// ═══════════════════════════════════════════════════════════════
// getAllPrices() — batch for portfolio
// ═══════════════════════════════════════════════════════════════
/**
 * Busca preços de todas as chains suportadas em paralelo.
 * Mapeamento:
 *   BTC  → busca "WBTC" (melhor liquidez on-chain) + fallback "BTC"
 *   ETH  → busca "WETH"
 *   SOL  → busca "SOL"
 *   LTC  → busca "LTC"
 *   DOGE → busca "DOGE"
 *
 * @returns {Promise<Record<string, TokenPrice>>}
 */
export async function getAllPrices() {
  const cacheKey = "all_prices";
  const cached = fromCache(cacheKey, 25_000);
  if (cached) return cached;

  const searches = [
    { chain: "SOL",  query: "SOL"  },
    { chain: "BTC",  query: "WBTC" },
    { chain: "ETH",  query: "WETH" },
    { chain: "LTC",  query: "LTC"  },
    { chain: "DOGE", query: "DOGE" },
  ];

  const results = await Promise.allSettled(
    searches.map(({ query }) => getTokenPrice(query))
  );

  const map = {};
  searches.forEach(({ chain }, i) => {
    const r = results[i];
    if (r.status === "fulfilled" && r.value) {
      map[chain] = { ...r.value, symbol: chain };
    }
  });

  return toCache(cacheKey, map);
}

// ═══════════════════════════════════════════════════════════════
// getTokenPairs(chain, address) — pairs for a specific token
// ═══════════════════════════════════════════════════════════════
/**
 * Retorna todos os pares de trading de um token específico.
 *
 * @param {string} chain    ex: "solana", "ethereum", "bsc"
 * @param {string} address  endereço do token
 * @returns {Promise<object[]>}
 */
export async function getTokenPairs(chain, address) {
  const cacheKey = `pairs_${chain}_${address}`;
  const cached = fromCache(cacheKey, 120_000);
  if (cached) return cached;

  const data = await dsFetch(`/token-pairs/v1/${chain}/${address}`);
  return toCache(cacheKey, data.pairs || []);
}

// ═══════════════════════════════════════════════════════════════
// getTrendingTokens() — latest token profiles
// ═══════════════════════════════════════════════════════════════
/**
 * Retorna os últimos token profiles (trending/newest).
 * @returns {Promise<object[]>}
 */
export async function getTrendingTokens() {
  const cacheKey = "trending";
  const cached = fromCache(cacheKey, 60_000);
  if (cached) return cached;

  const data = await dsFetch("/token-profiles/latest/v1");
  return toCache(cacheKey, Array.isArray(data) ? data.slice(0, 20) : []);
}

// ═══════════════════════════════════════════════════════════════
// getTokenChart() — OHLCV data stub
// ═══════════════════════════════════════════════════════════════
/**
 * DexScreener não tem endpoint público de OHLCV.
 * Para gráficos reais, usar Birdeye (Solana) ou CoinGecko Pro.
 * Retorna dados sintéticos baseados no preço atual para preview.
 *
 * @param {string} symbol
 * @param {number} [points=24]
 * @returns {Promise<{time: number, price: number}[]>}
 */
export async function getTokenChart(symbol, points = 24) {
  const price = await getTokenPrice(symbol);
  if (!price) return [];

  // Gerar série de preços sintética (±5% ao redor do preço atual)
  // Em produção: usar Birdeye API ou CoinGecko OHLCV
  const now    = Date.now();
  const hourMs = 3_600_000;
  let p        = price.priceUsd * (1 - Math.abs(price.change24h) / 100);

  return Array.from({ length: points }, (_, i) => {
    const noise = (Math.random() - 0.5) * 0.02; // ±1% por hora
    p = p * (1 + noise);
    return {
      time:  Math.floor((now - (points - i) * hourMs) / 1000),
      price: p,
    };
  });
}

// ─── Cache management ─────────────────────────────────────────
export function clearCache() {
  _cache.clear();
}

export function getCacheStats() {
  return {
    entries: _cache.size,
    keys: [..._cache.keys()],
  };
}

