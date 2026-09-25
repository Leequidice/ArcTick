import { MAINNET_FEEDS } from "./feeds.js";
import { testnetFeeds } from "./feeds.testnet.js";

/** Returns only Chainlink feeds explicitly configured for the selected chain. */
export function configuredFeeds(chainId: number, environment: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (chainId === 5042) return MAINNET_FEEDS;
  if (chainId === 5042002) return testnetFeeds(environment);
  throw new Error(`No approved feed configuration for chain ${chainId}`);
}
