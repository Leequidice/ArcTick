import "dotenv/config";
import { randomBytes, randomUUID, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import express from "express";
import { OAuth2Client } from "google-auth-library";
import { SignJWT, jwtVerify } from "jose";
import { createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, fallback, http, isAddress, keccak256, parseUnits, recoverMessageAddress, zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { aggregatorAbi, factoryAbi, marketAbi, usdcAbi, vaultAbi } from "./abi.js";
import { DURATIONS } from "./feeds.js";
import { configuredFeeds } from "./network-feeds.js";

const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
const rpc = required("ARC_RPC_URL");
const vault = required("VAULT_ADDRESS") as Address;
const factory = required("FACTORY_ADDRESS") as Address;
const usdc = (process.env.USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000") as Address;
const operator = privateKeyToAccount(required("KEEPER_PRIVATE_KEY") as `0x${string}`);
const jwtSecret = new TextEncoder().encode(required("JWT_SECRET"));
const masterKey = scryptSync(required("WALLET_MASTER_SECRET"), "arctick-wallet-v1", 32);
const usersPath = process.env.USERS_DB_PATH ?? "data/users.json";
mkdirSync(dirname(usersPath), { recursive: true });
const chain = { id: Number(required("ARC_CHAIN_ID")), name: "Arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as const;
const feeds = configuredFeeds(chain.id);
// Keep individual requests small for Arc providers. Mainnet falls back to the
// official endpoint if a dedicated provider is temporarily unavailable.
const rpcOptions = { timeout: 20_000, retryCount: 1 };
const publicTransport = Number(process.env.ARC_CHAIN_ID) === 5042 && rpc !== "https://rpc.mainnet.arc.io"
  ? fallback([http(rpc, rpcOptions), http("https://rpc.mainnet.arc.io", rpcOptions)])
  : http(rpc, rpcOptions);
const publicClient = createPublicClient({ chain, transport: publicTransport });
const operatorClient = createWalletClient({ account: operator, chain, transport: http(rpc) });
const google = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

type User = { id: string; address: Address; mode: "custodial" | "connected"; encryptedKey?: string; googleSub?: string; nonce?: string };
let users: User[] = existsSync(usersPath) ? JSON.parse(readFileSync(usersPath, "utf8")) : [];
function save() { writeFileSync(usersPath, JSON.stringify(users, null, 2), { mode: 0o600 }); }
function encrypt(value: string) { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", masterKey, iv); const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64"); }
function decrypt(value: string) { const raw = Buffer.from(value, "base64"), decipher = createDecipheriv("aes-256-gcm", masterKey, raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"); }
function token(user: User) { return new SignJWT({ address: user.address, mode: user.mode }).setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setExpirationTime("7d").sign(jwtSecret); }
async function auth(req: express.Request, res: express.Response, next: express.NextFunction) { try { const raw = req.header("authorization")?.replace(/^Bearer\s+/i, ""); if (!raw) throw new Error(); const verified = await jwtVerify(raw, jwtSecret); const user = users.find(candidate => candidate.id === verified.payload.sub); if (!user) throw new Error(); res.locals.user = user; next(); } catch { res.status(401).json({ error: "unauthorized" }); } }
const app = express();
// Apply CORS before body parsing so client-visible error responses retain the
// same headers as successful auth responses.
app.use((_req, res, next) => { res.setHeader("Access-Control-Allow-Origin", process.env.WEB_ORIGIN ?? "http://localhost:5173"); res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type"); res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS"); if (_req.method === "OPTIONS") return res.sendStatus(204); next(); });
app.use(express.json());
app.get("/health", (_req, res) => res.json({ status: "ok" }));

type Comment = { id: string; userId: string; address: string; text: string; createdAt: string };
type Community = { favorites: Record<string, string[]>; comments: Record<string, Comment[]> };
const communityPath = process.env.COMMUNITY_DB_PATH ?? "data/community.json";
let community: Community = existsSync(communityPath) ? JSON.parse(readFileSync(communityPath, "utf8")) : { favorites: {}, comments: {} };
function saveCommunity() { writeFileSync(communityPath, JSON.stringify(community, null, 2), { mode: 0o600 }); }
const marketCacheTtlMs = Number(process.env.MARKETS_CACHE_TTL_MS ?? 4_000);
let marketCache: { expiresAt: number; value: unknown } | undefined;
let marketCachePending: Promise<unknown> | undefined;
const amount = (value: string | number) => typeof value === "string" ? BigInt(value) : parseUnits(String(value), 6);
const cleanComment = (text: string) => text.trim().replace(/\s+/g, " ");
const bannedWords = /\b(fuck|shit|bitch|cunt|nigger|faggot)\b/i;

async function mapConcurrent<T, U>(values: T[], limit: number, work: (value: T) => Promise<U>) {
  const output = new Array<U>(values.length); let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) { const index = cursor++; output[index] = await work(values[index]); }
  }));
  return output;
}

type Slot = { slotId: string; symbol: string; feed: Address; duration: number; assetPair: string };
const slots: Slot[] = Object.entries(feeds).flatMap(([symbol, feed]) => DURATIONS.map(duration => ({ slotId: `${symbol}-${duration}`, symbol, feed: feed as Address, duration, assetPair: `${symbol}/USD ${duration}s` })));
const slotById = new Map(slots.map(slot => [slot.slotId, slot]));
const slotKey = (slot: Slot) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [slot.feed, BigInt(slot.duration)]));

async function openMarketForSlot(slot: Slot) {
  const address = await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "latestMarketByFeedAndDuration", args: [slotKey(slot)] });
  if (address === zeroAddress) return undefined;
  const [startTime, endTime, resolved] = await Promise.all([
    publicClient.readContract({ address, abi: marketAbi, functionName: "startTime" }),
    publicClient.readContract({ address, abi: marketAbi, functionName: "endTime" }),
    publicClient.readContract({ address, abi: marketAbi, functionName: "resolved" })
  ]);
  return !resolved && endTime > BigInt(Math.floor(Date.now() / 1000)) ? { address, startTime, endTime } : undefined;
}

async function loadOpenMarkets() {
  const now = Math.floor(Date.now() / 1000);
  const values = await mapConcurrent(slots, 3, async slot => {
    const [round, market] = await Promise.all([
      publicClient.readContract({ address: slot.feed, abi: aggregatorAbi, functionName: "latestRoundData" }),
      openMarketForSlot(slot)
    ]);
    const base = { slotId: slot.slotId, assetPair: slot.assetPair, feedAddress: slot.feed, duration: String(slot.duration), price: round[1].toString(), priceUpdatedAt: round[3].toString() };
    if (!market) return { ...base, kind: "virtual" as const, address: undefined, startTime: undefined, endTime: undefined, timeRemaining: 0, yesPool: "0", noPool: "0", yesParticipants: "0", noParticipants: "0" };
    const [pools, participants] = await Promise.all([
      publicClient.readContract({ address: market.address, abi: marketAbi, functionName: "getPoolSizes" }),
      publicClient.readContract({ address: market.address, abi: marketAbi, functionName: "getParticipantCounts" })
    ]);
    return { ...base, kind: "live" as const, address: market.address, startTime: market.startTime.toString(), endTime: market.endTime.toString(), timeRemaining: Math.max(0, Number(market.endTime) - now), yesPool: pools[0].toString(), noPool: pools[1].toString(), yesParticipants: participants[0].toString(), noParticipants: participants[1].toString() };
  });
  const value = { markets: values, cachedAt: new Date().toISOString() };
  marketCache = { value, expiresAt: Date.now() + marketCacheTtlMs };
  return value;
}
async function openMarkets() {
  if (marketCache && marketCache.expiresAt > Date.now()) return marketCache.value;
  if (!marketCachePending) marketCachePending = loadOpenMarkets().finally(() => { marketCachePending = undefined; });
  return marketCachePending;
}

app.post("/auth/google", async (req, res) => {
  try {
    const { idToken } = z.object({ idToken: z.string() }).parse(req.body);
    const ticket = await google.verifyIdToken({ idToken, audience: required("GOOGLE_CLIENT_ID") });
    const payload = ticket.getPayload(); if (!payload?.sub) throw new Error("Google token has no subject");
    let user = users.find(candidate => candidate.googleSub === payload.sub);
    if (!user) { const key = generatePrivateKey(); const account = privateKeyToAccount(key); user = { id: randomUUID(), address: account.address, mode: "custodial", encryptedKey: encrypt(key), googleSub: payload.sub }; users.push(user); save(); }
    res.json({ token: await token(user), address: user.address, custodial: true });
  } catch (error) {
    // Keep provider diagnostics in the server log; token-validation details do
    // not belong in a browser response.
    console.error(JSON.stringify({ service: "api", action: "google_token_verification_failed", error: String(error) }));
    res.status(401).json({ error: "invalid_google_token" });
  }
});

app.post("/auth/wallet/nonce", (req, res) => {
  const { address } = z.object({ address: z.string().refine(isAddress) }).parse(req.body);
  const normalized = address as Address; let user = users.find(candidate => candidate.address.toLowerCase() === normalized.toLowerCase());
  if (!user) { user = { id: randomUUID(), address: normalized, mode: "connected" }; users.push(user); }
  user.nonce = randomBytes(24).toString("hex"); save();
  res.json({ message: `ArcTick wallet authentication nonce: ${user.nonce}` });
});

app.post("/wallet/connect", async (req, res) => {
  try {
    const { address, signature } = z.object({ address: z.string().refine(isAddress), signature: z.string() }).parse(req.body);
    const user = users.find(candidate => candidate.address.toLowerCase() === address.toLowerCase());
    if (!user?.nonce || user.mode !== "connected") throw new Error("request a nonce first");
    const message = `ArcTick wallet authentication nonce: ${user.nonce}`;
    if ((await recoverMessageAddress({ message, signature: signature as `0x${string}` })).toLowerCase() !== address.toLowerCase()) throw new Error("bad signature");
    delete user.nonce; save(); res.json({ token: await token(user), address: user.address, custodial: false });
  } catch (error) { res.status(401).json({ error: "wallet_auth_failed", detail: String(error) }); }
});

app.get("/balance", auth, async (_req, res) => { const user: User = res.locals.user; const balance = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "balances", args: [user.address] }); res.json({ address: user.address, balance: balance.toString(), decimals: 6 }); });
app.get("/markets", async (_req, res) => { try { res.json(await openMarkets()); } catch (error) { res.status(503).json({ error: "markets_unavailable", detail: String(error) }); } });

app.post("/deposit", auth, async (req, res) => {
  try {
    const user: User = res.locals.user; const value = amount(z.object({ amount: z.union([z.string(), z.number()]) }).parse(req.body).amount);
    if (user.mode === "connected") return res.status(409).json({ error: "wallet_signature_required", message: "Approve and deposit from your connected wallet.", transactions: [
      { to: usdc, data: encodeFunctionData({ abi: usdcAbi, functionName: "approve", args: [vault, value] }) },
      { to: vault, data: encodeFunctionData({ abi: vaultAbi, functionName: "deposit", args: [value] }) }
    ] });
    const account = privateKeyToAccount(decrypt(user.encryptedKey!) as `0x${string}`);
    const client = createWalletClient({ account, chain, transport: http(rpc) });
    const approvalHash = await client.writeContract({ address: usdc, abi: usdcAbi, functionName: "approve", args: [vault, value] });
    await publicClient.waitForTransactionReceipt({ hash: approvalHash });
    const transactionHash = await client.writeContract({ address: vault, abi: vaultAbi, functionName: "deposit", args: [value] });
    res.status(202).json({ approvalHash, transactionHash, status: "submitted" });
  } catch (error) { res.status(400).json({ error: "deposit_failed", detail: String(error) }); }
});

type SelectedMarket = { market: Address; created: boolean };
const pendingMarketCreations = new Map<string, Promise<SelectedMarket>>();

async function createOrReuseMarket(slot: Slot): Promise<SelectedMarket> {
  const existing = await openMarketForSlot(slot);
  if (existing) return { market: existing.address, created: false };
  try {
    const hash = await operatorClient.writeContract({ address: factory, abi: factoryAbi, functionName: "createMarket", args: [slot.assetPair, slot.feed, BigInt(slot.duration)] });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`market creation reverted: ${hash}`);
  } catch (creationError) {
    // The duplicate guard is the expected race path: another swipe may have
    // created the same slot after our initial read. Only recover if a live
    // factory market can now be read; surface every other creation failure.
    const raced = await openMarketForSlot(slot);
    if (!raced) throw creationError;
    return { market: raced.address, created: false };
  }
  const created = await openMarketForSlot(slot);
  if (!created) throw new Error("created market was not open after confirmation");
  marketCache = undefined;
  return { market: created.address, created: true };
}

async function marketForSwipe(slot: Slot): Promise<SelectedMarket> {
  const existing = await openMarketForSlot(slot);
  if (existing) return { market: existing.address, created: false };
  const pending = pendingMarketCreations.get(slot.slotId);
  if (pending) return pending;
  const creation = createOrReuseMarket(slot);
  pendingMarketCreations.set(slot.slotId, creation);
  try { return await creation; }
  finally { pendingMarketCreations.delete(slot.slotId); }
}

app.post("/swipe", auth, async (req, res) => {
  try {
    const user: User = res.locals.user;
    const body = z.object({ slotId: z.string(), isYes: z.boolean(), amount: z.union([z.string(), z.number()]) }).parse(req.body);
    const slot = slotById.get(body.slotId); if (!slot) return res.status(400).json({ error: "unknown_market_slot" });
    const amount = typeof body.amount === "string" ? BigInt(body.amount) : parseUnits(String(body.amount), 6);
    const selected = await marketForSwipe(slot);
    const hash = await operatorClient.writeContract({ address: vault, abi: vaultAbi, functionName: "operatorPlaceBet", args: [user.address, selected.market, body.isYes, amount] });
    marketCache = undefined;
    res.status(202).json({ transactionHash: hash, marketAddress: selected.market, created: selected.created, status: "submitted" });
  } catch (error) { res.status(400).json({ error: "swipe_failed", detail: String(error) }); }
});

app.post("/withdraw", auth, async (req, res) => {
  try { const user: User = res.locals.user; const { amount } = z.object({ amount: z.union([z.string(), z.number()]) }).parse(req.body); const value = typeof amount === "string" ? BigInt(amount) : parseUnits(String(amount), 6); if (user.mode === "connected") return res.status(409).json({ error: "wallet_signature_required", message: "Connected-wallet users must submit Vault.withdraw(amount) from their own wallet.", transaction: { to: vault, functionName: "withdraw", args: [value.toString()] } }); const account = privateKeyToAccount(decrypt(user.encryptedKey! ) as `0x${string}`); const client = createWalletClient({ account, chain, transport: http(rpc) }); const hash = await client.writeContract({ address: vault, abi: vaultAbi, functionName: "withdraw", args: [value] }); res.status(202).json({ transactionHash: hash, status: "submitted" }); } catch (error) { res.status(400).json({ error: "withdraw_failed", detail: String(error) }); }
});

app.get("/favorites", auth, (_req, res) => { const user: User = res.locals.user; res.json({ markets: community.favorites[user.id] ?? [] }); });
app.post("/markets/:address/favorite", auth, (req, res) => {
  const user: User = res.locals.user; const address = z.string().refine(isAddress).parse(req.params.address).toLowerCase(); const saved = new Set(community.favorites[user.id] ?? []); saved.add(address); community.favorites[user.id] = [...saved]; saveCommunity(); res.status(201).json({ favorited: true, address });
});
app.delete("/markets/:address/favorite", auth, (req, res) => {
  const user: User = res.locals.user; const address = z.string().refine(isAddress).parse(req.params.address).toLowerCase(); community.favorites[user.id] = (community.favorites[user.id] ?? []).filter(item => item !== address); saveCommunity(); res.json({ favorited: false, address });
});
app.get("/markets/:address/comments", auth, (req, res) => { const address = z.string().refine(isAddress).parse(req.params.address).toLowerCase(); res.json({ comments: community.comments[address] ?? [] }); });
app.post("/markets/:address/comments", auth, (req, res) => {
  try { const user: User = res.locals.user; const address = z.string().refine(isAddress).parse(req.params.address).toLowerCase(); const text = cleanComment(z.object({ text: z.string().max(280) }).parse(req.body).text); if (text.length === 0 || bannedWords.test(text)) return res.status(400).json({ error: "invalid_comment" }); const comment: Comment = { id: randomUUID(), userId: user.id, address: user.address, text, createdAt: new Date().toISOString() }; (community.comments[address] ??= []).push(comment); saveCommunity(); res.status(201).json({ comment }); } catch (error) { res.status(400).json({ error: "comment_failed", detail: String(error) }); }
});

app.listen(Number(process.env.API_PORT ?? 3000), () => console.log(JSON.stringify({ service: "api", action: "listening", port: Number(process.env.API_PORT ?? 3000) })));
