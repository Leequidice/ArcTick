import "dotenv/config";
import { randomBytes, randomUUID, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import express from "express";
import { OAuth2Client } from "google-auth-library";
import { SignJWT, jwtVerify } from "jose";
import { createPublicClient, createWalletClient, encodeAbiParameters, encodeFunctionData, fallback, http, isAddress, keccak256, parseUnits, recoverMessageAddress, zeroAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { aggregatorAbi, factoryAbi, marketAbi, usdcAbi, vaultAbi } from "./abi.js";
import { DURATIONS } from "./feeds.js";
import { configuredFeeds } from "./network-feeds.js";
import { evaluateChainStatus, expectedChainId, isNetworkGuardedRequest, type ChainStatus } from "./network-guard.js";
import { isValidInternalSecret } from "./internal-auth.js";
import { consumeWalletNonce, createGoogleUser, getOrCreateConnectedUser, getUserByAddress, getUserByGoogleSub, getUserById, initializeDatabase, pool, setWalletNonce, withOperatorTransactionLock, type User } from "./database.js";

const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
const rpc = required("ARC_RPC_URL");
const vault = required("VAULT_ADDRESS") as Address;
const factory = required("FACTORY_ADDRESS") as Address;
const usdc = (process.env.USDC_ADDRESS ?? "0x3600000000000000000000000000000000000000") as Address;
const operator = privateKeyToAccount(required("API_OPERATOR_PRIVATE_KEY") as `0x${string}`);
const jwtSecret = new TextEncoder().encode(required("JWT_SECRET"));
const masterKey = scryptSync(required("WALLET_MASTER_SECRET"), "arctick-wallet-v1", 32);
required("DATABASE_URL");
const chain = { id: Number(required("ARC_CHAIN_ID")), name: "Arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as const;
const expectedNetworkId = expectedChainId(chain.id);
const feeds = configuredFeeds(chain.id);
// Keep individual requests small for Arc providers. Mainnet falls back to the
// official endpoint if a dedicated provider is temporarily unavailable.
const rpcOptions = { timeout: 20_000, retryCount: 1 };
function rpcHostname() {
  try {
    return new URL(rpc).hostname;
  } catch {
    return "invalid_rpc_url";
  }
}
const publicTransport = Number(process.env.ARC_CHAIN_ID) === 5042 && rpc !== "https://rpc.mainnet.arc.io"
  ? fallback([http(rpc, rpcOptions), http("https://rpc.mainnet.arc.io", rpcOptions)])
  : http(rpc, rpcOptions);
const publicClient = createPublicClient({ chain, transport: publicTransport });
const operatorClient = createWalletClient({ account: operator, chain, transport: http(rpc) });
const google = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
let networkStatusPromise: Promise<ChainStatus> | undefined;
let networkStatusLogged = false;

function getNetworkStatus() {
  if (!networkStatusPromise) {
    networkStatusPromise = publicClient.getChainId()
      .then(actual => evaluateChainStatus(expectedNetworkId, chain.id, actual))
      .catch(() => evaluateChainStatus(expectedNetworkId, chain.id, null));
  }
  return networkStatusPromise;
}

async function logNetworkStatus(status: ChainStatus) {
  if (networkStatusLogged) return;
  networkStatusLogged = true;
  console[status.matchesExpected ? "info" : "error"](JSON.stringify({
    service: "api",
    action: status.matchesExpected ? "network_verified" : "network_mismatch",
    ...status,
    rpcHostname: rpcHostname()
  }));
}

function encrypt(value: string) { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", masterKey, iv); const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64"); }
function decrypt(value: string) { const raw = Buffer.from(value, "base64"), decipher = createDecipheriv("aes-256-gcm", masterKey, raw.subarray(0, 12)); decipher.setAuthTag(raw.subarray(12, 28)); return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"); }
function token(user: User) { return new SignJWT({ address: user.address, mode: user.mode }).setProtectedHeader({ alg: "HS256" }).setSubject(user.id).setExpirationTime("7d").sign(jwtSecret); }
async function auth(req: express.Request, res: express.Response, next: express.NextFunction) { try { const raw = req.header("authorization")?.replace(/^Bearer\s+/i, ""); if (!raw) throw new Error(); const verified = await jwtVerify(raw, jwtSecret); const userId = verified.payload.sub; if (!userId) throw new Error(); const user = await getUserById(userId); if (!user) throw new Error(); res.locals.user = user; next(); } catch { res.status(401).json({ error: "unauthorized" }); } }
export const app = express();
// Apply CORS before body parsing so client-visible error responses retain the
// same headers as successful auth responses.
app.use((_req, res, next) => {
  const webOrigin = process.env.WEB_ORIGIN ?? (process.env.NODE_ENV === "production" ? undefined : "http://localhost:5173");
  if (webOrigin) res.setHeader("Access-Control-Allow-Origin", webOrigin);
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (_req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.json());
app.use(async (req, res, next) => {
  if (!isNetworkGuardedRequest(req.method, req.path)) return next();
  const status = await getNetworkStatus();
  await logNetworkStatus(status);
  if (!status.matchesExpected) return res.status(503).json({ error: "misconfigured_network", ...status });
  next();
});
app.get("/health", async (_req, res) => {
  const status = await getNetworkStatus();
  await logNetworkStatus(status);
  res.json({ status: status.matchesExpected ? "ok" : "misconfigured_network", expectedChainId: status.expectedChainId, actualChainId: status.actualChainId, matchesExpected: status.matchesExpected, rpcHostname: rpcHostname() });
});

// Keeper-to-API channel only. This credential is separate from user JWTs and
// is never returned to a client or included in logs.
// Vercel's current build exposes this catch-all as one path segment, so keep a
// single-segment alias for the scheduled keeper while retaining the local/API
// route used by non-Vercel hosts.
app.post("/settle", async (req, res) => {
  const configuredSecret = process.env.INTERNAL_KEEPER_SECRET;
  const suppliedSecret = req.header("x-keeper-secret");
  if (!configuredSecret) return res.status(503).json({ error: "internal_settlement_unconfigured" });
  if (!isValidInternalSecret(configuredSecret, suppliedSecret)) return res.status(401).json({ error: "internal_unauthorized" });

  try {
    const { market } = z.object({ market: z.string().refine(isAddress) }).parse(req.body);
    const address = market as Address;
    const [marketFactory, marketUsdc, resolved] = await Promise.all([
      publicClient.readContract({ address, abi: marketAbi, functionName: "factory" }),
      publicClient.readContract({ address, abi: marketAbi, functionName: "usdc" }),
      publicClient.readContract({ address, abi: marketAbi, functionName: "resolved" })
    ]);
    if (marketFactory.toLowerCase() !== factory.toLowerCase() || marketUsdc.toLowerCase() !== usdc.toLowerCase()) {
      return res.status(400).json({ error: "unknown_market" });
    }
    if (!resolved) return res.status(409).json({ error: "market_not_resolved" });

    const result = await withOperatorTransactionLock(async () => {
      const [settled, participants] = await Promise.all([
        publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "marketSettled", args: [address] }),
        publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getMarketParticipants", args: [address] })
      ]);
      if (settled) return { status: "already_settled" as const };
      if (participants.length === 0) return { status: "no_positions" as const };
      const hash = await operatorClient.writeContract({ address: vault, abi: vaultAbi, functionName: "operatorSettleMarket", args: [address] });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`vault settlement reverted: ${hash}`);
      return { status: "settled" as const, transactionHash: hash, blockNumber: receipt.blockNumber.toString() };
    });
    res.json({ market: address, ...result });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: "invalid_request", message: "Settlement request is invalid." });
    console.error(JSON.stringify({ service: "api", action: "internal_settlement_failed", error: String(error) }));
    res.status(500).json({ error: "internal_settlement_failed" });
  }
});

type Comment = { id: string; userId: string; address: string; text: string; createdAt: string };
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
  // Each asset has three timeframe slots, but the price is shared. Fetch once
  // per feed rather than issuing the same Chainlink read three times per refresh.
  const uniqueFeeds = [...new Set(slots.map(slot => slot.feed))];
  const roundResults = new Map<Address, Promise<readonly [bigint, bigint, bigint, bigint, bigint]>>();
  await mapConcurrent(uniqueFeeds, 2, async feed => {
    const pendingRound = publicClient.readContract({ address: feed, abi: aggregatorAbi, functionName: "latestRoundData" });
    roundResults.set(feed, pendingRound);
    await pendingRound.catch(() => undefined);
  });
  const values = await mapConcurrent(slots, 3, async slot => {
    const [roundResult, marketResult] = await Promise.allSettled([
      roundResults.get(slot.feed)!,
      openMarketForSlot(slot)
    ]);
    const round = roundResult.status === "fulfilled" ? roundResult.value : undefined;
    const market = marketResult.status === "fulfilled" ? marketResult.value : undefined;
    const feedAvailable = round !== undefined;
    const base = {
      slotId: slot.slotId, assetPair: slot.assetPair, feedAddress: slot.feed,
      duration: String(slot.duration), price: round?.[1].toString() ?? null,
      priceUpdatedAt: round?.[3].toString() ?? null
    };
    const unavailable = (reason: string, kind: "unavailable" | "live" = "unavailable") => ({
      ...base, kind, status: "unavailable" as const, unavailableReason: reason,
      address: market?.address, startTime: market?.startTime.toString(), endTime: market?.endTime.toString(),
      timeRemaining: market ? Math.max(0, Number(market.endTime) - now) : 0,
      yesPool: null, noPool: null, yesParticipants: null, noParticipants: null
    });
    if (!feedAvailable) {
      const error = roundResult.status === "rejected" ? String(roundResult.reason) : "unknown_feed_error";
      console.error(JSON.stringify({ service: "api", action: "market_slot_unavailable", slotId: slot.slotId, feed: slot.feed, reason: "price_feed_unavailable", error }));
      return unavailable("price_feed_unavailable", market ? "live" : "unavailable");
    }
    if (marketResult.status === "rejected") {
      console.error(JSON.stringify({ service: "api", action: "market_slot_unavailable", slotId: slot.slotId, feed: slot.feed, reason: "market_lookup_failed", error: String(marketResult.reason) }));
      return unavailable("market_lookup_failed");
    }
    if (!market) return { ...base, kind: "virtual" as const, status: "available" as const, address: undefined, startTime: undefined, endTime: undefined, timeRemaining: 0, yesPool: "0", noPool: "0", yesParticipants: "0", noParticipants: "0" };
    try {
      const [pools, participants] = await Promise.all([
        publicClient.readContract({ address: market.address, abi: marketAbi, functionName: "getPoolSizes" }),
        publicClient.readContract({ address: market.address, abi: marketAbi, functionName: "getParticipantCounts" })
      ]);
      return { ...base, kind: "live" as const, status: "available" as const, address: market.address, startTime: market.startTime.toString(), endTime: market.endTime.toString(), timeRemaining: Math.max(0, Number(market.endTime) - now), yesPool: pools[0].toString(), noPool: pools[1].toString(), yesParticipants: participants[0].toString(), noParticipants: participants[1].toString() };
    } catch (error) {
      console.error(JSON.stringify({ service: "api", action: "market_slot_unavailable", slotId: slot.slotId, feed: slot.feed, market: market.address, reason: "market_data_unavailable", error: String(error) }));
      return unavailable("market_data_unavailable", "live");
    }
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
  let googleSub: string;
  try {
    const { idToken } = z.object({ idToken: z.string() }).parse(req.body);
    const ticket = await google.verifyIdToken({ idToken, audience: required("GOOGLE_CLIENT_ID") });
    const payload = ticket.getPayload(); if (!payload?.sub) throw new Error("Google token has no subject");
    googleSub = payload.sub;
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: "invalid_request", message: "Google sign-in request is invalid." });
    console.error(JSON.stringify({ service: "api", action: "google_token_verification_failed", error: String(error) }));
    res.status(401).json({ error: "invalid_google_token" });
    return;
  }
  try {
    let user = await getUserByGoogleSub(googleSub);
    if (!user) { const key = generatePrivateKey(); const account = privateKeyToAccount(key); user = await createGoogleUser({ id: randomUUID(), address: account.address, mode: "custodial", encryptedKey: encrypt(key), googleSub }); }
    res.json({ token: await token(user), address: user.address, custodial: true });
  } catch (error) {
    // Keep storage failures distinct from invalid credentials so persistence
    // issues are diagnosable without leaking provider details to the browser.
    console.error(JSON.stringify({ service: "api", action: "google_user_storage_failed", error: String(error) }));
    res.status(503).json({ error: "authentication_storage_unavailable" });
  }
});

app.post("/auth/wallet/nonce", async (req, res) => {
  const { address } = z.object({ address: z.string().refine(isAddress) }).parse(req.body);
  const normalized = address as Address; const current = await getOrCreateConnectedUser(normalized);
  const user = await setWalletNonce(current.id, randomBytes(24).toString("hex"));
  if (!user) return res.status(404).json({ error: "wallet_user_not_found" });
  res.json({ message: `ArcTick wallet authentication nonce: ${user.nonce}` });
});

app.post("/wallet/connect", async (req, res) => {
  try {
    const { address, signature } = z.object({ address: z.string().refine(isAddress), signature: z.string() }).parse(req.body);
    const user = await getUserByAddress(address);
    if (!user?.nonce || user.mode !== "connected") throw new Error("request a nonce first");
    const message = `ArcTick wallet authentication nonce: ${user.nonce}`;
    if ((await recoverMessageAddress({ message, signature: signature as `0x${string}` })).toLowerCase() !== address.toLowerCase()) throw new Error("bad signature");
    const authenticatedUser = await consumeWalletNonce(user.id, user.nonce);
    if (!authenticatedUser) throw new Error("nonce already used; request a fresh one");
    res.json({ token: await token(authenticatedUser), address: authenticatedUser.address, custodial: false });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: "invalid_request", message: "Wallet connection request is invalid." });
    res.status(401).json({ error: "wallet_auth_failed", detail: String(error) });
  }
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
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: "invalid_request", message: "Deposit request is invalid." });
    res.status(400).json({ error: "deposit_failed", detail: String(error) });
  }
});

type SelectedMarket = { market: Address; created: boolean };
const pendingMarketCreations = new Map<string, Promise<SelectedMarket>>();

async function createOrReuseMarket(slot: Slot): Promise<SelectedMarket> {
  const existing = await openMarketForSlot(slot);
  if (existing) return { market: existing.address, created: false };
  try {
    await withOperatorTransactionLock(async () => {
      const submitted = await operatorClient.writeContract({ address: factory, abi: factoryAbi, functionName: "createMarket", args: [slot.assetPair, slot.feed, BigInt(slot.duration)] });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: submitted });
      if (receipt.status !== "success") throw new Error(`market creation reverted: ${submitted}`);
      return submitted;
    });
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
    const hash = await withOperatorTransactionLock(async () => {
      const submitted = await operatorClient.writeContract({ address: vault, abi: vaultAbi, functionName: "operatorPlaceBet", args: [user.address, selected.market, body.isYes, amount] });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: submitted });
      if (receipt.status !== "success") throw new Error(`bet transaction reverted: ${submitted}`);
      return submitted;
    });
    marketCache = undefined;
    res.status(202).json({ transactionHash: hash, marketAddress: selected.market, created: selected.created, status: "submitted" });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: "invalid_request", message: "Swipe request is invalid." });
    res.status(400).json({ error: "swipe_failed", detail: String(error) });
  }
});

app.post("/withdraw", auth, async (req, res) => {
  try { const user: User = res.locals.user; const { amount } = z.object({ amount: z.union([z.string(), z.number()]) }).parse(req.body); const value = typeof amount === "string" ? BigInt(amount) : parseUnits(String(amount), 6); if (user.mode === "connected") return res.status(409).json({ error: "wallet_signature_required", message: "Connected-wallet users must submit Vault.withdraw(amount) from their own wallet.", transaction: { to: vault, functionName: "withdraw", args: [value.toString()] } }); const account = privateKeyToAccount(decrypt(user.encryptedKey! ) as `0x${string}`); const client = createWalletClient({ account, chain, transport: http(rpc) }); const hash = await client.writeContract({ address: vault, abi: vaultAbi, functionName: "withdraw", args: [value] }); res.status(202).json({ transactionHash: hash, status: "submitted" }); } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: "invalid_request", message: "Withdrawal request is invalid." });
    res.status(400).json({ error: "withdraw_failed", detail: String(error) });
  }
});

app.get("/favorites", auth, async (_req, res) => { const user: User = res.locals.user; const result = await pool.query<{ market_address: string }>("SELECT market_address FROM favorites WHERE user_id = $1 ORDER BY created_at DESC", [user.id]); res.json({ markets: result.rows.map(row => row.market_address) }); });
app.post("/markets/:address/favorite", auth, async (req, res) => {
  const user: User = res.locals.user; const address = z.string().refine(isAddress).parse(req.params.address).toLowerCase();
  await pool.query("INSERT INTO favorites (user_id, market_address) VALUES ($1, $2) ON CONFLICT DO NOTHING", [user.id, address]);
  res.status(201).json({ favorited: true, address });
});
app.delete("/markets/:address/favorite", auth, async (req, res) => {
  const user: User = res.locals.user; const address = z.string().refine(isAddress).parse(req.params.address).toLowerCase();
  await pool.query("DELETE FROM favorites WHERE user_id = $1 AND market_address = $2", [user.id, address]);
  res.json({ favorited: false, address });
});
app.get("/markets/:address/comments", auth, async (req, res) => {
  const address = z.string().refine(isAddress).parse(req.params.address).toLowerCase();
  const result = await pool.query<{ id: string; user_id: string; author_address: string; body: string; created_at: Date }>("SELECT id, user_id, author_address, body, created_at FROM comments WHERE market_address = $1 ORDER BY created_at ASC, id ASC", [address]);
  const comments: Comment[] = result.rows.map(row => ({ id: row.id, userId: row.user_id, address: row.author_address, text: row.body, createdAt: row.created_at.toISOString() }));
  res.json({ comments });
});
app.post("/markets/:address/comments", auth, async (req, res) => {
  try {
    const user: User = res.locals.user; const address = z.string().refine(isAddress).parse(req.params.address).toLowerCase(); const text = cleanComment(z.object({ text: z.string().max(280) }).parse(req.body).text);
    if (text.length === 0 || bannedWords.test(text)) return res.status(400).json({ error: "invalid_comment" });
    const comment: Comment = { id: randomUUID(), userId: user.id, address: user.address, text, createdAt: new Date().toISOString() };
    await pool.query("INSERT INTO comments (id, user_id, market_address, author_address, body, created_at) VALUES ($1, $2, $3, $4, $5, $6)", [comment.id, user.id, address, user.address, text, comment.createdAt]);
    res.status(201).json({ comment });
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ error: "invalid_request", message: "Comment request is invalid." });
    res.status(400).json({ error: "comment_failed", detail: String(error) });
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = typeof error === "object" && error !== null && "status" in error ? Number(error.status) : undefined;
  if (error instanceof z.ZodError || (status === 400 && typeof error === "object" && error !== null && "type" in error && error.type === "entity.parse.failed")) {
    return res.status(400).json({ error: "invalid_request", message: "Request body is invalid." });
  }
  console.error(JSON.stringify({ service: "api", action: "unhandled_request_error", error: String(error) }));
  return res.status(500).json({ error: "internal_error" });
});

export async function initializeApi() {
  await initializeDatabase();
  const status = await getNetworkStatus();
  await logNetworkStatus(status);
}

export default app;
