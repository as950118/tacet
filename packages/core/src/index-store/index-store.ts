import type { TacetConfig } from "../config.js";
import type {
  ApiCallInfo,
  BackendManifest,
  DtoInfo,
  EndpointInfo,
  EnumInfo,
  FileInfo,
  FrontendManifest,
  FunctionInfo,
  PropertyAccessInfo,
  RouteInfo,
  ServiceCallInfo,
} from "../ir/types.js";
import type { Ontology, OntologyEntity, OntologyTriple, PageApiUse, RelatedPage } from "../analysis/ontology.js";
import { openSqlDriver, type SqlDriver, type SqlValue } from "./driver.js";
import { GLOBAL_PROJECT, META_TABLE, RELATION_TABLES, SCHEMA_VERSION, SNAPSHOT_TABLE, TABLES, schemaSql, type SqlDialect } from "./schema.js";

/** The project used when none is named: a SQLite file usually holds just one. */
export const DEFAULT_PROJECT = "default";

/** A row of `page_apis`: one page using one API. */
export interface StoredPageApi extends PageApiUse {
  page: string;
}

export interface RelationQuery {
  subject?: string;
  predicate?: string;
  object?: string;
  limit?: number;
}

export interface IndexSummary {
  files: number;
  functions: number;
  apiCalls: number;
  resolvedApiCalls: number;
  propertyAccesses: number;
}

export interface FrontendIndexUpdate {
  summary: IndexSummary;
  /** Source files whose indexed records were added, changed or removed. */
  changedFiles: string[];
}

export interface BackendIndexUpdate {
  endpoints: number;
  dtos: number;
  /** Endpoint ids that were added, changed or removed. */
  changedEndpoints: string[];
}

export interface Snapshot {
  fingerprint: string;
  generatedAt: string;
  json: string;
}

export interface ProjectInfo {
  name: string;
  frontend: { rootDir: string; generatedAt: string } | null;
  backend: { rootDir: string; generatedAt: string } | null;
}

/**
 * The index of one project: extractor manifests (facts) and the relations derived from them. The workspace, CLI,
 * MCP and HTTP servers only use this interface, so where the data lives (a SQLite file, a shared PostgreSQL, …)
 * is decided by {@link openIndexDatabase} alone.
 */
export interface IndexStore {
  readonly project: string;

  getMeta(key: string): Promise<string | null>;
  /** The config used when the frontend was indexed, so later queries link endpoints the same way. */
  writeConfig(config: TacetConfig): Promise<void>;
  readConfig(): Promise<TacetConfig>;

  /**
   * Syncs the frontend part of the index with a manifest. Only rows that actually changed are written, and the
   * files they belong to are reported, so callers can tell which parts of the frontend a code change touched.
   */
  writeManifest(manifest: FrontendManifest): Promise<FrontendIndexUpdate>;
  writeBackendManifest(manifest: BackendManifest): Promise<BackendIndexUpdate>;
  /** Replaces the stored relations with an ontology built from the current facts. */
  writeRelations(ontology: Ontology, config?: TacetConfig): Promise<{ entities: number; relations: number; pageApis: number }>;

  summary(): Promise<IndexSummary>;
  listFiles(): Promise<FileInfo[]>;
  listFunctions(): Promise<FunctionInfo[]>;
  listApiCalls(): Promise<ApiCallInfo[]>;
  listPropertyAccesses(): Promise<PropertyAccessInfo[]>;
  listRoutes(): Promise<RouteInfo[]>;
  findApiCallsByEndpoint(method: string, endpointPattern: string): Promise<ApiCallInfo[]>;
  findPropertyAccessesForApiCall(apiCallId: string): Promise<PropertyAccessInfo[]>;

  hasRelations(): Promise<boolean>;
  /** Whether the stored relations were built with this config (e.g. the same common-API rule). */
  relationsBuiltWith(config: TacetConfig): Promise<boolean>;
  getEntity(id: string): Promise<OntologyEntity | null>;
  /** Entities whose id, label, route path or page component is exactly `key`, optionally of one class. */
  findEntitiesByKey(key: string, cls?: string): Promise<OntologyEntity[]>;
  /** Relations matching every given part (entity ids), e.g. { predicate: "renders", object: "fn:..." }. */
  queryRelations(query?: RelationQuery): Promise<OntologyTriple[]>;
  /** Pages using an API (endpoint entity id), or the APIs a page uses (page entity id). */
  pageApis(by: { page?: string; endpoint?: string }): Promise<StoredPageApi[]>;
  /** Pages sharing the most non-common APIs with a page (page entity id). */
  relatedPages(page: string): Promise<Array<Omit<RelatedPage, "route" | "component">>>;

  /** The frontend manifest stored in the index, or null when no frontend has been indexed. */
  readFrontendManifest(): Promise<FrontendManifest | null>;
  /** The backend manifest stored in the index, or null when no backend has been extracted. */
  readBackendManifest(): Promise<BackendManifest | null>;
  /** Stores a precomputed result (JSON text) under `kind`, tagged with the index state it was computed from. */
  writeSnapshot(kind: string, fingerprint: string, json: string): Promise<void>;
  readSnapshot(kind: string): Promise<Snapshot | null>;
  /** Removes everything stored for this project. */
  clear(): Promise<void>;
}

/** A database holding the indexes of any number of projects. */
export interface IndexDatabase {
  readonly dialect: SqlDialect;
  /** Where the data lives, without credentials. */
  readonly location: string;
  project(name?: string): IndexStore;
  listProjects(): Promise<ProjectInfo[]>;
  close(): Promise<void>;
}

/**
 * Opens (and creates or migrates) an index database: a `postgres://user:pass@host/db?schema=tacet` URL, or a SQLite
 * file path. The index is derived data, so a database with an older layout is rebuilt rather than migrated.
 */
export async function openIndexDatabase(location: string): Promise<IndexDatabase> {
  const driver = await openSqlDriver(location);
  try {
    await driver.transaction(async (tx) => {
      const version = await schemaVersion(tx);
      if (version !== null && version !== String(SCHEMA_VERSION)) {
        for (const table of [...TABLES, ...RELATION_TABLES, SNAPSHOT_TABLE, META_TABLE]) await tx.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      await tx.exec(schemaSql(driver.dialect));
      await upsertMeta(tx, GLOBAL_PROJECT, "schemaVersion", String(SCHEMA_VERSION));
    }, "schema");
  } catch (err) {
    await driver.close();
    throw err;
  }
  return new SqlIndexDatabase(driver);
}

async function schemaVersion(tx: SqlDriver): Promise<string | null> {
  const exists =
    tx.dialect === "postgres"
      ? await tx.all("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?", [META_TABLE])
      : await tx.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [META_TABLE]);
  if (!exists.length) return null;
  // Works for every layout so far: older ones had no `project` column.
  const rows = await tx.all<{ value: string }>(`SELECT value FROM ${META_TABLE} WHERE key = 'schemaVersion'`);
  return rows[0]?.value ?? "unknown";
}

async function upsertMeta(db: SqlDriver, project: string, key: string, value: string): Promise<void> {
  await db.run(
    `INSERT INTO ${META_TABLE} (project, key, value) VALUES (?, ?, ?) ON CONFLICT (project, key) DO UPDATE SET value = excluded.value`,
    [project, key, value],
  );
}

class SqlIndexDatabase implements IndexDatabase {
  constructor(private readonly driver: SqlDriver) {}

  get dialect(): SqlDialect {
    return this.driver.dialect;
  }

  get location(): string {
    return this.driver.location;
  }

  project(name: string = DEFAULT_PROJECT): IndexStore {
    if (!name || name === GLOBAL_PROJECT) throw new Error("A project name must not be empty");
    return new SqlIndexStore(this.driver, name);
  }

  async listProjects(): Promise<ProjectInfo[]> {
    const rows = await this.driver.all<{ project: string; key: string; value: string }>(
      `SELECT project, key, value FROM ${META_TABLE} WHERE project <> ? AND key IN ('rootDir', 'generatedAt', 'backend.rootDir', 'backend.generatedAt') ORDER BY project`,
      [GLOBAL_PROJECT],
    );
    const meta = new Map<string, Record<string, string>>();
    for (const r of rows) meta.set(r.project, { ...meta.get(r.project), [r.key]: r.value });
    return [...meta].map(([name, m]) => ({
      name,
      frontend: m.rootDir !== undefined ? { rootDir: m.rootDir, generatedAt: m.generatedAt ?? "" } : null,
      backend: m["backend.rootDir"] !== undefined ? { rootDir: m["backend.rootDir"], generatedAt: m["backend.generatedAt"] ?? "" } : null,
    }));
  }

  close(): Promise<void> {
    return this.driver.close();
  }
}

type Table = (typeof TABLES)[number];

interface SyncRow {
  id: string;
  file: string;
  columns: Record<string, SqlValue>;
  value: unknown;
}

/** Rows per multi-row INSERT: well under SQLite's and PostgreSQL's parameter limits. */
const MAX_PARAMS = 8000;

/** The index of one project in a SQL database (SQLite or PostgreSQL). The only module that knows about SQL. */
class SqlIndexStore implements IndexStore {
  constructor(
    private readonly db: SqlDriver,
    readonly project: string,
  ) {}

  async getMeta(key: string): Promise<string | null> {
    const rows = await this.db.all<{ value: string }>(`SELECT value FROM ${META_TABLE} WHERE project = ? AND key = ?`, [
      this.project,
      key,
    ]);
    return rows[0]?.value ?? null;
  }

  writeConfig(config: TacetConfig): Promise<void> {
    return upsertMeta(this.db, this.project, "config", JSON.stringify(config));
  }

  async readConfig(): Promise<TacetConfig> {
    return JSON.parse((await this.getMeta("config")) ?? "{}") as TacetConfig;
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async writeManifest(manifest: FrontendManifest): Promise<FrontendIndexUpdate> {
    const changed = new Set<string>();
    await this.write(async (tx) => {
      const sync = (table: Table, rows: SyncRow[]) => this.sync(tx, table, rows, changed);
      await sync("files", manifest.files.map((f) => ({ id: f.path, file: f.path, columns: {}, value: f })));
      await sync("functions", manifest.functions.map((f) => ({ id: f.id, file: f.file, columns: { name: f.name }, value: f })));
      await sync(
        "api_calls",
        manifest.apiCalls.map((c) => ({
          id: c.id,
          file: c.file,
          columns: { method: c.method, endpoint_pattern: c.endpointPattern },
          value: c,
        })),
      );
      await sync(
        "property_accesses",
        manifest.propertyAccesses.map((a) => ({ id: a.id, file: a.file, columns: { api_call_id: a.apiCallId }, value: a })),
      );
      await sync("routes", (manifest.routes ?? []).map((r) => ({ id: r.id, file: r.file, columns: {}, value: r })));
      await this.setMeta(tx, { language: manifest.language, rootDir: manifest.rootDir, generatedAt: manifest.generatedAt });
    });
    return { summary: await this.summary(), changedFiles: [...changed].sort() };
  }

  async writeBackendManifest(manifest: BackendManifest): Promise<BackendIndexUpdate> {
    const changedFiles = new Set<string>();
    const changedEndpoints = new Set<string>();
    await this.write(async (tx) => {
      await this.sync(
        tx,
        "endpoints",
        manifest.endpoints.map((e) => ({ id: e.id, file: e.id, columns: { method: e.method, path: e.path }, value: e })),
        changedEndpoints,
      );
      await this.sync(
        tx,
        "dtos",
        manifest.dtos.map((d) => ({ id: d.id, file: d.location.file, columns: { name: d.name }, value: d })),
        changedFiles,
      );
      await this.sync(
        tx,
        "enums",
        manifest.enums.map((e) => ({ id: e.id, file: e.location.file, columns: { name: e.name }, value: e })),
        changedFiles,
      );
      await this.sync(
        tx,
        "service_calls",
        (manifest.serviceCalls ?? []).map((c) => ({
          id: c.id,
          file: c.location.file,
          columns: { method: c.method, path: c.path },
          value: c,
        })),
        changedFiles,
      );
      await this.setMeta(tx, {
        "backend.gatewayRoutes": JSON.stringify(manifest.gatewayRoutes ?? []),
        "backend.contextPaths": JSON.stringify(manifest.contextPaths ?? []),
        "backend.language": manifest.language,
        "backend.rootDir": manifest.rootDir,
        "backend.generatedAt": manifest.generatedAt,
        "backend.warnings": JSON.stringify(manifest.warnings),
      });
    });
    return {
      endpoints: manifest.endpoints.length,
      dtos: manifest.dtos.length,
      changedEndpoints: [...changedEndpoints].sort(),
    };
  }

  /** Relations are derived data, so they are rewritten as a whole (in one transaction) rather than synced row by row. */
  async writeRelations(ontology: Ontology, config: TacetConfig = {}): Promise<{ entities: number; relations: number; pageApis: number }> {
    const uses: SqlValue[][] = [];
    const related: SqlValue[][] = [];
    for (const page of ontology.pages) {
      for (const api of page.apis) {
        uses.push([page.page, api.endpoint, api.apiKey, api.status, JSON.stringify(api.via), JSON.stringify(api.fields), api.common ? 1 : 0]);
      }
      for (const r of page.related ?? []) related.push([page.page, r.page, r.shared, JSON.stringify(r.apis)]);
    }
    const pageApis = unique(uses, (r) => `${r[0]}\0${r[1]}`);
    await this.write(async (tx) => {
      for (const table of RELATION_TABLES) await tx.run(`DELETE FROM ${table} WHERE project = ?`, [this.project]);
      await this.insert(
        tx,
        "entities",
        ["id", "class", "label", "file", "line", "status", "route_path", "component", "json"],
        unique(ontology.entities, (e) => e.id).map((e) => [
          e.id,
          e.class,
          e.label,
          e.file,
          e.line,
          e.status,
          stringAttribute(e, "path"),
          stringAttribute(e, "component"),
          JSON.stringify(e),
        ]),
      );
      await this.insert(
        tx,
        "relations",
        ["subject", "predicate", "object", "inferred", "json"],
        unique(ontology.triples, (t) => `${t.subject}\0${t.predicate}\0${t.object}`).map((t) => [
          t.subject,
          t.predicate,
          t.object,
          t.inferred ? 1 : 0,
          JSON.stringify(t),
        ]),
      );
      await this.insert(tx, "page_apis", ["page", "endpoint", "api_key", "status", "via", "fields", "common"], pageApis);
      await this.insert(tx, "related_pages", ["page", "related", "shared", "apis"], unique(related, (r) => `${r[0]}\0${r[1]}`));
      await this.setMeta(tx, {
        "relations.generatedAt": new Date().toISOString(),
        "relations.config": JSON.stringify(config),
        "relations.commonApis": JSON.stringify(ontology.commonApis ?? null),
      });
    });
    return { entities: ontology.entities.length, relations: ontology.triples.length, pageApis: pageApis.length };
  }

  async writeSnapshot(kind: string, fingerprint: string, json: string): Promise<void> {
    await this.db.run(
      `INSERT INTO ${SNAPSHOT_TABLE} (project, kind, fingerprint, generated_at, json) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project, kind) DO UPDATE SET fingerprint = excluded.fingerprint, generated_at = excluded.generated_at, json = excluded.json`,
      [this.project, kind, fingerprint, new Date().toISOString(), json],
    );
  }

  async readSnapshot(kind: string): Promise<Snapshot | null> {
    const rows = await this.db.all<{ fingerprint: string; generated_at: string; json: string }>(
      `SELECT fingerprint, generated_at, json FROM ${SNAPSHOT_TABLE} WHERE project = ? AND kind = ?`,
      [this.project, kind],
    );
    const row = rows[0];
    return row ? { fingerprint: row.fingerprint, generatedAt: row.generated_at, json: row.json } : null;
  }

  async clear(): Promise<void> {
    await this.write(async (tx) => {
      for (const table of [...TABLES, ...RELATION_TABLES, SNAPSHOT_TABLE, META_TABLE]) {
        await tx.run(`DELETE FROM ${table} WHERE project = ?`, [this.project]);
      }
    });
  }

  private write(work: (tx: SqlDriver) => Promise<void>): Promise<void> {
    return this.db.transaction(work, this.project);
  }

  private async setMeta(tx: SqlDriver, values: Record<string, string>): Promise<void> {
    for (const [key, value] of Object.entries(values)) await upsertMeta(tx, this.project, key, value);
  }

  /** Multi-row inserts of `rows` (each without the project column), upserting on the primary key when `upsert` is given. */
  private async insert(tx: SqlDriver, table: string, columns: string[], rows: SqlValue[][], upsert?: { key: string[] }): Promise<void> {
    const names = ["project", ...columns];
    const perRow = names.length;
    const chunk = Math.max(1, Math.floor(MAX_PARAMS / perRow));
    const onConflict = upsert
      ? ` ON CONFLICT (${upsert.key.join(", ")}) DO UPDATE SET ${columns
          .filter((c) => !upsert.key.includes(c))
          .map((c) => `${c} = excluded.${c}`)
          .join(", ")}`
      : "";
    for (let i = 0; i < rows.length; i += chunk) {
      const batch = rows.slice(i, i + chunk);
      const values = batch.map(() => `(${names.map(() => "?").join(", ")})`).join(", ");
      await tx.run(
        `INSERT INTO ${table} (${names.join(", ")}) VALUES ${values}${onConflict}`,
        batch.flatMap((row) => [this.project, ...row]),
      );
    }
  }

  /** Upserts rows whose JSON changed and deletes rows that disappeared, recording the affected `file`s. */
  private async sync(tx: SqlDriver, table: Table, input: SyncRow[], changed: Set<string>): Promise<void> {
    const existing = new Map<string, { file: string; json: string }>();
    for (const r of await tx.all<{ id: string; file: string; json: string }>(`SELECT id, file, json FROM ${table} WHERE project = ?`, [
      this.project,
    ])) {
      existing.set(r.id, { file: r.file, json: r.json });
    }

    const rows = unique(input, (r) => r.id);
    const extra = Object.keys(rows[0]?.columns ?? {});
    const upserts: SqlValue[][] = [];
    for (const row of rows) {
      const json = JSON.stringify(row.value);
      const previous = existing.get(row.id);
      existing.delete(row.id);
      if (previous?.json === json) continue;
      upserts.push([row.id, row.file, ...extra.map((c) => row.columns[c] ?? null), json]);
      changed.add(row.file);
      if (previous) changed.add(previous.file);
    }
    await this.insert(tx, table, ["id", "file", ...extra, "json"], upserts, { key: ["project", "id"] });

    const removed = [...existing.keys()];
    for (let i = 0; i < removed.length; i += MAX_PARAMS - 1) {
      const batch = removed.slice(i, i + MAX_PARAMS - 1);
      await tx.run(`DELETE FROM ${table} WHERE project = ? AND id IN (${batch.map(() => "?").join(", ")})`, [this.project, ...batch]);
    }
    for (const id of removed) changed.add(existing.get(id)!.file);
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async summary(): Promise<IndexSummary> {
    const count = async (table: string, where = ""): Promise<number> => {
      const rows = await this.db.all<{ c: number | string }>(
        `SELECT CAST(COUNT(*) AS INTEGER) AS c FROM ${table} WHERE project = ?${where}`,
        [this.project],
      );
      return Number(rows[0]?.c ?? 0);
    };
    return {
      files: await count("files"),
      functions: await count("functions"),
      apiCalls: await count("api_calls"),
      resolvedApiCalls: await count("api_calls", " AND endpoint_pattern IS NOT NULL"),
      propertyAccesses: await count("property_accesses"),
    };
  }

  /** JSON values of the rows `sql` selects; `sql` filters on `project = ?` first. */
  private async rows<T>(sql: string, ...params: SqlValue[]): Promise<T[]> {
    const rows = await this.db.all<{ json: string }>(sql, [this.project, ...params]);
    return rows.map((r) => JSON.parse(r.json) as T);
  }

  listFiles(): Promise<FileInfo[]> {
    return this.rows("SELECT json FROM files WHERE project = ? ORDER BY id");
  }

  listFunctions(): Promise<FunctionInfo[]> {
    return this.rows("SELECT json FROM functions WHERE project = ? ORDER BY file, id");
  }

  listApiCalls(): Promise<ApiCallInfo[]> {
    return this.rows("SELECT json FROM api_calls WHERE project = ? ORDER BY file, id");
  }

  listPropertyAccesses(): Promise<PropertyAccessInfo[]> {
    return this.rows("SELECT json FROM property_accesses WHERE project = ? ORDER BY file, id");
  }

  listRoutes(): Promise<RouteInfo[]> {
    return this.rows("SELECT json FROM routes WHERE project = ? ORDER BY id");
  }

  findApiCallsByEndpoint(method: string, endpointPattern: string): Promise<ApiCallInfo[]> {
    return this.rows(
      "SELECT json FROM api_calls WHERE project = ? AND method = ? AND endpoint_pattern = ? ORDER BY file, id",
      method,
      endpointPattern,
    );
  }

  findPropertyAccessesForApiCall(apiCallId: string): Promise<PropertyAccessInfo[]> {
    return this.rows("SELECT json FROM property_accesses WHERE project = ? AND api_call_id = ? ORDER BY file, id", apiCallId);
  }

  // ---- relations

  async hasRelations(): Promise<boolean> {
    return (await this.getMeta("relations.generatedAt")) !== null;
  }

  async relationsBuiltWith(config: TacetConfig): Promise<boolean> {
    return (await this.getMeta("relations.config")) === JSON.stringify(config);
  }

  async getEntity(id: string): Promise<OntologyEntity | null> {
    const [entity] = await this.rows<OntologyEntity>("SELECT json FROM entities WHERE project = ? AND id = ?", id);
    return entity ?? null;
  }

  findEntitiesByKey(key: string, cls?: string): Promise<OntologyEntity[]> {
    const match = "project = ? AND (id = ? OR label = ? OR route_path = ? OR component = ?)";
    return cls
      ? this.rows(`SELECT json FROM entities WHERE ${match} AND class = ? ORDER BY id`, key, key, key, key, cls)
      : this.rows(`SELECT json FROM entities WHERE ${match} ORDER BY id`, key, key, key, key);
  }

  queryRelations(query: RelationQuery = {}): Promise<OntologyTriple[]> {
    const where = ["project = ?"];
    const params: SqlValue[] = [];
    for (const key of ["subject", "predicate", "object"] as const) {
      if (query[key] !== undefined) {
        where.push(`${key} = ?`);
        params.push(query[key]!);
      }
    }
    const limit = query.limit ? ` LIMIT ${Math.max(1, Math.floor(query.limit))}` : "";
    return this.rows(`SELECT json FROM relations WHERE ${where.join(" AND ")} ORDER BY subject, predicate, object${limit}`, ...params);
  }

  async pageApis(by: { page?: string; endpoint?: string }): Promise<StoredPageApi[]> {
    const [column, value] = by.page !== undefined ? ["page", by.page] : ["endpoint", by.endpoint ?? ""];
    const rows = await this.db.all<{
      page: string;
      endpoint: string;
      api_key: string;
      status: string | null;
      via: string;
      fields: string;
      common: number;
    }>(
      `SELECT page, endpoint, api_key, status, via, fields, common FROM page_apis WHERE project = ? AND ${column} = ? ORDER BY page, common, api_key`,
      [this.project, value],
    );
    return rows.map((r) => ({
      page: r.page,
      endpoint: r.endpoint,
      apiKey: r.api_key,
      status: r.status as PageApiUse["status"],
      via: JSON.parse(r.via) as string[],
      fields: JSON.parse(r.fields) as string[],
      ...(Number(r.common) ? { common: true } : {}),
    }));
  }

  async relatedPages(page: string): Promise<Array<Omit<RelatedPage, "route" | "component">>> {
    const rows = await this.db.all<{ related: string; shared: number; apis: string }>(
      "SELECT related, shared, apis FROM related_pages WHERE project = ? AND page = ? ORDER BY shared DESC, related",
      [this.project, page],
    );
    return rows.map((r) => ({ page: r.related, shared: Number(r.shared), apis: JSON.parse(r.apis) as string[] }));
  }

  async readFrontendManifest(): Promise<FrontendManifest | null> {
    if ((await this.getMeta("language")) === null) return null;
    return {
      language: "typescript",
      rootDir: (await this.getMeta("rootDir")) ?? "",
      generatedAt: (await this.getMeta("generatedAt")) ?? "",
      files: await this.listFiles(),
      functions: await this.listFunctions(),
      apiCalls: await this.listApiCalls(),
      propertyAccesses: await this.listPropertyAccesses(),
      routes: await this.listRoutes(),
    };
  }

  async readBackendManifest(): Promise<BackendManifest | null> {
    if ((await this.getMeta("backend.language")) === null) return null;
    const meta = async (key: string, fallback: string) => (await this.getMeta(key)) ?? fallback;
    return {
      language: "java",
      rootDir: await meta("backend.rootDir", ""),
      generatedAt: await meta("backend.generatedAt", ""),
      endpoints: await this.rows<EndpointInfo>("SELECT json FROM endpoints WHERE project = ? ORDER BY path, method"),
      dtos: await this.rows<DtoInfo>("SELECT json FROM dtos WHERE project = ? ORDER BY id"),
      enums: await this.rows<EnumInfo>("SELECT json FROM enums WHERE project = ? ORDER BY id"),
      serviceCalls: await this.rows<ServiceCallInfo>("SELECT json FROM service_calls WHERE project = ? ORDER BY id"),
      gatewayRoutes: JSON.parse(await meta("backend.gatewayRoutes", "[]")),
      contextPaths: JSON.parse(await meta("backend.contextPaths", "[]")),
      warnings: JSON.parse(await meta("backend.warnings", "[]")),
    };
  }
}

/** Last occurrence wins, like the per-row upserts the store used to do; keeps first-seen order. */
function unique<T>(items: T[], key: (item: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const item of items) byKey.set(key(item), item);
  return [...byKey.values()];
}

function stringAttribute(entity: OntologyEntity, name: string): string | null {
  const value = (entity.attributes as Record<string, unknown> | undefined)?.[name];
  return typeof value === "string" ? value : null;
}
