import assert from "node:assert/strict";
import test from "node:test";
import { findSlotIndex, mergeMarketSnapshot, nextFeedIndex, rememberSkippedSlot, uniqueMarketSnapshot } from "../web/src/feed-state.ts";
import type { Market } from "../web/src/types.ts";

function market(slotId: string, price: string): Market {
  return {
    slotId, kind: "virtual", assetPair: `${slotId}/USD`, feedAddress: "0x0000000000000000000000000000000000000001",
    price, priceUpdatedAt: "1", duration: "300", timeRemaining: 0,
    yesPool: null, noPool: null, yesParticipants: null, noParticipants: null
  };
}

test("feed merges refreshed slots in place and deduplicates repeated slot IDs", () => {
  const first = market("BTC-300", "100");
  const second = market("ETH-300", "200");
  const updatedFirst = market("BTC-300", "101");
  const newSlot = market("SOL-300", "50");

  assert.deepEqual(uniqueMarketSnapshot([updatedFirst, updatedFirst, newSlot]).map(item => item.slotId), ["BTC-300", "SOL-300"]);
  const merged = mergeMarketSnapshot([first, second], [updatedFirst, updatedFirst, newSlot]);

  assert.deepEqual(merged.map(item => item.slotId), ["BTC-300", "ETH-300", "SOL-300"]);
  assert.equal(merged[0].price, "101");
  assert.equal(merged[1].price, "200");
});

test("feed cursor loops over the matrix without an end state", () => {
  assert.equal(nextFeedIndex(0, 3), 1);
  assert.equal(nextFeedIndex(2, 3), 0);
  assert.equal(nextFeedIndex(0, 0), 0);
});

test("skip undo history is bounded and restores by current slot ID", () => {
  const history = Array.from({ length: 11 }, (_, index) => `slot-${index}`).reduce((stack, id) => rememberSkippedSlot(stack, id), [] as string[]);
  assert.equal(history.length, 8);
  assert.deepEqual(history, ["slot-3", "slot-4", "slot-5", "slot-6", "slot-7", "slot-8", "slot-9", "slot-10"]);
  assert.equal(findSlotIndex([market("BTC-300", "updated"), market("ETH-300", "200")], "BTC-300"), 0);
});
