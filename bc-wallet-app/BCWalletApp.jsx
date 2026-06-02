import { useState, useEffect, useCallback, useRef, useMemo } from "react";

// ═══════════════════════════════════════════════════════════════
// DESIGN TOKENS
// ═══════════════════════════════════════════════════════════════
const C = {
  bg:      "#0a0a0f", surface:"#12121a", card:"#1a1a27",
  border:  "rgba(255,255,255,0.07)", glass:"rgba(18,18,26,0.92)",
  accent:  "#7c3aed", accent2:"#a855f7", accentGlow:"rgba(124,58,237,0.3)",
  green:   "#22c55e", red:"#ef4444", yellow:"#f59e0b", blue:"#3b82f6",
  text:    "#f1f1f5", muted:"#6b7280", dim:"#374151",
};

// ─── Chain registry ──────────────────────────────────────────
const CHAINS = {
  SOL:  { symbol:"SOL",  name:"Solana",         color:"#9945ff", icon:"◎", decimals:9,  cgId:"solana"   },
  BTC:  { symbol:"BTC",  name:"Bitcoin",         color:"#f59e0b", icon:"₿", decimals:8,  cgId:"bitcoin"  },
  ETH:  { symbol:"ETH",  name:"Ethereum",        color:"#6366f1", icon:"Ξ", decimals:18, cgId:"ethereum" },
  BC:   { symbol:"BC",   name:"Mine Blockchain", color:"#7c3aed", icon:"⛓",decimals:8,  cgId:null       },
  LTC:  { symbol:"LTC",  name:"Litecoin",        color:"#94a3b8", icon:"Ł", decimals:8,  cgId:"litecoin" },
  DOGE: { symbol:"DOGE", name:"Dogecoin",        color:"#f59e0b", icon:"Ð", decimals:8,  cgId:"dogecoin" },
};

// ─── Backend API base ────────────────────────────────────────
const BC_API = "http://localhost:4000";

// ═══════════════════════════════════════════════════════════════
// SERVICE LAYER — all real data, browser-side fetch
// ═══════════════════════════════════════════════════════════════

// ── Cache util ────────────────────────────────────────────────
const _cache = {};
function cached(key, ttlMs, fn) {
  const entry = _cache[key];
  if (entry && Date.now() - entry.ts < ttlMs) return Promise.resolve(entry.data);
  return fn().then(data => { _cache[key] = { data, ts: Date.now() }; return data; });
}

// ══════════════════════════════
// services/dexscreener.js
// ══════════════════════════════
const DexScreener = {
  BASE: "https://api.dexscreener.com",

  async _get(path) {
    const r = await fetch(this.BASE + path, {
      headers: { "Accept": "application/json" },
    });
    if (!r.ok) throw new Error(`DexScreener ${r.status}: ${path}`);
    return r.json();
  },

  /** Get best price for a token symbol across all DEXes */
  async getTokenPrice(symbol) {
    return cached(`dex_price_${symbol}`, 30_000, async () => {
      const d = await this._get(`/latest/dex/search?q=${symbol}`);
      const pairs = d.pairs || [];

      // Prefer high-liquidity pairs
      const sorted = pairs
        .filter(p => parseFloat(p.liquidity?.usd || 0) > 50_000)
        .sort((a, b) => parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0));

      const best = sorted[0] || pairs[0];
      if (!best) return null;

      return {
        symbol:      symbol.toUpperCase(),
        priceUsd:    parseFloat(best.priceUsd || 0),
        change1h:    best.priceChange?.h1  || 0,
        change24h:   best.priceChange?.h24 || 0,
        change7d:    best.priceChange?.h6  || 0,
        volumeH24:   parseFloat(best.volume?.h24 || 0),
        liquidityUsd:parseFloat(best.liquidity?.usd || 0),
        marketCap:   parseFloat(best.marketCap || best.fdv || 0),
        pairAddress: best.pairAddress,
        chainId:     best.chainId,
        dexId:       best.dexId,
        url:         best.url,
      };
    });
  },

  /** Batch prices for all chains */
  async getAllPrices() {
    return cached("dex_all_prices", 30_000, async () => {
      const symbols = ["SOL","WBTC","WETH","LTC","DOGE"];
      const results = await Promise.allSettled(symbols.map(s => this.getTokenPrice(s)));
      const map = {};
      // SOL
      if (results[0].status==="fulfilled" && results[0].value) map.SOL = results[0].value;
      // BTC via WBTC
      if (results[1].status==="fulfilled" && results[1].value) map.BTC = { ...results[1].value, symbol:"BTC" };
      // ETH via WETH
      if (results[2].status==="fulfilled" && results[2].value) map.ETH = { ...results[2].value, symbol:"ETH" };
      if (results[3].status==="fulfilled" && results[3].value) map.LTC  = results[3].value;
      if (results[4].status==="fulfilled" && results[4].value) map.DOGE = results[4].value;
      return map;
    });
  },

  /** Trending tokens on a chain */
  async getTrendingTokens(chainId = "solana") {
    return cached(`dex_trending_${chainId}`, 60_000, async () => {
      const d = await this._get(`/token-profiles/latest/v1`);
      return (d || []).slice(0, 10);
    });
  },
};

// ══════════════════════════════
// services/balances.js
// ══════════════════════════════
const BalanceService = {

  /** SOL balance via Solana JSON-RPC */
  async getSolBalance(address) {
    if (!address || address === "—") return 0;
    return cached(`sol_bal_${address}`, 20_000, async () => {
      const r = await fetch("https://api.mainnet-beta.solana.com", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          jsonrpc:"2.0", id:1, method:"getBalance",
          params:[address, { commitment:"confirmed" }],
        }),
      });
      const d = await r.json();
      return (d.result?.value || 0) / 1e9; // lamports → SOL
    });
  },

  /** BTC balance via Blockstream Esplora */
  async getBtcBalance(address) {
    if (!address || address === "—") return 0;
    return cached(`btc_bal_${address}`, 30_000, async () => {
      const r = await fetch(`https://blockstream.info/api/address/${address}`);
      const d = await r.json();
      const funded = d.chain_stats?.funded_txo_sum  || 0;
      const spent  = d.chain_stats?.spent_txo_sum   || 0;
      return (funded - spent) / 1e8;
    });
  },

  /** ETH balance via public Ethereum RPC */
  async getEthBalance(address) {
    if (!address || address === "—") return 0;
    return cached(`eth_bal_${address}`, 20_000, async () => {
      const r = await fetch("https://cloudflare-eth.com", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          jsonrpc:"2.0", id:1, method:"eth_getBalance",
          params:[address, "latest"],
        }),
      });
      const d = await r.json();
      const hex = d.result || "0x0";
      return parseInt(hex, 16) / 1e18;
    });
  },

  /** BTC-explorer for LTC/DOGE via blockcypher */
  async getUtxoBalance(address, coin) {
    if (!address || address === "—") return 0;
    const slug = coin === "LTC" ? "ltc/main" : "doge/main";
    return cached(`${coin}_bal_${address}`, 60_000, async () => {
      const r = await fetch(`https://api.blockcypher.com/v1/${slug}/addrs/${address}/balance`);
      const d = await r.json();
      return (d.balance || 0) / 1e8;
    });
  },

  /** Fetch all balances in parallel */
  async getAllBalances(portfolio) {
    if (!portfolio) return {};
    const [sol, btc, eth, ltc, doge] = await Promise.allSettled([
      this.getSolBalance (portfolio.SOL?.address),
      this.getBtcBalance (portfolio.BTC?.address),
      this.getEthBalance (portfolio.ETH?.address),
      this.getUtxoBalance(portfolio.LTC?.address,  "LTC"),
      this.getUtxoBalance(portfolio.DOGE?.address, "DOGE"),
    ]);
    return {
      SOL:  sol.status  === "fulfilled" ? sol.value  : null,
      BTC:  btc.status  === "fulfilled" ? btc.value  : null,
      ETH:  eth.status  === "fulfilled" ? eth.value  : null,
      BC:   0, // served by BC node
      LTC:  ltc.status  === "fulfilled" ? ltc.value  : null,
      DOGE: doge.status === "fulfilled" ? doge.value : null,
    };
  },
};

// ══════════════════════════════
// services/solana.js
// ══════════════════════════════
const SolanaService = {
  RPC: "https://api.mainnet-beta.solana.com",

  async rpc(method, params = []) {
    const r = await fetch(this.RPC, {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ jsonrpc:"2.0", id:1, method, params }),
    });
    const d = await r.json();
    if (d.error) throw new Error(`Solana RPC: ${d.error.message}`);
    return d.result;
  },

  /** Get recent transactions for an address */
  async getTransactions(address, limit = 10) {
    return cached(`sol_txs_${address}`, 30_000, async () => {
      const sigs = await this.rpc("getSignaturesForAddress", [
        address, { limit }
      ]);
      return (sigs || []).map(s => ({
        hash:      s.signature,
        time:      s.blockTime ? new Date(s.blockTime * 1000).toLocaleDateString() : "pending",
        status:    s.err ? "failed" : "confirmed",
        chain:     "SOL",
        // Full tx details would need another call per sig
      }));
    });
  },

  /** Get token accounts (SPL tokens) */
  async getTokenAccounts(address) {
    return cached(`sol_tokens_${address}`, 60_000, async () => {
      const r = await this.rpc("getTokenAccountsByOwner", [
        address,
        { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
        { encoding: "jsonParsed" },
      ]);
      return r?.value || [];
    });
  },
};

// ══════════════════════════════
// services/api.js (BC backend)
// ══════════════════════════════
const WalletAPI = {
  async fetch(path, opts = {}, sessionId = null) {
    const headers = { "Content-Type":"application/json" };
    if (sessionId) headers["x-session-id"] = sessionId;
    const r = await fetch(BC_API + path, { ...opts, headers });
    return r.json();
  },

  async createWallet(password, passphrase = "", label = "My Wallet") {
    return this.fetch("/wallet/create", {
      method:"POST",
      body: JSON.stringify({ password, passphrase, label, fast:true }),
    });
  },

  async restoreWallet(mnemonic, password, passphrase = "") {
    return this.fetch("/wallet/restore", {
      method:"POST",
      body: JSON.stringify({ mnemonic, password, passphrase, label:"Restored", fast:true }),
    });
  },

  async unlockWallet(keystoreData, password, passphrase = "") {
    return this.fetch("/wallet/unlock", {
      method:"POST",
      body: JSON.stringify({ keystoreData, password, passphrase }),
    });
  },

  async getPortfolio(sessionId) {
    return this.fetch("/wallet/portfolio", {}, sessionId);
  },

  async getAddresses(sessionId, chain, count = 5) {
    return this.fetch(`/wallet/addresses?chain=${chain}&count=${count}`, {}, sessionId);
  },
};

// ═══════════════════════════════════════════════════════════════
// HOOKS
// ═══════════════════════════════════════════════════════════════

function usePrices(autoRefreshMs = 30_000) {
  const [prices, setPrices]   = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const load = useCallback(async () => {
    try {
      const p = await DexScreener.getAllPrices();
      setPrices(p);
      setError(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, autoRefreshMs);
    return () => clearInterval(t);
  }, [load, autoRefreshMs]);

  return { prices, loading, error, refresh: load };
}

function useBalances(portfolio, autoRefreshMs = 20_000) {
  const [balances, setBalances] = useState({});
  const [loading, setLoading]   = useState(false);
  const prevPortfolio = useRef(null);

  const load = useCallback(async () => {
    if (!portfolio) return;
    setLoading(true);
    try {
      const b = await BalanceService.getAllBalances(portfolio);
      setBalances(b);
    } catch {}
    setLoading(false);
  }, [portfolio]);

  useEffect(() => {
    if (!portfolio || portfolio === prevPortfolio.current) return;
    prevPortfolio.current = portfolio;
    load();
    const t = setInterval(load, autoRefreshMs);
    return () => clearInterval(t);
  }, [portfolio, load, autoRefreshMs]);

  return { balances, loading, refresh: load };
}

function useSolTransactions(address) {
  const [txs, setTxs]         = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!address) return;
    setLoading(true);
    SolanaService.getTransactions(address, 10)
      .then(setTxs).catch(()=>{}).finally(()=>setLoading(false));
  }, [address]);

  return { txs, loading };
}

function useTotalUSD(balances, prices) {
  return useMemo(() => {
    let total = 0;
    for (const [chain, bal] of Object.entries(balances)) {
      if (bal === null || bal === undefined) continue;
      const p = prices[chain]?.priceUsd || 0;
      total += bal * p;
    }
    return total;
  }, [balances, prices]);
}

// ═══════════════════════════════════════════════════════════════
// SMALL COMPONENTS
// ═══════════════════════════════════════════════════════════════

function GlowOrb({ x, y, color, size=300 }) {
  return <div style={{ position:"absolute",left:x,top:y,width:size,height:size,borderRadius:"50%",background:color,filter:"blur(80px)",opacity:0.12,pointerEvents:"none",zIndex:0 }}/>;
}

function GlassCard({ children, style={}, onClick }) {
  const [press, setPress] = useState(false);
  return (
    <div onClick={onClick} onMouseDown={()=>onClick&&setPress(true)} onMouseUp={()=>setPress(false)} onMouseLeave={()=>setPress(false)}
      style={{ background:C.glass, backdropFilter:"blur(20px)", border:`1px solid ${C.border}`, borderRadius:16, transition:"all 0.15s", transform:press?"scale(0.98)":"scale(1)", cursor:onClick?"pointer":"default", ...style }}>
      {children}
    </div>
  );
}

function Badge({ text }) {
  if (!text && text !== 0) return null;
  const str = typeof text === "number" ? (text >= 0 ? `+${text.toFixed(2)}%` : `${text.toFixed(2)}%`) : String(text);
  const pos = str.startsWith("+");
  const neg = str.startsWith("-");
  return (
    <span style={{ background:pos?"rgba(34,197,94,0.12)":neg?"rgba(239,68,68,0.12)":"rgba(107,114,128,0.12)", color:pos?C.green:neg?C.red:C.muted, padding:"2px 8px", borderRadius:20, fontSize:11, fontWeight:600, fontFamily:"monospace" }}>
      {str}
    </span>
  );
}

function Skeleton({ w, h=14, radius=6 }) {
  return <div style={{ width:w||"100%", height:h, borderRadius:radius, background:"rgba(255,255,255,0.06)", animation:"pulse 1.5s ease-in-out infinite" }}/>;
}

function Spinner({ size=20 }) {
  return <div style={{ width:size, height:size, borderRadius:"50%", border:`2px solid ${C.dim}`, borderTopColor:C.accent2, animation:"spin 0.7s linear infinite" }}/>;
}

function Input({ placeholder, value, onChange, type="text", label }) {
  const [focus, setFocus] = useState(false);
  return (
    <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
      {label && <label style={{ fontSize:12, color:C.muted, fontWeight:600 }}>{label}</label>}
      <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
        onFocus={()=>setFocus(true)} onBlur={()=>setFocus(false)}
        style={{ background:"rgba(255,255,255,0.05)", border:`1px solid ${focus?C.accent:C.border}`, borderRadius:10, padding:"12px 14px", color:C.text, fontSize:14, outline:"none", fontFamily:"monospace", transition:"border 0.15s", width:"100%", boxSizing:"border-box" }}
      />
    </div>
  );
}

function PrimaryBtn({ children, onClick, loading, disabled, style={} }) {
  const [h, setH] = useState(false);
  return (
    <button onClick={onClick} disabled={disabled||loading} onMouseEnter={()=>setH(true)} onMouseLeave={()=>setH(false)}
      style={{ background:disabled?"rgba(124,58,237,0.2)":h?`linear-gradient(135deg,${C.accent},${C.accent2})`:`linear-gradient(135deg,${C.accent},#9333ea)`, border:"none", borderRadius:12, padding:"14px 20px", color:"white", fontSize:15, fontWeight:700, cursor:disabled?"not-allowed":"pointer", width:"100%", display:"flex", alignItems:"center", justifyContent:"center", gap:8, transition:"all 0.2s", outline:"none", boxShadow:h&&!disabled?`0 0 20px ${C.accentGlow}`:"none", ...style }}>
      {loading ? <Spinner size={18}/> : children}
    </button>
  );
}

function GhostBtn({ children, onClick, style={} }) {
  return (
    <button onClick={onClick}
      style={{ background:"transparent", border:`1px solid ${C.border}`, borderRadius:12, padding:"14px 20px", color:C.muted, fontSize:15, fontWeight:600, cursor:"pointer", width:"100%", transition:"all 0.15s", outline:"none", ...style }}>
      {children}
    </button>
  );
}

function ActionBtn({ icon, label, onClick }) {
  const [h, setH] = useState(false);
  return (
    <button onClick={onClick} onMouseEnter={()=>setH(true)} onMouseLeave={()=>setH(false)}
      style={{ display:"flex", flexDirection:"column", alignItems:"center", gap:6, background:h?"rgba(124,58,237,0.2)":"rgba(124,58,237,0.08)", border:`1px solid ${h?"rgba(124,58,237,0.5)":"rgba(124,58,237,0.2)"}`, borderRadius:14, padding:"12px 16px", color:C.text, cursor:"pointer", transition:"all 0.2s", outline:"none", flex:1 }}>
      <span style={{ fontSize:20 }}>{icon}</span>
      <span style={{ fontSize:11, fontWeight:600, color:C.muted }}>{label}</span>
    </button>
  );
}

function MnemonicGrid({ words }) {
  return (
    <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, padding:16, background:"rgba(0,0,0,0.3)", borderRadius:12, border:`1px solid ${C.border}` }}>
      {words.map((w,i) => (
        <div key={i} style={{ display:"flex", alignItems:"center", gap:8, background:"rgba(255,255,255,0.04)", padding:"8px 12px", borderRadius:8 }}>
          <span style={{ fontSize:11, color:C.muted, width:18, textAlign:"right" }}>{i+1}</span>
          <span style={{ fontSize:14, fontWeight:600, color:C.text, fontFamily:"monospace" }}>{w}</span>
        </div>
      ))}
    </div>
  );
}

function BottomNav({ active, onNavigate }) {
  const tabs = [["home","⌂","Início"],["assets","◈","Ativos"],["tx","⇄","Transações"],["explore","◯","Explore"],["settings","⚙","Config."]];
  return (
    <div style={{ display:"flex", borderTop:`1px solid ${C.border}`, background:C.surface }}>
      {tabs.map(([id,icon,label]) => {
        const on = active===id;
        return (
          <button key={id} onClick={()=>onNavigate(id)}
            style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:3, padding:"10px 0 8px", background:"transparent", border:"none", color:on?C.accent2:C.muted, cursor:"pointer", transition:"color 0.15s", outline:"none" }}>
            <span style={{ fontSize:18 }}>{icon}</span>
            <span style={{ fontSize:10, fontWeight:on?700:400 }}>{label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Asset row with real price + balance ────────────────────
function AssetRow({ chainKey, address, balance, price, onClick }) {
  const chain   = CHAINS[chainKey];
  const [hover, setHover] = useState(false);

  const bal     = balance ?? null;
  const priceUsd = price?.priceUsd || 0;
  const change  = price?.change24h;
  const usdVal  = bal !== null ? (bal * priceUsd).toFixed(2) : null;

  const fmtBal = bal !== null
    ? bal < 0.0001 ? bal.toFixed(8) : bal < 1 ? bal.toFixed(6) : bal.toFixed(4)
    : null;

  return (
    <div onMouseEnter={()=>setHover(true)} onMouseLeave={()=>setHover(false)} onClick={()=>onClick?.(chainKey)}
      style={{ display:"flex", alignItems:"center", gap:12, padding:"14px 16px", background:hover?"rgba(255,255,255,0.04)":"transparent", borderRadius:12, cursor:"pointer", transition:"background 0.15s" }}>
      <div style={{ width:42, height:42, borderRadius:12, background:`${chain.color}20`, border:`1px solid ${chain.color}40`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20, flexShrink:0 }}>
        {chain.icon}
      </div>
      <div style={{ flex:1, minWidth:0 }}>
        <div style={{ fontSize:14, fontWeight:700, color:C.text }}>{chain.name}</div>
        <div style={{ display:"flex", alignItems:"center", gap:6 }}>
          {priceUsd > 0
            ? <span style={{ fontSize:12, color:C.muted, fontFamily:"monospace" }}>${priceUsd.toLocaleString(undefined,{maximumFractionDigits:4})}</span>
            : <Skeleton w={60} h={12}/>}
          {change !== undefined && <Badge text={change}/>}
        </div>
      </div>
      <div style={{ textAlign:"right" }}>
        {fmtBal !== null
          ? <div style={{ fontSize:14, fontWeight:700, color:C.text, fontFamily:"monospace" }}>{fmtBal} {chain.symbol}</div>
          : <Skeleton w={80} h={14}/>}
        {usdVal !== null
          ? <div style={{ fontSize:12, color:C.muted, marginTop:2 }}>${parseFloat(usdVal).toLocaleString()}</div>
          : <Skeleton w={50} h={11} style={{marginTop:4}}/>}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SCREENS
// ═══════════════════════════════════════════════════════════════

// ─── Welcome ──────────────────────────────────────────────────
function WelcomeScreen({ onNavigate }) {
  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", position:"relative", overflow:"hidden" }}>
      <GlowOrb x={-80} y={80} color={C.accent} size={400}/>
      <GlowOrb x={100} y={380} color="#1d4ed8" size={300}/>
      <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:32, zIndex:1 }}>
        <div style={{ width:88, height:88, borderRadius:26, background:`linear-gradient(135deg,${C.accent},#1d4ed8)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:42, marginBottom:28, boxShadow:`0 0 40px ${C.accentGlow}` }}>⛓</div>
        <h1 style={{ fontSize:32, fontWeight:800, margin:"0 0 8px", textAlign:"center", background:`linear-gradient(135deg,${C.text},${C.accent2})`, WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>BC Wallet</h1>
        <p style={{ fontSize:15, color:C.muted, textAlign:"center", lineHeight:1.6, margin:"0 0 40px", maxWidth:260 }}>Carteira multi-chain com dados em tempo real.</p>
        {[["◎","Solana + DexScreener preços reais"],["₿","Bitcoin via Blockstream API"],["🔐","BIP32/39/44 · Taproot · Zero-mock"]].map(([i,t])=>(
          <div key={t} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 16px", marginBottom:8, background:"rgba(255,255,255,0.03)", borderRadius:10, width:"100%", maxWidth:300 }}>
            <span style={{ fontSize:18 }}>{i}</span>
            <span style={{ fontSize:13, color:C.muted }}>{t}</span>
          </div>
        ))}
      </div>
      <div style={{ padding:24, paddingBottom:32, display:"flex", flexDirection:"column", gap:12, zIndex:1 }}>
        <PrimaryBtn onClick={()=>onNavigate("create")}>✦ Criar nova carteira</PrimaryBtn>
        <GhostBtn onClick={()=>onNavigate("restore")}>Restaurar com seed phrase</GhostBtn>
      </div>
    </div>
  );
}

// ─── Create ───────────────────────────────────────────────────
function CreateScreen({ onNavigate, onWalletCreated }) {
  const [step, setStep]       = useState(1);
  const [pw, setPw]           = useState("");
  const [pw2, setPw2]         = useState("");
  const [pass, setPass]       = useState("");
  const [loading, setLoading] = useState(false);
  const [mnemonic, setMnemonic] = useState("");
  const [result, setResult]   = useState(null);
  const [error, setError]     = useState("");

  const ok = pw === pw2 && pw.length >= 8;
  const words = mnemonic ? mnemonic.split(" ") : [];

  const create = async () => {
    setLoading(true); setError("");
    try {
      const r = await WalletAPI.createWallet(pw, pass, "My Wallet");
      if (!r.ok) { setError(r.error); return; }
      setMnemonic(r.mnemonic); setResult(r); setStep(2);
    } catch { setError("Servidor offline. Inicie: node api/server.js"); }
    finally { setLoading(false); }
  };

  const finish = () => { if (result) onWalletCreated(result); onNavigate("home"); };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
      <div style={{ display:"flex", alignItems:"center", padding:"16px 20px", gap:12 }}>
        <button onClick={()=>onNavigate("welcome")} style={{ background:"none", border:"none", color:C.muted, fontSize:20, cursor:"pointer" }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.text }}>{step===1?"Criar Carteira":step===2?"Guarde sua Seed":"Pronto"}</span>
      </div>
      <div style={{ display:"flex", gap:4, padding:"0 20px 16px" }}>
        {[1,2,3].map(s=><div key={s} style={{ flex:1, height:3, borderRadius:2, background:s<=step?C.accent2:C.dim, transition:"background 0.3s" }}/>)}
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"0 20px 20px", display:"flex", flexDirection:"column", gap:14 }}>
        {step===1 && <>
          <Input label="Senha" type="password" placeholder="Mínimo 8 caracteres" value={pw} onChange={setPw}/>
          <Input label="Confirmar" type="password" placeholder="Repita" value={pw2} onChange={setPw2}/>
          <Input label="BIP39 Passphrase (opcional)" type="password" placeholder="25ª palavra" value={pass} onChange={setPass}/>
          {pass && <div style={{ padding:12, background:"rgba(245,158,11,0.1)", borderRadius:10, border:"1px solid rgba(245,158,11,0.3)" }}><p style={{ margin:0, fontSize:12, color:C.yellow }}>⚠️ Guarde a passphrase junto com o mnemonic.</p></div>}
          {error && <div style={{ color:C.red, fontSize:13, textAlign:"center" }}>{error}</div>}
          <PrimaryBtn onClick={create} loading={loading} disabled={!ok}>Gerar carteira</PrimaryBtn>
        </>}
        {step===2 && <>
          <div style={{ padding:14, background:"rgba(239,68,68,0.08)", borderRadius:12, border:"1px solid rgba(239,68,68,0.2)" }}>
            <p style={{ margin:0, fontSize:13, color:"#fca5a5", lineHeight:1.6 }}>⚠️ Escreva estas palavras. Nunca envie por mensagem.</p>
          </div>
          <MnemonicGrid words={words}/>
          <PrimaryBtn onClick={()=>setStep(3)}>Já guardei ✓</PrimaryBtn>
        </>}
        {step===3 && <>
          <div style={{ textAlign:"center", padding:"20px 0" }}>
            <div style={{ fontSize:56, marginBottom:16 }}>🎉</div>
            <h2 style={{ color:C.text, fontSize:20, margin:"0 0 8px" }}>Carteira criada!</h2>
            <p style={{ color:C.muted, fontSize:14, lineHeight:1.6 }}>Seus dados reais serão carregados automaticamente.</p>
          </div>
          {result && <GlassCard style={{ padding:16 }}><div style={{ fontSize:11, color:C.muted }}>Session ID</div><div style={{ fontSize:12, color:C.text, fontFamily:"monospace", marginTop:4 }}>{result.sessionId?.slice(0,24)}...</div></GlassCard>}
          <PrimaryBtn onClick={finish}>Ir para carteira →</PrimaryBtn>
        </>}
      </div>
    </div>
  );
}

// ─── Restore ──────────────────────────────────────────────────
function RestoreScreen({ onNavigate, onWalletCreated }) {
  const [mn, setMn]         = useState("");
  const [pw, setPw]         = useState("");
  const [pass, setPass]     = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState("");

  const restore = async () => {
    setLoading(true); setError("");
    try {
      const r = await WalletAPI.restoreWallet(mn.trim(), pw, pass);
      if (!r.ok) { setError(r.error); return; }
      onWalletCreated(r); onNavigate("home");
    } catch { setError("Servidor offline. Inicie: node api/server.js"); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
      <div style={{ display:"flex", alignItems:"center", padding:"16px 20px", gap:12 }}>
        <button onClick={()=>onNavigate("welcome")} style={{ background:"none", border:"none", color:C.muted, fontSize:20, cursor:"pointer" }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.text }}>Restaurar Carteira</span>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"0 20px 20px", display:"flex", flexDirection:"column", gap:14 }}>
        <div style={{ padding:14, background:"rgba(59,130,246,0.08)", borderRadius:12, border:"1px solid rgba(59,130,246,0.2)" }}>
          <p style={{ margin:0, fontSize:13, color:"#93c5fd", lineHeight:1.6 }}>🔑 12 ou 24 palavras separadas por espaço.</p>
        </div>
        <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
          <label style={{ fontSize:12, color:C.muted, fontWeight:600 }}>Seed Phrase</label>
          <textarea value={mn} onChange={e=>setMn(e.target.value)} placeholder="word1 word2 ..." rows={4}
            style={{ background:"rgba(255,255,255,0.05)", border:`1px solid ${C.border}`, borderRadius:10, padding:"12px 14px", color:C.text, fontSize:14, outline:"none", fontFamily:"monospace", resize:"vertical", boxSizing:"border-box", width:"100%" }}/>
        </div>
        <Input label="Nova senha" type="password" placeholder="Para proteger" value={pw} onChange={setPw}/>
        <Input label="BIP39 Passphrase (se usou)" type="password" placeholder="Opcional" value={pass} onChange={setPass}/>
        {error && <div style={{ color:C.red, fontSize:13, textAlign:"center" }}>{error}</div>}
        <PrimaryBtn onClick={restore} loading={loading} disabled={!mn.trim()||!pw}>Restaurar</PrimaryBtn>
      </div>
    </div>
  );
}

// ─── Home ─────────────────────────────────────────────────────
function HomeScreen({ session, portfolio, onNavigate }) {
  const { prices, loading: pricesLoading } = usePrices(30_000);
  const { balances, loading: balsLoading } = useBalances(portfolio, 20_000);
  const totalUSD = useTotalUSD(balances, prices);

  const primaryAddress = portfolio?.SOL?.address || portfolio?.BTC?.address;
  const shortAddr = primaryAddress
    ? primaryAddress.slice(0,6)+"..."+primaryAddress.slice(-4)
    : "Carregando...";

  const chainOrder = ["SOL","BTC","ETH","BC","LTC","DOGE"];
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = () => {
    setRefreshing(true);
    Object.keys(_cache).forEach(k => delete _cache[k]);
    setTimeout(() => setRefreshing(false), 2000);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%", position:"relative", overflow:"hidden" }}>
      <GlowOrb x={-60} y={-60} color={C.accent} size={350}/>

      {/* Header */}
      <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"16px 20px", zIndex:1 }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          <div style={{ width:36, height:36, borderRadius:10, background:`linear-gradient(135deg,${C.accent},#1d4ed8)`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>⛓</div>
          <div>
            <div style={{ fontSize:13, fontWeight:700, color:C.text }}>Minha Carteira</div>
            <div style={{ fontSize:11, color:C.muted, fontFamily:"monospace" }}>{shortAddr}</div>
          </div>
        </div>
        <button onClick={handleRefresh} style={{ background:"rgba(255,255,255,0.06)", border:`1px solid ${C.border}`, borderRadius:8, padding:"6px 10px", color:C.muted, cursor:"pointer", display:"flex", alignItems:"center", gap:6 }}>
          {refreshing ? <Spinner size={12}/> : <span style={{ fontSize:14 }}>↺</span>}
          <span style={{ fontSize:12 }}>Live</span>
        </button>
      </div>

      {/* Balance card */}
      <div style={{ padding:"0 20px 16px", zIndex:1 }}>
        <GlassCard style={{ padding:20, background:"rgba(124,58,237,0.08)", border:`1px solid rgba(124,58,237,0.2)` }}>
          <div style={{ fontSize:12, color:C.muted, marginBottom:4 }}>Portfólio total</div>
          {balsLoading && !totalUSD
            ? <Skeleton w={160} h={34}/>
            : <div style={{ fontSize:34, fontWeight:800, color:C.text, marginBottom:6, fontFamily:"monospace" }}>
                ${totalUSD.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}
              </div>}
          {prices.BTC && <div style={{ display:"flex", alignItems:"center", gap:8 }}>
            <Badge text={prices.BTC.change24h}/>
            <span style={{ fontSize:11, color:C.muted }}>24h · DexScreener</span>
            <span style={{ width:6, height:6, borderRadius:"50%", background:C.green, display:"inline-block" }}/>
          </div>}
        </GlassCard>
      </div>

      {/* Actions */}
      <div style={{ display:"flex", gap:8, padding:"0 20px 16px", zIndex:1 }}>
        <ActionBtn icon="↑" label="Enviar"  onClick={()=>onNavigate("send")}/>
        <ActionBtn icon="↓" label="Receber" onClick={()=>onNavigate("receive")}/>
        <ActionBtn icon="⇄" label="Swap"    onClick={()=>onNavigate("swap")}/>
      </div>

      {/* SOL featured card */}
      {prices.SOL && (
        <div style={{ padding:"0 20px 12px", zIndex:1 }}>
          <GlassCard style={{ padding:14, background:"rgba(153,69,255,0.08)", border:"1px solid rgba(153,69,255,0.25)" }}>
            <div style={{ display:"flex", alignItems:"center", gap:10 }}>
              <span style={{ fontSize:28 }}>◎</span>
              <div style={{ flex:1 }}>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <span style={{ fontSize:15, fontWeight:700, color:C.text }}>Solana</span>
                  <Badge text={prices.SOL.change24h}/>
                </div>
                <div style={{ fontSize:12, color:C.muted }}>
                  Vol 24h: ${(prices.SOL.volumeH24/1e6).toFixed(1)}M · Liq: ${(prices.SOL.liquidityUsd/1e6).toFixed(1)}M
                </div>
              </div>
              <div style={{ textAlign:"right" }}>
                <div style={{ fontSize:17, fontWeight:800, color:"#c4b5fd", fontFamily:"monospace" }}>
                  ${prices.SOL.priceUsd.toLocaleString(undefined,{maximumFractionDigits:2})}
                </div>
                <div style={{ fontSize:11, color:C.muted }}>via DexScreener</div>
              </div>
            </div>
          </GlassCard>
        </div>
      )}

      {/* Asset header */}
      <div style={{ padding:"0 20px 8px", zIndex:1, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <span style={{ fontSize:14, fontWeight:700, color:C.text }}>Ativos</span>
        <span style={{ fontSize:11, color:C.muted }}>
          {balsLoading ? "atualizando..." : "ao vivo"}
        </span>
      </div>

      {/* Asset list */}
      <div style={{ flex:1, overflowY:"auto", padding:"0 12px", zIndex:1 }}>
        <GlassCard style={{ overflow:"hidden" }}>
          {chainOrder.map((key, i) => (
            <div key={key}>
              <AssetRow
                chainKey={key}
                address={portfolio?.[key]?.address}
                balance={balances[key]}
                price={prices[key]}
                onClick={()=>onNavigate("chain-detail")}
              />
              {i < chainOrder.length-1 && <div style={{ height:1, background:C.border, margin:"0 16px" }}/>}
            </div>
          ))}
        </GlassCard>

        {/* Price source badge */}
        <div style={{ display:"flex", alignItems:"center", gap:6, padding:"10px 4px" }}>
          <span style={{ width:6, height:6, borderRadius:"50%", background:C.green }}/>
          <span style={{ fontSize:11, color:C.muted }}>Preços: DexScreener · Saldos: Blockstream / Solana RPC</span>
        </div>
        <div style={{ height:8 }}/>
      </div>
    </div>
  );
}

// ─── Assets Screen ────────────────────────────────────────────
function AssetsScreen({ portfolio }) {
  const { prices } = usePrices(30_000);
  const { balances } = useBalances(portfolio, 20_000);
  const chainOrder = ["SOL","BTC","ETH","BC","LTC","DOGE"];

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
      <div style={{ padding:"16px 20px 8px", fontSize:18, fontWeight:800, color:C.text }}>Ativos</div>
      <div style={{ flex:1, overflowY:"auto", padding:"0 16px" }}>
        <GlassCard style={{ overflow:"hidden" }}>
          {chainOrder.map((key,i) => (
            <div key={key}>
              <AssetRow chainKey={key} address={portfolio?.[key]?.address} balance={balances[key]} price={prices[key]} onClick={()=>{}}/>
              {i < chainOrder.length-1 && <div style={{ height:1, background:C.border, margin:"0 16px" }}/>}
            </div>
          ))}
        </GlassCard>

        {/* Market overview */}
        <div style={{ padding:"16px 4px 4px", fontSize:14, fontWeight:700, color:C.text }}>Mercado em tempo real</div>
        <GlassCard style={{ padding:"8px 0", overflow:"hidden" }}>
          {Object.entries(prices).map(([sym, p]) => (
            <div key={sym} style={{ display:"flex", alignItems:"center", gap:12, padding:"10px 16px" }}>
              <span style={{ fontSize:18, width:24, textAlign:"center" }}>{CHAINS[sym]?.icon||"?"}</span>
              <span style={{ flex:1, fontSize:13, fontWeight:600, color:C.text }}>{sym}</span>
              <span style={{ fontSize:13, color:C.text, fontFamily:"monospace" }}>${p.priceUsd?.toLocaleString(undefined,{maximumFractionDigits:4})}</span>
              <Badge text={p.change24h}/>
            </div>
          ))}
        </GlassCard>
        <div style={{ height:16 }}/>
      </div>
    </div>
  );
}

// ─── Transactions ─────────────────────────────────────────────
function TxScreen({ portfolio }) {
  const solAddr = portfolio?.SOL?.address;
  const { txs, loading } = useSolTransactions(solAddr);

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
      <div style={{ padding:"16px 20px 8px", fontSize:18, fontWeight:800, color:C.text }}>Transações</div>
      <div style={{ flex:1, overflowY:"auto", padding:"0 16px" }}>
        {loading && (
          <div style={{ display:"flex", justifyContent:"center", padding:32 }}><Spinner size={28}/></div>
        )}
        {!loading && txs.length === 0 && !solAddr && (
          <GlassCard style={{ padding:32, textAlign:"center" }}>
            <div style={{ fontSize:36, marginBottom:12 }}>📭</div>
            <div style={{ color:C.text, fontSize:15, fontWeight:600 }}>Nenhuma transação</div>
            <p style={{ color:C.muted, fontSize:13, lineHeight:1.6, marginTop:8 }}>
              Conecte sua wallet para ver transações reais da Solana.
            </p>
          </GlassCard>
        )}
        {txs.length > 0 && (
          <GlassCard style={{ overflow:"hidden" }}>
            {txs.map((tx, i) => (
              <div key={tx.hash}>
                <div style={{ display:"flex", alignItems:"center", gap:12, padding:"14px 16px" }}>
                  <div style={{ width:38, height:38, borderRadius:10, background:"rgba(153,69,255,0.1)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:16, flexShrink:0 }}>◎</div>
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ fontSize:13, fontWeight:600, color:C.text }}>Transação Solana</div>
                    <div style={{ fontSize:11, color:C.muted, fontFamily:"monospace", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
                      {tx.hash.slice(0,20)}...
                    </div>
                    <div style={{ fontSize:11, color:C.muted }}>{tx.time}</div>
                  </div>
                  <div>
                    <span style={{ padding:"3px 8px", borderRadius:20, fontSize:11, fontWeight:600, background:tx.status==="confirmed"?"rgba(34,197,94,0.1)":"rgba(239,68,68,0.1)", color:tx.status==="confirmed"?C.green:C.red }}>
                      {tx.status}
                    </span>
                  </div>
                </div>
                {i < txs.length-1 && <div style={{ height:1, background:C.border, margin:"0 16px" }}/>}
              </div>
            ))}
          </GlassCard>
        )}
        <div style={{ padding:"12px 4px" }}>
          <div style={{ display:"flex", alignItems:"center", gap:6 }}>
            <span style={{ width:6, height:6, borderRadius:"50%", background:C.green }}/>
            <span style={{ fontSize:11, color:C.muted }}>Histórico via Solana RPC · api.mainnet-beta.solana.com</span>
          </div>
        </div>
        <div style={{ height:16 }}/>
      </div>
    </div>
  );
}

// ─── Receive ──────────────────────────────────────────────────
function ReceiveScreen({ portfolio, onBack }) {
  const [chain, setChain] = useState("SOL");
  const address = portfolio?.[chain]?.address || "—";
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try { await navigator.clipboard.writeText(address); } catch {}
    setCopied(true); setTimeout(()=>setCopied(false), 2000);
  };

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
      <div style={{ display:"flex", alignItems:"center", padding:"16px 20px", gap:12 }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:C.muted, fontSize:20, cursor:"pointer" }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.text }}>Receber</span>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"0 20px 20px", display:"flex", flexDirection:"column", gap:16 }}>
        <div style={{ display:"flex", gap:8, overflowX:"auto", paddingBottom:4 }}>
          {["SOL","BTC","ETH","BC","LTC","DOGE"].map(c=>(
            <button key={c} onClick={()=>setChain(c)} style={{ padding:"6px 16px", borderRadius:20, background:chain===c?C.accent:"rgba(255,255,255,0.06)", border:`1px solid ${chain===c?C.accent:C.border}`, color:chain===c?"white":C.muted, cursor:"pointer", fontSize:13, fontWeight:600, flexShrink:0 }}>{c}</button>
          ))}
        </div>
        <GlassCard style={{ padding:24, display:"flex", flexDirection:"column", alignItems:"center", gap:16 }}>
          {/* QR placeholder — real QR would need qrcode lib */}
          <div style={{ width:180, height:180, background:"rgba(255,255,255,0.04)", border:`2px solid ${C.border}`, borderRadius:16, display:"flex", alignItems:"center", justifyContent:"center", flexDirection:"column", gap:8 }}>
            <span style={{ fontSize:48 }}>{CHAINS[chain]?.icon}</span>
            <span style={{ fontSize:11, color:C.muted }}>{chain}</span>
          </div>
          <div style={{ textAlign:"center", width:"100%" }}>
            <div style={{ fontSize:12, color:C.muted, marginBottom:6 }}>Endereço {CHAINS[chain]?.name}</div>
            <div style={{ fontSize:12, color:C.text, fontFamily:"monospace", wordBreak:"break-all", lineHeight:1.7, padding:"10px 14px", background:"rgba(255,255,255,0.04)", borderRadius:8 }}>
              {address}
            </div>
          </div>
          <div style={{ display:"flex", gap:8, width:"100%" }}>
            <GhostBtn onClick={copy} style={{ flex:1, padding:"10px 0", fontSize:13 }}>
              {copied ? "✓ Copiado!" : "📋 Copiar"}
            </GhostBtn>
          </div>
        </GlassCard>
        <div style={{ padding:12, background:"rgba(34,197,94,0.08)", borderRadius:10, border:"1px solid rgba(34,197,94,0.2)" }}>
          <p style={{ margin:0, fontSize:12, color:"#86efac", lineHeight:1.6 }}>✓ Endereço derivado via BIP44 · m/{CHAINS[chain]?.symbol==="SOL"?"44'/501'":"44'/0'"}/0'/0/0</p>
        </div>
      </div>
    </div>
  );
}

// ─── Send ─────────────────────────────────────────────────────
function SendScreen({ portfolio, prices, onBack }) {
  const [chain, setChain] = useState("SOL");
  const [to, setTo]       = useState("");
  const [amount, setAmount] = useState("");
  const [fee, setFee]     = useState("medium");
  const p = prices[chain];

  const usdValue = p && amount ? (parseFloat(amount||0) * p.priceUsd).toFixed(2) : null;

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
      <div style={{ display:"flex", alignItems:"center", padding:"16px 20px", gap:12 }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:C.muted, fontSize:20, cursor:"pointer" }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.text }}>Enviar</span>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"0 20px 20px", display:"flex", flexDirection:"column", gap:14 }}>
        <div style={{ display:"flex", gap:6 }}>
          {["SOL","BTC","ETH"].map(c=>(
            <button key={c} onClick={()=>setChain(c)} style={{ flex:1, padding:"8px", borderRadius:10, background:chain===c?C.accent:"rgba(255,255,255,0.05)", border:`1px solid ${chain===c?C.accent:C.border}`, color:chain===c?"white":C.muted, cursor:"pointer", fontSize:13, fontWeight:600 }}>
              {CHAINS[c]?.icon} {c}
            </button>
          ))}
        </div>

        {p && (
          <div style={{ padding:"10px 14px", background:"rgba(255,255,255,0.04)", borderRadius:10, display:"flex", justifyContent:"space-between" }}>
            <span style={{ fontSize:12, color:C.muted }}>Preço {chain}</span>
            <div style={{ display:"flex", alignItems:"center", gap:6 }}>
              <span style={{ fontSize:13, color:C.text, fontFamily:"monospace" }}>${p.priceUsd.toLocaleString(undefined,{maximumFractionDigits:4})}</span>
              <Badge text={p.change24h}/>
            </div>
          </div>
        )}

        <Input label="Para" placeholder={chain==="SOL"?"7x2Y...Wx9Z":"bc1q... / 0x..."} value={to} onChange={setTo}/>

        <div style={{ display:"flex", flexDirection:"column", gap:4 }}>
          <label style={{ fontSize:12, color:C.muted, fontWeight:600 }}>Valor ({chain})</label>
          <div style={{ position:"relative" }}>
            <input value={amount} onChange={e=>setAmount(e.target.value)} placeholder="0.00" type="number"
              style={{ background:"rgba(255,255,255,0.05)", border:`1px solid ${C.border}`, borderRadius:10, padding:"12px 14px", color:C.text, fontSize:18, fontWeight:700, outline:"none", fontFamily:"monospace", width:"100%", boxSizing:"border-box" }}/>
            {usdValue && <div style={{ fontSize:12, color:C.muted, padding:"4px 14px" }}>≈ ${usdValue} USD</div>}
          </div>
        </div>

        {/* Fee */}
        <div>
          <label style={{ fontSize:12, color:C.muted, fontWeight:600, display:"block", marginBottom:8 }}>Taxa de rede</label>
          <div style={{ display:"flex", gap:6 }}>
            {[["slow","Lenta","~60min","1"],["medium","Normal","~30min","5"],["fast","Rápida","~10min","20"]].map(([id,l,t,r])=>(
              <button key={id} onClick={()=>setFee(id)} style={{ flex:1, padding:"10px 6px", borderRadius:10, background:fee===id?"rgba(124,58,237,0.2)":"rgba(255,255,255,0.04)", border:`1px solid ${fee===id?C.accent:C.border}`, cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:2, outline:"none" }}>
                <span style={{ fontSize:12, fontWeight:700, color:fee===id?C.accent2:C.text }}>{l}</span>
                <span style={{ fontSize:10, color:C.muted }}>{t}</span>
                <span style={{ fontSize:10, color:C.muted, fontFamily:"monospace" }}>{r} sat/vb</span>
              </button>
            ))}
          </div>
        </div>

        {to && amount && (
          <GlassCard style={{ padding:14 }}>
            {[["Enviar",`${amount} ${chain}`],["≈ USD",`$${usdValue||"—"}`],["Taxa","~0.00015 "+chain]].map(([k,v])=>(
              <div key={k} style={{ display:"flex", justifyContent:"space-between", marginBottom:8 }}>
                <span style={{ fontSize:13, color:C.muted }}>{k}</span>
                <span style={{ fontSize:13, color:C.text, fontFamily:"monospace" }}>{v}</span>
              </div>
            ))}
          </GlassCard>
        )}

        <PrimaryBtn disabled={!to||!amount}>Revisar transação →</PrimaryBtn>
      </div>
    </div>
  );
}

// ─── Explore (DexScreener trending) ──────────────────────────
function ExploreScreen() {
  const [trending, setTrending] = useState([]);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    DexScreener.getTrendingTokens("solana")
      .then(setTrending).catch(()=>{}).finally(()=>setLoading(false));
  }, []);

  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
      <div style={{ padding:"16px 20px 8px", fontSize:18, fontWeight:800, color:C.text }}>Explore</div>
      <div style={{ flex:1, overflowY:"auto", padding:"0 16px" }}>
        <div style={{ fontSize:14, fontWeight:700, color:C.text, padding:"4px 4px 8px" }}>🔥 Trending DexScreener</div>
        {loading && <div style={{ display:"flex", justifyContent:"center", padding:32 }}><Spinner size={28}/></div>}
        {!loading && (
          <GlassCard style={{ overflow:"hidden" }}>
            {trending.length === 0 && (
              <div style={{ padding:24, textAlign:"center" }}>
                <div style={{ color:C.muted, fontSize:13 }}>Nenhum token trending disponível</div>
                <div style={{ color:C.dim, fontSize:11, marginTop:4 }}>Verifique sua conexão</div>
              </div>
            )}
            {trending.map((t, i) => (
              <div key={i}>
                <div style={{ display:"flex", alignItems:"center", gap:12, padding:"12px 16px" }}>
                  {t.icon
                    ? <img src={t.icon} alt="" style={{ width:36, height:36, borderRadius:"50%", objectFit:"cover" }}/>
                    : <div style={{ width:36, height:36, borderRadius:"50%", background:"rgba(124,58,237,0.2)", display:"flex", alignItems:"center", justifyContent:"center", fontSize:16 }}>◈</div>}
                  <div style={{ flex:1 }}>
                    <div style={{ fontSize:13, fontWeight:700, color:C.text }}>{t.header || t.tokenAddress?.slice(0,10)+"..."}</div>
                    <div style={{ fontSize:11, color:C.muted }}>{t.chainId}</div>
                  </div>
                  <a href={t.url||"#"} target="_blank" rel="noreferrer" style={{ fontSize:11, color:C.accent2, textDecoration:"none" }}>Ver →</a>
                </div>
                {i < trending.length-1 && <div style={{ height:1, background:C.border, margin:"0 16px" }}/>}
              </div>
            ))}
          </GlassCard>
        )}
        <div style={{ padding:"10px 4px" }}>
          <span style={{ fontSize:11, color:C.muted }}>Dados: DexScreener API · Atualizado em tempo real</span>
        </div>
        <div style={{ height:16 }}/>
      </div>
    </div>
  );
}

// ─── Settings ─────────────────────────────────────────────────
function SettingsScreen({ onBack, onLogout, session }) {
  const rows = [
    ["🔐","Segurança","Biometria, PIN"],
    ["💾","Backup","Exportar keystore"],
    ["🌐","Redes","Mainnet / Testnet"],
    ["🔑","Web3 Login","Challenge auth"],
    ["ℹ️","Sobre","v1.0 · Node.js Core"],
  ];
  return (
    <div style={{ display:"flex", flexDirection:"column", height:"100%" }}>
      <div style={{ display:"flex", alignItems:"center", padding:"16px 20px", gap:12 }}>
        <button onClick={onBack} style={{ background:"none", border:"none", color:C.muted, fontSize:20, cursor:"pointer" }}>←</button>
        <span style={{ fontSize:16, fontWeight:700, color:C.text }}>Configurações</span>
      </div>
      <div style={{ flex:1, overflowY:"auto", padding:"0 16px 20px", display:"flex", flexDirection:"column", gap:12 }}>
        {session && <GlassCard style={{ padding:14 }}>
          <div style={{ fontSize:11, color:C.muted }}>Session ativa</div>
          <div style={{ fontSize:12, color:C.text, fontFamily:"monospace", marginTop:2 }}>{session.slice(0,20)}...</div>
          <div style={{ display:"flex", alignItems:"center", gap:6, marginTop:6 }}>
            <span style={{ width:6, height:6, borderRadius:"50%", background:C.green }}/>
            <span style={{ fontSize:11, color:C.green }}>Conectado ao BC API</span>
          </div>
        </GlassCard>}
        <GlassCard style={{ overflow:"hidden" }}>
          {rows.map(([icon,label,sub],i)=>(
            <div key={label}>
              <div style={{ display:"flex", alignItems:"center", gap:12, padding:"14px 16px", cursor:"pointer" }}>
                <span style={{ fontSize:20 }}>{icon}</span>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:14, fontWeight:600, color:C.text }}>{label}</div>
                  <div style={{ fontSize:12, color:C.muted }}>{sub}</div>
                </div>
                <span style={{ color:C.dim }}>›</span>
              </div>
              {i<rows.length-1 && <div style={{ height:1, background:C.border, margin:"0 16px" }}/>}
            </div>
          ))}
        </GlassCard>
        <button onClick={onLogout} style={{ background:"rgba(239,68,68,0.08)", border:"1px solid rgba(239,68,68,0.2)", borderRadius:12, padding:"14px 20px", color:"#fca5a5", fontSize:14, fontWeight:600, cursor:"pointer", width:"100%" }}>
          🔒 Bloquear carteira
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// ROOT
// ═══════════════════════════════════════════════════════════════
export default function BCWalletApp() {
  const [screen, setScreen]     = useState("welcome");
  const [navTab, setNavTab]     = useState("home");
  const [session, setSession]   = useState(null);
  const [portfolio, setPortfolio] = useState(null);

  const { prices } = usePrices(30_000);

  const onWalletCreated = useCallback(async (result) => {
    setSession(result.sessionId);
    // Fetch real portfolio from backend
    if (result.sessionId) {
      try {
        const p = await WalletAPI.getPortfolio(result.sessionId);
        if (p.ok) setPortfolio(p.portfolio);
      } catch {}
    }
  }, []);

  const isInApp = !["welcome","create","restore"].includes(screen);

  const nav = (s) => {
    const tabScreens = ["home","assets","tx","explore","settings"];
    if (tabScreens.includes(s)) { setNavTab(s); setScreen("home"); }
    else setScreen(s);
  };

  const getContent = () => {
    switch(screen) {
      case "welcome":  return <WelcomeScreen onNavigate={nav}/>;
      case "create":   return <CreateScreen  onNavigate={nav} onWalletCreated={onWalletCreated}/>;
      case "restore":  return <RestoreScreen onNavigate={nav} onWalletCreated={onWalletCreated}/>;
      case "receive":  return <ReceiveScreen portfolio={portfolio} onBack={()=>setScreen("home")}/>;
      case "send":     return <SendScreen    portfolio={portfolio} prices={prices} onBack={()=>setScreen("home")}/>;
      case "swap":     return (
        <div style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", gap:16, padding:32 }}>
          <button onClick={()=>setScreen("home")} style={{ position:"absolute", top:16, left:20, background:"none", border:"none", color:C.muted, fontSize:20, cursor:"pointer" }}>←</button>
          <span style={{ fontSize:48 }}>⇄</span>
          <div style={{ fontSize:18, fontWeight:700, color:C.text }}>Swap em breve</div>
          <p style={{ color:C.muted, textAlign:"center", fontSize:13, lineHeight:1.6 }}>Integração THORChain · Jupiter · 1inch em desenvolvimento.</p>
        </div>
      );
      default:
        const tabMap = {
          home:     <HomeScreen     session={session} portfolio={portfolio} onNavigate={nav}/>,
          assets:   <AssetsScreen   portfolio={portfolio}/>,
          tx:       <TxScreen       portfolio={portfolio}/>,
          explore:  <ExploreScreen/>,
          settings: <SettingsScreen onBack={()=>nav("home")} onLogout={()=>{ setSession(null); setScreen("welcome"); }} session={session}/>,
        };
        return tabMap[navTab] || tabMap.home;
    }
  };

  return (
    <>
      <style>{`
        *{box-sizing:border-box;margin:0;padding:0;}
        body{background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:'SF Pro Text',-apple-system,'Segoe UI',sans-serif;}
        @keyframes spin{to{transform:rotate(360deg);}}
        @keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.5;}}
        ::-webkit-scrollbar{width:3px;}::-webkit-scrollbar-track{background:transparent;}::-webkit-scrollbar-thumb{background:rgba(255,255,255,0.1);border-radius:2px;}
        input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;}
      `}</style>

      {/* Phone frame */}
      <div style={{ width:390, height:844, background:C.bg, borderRadius:44, overflow:"hidden", border:"2px solid rgba(255,255,255,0.08)", boxShadow:"0 0 80px rgba(0,0,0,0.8),inset 0 1px 0 rgba(255,255,255,0.1)", display:"flex", flexDirection:"column", position:"relative" }}>
        {/* Status bar */}
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"12px 28px 6px", background:"rgba(0,0,0,0.2)", fontSize:12, fontWeight:600, color:C.text, flexShrink:0 }}>
          <span>9:41</span>
          <div style={{ width:120, height:28, borderRadius:20, background:"#000", border:"2px solid rgba(255,255,255,0.08)" }}/>
          <span>●●●</span>
        </div>

        {/* Main content */}
        <div style={{ flex:1, overflow:"hidden", display:"flex", flexDirection:"column" }}>
          {getContent()}
        </div>

        {/* Bottom nav */}
        {(isInApp || screen==="home") && (
          <BottomNav active={navTab} onNavigate={(t)=>{ setNavTab(t); setScreen("home"); }}/>
        )}

        {/* Home indicator */}
        <div style={{ padding:"8px 0 6px", display:"flex", justifyContent:"center" }}>
          <div style={{ width:134, height:5, borderRadius:3, background:"rgba(255,255,255,0.2)" }}/>
        </div>
      </div>

      {/* Info panel */}
      <div style={{ position:"fixed", right:"calc(50% - 265px)", top:"50%", transform:"translateY(-50%)", opacity:0.45, display:"flex", flexDirection:"column", gap:6 }}>
        {["BC Wallet v1.0","Dados Reais","DexScreener API","Solana RPC","Blockstream BTC","BIP32/39/44","Taproot"].map(t=>(
          <div key={t} style={{ fontSize:10, color:"#555", fontFamily:"monospace", textAlign:"right" }}>{t}</div>
        ))}
      </div>
    </>
  );
}

