import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { evaluateChainStatus, expectedChainId, isNetworkGuardedRequest } from "./network-guard.js";

test("production API and GitHub Actions pin the expected chain to Arc mainnet", () => {
  assert.equal(expectedChainId(5042002, { NODE_ENV: "production" }), 5042);
  assert.equal(expectedChainId(5042002, { GITHUB_ACTIONS: "true" }), 5042);
  assert.equal(expectedChainId(5042002, {}), 5042002);
});

test("chain status fails closed for RPC mismatch, config mismatch, and unreadable chain id", () => {
  assert.deepEqual(evaluateChainStatus(5042, 5042, 5042), {
    expectedChainId: 5042, configuredChainId: 5042, actualChainId: 5042, matchesExpected: true
  });
  assert.equal(evaluateChainStatus(5042, 5042, 5042002).matchesExpected, false);
  assert.equal(evaluateChainStatus(5042, 5042002, 5042).matchesExpected, false);
  assert.equal(evaluateChainStatus(5042, 5042, null).matchesExpected, false);
});

test("markets, funds, swipe, and settlement are network-guarded", () => {
  assert.equal(isNetworkGuardedRequest("GET", "/markets"), true);
  assert.equal(isNetworkGuardedRequest("POST", "/swipe"), true);
  assert.equal(isNetworkGuardedRequest("POST", "/settle"), true);
  assert.equal(isNetworkGuardedRequest("POST", "/internal/settle"), false);
  assert.equal(isNetworkGuardedRequest("GET", "/health"), false);
});

test("keeper verifies chain before lock acquisition and tick work", () => {
  const source = readFileSync(new URL("./keeper.ts", import.meta.url), "utf8");
  const check = source.indexOf("await verifyConfiguredNetwork()");
  const lock = source.indexOf("acquirePidLock()");
  const tick = source.indexOf("async function tick()");
  assert.ok(check >= 0 && check < lock && check < tick);
  assert.match(source, /publicClient\.getChainId\(\)/);
  assert.match(source, /misconfigured_network/);
});

test("the API exposes only one settlement route and health omits RPC URL", () => {
  const source = readFileSync(new URL("./api.ts", import.meta.url), "utf8");
  assert.match(source, /app\.post\("\/settle"/);
  assert.doesNotMatch(source, /app\.post\("\/internal\/settle"/);
  assert.match(source, /actualChainId: status\.actualChainId/);
  assert.match(source, /rpcHostname: rpcHostname\(\)/);
  assert.doesNotMatch(source, /rpcUrl:/);
});
