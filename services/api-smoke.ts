// Example: API_URL=http://localhost:3001 npm run test:api
const base = process.env.API_URL ?? "http://localhost:3001";
const response = await fetch(`${base}/auth/wallet/nonce`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: process.env.TEST_WALLET_ADDRESS }) });
console.log(await response.text());
