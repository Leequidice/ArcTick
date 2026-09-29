import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const keeperSource = readFileSync(new URL("./keeper.ts", import.meta.url), "utf8");

test("keeper resolves on-chain and delegates Vault settlement to the API", () => {
  assert.match(keeperSource, /functionName: "resolve"/);
  assert.match(keeperSource, /requestSettlement\(market\)/);
  assert.doesNotMatch(keeperSource, /functionName: "(?:createMarket|operatorPlaceBet|operatorSettleMarket)"/);
});

test("keeper dry run reports planned actions and bypasses all writes", () => {
  assert.match(keeperSource, /const dryRun = process\.env\.KEEPER_DRY_RUN === "true"/);
  assert.match(keeperSource, /if \(dryRun\) \{\s*wouldResolveCount\+\+;[\s\S]*?log\("would_resolve"/);
  assert.match(keeperSource, /else await send\([\s\S]*?"market_resolved"\)/);
  assert.match(keeperSource, /if \(dryRun\) \{\s*wouldSettleCount\+\+;[\s\S]*?log\("would_settle"/);
  assert.match(keeperSource, /else await requestSettlement\(market\)/);
  assert.match(keeperSource, /dryRun \? undefined : privateKeyToAccount/);
});
