import { timingSafeEqual } from "node:crypto";

export function isValidInternalSecret(expectedValue: string | undefined, suppliedValue: string | undefined) {
  if (!expectedValue || !suppliedValue) return false;
  const expected = Buffer.from(expectedValue);
  const supplied = Buffer.from(suppliedValue);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
