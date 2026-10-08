import type { Ontology, OntologyClass, OntologyEntity } from "../analysis/ontology.js";

export interface OntologyRenderOptions {
  /** Classes to leave out (default for Mermaid: File, DtoField, Enum). */
  hideClasses?: OntologyClass[];
}

const CLASS_STYLE: Record<OntologyClass, { fill: string; stroke: string; color: string }> = {
  Page: { fill: "#fdf0e6", stroke: "#d4733a", color: "#5c2a0c" },
  Component: { fill: "#e6f6ee", stroke: "#2e9a62", color: "#0f3d26" },
  Hook: { fill: "#e5f5f7", stroke: "#1f8f9c", color: "#0b3a40" },
  Function: { fill: "#f0f2f5", stroke: "#5f6b7a", color: "#262b33" },
  ApiClient: { fill: "#eef0fd", stroke: "#5b63d6", color: "#1e2266" },
  Endpoint: { fill: "#e8f0fe", stroke: "#3b6fd8", color: "#0b2a66" },
  Controller: { fill: "#f6eefb", stroke: "#9a4fc2", color: "#3d1452" },
  Dto: { fill: "#fdf6e0", stroke: "#b88a00", color: "#4a3700" },
  DtoField: { fill: "#fbf8ef", stroke: "#c9a74a", color: "#4a3a10" },
  Enum: { fill: "#fdeef4", stroke: "#c2477a", color: "#521330" },
  File: { fill: "#f7f7f5", stroke: "#8a8a84", color: "#333" },
};

// ---------------------------------------------------------------------------
// Mermaid
// ---------------------------------------------------------------------------

/** Ontology as a Mermaid flowchart: one node style per class, predicates as edge labels. */
export function renderOntologyMermaid(ontology: Ontology, options: OntologyRenderOptions = {}): string {
  const hidden = new Set<OntologyClass>(options.hideClasses ?? ["File", "DtoField", "Enum"]);
  const visible = ontology.entities.filter((e) => !hidden.has(e.class));
  const ids = new Map(visible.map((e, i) => [e.id, `e${i}`]));
  const lines = ["flowchart LR"];
  for (const e of visible) lines.push(`  ${ids.get(e.id)}${mermaidShape(e)}`);
  for (const t of ontology.triples) {
    const from = ids.get(t.subject);
    const to = ids.get(t.object);
    if (!from || !to) continue;
    lines.push(`  ${from} ${t.inferred ? "-.->" : "-->"}|${t.predicate}| ${to}`);
  }
  for (const [cls, style] of Object.entries(CLASS_STYLE)) {
    lines.push(`  classDef ${cls} fill:${style.fill},stroke:${style.stroke},color:${style.color}`);
  }
  lines.push("  classDef broken fill:#fde8e8,stroke:#d33a3a,color:#6b1111");
  const byClass = new Map<string, string[]>();
  for (const e of visible) {
    const cls = e.class === "Endpoint" && (e.status === "not-found" || e.status === "method-mismatch") ? "broken" : e.class;
    (byClass.get(cls) ?? byClass.set(cls, []).get(cls)!).push(ids.get(e.id)!);
  }
  for (const [cls, members] of byClass) lines.push(`  class ${members.join(",")} ${cls}`);
  return lines.join("\n");
}

function mermaidShape(e: OntologyEntity): string {
  const label = `"${mermaidEscape(e.label)}<br/><small>${e.class}</small>"`;
  switch (e.class) {
    case "Page":
      return `[/${label}/]`;
    case "Component":
      return `([${label}])`;
    case "Endpoint":
      return `[[${label}]]`;
    case "Controller":
      return `{{${label}}}`;
    case "Dto":
    case "Enum":
      return `[(${label})]`;
    default:
      return `(${label})`;
  }
}

function mermaidEscape(text: string): string {
  return text.replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;");
}

// ---------------------------------------------------------------------------
// RDF / Turtle
// ---------------------------------------------------------------------------

export const TACET_ONTOLOGY_IRI = "https://tacet.dev/ontology#";
export const TACET_ENTITY_IRI = "https://tacet.dev/entity/";

/**
 * Ontology as RDF Turtle: the schema as OWL classes and object properties (with domain/range), every
 * entity as an individual with its attributes, and every triple. Loads into any triple store
 * (Jena, GraphDB, Oxigraph, …) for SPARQL queries.
 */
export function renderOntologyTurtle(ontology: Ontology): string {
  const iri = (id: string) => `<${TACET_ENTITY_IRI}${encodeURIComponent(id)}>`;
  const union = (classes: OntologyClass[]) =>
    classes.length === 1 ? `tacet:${classes[0]}` : `[ a owl:Class ; owl:unionOf ( ${classes.map((c) => `tacet:${c}`).join(" ")} ) ]`;
  const lines = [
    `@prefix tacet: <${TACET_ONTOLOGY_IRI}> .`,
    "@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .",
    "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
    "@prefix owl: <http://www.w3.org/2002/07/owl#> .",
    "@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .",
    "",
    "# ---- schema",
    "",
  ];
  for (const c of ontology.schema.classes) {
    lines.push(`tacet:${c.name} a owl:Class ; rdfs:label ${literal(c.name)} ; rdfs:comment ${literal(c.description)} .`);
  }
  lines.push("");
  for (const p of ontology.schema.predicates) {
    lines.push(
      `tacet:${p.name} a owl:ObjectProperty ;`,
      `  rdfs:domain ${union(p.domain)} ;`,
      `  rdfs:range ${union(p.range)} ;`,
      `  rdfs:comment ${literal(p.description + (p.inferred ? " (inferred)" : ""))} .`,
    );
  }
  for (const name of ["file", "line", "detail", "status"]) lines.push(`tacet:${name} a owl:DatatypeProperty .`);

  const outgoing = new Map<string, string[]>();
  for (const t of ontology.triples) {
    (outgoing.get(t.subject) ?? outgoing.set(t.subject, []).get(t.subject)!).push(`  tacet:${t.predicate} ${iri(t.object)}`);
  }
  lines.push("", "# ---- entities", "");
  for (const e of ontology.entities) {
    const props = [`  a tacet:${e.class}`, `  rdfs:label ${literal(e.label)}`];
    if (e.detail) props.push(`  tacet:detail ${literal(e.detail)}`);
    if (e.file) props.push(`  tacet:file ${literal(e.file)}`);
    if (e.line !== null) props.push(`  tacet:line ${e.line}`);
    if (e.status) props.push(`  tacet:status ${literal(e.status)}`);
    for (const [key, value] of Object.entries(e.attributes)) {
      if (value === null || key === "path" && e.class !== "Page" && e.class !== "Endpoint") continue;
      const name = key.replace(/[^A-Za-z0-9_]/g, "_");
      props.push(`  tacet:${name} ${typeof value === "string" ? literal(value) : String(value)}`);
    }
    props.push(...(outgoing.get(e.id) ?? []));
    lines.push(`${iri(e.id)}\n${props.join(" ;\n")} .`, "");
  }
  return lines.join("\n");
}

function literal(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r")}"`;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

export interface OntologyHtmlOptions {
  title: string;
  subtitle?: string;
}

/**
 * Self-contained ontology explorer (no external requests): a class-laned graph with predicate labels,
 * a Page × API matrix, a searchable triple table and the schema diagram.
 */
export function renderOntologyHtml(ontology: Ontology, options: OntologyHtmlOptions): string {
  const payload = JSON.stringify({ ontology, title: options.title, subtitle: options.subtitle ?? "", styles: CLASS_STYLE })
    .replace(/</g, "\\u003c")
    .replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <div class="title">
    <h1 id="title"></h1>
    <p id="subtitle"></p>
  </div>
  <div id="stats" class="stats"></div>
</header>
<nav class="tabs" role="tablist">
  <button role="tab" data-tab="graph" aria-selected="true">Graph</button>
  <button role="tab" data-tab="matrix">Page ↔ API</button>
  <button role="tab" data-tab="triples">Triples</button>
  <button role="tab" data-tab="schema">Schema</button>
</nav>
<details id="common-panel" class="common-panel">
  <summary id="common-summary"></summary>
  <div id="common-body" class="common-body"></div>
</details>

<section id="tab-graph" class="tab">
  <div class="toolbar">
    <div class="searchbox">
      <input id="search" type="search" placeholder="Search pages, components, APIs, DTOs…" autocomplete="off"
        role="combobox" aria-expanded="false" aria-controls="suggest">
      <div id="suggest" class="suggest" role="listbox" hidden></div>
    </div>
    <label class="check">Depth
      <select id="depth"><option value="1">1</option><option value="2">2</option><option value="3">3</option><option value="0" selected>All</option></select>
    </label>
    <label class="check" title="Hide components and functions that lead to no API"><input id="api-paths" type="checkbox" checked> API paths only</label>
    <label class="check" title="APIs most pages use (permission checks, icon fetches) connect every page to every other"><input id="hide-common" type="checkbox" checked> Hide common APIs</label>
    <label class="check"><input id="show-all" type="checkbox"> Whole graph</label>
    <div class="zoom">
      <button id="zoom-out" title="Zoom out">−</button>
      <button id="zoom-reset" title="Reset zoom">100%</button>
      <button id="zoom-in" title="Zoom in">+</button>
    </div>
  </div>
  <details class="filters">
    <summary>Filter classes and relations</summary>
    <div class="toolbar"><div id="classes" class="chips"></div></div>
    <div class="toolbar"><div id="predicates" class="chips"></div></div>
  </details>
  <main class="graph-main">
    <aside class="nav">
      <input id="page-filter" type="search" placeholder="Filter pages…" autocomplete="off">
      <div id="page-count" class="muted small"></div>
      <div id="page-list" class="page-list"></div>
    </aside>
    <section class="canvas-wrap">
      <div id="crumbs" class="crumbs"></div>
      <section class="canvas" id="canvas"><svg id="graph" xmlns="http://www.w3.org/2000/svg"></svg><div id="empty" class="empty" hidden></div></section>
    </section>
    <aside id="details" class="details"></aside>
  </main>
</section>

<section id="tab-matrix" class="tab" hidden>
  <div id="pa-summary" class="pa-summary"></div>
  <div class="toolbar">
    <div class="segmented" role="group" aria-label="View">
      <button data-mode="pages" aria-pressed="true">Pages → APIs</button>
      <button data-mode="apis" aria-pressed="false">APIs → pages</button>
      <button data-mode="matrix" aria-pressed="false" id="mode-matrix" hidden>Matrix</button>
    </div>
    <input id="pa-filter" type="search" placeholder="Filter…" autocomplete="off">
    <label class="check"><input id="pa-broken" type="checkbox"> Only with broken APIs</label>
    <button id="pa-only-common" class="chip-on" hidden title="Show all APIs again">Only common APIs ✕</button>
    <label class="check" id="pa-common-wrap" hidden><input id="pa-common" type="checkbox"> Include common APIs</label>
    <label class="check" id="pa-unused-wrap" hidden><input id="pa-unused" type="checkbox"> Include APIs no page uses</label>
  </div>
  <main class="pa-main" id="pa-main">
    <aside class="nav"><div id="pa-count" class="muted small"></div><div id="pa-list" class="page-list"></div></aside>
    <section id="pa-detail" class="pa-detail"></section>
  </main>
  <div class="scroll" id="pa-matrix-wrap" hidden><table id="matrix" class="matrix"></table></div>
</section>

<section id="tab-triples" class="tab" hidden>
  <div class="toolbar">
    <input id="triple-search" type="search" placeholder="Filter triples…" autocomplete="off">
    <select id="triple-predicate"><option value="">All predicates</option></select>
    <span id="triple-count" class="muted"></span>
  </div>
  <div class="scroll"><table id="triples"><thead><tr><th>Subject</th><th>Predicate</th><th>Object</th><th>Evidence</th></tr></thead><tbody></tbody></table></div>
</section>

<section id="tab-schema" class="tab" hidden>
  <p class="muted pad">Classes and the relations between them (domain → range). Dashed: inferred.</p>
  <div class="canvas schema"><svg id="schema" xmlns="http://www.w3.org/2000/svg"></svg></div>
</section>

<script id="ontology-data" type="application/json">${payload}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const STYLE = `
:root {
  --bg: #f7f7f5; --panel: #ffffff; --text: #1d1d1f; --muted: #6b6b70; --line: #e2e2de;
  --edge: #b9b9b3; --accent: #3b6fd8; --broken: #d33a3a; --broken-bg: #fdecec; --unresolved: #c98100;
  --unused: #9a9a9a; --hot: #3b6fd8;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141416; --panel: #1c1c1f; --text: #ececef; --muted: #9a9aa2; --line: #2e2e33;
    --edge: #4a4a52; --accent: #7aa2f7; --broken: #f07171; --broken-bg: #361b1b; --unresolved: #e6a73a;
    --unused: #6d6d72; --hot: #7aa2f7;
  }
}
* { box-sizing: border-box; }
html, body { overflow-x: hidden; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.45 ui-sans-serif, -apple-system, "Segoe UI", "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; }
header { display: flex; flex-wrap: wrap; gap: 16px; align-items: flex-end; justify-content: space-between; padding: 20px 24px 12px; }
h1 { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: -0.01em; }
header p { margin: 4px 0 0; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
.stats { display: flex; flex-wrap: wrap; gap: 8px; }
.stat { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; min-width: 80px; }
.stat b { display: block; font-size: 18px; font-variant-numeric: tabular-nums; }
.stat span { color: var(--muted); font-size: 12px; }
.stat.alert b { color: var(--broken); }
.tabs { display: flex; gap: 4px; padding: 0 24px; border-bottom: 1px solid var(--line); margin-bottom: 12px; overflow-x: auto; }
.tabs button { border: 0; background: none; color: var(--muted); font: inherit; padding: 8px 12px; cursor: pointer;
  border-bottom: 2px solid transparent; margin-bottom: -1px; white-space: nowrap; }
.tabs button[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); font-weight: 600; }
.toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 0 24px 10px; }
input[type=search], select { padding: 8px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel);
  color: var(--text); font: inherit; }
input[type=search] { flex: 1 1 260px; max-width: 480px; }
input[type=search]:focus, select:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chips label, .check { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px;
  border: 1px solid var(--line); background: var(--panel); cursor: pointer; user-select: none; font-size: 12.5px; }
.chips input, .check input { accent-color: var(--accent); margin: 0; }
.chips .count { color: var(--muted); font-variant-numeric: tabular-nums; }
.swatch { width: 10px; height: 10px; border-radius: 3px; display: inline-block; border: 1.5px solid; }
.line-swatch { width: 16px; height: 0; border-top: 2px solid; display: inline-block; }
.zoom { display: flex; gap: 4px; margin-left: auto; }
.zoom button { min-width: 34px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel);
  color: var(--text); font: inherit; cursor: pointer; }
main { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 12px; padding: 0 24px 32px; }
main.graph-main { grid-template-columns: 260px minmax(0, 1fr) 340px; }
@media (max-width: 1200px) { main.graph-main { grid-template-columns: minmax(0, 1fr) 320px; } main.graph-main .nav { grid-column: 1 / -1; max-height: 220px; } }
@media (max-width: 900px) { main, main.graph-main { grid-template-columns: 1fr; } }
.filters { padding: 0 24px 6px; }
.filters summary { cursor: pointer; color: var(--muted); font-size: 12.5px; padding: 2px 0 8px; }
.filters .toolbar { padding-left: 0; padding-right: 0; }
.searchbox { position: relative; flex: 1 1 260px; max-width: 520px; }
.searchbox input { width: 100%; max-width: none; }
.suggest { position: absolute; z-index: 10; top: calc(100% + 4px); left: 0; right: 0; max-height: 60vh; overflow: auto;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,.14); padding: 4px; }
.suggest .group { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); padding: 8px 10px 2px; font-weight: 600; }
.suggest .opt { display: flex; gap: 8px; align-items: baseline; padding: 6px 10px; border-radius: 6px; cursor: pointer; }
.suggest .opt[aria-selected="true"], .suggest .opt:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.suggest .opt .lbl { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; word-break: break-all; }
.suggest .opt .det { color: var(--muted); font-size: 11.5px; margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 45%; }
.nav { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 6px; max-height: 76vh; min-width: 0; }
.nav input { width: 100%; max-width: none; flex: none; }
.small { font-size: 12px; }
.page-list { overflow: auto; min-height: 0; flex: 1; }
.page-item { display: block; width: 100%; text-align: left; border: 0; background: none; color: var(--text); font: inherit; padding: 6px 8px;
  border-radius: 6px; cursor: pointer; }
.page-item:hover { background: var(--bg); }
.page-item[aria-current="true"] { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.page-item .route { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; word-break: break-all; display: block; }
.page-item .meta { display: flex; gap: 6px; align-items: center; color: var(--muted); font-size: 11.5px; margin-top: 2px; }
.page-item .meta .comp { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.badge { border-radius: 999px; padding: 0 7px; font-size: 11px; border: 1px solid var(--line); white-space: nowrap; font-variant-numeric: tabular-nums; }
.badge.broken { color: var(--broken); border-color: var(--broken); }
.canvas-wrap { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.crumbs { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; font-size: 12.5px; min-height: 26px; }
.crumbs button { border: 1px solid var(--line); background: var(--panel); color: var(--text); font: inherit; border-radius: 999px; padding: 2px 10px; cursor: pointer;
  max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.crumbs button[aria-current="true"] { border-color: var(--accent); color: var(--accent); font-weight: 600; }
.crumbs .sep { color: var(--muted); }
.crumbs .count { color: var(--muted); margin-left: auto; }
.canvas { position: relative; }
.empty { padding: 28px; max-width: 620px; }
.empty h3 { margin: 0 0 6px; font-size: 16px; }
.empty p { margin: 0 0 14px; color: var(--muted); }
.empty ul { margin: 0; padding: 0; list-style: none; }
.empty li { margin: 4px 0; }
.focus-btn { margin-top: 10px; border: 1px solid var(--accent); color: var(--accent); background: none; border-radius: 6px; padding: 4px 10px; font: inherit; cursor: pointer; }
@media (max-width: 600px) { header, .toolbar, .tabs { padding-left: 16px; padding-right: 16px; } main { padding: 0 16px 24px; } }
.canvas { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: auto; height: 70vh; }
.canvas.schema { height: auto; margin: 0 24px 32px; }
.details { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; max-height: 70vh; overflow: auto; }
.details h3 { margin: 2px 0; font-size: 15px; word-break: break-all; }
.details .kind { text-transform: uppercase; font-size: 11px; letter-spacing: .06em; font-weight: 600; }
.details h4 { margin: 14px 0 4px; font-size: 12px; color: var(--muted); font-weight: 600; }
.details ul { margin: 0; padding-left: 0; list-style: none; }
.details li { margin: 2px 0; font-size: 12.5px; word-break: break-all; }
.details .ev { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
.details .attrs { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted); margin-top: 6px; }
.link { color: var(--accent); cursor: pointer; text-decoration: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.link:hover { text-decoration: underline; }
.chain { font-size: 12px; color: var(--muted); }
.muted { color: var(--muted); }
.pad { padding: 0 24px; }
svg text { fill: var(--text); font-size: 12.5px; }
svg .lane-title { fill: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; font-weight: 600; }
svg .lane { fill: var(--bg); }
.node { cursor: pointer; }
.node rect { stroke-width: 1.3; }
.node .sub { font-size: 11px; opacity: .75; }
.node.broken rect { stroke: var(--broken) !important; stroke-width: 2; }
.node.unused rect { stroke-dasharray: 4 3; opacity: .7; }
.node.selected rect { stroke-width: 2.8; }
.node.cycle rect { stroke-dasharray: 6 3; stroke-width: 2; }
.node.focus rect { stroke-width: 3; filter: drop-shadow(0 0 6px color-mix(in srgb, var(--accent) 45%, transparent)); }
.node.match rect { stroke: var(--accent) !important; stroke-width: 2.6; }
.edge { fill: none; stroke-width: 1.3; opacity: .55; }
.edge.inferred { stroke-dasharray: 6 4; }
.edge-label { font-size: 10.5px; fill: var(--muted); paint-order: stroke; stroke: var(--panel); stroke-width: 3px; display: none; }
.edge.hot { opacity: 1; stroke-width: 2.2; }
.edge-label.hot { display: block; fill: var(--text); }
.dim { opacity: .12; }
.scroll { overflow-x: auto; margin: 0 24px 16px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
@media (max-width: 600px) { .scroll { margin: 0 16px 16px; } .canvas.schema { margin: 0 16px 24px; } .pad { padding: 0 16px; } }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 7px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 12px; color: var(--muted); font-weight: 600; background: var(--bg); position: sticky; top: 0; }
td { font-size: 13px; }
td.mono, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
.matrix { width: auto; min-width: 100%; }
.matrix th.page { min-width: 220px; }
.matrix th.api, .matrix td.cell { width: 44px; }
.matrix th.api { writing-mode: vertical-rl; transform: rotate(180deg); white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-weight: 500; padding: 10px 6px; vertical-align: bottom; }
.matrix td.cell { text-align: center; padding: 6px; }
.matrix td.cell span { display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: var(--accent); cursor: help; }
.matrix td.cell span.broken { background: var(--broken); }
.matrix td.cell span.read { background: transparent; border: 2px solid var(--accent); }
.matrix th.page { white-space: nowrap; }
h2.section { font-size: 14px; margin: 20px 24px 8px; }
.pa-summary { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 24px 12px; }
.pa-summary button { text-align: left; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; color: var(--text);
  font: inherit; cursor: pointer; min-width: 120px; }
.pa-summary button b { display: block; font-size: 18px; font-variant-numeric: tabular-nums; }
.pa-summary button span { color: var(--muted); font-size: 12px; }
.pa-summary button.alert b { color: var(--broken); }
.pa-summary button[aria-pressed="true"] { border-color: var(--accent); }
.segmented { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; background: var(--panel); }
.segmented button { border: 0; background: none; color: var(--muted); font: inherit; padding: 7px 12px; cursor: pointer; }
.segmented button + button { border-left: 1px solid var(--line); }
.segmented button[aria-pressed="true"] { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--text); font-weight: 600; }
#pa-filter { flex: 1 1 220px; max-width: 420px; }
.pa-main { display: grid; grid-template-columns: 340px minmax(0, 1fr); gap: 12px; padding: 0 24px 32px; }
@media (max-width: 900px) { .pa-main { grid-template-columns: 1fr; } .pa-main .nav { max-height: 280px; } }
@media (max-width: 600px) { .pa-main, .pa-summary { padding-left: 16px; padding-right: 16px; } }
.group-head { position: sticky; top: 0; z-index: 1; display: flex; justify-content: space-between; gap: 8px; width: 100%; border: 0; text-align: left;
  font: inherit; font-size: 11.5px; font-weight: 600; letter-spacing: .04em; color: var(--muted); background: var(--panel); padding: 8px 8px 4px; cursor: pointer;
  border-bottom: 1px solid var(--line); }
.group-head .n { font-variant-numeric: tabular-nums; }
.group-head .n .bad { color: var(--broken); margin-left: 6px; }
.pa-detail { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; min-width: 0; max-height: 76vh; overflow: auto; }
.pa-detail .head { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: flex-start; justify-content: space-between; margin-bottom: 12px; }
.pa-detail h3 { margin: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 16px; word-break: break-all; }
.pa-detail .sub { color: var(--muted); font-size: 12.5px; margin-top: 3px; word-break: break-all; }
.pa-detail .counts { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.pa-detail .actions button { border: 1px solid var(--accent); color: var(--accent); background: none; border-radius: 6px; padding: 4px 10px; font: inherit; cursor: pointer; }
.pa-detail h4 { margin: 16px 0 6px; font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: .05em; }
.use { border: 1px solid var(--line); border-radius: 8px; margin: 6px 0; background: var(--bg); }
.use.bad { border-color: color-mix(in srgb, var(--broken) 55%, var(--line)); background: color-mix(in srgb, var(--broken) 7%, var(--bg)); }
.use summary { display: flex; gap: 10px; align-items: center; padding: 8px 10px; cursor: pointer; list-style: none; min-width: 0; }
.use summary::-webkit-details-marker { display: none; }
.use summary::before { content: "▸"; color: var(--muted); font-size: 11px; }
.use[open] summary::before { content: "▾"; }
.use .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; word-break: break-all; flex: 1; min-width: 0; }
.use .path small { display: block; color: var(--muted); font-family: inherit; }
.use .body { padding: 2px 12px 12px 30px; font-size: 12.5px; }
.method { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; font-weight: 700; border-radius: 4px; padding: 1px 6px; min-width: 52px;
  text-align: center; color: #fff; flex: none; }
.method.GET { background: #2f7d4f; } .method.POST { background: #3b6fd8; } .method.PUT { background: #b07400; } .method.PATCH { background: #8a5cd8; }
.method.DELETE { background: #c23b3b; } .method.ANY { background: #6b6b70; }
.steps { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin: 4px 0 8px; }
.steps .step { border: 1px solid var(--line); background: var(--panel); border-radius: 999px; padding: 1px 8px; font-size: 12px; }
.steps .arr { color: var(--muted); font-size: 11px; }
.fields { display: flex; flex-wrap: wrap; gap: 4px; }
.common-panel { margin: 0 24px 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 8px 14px; }
.common-panel > summary { cursor: pointer; font-size: 12.5px; color: var(--muted); }
.common-body { padding: 10px 0 4px; }
.common-form { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.common-form input[type=range] { width: 160px; accent-color: var(--accent); }
.common-form input[type=number] { width: 72px; padding: 4px 8px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--text); font: inherit; }
.common-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.common-list li { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 12.5px; }
.common-list .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
.tree-crumbs { display: flex; flex-wrap: wrap; gap: 2px; align-items: center; padding: 2px 4px 8px; border-bottom: 1px solid var(--line); margin-bottom: 4px;
  position: sticky; top: 0; background: var(--panel); z-index: 1; }
.tree-crumbs button { border: 0; background: none; color: var(--accent); font: inherit; font-size: 12.5px; cursor: pointer; padding: 2px 4px; border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.tree-crumbs button[aria-current="true"] { color: var(--text); font-weight: 700; cursor: default; }
.tree-crumbs .sep { color: var(--muted); font-size: 12px; }
.folder { display: flex; justify-content: space-between; gap: 8px; width: 100%; text-align: left; border: 0; background: none; color: var(--text); font: inherit;
  padding: 7px 8px; border-radius: 6px; cursor: pointer; }
.folder:hover { background: var(--bg); }
.folder .fname { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; font-weight: 600; word-break: break-all; }
.folder .fname::before { content: "▸ "; color: var(--muted); }
.folder .n { color: var(--muted); font-size: 12px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.folder .n .bad { color: var(--broken); margin-left: 6px; }
.ov-row { display: flex; gap: 10px; align-items: center; width: 100%; text-align: left; border: 1px solid var(--line); background: var(--bg); color: var(--text);
  font: inherit; border-radius: 8px; padding: 7px 10px; margin: 4px 0; cursor: pointer; }
.ov-row:hover { border-color: var(--accent); }
.ov-row.bad { border-color: color-mix(in srgb, var(--broken) 55%, var(--line)); }
.ov-row .path { flex: 1; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; word-break: break-all; }
.ov-row .path small { display: block; color: var(--muted); font-family: inherit; }
.link-btn.back { font-size: 12.5px; margin-bottom: 8px; }
.chip-on { border: 1px solid var(--accent); color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); border-radius: 999px;
  padding: 3px 10px; font: inherit; font-size: 12.5px; cursor: pointer; }
.common-form .focus-btn { margin-top: 0; }
.link-btn { border: 0; background: none; color: var(--accent); cursor: pointer; font: inherit; padding: 0; }
.pa-detail .actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: flex-start; }
.pa-detail .actions .focus-btn { margin-top: 0; }
@media (max-width: 600px) { .common-panel { margin: 0 16px 12px; } }
.related { display: flex; flex-wrap: wrap; gap: 6px; }
.related-item { display: inline-flex; gap: 8px; align-items: center; border: 1px solid var(--line); background: var(--bg); color: var(--text); font: inherit;
  border-radius: 8px; padding: 5px 10px; cursor: pointer; max-width: 100%; }
.related-item .route { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; word-break: break-all; }
.related-item:hover { border-color: var(--accent); }
.common-group { margin-top: 16px; }
.common-group > summary { cursor: pointer; color: var(--muted); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; padding: 4px 0; }
.fields code { font-size: 11.5px; background: var(--panel); border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11.5px; border: 1px solid var(--line); white-space: nowrap; }
.pill.broken { color: var(--broken); border-color: var(--broken); }
.pill.unused { color: var(--unused); }
`;

// Plain JS (no template literals) so it can live inside this TypeScript template string.
const SCRIPT = `
(function () {
  var data = JSON.parse(document.getElementById("ontology-data").textContent);
  var O = data.ontology, STY = data.styles;
  var entities = O.entities, triples = O.triples;
  var byId = new Map(entities.map(function (e) { return [e.id, e]; }));
  var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  var NS = "http://www.w3.org/2000/svg";

  document.getElementById("title").textContent = data.title;
  document.getElementById("subtitle").textContent = data.subtitle;

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function s(tag, attrs, text) { var e = document.createElementNS(NS, tag); for (var k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; }
  function clip(t, max) { return t.length > max ? t.slice(0, max - 1) + "…" : t; }
  function push(map, k, v) { if (!map.has(k)) map.set(k, []); map.get(k).push(v); }
  function colors(cls) {
    var c = STY[cls];
    return dark ? { fill: "color-mix(in srgb, " + c.stroke + " 18%, #1c1c1f)", stroke: c.stroke, text: "#ececef" } : { fill: c.fill, stroke: c.stroke, text: c.color };
  }
  function broken(e) { return e.status === "not-found" || e.status === "method-mismatch"; }
  /** An API a large share of all pages uses (permission check, icon fetch): hidden by default, it links every page to every other. */
  function isCommon(id) { var e = byId.get(id); return !!(e && e.class === "Endpoint" && e.attributes.common); }

  // ---- path trees: drill down /aws → /aws/compute → …
  function isParamSeg(x) { return x.charAt(0) === ":" || x.charAt(0) === "*" || x.charAt(0) === "{" || x.charAt(0) === "<" || x.indexOf("(") >= 0; }
  /** "/aws/compute/ami/:amiId" → ["aws", "compute", "ami"]. */
  function routeSegs(route) {
    if (route === null || route === undefined) return ["(no path)"];
    return route.split("/").filter(function (x) { return x && !isParamSeg(x); });
  }
  /** "GET /admin/v1/inventory/aws/compute/amis/{id}" → ["inventory", "aws", "compute", "amis"]: no method, role, version or params. */
  function apiSegs(e) {
    var path = (e.attributes && e.attributes.path) || e.label.split(" ").slice(1).join(" ");
    var segs = String(path).split("/").filter(function (x) { return x && !isParamSeg(x) && !/^(api|admin|user|common|console|v\\d+)$/.test(x); });
    return segs.length ? segs : ["(root)"];
  }
  function buildTree(items) {
    var root = { name: "", segs: [], children: new Map(), items: [], count: 0, bad: 0 };
    items.forEach(function (it) {
      var node = root; root.count++; if (it.bad) root.bad++;
      it.segs.forEach(function (seg) {
        if (!node.children.has(seg)) node.children.set(seg, { name: seg, segs: node.segs.concat([seg]), children: new Map(), items: [], count: 0, bad: 0 });
        node = node.children.get(seg); node.count++; if (it.bad) node.bad++;
      });
      node.items.push(it);
    });
    return root;
  }
  function subtreeItems(node, out) { node.items.forEach(function (it) { out.push(it); }); node.children.forEach(function (c) { subtreeItems(c, out); }); return out; }
  /**
   * Renders items as a drill-down tree inside "list": a breadcrumb of the scope, then its sub-folders (with item and
   * broken counts; single-child chains merged, single-item folders shown as the item) and its own items. With a
   * query, the matches anywhere under the scope are listed flat. Returns the scope node, its path and its items.
   */
  function renderTree(list, items, scope, opts) {
    list.textContent = "";
    var root = buildTree(items), node = root, path = [];
    for (var i = 0; i < scope.length; i++) { var c = node.children.get(scope[i]); if (!c) break; node = c; path.push(scope[i]); }
    var crumbs = el("div", "tree-crumbs"), all = el("button", null, "All");
    all.setAttribute("aria-current", String(!path.length)); all.onclick = function () { opts.setScope([]); };
    crumbs.appendChild(all);
    path.forEach(function (seg, i) {
      crumbs.appendChild(el("span", "sep", "/"));
      var b = el("button", null, seg); b.setAttribute("aria-current", String(i === path.length - 1));
      b.onclick = function () { opts.setScope(path.slice(0, i + 1)); };
      crumbs.appendChild(b);
    });
    list.appendChild(crumbs);
    var inScope = subtreeItems(node, []), shown = 0;
    var add = function (it) { if (shown++ < 1500) list.appendChild(opts.renderItem(it)); };
    if (opts.query) {
      inScope.slice().sort(opts.sortItems).forEach(add);
      return { node: node, path: path, items: inScope };
    }
    Array.from(node.children.values()).sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (child) {
      if (child.count === 1) { add(subtreeItems(child, [])[0]); return; }
      var label = child.name, target = child;
      while (!target.items.length && target.children.size === 1) { target = target.children.values().next().value; label += "/" + target.name; }
      var f = el("button", "folder");
      f.appendChild(el("span", "fname", label + "/"));
      var n = el("span", "n", String(child.count));
      if (child.bad) n.appendChild(el("span", "bad", child.bad + " broken"));
      f.appendChild(n);
      f.title = "Show only /" + target.segs.join("/");
      f.onclick = function () { opts.setScope(target.segs); };
      list.appendChild(f);
    });
    node.items.slice().sort(opts.sortItems).forEach(add);
    return { node: node, path: path, items: inScope };
  }

  // ---- common-API rule: project default (tacet.config.json, baked into this file) or a personal one (this browser only)
  var DEF = O.commonApis || { share: 0.25, minPages: 8, include: [], exclude: [], threshold: 0 };
  var COMMON_KEY = "tacet.commonApis:" + (O.rootDir || data.title);
  var personal = loadPersonal();
  function loadPersonal() {
    try {
      var v = JSON.parse(localStorage.getItem(COMMON_KEY) || "null");
      if (v && typeof v.share === "number" && typeof v.minPages === "number") return { share: v.share, minPages: v.minPages, include: v.include || [], exclude: v.exclude || [] };
    } catch (e) { /* storage unavailable */ }
    return null;
  }
  function savePersonal() {
    try { if (personal) localStorage.setItem(COMMON_KEY, JSON.stringify(personal)); else localStorage.removeItem(COMMON_KEY); } catch (e) { /* storage unavailable */ }
  }
  function currentRule() { return personal || { share: DEF.share, minPages: DEF.minPages, include: [], exclude: [] }; }
  var usageCount = new Map();
  O.pages.forEach(function (p) { p.apis.forEach(function (a) { usageCount.set(a.endpoint, (usageCount.get(a.endpoint) || 0) + 1); }); });
  var commonCount = 0, commonThreshold = 0;
  /** Marks common APIs by the current rule (personal overrides beat project include/exclude) and recomputes related pages. */
  function applyCommon() {
    var r = currentRule();
    commonThreshold = Math.max(r.minPages, Math.ceil(O.pages.length * r.share));
    commonCount = 0;
    entities.forEach(function (e) {
      if (e.class !== "Endpoint") return;
      var c = (usageCount.get(e.id) || 0) >= commonThreshold;
      if (DEF.include.indexOf(e.label) >= 0) c = true;
      if (DEF.exclude.indexOf(e.label) >= 0) c = false;
      if (r.include.indexOf(e.label) >= 0) c = true;
      if (r.exclude.indexOf(e.label) >= 0) c = false;
      e.attributes.common = c; e.attributes.pages = usageCount.get(e.id) || 0;
      if (c) commonCount++;
    });
    O.pages.forEach(function (p) { p.apis.forEach(function (a) { a.common = isCommon(a.endpoint); }); });
    var byApi = new Map();
    O.pages.forEach(function (p) { p.apis.forEach(function (a) { if (!a.common) push(byApi, a.endpoint, p); }); });
    O.pages.forEach(function (p) {
      var shared = new Map();
      p.apis.forEach(function (a) {
        if (a.common) return;
        (byApi.get(a.endpoint) || []).forEach(function (o) { if (o !== p) { if (!shared.has(o)) shared.set(o, []); shared.get(o).push(a.apiKey); } });
      });
      p.related = Array.from(shared.entries())
        .sort(function (x, y) { return y[1].length - x[1].length || (x[0].route || "").localeCompare(y[0].route || "") || x[0].page.localeCompare(y[0].page); })
        .slice(0, 8)
        .map(function (x) { return { page: x[0].page, route: x[0].route, component: x[0].component, shared: x[1].length, apis: x[1].slice(0, 10) }; });
    });
  }
  applyCommon();

  /** Personal override for one API: true = always common, false = never, null = follow the rule. */
  function setCommonOverride(label, value) {
    var r = currentRule();
    personal = { share: r.share, minPages: r.minPages, include: r.include.filter(function (x) { return x !== label; }), exclude: r.exclude.filter(function (x) { return x !== label; }) };
    if (value === true) personal.include.push(label);
    if (value === false) personal.exclude.push(label);
    commonChanged();
  }
  function commonChanged() {
    savePersonal(); applyCommon();
    buildPageRows(); buildPaItems();
    renderCommonPanel(); draw(); renderDetails(); renderPa();
  }
  function commonToggle(e) {
    var b = el("button", "focus-btn", e.attributes.common ? "Don't treat as common" : "Treat as common");
    b.onclick = function () { setCommonOverride(e.label, !e.attributes.common); };
    return b;
  }

  function renderCommonPanel() {
    var r = currentRule();
    document.getElementById("common-summary").textContent = "Common APIs: " + commonCount + " hidden · used by ≥ " + Math.round(r.share * 100) +
      "% of pages, at least " + r.minPages + " (≥ " + commonThreshold + " pages) · " + (personal ? "your setting" : "project default");
    var body = document.getElementById("common-body"); body.textContent = "";
    var form = el("div", "common-form");
    var shareLabel = el("label", "check", "Share of pages ");
    var share = el("input"); share.type = "range"; share.min = "5"; share.max = "100"; share.step = "5"; share.value = String(Math.round(r.share * 100));
    var shareOut = el("b", null, share.value + "%");
    share.oninput = function () { shareOut.textContent = share.value + "%"; };
    share.onchange = function () { personal = { share: Number(share.value) / 100, minPages: r.minPages, include: r.include, exclude: r.exclude }; commonChanged(); };
    shareLabel.appendChild(share); shareLabel.appendChild(shareOut); form.appendChild(shareLabel);
    var minLabel = el("label", "check", "At least ");
    var min = el("input"); min.type = "number"; min.min = "1"; min.max = String(Math.max(1, O.pages.length)); min.value = String(r.minPages);
    min.onchange = function () {
      var v = Math.max(1, Math.floor(Number(min.value) || 1));
      personal = { share: r.share, minPages: v, include: r.include, exclude: r.exclude }; commonChanged();
    };
    minLabel.appendChild(min); minLabel.appendChild(document.createTextNode(" pages")); form.appendChild(minLabel);
    if (commonCount) {
      var show = el("button", "focus-btn", "Show in Page ↔ API");
      show.onclick = function () { openApis(null, true); };
      form.appendChild(show);
    }
    if (personal) {
      var reset = el("button", "focus-btn", "Reset to project default");
      reset.onclick = function () { personal = null; commonChanged(); };
      form.appendChild(reset);
    }
    body.appendChild(form);
    body.appendChild(el("p", "muted small", "Saved in this browser only. The project default (" + Math.round(DEF.share * 100) + "%, at least " + DEF.minPages +
      " pages" + (DEF.include.length || DEF.exclude.length ? ", " + DEF.include.length + " always / " + DEF.exclude.length + " never" : "") +
      ") comes from commonApis in tacet.config.json and is what the index database, CLI and MCP use."));
    var list = entities.filter(function (e) { return e.class === "Endpoint" && (e.attributes.common || r.exclude.indexOf(e.label) >= 0); })
      .sort(function (a, b) { return (b.attributes.pages || 0) - (a.attributes.pages || 0) || a.label.localeCompare(b.label); });
    if (!list.length) { body.appendChild(el("p", "muted small", "No API is common with this rule.")); return; }
    var ul = el("ul", "common-list");
    list.forEach(function (e) {
      var li = el("li"), k = splitKey(e.label);
      li.appendChild(methodBadge(k.method));
      var open = el("button", "link-btn path", k.path);
      open.title = "Show the pages using this API";
      open.onclick = function () { openApis(e.id, e.attributes.common); };
      li.appendChild(open);
      li.appendChild(el("span", "badge", e.attributes.pages + " pages"));
      var why = r.include.indexOf(e.label) >= 0 ? "always (yours)" : r.exclude.indexOf(e.label) >= 0 ? "never (yours)" :
        DEF.include.indexOf(e.label) >= 0 ? "always (project)" : DEF.exclude.indexOf(e.label) >= 0 ? "never (project)" : "";
      if (why) li.appendChild(el("span", "badge", why));
      var b = el("button", "link-btn", e.attributes.common ? "Not common" : "Undo");
      b.onclick = function () { setCommonOverride(e.label, e.attributes.common ? false : null); };
      li.appendChild(b);
      ul.appendChild(li);
    });
    body.appendChild(ul);
  }

  // ---- stats
  var statsEl = document.getElementById("stats");
  var brokenCount = entities.filter(function (e) { return e.class === "Endpoint" && broken(e); }).length;
  [["Pages", O.stats.entities.Page || 0], ["Components", O.stats.entities.Component || 0], ["APIs", O.stats.entities.Endpoint || 0],
   ["DTOs", O.stats.entities.Dto || 0], ["Triples", O.stats.triples]].concat(brokenCount ? [["Broken APIs", brokenCount, true]] : [])
    .forEach(function (x) { var d = el("div", "stat" + (x[2] ? " alert" : "")); d.appendChild(el("b", null, String(x[1]))); d.appendChild(el("span", null, x[0])); statsEl.appendChild(d); });

  // ---- tabs
  var tabs = document.querySelectorAll(".tabs button");
  function showTab(name) {
    tabs.forEach(function (b) { b.setAttribute("aria-selected", String(b.dataset.tab === name)); });
    document.querySelectorAll(".tab").forEach(function (t) { t.hidden = t.id !== "tab-" + name; });
  }
  tabs.forEach(function (b) { b.onclick = function () { showTab(b.dataset.tab); }; });

  // ================================================================ graph
  var LANES = [["Page"], ["Component", "Hook"], ["Function", "ApiClient"], ["Endpoint"], ["Controller"], ["Dto", "Enum"], ["DtoField"], ["File"]];
  var LANE_W = [230, 220, 220, 360, 210, 230, 240, 250];
  var laneOf = {}; LANES.forEach(function (l, i) { l.forEach(function (c) { laneOf[c] = i; }); });
  var hiddenClasses = new Set(["File", "DtoField", "Enum"]);
  var hiddenPredicates = new Set(["definedIn", "usesApi"]);
  var PRED_COLOR = { showsComponent: "#d4733a", renders: "#2e9a62", calls: "#5f6b7a", requests: "#3b6fd8", reads: "#8a5cd8",
    usesApi: "#d4733a", handledBy: "#9a4fc2", accepts: "#b88a00", returns: "#b88a00", hasField: "#c9a74a", typedAs: "#c2477a", definedIn: "#8a8a84" };
  var SMALL_GRAPH = 150, LARGE_VIEW = 400;

  function chips(container, items, hidden, onChange) {
    items.forEach(function (it) {
      var label = el("label"); var cb = el("input"); cb.type = "checkbox"; cb.checked = !hidden.has(it.key); cb.dataset.key = it.key;
      label.appendChild(cb); label.appendChild(it.swatch); label.appendChild(document.createTextNode(it.label));
      if (it.count != null) label.appendChild(el("span", "count", String(it.count)));
      cb.onchange = function () { if (cb.checked) hidden.delete(it.key); else hidden.add(it.key); onChange(); };
      container.appendChild(label);
    });
  }
  var classCounts = {}; entities.forEach(function (e) { classCounts[e.class] = (classCounts[e.class] || 0) + 1; });
  chips(document.getElementById("classes"), O.schema.classes.filter(function (c) { return classCounts[c.name]; }).map(function (c) {
    var sw = el("span", "swatch"); var col = colors(c.name); sw.style.background = col.fill; sw.style.borderColor = col.stroke;
    return { key: c.name, label: c.name, swatch: sw, count: classCounts[c.name] };
  }), hiddenClasses, rebuild);
  var predCounts = {}; triples.forEach(function (t) { predCounts[t.predicate] = (predCounts[t.predicate] || 0) + 1; });
  chips(document.getElementById("predicates"), O.schema.predicates.filter(function (p) { return predCounts[p.name]; }).map(function (p) {
    var sw = el("span", "line-swatch"); sw.style.borderColor = PRED_COLOR[p.name]; if (p.inferred) sw.style.borderTopStyle = "dashed";
    return { key: p.name, label: p.name, swatch: sw, count: predCounts[p.name] };
  }), hiddenPredicates, rebuild);

  // Adjacency over the classes and relations currently shown.
  // pOut / pIn leave out "reads": a shared formatter reading some API's data is not a path to that API.
  var gOut = new Map(), gIn = new Map(), pOut = new Map(), pIn = new Map(), shownTriples = [];
  function rebuildAdjacency() {
    gOut = new Map(); gIn = new Map(); pOut = new Map(); pIn = new Map();
    shownTriples = triples.filter(function (t) {
      return !hiddenPredicates.has(t.predicate) && !hiddenClasses.has(byId.get(t.subject).class) && !hiddenClasses.has(byId.get(t.object).class);
    });
    shownTriples.forEach(function (t) {
      push(gOut, t.subject, t.object); push(gIn, t.object, t.subject);
      if (t.predicate !== "reads") { push(pOut, t.subject, t.object); push(pIn, t.object, t.subject); }
    });
  }
  function walk(start, adj, depth, skip) {
    var seen = new Map([[start, 0]]), q = [start];
    while (q.length) {
      var id = q.shift(), d = seen.get(id);
      if (depth && d >= depth) continue;
      (adj.get(id) || []).forEach(function (next) {
        if (!seen.has(next) && !(skip && skip(next))) { seen.set(next, d + 1); q.push(next); }
      });
    }
    return seen;
  }

  var svg = document.getElementById("graph"), emptyEl = document.getElementById("empty");
  var H = 46, GX = 64, GY = 10, PADX = 20, PADY = 44;
  var xy = new Map(), wOf = new Map(), nodeEls = new Map(), edgeEls = [], width = 0, height = 0;
  var viewIds = new Set(), vOut = new Map(), vIn = new Map();
  var focusId = null, history = [], selected = null, query = "";
  var depthSel = document.getElementById("depth"), showAll = document.getElementById("show-all"), apiPaths = document.getElementById("api-paths");
  var hideCommon = document.getElementById("hide-common");
  var repOf = new Map(), cycleMembers = new Map();
  var shownCount = entities.filter(function (e) { return !hiddenClasses.has(e.class); }).length;
  showAll.checked = shownCount <= SMALL_GRAPH;

  /** The entities to draw: the focused entity with everything upstream and downstream of it, or the whole graph. */
  function computeView() {
    if (focusId && !hiddenClasses.has(byId.get(focusId).class)) {
      var depth = Number(depthSel.value), ids = new Set();
      var skip = hideCommon.checked ? function (id) { return id !== focusId && isCommon(id); } : null;
      var down = apiPaths.checked ? onApiPaths(walk(focusId, pOut, depth, skip)) : walk(focusId, gOut, depth, skip);
      down.forEach(function (_, id) { ids.add(id); });
      walk(focusId, gIn, depth, skip).forEach(function (_, id) { ids.add(id); });
      return ids;
    }
    if (showAll.checked) {
      return new Set(entities.filter(function (e) { return !hiddenClasses.has(e.class) && !(hideCommon.checked && isCommon(e.id)); }).map(function (e) { return e.id; }));
    }
    return new Set();
  }

  var API_SIDE = new Set(["Endpoint", "Controller", "Dto", "Enum", "DtoField"]);
  /**
   * Of the downstream entities, those on a call path to a resolved API (or the backend side): drops UI components
   * that only render, and icon/asset fetches whose URL is unknown.
   */
  function onApiPaths(down) {
    var keep = new Map(), q = [];
    down.forEach(function (d, id) {
      var e = byId.get(id);
      if ((API_SIDE.has(e.class) && e.status !== "unresolved") || id === focusId) { keep.set(id, d); q.push(id); }
    });
    while (q.length) {
      (pIn.get(q.shift()) || []).forEach(function (prev) { if (down.has(prev) && !keep.has(prev)) { keep.set(prev, down.get(prev)); q.push(prev); } });
    }
    return keep;
  }

  function rebuild() { rebuildAdjacency(); draw(); }

  /**
   * Components and functions that render or call each other in a loop (A → B → A) are drawn as one node, so every
   * drawn edge points one way. Returns the view's relations with each cycle's members mapped to its first member.
   */
  function collapseCycles(vt) {
    var adj = new Map();
    vt.forEach(function (t) { if (t.predicate === "calls" || t.predicate === "renders") push(adj, t.subject, t.object); });
    var index = 0, idx = new Map(), low = new Map(), stack = [], on = new Set();
    repOf = new Map(); cycleMembers = new Map();
    adj.forEach(function (_, root) {
      if (idx.has(root)) return;
      var work = [[root, 0]];
      idx.set(root, index); low.set(root, index); index++; stack.push(root); on.add(root);
      while (work.length) {
        var top = work[work.length - 1], v = top[0], next = adj.get(v) || [];
        if (top[1] < next.length) {
          var w = next[top[1]++];
          if (!idx.has(w)) { idx.set(w, index); low.set(w, index); index++; stack.push(w); on.add(w); work.push([w, 0]); }
          else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
        } else {
          work.pop();
          if (work.length) { var u = work[work.length - 1][0]; low.set(u, Math.min(low.get(u), low.get(v))); }
          if (low.get(v) === idx.get(v)) {
            var comp = [], x;
            do { x = stack.pop(); on.delete(x); comp.push(x); } while (x !== v);
            if (comp.length > 1) {
              comp.sort(function (a, b) { return byId.get(a).label.localeCompare(byId.get(b).label); });
              comp.forEach(function (c) { repOf.set(c, comp[0]); });
              cycleMembers.set(comp[0], comp);
            }
          }
        }
      }
    });
    if (!cycleMembers.size) return vt;
    var seen = new Set(), out = [];
    vt.forEach(function (t) {
      var a = repOf.get(t.subject) || t.subject, b = repOf.get(t.object) || t.object, key = a + "\u0000" + t.predicate + "\u0000" + b;
      if (a === b || seen.has(key)) return;
      seen.add(key);
      out.push(a === t.subject && b === t.object ? t : { subject: a, predicate: t.predicate, object: b, inferred: t.inferred, evidence: t.evidence });
    });
    return out;
  }
  function shown(id) { return repOf.get(id) || id; }

  function draw() {
    svg.textContent = "";
    viewIds = computeView();
    renderCrumbs();
    renderPageList();
    emptyEl.hidden = viewIds.size > 0;
    svg.style.display = viewIds.size ? "" : "none";
    if (!viewIds.size) { renderEmpty(); return; }

    var vt = collapseCycles(shownTriples.filter(function (t) { return viewIds.has(t.subject) && viewIds.has(t.object); }));
    vOut = new Map(); vIn = new Map();
    vt.forEach(function (t) { push(vOut, t.subject, t.object); push(vIn, t.object, t.subject); });
    var lanes = LANES.map(function () { return []; });
    entities.forEach(function (e) { if (viewIds.has(e.id) && !(repOf.has(e.id) && repOf.get(e.id) !== e.id)) lanes[laneOf[e.class]].push(e); });
    var used = lanes.map(function (l, i) { return { i: i, nodes: l }; }).filter(function (l) { return l.nodes.length; });
    used.forEach(function (l) { l.nodes.sort(function (a, b) { return a.class.localeCompare(b.class) || a.label.localeCompare(b.label); }); });
    var pos = new Map();
    function index() { used.forEach(function (l) { l.nodes.forEach(function (n, i) { pos.set(n.id, i); }); }); }
    function bary(n, adj) {
      var ns = (adj.get(n.id) || []).filter(function (id) { return pos.has(id); });
      if (!ns.length) return pos.get(n.id);
      return ns.reduce(function (sum, id) { return sum + pos.get(id); }, 0) / ns.length;
    }
    index();
    for (var sweep = 0; sweep < 6; sweep++) {
      for (var r = 1; r < used.length; r++) { used[r].nodes.sort(function (a, b) { return bary(a, vIn) - bary(b, vIn); }); index(); }
      for (var r2 = used.length - 2; r2 >= 0; r2--) { used[r2].nodes.sort(function (a, b) { return bary(a, vOut) - bary(b, vOut); }); index(); }
    }
    var tallest = Math.max.apply(null, used.map(function (l) { return l.nodes.length; }).concat([1]));
    height = PADY + tallest * (H + GY) + 24;
    xy = new Map(); wOf = new Map();
    var x = PADX;
    used.forEach(function (l) {
      var w = LANE_W[l.i];
      svg.appendChild(s("rect", { "class": "lane", x: x - 8, y: 8, width: w + 16, height: height - 16, rx: 10 }));
      svg.appendChild(s("text", { "class": "lane-title", x: x, y: 28 }, LANES[l.i].join(" · ") + "  " + l.nodes.length));
      l.nodes.forEach(function (n, i) { xy.set(n.id, { x: x, y: PADY + i * (H + GY) }); wOf.set(n.id, w); });
      x += w + GX;
    });
    width = x - GX + PADX;

    var edgeLayer = s("g", {}), labelLayer = s("g", {}), nodeLayer = s("g", {});
    svg.appendChild(edgeLayer); svg.appendChild(nodeLayer); svg.appendChild(labelLayer);
    edgeEls = [];
    vt.forEach(function (t) {
      var a = xy.get(t.subject), b = xy.get(t.object), wa = wOf.get(t.subject), wb = wOf.get(t.object);
      var d, lx, ly;
      if (a.x === b.x) {
        var x1 = a.x + wa, y1 = a.y + H / 2, y2 = b.y + H / 2, bulge = 30 + Math.min(40, Math.abs(y2 - y1) / 6);
        d = "M" + x1 + "," + y1 + " C" + (x1 + bulge) + "," + y1 + " " + (x1 + bulge) + "," + y2 + " " + x1 + "," + y2;
        lx = x1 + bulge * 0.8; ly = (y1 + y2) / 2;
      } else {
        var fwd = b.x > a.x;
        var sx = fwd ? a.x + wa : a.x, sy = a.y + H / 2, ex = fwd ? b.x : b.x + wb, ey = b.y + H / 2, mx = (sx + ex) / 2;
        d = "M" + sx + "," + sy + " C" + mx + "," + sy + " " + mx + "," + ey + " " + ex + "," + ey;
        lx = mx; ly = (sy + ey) / 2;
      }
      var p = s("path", { d: d, "class": "edge" + (t.inferred ? " inferred" : ""), stroke: PRED_COLOR[t.predicate] || "var(--edge)" });
      p.appendChild(s("title", {}, byId.get(t.subject).label + "  —" + t.predicate + "→  " + byId.get(t.object).label));
      edgeLayer.appendChild(p);
      var label = s("text", { "class": "edge-label", x: lx, y: ly - 3, "text-anchor": "middle" }, t.predicate);
      labelLayer.appendChild(label);
      edgeEls.push({ el: p, label: label, t: t });
    });
    nodeEls = new Map();
    entities.forEach(function (n) {
      var p = xy.get(n.id); if (!p) return;
      var col = colors(n.class), w = wOf.get(n.id), chars = Math.floor((w - 20) / 7.2);
      var members = cycleMembers.get(n.id);
      var g = s("g", { "class": "node" + (broken(n) ? " broken" : "") + (n.status === "unused" ? " unused" : "") + (members ? " cycle" : "") +
        (n.id === shown(focusId) ? " focus" : ""),
        transform: "translate(" + p.x + "," + p.y + ")" });
      var box = s("rect", { width: w, height: H, rx: n.class === "Page" ? 3 : n.class === "Component" ? 20 : 7 });
      box.style.fill = col.fill; box.style.stroke = col.stroke; g.appendChild(box);
      var t1 = s("text", { x: 10, y: 19, fill: col.text }, n.class === "Endpoint" ? clipPath(n.label, chars) : clip(n.label, chars));
      t1.style.fill = col.text; g.appendChild(t1);
      var subText = members ? "⟲ cycle with " + members.slice(1).map(function (m) { return byId.get(m).label; }).join(", ") : sub(n);
      var t2 = s("text", { x: 10, y: 35, "class": "sub" }, clip(subText, chars + 4)); t2.style.fill = col.text; g.appendChild(t2);
      var tip = members ? "Render/call cycle: " + members.map(function (m) { return byId.get(m).label; }).join(" ⇄ ") : n.class + ": " + n.label + (n.detail ? "\\n" + n.detail : "");
      g.appendChild(s("title", {}, tip + "\\nClick: highlight · Double-click: focus"));
      g.addEventListener("click", function (ev) { ev.stopPropagation(); select(n.id); });
      g.addEventListener("dblclick", function (ev) { ev.stopPropagation(); focus(n.id); });
      nodeLayer.appendChild(g);
      nodeEls.set(n.id, g);
    });
    applyZoom();
    refresh();
  }
  /** "GET /admin/v1/inventory/vsphere/datacenters/{id}" → "GET …/vsphere/datacenters/{id}": the end of a path says the most. */
  function clipPath(label, max) {
    if (label.length <= max) return label;
    var space = label.indexOf(" "), method = space > 0 ? label.slice(0, space + 1) : "";
    return method + "…" + label.slice(label.length - (max - method.length - 1));
  }
  function sub(n) {
    if (n.class === "Endpoint") {
      if (n.status === "unused") return "no frontend usage";
      if (n.status && n.status !== "matched" && n.status !== "no-backend") return n.status.replace("-", " ");
      return (n.detail || "").split(".").pop();
    }
    if (n.class === "Page") return n.attributes.path ? n.detail + " · " + n.attributes.source : "by convention";
    if (n.class === "DtoField") return n.detail || "";
    if (n.class === "Dto" || n.class === "Controller") return n.class;
    return n.class + (n.file ? " · " + n.file.split("/").pop() : "");
  }

  var scale = 1;
  function applyZoom() {
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    svg.setAttribute("width", width * scale); svg.setAttribute("height", height * scale);
    document.getElementById("zoom-reset").textContent = Math.round(scale * 100) + "%";
  }
  document.getElementById("zoom-in").onclick = function () { scale = Math.min(2.5, scale * 1.2); applyZoom(); };
  document.getElementById("zoom-out").onclick = function () { scale = Math.max(0.25, scale / 1.2); applyZoom(); };
  document.getElementById("zoom-reset").onclick = function () { scale = 1; applyZoom(); };
  document.getElementById("canvas").addEventListener("click", function () { select(null); });
  depthSel.onchange = draw;
  hideCommon.onchange = function () { renderPageList(); draw(); };
  apiPaths.onchange = draw;
  showAll.onchange = function () { if (showAll.checked) { focusId = null; selected = null; renderDetails(); } draw(); };

  /** Redraws the graph around one entity (history for the breadcrumbs). */
  function focus(id, fromHistory) {
    if (id && hiddenClasses.has(byId.get(id).class)) {
      hiddenClasses.delete(byId.get(id).class); syncChips(); rebuildAdjacency();
    }
    if (id && !fromHistory) {
      var at = history.indexOf(id);
      if (at >= 0) history = history.slice(0, at + 1); else history.push(id);
      if (history.length > 12) history = history.slice(-12);
    }
    focusId = id; selected = id; showAll.checked = false;
    draw(); renderDetails();
    var c = document.getElementById("canvas"); c.scrollTo({ left: 0, top: 0 });
    if (id) scrollToNode(id);
  }
  function renderCrumbs() {
    var box = document.getElementById("crumbs"); box.textContent = "";
    var home = el("button", null, "Overview"); home.setAttribute("aria-current", String(!focusId));
    home.onclick = function () { history = []; focusId = null; selected = null; draw(); renderDetails(); };
    box.appendChild(home);
    history.forEach(function (id) {
      box.appendChild(el("span", "sep", "›"));
      var e = byId.get(id), b = el("button", null, e.label); b.title = e.class + ": " + e.label;
      b.setAttribute("aria-current", String(id === focusId));
      b.onclick = function () { focus(id, true); };
      box.appendChild(b);
    });
    var total = entities.filter(function (e) { return !hiddenClasses.has(e.class); }).length;
    var info = viewIds.size ? "Showing " + viewIds.size + " of " + total : "";
    if (viewIds.size > LARGE_VIEW && focusId) info += " · large neighborhood, lower the depth to simplify";
    box.appendChild(el("span", "count", info));
  }

  function renderEmpty() {
    emptyEl.textContent = "";
    emptyEl.appendChild(el("h3", null, "Pick something to explore"));
    emptyEl.appendChild(el("p", null, (O.stats.entities.Page || 0) + " pages and " + (O.stats.entities.Endpoint || 0) +
      " APIs are too many to draw at once. Choose a page on the left or search above: the graph then shows only what it is connected to."));
    var brokenApis = entities.filter(function (e) { return e.class === "Endpoint" && broken(e); });
    if (brokenApis.length) {
      emptyEl.appendChild(el("h4", null, "APIs the backend does not have (" + brokenApis.length + ")"));
      var ul = el("ul");
      brokenApis.slice(0, 12).forEach(function (e) { var li = el("li"); li.appendChild(entityLink(e.id)); ul.appendChild(li); });
      emptyEl.appendChild(ul);
    }
  }

  // ---- page list
  var pageFilter = document.getElementById("page-filter");
  var pageRows = [];
  function buildPageRows() {
    pageRows = O.pages.map(function (p) {
      var brokenN = p.apis.filter(function (a) { return a.status === "not-found" || a.status === "method-mismatch"; }).length;
      var own = p.apis.filter(function (a) { return !a.common; }).length;
      return { p: p, broken: brokenN, bad: brokenN, own: own, segs: routeSegs(p.route), text: ((p.route || "") + " " + p.component + " " + p.file).toLowerCase() };
    });
  }
  buildPageRows();
  var pageScope = [];
  pageFilter.addEventListener("input", renderPageList);
  function renderPageList() {
    var q = pageFilter.value.trim().toLowerCase(), list = document.getElementById("page-list");
    var rows = pageRows.filter(function (r) { return !q || r.text.indexOf(q) >= 0; });
    var scoped = renderTree(list, rows, pageScope, {
      query: q,
      setScope: function (segs) { pageScope = segs; renderPageList(); },
      sortItems: function (a, b) { return (a.p.route || "").localeCompare(b.p.route || ""); },
      renderItem: pageRowButton,
    });
    document.getElementById("page-count").textContent = scoped.items.length + " of " + pageRows.length + " pages";
  }
  function pageRowButton(r) {
      var b = el("button", "page-item"); b.setAttribute("aria-current", String(r.p.page === focusId));
      b.appendChild(el("span", "route", r.p.route || r.p.component));
      var meta = el("span", "meta");
      meta.appendChild(el("span", "comp", r.p.component));
      var n = hideCommon.checked ? r.own : r.p.apis.length;
      meta.appendChild(el("span", "badge", n + " API" + (n === 1 ? "" : "s")));
      if (r.broken) meta.appendChild(el("span", "badge broken", r.broken + " broken"));
      b.appendChild(meta);
      b.onclick = function () { history = []; focus(r.p.page); };
      return b;
  }

  // ---- search with suggestions
  var search = document.getElementById("search"), suggest = document.getElementById("suggest"), options = [], active = -1;
  function matches(e) { return query !== "" && (e.label.toLowerCase().indexOf(query) >= 0 || (e.detail || "").toLowerCase().indexOf(query) >= 0); }
  function closeSuggest() { suggest.hidden = true; search.setAttribute("aria-expanded", "false"); active = -1; }
  function renderSuggest() {
    suggest.textContent = ""; options = []; active = -1;
    if (!query) { closeSuggest(); return; }
    var found = entities.filter(function (e) { return e.class !== "File" && matches(e); });
    if (!found.length) { suggest.appendChild(el("div", "group", "No matches")); suggest.hidden = false; return; }
    var byClass = new Map(); found.forEach(function (e) { push(byClass, e.class, e); });
    O.schema.classes.forEach(function (c) {
      var list = byClass.get(c.name); if (!list) return;
      suggest.appendChild(el("div", "group", c.name + " · " + list.length));
      list.slice(0, 8).forEach(function (e) {
        var o = el("div", "opt"); o.setAttribute("role", "option");
        var sw = el("span", "swatch"), col = colors(e.class); sw.style.background = col.fill; sw.style.borderColor = col.stroke;
        o.appendChild(sw); o.appendChild(el("span", "lbl", e.label)); o.appendChild(el("span", "det", e.detail || e.file || ""));
        o.onmousedown = function (ev) { ev.preventDefault(); choose(e.id); };
        suggest.appendChild(o); options.push({ el: o, id: e.id });
      });
    });
    suggest.hidden = false; search.setAttribute("aria-expanded", "true");
  }
  function choose(id) { closeSuggest(); history = []; focus(id); }
  search.addEventListener("input", function () { query = search.value.trim().toLowerCase(); renderSuggest(); refresh(); });
  search.addEventListener("blur", closeSuggest);
  search.addEventListener("focus", function () { if (query) renderSuggest(); });
  search.addEventListener("keydown", function (ev) {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      ev.preventDefault();
      if (!options.length) return;
      active = (active + (ev.key === "ArrowDown" ? 1 : options.length - 1)) % options.length;
      options.forEach(function (o, i) { o.el.setAttribute("aria-selected", String(i === active)); });
      options[active].el.scrollIntoView({ block: "nearest" });
    } else if (ev.key === "Enter") {
      var pick = options[active >= 0 ? active : 0]; if (pick) choose(pick.id);
    } else if (ev.key === "Escape") closeSuggest();
  });

  function scrollToNode(id) {
    var p = xy.get(shown(id)), c = document.getElementById("canvas"); if (!p) return;
    c.scrollTo({ left: Math.max(0, p.x * scale - 80), top: Math.max(0, p.y * scale - c.clientHeight / 2), behavior: "smooth" });
  }
  function reach(start, adj) {
    var seen = new Set([start]), q = [start];
    while (q.length) (adj.get(q.shift()) || []).forEach(function (id) { if (!seen.has(id)) { seen.add(id); q.push(id); } });
    return seen;
  }
  /** Highlights an entity's connections within the current view; outside it, focuses the graph on the entity. */
  function select(id) {
    if (id && !viewIds.has(id)) { history = []; focus(id); return; }
    selected = id ? shown(id) : id;
    refresh(); renderDetails();
  }
  function syncChips() {
    document.querySelectorAll("#classes input").forEach(function (cb) { cb.checked = !hiddenClasses.has(cb.dataset.key); });
  }
  function refresh() {
    var hl = null, sel = selected && shown(selected);
    if (sel && sel !== shown(focusId) && viewIds.has(sel)) { hl = reach(sel, vOut); reach(sel, vIn).forEach(function (id) { hl.add(id); }); }
    var whole = !focusId;
    nodeEls.forEach(function (g, id) {
      var n = byId.get(id);
      g.classList.toggle("dim", !!((hl && !hl.has(id)) || (!hl && whole && query !== "" && !matches(n))));
      g.classList.toggle("match", matches(n));
      g.classList.toggle("selected", id === sel);
    });
    edgeEls.forEach(function (x) {
      var f = shown(focusId), hot = hl ? hl.has(x.t.subject) && hl.has(x.t.object) : !!focusId && (x.t.subject === f || x.t.object === f);
      x.el.classList.toggle("hot", hot); x.label.classList.toggle("hot", hot);
      x.el.classList.toggle("dim", !!(hl && !hot) || (!hl && whole && query !== ""));
    });
  }

  function entityLink(id) {
    var e = byId.get(id), a = el("a", "link", e ? e.label : id);
    a.href = "#"; a.onclick = function (ev) { ev.preventDefault(); showTab("graph"); history = []; focus(id); };
    return a;
  }
  function renderDetails() {
    var box = document.getElementById("details");
    box.textContent = "";
    if (!selected) {
      box.appendChild(el("p", "muted", "Pick a page on the left or search for anything. The graph shows only what the chosen entity connects to, upstream and downstream. Click a node to highlight its path; double-click to focus on it."));
      return;
    }
    var n = byId.get(selected), col = colors(n.class);
    var kind = el("div", "kind", n.class + (n.status ? " · " + n.status : "")); kind.style.color = col.stroke; box.appendChild(kind);
    box.appendChild(el("h3", null, n.label));
    if (n.detail) box.appendChild(el("div", "muted", n.detail));
    if (n.file) box.appendChild(el("div", "ev", n.file + (n.line ? ":" + n.line : "")));
    var attrs = Object.keys(n.attributes).filter(function (k) { return n.attributes[k] !== null && n.attributes[k] !== ""; });
    if (attrs.length) box.appendChild(el("div", "attrs", attrs.map(function (k) { return k + " = " + n.attributes[k]; }).join("\\n")));
    if (selected !== focusId) {
      var fb = el("button", "focus-btn", "Focus graph on this"); fb.onclick = function () { focus(selected); }; box.appendChild(fb);
    }

    var cycle = cycleMembers.get(shown(n.id));
    if (cycle) section("Render/call cycle (" + cycle.length + ")", cycle.map(function (id) { return { id: id }; }));
    if (n.class === "Page") {
      var row = O.pages.find(function (p) { return p.page === n.id; });
      if (row) {
        var own = row.apis.filter(function (a) { return !a.common; }), shared = row.apis.filter(function (a) { return a.common; });
        section("Uses APIs (" + own.length + ")", own.map(function (a) { return { id: a.endpoint, chain: a.via, fields: a.fields }; }));
        section("Related pages (sharing APIs)", (row.related || []).map(function (r) { return { id: r.page, note: r.shared + " shared: " + r.apis.join(", ") }; }));
        section("Common APIs (" + shared.length + ")", shared.map(function (a) { return { id: a.endpoint }; }));
      }
    }
    if (n.class === "Endpoint") {
      if (n.attributes.common) box.appendChild(el("p", "muted", "Common API: " + n.attributes.pages + " pages use it, so it is hidden from other views."));
      box.appendChild(commonToggle(n));
    }
    if (n.class === "Endpoint") {
      var using = [];
      O.pages.forEach(function (p) { p.apis.forEach(function (a) { if (a.endpoint === n.id) using.push({ id: p.page, chain: a.via, fields: a.fields }); }); });
      section("Used by pages (" + using.length + ")", using);
    }
    var groups = new Map();
    triples.forEach(function (t) {
      if (t.subject === n.id) push(groups, t.predicate + " →", { id: t.object, ev: t.evidence });
      else if (t.object === n.id) push(groups, "← " + t.predicate, { id: t.subject, ev: t.evidence });
    });
    groups.forEach(function (items, title) { section(title + " (" + items.length + ")", items); });

    function section(title, items) {
      if (!items.length) return;
      box.appendChild(el("h4", null, title));
      var ul = el("ul");
      items.forEach(function (it) {
        var li = el("li"); li.appendChild(entityLink(it.id));
        if (it.chain) li.appendChild(el("div", "chain", it.chain.join(" → ")));
        if (it.note) li.appendChild(el("div", "chain", it.note));
        if (it.fields && it.fields.length) li.appendChild(el("div", "ev", "reads " + it.fields.join(", ")));
        (it.ev || []).forEach(function (e) { li.appendChild(el("div", "ev", e.file + ":" + e.line + "  " + e.code)); });
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
  }

  // ================================================================ page ↔ API
  var paScope = { pages: [], apis: [] }, paOnlyCommon = false, paMode = "pages", paSelected = { pages: null, apis: null };
  var endpointsById = new Map(entities.filter(function (e) { return e.class === "Endpoint"; }).map(function (e) { return [e.id, e]; }));
  var usesByApi = new Map();
  O.pages.forEach(function (p) { p.apis.forEach(function (a) { push(usesByApi, a.endpoint, { page: p, use: a }); }); });
  function isBrokenUse(a) { return a.status === "not-found" || a.status === "method-mismatch"; }
  var pageItems = [], apiItems = [], usedApiCount = 0, brokenApis = 0, pagesWithBroken = 0;
  function buildPaItems() {
    pageItems = O.pages.map(function (p) {
      var bad = p.apis.filter(isBrokenUse).length, own = p.apis.filter(function (a) { return !a.common; }).length;
      return { id: p.page, p: p, bad: bad, own: own, segs: routeSegs(p.route), text: ((p.route || "") + " " + p.component + " " + p.file).toLowerCase() };
    });
    apiItems = Array.from(endpointsById.values()).map(function (e) {
      var uses = usesByApi.get(e.id) || [];
      return { id: e.id, e: e, uses: uses, bad: broken(e) ? 1 : 0, common: !!e.attributes.common, segs: apiSegs(e),
        text: (e.label + " " + (e.detail || "")).toLowerCase() };
    });
    usedApiCount = apiItems.filter(function (a) { return a.uses.length && !a.common; }).length;
    brokenApis = apiItems.filter(function (a) { return a.bad && a.uses.length; }).length;
    pagesWithBroken = pageItems.filter(function (p) { return p.bad; }).length;
  }
  buildPaItems();
  function splitKey(label) { var i = label.indexOf(" "); return i > 0 ? { method: label.slice(0, i), path: label.slice(i + 1) } : { method: "ANY", path: label }; }
  function methodBadge(method) { return el("span", "method " + (/^(GET|POST|PUT|PATCH|DELETE)$/.test(method) ? method : "ANY"), method); }

  var small = O.pages.length <= 40 && usedApiCount <= 80;
  document.getElementById("mode-matrix").hidden = !small || !O.pages.length;

  function summary() {
    var box = document.getElementById("pa-summary"); box.textContent = "";
    [["Pages", O.pages.length, "pages", false], ["APIs used by pages", usedApiCount, "apis", false],
     ["Pages with broken APIs", pagesWithBroken, "pages", true], ["Broken APIs in use", brokenApis, "apis", true]]
      .concat(commonCount ? [["Common APIs (hidden)", commonCount, "common", false]] : []).forEach(function (x) {
      var b = el("button", x[3] && x[1] ? "alert" : "");
      b.appendChild(el("b", null, String(x[1]))); b.appendChild(el("span", null, x[0]));
      var pressed = x[2] === "common" ? paMode === "apis" && paOnlyCommon
        : paMode === x[2] && !paOnlyCommon && document.getElementById("pa-broken").checked === x[3];
      b.setAttribute("aria-pressed", String(pressed));
      b.onclick = function () {
        if (x[2] === "common") { openApis(null, true); return; }
        setMode(x[2]);
        document.getElementById("pa-broken").checked = x[3]; renderPa();
      };
      box.appendChild(b);
    });
  }
  /** Page ↔ API tab, APIs → pages, with id selected; onlyCommon lists just the common APIs. */
  function openApis(id, onlyCommon) {
    showTab("matrix");
    setMode("apis");
    paOnlyCommon = !!onlyCommon;
    document.getElementById("pa-filter").value = "";
    document.getElementById("pa-broken").checked = false;
    if (onlyCommon || isCommon(id)) document.getElementById("pa-common").checked = true;
    paSelected.apis = id;
    paScope.apis = [];
    renderPa();
  }
  document.getElementById("pa-only-common").onclick = function () { paOnlyCommon = false; renderPa(); };
  function setMode(mode) {
    paMode = mode;
    paOnlyCommon = false;
    document.querySelectorAll(".segmented button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.mode === mode)); });
    document.getElementById("pa-unused-wrap").hidden = mode !== "apis";
    document.getElementById("pa-common-wrap").hidden = mode !== "apis" || !commonCount;
  }
  document.querySelectorAll(".segmented button").forEach(function (b) { b.onclick = function () { setMode(b.dataset.mode); renderPa(); }; });
  ["pa-filter", "pa-broken", "pa-unused", "pa-common"].forEach(function (id) { document.getElementById(id).addEventListener(id === "pa-filter" ? "input" : "change", renderPa); });

  function renderPa() {
    summary();
    var matrix = paMode === "matrix";
    document.getElementById("pa-main").hidden = matrix;
    document.getElementById("pa-matrix-wrap").hidden = !matrix;
    if (matrix) { renderMatrix(); return; }
    if (!O.pages.length) {
      document.getElementById("pa-list").textContent = "";
      document.getElementById("pa-detail").textContent = "No pages found. Add routes to tacet.config.json, or use React Router / vue-router / Next.js / Remix routing.";
      return;
    }
    document.getElementById("pa-only-common").hidden = !(paMode === "apis" && paOnlyCommon);
    var q = document.getElementById("pa-filter").value.trim().toLowerCase();
    var onlyBad = document.getElementById("pa-broken").checked, unused = document.getElementById("pa-unused").checked;
    var items = (paMode === "pages" ? pageItems : apiItems).filter(function (it) {
      if (paMode === "apis" && !unused && !it.uses.length) return false;
      if (paMode === "apis" && it.common && !document.getElementById("pa-common").checked) return false;
      if (paMode === "apis" && paOnlyCommon && !it.common) return false;
      if (onlyBad && !it.bad) return false;
      return !q || it.text.indexOf(q) >= 0;
    });
    var total = paMode === "pages" ? pageItems.length : (unused ? apiItems.length : usedApiCount);
    var list = document.getElementById("pa-list");
    var scoped = renderTree(list, items, paScope[paMode], {
      query: q,
      setScope: function (segs) { paScope[paMode] = segs; paSelected[paMode] = null; renderPa(); },
      sortItems: function (a, b) {
        return paMode === "pages" ? (a.p.route || "").localeCompare(b.p.route || "") : splitKey(a.e.label).path.localeCompare(splitKey(b.e.label).path);
      },
      renderItem: paItemButton,
    });
    document.getElementById("pa-count").textContent = scoped.items.length + " of " + total + (paMode === "pages" ? " pages" : " APIs");
    if (paSelected[paMode] && !items.some(function (it) { return it.id === paSelected[paMode]; })) paSelected[paMode] = null;
    paScopeView = scoped;
    renderPaDetail();
  }
  var paScopeView = null;

  function paItemButton(it) {
    var b = el("button", "page-item"); b.setAttribute("aria-current", String(paSelected[paMode] === it.id));
    if (paMode === "pages") {
      b.appendChild(el("span", "route", it.p.route || it.p.component));
      var meta = el("span", "meta"); meta.appendChild(el("span", "comp", it.p.component));
      meta.appendChild(el("span", "badge", it.own + " API" + (it.own === 1 ? "" : "s")));
      if (it.bad) meta.appendChild(el("span", "badge broken", it.bad + " broken"));
      b.appendChild(meta);
    } else {
      var k = splitKey(it.e.label), line = el("span", "meta");
      line.appendChild(methodBadge(k.method)); line.appendChild(el("span", "route", k.path));
      b.appendChild(line);
      var meta2 = el("span", "meta");
      meta2.appendChild(el("span", "badge" + (it.bad ? " broken" : ""), it.bad ? it.e.status.replace("-", " ") : it.uses.length + " page" + (it.uses.length === 1 ? "" : "s")));
      if (it.bad) meta2.appendChild(el("span", "badge", it.uses.length + " page" + (it.uses.length === 1 ? "" : "s")));
      b.appendChild(meta2);
    }
    b.onclick = function () { paSelected[paMode] = it.id; renderPa(); };
    return b;
  }

  /** Nothing selected: what the current group (scope) adds up to. */
  function renderOverview(box, view) {
    var where = (paMode === "apis" && paOnlyCommon ? "Common APIs" : "") + (view.path.length ? " /" + view.path.join("/") : paMode === "apis" && paOnlyCommon ? "" : "All " + (paMode === "pages" ? "pages" : "APIs"));
    var head = el("div", "head"), title = el("div");
    title.appendChild(el("h3", null, where));
    var counts = el("div", "counts"), bad = view.items.filter(function (it) { return it.bad; }).length;
    counts.appendChild(el("span", "badge", view.items.length + (paMode === "pages" ? " pages" : " APIs")));
    if (bad) counts.appendChild(el("span", "badge broken", bad + (paMode === "pages" ? " with broken APIs" : " broken")));
    title.appendChild(counts); head.appendChild(title); box.appendChild(head);
    if (!view.items.length) { box.appendChild(el("p", "muted", "Nothing matches the filter.")); return; }
    var rows = [];
    if (paMode === "pages") {
      var byApi = new Map();
      view.items.forEach(function (it) {
        it.p.apis.forEach(function (a) {
          if (a.common) return;
          if (!byApi.has(a.endpoint)) byApi.set(a.endpoint, { a: a, pages: 0 });
          byApi.get(a.endpoint).pages++;
        });
      });
      rows = Array.from(byApi.values()).sort(function (x, y) {
        return (isBrokenUse(y.a) ? 1 : 0) - (isBrokenUse(x.a) ? 1 : 0) || y.pages - x.pages || x.a.apiKey.localeCompare(y.a.apiKey);
      });
      box.appendChild(el("h4", null, "APIs these pages use (" + rows.length + ")"));
      rows.slice(0, 300).forEach(function (r) {
        var b = el("button", "ov-row" + (isBrokenUse(r.a) ? " bad" : "")), k = splitKey(r.a.apiKey);
        b.appendChild(methodBadge(k.method)); b.appendChild(el("span", "path", k.path));
        if (isBrokenUse(r.a)) b.appendChild(el("span", "badge broken", r.a.status.replace("-", " ")));
        b.appendChild(el("span", "badge", r.pages + " of " + view.items.length + " pages"));
        b.onclick = function () { openApis(r.a.endpoint, false); };
        box.appendChild(b);
      });
    } else {
      var byPage = new Map();
      view.items.forEach(function (it) {
        it.uses.forEach(function (u) {
          if (!byPage.has(u.page.page)) byPage.set(u.page.page, { p: u.page, apis: 0, bad: 0 });
          var r = byPage.get(u.page.page); r.apis++; if (it.bad) r.bad++;
        });
      });
      rows = Array.from(byPage.values()).sort(function (x, y) { return y.bad - x.bad || y.apis - x.apis || (x.p.route || "").localeCompare(y.p.route || ""); });
      box.appendChild(el("h4", null, "Pages using these APIs (" + rows.length + ")"));
      rows.slice(0, 300).forEach(function (r) {
        var b = el("button", "ov-row" + (r.bad ? " bad" : ""));
        var path = el("span", "path", r.p.route || r.p.component); path.appendChild(el("small", null, r.p.component)); b.appendChild(path);
        if (r.bad) b.appendChild(el("span", "badge broken", r.bad + " broken"));
        b.appendChild(el("span", "badge", r.apis + " of " + view.items.length + " APIs"));
        b.onclick = function () { setMode("pages"); paScope.pages = []; paSelected.pages = r.p.page; document.getElementById("pa-filter").value = ""; renderPa(); };
        box.appendChild(b);
      });
    }
    if (rows.length > 300) box.appendChild(el("p", "muted small", "Showing the first 300; drill down or filter to narrow."));
  }

  function steps(via) {
    var box = el("div", "steps");
    via.slice(1, -1).forEach(function (label, i) {
      if (i) box.appendChild(el("span", "arr", "→"));
      box.appendChild(el("span", "step", label));
    });
    return box;
  }
  function fieldsBox(fields) {
    var box = el("div", "fields");
    if (!fields.length) { box.appendChild(el("span", "muted", "No response fields read")); return box; }
    fields.forEach(function (f) { box.appendChild(el("code", null, f)); });
    return box;
  }
  function graphButton(id) {
    var b = el("button", null, "Open in graph");
    b.onclick = function () { showTab("graph"); history = []; focus(id); };
    var wrap = el("div", "actions"); wrap.appendChild(b); return wrap;
  }

  function renderPaDetail() {
    var box = document.getElementById("pa-detail"); box.textContent = "";
    var id = paSelected[paMode];
    if (!id) { if (paScopeView) renderOverview(box, paScopeView); return; }
    var back = el("button", "link-btn back", "‹ " + (paScopeView && paScopeView.path.length ? "/" + paScopeView.path.join("/") : "All") + " overview");
    back.onclick = function () { paSelected[paMode] = null; renderPa(); };
    box.appendChild(back);
    var head = el("div", "head"), title = el("div");
    if (paMode === "pages") {
      var it = pageItems.find(function (x) { return x.id === id; }), p = it.p;
      title.appendChild(el("h3", null, p.route || p.component));
      title.appendChild(el("div", "sub", p.component + " · " + p.file));
      var counts = el("div", "counts"); counts.appendChild(el("span", "badge", it.own + " APIs"));
      if (it.own !== p.apis.length) counts.appendChild(el("span", "badge", "+" + (p.apis.length - it.own) + " common"));
      if (it.bad) counts.appendChild(el("span", "badge broken", it.bad + " broken"));
      title.appendChild(counts); head.appendChild(title); head.appendChild(graphButton(p.page)); box.appendChild(head);
      var sorted = p.apis.slice().sort(function (a, b) { return (isBrokenUse(b) ? 1 : 0) - (isBrokenUse(a) ? 1 : 0) || splitKey(a.apiKey).path.localeCompare(splitKey(b.apiKey).path); });
      var bad = sorted.filter(isBrokenUse), ok = sorted.filter(function (a) { return !isBrokenUse(a) && !a.common; });
      var commonUses = sorted.filter(function (a) { return !isBrokenUse(a) && a.common; });
      if (bad.length) { box.appendChild(el("h4", null, "Broken (" + bad.length + ")")); bad.forEach(function (a) { box.appendChild(apiUse(a)); }); }
      if (ok.length) { box.appendChild(el("h4", null, "APIs (" + ok.length + ")")); ok.forEach(function (a) { box.appendChild(apiUse(a)); }); }
      if ((p.related || []).length) {
        box.appendChild(el("h4", null, "Related pages (sharing APIs)"));
        var rl = el("div", "related");
        p.related.forEach(function (r) {
          var b = el("button", "related-item");
          b.appendChild(el("span", "route", r.route || r.component));
          b.appendChild(el("span", "badge", r.shared + " shared"));
          b.title = r.apis.join("\\n");
          b.onclick = function () { paSelected.pages = r.page; document.getElementById("pa-filter").value = ""; document.getElementById("pa-broken").checked = false; renderPa(); };
          rl.appendChild(b);
        });
        box.appendChild(rl);
      }
      if (commonUses.length) {
        var cd = el("details", "common-group"), cs = el("summary", null, "Common APIs (" + commonUses.length + ") — used by most pages");
        cd.appendChild(cs); commonUses.forEach(function (a) { cd.appendChild(apiUse(a)); }); box.appendChild(cd);
      }
    } else {
      var api = apiItems.find(function (x) { return x.id === id; }), k = splitKey(api.e.label);
      var line = el("div", "meta"); line.appendChild(methodBadge(k.method)); line.appendChild(el("h3", null, k.path)); title.appendChild(line);
      title.appendChild(el("div", "sub", api.e.detail || (api.e.status || "")));
      var c = el("div", "counts");
      c.appendChild(el("span", "pill" + (api.bad ? " broken" : api.e.status === "unused" ? " unused" : ""), api.e.status || ""));
      c.appendChild(el("span", "badge", api.uses.length + " pages"));
      if (api.common) c.appendChild(el("span", "badge", "common API"));
      title.appendChild(c); head.appendChild(title);
      var acts = graphButton(api.e.id); acts.appendChild(commonToggle(api.e)); head.appendChild(acts); box.appendChild(head);
      if (!api.uses.length) box.appendChild(el("p", "muted", "No page uses this API."));
      else {
        box.appendChild(el("h4", null, "Used by pages (" + api.uses.length + ")"));
        api.uses.slice().sort(function (a, b) { return (a.page.route || "").localeCompare(b.page.route || ""); }).forEach(function (u) { box.appendChild(pageUse(u)); });
      }
    }
  }
  function apiUse(a) {
    var d = el("details", "use" + (isBrokenUse(a) ? " bad" : "")), sm = el("summary"), k = splitKey(a.apiKey);
    sm.appendChild(methodBadge(k.method));
    var path = el("span", "path", k.path);
    if (isBrokenUse(a)) path.appendChild(el("small", null, a.status.replace("-", " ") + " in the backend"));
    sm.appendChild(path);
    sm.appendChild(el("span", "badge", a.fields.length + " field" + (a.fields.length === 1 ? "" : "s")));
    d.appendChild(sm);
    var body = el("div", "body");
    body.appendChild(el("div", "muted small", "Call path")); body.appendChild(steps(a.via));
    body.appendChild(el("div", "muted small", "Fields read")); body.appendChild(fieldsBox(a.fields));
    var link = el("a", "link", "Show this API's pages"); link.href = "#";
    link.onclick = function (ev) { ev.preventDefault(); setMode("apis"); paSelected.apis = a.endpoint; document.getElementById("pa-filter").value = ""; document.getElementById("pa-broken").checked = false; renderPa(); };
    var lw = el("div"); lw.style.marginTop = "8px"; lw.appendChild(link); body.appendChild(lw);
    d.appendChild(body);
    return d;
  }
  function pageUse(u) {
    var d = el("details", "use"), sm = el("summary");
    var path = el("span", "path", u.page.route || u.page.component); path.appendChild(el("small", null, u.page.component));
    sm.appendChild(path); sm.appendChild(el("span", "badge", u.use.fields.length + " field" + (u.use.fields.length === 1 ? "" : "s")));
    d.appendChild(sm);
    var body = el("div", "body");
    body.appendChild(el("div", "muted small", "Call path")); body.appendChild(steps(u.use.via));
    body.appendChild(el("div", "muted small", "Fields read")); body.appendChild(fieldsBox(u.use.fields));
    var link = el("a", "link", "Show this page's APIs"); link.href = "#";
    link.onclick = function (ev) { ev.preventDefault(); setMode("pages"); paSelected.pages = u.page.page; document.getElementById("pa-filter").value = ""; document.getElementById("pa-broken").checked = false; renderPa(); };
    var lw = el("div"); lw.style.marginTop = "8px"; lw.appendChild(link); body.appendChild(lw);
    d.appendChild(body);
    return d;
  }

  /** The full Page × API grid; offered only for small projects, where it still fits on screen. */
  function renderMatrix() {
    var apis = apiItems.filter(function (a) { return a.uses.length; }).map(function (a) { return a.e; });
    var table = document.getElementById("matrix"); table.textContent = "";
    var thead = el("thead"), hr = el("tr"); hr.appendChild(el("th", null, "Page \\\\ API"));
    apis.forEach(function (a) { var th = el("th", "api"); th.appendChild(entityLink(a.id)); hr.appendChild(th); });
    thead.appendChild(hr); table.appendChild(thead);
    var tbody = el("tbody");
    O.pages.forEach(function (p) {
      var tr = el("tr"), th = el("th", "page"); th.appendChild(entityLink(p.page));
      th.appendChild(el("div", "chain", p.component + " · " + p.file)); tr.appendChild(th);
      var byApi = new Map(p.apis.map(function (a) { return [a.endpoint, a]; }));
      apis.forEach(function (a) {
        var td = el("td", "cell"), use = byApi.get(a.id);
        if (use) {
          var dot = el("span", broken(a) ? "broken" : "");
          dot.title = use.via.join(" → ") + (use.fields.length ? "\\nreads: " + use.fields.join(", ") : "");
          td.appendChild(dot);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
  }

  // ================================================================ triples
  var predSelect = document.getElementById("triple-predicate");
  O.schema.predicates.filter(function (p) { return predCounts[p.name]; }).forEach(function (p) { var o = el("option", null, p.name + " (" + predCounts[p.name] + ")"); o.value = p.name; predSelect.appendChild(o); });
  var tsearch = document.getElementById("triple-search");
  function renderTriples() {
    var q = tsearch.value.trim().toLowerCase(), pred = predSelect.value;
    var body = document.querySelector("#triples tbody"); body.textContent = "";
    var rows = triples.filter(function (t) {
      if (pred && t.predicate !== pred) return false;
      if (!q) return true;
      return [byId.get(t.subject).label, t.predicate, byId.get(t.object).label].join(" ").toLowerCase().indexOf(q) >= 0;
    });
    document.getElementById("triple-count").textContent = rows.length + " of " + triples.length;
    rows.slice(0, 2000).forEach(function (t) {
      var tr = el("tr");
      var c1 = el("td", "mono"); c1.appendChild(entityLink(t.subject)); c1.appendChild(el("div", "chain", byId.get(t.subject).class)); tr.appendChild(c1);
      tr.appendChild(el("td", "mono", t.predicate + (t.inferred ? " (inferred)" : "")));
      var c3 = el("td", "mono"); c3.appendChild(entityLink(t.object)); c3.appendChild(el("div", "chain", byId.get(t.object).class)); tr.appendChild(c3);
      var c4 = el("td", "mono");
      if (t.via) c4.appendChild(el("div", "chain", t.via.map(function (id) { return byId.get(id) ? byId.get(id).label : id; }).join(" → ")));
      t.evidence.forEach(function (e) { c4.appendChild(el("div", "ev", e.file + ":" + e.line + "  " + e.code)); });
      tr.appendChild(c4);
      body.appendChild(tr);
    });
  }
  tsearch.addEventListener("input", renderTriples); predSelect.onchange = renderTriples;

  // ================================================================ schema
  function renderSchema() {
    var POS = { Page: [90, 70], Component: [290, 70], Hook: [290, 190], Function: [490, 190], ApiClient: [490, 70], Endpoint: [690, 70],
      Controller: [890, 70], Dto: [690, 250], DtoField: [890, 250], Enum: [890, 370], File: [490, 370] };
    var svgS = document.getElementById("schema"); svgS.textContent = "";
    var CW = 120, CH = 36, Wd = 1010, Hd = 480;
    svgS.setAttribute("viewBox", "0 0 " + Wd + " " + Hd); svgS.setAttribute("width", Wd); svgS.setAttribute("height", Hd);
    var defs = s("defs", {});
    Object.keys(PRED_COLOR).forEach(function (p) {
      var m = s("marker", { id: "arrow-" + p, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
      m.appendChild(s("path", { d: "M0,0 L10,5 L0,10 z", fill: PRED_COLOR[p] })); defs.appendChild(m);
    });
    svgS.appendChild(defs);
    var pairCount = new Map();
    O.schema.predicates.forEach(function (p) {
      p.domain.forEach(function (d) { p.range.forEach(function (r) {
        if (p.name === "definedIn" && d !== "Component" && d !== "Controller") return;
        var a = POS[d], b = POS[r]; if (!a || !b) return;
        var key = [d, r].sort().join("|"), k = pairCount.get(key) || 0; pairCount.set(key, k + 1);
        var x1 = a[0] + CW / 2, y1 = a[1] + CH / 2, x2 = b[0] + CW / 2, y2 = b[1] + CH / 2;
        var path;
        if (d === r) { path = "M" + (x1 + 30) + "," + (a[1]) + " C" + (x1 + 70) + "," + (a[1] - 50) + " " + (x1 - 70) + "," + (a[1] - 50) + " " + (x1 - 30) + "," + a[1]; }
        else {
          var dx = x2 - x1, dy = y2 - y1, len = Math.sqrt(dx * dx + dy * dy) || 1;
          var sx = x1 + dx / len * 64, sy = y1 + dy / len * 22, ex = x2 - dx / len * 66, ey = y2 - dy / len * 24;
          var bend = (k - 0.5) * 28, mx = (sx + ex) / 2 - dy / len * bend, my = (sy + ey) / 2 + dx / len * bend;
          path = "M" + sx + "," + sy + " Q" + mx + "," + my + " " + ex + "," + ey;
        }
        var pe = s("path", { d: path, fill: "none", stroke: PRED_COLOR[p.name], "stroke-width": 1.4, "marker-end": "url(#arrow-" + p.name + ")", opacity: 0.8 });
        if (p.inferred) pe.setAttribute("stroke-dasharray", "6 4");
        pe.appendChild(s("title", {}, d + " —" + p.name + "→ " + r + "\\n" + p.description));
        svgS.appendChild(pe);
      }); });
    });
    O.schema.classes.forEach(function (c) {
      var p = POS[c.name], col = colors(c.name);
      var g = s("g", { transform: "translate(" + p[0] + "," + p[1] + ")" });
      var box = s("rect", { width: CW, height: CH, rx: 8, "stroke-width": 1.5 });
      box.style.fill = col.fill; box.style.stroke = col.stroke; g.appendChild(box);
      var t = s("text", { x: CW / 2, y: 22, "text-anchor": "middle", "font-weight": 600 }, c.name); t.style.fill = col.text; g.appendChild(t);
      g.appendChild(s("title", {}, c.description + (classCounts[c.name] ? " — " + classCounts[c.name] + " in this project" : "")));
      svgS.appendChild(g);
    });
    O.schema.predicates.forEach(function (p, i) {
      var x = 20 + (i % 6) * 165, y = Hd - 36 + Math.floor(i / 6) * 20;
      svgS.appendChild(s("line", { x1: x, y1: y - 4, x2: x + 20, y2: y - 4, stroke: PRED_COLOR[p.name], "stroke-width": 2, "stroke-dasharray": p.inferred ? "5 3" : "" }));
      svgS.appendChild(s("text", { x: x + 26, y: y, "font-size": 11.5 }, p.name));
    });
  }

  rebuild();
  renderCommonPanel();
  renderDetails();
  renderPa();
  renderTriples();
  renderSchema();
})();
`;
