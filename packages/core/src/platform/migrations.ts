import type { SqlDriver } from "../index-store/driver.js";
import type { SqlDialect } from "../index-store/schema.js";

/**
 * Accounts and workspaces (ADR-0002). Unlike the index, which is a cache rebuilt whenever its layout changes, these
 * rows are the only copy of who owns what: they change through numbered migrations and are never dropped. They share
 * the index's database (and Postgres schema); the index rebuild drops only its own tables by name.
 */
export interface PlatformMigration {
  readonly version: number;
  readonly name: string;
  sql(dialect: SqlDialect): string;
}

export const PLATFORM_MIGRATIONS_TABLE = "platform_migrations";

export const WORKSPACE_ROLES = ["owner", "admin", "member", "viewer"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Ordered by version; append only - an applied migration must never change. */
export const PLATFORM_MIGRATIONS: readonly PlatformMigration[] = [
  {
    version: 1,
    name: "accounts-and-workspaces",
    sql: (dialect) => {
      // Ids are random UUIDs and times are ISO-8601 UTC strings, the same in both databases.
      const T = dialect === "postgres" ? 'TEXT COLLATE "C"' : "TEXT";
      const role = (column: string) => `${column} ${T} NOT NULL CHECK (${column} IN (${WORKSPACE_ROLES.map((r) => `'${r}'`).join(", ")}))`;
      return `
CREATE TABLE users (
  id ${T} PRIMARY KEY, email ${T} NOT NULL UNIQUE, password_hash TEXT NOT NULL, display_name TEXT,
  created_at ${T} NOT NULL);
-- Only a hash of each session token is kept, so a leaked table does not log anyone in.
CREATE TABLE sessions (
  token_hash ${T} PRIMARY KEY, user_id ${T} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at ${T} NOT NULL, expires_at ${T} NOT NULL, last_used_at ${T} NOT NULL);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE workspaces (
  id ${T} PRIMARY KEY, slug ${T} NOT NULL UNIQUE, name TEXT NOT NULL,
  created_by ${T} REFERENCES users(id) ON DELETE SET NULL, created_at ${T} NOT NULL);
CREATE TABLE workspace_members (
  workspace_id ${T} NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id ${T} NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ${role("role")}, created_at ${T} NOT NULL, PRIMARY KEY (workspace_id, user_id));
CREATE INDEX idx_workspace_members_user ON workspace_members(user_id);
-- An invite is accepted by presenting its token (the link), not by signing up with the invited email.
CREATE TABLE workspace_invites (
  id ${T} PRIMARY KEY, workspace_id ${T} NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email ${T} NOT NULL, ${role("role")}, token_hash ${T} NOT NULL UNIQUE,
  invited_by ${T} REFERENCES users(id) ON DELETE SET NULL, created_at ${T} NOT NULL, expires_at ${T} NOT NULL,
  accepted_at ${T}, accepted_by ${T} REFERENCES users(id) ON DELETE SET NULL);
CREATE INDEX idx_workspace_invites_workspace ON workspace_invites(workspace_id);
-- A workspace's project points at its index by \`index_key\` (the index's project name), which never changes, so
-- renaming a project does not touch the index.
CREATE TABLE workspace_projects (
  id ${T} PRIMARY KEY, workspace_id ${T} NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug ${T} NOT NULL, name TEXT NOT NULL, index_key ${T} NOT NULL UNIQUE, created_at ${T} NOT NULL,
  UNIQUE (workspace_id, slug));
`;
    },
  },
  {
    version: 2,
    name: "workspace-slug-aliases",
    sql: (dialect) => {
      const T = dialect === "postgres" ? 'TEXT COLLATE "C"' : "TEXT";
      return `
-- A workspace's earlier slugs (REVIEW-0002 OQ-5): old links redirect to the current slug, and no other workspace can
-- take them. They go with the workspace.
CREATE TABLE workspace_slug_aliases (
  slug ${T} PRIMARY KEY, workspace_id ${T} NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at ${T} NOT NULL);
CREATE INDEX idx_workspace_slug_aliases_workspace ON workspace_slug_aliases(workspace_id);
`;
    },
  },
];

export interface PlatformMigrationResult {
  /** Versions applied by this call, in order. */
  applied: number[];
  /** The version the database is at now. */
  version: number;
}

/**
 * Brings the account tables up to the latest migration, each in the same transaction as its bookkeeping row.
 * Concurrent callers (two API instances starting) are serialized by the lock, so each migration runs once.
 */
export async function migratePlatform(
  driver: SqlDriver,
  migrations: readonly PlatformMigration[] = PLATFORM_MIGRATIONS,
): Promise<PlatformMigrationResult> {
  return driver.transaction(async (tx) => {
    const T = tx.dialect === "postgres" ? 'TEXT COLLATE "C"' : "TEXT";
    await tx.exec(
      `CREATE TABLE IF NOT EXISTS ${PLATFORM_MIGRATIONS_TABLE} (version INTEGER PRIMARY KEY, name ${T} NOT NULL, applied_at ${T} NOT NULL)`,
    );
    const done = new Set(
      (await tx.all<{ version: number | string }>(`SELECT version FROM ${PLATFORM_MIGRATIONS_TABLE}`)).map((r) => Number(r.version)),
    );
    const latest = Math.max(0, ...migrations.map((m) => m.version));
    const newer = [...done].filter((v) => v > latest);
    if (newer.length) {
      throw new Error(
        `The database has account migrations ${newer.join(", ")} that this version does not know (it knows up to ${latest}): upgrade tacet`,
      );
    }
    const applied: number[] = [];
    for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
      if (done.has(migration.version)) continue;
      await tx.exec(migration.sql(tx.dialect));
      await tx.run(`INSERT INTO ${PLATFORM_MIGRATIONS_TABLE} (version, name, applied_at) VALUES (?, ?, ?)`, [
        migration.version,
        migration.name,
        new Date().toISOString(),
      ]);
      applied.push(migration.version);
    }
    return { applied, version: Math.max(0, ...done, ...applied) };
  }, "platform-migrations");
}
