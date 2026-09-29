import assert from "node:assert/strict";
import test from "node:test";
import { safeTransactionError, transactionFailureCode, transactionFailureMessage } from "./tx-diagnostics.js";

test("classifies insufficient Vault stake balance for a failed bet", () => {
  const error = Object.assign(new Error("execution reverted"), { shortMessage: "operatorPlaceBet reverted: InsufficientBalance" });
  const code = transactionFailureCode("place_bet", error);
  assert.equal(code, "vault_balance_low");
  assert.match(transactionFailureMessage(code), /Deposit USDC into the Vault/);
});

test("keeps revert details while redacting embedded RPC credentials and private keys", () => {
  const error = Object.assign(new Error("RPC Request failed."), {
    shortMessage: "RPC Request failed.",
    cause: Object.assign(new Error("execution reverted"), {
      reason: "InsufficientBalance",
      data: "0x" + "a".repeat(64),
      details: "POST https://rpc.example/rpc?api-key=secret",
      privateKey: "0x" + "b".repeat(64)
    })
  });
  const message = safeTransactionError(error);
  assert.match(message, /InsufficientBalance/);
  assert.match(message, /0x[a]{64}/i);
  assert.doesNotMatch(message, /api-key=secret|b{64}/i);
  assert.match(message, /api-key=%5Bredacted%5D/i);
});

test("classifies and reports the deepest wrapped RPC failure", () => {
  const error = Object.assign(new Error("Transaction creation failed."), {
    shortMessage: "Transaction creation failed.",
    cause: new Error("insufficient funds for gas * price + value")
  });
  assert.equal(transactionFailureCode("wallet_approve", error), "wallet_funding_low");
  assert.match(safeTransactionError(error), /insufficient funds for gas/);
});
