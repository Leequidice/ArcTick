# ArcTick

ArcTick is a swipe-based market app for people who follow digital-asset prices and want to express a short-term view with a simple YES or NO position. Each swipe opens or joins a shared, on-chain USDC market on Arc mainnet; the card advances immediately while the bet is submitted in the background. Trading and forecasting use the same transparent binary-market primitive, with different time horizons and interface framing.

## Live product

- **App:** [arctick.vercel.app](https://arctick.vercel.app/)
- **API health:** [arctick.vercel.app/api/health](https://arctick.vercel.app/api/health)
- **Network:** Arc mainnet, chain ID `5042`
- **Settlement asset and gas token:** USDC, 6 decimals
- **USDC contract:** `0x3600000000000000000000000000000000000000`
- **MarketFactory:** `0x880e46A226756D87c825257601dFc61AAcF266dF`
- **Vault:** `0x72Bf237803Ee3bBe7B6aa21FE0b17c77d1ed5486`
- **Explorer:** [explorer.arc.io](https://explorer.arc.io/)
- **Price feeds:** Chainlink Standard Proxy feeds configured in [`services/feeds.ts`](services/feeds.ts). See [Chainlink's Arc feed registry](https://docs.chain.link/data-feeds/price-feeds/addresses?network=arc).

The live feed covers BTC, ETH, SOL, AVAX, BNB, LINK, XRP, UNI, TRX, and BCH against USD across 5-minute, 15-minute, and 1-hour windows.

## How it works

### Swipe markets

- Swipe right to take **YES**: the asset price will be higher at close.
- Swipe left to take **NO**: the price will be flat or lower at close.
- Swipe up or tap × to pass without betting. The last skipped cards can be restored with undo.

The Trading view groups 5-minute and 15-minute markets for shorter-horizon price action. The Forecasting view (labeled “Prediction” in the app) presents the 1-hour horizon. These labels describe the experience; both views use the same contract, pool, and resolution rules.

### Shared pools and settlement

Markets are pari-mutuel: participants fund both sides, and there is no house or separate liquidity provider. Each market opens with a reference price and Chainlink round ID. At close, a fresh feed observation determines the result: a higher price makes YES the winner; a flat or lower price makes NO the winner. Winning positions receive their original stake plus a proportional share of 98% of the losing pool. The remaining 2% of that pool is sent to the configured treasury.

Two conditions produce full refunds with no commission: one side has no participants, or the feed has not advanced to a new round since market opening. The round check prevents an old observation from being treated as a current result. Resolution is permissionless; an automated keeper scans expired markets, resolves them, and requests settlement for markets with Vault positions. Scheduled scans run every five minutes, so resolution and settlement can follow market close by several minutes.

### On-demand market creation

ArcTick creates a market only when the first user bets on a feed/timeframe slot. The first swipe both opens the market and places the initiating bet. Subsequent swipes join that live market. After it closes, another swipe can open the next market for that slot. An on-chain duplicate guard permits at most one open market per feed and duration, including when multiple users swipe at nearly the same time.

This demand-driven model avoids deploying empty markets for slots nobody uses. It reduces routine transactions and keeps the factory's market registry focused on markets with actual user demand.

### Vault and wallet roles

The Vault maintains an internal USDC balance and per-user YES/NO positions for each market. After a user deposits, a swipe can be submitted through the API operator without requiring a separate wallet confirmation for each bet. On resolution, the Vault claims the market payout once and allocates it to eligible user positions; users can withdraw their available balance.

Runtime authority is divided by purpose. The factory owner administers roles; a market-creator account can create markets but cannot administer the factory. The API operator submits Vault bets and settlement calls. The keeper key is used for permissionless market resolution, while a separate shared-secret header authorizes keeper-to-API settlement requests. Deployment ownership and treasury control remain separate from these operational keys.

## Architecture

ArcTick's on-chain layer consists of three Solidity contracts. `MarketFactory` validates supported durations, captures the opening feed price and round, deploys markets, and enforces the open-market invariant. Each `BinaryMarket` holds the USDC pool and resolves/refunds it according to the feed rules. `Vault` tracks user balances and positions and redistributes each market's payout to users.

The mobile web client is a React, Vite, and TypeScript PWA. Framer Motion handles card gestures and transitions. It calls the same-origin Vercel API for authentication, market data, deposits, swipes, balances, positions, comments, favorites, and withdrawals. The Node API uses PostgreSQL for user records, encrypted custodial keys, community data, and bet transaction references. It reads Arc contracts and Chainlink feeds through the configured RPC provider.

The keeper is a one-shot Node process run by GitHub Actions on a five-minute schedule, with a manual workflow-dispatch option. It verifies the RPC chain ID, batches factory and market reads through Multicall3, resolves expired markets, and requests Vault settlement from the API. The API and keeper use distinct keys and authority scopes. Vercel functions are stateless; Neon Postgres provides persistent application storage. The API or database may cold-start after idle, which can slow the first request.

## Product scope and roadmap

**Available today:** live YES/NO markets, on-demand market creation, USDC deposits and withdrawals, live pool and participant counts, an account balance, a My Positions view with status and transaction links, comments, favorites, swipe skip/undo, and mobile PWA installability.

**Planned product milestones:**

- **Early exit:** let users close a position before market expiry under explicit, on-chain payout rules.
- **Self-funding operations:** introduce a small, clearly disclosed per-swipe fee to fund transaction gas and ongoing market operations.
- **Broader asset coverage:** add further Arc-listed feeds as reliable Chainlink coverage becomes available.

## Wallet warning

MetaMask or Blockaid may show a domain-reputation warning for the newly deployed app domain. A false-positive report has been filed. ArcTick's login flow requests a message signature for authentication; it does not request token approval. Deposits and withdrawals are separate, user-initiated flows. Verify the app URL and review every wallet prompt before signing.

## Setup and development

Requirements: Node.js 22+, npm, and Foundry. Copy `.env.example` to `.env`, configure local API, PostgreSQL, RPC, and OAuth values, then install dependencies from the repository root:

```sh
npm ci
npm --prefix web ci
```

Run the API and frontend in separate terminals:

```sh
npm run api
npm --prefix web run dev
```

The API uses the platform `PORT` when present, otherwise `API_PORT` (the example configuration uses `3000`, with `8080` as the code fallback). Vite serves the client at `http://localhost:5173`; set `VITE_API_URL` to the actual local API origin and `VITE_GOOGLE_CLIENT_ID` in `web/.env.local`. The Google OAuth JavaScript origin must match the browser URL exactly.

Run the checks:

```sh
forge test
npm run typecheck
npm run test:services
npm --prefix web run build
```

Production secrets belong in Vercel environment variables and GitHub Actions secrets, never in the repository. The API requires `DATABASE_URL`, `ARC_RPC_URL`, `ARC_CHAIN_ID`, `FACTORY_ADDRESS`, `VAULT_ADDRESS`, `API_OPERATOR_PRIVATE_KEY`, `INTERNAL_KEEPER_SECRET`, `JWT_SECRET`, `WALLET_MASTER_SECRET`, and `GOOGLE_CLIENT_ID`. The web build requires `VITE_GOOGLE_CLIENT_ID`; production uses the same-origin API, so `VITE_API_URL` can remain unset. The keeper workflow separately requires `ARC_RPC_URL`, `ARC_CHAIN_ID`, `FACTORY_ADDRESS`, `VAULT_ADDRESS`, `KEEPER_PRIVATE_KEY`, and `INTERNAL_KEEPER_SECRET` as repository secrets. Mainnet requests fail closed if the configured RPC reports a chain ID other than `5042`.

Arc mainnet's public RPC is `https://rpc.mainnet.arc.io`; production should use a dedicated provider, with the public endpoint as fallback. Testnet development uses the isolated `MockV3Aggregator` implementation in `src/testnet/`; never use mainnet feed addresses on testnet.

---

Built for and submitted to [Arc Microgrants](https://arc.network/) by [Leequidice](https://github.com/Leequidice).
