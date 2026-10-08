export const SCHEMA_VERSION = 5;

/**
 * The index is a cache of extractor manifests: every row keeps the full IR
 * object as JSON plus the columns needed for lookups. No foreign keys -
 * consistency comes from syncing whole manifests.
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
] as const;

/** Relation tables: the ontology derived from the facts above, rewritten whenever the facts change. */
export const RELATION_TABLES = ["entities", "relations", "page_apis", "related_pages"] as const;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, file TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS functions (
  id TEXT PRIMARY KEY, file TEXT NOT NULL, name TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_calls (
  id TEXT PRIMARY KEY, file TEXT NOT NULL, method TEXT, endpoint_pattern TEXT, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS property_accesses (
  id TEXT PRIMARY KEY, file TEXT NOT NULL, api_call_id TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS routes (id TEXT PRIMARY KEY, file TEXT NOT NULL, json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS endpoints (
  id TEXT PRIMARY KEY, file TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dtos (id TEXT PRIMARY KEY, file TEXT NOT NULL, name TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS enums (id TEXT PRIMARY KEY, file TEXT NOT NULL, name TEXT NOT NULL, json TEXT NOT NULL);

CREATE INDEX IF NOT EXISTS idx_functions_file ON functions(file);
CREATE INDEX IF NOT EXISTS idx_api_calls_endpoint ON api_calls(method, endpoint_pattern);
CREATE INDEX IF NOT EXISTS idx_api_calls_file ON api_calls(file);
CREATE INDEX IF NOT EXISTS idx_prop_access_apicall ON property_accesses(api_call_id);
CREATE INDEX IF NOT EXISTS idx_prop_access_file ON property_accesses(file);
CREATE INDEX IF NOT EXISTS idx_endpoints_method_path ON endpoints(method, path);

-- Relations (subject -predicate-> object) between pages, components, functions, APIs, controllers, DTOs and files.
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY, class TEXT NOT NULL, label TEXT NOT NULL, file TEXT, line INTEGER, status TEXT, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS relations (
  subject TEXT NOT NULL, predicate TEXT NOT NULL, object TEXT NOT NULL, inferred INTEGER NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (subject, predicate, object));
-- Which page uses which API (the inferred usesApi relation), with the call path and the response fields read.
CREATE TABLE IF NOT EXISTS page_apis (
  page TEXT NOT NULL, endpoint TEXT NOT NULL, api_key TEXT NOT NULL, status TEXT, via TEXT NOT NULL, fields TEXT NOT NULL,
  common INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (page, endpoint));
-- Pages sharing non-common APIs (common = used by a large share of all pages, e.g. a permission check).
CREATE TABLE IF NOT EXISTS related_pages (
  page TEXT NOT NULL, related TEXT NOT NULL, shared INTEGER NOT NULL, apis TEXT NOT NULL, PRIMARY KEY (page, related));

CREATE INDEX IF NOT EXISTS idx_entities_class ON entities(class);
CREATE INDEX IF NOT EXISTS idx_entities_label ON entities(label);
CREATE INDEX IF NOT EXISTS idx_relations_object ON relations(object, predicate);
CREATE INDEX IF NOT EXISTS idx_relations_predicate ON relations(predicate);
CREATE INDEX IF NOT EXISTS idx_page_apis_endpoint ON page_apis(endpoint);
`;
