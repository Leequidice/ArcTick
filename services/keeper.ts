import "dotenv/config";
import { mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createPublicClient, createWalletClient, fallback, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { factoryAbi, marketAbi, vaultAbi } from "./abi.js";
import { evaluateChainStatus, expectedChainId } from "./network-guard.js";

const required = (name: string) => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
const rpc = required("ARC_RPC_URL");
const chainId = Number(required("ARC_CHAIN_ID"));
const factory = required("FACTORY_ADDRESS") as Address;
const vault = required("VAULT_ADDRESS") as Address;
const dryRun = process.env.KEEPER_DRY_RUN === "true";
const marketListTimeoutMs = Number(process.env.KEEPER_MARKET_LIST_TIMEOUT_MS ?? "60000");
const settlementUrl = dryRun ? process.env.SETTLEMENT_API_URL : required("SETTLEMENT_API_URL");
const settlementSecret = dryRun ? process.env.INTERNAL_KEEPER_SECRET : required("INTERNAL_KEEPER_SECRET");
const account = dryRun ? undefined : privateKeyToAccount(required("KEEPER_PRIVATE_KEY") as `0x${string}`);
const expectedNetworkId = expectedChainId(chainId);
const chain = { id: chainId, name: "Arc", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as const;
const transportOptions = { timeout: 20_000, retryCount: 1 } as const;
const transports = [http(rpc, transportOptions)];
// A public fallback is used only for Arc mainnet and only after the configured
// provider times out. Production should still supply a dedicated primary RPC.
if (chainId === 5042 && rpc !== "https://rpc.mainnet.arc.io") transports.push(http("https://rpc.mainnet.arc.io", transportOptions));
const transport = transports.length === 1 ? transports[0] : fallback(transports);
const publicClient = createPublicClient({ chain, transport });
const walletClient = account ? createWalletClient({ account, chain, transport }) : undefined;
const multicall3Address = "0xca11bde05977b3631167028862be2a173976ca11" as Address;
type BatchOutcome<T> = { status: "success"; result: T } | { status: "failure"; error: Error };
const log = (action: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ timestamp: new Date().toISOString(), service: "keeper", action, ...fields }));

async function verifyConfiguredNetwork() {
  let actualChainId: number | null = null;
  try { actualChainId = await publicClient.getChainId(); }
  catch (error) {
    const status = evaluateChainStatus(expectedNetworkId, chainId, null);
    log("network_mismatch", { ...status, reason: String(error) });
    throw new Error(`misconfigured_network: expected chain ${expectedNetworkId}, but the configured RPC chain ID could not be read`);
  }
  const status = evaluateChainStatus(expectedNetworkId, chainId, actualChainId);
  if (!status.matchesExpected) {
    log("network_mismatch", status);
    throw new Error(`misconfigured_network: expected chain ${expectedNetworkId}, configured ${chainId}, RPC reports ${actualChainId}`);
  }
  // Fail closed if Arc's canonical Multicall3 deployment is unavailable. The
  // keeper relies on it to scan the factory without issuing one RPC request
  // per market.
  const multicallCode = await publicClient.getBytecode({ address: multicall3Address });
  if (!multicallCode || multicallCode === "0x") {
    throw new Error(`multicall_unavailable: no bytecode at ${multicall3Address} on chain ${actualChainId}`);
  }
  log("multicall_verified", { address: multicall3Address, bytecodeBytes: (multicallCode.length - 2) / 2 });
  log("network_verified", status);
}

// Validate the RPC and configured chain before acquiring the keeper lock or
// entering any resolve/settle code. A mismatch exits this process non-zero.
try { await verifyConfiguredNetwork(); }
catch (error) {
  log("keeper_network_check_failed", { error: String(error) });
  process.exitCode = 1;
  throw error;
}

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

async function send(request: Parameters<NonNullable<typeof walletClient>["writeContract"]>[0], action: string) {
  if (!walletClient) throw new Error("Transaction signer is unavailable in dry-run mode");
  const hash = await walletClient.writeContract(request as never);
  // Arc has deterministic finality, so one receipt makes the next scan safe.
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${action} transaction reverted: ${hash}`);
  log(action, { hash, blockNumber: receipt.blockNumber.toString() });
  return hash;
}

async function requestSettlement(market: Address) {
  if (!settlementUrl || !settlementSecret) throw new Error("Missing SETTLEMENT_API_URL or INTERNAL_KEEPER_SECRET");
  const response = await fetch(settlementUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-keeper-secret": settlementSecret },
    body: JSON.stringify({ market })
  });
  const body = await response.json() as { status?: string; transactionHash?: string; error?: string };
  if (!response.ok) throw new Error(`settlement API returned ${response.status}: ${body.error ?? "unknown error"}`);
  log("market_settlement_checked", { market, status: body.status, transactionHash: body.transactionHash });
}

async function loadMarkets(): Promise<Address[]> {
  const managedMarkets = (process.env.KEEPER_MANAGED_MARKETS ?? "").split(",").map(value => value.trim()).filter(Boolean) as Address[];
  if (managedMarkets.length > 0) return managedMarkets;

  const load = async () => {
    const count = await publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "marketCount" });
    const total = Number(count);
    const addresses: Address[] = [];
    // A bounded number of Multicall3 eth_call round-trips replaces N parallel
    // direct RPC requests. Sequential chunks keep response sizes predictable
    // for providers with conservative request limits.
    const batchSize = 40;
    for (let offset = 0; offset < total; offset += batchSize) {
      const size = Math.min(batchSize, total - offset);
      const contracts = Array.from({ length: size }, (_, index) => ({
        address: factory,
        abi: factoryAbi,
        functionName: "markets" as const,
        args: [BigInt(offset + index)] as const
      }));
      const results = await publicClient.multicall({
        contracts,
        allowFailure: true,
        multicallAddress: multicall3Address
      }) as unknown as BatchOutcome<unknown>[];
      const failedIndex = results.findIndex(result => result?.status !== "success");
      if (failedIndex >= 0) {
        const result = results[failedIndex];
        throw new Error(`market_list_batch_failed at index ${offset + failedIndex}: ${result?.status === "failure" ? String(result.error) : "missing_multicall_result"}`);
      }
      for (const result of results) {
        if (result.status !== "success") throw new Error(`market_list_batch_failed at index ${offset}: ${String(result.error)}`);
        addresses.push(result.result as Address);
      }
      log("market_list_batch_loaded", { offset, batchSize: size, loaded: addresses.length, total });
    }
    return addresses;
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      load(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`market_list_load_timeout after ${marketListTimeoutMs}ms`)), marketListTimeoutMs);
        timeout.unref?.();
      })
    ]);
  } catch (error) {
    log("market_list_load_failed", { error: String(error), timeoutMs: marketListTimeoutMs });
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function tick() {
  log("keeper_scan_started", { mode: dryRun ? "dry_run" : "live" });
  // Creation is deliberately absent: /swipe creates a slot only when a user
  // demands it. The keeper resolves permissionlessly, then requests settlement
  // from the API's sole Vault operator using a separate service credential.
  const markets = await loadMarkets();
  log("keeper_markets_loaded", { marketCount: markets.length });
  const now = BigInt(Math.floor(Date.now() / 1000));
  let wouldResolveCount = 0;
  let wouldSettleCount = 0;
  const wouldResolveMarkets: Address[] = [];
  const wouldSettleMarkets: { market: Address; participantCount: number }[] = [];
  const marketsNeedingSettlement: Address[] = [];
  const batchSize = 25;
  for (let offset = 0; offset < markets.length; offset += batchSize) {
    const batch = markets.slice(offset, offset + batchSize);
    const calls = batch.flatMap(address => [
      { address, abi: marketAbi, functionName: "endTime" as const },
      { address, abi: marketAbi, functionName: "resolved" as const }
    ]);
    let results: BatchOutcome<unknown>[];
    try {
      results = await publicClient.multicall({ contracts: calls, allowFailure: true, multicallAddress: multicall3Address }) as unknown as BatchOutcome<unknown>[];
    } catch (error) {
      log("market_status_batch_failed", { offset, batchSize: batch.length, error: String(error) });
      throw error;
    }
    for (let index = 0; index < batch.length; index++) {
      const market = batch[index];
      const endTimeResult = results[index * 2];
      const resolvedResult = results[index * 2 + 1];
      if (endTimeResult?.status !== "success" || resolvedResult?.status !== "success") {
        const failed = endTimeResult?.status === "failure" ? endTimeResult.error : resolvedResult?.status === "failure" ? resolvedResult.error : "missing_multicall_result";
        log("market_status_read_failed", { market, error: String(failed) });
        continue;
      }
      const endTime = endTimeResult.result as bigint;
      const resolved = resolvedResult.result as boolean;
      const shouldResolve = !resolved && endTime <= now;
      if (shouldResolve) {
        if (dryRun) {
          wouldResolveCount++;
          wouldResolveMarkets.push(market);
          log("would_resolve", { market, endTime: endTime.toString() });
        } else await send({ address: market, abi: marketAbi, functionName: "resolve" }, "market_resolved");
      }
      if (resolved || endTime <= now) marketsNeedingSettlement.push(market);
    }
  }

  for (let offset = 0; offset < marketsNeedingSettlement.length; offset += batchSize) {
    const batch = marketsNeedingSettlement.slice(offset, offset + batchSize);
    const calls = batch.flatMap(address => [
      { address: vault, abi: vaultAbi, functionName: "getMarketParticipants" as const, args: [address] as const },
      { address: vault, abi: vaultAbi, functionName: "marketSettled" as const, args: [address] as const }
    ]);
    let results: BatchOutcome<unknown>[];
    try {
      results = await publicClient.multicall({ contracts: calls, allowFailure: true, multicallAddress: multicall3Address }) as unknown as BatchOutcome<unknown>[];
    } catch (error) {
      log("vault_status_batch_failed", { offset, batchSize: batch.length, error: String(error) });
      throw error;
    }
    for (let index = 0; index < batch.length; index++) {
      const market = batch[index];
      const usersResult = results[index * 2];
      const settledResult = results[index * 2 + 1];
      if (usersResult?.status !== "success" || settledResult?.status !== "success") {
        const failed = usersResult?.status === "failure" ? usersResult.error : settledResult?.status === "failure" ? settledResult.error : "missing_multicall_result";
        log("vault_status_read_failed", { market, error: String(failed) });
        continue;
      }
      const users = usersResult.result as Address[];
      const settled = settledResult.result as boolean;
      if (users.length && !settled) {
        if (dryRun) {
          wouldSettleCount++;
          wouldSettleMarkets.push({ market, participantCount: users.length });
          log("would_settle", { market, participantCount: users.length });
        } else await requestSettlement(market);
      }
    }
  }
  log("keeper_scan_complete", {
    mode: dryRun ? "dry_run" : "live",
    marketCount: markets.length,
    wouldResolveCount,
    wouldResolveMarkets,
    wouldSettleCount,
    wouldSettleMarkets
  });
}

if (process.env.KEEPER_RUN_ONCE === "true") {
  try {
    await tick();
    log("keeper_run_complete", { pid: process.pid });
  } catch (error) {
    log("keeper_run_failed", { pid: process.pid, error: String(error) });
    process.exitCode = 1;
  } finally {
    releasePidLock();
    log("keeper_stopped", { pid: process.pid });
  }
} else {
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
}
