/**
 * hooks/index.js — todos os hooks da wallet em um arquivo
 */
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { getAllBalances } from "../services/balances";
import { getFormattedTransactions } from "../services/solana";
import api from "../services/api";

// ─── usePortfolio ─────────────────────────────────────────────
export function usePortfolio(sessionId) {
  const [portfolio, setPortfolio] = useState(null);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState(null);

  const load = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const r = await api.getPortfolio(sessionId);
      if (r.ok) setPortfolio(r.portfolio);
      else setError(r.error);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [sessionId]);

  useEffect(() => { load(); }, [load]);
  return { portfolio, loading, error, refresh: load };
}

// ─── useBalances ──────────────────────────────────────────────
export function useBalances(portfolio, refreshMs = 20_000) {
  const [balances, setBalances] = useState({});
  const [loading, setLoading]   = useState(false);
  const prev = useRef(null);

  const load = useCallback(async () => {
    if (!portfolio) return;
    setLoading(true);
    try {
      const b = await getAllBalances(portfolio);
      setBalances(b);
    } catch {}
    setLoading(false);
  }, [portfolio]);

  useEffect(() => {
    if (!portfolio || portfolio === prev.current) return;
    prev.current = portfolio;
    load();
    const t = setInterval(load, refreshMs);
    return () => clearInterval(t);
  }, [portfolio, load, refreshMs]);

  return { balances, loading, refresh: load };
}

// ─── useTotalUSD ──────────────────────────────────────────────
export function useTotalUSD(balances, prices) {
  return useMemo(() => {
    let total = 0;
    for (const [chain, bal] of Object.entries(balances || {})) {
      if (bal == null) continue;
      const p = prices[chain]?.priceUsd || 0;
      total += bal * p;
    }
    return total;
  }, [balances, prices]);
}

// ─── useSolTransactions ───────────────────────────────────────
export function useSolTransactions(address, limit = 10) {
  const [txs, setTxs]       = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]   = useState(null);

  const load = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    try {
      const t = await getFormattedTransactions(address, limit);
      setTxs(t);
      setError(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  }, [address, limit]);

  useEffect(() => { load(); }, [load]);
  return { txs, loading, error, refresh: load };
}

// ─── useServerHealth ─────────────────────────────────────────
export function useServerHealth() {
  const [online, setOnline] = useState(null);
  useEffect(() => {
    api.health().then(r => setOnline(r.status === "online")).catch(() => setOnline(false));
    const t = setInterval(() =>
      api.health().then(r => setOnline(r.status === "online")).catch(() => setOnline(false))
    , 15_000);
    return () => clearInterval(t);
  }, []);
  return online;
}

