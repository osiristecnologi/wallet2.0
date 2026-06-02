# BC Wallet

Carteira HD multi-chain com dados em tempo real.

## Stack

- React (web preview) / React Native + Expo (mobile)
- Node.js backend (BIP32/39/44, Taproot, signing)
- DexScreener API — preços em tempo real
- Solana RPC — saldos e transações SOL
- Blockstream — saldos BTC
- Cloudflare ETH RPC — saldos ETH
- BlockCypher — LTC/DOGE

## Rodar

```bash
# 1. Backend BC Wallet API
cd mini-blockchain
node api/server.js
# Roda em http://localhost:4000

# 2. App web (preview mobile)
# Abrir BCWalletApp.jsx no Claude Artifacts
# Ou com Expo:
cd bc-wallet-app
npm install
npm run dev
```

## Arquitetura

```
bc-wallet-app/
├── BCWalletApp.jsx          ← App completo (artifact preview)
├── src/
│   ├── services/
│   │   ├── api.js           ← BC backend client
│   │   ├── balances.js      ← Saldos reais (SOL/BTC/ETH/LTC/DOGE)
│   │   ├── dexscreener.js   ← Preços tempo real
│   │   └── solana.js        ← Solana RPC (txs, SPL tokens)
│   └── hooks/
│       └── index.js         ← usePortfolio, useBalances, usePrices, useSolTransactions

mini-blockchain/
├── wallet/                  ← HD Wallet core (BIP32/39/44)
│   ├── HDWallet.js          ← async create/unlock + BIP39 passphrase
│   ├── keystore.js          ← AES-256-GCM + scrypt async + AAD
│   ├── bip32.js             ← HD derivation + watch-only real
│   ├── bip39/               ← Mnemonic 24 palavras
│   ├── chains/bitcoin/      ← secp256k1, Schnorr, Taproot, UTXO
│   └── security/            ← BruteForceGuard, SecureLogger
└── api/server.js            ← REST bridge (sessões, signing)
```

## Chains suportadas

| Chain | Tipo      | Fonte de saldo         | Fonte de preço |
|-------|-----------|------------------------|----------------|
| SOL   | Solana    | Solana RPC             | DexScreener    |
| BTC   | Bitcoin   | Blockstream Esplora    | DexScreener    |
| ETH   | Ethereum  | Cloudflare ETH RPC     | DexScreener    |
| BC    | Mine BC   | BC Node local          | —              |
| LTC   | Litecoin  | BlockCypher            | DexScreener    |
| DOGE  | Dogecoin  | BlockCypher            | DexScreener    |

## Segurança

- BIP39 passphrase correta (muda seed completamente)
- Mutex anti-race em sign/lock/unlock
- `privKeyBuffer` (Buffer 32B) em vez de hex string
- secureWipe 3 passadas em materiais sensíveis
- Keystore v4: scrypt async + AAD + checksum
- Fingerprint detecta passphrase errada explicitamente
- Watch-only BIP32 correto: `childPub = point(IL) + parentPub`
