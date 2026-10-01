import { AnimatePresence, motion, useAnimation } from "framer-motion";
import { FormEvent, PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import { findSlotIndex, mergeMarketSnapshot, nextFeedIndex, rememberSkippedSlot, uniqueMarketSnapshot } from "./feed-state";
import type { Comment, Market, Position, Session } from "./types";
import "./positions.css";

declare global { interface Window { ethereum?: { request: (args: { method: string; params?: unknown[] }) => Promise<unknown> }; google?: { accounts: { id: { initialize: (args: unknown) => void; renderButton: (element: HTMLElement, options: unknown) => void } } } } }

type View = "landing" | "warning" | "feed" | "deposit" | "withdraw" | "positions" | "comments" | "how";
const usdc = (raw: string) => (Number(raw) / 1_000_000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const timeframe = (seconds: string) => ({ "300": "5m", "900": "15m", "3600": "1h" }[seconds] ?? `${Number(seconds) / 60}m`);
const clock = (seconds: number) => `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.max(0, seconds) % 60).padStart(2, "0")}`;
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

function Login({ onSession }: { onSession: (session: Session) => void }) {
  const [error, setError] = useState(""); const googleButton = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
    let attempts = 0;
    const initializeGoogle = () => {
      if (!clientId) { setError("Google sign-in is not configured."); return; }
      if (!window.google) { if (++attempts < 20) window.setTimeout(initializeGoogle, 250); else setError("Google Identity Services did not load. Check your connection and reload."); return; }
      if (!googleButton.current) return;
      const googleWindow = window as Window & { __arctickGoogleInitialized?: boolean };
      if (!googleWindow.__arctickGoogleInitialized) {
        googleWindow.__arctickGoogleInitialized = true;
        window.google.accounts.id.initialize({
          client_id: clientId,
          callback: async ({ credential }: { credential?: string }) => {
            try {
              if (!credential) throw new Error("Google did not return an ID token.");
              const next = await api.googleAuth(credential);
              console.info("ArcTick Google sign-in succeeded");
              onSession(next);
            } catch (cause) {
              const message = cause instanceof Error ? cause.message : "Google sign-in failed.";
              console.error("ArcTick Google sign-in failed", cause);
              setError(message);
            }
          }
        });
      }
      googleButton.current.replaceChildren();
      window.google.accounts.id.renderButton(googleButton.current, { theme: "outline", size: "large", text: "signin_with", shape: "rectangular", width: 360 });
    };
    initializeGoogle();
  }, [onSession]);
  async function connectWallet() {
    try {
      if (!window.ethereum) throw new Error("No browser wallet found. Open ArcTick in a wallet browser.");
      const [address] = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
      const { message } = await api.walletNonce(address);
      const signature = await window.ethereum.request({ method: "personal_sign", params: [message, address] }) as string;
      onSession(await api.walletConnect(address, signature));
    } catch (err) { console.error("ArcTick wallet connection failed", err); setError(err instanceof Error ? err.message : "Wallet connection failed"); }
  }
  return <main className="screen landing"><div className="brand">ARC<span>TICK</span></div><div className="landing-copy"><p className="eyebrow">ON ARC MAINNET</p><h1>Read the move.<br />Choose a side.</h1><p>Short-window price markets, settled in USDC.</p></div><div className="actions"><div className="google-button" ref={googleButton} aria-label="Sign in with Google" /><button className="button" onClick={connectWallet}>Connect wallet</button>{error && <p className="error">{error}</p>}</div></main>;
}

function Warning({ acknowledge }: { acknowledge: () => void }) { return <main className="screen"><div className="panel warning"><p className="eyebrow">ONE IMPORTANT THING</p><h1>Keep this browser data.</h1><p>Your ArcTick wallet is stored securely for this browser session. If you clear this browser’s storage or cache, you may lose access to this wallet and its funds.</p><p>Save your wallet address somewhere safe and only use devices you trust.</p><button className="button primary" onClick={acknowledge}>I understand</button></div></main>; }

function MarketCard({ market, amount, canUndoSkip, onYes, onNo, onSkip, onUndoSkip, onOpen, onComments, onFavorite }: { market: Market; amount: string; canUndoSkip: boolean; onYes: () => void; onNo: () => void; onSkip: () => void; onUndoSkip: () => void; onOpen: () => void; onComments: () => void; onFavorite: () => void }) {
  const controls = useAnimation(); const started = useRef(0); const lastTap = useRef(0); const gestureStart = useRef<{ x: number; y: number } | null>(null); const verticalSkipHandled = useRef(false);
  const [remaining, setRemaining] = useState(market.kind === "live" ? Math.max(0, Number(market.endTime) - Math.floor(Date.now() / 1000)) : 0);
  useEffect(() => { if (market.kind === "virtual") return; const timer = window.setInterval(() => setRemaining(Math.max(0, Number(market.endTime) - Math.floor(Date.now() / 1000))), 1000); return () => clearInterval(timer); }, [market.kind, market.endTime]);
  async function dismiss(side: "yes" | "no" | "pass") { if (market.status === "unavailable") return; await controls.start(side === "pass" ? { y: -40, scale: 0.96, opacity: 0, transition: { duration: 0.2 } } : { x: side === "yes" ? 520 : -520, rotate: side === "yes" ? 12 : -12, opacity: 0, transition: { duration: 0.22 } }); if (side === "yes") onYes(); else if (side === "no") onNo(); else onSkip(); }
  function pointerDown(event: ReactPointerEvent) { if ((event.target as HTMLElement).closest("button")) return; verticalSkipHandled.current = false; gestureStart.current = { x: event.clientX, y: event.clientY }; started.current = Date.now(); }
  function pointerUp(event: ReactPointerEvent) {
    if ((event.target as HTMLElement).closest("button")) { gestureStart.current = null; return; }
    const start = gestureStart.current;
    gestureStart.current = null;
    if (start) {
      const deltaX = event.clientX - start.x;
      const deltaY = event.clientY - start.y;
      if (deltaY < -85 && Math.abs(deltaY) > Math.abs(deltaX) * 1.15) {
        verticalSkipHandled.current = true;
        void dismiss("pass");
        return;
      }
      if (Math.abs(deltaX) > 8 || Math.abs(deltaY) > 8) return;
    }
    if (Date.now() - started.current > 230) return;
    const now = Date.now(); if (now - lastTap.current < 280) { onFavorite(); lastTap.current = 0; } else { lastTap.current = now; window.setTimeout(() => { if (lastTap.current === now) onOpen(); }, 290); }
  }
  return <motion.article className="market-card" drag={market.status === "unavailable" ? false : true} dragConstraints={{ left: 0, right: 0, top: 0, bottom: 0 }} dragElastic={0.15} animate={controls} onPointerDown={pointerDown} onPointerUp={pointerUp} onDragEnd={(_, info) => { if (verticalSkipHandled.current) { verticalSkipHandled.current = false; return; } if (info.offset.x > 110) dismiss("yes"); else if (info.offset.x < -110) dismiss("no"); else controls.start({ x: 0, y: 0 }); }}>
    <div className="card-top"><span className="asset">{market.assetPair}</span><span className="live"><i /> {market.status === "unavailable" ? "UNAVAILABLE" : market.kind === "live" ? "LIVE" : "ON DEMAND"}</span></div>
    <div className="direction"><span>{market.status === "unavailable" ? "—" : "UP"}</span><p>{market.status === "unavailable" ? "Price data temporarily unavailable" : `Will ${market.assetPair.split("/")[0]} finish higher?`}</p></div>
    <div className="timer"><b>{market.kind === "live" ? clock(remaining) : market.status === "unavailable" ? "—" : "READY"}</b><span>{market.status === "unavailable" ? "This market can’t be opened right now" : market.kind === "live" ? `${timeframe(market.duration)} market` : `Runs ${timeframe(market.duration)} after opening`}</span></div>
    <div className="card-bottom"><span>{market.status === "unavailable" ? "Temporarily unavailable" : <>Swipe right YES · left NO <small>{amount || "0"} USDC · swipe up or tap × to pass</small></>}</span><div className="card-controls">{market.kind === "live" && market.address && <button aria-label="Open comments" onClick={event => { event.stopPropagation(); onComments(); }}>◌</button>}<div className="card-utility-actions"><button className="pass-button" aria-label="Pass on this market" title="Pass without betting" disabled={market.status === "unavailable"} onClick={event => { event.stopPropagation(); dismiss("pass"); }}>×</button><button className="undo-skip-button" aria-label="Undo last skipped market" title="Undo last pass" disabled={!canUndoSkip} onClick={event => { event.stopPropagation(); onUndoSkip(); }}>↧</button></div></div></div>
  </motion.article>;
}

function Detail({ market, close }: { market: Market; close: () => void }) { const pair = market.assetPair.replace(/ \d+s$/, ""); return <div className="sheet-backdrop" onClick={close}><section className="sheet" onClick={event => event.stopPropagation()}><button className="close" onClick={close}>×</button><p className="eyebrow">{market.status === "unavailable" ? "TEMPORARILY UNAVAILABLE" : market.kind === "live" ? "LIVE MARKET" : "READY ON DEMAND"}</p><h2>{market.assetPair} · {timeframe(market.duration)}</h2>{market.kind === "live" && market.yesPool !== null && market.noPool !== null && <div className="pool-grid"><div><span>YES bought</span><b>{usdc(market.yesPool)} USDC</b><small>{market.yesParticipants} participants</small></div><div><span>NO bought</span><b>{usdc(market.noPool)} USDC</b><small>{market.noParticipants} participants</small></div></div>}{market.status === "unavailable" ? <p className="muted">Price or market data is temporarily unavailable for this pair.</p> : <><p className="muted">Choose YES if you think {pair} will be up at close, or NO if you think it won’t. Swipe right for YES, left for NO, or tap × to pass without betting.</p><p className="muted">If the price feed doesn’t update in time, your position is refunded.</p></>}</section></div>; }

function HowItWorks({ close }: { close: () => void }) { return <main className="screen funds"><button className="back" onClick={close}>← Back</button><p className="eyebrow">HOW IT WORKS</p><h1>Short, shared price markets.</h1><div className="panel how"><h2>Opening and outcome</h2><p>Each market records its reference price when it opens. At close, a fresh oracle update determines the outcome: higher is YES; flat or lower is NO.</p><h2>Refunds</h2><p>If no newer oracle update is available by close, the market is refunded. This avoids settling on a stale price.</p><h2>Payouts and fees</h2><p>Winning positions receive their stake back plus a proportional share of the losing pool. A 2% commission is taken only from the losing pool and sent to the treasury.</p></div></main>; }

function Positions({ session, close }: { session: Session; close: () => void }) {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { api.getPositions(session).then(result => setPositions(result.positions)).catch(err => setError(err instanceof Error ? err.message : "Positions are unavailable.")).finally(() => setLoading(false)); }, [session]);
  return <main className="screen funds positions-screen"><button className="back" onClick={close}>← Back to feed</button><p className="eyebrow">YOUR ACTIVITY</p><h1>My positions</h1>{loading ? <p className="muted">Loading positions…</p> : error ? <p className="error">{error}</p> : positions.length === 0 ? <p className="muted">Your bets will appear here.</p> : <div className="position-list">{positions.map((position, index) => <article className="position" key={`${position.marketAddress}-${position.side}-${index}`}><div className="position-heading"><b>{position.assetPair} · {timeframe(position.duration)}</b><span className={position.side === "YES" ? "yes" : "no"}>{position.side}</span></div><p>{usdc(position.amount)} USDC staked</p><div className="position-heading"><span className="position-status">{position.status === "awaiting_resolution" ? "Awaiting resolution" : position.status}</span>{position.status === "open" && <span>{clock(position.timeRemaining)} left</span>}</div>{position.transactionHash && <a className="tx-link" href={`https://explorer.arc.io/tx/${position.transactionHash}`} target="_blank" rel="noreferrer">Transaction · {position.transactionHash}</a>}</article>)}</div>}</main>;
}

function Comments({ session, market, close }: { session: Session; market: Market & { address: string }; close: () => void }) {
  const [comments, setComments] = useState<Comment[]>([]); const [text, setText] = useState(""); const [error, setError] = useState("");
  useEffect(() => { api.getComments(session, market.address).then(result => setComments(result.comments)).catch(() => setError("Comments are unavailable.")); }, [market.address, session]);
  async function submit(event: FormEvent) { event.preventDefault(); try { const result = await api.postComment(session, market.address, text); setComments(value => [...value, result.comment]); setText(""); } catch (err) { setError(err instanceof Error ? err.message : "Could not post comment"); } }
  return <div className="sheet-backdrop"><section className="sheet comments"><button className="close" onClick={close}>×</button><p className="eyebrow">MARKET NOTES</p><h2>{market.assetPair}</h2><div className="thread">{comments.length ? comments.map(comment => <div className="comment" key={comment.id}><b>{short(comment.address)}</b><p>{comment.text}</p></div>) : <p className="muted">No notes yet.</p>}</div><form onSubmit={submit}><input maxLength={280} value={text} onChange={event => setText(event.target.value)} placeholder="Add a market note" /><button className="button primary" disabled={!text.trim()}>Post</button></form>{error && <p className="error">{error}</p>}</section></div>;
}

function Funds({ mode, session, balance, close, refresh }: { mode: "deposit" | "withdraw"; session: Session; balance: string; close: () => void; refresh: () => void }) {
  const [value, setValue] = useState(""); const [notice, setNotice] = useState(""); const [walletActions, setWalletActions] = useState<{ to: string; data: string }[]>([]); const [actionIndex, setActionIndex] = useState(0);
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const rawAmount = String(Math.round(Number(value) * 1_000_000));
      if (!Number.isFinite(Number(value)) || Number(value) <= 0) throw new Error("Enter a valid USDC amount.");
      if (mode === "deposit") {
        const result = await api.deposit(session, rawAmount); const actions = result.transactions ?? [];
        if (actions.length) { setWalletActions(actions); setActionIndex(0); } else { setNotice("Transaction submitted."); window.setTimeout(refresh, 2500); }
      } else {
        const result = await api.withdraw(session, rawAmount); const actions = result.transaction ? [result.transaction] : [];
        if (actions.length) { setWalletActions(actions); setActionIndex(0); } else { setNotice("Transaction submitted."); window.setTimeout(refresh, 2500); }
      }
    } catch (error) { setNotice(error instanceof Error ? error.message : "Request failed"); }
  }
  async function signNext() { try { await window.ethereum?.request({ method: "eth_sendTransaction", params: [walletActions[actionIndex]] }); if (actionIndex + 1 < walletActions.length) setActionIndex(value => value + 1); else { setWalletActions([]); setNotice("Transaction submitted."); window.setTimeout(refresh, 2500); } } catch { setNotice("Wallet transaction was not submitted."); } }
  const actionLabel = mode === "deposit" && actionIndex === 0 && walletActions.length > 1 ? "Approve" : mode === "deposit" ? "Deposit" : "Withdraw";
  return <main className="screen funds"><button className="back" onClick={close}>← Back</button><p className="eyebrow">{mode.toUpperCase()}</p><h1>{mode === "deposit" ? "Add USDC" : "Withdraw USDC"}</h1><p className="muted">Vault balance: {usdc(balance)} USDC</p>{mode === "deposit" && <div className="wallet-address"><span>Your Arc wallet</span><code>{session.address}</code><p>Send USDC on Arc here first. ArcTick has no card purchase or fiat on-ramp.</p></div>}<form className="fund-form" onSubmit={submit}><label>Amount (USDC)<input inputMode="decimal" value={value} onChange={event => setValue(event.target.value)} placeholder="0.00" /></label><button className="button primary" disabled={!value}>Continue</button></form>{walletActions.length > 0 && <button className="button primary" onClick={signNext}>{actionLabel} in wallet</button>}{notice && <p className="muted">{notice}</p>}</main>;
}

export function App() {
  const [session, setSession] = useState<Session | undefined>(() => { const raw = localStorage.getItem("arctick-session"); return raw ? JSON.parse(raw) : undefined; });
  const [view, setView] = useState<View>(() => session?.custodial && !localStorage.getItem("arctick-warning") ? "warning" : session ? "feed" : "landing");
  const [markets, setMarkets] = useState<Market[]>([]); const [index, setIndex] = useState(0); const [skippedSlots, setSkippedSlots] = useState<string[]>([]); const [tab, setTab] = useState<"Trading" | "Prediction">("Trading"); const [amount, setAmount] = useState("1"); const [balance, setBalance] = useState("0"); const [detail, setDetail] = useState<Market>(); const [comments, setComments] = useState<(Market & { address: string })>(); const [toast, setToast] = useState(""); const [toastHash, setToastHash] = useState("");
  const marketRequest = useRef<Promise<Market[]> | null>(null);
  const visibleMarkets = useMemo(() => markets.filter(market => tab === "Trading" ? market.duration !== "3600" : market.duration === "3600"), [markets, tab]);
  const current = visibleMarkets[index];
  async function refreshMarketMatrix() {
    if (marketRequest.current) return marketRequest.current;
    const request = api.getMarkets().then(result => {
      // The endpoint returns a finite pair/timeframe matrix. Keep one card per
      // slot, refresh existing card data in place, and append newly introduced
      // slots without replacing the active card (which avoids a feed flash).
      const incoming = uniqueMarketSnapshot(result.markets);
      setMarkets(previous => mergeMarketSnapshot(previous, incoming));
      return incoming;
    }).finally(() => { marketRequest.current = null; });
    marketRequest.current = request;
    return request;
  }
  const refresh = async () => {
    try {
      await refreshMarketMatrix();
    } catch (error) {
      console.error("ArcTick markets refresh failed", error);
      setToast("Live markets are temporarily unavailable");
      window.setTimeout(() => setToast(current => current === "Live markets are temporarily unavailable" ? "" : current), 2200);
    }

    if (session) {
      try {
        const result = await api.getBalance(session);
        setBalance(result.balance);
      } catch (error) {
        console.error("ArcTick balance refresh failed", error);
        setToast("Balance couldn’t be refreshed");
        window.setTimeout(() => setToast(current => current === "Balance couldn’t be refreshed" ? "" : current), 2200);
      }
    }
  };
  useEffect(() => { if (!session || view !== "feed") return; refresh(); const timer = window.setInterval(refresh, 8_000); return () => clearInterval(timer); }, [session, view]);
  useEffect(() => {
    if (!session || view !== "feed" || visibleMarkets.length === 0) return;
    if (index >= Math.max(0, visibleMarkets.length - 5)) void refreshMarketMatrix().catch(error => console.error("ArcTick feed preload failed", error));
  }, [session, view, index, visibleMarkets.length]);
  function setNewSession(next: Session) { localStorage.setItem("arctick-session", JSON.stringify(next)); setSession(next); setView(next.custodial && !localStorage.getItem("arctick-warning") ? "warning" : "feed"); }
  function logout() { localStorage.removeItem("arctick-session"); setSession(undefined); setView("landing"); }
  function advance() { setIndex(value => nextFeedIndex(value, visibleMarkets.length)); }
  function skipCurrent(slotId: string) { setSkippedSlots(previous => rememberSkippedSlot(previous, slotId)); advance(); }
  async function undoSkip() {
    const slotId = skippedSlots[skippedSlots.length - 1];
    if (!slotId) return;
    try {
      // Always re-read before restoring: a virtual slot may have become live
      // (or resolved) while it was in the in-memory undo stack.
      const freshMarkets = await refreshMarketMatrix();
      const freshVisible = freshMarkets.filter(market => tab === "Trading" ? market.duration !== "3600" : market.duration === "3600");
      const restoredIndex = findSlotIndex(freshVisible, slotId);
      if (restoredIndex < 0) throw new Error("That market is no longer available in the feed.");
      setSkippedSlots(previous => previous.slice(0, -1));
      setIndex(restoredIndex);
    } catch (error) {
      console.error("ArcTick skipped-market refresh failed", error);
      setToast("Couldn’t refresh that market to undo the pass.");
      window.setTimeout(() => setToast(current => current === "Couldn’t refresh that market to undo the pass." ? "" : current), 2200);
    }
  }
  async function placeBet(isYes: boolean) { if (!session || !current) return; const target = current; const side = isYes ? "YES" : "NO"; advance(); try { const result = await api.swipe(session, target.slotId, String(Math.round(Number(amount) * 1_000_000)), isYes); setToastHash(result.transactionHash); setToast(result.created ? `✓ Market opened + ${side} submitted` : `✓ ${side} submitted`); refresh(); } catch (error) { setToastHash(""); setToast(error instanceof Error ? error.message : "The bet could not be submitted."); } finally { window.setTimeout(() => { setToast(""); setToastHash(""); }, 4200); } }
  async function favorite() { if (!session || !current?.address) return; try { await api.favorite(session, current.address); setToast("Saved"); window.setTimeout(() => setToast(""), 1600); } catch { setToast("Could not save"); } }
  if (!session || view === "landing") return <Login onSession={setNewSession} />;
  if (view === "warning") return <Warning acknowledge={() => { localStorage.setItem("arctick-warning", "1"); setView("feed"); }} />;
  if (view === "positions") return <Positions session={session} close={() => setView("feed")} />;
  if (view === "deposit" || view === "withdraw") return <Funds mode={view} session={session} balance={balance} close={() => setView("feed")} refresh={refresh} />;
  if (view === "how") return <HowItWorks close={() => setView("feed")} />;
  return <main className="app"><header><div className="brand small">ARC<span>TICK</span></div><div className="header-actions"><button className="info" aria-label="How ArcTick works" onClick={() => setView("how")}>ⓘ</button><button className="positions-button" onClick={() => setView("positions")}>My positions</button><button className="balance" onClick={() => setView("withdraw")}>{usdc(balance)} <small>USDC</small></button><button className="logout" onClick={logout}>Log out</button></div></header><nav><button className={tab === "Trading" ? "active" : ""} onClick={() => { setTab("Trading"); setIndex(0); }}>Trading <small>Runs 5m or 15m after opening</small></button><button className={tab === "Prediction" ? "active" : ""} onClick={() => { setTab("Prediction"); setIndex(0); }}>Prediction <small>Runs 1h after opening</small></button></nav><section className="feed"><AnimatePresence mode="wait">{current ? <MarketCard key={current.slotId} market={current} amount={amount} canUndoSkip={skippedSlots.length > 0} onYes={() => void placeBet(true)} onNo={() => void placeBet(false)} onSkip={() => skipCurrent(current.slotId)} onUndoSkip={() => void undoSkip()} onOpen={() => setDetail(current)} onComments={() => { if (current.address) setComments(current as Market & { address: string }); }} onFavorite={favorite} /> : <div className="empty"><h2>That’s the feed.</h2><p>Fresh markets will appear here shortly. The feed checks again automatically.</p></div>}</AnimatePresence></section><footer><label>Stake<input value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" /> USDC</label><button onClick={() => setView("deposit")}>Deposit</button><span>← NO · <b>YES →</b></span></footer>{detail && <Detail market={detail} close={() => setDetail(undefined)} />}{comments && <Comments session={session} market={comments} close={() => setComments(undefined)} />}{toast && <div className="toast">{toast}{toastHash && toast.startsWith("✓") && <a className="toast-hash" href={`https://explorer.arc.io/tx/${toastHash}`} target="_blank" rel="noreferrer">{toastHash}</a>}</div>}</main>;
}
