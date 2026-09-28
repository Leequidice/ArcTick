import type { Comment, Market, Session } from "./types";

// Production is co-located on Vercel and always uses same-origin /api routes;
// this intentionally ignores any stale VITE_API_URL left from Kubeletto.
const configuredApiUrl = import.meta.env.DEV ? import.meta.env.VITE_API_URL?.trim() : undefined;
const configuredApiBase = configuredApiUrl ? configuredApiUrl.replace(/\/$/, "") : (import.meta.env.DEV ? "http://localhost:3001" : "");
const apiPath = (path: string) => `${configuredApiUrl ? "" : import.meta.env.DEV ? "" : "/api"}${path}`;
export const apiUrl = configuredApiBase || "/api";
async function request<T>(path: string, init: RequestInit = {}, session?: Session): Promise<T> {
  try {
    const response = await fetch(`${configuredApiBase}${apiPath(path)}`, { ...init, headers: { "content-type": "application/json", ...(session ? { authorization: `Bearer ${session.token}` } : {}), ...init.headers } });
    const body = await response.json(); if (!response.ok) throw new Error(body.message || body.error || "Request failed"); return body;
  } catch (error) {
    console.error("ArcTick API request failed", { path, apiUrl, error });
    throw error;
  }
}
export const getMarkets = () => request<{ markets: Market[] }>("/markets");
export const getBalance = (session: Session) => request<{ address: string; balance: string; decimals: number }>("/balance", {}, session);
export const swipe = (session: Session, slotId: string, amount: string) => request<{ transactionHash: string; marketAddress: string; created: boolean }>("/swipe", { method: "POST", body: JSON.stringify({ slotId, isYes: true, amount }) }, session);
export const deposit = (session: Session, amount: string) => request<{ transactionHash?: string; transactions?: { to: string; data: string }[] }>("/deposit", { method: "POST", body: JSON.stringify({ amount }) }, session);
export const withdraw = (session: Session, amount: string) => request<{ transactionHash?: string; transaction?: { to: string; data: string } }>("/withdraw", { method: "POST", body: JSON.stringify({ amount }) }, session);
export const getComments = (session: Session, address: string) => request<{ comments: Comment[] }>(`/markets/${address}/comments`, {}, session);
export const postComment = (session: Session, address: string, text: string) => request<{ comment: Comment }>(`/markets/${address}/comments`, { method: "POST", body: JSON.stringify({ text }) }, session);
export const favorite = (session: Session, address: string) => request(`/markets/${address}/favorite`, { method: "POST" }, session);
export const getFavorites = (session: Session) => request<{ markets: string[] }>("/favorites", {}, session);
export const walletNonce = (address: string) => request<{ message: string }>("/auth/wallet/nonce", { method: "POST", body: JSON.stringify({ address }) });
export const walletConnect = (address: string, signature: string) => request<Session>("/wallet/connect", { method: "POST", body: JSON.stringify({ address, signature }) });
export const googleAuth = (idToken: string) => request<Session>("/auth/google", { method: "POST", body: JSON.stringify({ idToken }) });
