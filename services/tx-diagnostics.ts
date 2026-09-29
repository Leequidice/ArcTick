type ErrorWithDetails = Error & Record<string, unknown> & {
  shortMessage?: unknown;
  cause?: unknown;
  details?: unknown;
  reason?: unknown;
  data?: unknown;
  metaMessages?: unknown;
};

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
  const diagnostic = serializeError(error, 0, new Set());
  return JSON.stringify(redactSensitive(diagnostic)).slice(0, 4_000);
}

function errorText(error: unknown): string {
  let current = error;
  let deepestMessage = "";
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && current && typeof current === "object" && !seen.has(current); depth++) {
    seen.add(current);
    const detailed = current as ErrorWithDetails;
    if (typeof detailed.shortMessage === "string" && detailed.shortMessage) deepestMessage = detailed.shortMessage;
    else if (typeof detailed.message === "string" && detailed.message) deepestMessage = `${detailed.name || "Error"}: ${detailed.message}`;
    if (!detailed.cause || typeof detailed.cause !== "object") break;
    current = detailed.cause;
  }
  return deepestMessage || String(current ?? error);
}

// Retain the outer viem message and nested cause fields: shortMessage alone is
// often only the generic "RPC Request failed" wrapper. Never serialize request
// objects or headers, which may contain credentials.
function serializeError(value: unknown, depth: number, seen: Set<unknown>): unknown {
  if (depth > 7) return "[cause depth limit]";
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular cause]";
  seen.add(value);

  if (Array.isArray(value)) return value.slice(0, 20).map(item => serializeError(item, depth + 1, seen));
  const error = value as ErrorWithDetails;
  const output: Record<string, unknown> = {};
  const fields = ["name", "message", "shortMessage", "details", "reason", "revertReason", "errorName", "code", "data", "metaMessages", "signature", "args", "cause"] as const;
  for (const field of fields) {
    const fieldValue = field === "name" && error[field] === undefined ? error.constructor?.name : error[field];
    if (fieldValue !== undefined && fieldValue !== null) output[field] = serializeError(fieldValue, depth + 1, seen);
  }
  return output;
}

function redactSensitive(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/https?:\/\/[^\s"'<>)}\]]+/gi, rawUrl => {
        try {
          const url = new URL(rawUrl);
          url.username = "";
          url.password = "";
          for (const key of [...url.searchParams.keys()]) {
            if (/key|token|secret|auth|password|credential/i.test(key)) url.searchParams.set(key, "[redacted]");
          }
          return url.toString();
        } catch {
          return "[invalid URL redacted]";
        }
      })
      .replace(/(private[ _-]?key|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]");
  }
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactSensitive(item)]));
  return value;
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
