import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const keeperSource = readFileSync(new URL("./keeper.ts", import.meta.url), "utf8");

test("keeper resolves on-chain and delegates Vault settlement to the API", () => {
  assert.match(keeperSource, /functionName: "resolve"/);
  assert.match(keeperSource, /requestSettlement\(market\)/);
  assert.doesNotMatch(keeperSource, /functionName: "(?:createMarket|operatorPlaceBet|operatorSettleMarket)"/);
});
