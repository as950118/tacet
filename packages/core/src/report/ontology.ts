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

<section id="tab-graph" class="tab">
  <div class="toolbar">
    <input id="search" type="search" placeholder="Search pages, components, APIs, DTOs…" autocomplete="off">
    <div class="zoom">
      <button id="zoom-out" title="Zoom out">−</button>
      <button id="zoom-reset" title="Reset zoom">100%</button>
      <button id="zoom-in" title="Zoom in">+</button>
    </div>
  </div>
  <div class="toolbar"><div id="classes" class="chips"></div></div>
  <div class="toolbar"><div id="predicates" class="chips"></div></div>
  <main>
    <section class="canvas" id="canvas"><svg id="graph" xmlns="http://www.w3.org/2000/svg"></svg></section>
    <aside id="details" class="details"></aside>
  </main>
</section>

<section id="tab-matrix" class="tab" hidden>
  <div class="toolbar">
    <label class="check"><input id="matrix-all" type="checkbox"> Show APIs no page uses</label>
  </div>
  <div class="scroll"><table id="matrix" class="matrix"></table></div>
  <h2 class="section">API → pages</h2>
  <div class="scroll"><table id="api-pages"></table></div>
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
@media (max-width: 900px) { main { grid-template-columns: 1fr; } }
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
  var laneOf = {}; LANES.forEach(function (l, i) { l.forEach(function (c) { laneOf[c] = i; }); });
  var hiddenClasses = new Set(["File", "DtoField", "Enum"]);
  var hiddenPredicates = new Set(["definedIn", "usesApi"]);
  var PRED_COLOR = { showsComponent: "#d4733a", renders: "#2e9a62", calls: "#5f6b7a", requests: "#3b6fd8", reads: "#8a5cd8",
    usesApi: "#d4733a", handledBy: "#9a4fc2", accepts: "#b88a00", returns: "#b88a00", hasField: "#c9a74a", typedAs: "#c2477a", definedIn: "#8a8a84" };

  function chips(container, items, hidden, onChange) {
    items.forEach(function (it) {
      var label = el("label"); var cb = el("input"); cb.type = "checkbox"; cb.checked = !hidden.has(it.key);
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
  }), hiddenClasses, layout);
  var predCounts = {}; triples.forEach(function (t) { predCounts[t.predicate] = (predCounts[t.predicate] || 0) + 1; });
  chips(document.getElementById("predicates"), O.schema.predicates.filter(function (p) { return predCounts[p.name]; }).map(function (p) {
    var sw = el("span", "line-swatch"); sw.style.borderColor = PRED_COLOR[p.name]; if (p.inferred) sw.style.borderTopStyle = "dashed";
    return { key: p.name, label: p.name, swatch: sw, count: predCounts[p.name] };
  }), hiddenPredicates, layout);

  var svg = document.getElementById("graph");
  var W = 210, H = 44, GX = 70, GY = 10, PADX = 20, PADY = 44;
  var xy = new Map(), nodeEls = new Map(), edgeEls = [], width = 0, height = 0;
  var visibleIds = new Set(), out = new Map(), inn = new Map();

  function layout() {
    svg.textContent = "";
    visibleIds = new Set(entities.filter(function (e) { return !hiddenClasses.has(e.class); }).map(function (e) { return e.id; }));
    var vt = triples.filter(function (t) { return !hiddenPredicates.has(t.predicate) && visibleIds.has(t.subject) && visibleIds.has(t.object); });
    out = new Map(); inn = new Map();
    vt.forEach(function (t) { push(out, t.subject, t.object); push(inn, t.object, t.subject); });
    var lanes = LANES.map(function () { return []; });
    entities.forEach(function (e) { if (visibleIds.has(e.id)) lanes[laneOf[e.class]].push(e); });
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
      for (var r = 1; r < used.length; r++) { used[r].nodes.sort(function (a, b) { return bary(a, inn) - bary(b, inn); }); index(); }
      for (var r2 = used.length - 2; r2 >= 0; r2--) { used[r2].nodes.sort(function (a, b) { return bary(a, out) - bary(b, out); }); index(); }
    }
    var tallest = Math.max.apply(null, used.map(function (l) { return l.nodes.length; }).concat([1]));
    width = PADX * 2 + used.length * W + Math.max(0, used.length - 1) * GX;
    height = PADY + tallest * (H + GY) + 24;
    xy = new Map();
    used.forEach(function (l, col) {
      var x = PADX + col * (W + GX);
      svg.appendChild(s("rect", { "class": "lane", x: x - 8, y: 8, width: W + 16, height: height - 16, rx: 10 }));
      svg.appendChild(s("text", { "class": "lane-title", x: x, y: 28 }, LANES[l.i].join(" · ")));
      var offset = (tallest - l.nodes.length) * (H + GY) / 2;
      l.nodes.forEach(function (n, i) { xy.set(n.id, { x: x, y: PADY + offset + i * (H + GY) }); });
    });
    var edgeLayer = s("g", {}), labelLayer = s("g", {}), nodeLayer = s("g", {});
    svg.appendChild(edgeLayer); svg.appendChild(nodeLayer); svg.appendChild(labelLayer);
    edgeEls = [];
    vt.forEach(function (t) {
      var a = xy.get(t.subject), b = xy.get(t.object);
      if (!a || !b) return;
      var d, lx, ly;
      if (a.x === b.x) {
        var x1 = a.x + W, y1 = a.y + H / 2, y2 = b.y + H / 2, bulge = 30 + Math.min(40, Math.abs(y2 - y1) / 6);
        d = "M" + x1 + "," + y1 + " C" + (x1 + bulge) + "," + y1 + " " + (x1 + bulge) + "," + y2 + " " + x1 + "," + y2;
        lx = x1 + bulge * 0.8; ly = (y1 + y2) / 2;
      } else {
        var fwd = b.x > a.x;
        var sx = fwd ? a.x + W : a.x, sy = a.y + H / 2, ex = fwd ? b.x : b.x + W, ey = b.y + H / 2, mx = (sx + ex) / 2;
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
      var col = colors(n.class);
      var g = s("g", { "class": "node" + (broken(n) ? " broken" : "") + (n.status === "unused" ? " unused" : ""), transform: "translate(" + p.x + "," + p.y + ")" });
      var box = s("rect", { width: W, height: H, rx: n.class === "Page" ? 3 : n.class === "Component" ? 20 : 7 });
      box.style.fill = col.fill; box.style.stroke = col.stroke; g.appendChild(box);
      var t1 = s("text", { x: 10, y: 18, fill: col.text }, clip(n.label, 28)); t1.style.fill = col.text; g.appendChild(t1);
      var t2 = s("text", { x: 10, y: 34, "class": "sub" }, clip(sub(n), 32)); t2.style.fill = col.text; g.appendChild(t2);
      g.appendChild(s("title", {}, n.class + ": " + n.label + (n.detail ? "\\n" + n.detail : "")));
      g.addEventListener("click", function (ev) { ev.stopPropagation(); select(n.id); });
      nodeLayer.appendChild(g);
      nodeEls.set(n.id, g);
    });
    applyZoom();
    refresh();
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

  var selected = null, query = "";
  var search = document.getElementById("search");
  search.addEventListener("input", function () { query = search.value.trim().toLowerCase(); refresh(); });
  search.addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter") return;
    var first = entities.find(function (e) { return visibleIds.has(e.id) && matches(e); });
    if (first) { select(first.id); scrollToNode(first.id); }
  });
  function matches(e) { return query !== "" && (e.label.toLowerCase().indexOf(query) >= 0 || (e.detail || "").toLowerCase().indexOf(query) >= 0); }
  function scrollToNode(id) {
    var p = xy.get(id), c = document.getElementById("canvas"); if (!p) return;
    c.scrollTo({ left: Math.max(0, p.x * scale - 80), top: Math.max(0, p.y * scale - c.clientHeight / 2), behavior: "smooth" });
  }
  function reach(start, adj) {
    var seen = new Set([start]), q = [start];
    while (q.length) (adj.get(q.shift()) || []).forEach(function (id) { if (!seen.has(id)) { seen.add(id); q.push(id); } });
    return seen;
  }
  function select(id) {
    selected = id;
    if (id && !visibleIds.has(id)) { hiddenClasses.delete(byId.get(id).class); syncChips(); layout(); }
    refresh(); renderDetails();
    if (id) scrollToNode(id);
  }
  function syncChips() {
    document.querySelectorAll("#classes label").forEach(function (l) { l.querySelector("input").checked = !hiddenClasses.has(l.childNodes[2].textContent); });
  }
  function refresh() {
    var focus = null;
    if (selected && visibleIds.has(selected)) { focus = reach(selected, out); reach(selected, inn).forEach(function (id) { focus.add(id); }); }
    nodeEls.forEach(function (g, id) {
      var n = byId.get(id);
      g.classList.toggle("dim", !!((focus && !focus.has(id)) || (!focus && query !== "" && !matches(n))));
      g.classList.toggle("match", matches(n));
      g.classList.toggle("selected", id === selected);
    });
    edgeEls.forEach(function (x) {
      var hot = !!(focus && focus.has(x.t.subject) && focus.has(x.t.object));
      x.el.classList.toggle("hot", hot); x.label.classList.toggle("hot", hot);
      x.el.classList.toggle("dim", !!(focus && !hot) || (!focus && query !== ""));
    });
  }

  function entityLink(id) {
    var e = byId.get(id), a = el("a", "link", e ? e.label : id);
    a.href = "#"; a.onclick = function (ev) { ev.preventDefault(); showTab("graph"); select(id); };
    return a;
  }
  function renderDetails() {
    var box = document.getElementById("details");
    box.textContent = "";
    if (!selected) {
      box.appendChild(el("p", "muted", "Click an entity to see its relations. Toggle classes and predicates above; usesApi (page → API) is inferred."));
      return;
    }
    var n = byId.get(selected), col = colors(n.class);
    var kind = el("div", "kind", n.class + (n.status ? " · " + n.status : "")); kind.style.color = col.stroke; box.appendChild(kind);
    box.appendChild(el("h3", null, n.label));
    if (n.detail) box.appendChild(el("div", "muted", n.detail));
    if (n.file) box.appendChild(el("div", "ev", n.file + (n.line ? ":" + n.line : "")));
    var attrs = Object.keys(n.attributes).filter(function (k) { return n.attributes[k] !== null && n.attributes[k] !== ""; });
    if (attrs.length) box.appendChild(el("div", "attrs", attrs.map(function (k) { return k + " = " + n.attributes[k]; }).join("\\n")));

    if (n.class === "Page") {
      var row = O.pages.find(function (p) { return p.page === n.id; });
      if (row) section("Uses APIs (" + row.apis.length + ")", row.apis.map(function (a) { return { id: a.endpoint, chain: a.via, fields: a.fields }; }));
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
        if (it.fields && it.fields.length) li.appendChild(el("div", "ev", "reads " + it.fields.join(", ")));
        (it.ev || []).forEach(function (e) { li.appendChild(el("div", "ev", e.file + ":" + e.line + "  " + e.code)); });
        ul.appendChild(li);
      });
      box.appendChild(ul);
    }
  }

  // ================================================================ matrix
  function renderMatrix() {
    var all = document.getElementById("matrix-all").checked;
    var used = new Set(); O.pages.forEach(function (p) { p.apis.forEach(function (a) { used.add(a.endpoint); }); });
    var apis = entities.filter(function (e) { return e.class === "Endpoint" && (all || used.has(e.id)); });
    var table = document.getElementById("matrix"); table.textContent = "";
    if (!O.pages.length) { table.appendChild(el("caption", "muted pad", "No pages found. Add routes to tacet.config.json, or use React Router / Next.js / Remix routing.")); return; }
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

    var rev = document.getElementById("api-pages"); rev.textContent = "";
    var h = el("thead"), r = el("tr"); ["API", "Status", "Pages", "Fields read"].forEach(function (x) { r.appendChild(el("th", null, x)); }); h.appendChild(r); rev.appendChild(h);
    var b = el("tbody");
    entities.filter(function (e) { return e.class === "Endpoint"; }).forEach(function (a) {
      var pages = [], fields = new Set();
      O.pages.forEach(function (p) { p.apis.forEach(function (u) { if (u.endpoint === a.id) { pages.push(p.page); u.fields.forEach(function (f) { fields.add(f); }); } }); });
      if (!all && !pages.length) return;
      var tr = el("tr"), c1 = el("td", "mono"); c1.appendChild(entityLink(a.id)); tr.appendChild(c1);
      var c2 = el("td"); c2.appendChild(el("span", "pill" + (broken(a) ? " broken" : a.status === "unused" ? " unused" : ""), a.status || "")); tr.appendChild(c2);
      var c3 = el("td"); pages.forEach(function (id, i) { if (i) c3.appendChild(document.createTextNode(", ")); c3.appendChild(entityLink(id)); });
      if (!pages.length) c3.appendChild(el("span", "muted", "—")); tr.appendChild(c3);
      tr.appendChild(el("td", "mono", Array.from(fields).sort().join(", ") || "—"));
      b.appendChild(tr);
    });
    rev.appendChild(b);
  }
  document.getElementById("matrix-all").onchange = renderMatrix;

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

  layout();
  renderDetails();
  renderMatrix();
  renderTriples();
  renderSchema();
})();
`;
