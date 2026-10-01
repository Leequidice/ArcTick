import type { Market } from "./types";

export function uniqueMarketSnapshot(markets: Market[]): Market[] {
  return [...new Map(markets.map(market => [market.slotId, market])).values()];
}

/** Update existing slots in place and append only genuinely new slot IDs. */
export function mergeMarketSnapshot(existing: Market[], fetched: Market[]): Market[] {
  const incoming = uniqueMarketSnapshot(fetched);
  const freshBySlot = new Map(incoming.map(market => [market.slotId, market]));
  const existingSlots = new Set(existing.map(market => market.slotId));
  return [
    ...existing.map(market => freshBySlot.get(market.slotId) ?? market),
    ...incoming.filter(market => !existingSlots.has(market.slotId))
  ];
}

export function nextFeedIndex(index: number, count: number): number {
  return count === 0 || index + 1 >= count ? 0 : index + 1;
}

export function rememberSkippedSlot(history: string[], slotId: string, limit = 8): string[] {
  return [...history, slotId].slice(-limit);
}

export function findSlotIndex(markets: Market[], slotId: string): number {
  return markets.findIndex(market => market.slotId === slotId);
}
