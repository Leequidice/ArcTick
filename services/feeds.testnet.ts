// Source checked 2026-09-20: Chainlink's official Price Feed Addresses page
// (https://docs.chain.link/data-feeds/price-feeds/addresses) does not list an
// "Arc Testnet" network or any Arc Testnet AggregatorV3 proxy addresses.
// Keep this deliberately empty. Never copy Arc mainnet proxy addresses here:
// a call to those addresses on testnet cannot provide a valid testnet oracle.
/**
 * TESTNET ONLY. These addresses must be locally injected after deploying
 * `MockV3Aggregator`; no Chainlink mainnet address is ever accepted here.
 */
export function testnetFeeds(environment: NodeJS.ProcessEnv): Record<string, string> {
  const feeds: Record<string, string> = {};
  if (environment.TESTNET_MOCK_BTC_USD_FEED) feeds.BTC = environment.TESTNET_MOCK_BTC_USD_FEED;
  if (environment.TESTNET_MOCK_ETH_USD_FEED) feeds.ETH = environment.TESTNET_MOCK_ETH_USD_FEED;
  return feeds;
}
