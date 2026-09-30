export const factoryAbi = [
  { type: "function", name: "marketCount", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "markets", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "latestMarketByFeedAndDuration", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "address" }] },
  { type: "function", name: "createMarket", stateMutability: "nonpayable", inputs: [{ type: "string" }, { type: "address" }, { type: "uint256" }], outputs: [{ type: "address" }] }
] as const;

export const aggregatorAbi = [
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }] }
] as const;

export const marketAbi = [
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "usdc", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "assetPair", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "startTime", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "endTime", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "resolved", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "yesWon", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "refunded", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "priceFeed", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "getPoolSizes", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "getParticipantCounts", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "resolve", stateMutability: "nonpayable", inputs: [], outputs: [] }
] as const;

export const vaultAbi = [
  { type: "function", name: "balances", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
  { type: "function", name: "operatorPlaceBet", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "bool" }, { type: "uint256" }], outputs: [] },
  { type: "function", name: "operatorSettleMarket", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
  { type: "function", name: "getMarketParticipants", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address[]" }] },
  { type: "function", name: "marketSettled", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "positions", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }, { type: "uint256" }, { type: "bool" }] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] }
] as const;

export const usdcAbi = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }
] as const;
