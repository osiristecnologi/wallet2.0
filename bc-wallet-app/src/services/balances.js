/**
 * services/balances.js
 * ═══════════════════════════════════════════════════════════════
 * Saldos reais de blockchain — zero mocks.
 *
 * Fontes:
 *   SOL  → Solana JSON-RPC  (api.mainnet-beta.solana.com)
 *   BTC  → Blockstream Esplora  (blockstream.info/api)
 *   ETH  → Cloudflare Ethereum RPC  (cloudflare-eth.com)
 *   LTC  → BlockCypher  (api.blockcypher.com/v1/ltc/main)
 *   DOGE → BlockCypher  (api.blockcypher.com/v1/doge/main)
 *   BC   → BC Node local  (localhost:4000)
 *
 * Cache: 20s para dados on-chain (suficiente para UX responsiva).
 * ═══════════════════════════════════════════════════════════════
 */

// ─── Cache ────────────────────────────────────────────────────
const _cache = new Map();
const CACHE_TTL = 20_000; // 20 seconds

function fromCache(key) {
  const e = _cache.get(key);
  if (e && Date.now() - e.ts < CACHE_TTL) return e.data;
  return null;
}
function toCache(key, data) {
  _cache.set(key, { data, ts: Date.now() });
  return data;
}

// ─── Generic timeout fetch ────────────────────────────────────
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// ═══════════════════════════════════════════════════════════════
// SOL — Solana JSON-RPC
// ═══════════════════════════════════════════════════════════════

/**
 * Retorna saldo SOL em lamports → convertido para SOL.
 * 1 SOL = 1_000_000_000 lamports
 *
 * @param {string} address  Base58 Solana address
 * @returns {Promise<number>}  SOL balance (float)
 */
export async function getSolBalance(address) {
  if (!address || address === "—") return 0;

  const cacheKey = `sol_${address}`;
  const cached = fromCache(cacheKey);
  if (cached !== null) return cached;

  const res = await fetchWithTimeout("https://api.mainnet-beta.solana.com", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id:      1,
      method:  "getBalance",
      params:  [address, { commitment: "confirmed" }],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Solana RPC: ${data.error.message}`);

  const lamports = data.result?.value ?? 0;
  return toCache(cacheKey, lamports / 1_000_000_000);
}

/**
 * Retorna tokens SPL de uma conta Solana.
 * Útil para exibir USDC, USDT, etc.
 *
 * @param {string} address
 * @returns {Promise<SplToken[]>}
 *
 * @typedef {object} SplToken
 * @property {string} mint        Token mint address
 * @property {number} uiAmount    Balance (human readable)
 * @property {number} decimals
 */
export async function getSplTokens(address) {
  if (!address) return [];

  const cacheKey = `spl_${address}`;
  const cached = fromCache(cacheKey);
  if (cached !== null) return cached;

  const res = await fetchWithTimeout("https://api.mainnet-beta.solana.com", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id:      1,
      method:  "getTokenAccountsByOwner",
      params: [
        address,
        { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
        { encoding: "jsonParsed" },
      ],
    }),
  });

  const data  = await res.json();
  const items = data.result?.value || [];

  const tokens = items
    .map(acc => {
      const info = acc.account?.data?.parsed?.info;
      return info ? {
        mint:     info.mint,
        uiAmount: info.tokenAmount?.uiAmount    || 0,
        decimals: info.tokenAmount?.decimals    || 0,
        address:  acc.pubkey,
      } : null;
    })
    .filter(Boolean)
    .filter(t => t.uiAmount > 0);

  return toCache(cacheKey, tokens);
}

// ═══════════════════════════════════════════════════════════════
// BTC — Blockstream Esplora
// ═══════════════════════════════════════════════════════════════

/**
 * Retorna saldo BTC para qualquer tipo de endereço
 * (P2PKH 1..., P2SH 3..., Bech32 bc1q..., Taproot bc1p...).
 *
 * @param {string} address  Bitcoin address
 * @returns {Promise<number>}  BTC balance (float, 8 decimals)
 */
export async function getBtcBalance(address) {
  if (!address || address === "—") return 0;

  const cacheKey = `btc_${address}`;
  const cached = fromCache(cacheKey);
  if (cached !== null) return cached;

  const res  = await fetchWithTimeout(
    `https://blockstream.info/api/address/${encodeURIComponent(address)}`
  );
  const data = await res.json();

  // funded_txo_sum - spent_txo_sum = current balance (in satoshis)
  const funded = data.chain_stats?.funded_txo_sum || 0;
  const spent  = data.chain_stats?.spent_txo_sum  || 0;

  return toCache(cacheKey, (funded - spent) / 1e8);
}

/**
 * Retorna UTXOs não gastos de um endereço Bitcoin.
 * Necessário para construir transações reais.
 *
 * @param {string} address
 * @returns {Promise<Utxo[]>}
 *
 * @typedef {object} Utxo
 * @property {string}  txid
 * @property {number}  vout
 * @property {number}  value         Satoshis
 * @property {boolean} status.confirmed
 */
export async function getBtcUTXOs(address) {
  if (!address) return [];

  const cacheKey = `btc_utxos_${address}`;
  const cached = fromCache(cacheKey);
  if (cached !== null) return cached;

  const res  = await fetchWithTimeout(
    `https://blockstream.info/api/address/${encodeURIComponent(address)}/utxo`
  );
  const data = await res.json();

  return toCache(cacheKey, Array.isArray(data) ? data : []);
}

// ═══════════════════════════════════════════════════════════════
// ETH — Cloudflare Ethereum RPC (free, no API key)
// ═══════════════════════════════════════════════════════════════

/**
 * Retorna saldo ETH via eth_getBalance.
 *
 * @param {string} address  EIP-55 checksum or lowercase 0x address
 * @returns {Promise<number>}  ETH balance (float, 18 decimals)
 */
export async function getEthBalance(address) {
  if (!address || address === "—") return 0;

  const cacheKey = `eth_${address}`;
  const cached = fromCache(cacheKey);
  if (cached !== null) return cached;

  const res = await fetchWithTimeout("https://cloudflare-eth.com", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id:      1,
      method:  "eth_getBalance",
      params:  [address, "latest"],
    }),
  });

  const data = await res.json();
  if (data.error) throw new Error(`ETH RPC: ${data.error.message}`);

  const hex = data.result || "0x0";
  return toCache(cacheKey, parseInt(hex, 16) / 1e18);
}

// ═══════════════════════════════════════════════════════════════
// LTC / DOGE — BlockCypher (free tier, 3 req/s)
// ═══════════════════════════════════════════════════════════════

/**
 * Retorna saldo de um endereço Litecoin ou Dogecoin.
 * BlockCypher free tier: 3 req/s, 200 req/h.
 *
 * @param {string}         address
 * @param {'LTC'|'DOGE'}   coin
 * @returns {Promise<number>}
 */
export async function getUtxoCoinBalance(address, coin) {
  if (!address || address === "—") return 0;

  const cacheKey = `${coin}_${address}`;
  const cached = fromCache(cacheKey);
  if (cached !== null) return cached;

  const slug = coin === "LTC" ? "ltc/main" : "doge/main";
  const res  = await fetchWithTimeout(
    `https://api.blockcypher.com/v1/${slug}/addrs/${encodeURIComponent(address)}/balance`
  );
  const data = await res.json();

  if (data.error) throw new Error(`BlockCypher ${coin}: ${data.error}`);

  // balance = confirmed balance in satoshis/litoshis/koinus
  return toCache(cacheKey, (data.balance || 0) / 1e8);
}

// ═══════════════════════════════════════════════════════════════
// BC — Mine Blockchain (local node)
// ═══════════════════════════════════════════════════════════════

/**
 * Retorna saldo BC do nó local.
 * Endpoint: GET http://localhost:3000/balance/:address
 *
 * @param {string} address  Base58Check BC address
 * @returns {Promise<number>}  BC balance
 */
export async function getBCBalance(address) {
  if (!address || address === "—") return 0;

  const cacheKey = `bc_${address}`;
  const cached = fromCache(cacheKey);
  if (cached !== null) return cached;

  try {
    const res  = await fetchWithTimeout(
      `http://localhost:3000/balance/${encodeURIComponent(address)}`,
      {}, 3000 // shorter timeout for local node
    );
    const data = await res.json();
    return toCache(cacheKey, data.data?.balance ?? 0);
  } catch {
    // BC node offline — return 0 gracefully
    return 0;
  }
}

// ═══════════════════════════════════════════════════════════════
// getAllBalances(portfolio) — parallel fetch all chains
// ═══════════════════════════════════════════════════════════════

/**
 * Busca todos os saldos em paralelo.
 * Falhas individuais retornam null (não propagam erro).
 *
 * @param {object} portfolio  { SOL: { address }, BTC: { address }, ... }
 * @returns {Promise<Balances>}
 *
 * @typedef {object} Balances
 * @property {number|null} SOL
 * @property {number|null} BTC
 * @property {number|null} ETH
 * @property {number|null} BC
 * @property {number|null} LTC
 * @property {number|null} DOGE
 */
export async function getAllBalances(portfolio) {
  if (!portfolio) return {};

  const [sol, btc, eth, bc, ltc, doge] = await Promise.allSettled([
    getSolBalance       (portfolio.SOL?.address),
    getBtcBalance       (portfolio.BTC?.address || portfolio.BTC_TAPROOT?.address),
    getEthBalance       (portfolio.ETH?.address),
    getBCBalance        (portfolio.BC?.address),
    getUtxoCoinBalance  (portfolio.LTC?.address,  "LTC"),
    getUtxoCoinBalance  (portfolio.DOGE?.address, "DOGE"),
  ]);

  const pick = (r) => r.status === "fulfilled" ? r.value : null;

  return {
    SOL:  pick(sol),
    BTC:  pick(btc),
    ETH:  pick(eth),
    BC:   pick(bc),
    LTC:  pick(ltc),
    DOGE: pick(doge),
  };
}

// ─── Cache control ────────────────────────────────────────────
export function invalidateAddress(address) {
  for (const key of _cache.keys()) {
    if (key.includes(address)) _cache.delete(key);
  }
}

export function clearAllBalanceCache() {
  _cache.clear();
}

