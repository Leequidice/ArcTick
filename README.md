# ArcTick contracts

Fixed-window binary parimutuel markets settled in ERC-20 USDC (6 decimals).

## Verified Arc parameters

Arc's official integration documentation lists mainnet chain ID `5042`, primary RPC
`https://rpc.mainnet.arc.io`, and explorer `https://explorer.arc.io`. Testnet uses
chain ID `5042002` and `https://rpc.testnet.arc.io`.

Chainlink's official Data Feed address registry lists these Arc mainnet **proxy**
addresses: BTC/USD `0xa109B535C70C8Be9995be64Bb6751AcDB27e03De` and ETH/USD
`0x50FCDD99D6762D1C170DC6A9111db944AEE6D364`. Pass feed addresses into
`createMarket`; none are embedded in the contracts.

## Market rules

- YES wins only if end price is strictly greater than start price; flat resolves to NO.
- The winner gets original stake plus its proportional share of 98% of the losing pool.
- The treasury receives 2% of the losing pool during resolution.
- If either side is empty, every participant on the populated side can claim a full
  refund and no commission is charged.
- If Chainlink has not published a new round since market opening, the market is
  refunded in full. This prevents a stale 0.5%-threshold feed update from being
  mistaken for a genuine flat-price NO result.

## Roles and commission treasury

`MarketFactory.owner()` administers only factory roles. `MARKET_CREATOR` is a
separate, least-privilege account permitted to call `createMarket`; the keeper
must receive this role but must never receive ownership. The 2% commission does
not accrue in the Vault or market: `BinaryMarket.resolve()` transfers it directly
to the immutable `treasury` configured in the factory at market creation. There
is therefore no treasury-withdraw function or trapped commission balance. Set
`TREASURY_ADDRESS` to a distinct cold/multisig wallet, never the keeper key.

## Commands

```sh
forge test
forge script script/DeployMarketFactory.s.sol:DeployMarketFactory \
  --rpc-url "$ARC_RPC_URL" --broadcast
forge script script/DeployVault.s.sol:DeployVault \
  --rpc-url "$ARC_RPC_URL" --broadcast
npm install
npm run typecheck
npm run keeper
npm run api
```

Foundry loads a local `.env` automatically. In PowerShell, use
`$env:ARC_RPC_URL` in place of `"$ARC_RPC_URL"`.

The factory owner creates immediate-opening markets with one of the supported durations:
60, 300, 900, or 3600 seconds. The creation transaction captures both the
Chainlink price and round ID.

## Vault and services

`Vault` is an operator-controlled pooled ledger. It sets a maximum USDC allowance lazily
for a market only after verifying the market was deployed by the configured factory and
uses the same USDC token. Its per-market, per-user YES/NO ledger means the Vault can claim
once and redistribute the exact payout internally, including all refund cases.

The Node services live in `services/`. `keeper.ts` creates the rolling 10×3 markets,
resolves ended markets, and settles Vault positions. `api.ts` supplies Google and
signature-wallet auth, balance, swipe, and withdrawal endpoints. Custodial Google users
have AES-256-GCM-encrypted keys (derived from `WALLET_MASTER_SECRET`) and can have the
server submit a withdrawal. Connected-wallet users must sign `Vault.withdraw` themselves;
the API returns the transaction request instead of signing on their behalf.

Do not use the Arc-mainnet Chainlink feed map against testnet. As of 2026-09-20, Chainlink's
official address registry has no Arc Testnet price-feed entries; therefore
`services/feeds.testnet.ts` is deliberately empty and the testnet keeper creates no markets.
Populate it only with addresses subsequently published by Chainlink.

## Mobile web app

The mobile-first React PWA lives in [`web/`](web/). It uses the existing API for
authentication, Vault balance, deposits, swipes, and withdrawals, plus the market and
community endpoints added in `services/api.ts`.

```sh
cd web
copy .env.example .env
npm install
npm run dev
```

Set `VITE_API_URL` to the API origin and `VITE_GOOGLE_CLIENT_ID` to the browser OAuth
client. The API needs `WEB_ORIGIN` set to the deployed web origin. For mainnet, use a
dedicated `ARC_RPC_URL`; `GET /markets` uses a short shared cache (`MARKETS_CACHE_TTL_MS`,
default four seconds), bounded RPC reads, and falls back to the official Arc RPC if the
dedicated provider is unavailable.

For a full testnet-only lifecycle, deploy `DeployTestnetMocks.s.sol` and set the
resulting mock addresses as `TESTNET_MOCK_BTC_USD_FEED` and
`TESTNET_MOCK_ETH_USD_FEED` in `.env.testnet`. `MockV3Aggregator` is namespaced
under `src/testnet`, labeled TESTNET ONLY, and must never be added to mainnet config.
