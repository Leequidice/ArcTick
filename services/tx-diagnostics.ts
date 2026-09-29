type ErrorWithDetails = Error & { shortMessage?: unknown };

export type TransactionStage = "wallet_approve" | "vault_deposit" | "market_create" | "place_bet";

export function transactionFailureCode(stage: TransactionStage, error: unknown): string {
  const message = errorText(error).toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (stage === "place_bet" && message.includes("insufficientbalance")) return "vault_balance_low";
  if (message.includes("erc20insufficientbalance") || message.includes("insufficientfunds")) return "wallet_funding_low";
  if (message.includes("insufficientallowance")) return "token_approval_missing";
  if (message.includes("userrejected") || message.includes("actionrejected")) return "transaction_rejected";
  if (message.includes("invalidaccount") || message.includes("decrypt")) return "custodial_wallet_error";
  return "transaction_failed";
}

export function safeTransactionError(error: unknown): string {
  return errorText(error)
    .replace(/https?:\/\/[^\s"'<>)}\]]+/gi, "[rpc endpoint redacted]")
    .replace(/0x[a-f\d]{40,}/gi, "[hex value redacted]")
    .replace(/(private[ _-]?key|secret|token|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

function errorText(error: unknown): string {
  if (error && typeof error === "object") {
    const detailed = error as ErrorWithDetails;
    if (typeof detailed.shortMessage === "string" && detailed.shortMessage) return detailed.shortMessage;
    if (typeof detailed.message === "string" && detailed.message) return `${detailed.name || "Error"}: ${detailed.message}`;
  }
  return String(error);
}

export function transactionFailureMessage(code: string): string {
  switch (code) {
    case "vault_balance_low": return "Your ArcTick balance is too low. Deposit USDC into the Vault before betting.";
    case "wallet_funding_low": return "The wallet does not have enough USDC or Arc gas to complete this transaction.";
    case "token_approval_missing": return "USDC approval was not available for the deposit. No deposit was credited.";
    case "transaction_rejected": return "The transaction was rejected. No deposit or bet was completed.";
    case "custodial_wallet_error": return "The app could not access this account’s signing key. Contact support before retrying.";
    default: return "The transaction failed. No success was recorded; contact support with the diagnostic reference.";
  }
}
