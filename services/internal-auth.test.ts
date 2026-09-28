import assert from "node:assert/strict";
import test from "node:test";
import { isValidInternalSecret } from "./internal-auth.js";

test("accepts only an exact configured internal secret", () => {
  assert.equal(isValidInternalSecret("a-long-random-secret", "a-long-random-secret"), true);
  assert.equal(isValidInternalSecret("a-long-random-secret", "wrong-secret"), false);
  assert.equal(isValidInternalSecret("a-long-random-secret", "a-long-random-secret-extra"), false);
  assert.equal(isValidInternalSecret(undefined, "a-long-random-secret"), false);
  assert.equal(isValidInternalSecret("a-long-random-secret", undefined), false);
});
