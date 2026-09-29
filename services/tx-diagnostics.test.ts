import assert from "node:assert/strict";
import test from "node:test";
import { safeTransactionError, transactionFailureCode, transactionFailureMessage } from "./tx-diagnostics.js";

test("classifies insufficient Vault stake balance for a failed bet", () => {
  const error = Object.assign(new Error("execution reverted"), { shortMessage: "operatorPlaceBet reverted: InsufficientBalance" });
  const code = transactionFailureCode("place_bet", error);
  assert.equal(code, "vault_balance_low");
  assert.match(transactionFailureMessage(code), /Deposit USDC into the Vault/);
});

test("redacts RPC credentials and long hexadecimal values from diagnostics", () => {
  const message = safeTransactionError(new Error("failed https://rpc.example/rpc?key=secret 0x" + "a".repeat(64)));
  assert.doesNotMatch(message, /key=secret|a{40}/i);
  assert.match(message, /rpc endpoint redacted/);
});

test("classifies and reports the deepest wrapped RPC failure", () => {
  const error = Object.assign(new Error("Transaction creation failed."), {
    shortMessage: "Transaction creation failed.",
    cause: new Error("insufficient funds for gas * price + value")
  });
  assert.equal(transactionFailureCode("wallet_approve", error), "wallet_funding_low");
  assert.match(safeTransactionError(error), /insufficient funds for gas/);
});
