import pg, { type QueryResultRow } from "pg";
import { randomUUID } from "node:crypto";

const { Pool } = pg;
const OPERATOR_TX_LOCK = "781240914522";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  // Let pg honor sslmode=require from providers such as Neon. An explicit
  // false here would override the connection URL's TLS setting.
  ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : undefined
});
pool.on("error", error => console.error(JSON.stringify({ service: "api", action: "postgres_pool_error", error: String(error) })));

export type User = {
  id: string;
  address: `0x${string}`;
  mode: "custodial" | "connected";
  encryptedKey?: string;
  googleSub?: string;
  nonce?: string;
};

type UserRow = QueryResultRow & {
  id: string;
  address: `0x${string}`;
  mode: "custodial" | "connected";
  encrypted_key: string | null;
  google_sub: string | null;
  nonce: string | null;
};

function toUser(row: UserRow): User {
  return {
    id: row.id,
    address: row.address,
    mode: row.mode,
    ...(row.encrypted_key ? { encryptedKey: row.encrypted_key } : {}),
    ...(row.google_sub ? { googleSub: row.google_sub } : {}),
    ...(row.nonce ? { nonce: row.nonce } : {})
  };
}

let initialization: Promise<void> | undefined;

export function initializeDatabase(): Promise<void> {
  if (!initialization) {
    initialization = initializeDatabaseOnce().catch(error => {
      initialization = undefined;
      throw error;
    });
  }
  return initialization;
}

async function initializeDatabaseOnce() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY,
      address text NOT NULL,
      address_key text NOT NULL UNIQUE,
      mode text NOT NULL CHECK (mode IN ('custodial', 'connected')),
      encrypted_key text,
      google_sub text UNIQUE,
      nonce text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((mode = 'custodial' AND encrypted_key IS NOT NULL) OR mode = 'connected')
    );

    CREATE TABLE IF NOT EXISTS favorites (
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      market_address text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, market_address)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      market_address text NOT NULL,
      author_address text NOT NULL,
      body text NOT NULL CHECK (char_length(body) <= 280),
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS comments_market_created_idx
      ON comments (market_address, created_at, id);

    CREATE TABLE IF NOT EXISTS position_transactions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      market_address text NOT NULL,
      side text NOT NULL CHECK (side IN ('YES', 'NO')),
      amount numeric(78, 0) NOT NULL,
      transaction_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS position_transactions_user_recent_idx
      ON position_transactions (user_id, created_at DESC);
  `);
  await pool.query("SELECT 1");
}

export async function recordPositionTransaction(userId: string, marketAddress: string, side: "YES" | "NO", amount: string, transactionHash: string) {
  await pool.query(
    `INSERT INTO position_transactions (id, user_id, market_address, side, amount, transaction_hash)
     VALUES ($1, $2, lower($3), $4, $5, $6)`,
    [randomUUID(), userId, marketAddress, side, amount, transactionHash]
  );
}

export async function getPositionTransactionHashes(userId: string): Promise<Map<string, string>> {
  const result = await pool.query<{ market_address: string; side: "YES" | "NO"; transaction_hash: string }>(
    `SELECT DISTINCT ON (market_address, side) market_address, side, transaction_hash
     FROM position_transactions WHERE user_id = $1
     ORDER BY market_address, side, created_at DESC`,
    [userId]
  );
  return new Map(result.rows.map(row => [`${row.market_address.toLowerCase()}:${row.side}`, row.transaction_hash]));
}

export async function getUserById(id: string): Promise<User | undefined> {
  const result = await pool.query<UserRow>("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0] ? toUser(result.rows[0]) : undefined;
}

export async function getUserByGoogleSub(googleSub: string): Promise<User | undefined> {
  const result = await pool.query<UserRow>("SELECT * FROM users WHERE google_sub = $1", [googleSub]);
  return result.rows[0] ? toUser(result.rows[0]) : undefined;
}

export async function createGoogleUser(user: User) {
  await pool.query(
    `INSERT INTO users (id, address, address_key, mode, encrypted_key, google_sub)
     VALUES ($1, $2, lower($2), 'custodial', $3, $4)
     ON CONFLICT DO NOTHING`,
    [user.id, user.address, user.encryptedKey, user.googleSub]
  );
  const saved = await getUserByGoogleSub(user.googleSub!);
  if (!saved) throw new Error("Could not create Google user; account address is already registered");
  return saved;
}

export async function getOrCreateConnectedUser(address: `0x${string}`) {
  await pool.query(
    `INSERT INTO users (id, address, address_key, mode)
     VALUES ($1, $2, lower($2), 'connected')
     ON CONFLICT (address_key) DO NOTHING`,
    [randomUUID(), address]
  );
  const result = await pool.query<UserRow>("SELECT * FROM users WHERE address_key = lower($1)", [address]);
  if (!result.rows[0]) throw new Error("Could not create wallet user");
  return toUser(result.rows[0]);
}

export async function setWalletNonce(id: string, nonce: string) {
  const result = await pool.query<UserRow>("UPDATE users SET nonce = $2 WHERE id = $1 RETURNING *", [id, nonce]);
  return result.rows[0] ? toUser(result.rows[0]) : undefined;
}

export async function getUserByAddress(address: string): Promise<User | undefined> {
  const result = await pool.query<UserRow>("SELECT * FROM users WHERE address_key = lower($1)", [address]);
  return result.rows[0] ? toUser(result.rows[0]) : undefined;
}

export async function consumeWalletNonce(id: string, nonce: string): Promise<User | undefined> {
  const result = await pool.query<UserRow>(
    "UPDATE users SET nonce = NULL WHERE id = $1 AND nonce = $2 AND mode = 'connected' RETURNING *",
    [id, nonce]
  );
  return result.rows[0] ? toUser(result.rows[0]) : undefined;
}

/** Serialize transactions signed by the shared API/keeper operator account. */
export async function withOperatorTransactionLock<T>(work: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let acquired = false;
  try {
    await client.query("SELECT pg_advisory_lock($1::bigint)", [OPERATOR_TX_LOCK]);
    acquired = true;
    return await work();
  } finally {
    try {
      if (acquired) await client.query("SELECT pg_advisory_unlock($1::bigint)", [OPERATOR_TX_LOCK]);
    } finally {
      client.release();
    }
  }
}
