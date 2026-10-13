import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { SqlDialect } from "./schema.js";

export type SqlValue = string | number | null;

/**
 * The little SQL the index store needs, over any database. Statements use `?` placeholders; drivers translate them.
 * Everything is async so drivers for network databases fit the same shape as the embedded SQLite one.
 */
export interface SqlDriver {
  readonly dialect: SqlDialect;
  /** Where the data lives, safe to show (no password). */
  readonly location: string;
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  run(sql: string, params?: SqlValue[]): Promise<void>;
  /** Several statements without parameters (DDL). */
  exec(sql: string): Promise<void>;
  /**
   * Runs `work` in one transaction. Transactions with the same `lock` never run at the same time, also across
   * processes where the database supports it, so concurrent indexers of one project do not interleave.
   */
  transaction<T>(work: (tx: SqlDriver) => Promise<T>, lock?: string): Promise<T>;
  close(): Promise<void>;
}

/** True for `postgres://` and `postgresql://` URLs; everything else is a SQLite file path. */
export function isPostgresUrl(location: string): boolean {
  return /^postgres(ql)?:\/\//i.test(location);
}

/** A location with any password replaced, for messages and results. */
export function redactLocation(location: string): string {
  if (!isPostgresUrl(location)) return location;
  try {
    const url = new URL(location);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return location.replace(/:\/\/([^:@/]+):[^@/]*@/, "://$1:***@");
  }
}

export async function openSqlDriver(location: string): Promise<SqlDriver> {
  return isPostgresUrl(location) ? openPostgres(location) : openSqlite(location);
}

// ---------------------------------------------------------------------------
// SQLite (node:sqlite, a file next to the project)
// ---------------------------------------------------------------------------

/** node:sqlite is synchronous, so writers in one process are serialized here instead of waiting on file locks. */
const sqliteLocks = new Map<string, Promise<unknown>>();

function openSqlite(path: string): SqlDriver {
  const file = resolve(path);
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  // Another process (e.g. an MCP server next to a CLI run) may be writing; wait for it rather than fail.
  db.exec("PRAGMA busy_timeout = 5000");
  const params = (values: SqlValue[] = []) => values as SQLInputValue[];
  const driver: SqlDriver = {
    dialect: "sqlite",
    location: file,
    all: async <T>(sql: string, values?: SqlValue[]) => db.prepare(sql).all(...params(values)) as T[],
    run: async (sql, values) => {
      db.prepare(sql).run(...params(values));
    },
    exec: async (sql) => db.exec(sql),
    transaction: async (work) => {
      const previous = sqliteLocks.get(file) ?? Promise.resolve();
      const current = previous.catch(() => undefined).then(async () => {
        db.exec("BEGIN IMMEDIATE");
        try {
          const result = await work(driver);
          db.exec("COMMIT");
          return result;
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      });
      sqliteLocks.set(file, current);
      try {
        return await current;
      } finally {
        if (sqliteLocks.get(file) === current) sqliteLocks.delete(file);
      }
    },
    close: async () => db.close(),
  };
  return driver;
}

// ---------------------------------------------------------------------------
// PostgreSQL (pg, loaded on first use)
// ---------------------------------------------------------------------------

interface PgQueryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** `?` → `$1, $2, …`. The store's SQL has no `?` inside string literals. */
function numbered(sql: string): string {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
}

async function openPostgres(location: string): Promise<SqlDriver> {
  let pg: typeof import("pg");
  try {
    pg = (await import("pg")).default as unknown as typeof import("pg");
  } catch {
    throw new Error('PostgreSQL support needs the "pg" package: npm install pg');
  }
  // `schema` is ours (tables go to their own schema, "tacet" by default), not a libpq parameter.
  const url = new URL(location);
  const schema = url.searchParams.get("schema") ?? "tacet";
  url.searchParams.delete("schema");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error(`Invalid PostgreSQL schema name: ${schema}`);

  // A transaction pooler (Supabase's port 6543, PgBouncer in transaction mode) hands each statement to whichever
  // server connection is free, so the schema set per connection below would not stick.
  if (/\.pooler\.supabase\.com$/i.test(url.hostname) && url.port === "6543") {
    throw new Error(
      `${redactLocation(location)} is Supabase's transaction pooler: use the session pooler (same host, port 5432)`,
    );
  }
  // A CA as PEM text ($TACET_PG_CA), for hosts like Koyeb where no certificate file can be shipped next to the URL.
  const ca = process.env.TACET_PG_CA?.replace(/\\n/g, "\n");
  if (ca) for (const key of ["sslmode", "sslrootcert", "uselibpqcompat"]) url.searchParams.delete(key);

  const pool = new pg.Pool({
    connectionString: url.toString(),
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
    // A CLI run must not wait for idle connections to time out before exiting.
    allowExitOnIdle: true,
  });
  // An idle connection dropped by the server must not crash the process; the pool reconnects on next use.
  pool.on("error", () => undefined);
  // The schema is set per connection rather than with the `options` startup parameter, which poolers (Supavisor,
  // PgBouncer) drop.
  const prepared = new WeakSet<object>();
  const acquire = async () => {
    const conn = await pool.connect();
    if (!prepared.has(conn)) {
      try {
        await conn.query(`SET search_path TO ${schema}`);
      } catch (err) {
        conn.release(err as Error);
        throw err;
      }
      prepared.add(conn);
    }
    return conn;
  };
  const pooled: PgQueryable = {
    query: async (sql, params) => {
      const conn = await acquire();
      try {
        return await conn.query(sql, params);
      } finally {
        conn.release();
      }
    },
  };
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  } catch (err) {
    await pool.end();
    throw new Error(`Cannot open the PostgreSQL index ${redactLocation(location)}: ${(err as Error).message}`);
  }

  const over = (client: PgQueryable, inTransaction: boolean): SqlDriver => {
    const driver: SqlDriver = {
      dialect: "postgres",
      location: redactLocation(location),
      all: async <T>(sql: string, values?: SqlValue[]) => (await client.query(numbered(sql), values)).rows as T[],
      run: async (sql, values) => {
        await client.query(numbered(sql), values);
      },
      exec: async (sql) => {
        await client.query(sql);
      },
      transaction: async (work, lock) => {
        if (inTransaction) return work(driver);
        const conn = await acquire();
        try {
          await conn.query("BEGIN");
          // Released at COMMIT / ROLLBACK; serializes writers of one project across processes and machines.
          if (lock !== undefined) await conn.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`tacet:${lock}`]);
          const result = await work(over(conn, true));
          await conn.query("COMMIT");
          return result;
        } catch (err) {
          await conn.query("ROLLBACK").catch(() => undefined);
          throw err;
        } finally {
          conn.release();
        }
      },
      close: async () => {
        if (!inTransaction) await pool.end();
      },
    };
    return driver;
  };
  return over(pooled, false);
}
