/**
 * services/solana.js
 * ═══════════════════════════════════════════════════════════════
 * Solana JSON-RPC service — transações, tokens SPL, stake.
 *
 * RPC endpoint: https://api.mainnet-beta.solana.com (público, sem API key)
 * Alternativas: Helius, QuickNode, Alchemy (para maior rate limit)
 *
 * Rate limit público: ~10 req/s — suficiente para wallet single-user.
 * ═══════════════════════════════════════════════════════════════
 */

const RPC_URL = "https://api.mainnet-beta.solana.com";

// ─── Cache ────────────────────────────────────────────────────
const _cache = new Map();
function fromCache(key, ttlMs = 30_000) {
  const e = _cache.get(key);
  return e && Date.now() - e.ts < ttlMs ? e.data : null;
}
function toCache(key, data) {
  _cache.set(key, { data, ts: Date.now() });
  return data;
}

// ─── Core RPC call ────────────────────────────────────────────
async function rpc(method, params = [], ttlMs = 0) {
  const cacheKey = `${method}_${JSON.stringify(params)}`;
  if (ttlMs > 0) {
    const cached = fromCache(cacheKey, ttlMs);
    if (cached !== null) return cached;
  }

  const res = await fetch(RPC_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

  const data = await res.json();
  if (data.error) throw new Error(`Solana RPC ${method}: ${data.error.message}`);

  if (ttlMs > 0) toCache(cacheKey, data.result);
  return data.result;
}

// ═══════════════════════════════════════════════════════════════
// ACCOUNT INFO
// ═══════════════════════════════════════════════════════════════

/**
 * Retorna info completa de uma conta Solana.
 * @param {string} address
 * @returns {Promise<object>}
 */
export async function getAccountInfo(address) {
  return rpc("getAccountInfo", [address, { encoding: "jsonParsed" }], 15_000);
}

/**
 * Verifica se um endereço é válido (existe na rede).
 * @param {string} address
 * @returns {Promise<boolean>}
 */
export async function isValidAddress(address) {
  try {
    // Endereços Solana: base58, 32-44 chars
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return false;
    const info = await getAccountInfo(address);
    return info !== null; // null = address not found but valid format
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// TRANSACTIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Retorna as signatures de transações recentes.
 *
 * @param {string} address
 * @param {number} [limit=20]
 * @returns {Promise<SolTxSignature[]>}
 *
 * @typedef {object} SolTxSignature
 * @property {string}      signature
 * @property {number|null} slot
 * @property {number|null} blockTime     Unix timestamp
 * @property {object|null} err           null = success
 * @property {string}      confirmationStatus
 */
export async function getTransactionSignatures(address, limit = 20) {
  const cacheKey = `sigs_${address}_${limit}`;
  const cached = fromCache(cacheKey, 30_000);
  if (cached) return cached;

  const sigs = await rpc("getSignaturesForAddress", [
    address,
    { limit, commitment: "confirmed" },
  ]);

  return toCache(cacheKey, sigs || []);
}

/**
 * Retorna detalhes de uma transação específica.
 * @param {string} signature
 * @returns {Promise<object>}
 */
export async function getTransaction(signature) {
  return rpc("getTransaction", [
    signature,
    { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
  ], 300_000); // cache tx details for 5 min (immutable)
}

/**
 * Retorna transações formatadas para exibição na UI.
 * Incluindo tipo, valor SOL, e status.
 *
 * @param {string} address
 * @param {number} [limit=10]
 * @returns {Promise<FormattedTx[]>}
 *
 * @typedef {object} FormattedTx
 * @property {string}  signature
 * @property {string}  shortSig     Primeiros+últimos chars
 * @property {string}  status       'confirmed'|'failed'
 * @property {number}  blockTime
 * @property {string}  timeLabel    ex: "2h atrás"
 * @property {string}  chain        'SOL'
 * @property {string}  type         'transfer'|'unknown'
 * @property {number}  fee          Em SOL
 * @property {string}  explorerUrl
 */
export async function getFormattedTransactions(address, limit = 10) {
  const cacheKey = `fmt_txs_${address}`;
  const cached = fromCache(cacheKey, 30_000);
  if (cached) return cached;

  const sigs = await getTransactionSignatures(address, limit);

  const formatted = sigs.map(sig => ({
    signature:   sig.signature,
    shortSig:    sig.signature.slice(0, 8) + "..." + sig.signature.slice(-6),
    status:      sig.err ? "failed" : "confirmed",
    blockTime:   sig.blockTime,
    timeLabel:   sig.blockTime ? formatRelativeTime(sig.blockTime * 1000) : "pendente",
    chain:       "SOL",
    type:        "transfer",
    fee:         0, // full details need extra getTransaction call
    explorerUrl: `https://solscan.io/tx/${sig.signature}`,
  }));

  return toCache(cacheKey, formatted);
}

// ═══════════════════════════════════════════════════════════════
// SPL TOKENS
// ═══════════════════════════════════════════════════════════════

/** Endereço do programa de tokens SPL */
const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_ID    = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/**
 * Retorna todas as contas SPL token de um endereço.
 * Inclui USDC, USDT, BONK, etc.
 *
 * @param {string} address
 * @returns {Promise<SplToken[]>}
 *
 * @typedef {object} SplToken
 * @property {string} mint
 * @property {string} address      Token account address
 * @property {number} uiAmount     Balance
 * @property {number} decimals
 * @property {string} symbol       If known
 */
export async function getSplTokenBalances(address) {
  const cacheKey = `spl_${address}`;
  const cached = fromCache(cacheKey, 60_000);
  if (cached) return cached;

  const [result1, result2] = await Promise.allSettled([
    rpc("getTokenAccountsByOwner", [
      address,
      { programId: TOKEN_PROGRAM_ID },
      { encoding: "jsonParsed" },
    ]),
    rpc("getTokenAccountsByOwner", [
      address,
      { programId: TOKEN_2022_ID },
      { encoding: "jsonParsed" },
    ]),
  ]);

  const all = [
    ...(result1.status === "fulfilled" ? result1.value?.value || [] : []),
    ...(result2.status === "fulfilled" ? result2.value?.value || [] : []),
  ];

  const tokens = all
    .map(acc => {
      const info = acc.account?.data?.parsed?.info;
      if (!info) return null;
      return {
        mint:      info.mint,
        address:   acc.pubkey,
        uiAmount:  info.tokenAmount?.uiAmount    || 0,
        decimals:  info.tokenAmount?.decimals    || 0,
        rawAmount: info.tokenAmount?.amount      || "0",
      };
    })
    .filter(Boolean)
    .filter(t => parseFloat(t.uiAmount) > 0)
    .sort((a, b) => parseFloat(b.uiAmount) - parseFloat(a.uiAmount));

  return toCache(cacheKey, tokens);
}

// ═══════════════════════════════════════════════════════════════
// STAKING
// ═══════════════════════════════════════════════════════════════

/**
 * Retorna stake accounts para um wallet address.
 * @param {string} address
 * @returns {Promise<StakeAccount[]>}
 */
export async function getStakeAccounts(address) {
  const cacheKey = `stake_${address}`;
  const cached = fromCache(cacheKey, 60_000);
  if (cached) return cached;

  const result = await rpc("getStakeActivation", [address]).catch(() => null);
  return toCache(cacheKey, result ? [result] : []);
}

// ═══════════════════════════════════════════════════════════════
// NETWORK STATUS
// ═══════════════════════════════════════════════════════════════

/**
 * Retorna slot atual e informações de health da rede.
 * @returns {Promise<{ slot: number, epoch: object, health: string }>}
 */
export async function getNetworkStatus() {
  const [slot, epochInfo] = await Promise.allSettled([
    rpc("getSlot", [], 5_000),
    rpc("getEpochInfo", [], 30_000),
  ]);

  return {
    slot:      slot.status      === "fulfilled" ? slot.value : null,
    epochInfo: epochInfo.status === "fulfilled" ? epochInfo.value : null,
    health:    "ok",
  };
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Formata timestamp Unix para label relativo em PT-BR.
 * ex: "2h atrás", "3d atrás", "agora"
 *
 * @param {number} timestampMs
 * @returns {string}
 */
function formatRelativeTime(timestampMs) {
  const diff = Date.now() - timestampMs;
  const sec  = Math.floor(diff / 1000);
  const min  = Math.floor(sec  / 60);
  const hr   = Math.floor(min  / 60);
  const day  = Math.floor(hr   / 24);

  if (sec  < 60)  return "agora";
  if (min  < 60)  return `${min}min atrás`;
  if (hr   < 24)  return `${hr}h atrás`;
  if (day  < 30)  return `${day}d atrás`;
  return new Date(timestampMs).toLocaleDateString("pt-BR");
}

/**
 * Formata endereço Solana para exibição curta.
 * @param {string} address
 * @returns {string} ex: "7x2Y...Wx9Z"
 */
export function shortAddress(address) {
  if (!address) return "—";
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Converte lamports para SOL.
 * @param {number|string} lamports
 * @returns {number}
 */
export function lamportsToSol(lamports) {
  return Number(lamports) / 1_000_000_000;
}

/**
 * URL do explorer para um endereço ou tx.
 * @param {string} value
 * @param {'address'|'tx'} type
 * @returns {string}
 */
export function explorerUrl(value, type = "address") {
  return `https://solscan.io/${type}/${value}`;
}

// ─── Cache management ─────────────────────────────────────────
export function clearSolanaCache() {
  _cache.clear();
}

