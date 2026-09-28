export type ChainStatus = {
  expectedChainId: number;
  configuredChainId: number;
  actualChainId: number | null;
  matchesExpected: boolean;
};

export function expectedChainId(configuredChainId: number, environment: NodeJS.ProcessEnv = process.env) {
  // Production API and GitHub Actions keeper are always expected to target Arc
  // mainnet. Local/testnet runs remain configurable through ARC_CHAIN_ID.
  return environment.NODE_ENV === "production" || environment.GITHUB_ACTIONS === "true"
    ? 5042
    : configuredChainId;
}

export function evaluateChainStatus(expected: number, configured: number, actual: number | null): ChainStatus {
  return {
    expectedChainId: expected,
    configuredChainId: configured,
    actualChainId: actual,
    matchesExpected: actual !== null && expected === configured && actual === expected
  };
}

export function isNetworkGuardedRequest(method: string, path: string) {
  const verb = method.toUpperCase();
  return (verb === "GET" && (path === "/markets" || path === "/balance")) ||
    (verb === "POST" && ["/swipe", "/settle", "/deposit", "/withdraw"].includes(path));
}
