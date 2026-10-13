export const SCHEMA_VERSION = 6;

export type SqlDialect = "sqlite" | "postgres";

/**
 * The index is a cache of extractor manifests: every row keeps the full IR
 * object as JSON plus the columns needed for lookups. No foreign keys -
 * consistency comes from syncing whole manifests. Every row belongs to a
 * project, so one database (e.g. a shared PostgreSQL) can hold many frontends.
 */
export const TABLES = [
  "files",
  "functions",
  "api_calls",
  "property_accesses",
  "routes",
  "endpoints",
  "dtos",
  "enums",
  "service_calls",
] as const;

/** Relation tables: the ontology derived from the facts above, rewritten whenever the facts change. */
export const RELATION_TABLES = ["entities", "relations", "page_apis", "related_pages"] as const;

export const META_TABLE = "index_meta";

/** Rows of `index_meta` with this project hold database-wide values (the schema version). */
export const GLOBAL_PROJECT = "";

/** The DDL for a dialect. Text compares bytewise in both, so results come back in the same order. */
export function schemaSql(dialect: SqlDialect): string {
  const T = dialect === "postgres" ? 'TEXT COLLATE "C"' : "TEXT";
  const fact = (table: string, extra = "") =>
    `CREATE TABLE IF NOT EXISTS ${table} (
  project ${T} NOT NULL, id ${T} NOT NULL, file ${T} NOT NULL,${extra} json TEXT NOT NULL, PRIMARY KEY (project, id));`;
  return `
CREATE TABLE IF NOT EXISTS index_meta (project ${T} NOT NULL, key ${T} NOT NULL, value TEXT NOT NULL, PRIMARY KEY (project, key));

${fact("files")}
${fact("functions", ` name ${T} NOT NULL,`)}
${fact("api_calls", ` method ${T}, endpoint_pattern ${T},`)}
${fact("property_accesses", ` api_call_id ${T} NOT NULL,`)}
${fact("routes")}

${fact("endpoints", ` method ${T} NOT NULL, path ${T} NOT NULL,`)}
${fact("dtos", ` name ${T} NOT NULL,`)}
${fact("enums", ` name ${T} NOT NULL,`)}
-- Requests the backend sends to other services (Feign / @HttpExchange clients).
${fact("service_calls", ` method ${T} NOT NULL, path ${T} NOT NULL,`)}

CREATE INDEX IF NOT EXISTS idx_functions_file ON functions(project, file);
CREATE INDEX IF NOT EXISTS idx_api_calls_endpoint ON api_calls(project, method, endpoint_pattern);
CREATE INDEX IF NOT EXISTS idx_api_calls_file ON api_calls(project, file);
CREATE INDEX IF NOT EXISTS idx_prop_access_apicall ON property_accesses(project, api_call_id);
CREATE INDEX IF NOT EXISTS idx_prop_access_file ON property_accesses(project, file);
CREATE INDEX IF NOT EXISTS idx_endpoints_method_path ON endpoints(project, method, path);

-- Relations (subject -predicate-> object) between pages, components, functions, APIs, controllers, DTOs and files.
CREATE TABLE IF NOT EXISTS entities (
  project ${T} NOT NULL, id ${T} NOT NULL, class ${T} NOT NULL, label ${T} NOT NULL, file ${T}, line INTEGER, status ${T},
  route_path ${T}, component ${T}, json TEXT NOT NULL, PRIMARY KEY (project, id));
CREATE TABLE IF NOT EXISTS relations (
  project ${T} NOT NULL, subject ${T} NOT NULL, predicate ${T} NOT NULL, object ${T} NOT NULL, inferred INTEGER NOT NULL,
  json TEXT NOT NULL, PRIMARY KEY (project, subject, predicate, object));
-- Which page uses which API (the inferred usesApi relation), with the call path and the response fields read.
CREATE TABLE IF NOT EXISTS page_apis (
  project ${T} NOT NULL, page ${T} NOT NULL, endpoint ${T} NOT NULL, api_key ${T} NOT NULL, status ${T}, via TEXT NOT NULL,
  fields TEXT NOT NULL, common INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project, page, endpoint));
-- Pages sharing non-common APIs (common = used by a large share of all pages, e.g. a permission check).
CREATE TABLE IF NOT EXISTS related_pages (
  project ${T} NOT NULL, page ${T} NOT NULL, related ${T} NOT NULL, shared INTEGER NOT NULL, apis TEXT NOT NULL,
  PRIMARY KEY (project, page, related));

CREATE INDEX IF NOT EXISTS idx_entities_class ON entities(project, class);
CREATE INDEX IF NOT EXISTS idx_entities_label ON entities(project, label);
CREATE INDEX IF NOT EXISTS idx_relations_object ON relations(project, object);
CREATE INDEX IF NOT EXISTS idx_page_apis_endpoint ON page_apis(project, endpoint);
`;
}
