import "dotenv/config";
import { mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createPublicClient, createWalletClient, fallback, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { factoryAbi, marketAbi, vaultAbi } from "./abi.js";

const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
const rpc = required("ARC_RPC_URL");
const chainId = Number(required("ARC_CHAIN_ID"));
const factory = required("FACTORY_ADDRESS") as Address;
const vault = required("VAULT_ADDRESS") as Address;
const account = privateKeyToAccount(required("KEEPER_PRIVATE_KEY") as `0x${string}`);
const chain = { id: chainId, name: "Arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as const;
const transportOptions = { timeout: 20_000, retryCount: 1 } as const;
const transports = [http(rpc, transportOptions)];
// A public fallback is used only for Arc mainnet and only after the configured
// provider times out. Production should still supply a dedicated primary RPC.
if (chainId === 5042 && rpc !== "https://rpc.mainnet.arc.io") transports.push(http("https://rpc.mainnet.arc.io", transportOptions));
const transport = transports.length === 1 ? transports[0] : fallback(transports);
const publicClient = createPublicClient({ chain, transport });
const walletClient = createWalletClient({ account, chain, transport });
const log = (action: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: "keeper", action, ...fields }));

const pidFile = resolve(process.env.KEEPER_PID_FILE ?? "run/keeper.pid");
function isPidLive(pid: number) {
  try { process.kill(pid, 0); return true; }
  catch (error: unknown) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function acquirePidLock() {
  mkdirSync(dirname(pidFile), { recursive: true });
  try {
    const fd = openSync(pidFile, "wx", 0o600);
    writeFileSync(fd, `${process.pid}\n`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const previousPid = Number.parseInt(readFileSync(pidFile, "utf8").trim(), 10);
    if (Number.isInteger(previousPid) && previousPid > 0 && isPidLive(previousPid)) {
      throw new Error(`Another keeper is already running with PID ${previousPid}; refusing to start.`);
    }
    unlinkSync(pidFile);
    return acquirePidLock();
  }
}
function releasePidLock() {
  try {
    if (readFileSync(pidFile, "utf8").trim() === String(process.pid)) unlinkSync(pidFile);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

acquirePidLock();
log("keeper_starting", { pid: process.pid, pidFile });

const shutdownGraceMs = Number(process.env.KEEPER_SHUTDOWN_GRACE_MS ?? "30000");

async function send(request: Parameters<typeof walletClient.writeContract>[0], action: string) {
  const hash = await walletClient.writeContract(request as never);
  // Arc has deterministic finality, so one receipt makes the next scan safe.
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${action} transaction reverted: ${hash}`);
  log(action, { hash, blockNumber: receipt.blockNumber.toString() });
  return hash;
}

async function tick() {
  // Creation is deliberately absent: /swipe creates a slot only when a user
  // demands it. The keeper is restricted to resolution and Vault settlement.
  const managedMarkets = (process.env.KEEPER_MANAGED_MARKETS ?? "").split(",").map(value => value.trim()).filter(Boolean) as Address[];
  const count = managedMarkets.length === 0
    ? await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "marketCount" })
    : 0n;
  const markets = managedMarkets.length === 0
    ? await Promise.all(Array.from({ length: Number(count) }, (_, i) => publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "markets", args: [BigInt(i)] })))
    : managedMarkets;
  const now = BigInt(Math.floor(Date.now() / 1000));

  for (const market of markets) {
    const [endTime, resolved] = await Promise.all([
      publicClient.readContract({ address: market, abi: marketAbi, functionName: "endTime" }),
      publicClient.readContract({ address: market, abi: marketAbi, functionName: "resolved" })
    ]);
    if (!resolved && endTime <= now) await send({ address: market, abi: marketAbi, functionName: "resolve" }, "market_resolved");
    if (resolved) {
      const [users, settled] = await Promise.all([
        publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "getMarketParticipants", args: [market] }),
        publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "marketSettled", args: [market] })
      ]);
      if (users.length && !settled) await send({ address: vault, abi: vaultAbi, functionName: "operatorSettleMarket", args: [market] }, "market_settled");
    }
  }

}

const interval = Number(process.env.KEEPER_POLL_MS ?? 15_000);
let tickRunning = false;
let stopping = false;
async function runTick() {
  if (stopping) return;
  if (tickRunning) {
    log("tick_skipped", { reason: "previous_tick_still_running" });
    return;
  }
  tickRunning = true;
  try { await tick(); }
  catch (error) { log("tick_failed", { error: String(error) }); }
  finally { tickRunning = false; }
}
let activeTick: Promise<void> | undefined;
function scheduleTick() {
  if (tickRunning) {
    log("tick_skipped", { reason: "previous_tick_still_running" });
    return;
  }
  activeTick = runTick().finally(() => { activeTick = undefined; });
}
scheduleTick();
const timer = setInterval(scheduleTick, interval);

async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  log("keeper_stopping", { pid: process.pid, signal });
  if (activeTick) {
    const completed = await Promise.race([
      activeTick.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), shutdownGraceMs))
    ]);
    if (!completed) log("keeper_shutdown_timeout", { pid: process.pid, graceMs: shutdownGraceMs });
  }
  releasePidLock();
  log("keeper_stopped", { pid: process.pid });
  process.exit(0);
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
