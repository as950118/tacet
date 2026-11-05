import {
  ONTOLOGY_SCHEMA,
  compareEntities,
  comparePages,
  type Ontology,
  type OntologyEntity,
  type OntologyTriple,
  type PageApis,
  type RelatedPage,
} from "../analysis/ontology.js";
import type { IndexStore } from "./index-store.js";

export interface FocusOptions {
  /** Relations to follow from the entities matching the query (default 2). */
  depth?: number;
  /** Keep File entities and definedIn triples (default true, like `buildOntology`). */
  includeFiles?: boolean;
  /**
   * Ids from {@link IndexStore.unrelatedFrontendIds}: the frontend functions the pruned ontology leaves out. Pass the
   * same set for every query against one index state; computing it is the only whole-graph step.
   */
  unrelated: ReadonlySet<string>;
}

/**
 * What `focusOntology(buildOntology(model), query, depth)` returns, read from the relations the index stores instead
 * of rebuilt from the whole model: a few queries around the matching entities rather than every file, function and API
 * call of the project. The stored relations keep functions the default ontology prunes; `unrelated` removes them.
 */
export async function focusFromRelations(store: IndexStore, query: string, options: FocusOptions): Promise<Ontology> {
  const includeFiles = options.includeFiles ?? true;
  const depth = options.depth ?? 2;
  const visible = (e: OntologyEntity) => !options.unrelated.has(e.id) && (includeFiles || e.class !== "File");
  const visibleTriple = (t: OntologyTriple, known: Map<string, OntologyEntity>) => {
    const s = known.get(t.subject), o = known.get(t.object);
    return s !== undefined && o !== undefined && visible(s) && visible(o) && (includeFiles || t.predicate !== "definedIn");
  };

  const known = new Map<string, OntologyEntity>();
  const learn = async (ids: string[]) => {
    const missing = [...new Set(ids)].filter((id) => !known.has(id));
    for (const e of await store.getEntities(missing)) known.set(e.id, e);
  };

  const seeds = (await store.findFocusSeeds(query, includeFiles)).filter(visible);
  for (const e of seeds) known.set(e.id, e);
  const seedIds = new Set(seeds.map((e) => e.id));
  const keep = new Set(seedIds);

  let frontier = [...keep];
  for (let d = 0; d < depth && frontier.length; d++) {
    // Entities at either end are looked up first: a triple only counts when both ends are in the pruned ontology.
    const around = await store.relationsAround(frontier);
    await learn(around.flatMap((t) => [t.subject, t.object]));
    const neighbors = new Map<string, string[]>();
    const link = (a: string, b: string) => (neighbors.get(a) ?? neighbors.set(a, []).get(a)!).push(b);
    for (const t of around) {
      if (!visibleTriple(t, known)) continue;
      if (t.predicate === "definedIn" && !seedIds.has(t.object)) continue;
      link(t.subject, t.object);
      link(t.object, t.subject);
    }
    const next: string[] = [];
    for (const id of frontier) {
      // Do not expand through hubs that connect everything (files, generic envelopes).
      if (d > 0 && known.get(id)?.class === "File") continue;
      for (const n of neighbors.get(id) ?? []) {
        if (!keep.has(n)) {
          keep.add(n);
          next.push(n);
        }
      }
    }
    frontier = next;
  }

  const entities = [...keep].map((id) => known.get(id)!).sort(compareEntities);
  const triples = (await store.relationsAmong([...keep]))
    .filter((t) => visibleTriple(t, known))
    .sort((a, b) => a.subject.localeCompare(b.subject) || a.predicate.localeCompare(b.predicate) || a.object.localeCompare(b.object));

  const pages = await pagesOf(store, entities.filter((e) => e.class === "Page"));
  const stats: Ontology["stats"] = { entities: {}, triples: triples.length, inferred: triples.filter((t) => t.inferred).length };
  for (const e of entities) stats.entities[e.class] = (stats.entities[e.class] ?? 0) + 1;
  const info = await store.relationsInfo();
  return {
    schema: ONTOLOGY_SCHEMA,
    entities,
    triples,
    pages,
    stats,
    ...(info.commonApis ? { commonApis: info.commonApis } : {}),
    ...(info.rootDir !== null ? { rootDir: info.rootDir } : {}),
  };
}

/** Page rows rebuilt from `page_apis` and `related_pages`, ordered like `buildOntology` orders them. */
async function pagesOf(store: IndexStore, pageEntities: OntologyEntity[]): Promise<PageApis[]> {
  const pages: PageApis[] = [];
  const stored = await Promise.all(pageEntities.map(async (e) => ({ e, apis: await store.pageApis({ page: e.id }), related: await store.relatedPages(e.id) })));
  const relatedEntities = new Map((await store.getEntities([...new Set(stored.flatMap((s) => s.related.map((r) => r.page)))])).map((e) => [e.id, e]));
  const routeOf = (e: OntologyEntity | undefined) => ((e?.attributes.path as string | null | undefined) ?? null);
  for (const { e, apis, related } of stored) {
    const rows: RelatedPage[] = related.map((r) => {
      const other = relatedEntities.get(r.page);
      return { page: r.page, route: routeOf(other), component: String(other?.attributes.component ?? other?.label ?? r.page), shared: r.shared, apis: r.apis };
    });
    rows.sort((a, b) => b.shared - a.shared || (a.route ?? "").localeCompare(b.route ?? "") || a.page.localeCompare(b.page));
    pages.push({
      page: e.id,
      route: routeOf(e),
      component: String(e.attributes.component ?? e.label),
      file: e.file ?? "",
      apis: apis
        .map(({ page: _page, ...api }) => api)
        .sort((a, b) => a.apiKey.localeCompare(b.apiKey)),
      related: rows,
    });
  }
  return pages.sort(comparePages);
}
