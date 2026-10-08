import { DatabaseSync, type SQLInputValue } from "node:sqlite";
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
} from "../ir/types.js";
import type { Ontology, OntologyEntity, OntologyTriple, PageApiUse, RelatedPage } from "../analysis/ontology.js";
import { RELATION_TABLES, SCHEMA_SQL, SCHEMA_VERSION, TABLES } from "./schema.js";

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

type Table = (typeof TABLES)[number];

interface SyncRow {
  id: string;
  file: string;
  columns: Record<string, SQLInputValue>;
  value: unknown;
}

/** SQLite-backed cache of frontend and backend manifests. The only module that knows about SQL. */
export class IndexStore {
  private constructor(private readonly db: DatabaseSync) {
    const version = this.tableExists("index_meta") ? this.getMeta("schemaVersion") : null;
    if (version !== null && version !== String(SCHEMA_VERSION)) {
      // The index is derived data; an old layout is simply rebuilt.
      for (const table of [...TABLES, ...RELATION_TABLES, "index_meta"]) this.db.exec(`DROP TABLE IF EXISTS ${table}`);
    }
    this.db.exec(SCHEMA_SQL);
    this.setMeta("schemaVersion", String(SCHEMA_VERSION));
  }

  static open(dbPath: string): IndexStore {
    return new IndexStore(new DatabaseSync(dbPath));
  }

  close(): void {
    this.db.close();
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /** The config used when the frontend was indexed, so later queries link endpoints the same way. */
  writeConfig(config: TacetConfig): void {
    this.setMeta("config", JSON.stringify(config));
  }

  readConfig(): TacetConfig {
    return JSON.parse(this.getMeta("config") ?? "{}") as TacetConfig;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        "INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(key, value);
  }

  private tableExists(name: string): boolean {
    return (
      this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
      undefined
    );
  }

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  /**
   * Syncs the frontend part of the index with a manifest. Only rows that
   * actually changed are written, and the files they belong to are reported,
   * so callers can tell which parts of the frontend a code change touched.
   */
  writeManifest(manifest: FrontendManifest): FrontendIndexUpdate {
    const changed = new Set<string>();
    this.transaction(() => {
      this.sync("files", manifest.files.map((f) => ({ id: f.path, file: f.path, columns: {}, value: f })), changed);
      this.sync(
        "functions",
        manifest.functions.map((f) => ({ id: f.id, file: f.file, columns: { name: f.name }, value: f })),
        changed,
      );
      this.sync(
        "api_calls",
        manifest.apiCalls.map((c) => ({
          id: c.id,
          file: c.file,
          columns: { method: c.method, endpoint_pattern: c.endpointPattern },
          value: c,
        })),
        changed,
      );
      this.sync(
        "property_accesses",
        manifest.propertyAccesses.map((a) => ({
          id: a.id,
          file: a.file,
          columns: { api_call_id: a.apiCallId },
          value: a,
        })),
        changed,
      );
      this.sync(
        "routes",
        (manifest.routes ?? []).map((r) => ({ id: r.id, file: r.file, columns: {}, value: r })),
        changed,
      );
      this.setMeta("language", manifest.language);
      this.setMeta("rootDir", manifest.rootDir);
      this.setMeta("generatedAt", manifest.generatedAt);
    });
    return { summary: this.summary(), changedFiles: [...changed].sort() };
  }

  writeBackendManifest(manifest: BackendManifest): BackendIndexUpdate {
    const changedFiles = new Set<string>();
    const changedEndpoints = new Set<string>();
    this.transaction(() => {
      this.sync(
        "endpoints",
        manifest.endpoints.map((e) => ({
          id: e.id,
          file: e.id,
          columns: { method: e.method, path: e.path },
          value: e,
        })),
        changedEndpoints,
      );
      this.sync(
        "dtos",
        manifest.dtos.map((d) => ({ id: d.id, file: d.location.file, columns: { name: d.name }, value: d })),
        changedFiles,
      );
      this.sync(
        "enums",
        manifest.enums.map((e) => ({ id: e.id, file: e.location.file, columns: { name: e.name }, value: e })),
        changedFiles,
      );
      this.setMeta("backend.language", manifest.language);
      this.setMeta("backend.rootDir", manifest.rootDir);
      this.setMeta("backend.generatedAt", manifest.generatedAt);
      this.setMeta("backend.warnings", JSON.stringify(manifest.warnings));
    });
    return {
      endpoints: manifest.endpoints.length,
      dtos: manifest.dtos.length,
      changedEndpoints: [...changedEndpoints].sort(),
    };
  }

  /**
   * Replaces the stored relations with an ontology built from the current facts. Relations are derived data,
   * so they are rewritten as a whole (in one transaction) rather than synced row by row.
   */
  writeRelations(ontology: Ontology, config: TacetConfig = {}): { entities: number; relations: number; pageApis: number } {
    let pageApis = 0;
    this.transaction(() => {
      for (const table of RELATION_TABLES) this.db.exec(`DELETE FROM ${table}`);
      const entity = this.db.prepare(
        "INSERT INTO entities (id, class, label, file, line, status, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const e of ontology.entities) entity.run(e.id, e.class, e.label, e.file, e.line, e.status, JSON.stringify(e));
      const relation = this.db.prepare(
        "INSERT OR REPLACE INTO relations (subject, predicate, object, inferred, json) VALUES (?, ?, ?, ?, ?)",
      );
      for (const t of ontology.triples) {
        relation.run(t.subject, t.predicate, t.object, t.inferred ? 1 : 0, JSON.stringify(t));
      }
      const use = this.db.prepare(
        "INSERT OR REPLACE INTO page_apis (page, endpoint, api_key, status, via, fields, common) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const related = this.db.prepare("INSERT OR REPLACE INTO related_pages (page, related, shared, apis) VALUES (?, ?, ?, ?)");
      for (const page of ontology.pages) {
        for (const api of page.apis) {
          use.run(page.page, api.endpoint, api.apiKey, api.status, JSON.stringify(api.via), JSON.stringify(api.fields), api.common ? 1 : 0);
          pageApis++;
        }
        for (const r of page.related ?? []) related.run(page.page, r.page, r.shared, JSON.stringify(r.apis));
      }
      this.setMeta("relations.generatedAt", new Date().toISOString());
      this.setMeta("relations.config", JSON.stringify(config));
      this.setMeta("relations.commonApis", JSON.stringify(ontology.commonApis ?? null));
    });
    return { entities: ontology.entities.length, relations: ontology.triples.length, pageApis };
  }

  private transaction(work: () => void): void {
    this.db.exec("BEGIN");
    try {
      work();
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Upserts rows whose JSON changed and deletes rows that disappeared, recording the affected `file`s. */
  private sync(table: Table, rows: SyncRow[], changed: Set<string>): void {
    const existing = new Map<string, { file: string; json: string }>();
    for (const r of this.db.prepare(`SELECT id, file, json FROM ${table}`).all() as Array<{
      id: string;
      file: string;
      json: string;
    }>) {
      existing.set(r.id, { file: r.file, json: r.json });
    }

    for (const row of rows) {
      const json = JSON.stringify(row.value);
      const previous = existing.get(row.id);
      existing.delete(row.id);
      if (previous?.json === json) continue;

      const columns = { id: row.id, file: row.file, ...row.columns, json };
      const names = Object.keys(columns);
      this.db
        .prepare(
          `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})
           ON CONFLICT(id) DO UPDATE SET ${names
             .filter((n) => n !== "id")
             .map((n) => `${n} = excluded.${n}`)
             .join(", ")}`,
        )
        .run(...Object.values(columns));
      changed.add(row.file);
      if (previous) changed.add(previous.file);
    }

    const remove = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`);
    for (const [id, previous] of existing) {
      remove.run(id);
      changed.add(previous.file);
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  summary(): IndexSummary {
    const count = (sql: string): number => (this.db.prepare(sql).get() as { c: number }).c;
    return {
      files: count("SELECT COUNT(*) AS c FROM files"),
      functions: count("SELECT COUNT(*) AS c FROM functions"),
      apiCalls: count("SELECT COUNT(*) AS c FROM api_calls"),
      resolvedApiCalls: count("SELECT COUNT(*) AS c FROM api_calls WHERE endpoint_pattern IS NOT NULL"),
      propertyAccesses: count("SELECT COUNT(*) AS c FROM property_accesses"),
    };
  }

  private rows<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return (this.db.prepare(sql).all(...params) as Array<{ json: string }>).map(
      (r) => JSON.parse(r.json) as T,
    );
  }

  listFiles(): FileInfo[] {
    return this.rows("SELECT json FROM files ORDER BY id");
  }

  listFunctions(): FunctionInfo[] {
    return this.rows("SELECT json FROM functions ORDER BY file, id");
  }

  listApiCalls(): ApiCallInfo[] {
    return this.rows("SELECT json FROM api_calls ORDER BY file, id");
  }

  listPropertyAccesses(): PropertyAccessInfo[] {
    return this.rows("SELECT json FROM property_accesses ORDER BY file, id");
  }

  listRoutes(): RouteInfo[] {
    return this.rows("SELECT json FROM routes ORDER BY id");
  }

  findApiCallsByEndpoint(method: string, endpointPattern: string): ApiCallInfo[] {
    return this.rows(
      "SELECT json FROM api_calls WHERE method = ? AND endpoint_pattern = ? ORDER BY file, id",
      method,
      endpointPattern,
    );
  }

  findPropertyAccessesForApiCall(apiCallId: string): PropertyAccessInfo[] {
    return this.rows("SELECT json FROM property_accesses WHERE api_call_id = ? ORDER BY file, id", apiCallId);
  }

  // ---- relations

  hasRelations(): boolean {
    return this.getMeta("relations.generatedAt") !== null;
  }

  /** Whether the stored relations were built with this config (e.g. the same common-API rule). */
  relationsBuiltWith(config: TacetConfig): boolean {
    return this.getMeta("relations.config") === JSON.stringify(config);
  }

  getEntity(id: string): OntologyEntity | null {
    const row = this.db.prepare("SELECT json FROM entities WHERE id = ?").get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as OntologyEntity) : null;
  }

  /** Entities whose id, label, route path or page component is exactly `key`, optionally of one class. */
  findEntitiesByKey(key: string, cls?: string): OntologyEntity[] {
    const match =
      "(id = ? OR label = ? OR json_extract(json, '$.attributes.path') = ? OR json_extract(json, '$.attributes.component') = ?)";
    return cls
      ? this.rows(`SELECT json FROM entities WHERE ${match} AND class = ? ORDER BY id`, key, key, key, key, cls)
      : this.rows(`SELECT json FROM entities WHERE ${match} ORDER BY id`, key, key, key, key);
  }

  /** Relations matching every given part (entity ids), e.g. { predicate: "renders", object: "fn:..." }. */
  queryRelations(query: RelationQuery = {}): OntologyTriple[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    for (const key of ["subject", "predicate", "object"] as const) {
      if (query[key] !== undefined) {
        where.push(`${key} = ?`);
        params.push(query[key]!);
      }
    }
    const sql = `SELECT json FROM relations${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY subject, predicate, object${
      query.limit ? ` LIMIT ${Math.max(1, Math.floor(query.limit))}` : ""
    }`;
    return this.rows(sql, ...params);
  }

  /** Pages using an API (endpoint entity id), or the APIs a page uses (page entity id). */
  pageApis(by: { page?: string; endpoint?: string }): StoredPageApi[] {
    const [column, value] = by.page !== undefined ? ["page", by.page] : ["endpoint", by.endpoint ?? ""];
    const rows = this.db
      .prepare(`SELECT page, endpoint, api_key, status, via, fields, common FROM page_apis WHERE ${column} = ? ORDER BY page, common, api_key`)
      .all(value) as Array<{ page: string; endpoint: string; api_key: string; status: string | null; via: string; fields: string; common: number }>;
    return rows.map((r) => ({
      page: r.page,
      endpoint: r.endpoint,
      apiKey: r.api_key,
      status: r.status as PageApiUse["status"],
      via: JSON.parse(r.via) as string[],
      fields: JSON.parse(r.fields) as string[],
      ...(r.common ? { common: true } : {}),
    }));
  }

  /** Pages sharing the most non-common APIs with a page (page entity id). */
  relatedPages(page: string): Array<Omit<RelatedPage, "route" | "component">> {
    const rows = this.db
      .prepare("SELECT related, shared, apis FROM related_pages WHERE page = ? ORDER BY shared DESC, related")
      .all(page) as Array<{ related: string; shared: number; apis: string }>;
    return rows.map((r) => ({ page: r.related, shared: r.shared, apis: JSON.parse(r.apis) as string[] }));
  }

  /** The frontend manifest stored in the index, or null when no frontend has been indexed. */
  readFrontendManifest(): FrontendManifest | null {
    if (this.getMeta("language") === null) return null;
    return {
      language: "typescript",
      rootDir: this.getMeta("rootDir") ?? "",
      generatedAt: this.getMeta("generatedAt") ?? "",
      files: this.listFiles(),
      functions: this.listFunctions(),
      apiCalls: this.listApiCalls(),
      propertyAccesses: this.listPropertyAccesses(),
      routes: this.listRoutes(),
    };
  }

  /** The backend manifest stored in the index, or null when no backend has been extracted. */
  readBackendManifest(): BackendManifest | null {
    if (this.getMeta("backend.language") === null) return null;
    return {
      language: "java",
      rootDir: this.getMeta("backend.rootDir") ?? "",
      generatedAt: this.getMeta("backend.generatedAt") ?? "",
      endpoints: this.rows<EndpointInfo>("SELECT json FROM endpoints ORDER BY path, method"),
      dtos: this.rows<DtoInfo>("SELECT json FROM dtos ORDER BY id"),
      enums: this.rows<EnumInfo>("SELECT json FROM enums ORDER BY id"),
      warnings: JSON.parse(this.getMeta("backend.warnings") ?? "[]"),
    };
  }
}
