/**
 * services/api.js
 * ═══════════════════════════════════════════════════════════════
 * Cliente para o BC Wallet Backend API (node api/server.js).
 *
 * Todas as operações criptográficas (BIP32/39/44, signing) ficam
 * no backend Node.js. Este cliente é a ponte entre a UI React e
 * o core da wallet.
 *
 * Base URL: http://localhost:4000
 * Para produção: configurar via variável de ambiente.
 * ═══════════════════════════════════════════════════════════════
 */

const BASE = typeof process !== "undefined" && process.env?.REACT_APP_API_URL
  ? process.env.REACT_APP_API_URL
  : "http://localhost:4000";

// ─── Core fetch ───────────────────────────────────────────────
async function apiFetch(path, options = {}, sessionId = null) {
  const headers = {
    "Content-Type": "application/json",
    ...options.headers,
  };
  if (sessionId) headers["x-session-id"] = sessionId;

  let res;
  try {
    res = await fetch(BASE + path, { ...options, headers });
  } catch {
    throw new Error("Servidor offline. Inicie com: node api/server.js");
  }

  const data = await res.json();
  return data;
}

// ═══════════════════════════════════════════════════════════════
// WALLET OPERATIONS
// ═══════════════════════════════════════════════════════════════

/**
 * Cria uma nova HD wallet com mnemonic de 24 palavras.
 * O mnemonic é retornado APENAS nesta chamada.
 *
 * @param {string} password       - Senha para criptografar o keystore
 * @param {string} [passphrase]   - BIP39 passphrase (25ª palavra)
 * @param {string} [label]        - Nome da wallet
 * @param {boolean} [fast]        - KDF rápido (apenas testes)
 * @returns {Promise<{ok:boolean, sessionId:string, keystoreId:string, mnemonic:string, walletId:string}>}
 */
export async function createWallet(password, passphrase = "", label = "My Wallet", fast = false) {
  return apiFetch("/wallet/create", {
    method: "POST",
    body:   JSON.stringify({ password, passphrase, label, fast }),
  });
}

/**
 * Restaura wallet a partir de um mnemonic BIP39 existente.
 *
 * @param {string} mnemonic
 * @param {string} password
 * @param {string} [passphrase]
 * @param {string} [label]
 * @returns {Promise<{ok:boolean, sessionId:string, keystoreId:string, walletId:string}>}
 */
export async function restoreWallet(mnemonic, password, passphrase = "", label = "Restored") {
  return apiFetch("/wallet/restore", {
    method: "POST",
    body:   JSON.stringify({ mnemonic, password, passphrase, label, fast: false }),
  });
}

/**
 * Desbloqueia wallet a partir de um keystore salvo.
 * Retorna sessionId para operações subsequentes.
 *
 * @param {object} keystoreData  - Keystore exportado via exportKeystore()
 * @param {string} password
 * @param {string} [passphrase]
 * @returns {Promise<{ok:boolean, sessionId:string, walletId:string}>}
 */
export async function unlockWallet(keystoreData, password, passphrase = "") {
  return apiFetch("/wallet/unlock", {
    method: "POST",
    body:   JSON.stringify({ keystoreData, password, passphrase }),
  });
}

/**
 * Bloqueia a wallet e invalida a sessão.
 * @param {string} sessionId
 * @returns {Promise<{ok:boolean, locked:boolean}>}
 */
export async function lockWallet(sessionId) {
  return apiFetch("/wallet/lock", { method: "POST" }, sessionId);
}

// ═══════════════════════════════════════════════════════════════
// PORTFOLIO & ADDRESSES
// ═══════════════════════════════════════════════════════════════

/**
 * Retorna portfólio completo: endereços de todas as chains.
 * Requer sessão ativa (unlock primeiro).
 *
 * @param {string} sessionId
 * @returns {Promise<{ok:boolean, portfolio:Record<string,{address:string,publicKey:string,path:string}>}>}
 */
export async function getPortfolio(sessionId) {
  return apiFetch("/wallet/portfolio", {}, sessionId);
}

/**
 * Retorna endereço específico por chain + account + index.
 *
 * @param {string} sessionId
 * @param {string} chain     - 'BC', 'BTC', 'ETH', 'SOL', etc.
 * @param {number} [account] - BIP44 account index
 * @param {number} [index]   - Address index
 * @returns {Promise<{ok:boolean, address:string, publicKey:string, path:string}>}
 */
export async function getAddress(sessionId, chain, account = 0, index = 0) {
  return apiFetch(
    `/wallet/address?chain=${chain}&account=${account}&index=${index}`,
    {},
    sessionId
  );
}

/**
 * Retorna lista de endereços consecutivos para uma chain.
 *
 * @param {string} sessionId
 * @param {string} chain
 * @param {number} [count]
 * @param {number} [account]
 * @returns {Promise<{ok:boolean, addresses:object[]}>}
 */
export async function getAddresses(sessionId, chain, count = 5, account = 0) {
  return apiFetch(
    `/wallet/addresses?chain=${chain}&count=${count}&account=${account}`,
    {},
    sessionId
  );
}

// ═══════════════════════════════════════════════════════════════
// SIGNING
// ═══════════════════════════════════════════════════════════════

/**
 * Assina uma transação com a chave privada derivada.
 * A chave privada NUNCA sai do backend.
 *
 * @param {string} sessionId
 * @param {object} tx          - Dados da transação
 * @param {string} chain       - 'BC', 'BTC', 'ETH'
 * @param {number} [account]
 * @param {number} [index]
 * @returns {Promise<{ok:boolean, signature:string, publicKey:string, payload:string, chainId:string}>}
 */
export async function signTransaction(sessionId, tx, chain, account = 0, index = 0) {
  return apiFetch("/wallet/sign", {
    method: "POST",
    body:   JSON.stringify({ tx, chain, account, index }),
  }, sessionId);
}

// ═══════════════════════════════════════════════════════════════
// CHALLENGE AUTH (Web3 login)
// ═══════════════════════════════════════════════════════════════

/**
 * Cria um challenge para autenticação Web3 sem senha.
 * O usuário assina o challenge para provar posse do endereço.
 *
 * @param {string} sessionId
 * @param {string} address    - Endereço que está autenticando
 * @param {string} [context]  - Nome do app/site
 * @returns {Promise<{ok:boolean, nonce:string, challenge:string, expires:number}>}
 */
export async function createChallenge(sessionId, address, context = "web3-login") {
  return apiFetch("/wallet/challenge/create", {
    method: "POST",
    body:   JSON.stringify({ address, context }),
  }, sessionId);
}

/**
 * Assina um challenge para autenticação.
 * @param {string} sessionId
 * @param {string} challenge
 * @param {string} [chain]
 * @returns {Promise<{ok:boolean, signature:string, publicKey:string, chainId:string}>}
 */
export async function signChallenge(sessionId, challenge, chain = "BC") {
  return apiFetch("/wallet/challenge/sign", {
    method: "POST",
    body:   JSON.stringify({ challenge, chain }),
  }, sessionId);
}

/**
 * Verifica um challenge assinado (server-side validation).
 * @param {string} sessionId
 * @param {string} nonce
 * @param {string} signature
 * @param {string} publicKey
 * @param {string} address
 * @returns {Promise<{ok:boolean, valid:boolean}>}
 */
export async function verifyChallenge(sessionId, nonce, signature, publicKey, address) {
  return apiFetch("/wallet/challenge/verify", {
    method: "POST",
    body:   JSON.stringify({ nonce, signature, publicKey, address }),
  }, sessionId);
}

// ═══════════════════════════════════════════════════════════════
// KEYSTORE & XPUB
// ═══════════════════════════════════════════════════════════════

/**
 * Exporta o keystore criptografado (seguro para backup).
 * Nunca contém seed, mnemonic ou private keys em texto puro.
 *
 * @param {string} sessionId
 * @returns {Promise<{ok:boolean, keystore:object}>}
 */
export async function exportKeystore(sessionId) {
  return apiFetch("/wallet/keystore", {}, sessionId);
}

/**
 * Retorna o xpub para watch-only monitoring.
 * Seguro para compartilhar (sem private keys).
 *
 * @param {string} sessionId
 * @param {string} chain
 * @param {number} [account]
 * @returns {Promise<{ok:boolean, xpub:string, chain:string, account:number}>}
 */
export async function getXpub(sessionId, chain, account = 0) {
  return apiFetch(
    `/wallet/xpub?chain=${chain}&account=${account}`,
    {},
    sessionId
  );
}

/**
 * Healthcheck do servidor.
 * @returns {Promise<{status:'online'|'offline', sessions:number}>}
 */
export async function health() {
  try {
    return await apiFetch("/health");
  } catch {
    return { status: "offline", sessions: 0 };
  }
}

export default {
  createWallet, restoreWallet, unlockWallet, lockWallet,
  getPortfolio, getAddress, getAddresses,
  signTransaction, createChallenge, signChallenge, verifyChallenge,
  exportKeystore, getXpub, health,
};

