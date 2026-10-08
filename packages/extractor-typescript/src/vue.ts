import { parse, type DirectiveNode, type ElementNode, type TemplateChildNode } from "@vue/compiler-dom";
import { ts } from "ts-morph";

/**
 * Helpers the generated template code calls. The analyzer gives them meaning:
 * - UNREF(x):            template auto-unwrapping of a ref (`{{ user.name }}` reads `user.value.name`)
 * - RENDER(Comp, props): `<Comp :user="user" />` passes `user` to Comp's `defineProps`
 * - DEFINE_PROPS():      the props object of a component that calls `defineProps` without assigning it
 */
export const VUE_UNREF = "__tacetUnref";
export const VUE_RENDER = "__tacetRender";
export const VUE_DEFINE_PROPS = "__tacetDefineProps";
const PROPS_VAR = "__tacetProps";

/** The TypeScript file a `.vue` file is analyzed as: `Comp.vue` → `Comp.vue.ts`, so `import "./Comp.vue"` resolves to it. */
export function vueVirtualPath(vuePath: string): string {
  return `${vuePath}.ts`;
}

export function isVueVirtualPath(path: string): boolean {
  return path.endsWith(".vue.ts");
}

/** Generated template code shown as written in the template: `__tacetUnref(user).name` → `user.name`. */
export function vueDisplayCode(code: string): string {
  return code.replace(/__tacetUnref\(([\w$]+)\)/g, "$1").replace(/__tacetProps\./g, "");
}

interface ScriptInfo {
  /** Names declared at the top level of the script(s): imports, variables, functions, classes. */
  bindings: Set<string>;
  propNames: Set<string>;
  /** Variable holding `defineProps()`, or null when the props are not assigned to one. */
  propsVar: string | null;
  hasDefineProps: boolean;
  hasDefaultExport: boolean;
}

/**
 * Converts a Vue single-file component into TypeScript the extractor can analyze. Script blocks keep their
 * exact line and column; each template expression is emitted on the line it appears on (`v-for` as `for...of`,
 * `v-slot` props as block-scoped constants), with references to script bindings wrapped in `__tacetUnref`
 * and props read through the props object. Lines outside the blocks are blank, so locations map 1:1 by line.
 */
export function vueToTypeScript(source: string): string {
  let root;
  try {
    root = parse(source, { parseMode: "sfc", onError: () => {}, onWarn: () => {} });
  } catch {
    return "";
  }
  const blank = source.replace(/[^\r\n]/g, " ");
  const chars = [...blank];
  const scripts: string[] = [];
  let template: ElementNode | null = null;

  for (const node of root.children) {
    if (node.type !== 1) continue;
    if (node.tag === "script") {
      const content = node.children[0];
      if (content && content.type === 2) {
        const start = content.loc.start.offset;
        for (let i = 0; i < content.content.length; i++) chars[start + i] = content.content[i];
        scripts.push(content.content);
      }
    } else if (node.tag === "template" && !node.props.some((p) => p.type === 6 && p.name === "lang" && p.value?.content !== "html")) {
      template = node;
    }
  }

  const script = analyzeScript(scripts.join("\n"));
  const lines = chars.join("").split("\n");
  const emitted = new Map<number, { column: number; code: string[] }>();
  const emit = (line: number, column: number, code: string) => {
    const entry = emitted.get(line) ?? { column, code: [] };
    entry.code.push(code.replace(/\r?\n/g, " "));
    emitted.set(line, entry);
  };
  if (template) {
    const generator = new TemplateGenerator(script, emit);
    for (const child of template.children) generator.walk(child, new Set());
  }
  for (const [line, { column, code }] of emitted) {
    const index = line - 1;
    if (index >= 0 && index < lines.length && lines[index].trim() === "") {
      lines[index] = " ".repeat(Math.max(0, column - 1)) + code.join(" ");
    }
  }

  const trailer = [
    `declare function ${VUE_UNREF}(value: any): any;`,
    `declare function ${VUE_RENDER}(component: any, props: any): void;`,
    `declare function ${VUE_DEFINE_PROPS}(): any;`,
  ];
  if (script.hasDefineProps && script.propsVar === PROPS_VAR) trailer.push(`const ${PROPS_VAR} = ${VUE_DEFINE_PROPS}();`);
  else if (script.propsVar) trailer.push(`const ${PROPS_VAR} = ${script.propsVar};`);
  if (!script.hasDefaultExport) trailer.push("export default {} as any;");
  return `${lines.join("\n")}\n${trailer.join("\n")}\n`;
}

function analyzeScript(code: string): ScriptInfo {
  const sf = ts.createSourceFile("script.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const info: ScriptInfo = {
    bindings: new Set(),
    propNames: new Set(),
    propsVar: null,
    hasDefineProps: false,
    hasDefaultExport: false,
  };
  const typeMembers = new Map<string, ts.NodeArray<ts.TypeElement>>();
  let propsCall: ts.CallExpression | undefined;

  const addBindingNames = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) info.bindings.add(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) addBindingNames(element.name);
  };

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause && !statement.importClause.isTypeOnly) {
      const clause = statement.importClause;
      if (clause.name) info.bindings.add(clause.name.text);
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) info.bindings.add(named.name.text);
      if (named && ts.isNamedImports(named)) for (const el of named.elements) if (!el.isTypeOnly) info.bindings.add(el.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        addBindingNames(decl.name);
        const call = decl.initializer && definePropsCall(decl.initializer);
        if (call) {
          propsCall = call;
          if (ts.isIdentifier(decl.name)) info.propsVar = decl.name.text;
        }
      }
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)) && statement.name) {
      info.bindings.add(statement.name.text);
    } else if (ts.isInterfaceDeclaration(statement)) {
      typeMembers.set(statement.name.text, statement.members);
    } else if (ts.isTypeAliasDeclaration(statement) && ts.isTypeLiteralNode(statement.type)) {
      typeMembers.set(statement.name.text, statement.type.members);
    } else if (ts.isExportAssignment(statement)) {
      info.hasDefaultExport = true;
    } else if (ts.isExpressionStatement(statement)) {
      propsCall ??= definePropsCall(statement.expression);
    }
  }

  if (propsCall) {
    info.hasDefineProps = true;
    info.propsVar ??= PROPS_VAR;
    const typeArg = propsCall.typeArguments?.[0];
    const members = !typeArg
      ? undefined
      : ts.isTypeLiteralNode(typeArg)
        ? typeArg.members
        : ts.isTypeReferenceNode(typeArg) && ts.isIdentifier(typeArg.typeName)
          ? typeMembers.get(typeArg.typeName.text)
          : undefined;
    for (const member of members ?? []) {
      if (member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name))) info.propNames.add(member.name.text);
    }
    const arg = propsCall.arguments[0];
    if (arg && ts.isObjectLiteralExpression(arg)) {
      for (const prop of arg.properties) {
        if (prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) info.propNames.add(prop.name.text);
      }
    } else if (arg && ts.isArrayLiteralExpression(arg)) {
      for (const el of arg.elements) if (ts.isStringLiteral(el)) info.propNames.add(el.text);
    }
  }
  return info;
}

/** `defineProps(...)` or `withDefaults(defineProps(...), ...)`. */
function definePropsCall(expr: ts.Expression): ts.CallExpression | undefined {
  if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression)) return undefined;
  if (expr.expression.text === "defineProps") return expr;
  if (expr.expression.text === "withDefaults" && expr.arguments[0]) return definePropsCall(expr.arguments[0]);
  return undefined;
}

class TemplateGenerator {
  constructor(
    private readonly script: ScriptInfo,
    private readonly emit: (line: number, column: number, code: string) => void,
  ) {}

  walk(node: TemplateChildNode, locals: Set<string>): void {
    if (node.type === 5) {
      const content = node.content;
      if (content.type === 4) {
        this.emit(content.loc.start.line, content.loc.start.column, `${this.expression(content.content, locals)};`);
      }
      return;
    }
    if (node.type !== 1) return;

    const scope = new Set(locals);
    let opened = 0;
    const directives = node.props.filter((p): p is DirectiveNode => p.type === 7);
    const emitAt = (dir: DirectiveNode | ElementNode, code: string) => {
      const loc = "exp" in dir && dir.exp ? dir.exp.loc.start : dir.loc.start;
      this.emit(loc.line, loc.column, code);
    };

    for (const dir of directives.filter((d) => d.name === "if" || d.name === "else-if" || d.name === "show")) {
      if (dir.exp?.type === 4) emitAt(dir, `${this.expression(dir.exp.content, scope)};`);
    }

    const forDir = directives.find((d) => d.name === "for");
    const forResult = forDir?.forParseResult;
    if (forDir && forResult && forResult.source.type === 4) {
      const source = this.expression(forResult.source.content, scope);
      const aliases = [forResult.value, forResult.key, forResult.index].map((a) => (a && a.type === 4 ? a.content : null));
      const [value, key, index] = aliases;
      let code = `for (const ${value ?? "__tacetItem"} of ${source}) {`;
      if (key) code += ` const ${key}: any = undefined;`;
      if (index) code += ` const ${index}: any = undefined;`;
      emitAt(forDir, code);
      opened++;
      for (const alias of aliases) if (alias) for (const name of bindingNames(alias)) scope.add(name);
    }

    const slotDir = directives.find((d) => d.name === "slot");
    if (slotDir?.exp?.type === 4) {
      emitAt(slotDir, `{ const ${slotDir.exp.content}: any = undefined;`);
      opened++;
      for (const name of bindingNames(slotDir.exp.content)) scope.add(name);
    }

    const component = this.componentBinding(node.tag);
    const componentProps: string[] = [];
    for (const dir of directives) {
      if (dir.exp?.type !== 4 || ["if", "else-if", "show", "for", "slot"].includes(dir.name)) continue;
      const arg = dir.arg?.type === 4 && dir.arg.isStatic ? dir.arg.content : null;
      if (dir.name === "on") {
        emitAt(dir, `() => { ${this.expression(dir.exp.content, scope)} };`);
      } else if (dir.name === "bind" && arg && component) {
        componentProps.push(`${JSON.stringify(camelize(arg))}: ${this.expression(dir.exp.content, scope)}`);
      } else {
        emitAt(dir, `${this.expression(dir.exp.content, scope)};`);
      }
    }
    if (component && componentProps.length > 0) {
      this.emit(node.loc.start.line, node.loc.start.column, `${VUE_RENDER}(${component}, { ${componentProps.join(", ")} });`);
    }

    for (const child of node.children) this.walk(child, scope);
    if (opened > 0) this.emit(node.loc.end.line, node.loc.end.column, "}".repeat(opened));
  }

  /** `<user-card>` / `<UserCard>` → the script binding of the imported component, if any. */
  private componentBinding(tag: string): string | null {
    const pascal = camelize(tag).replace(/^./, (c) => c.toUpperCase());
    if (this.script.bindings.has(pascal)) return pascal;
    if (this.script.bindings.has(tag)) return tag;
    return null;
  }

  /** Rewrites free identifiers: props → `props.x`, script bindings and template locals → `__tacetUnref(x)`. */
  private expression(expr: string, locals: Set<string>): string {
    const text = `(${expr}\n)`;
    const sf = ts.createSourceFile("expr.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const declared = new Set<string>();
    const collectDeclared = (node: ts.Node) => {
      if ((ts.isParameter(node) || ts.isBindingElement(node) || ts.isVariableDeclaration(node)) && ts.isIdentifier(node.name)) {
        declared.add(node.name.text);
      }
      ts.forEachChild(node, collectDeclared);
    };
    collectDeclared(sf);

    const edits: { start: number; end: number; text: string }[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node) && isReference(node) && !declared.has(node.text)) {
        const replacement = this.reference(node.text, locals);
        if (replacement !== null) {
          const parent = node.parent;
          const text = ts.isShorthandPropertyAssignment(parent) ? `${node.text}: ${replacement}` : replacement;
          edits.push({ start: node.getStart(sf), end: node.getEnd(), text });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    let out = text;
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
      out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    }
    return out.replace(/\n\)$/, ")");
  }

  private reference(name: string, locals: Set<string>): string | null {
    if (locals.has(name)) return `${VUE_UNREF}(${name})`;
    if (this.script.bindings.has(name)) return `${VUE_UNREF}(${name})`;
    if (this.script.propNames.has(name) && this.script.propsVar) return `${PROPS_VAR}.${name}`;
    return null;
  }
}

/** An identifier that reads a variable (not a property name, declaration name, callee or assignment target). */
function isReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if ((ts.isParameter(parent) || ts.isBindingElement(parent) || ts.isVariableDeclaration(parent)) && parent.name === node) {
    return false;
  }
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isCallExpression(parent) && parent.expression === node) return false;
  if (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return false;
  }
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) return false;
  return true;
}

/** Names bound by a v-for alias or v-slot pattern: `item`, `{ id, name }`, `[a, b]`. */
function bindingNames(pattern: string): string[] {
  const sf = ts.createSourceFile("p.ts", `const ${pattern} = 0;`, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const collect = (name: ts.BindingName) => {
    if (ts.isIdentifier(name)) names.push(name.text);
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) collect(el.name);
  };
  const statement = sf.statements[0];
  if (statement && ts.isVariableStatement(statement)) {
    for (const decl of statement.declarationList.declarations) collect(decl.name);
  }
  return names;
}

function camelize(name: string): string {
  return name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());
}

