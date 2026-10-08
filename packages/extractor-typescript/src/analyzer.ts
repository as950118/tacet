import { Node, SyntaxKind, ts, type CallExpression, type SourceFile } from "ts-morph";
import {
  normalizePath,
  type ApiCallResolution,
  type TacetConfig,
  type DataFlowKind,
  type HttpMethod,
  type RequestShape,
} from "@tacet-api/core";
import { objectLiteralKeys, resolveEndpointExpression, resolveStaticString, resolveUrlQueryKeys } from "./endpoint.js";

/**
 * - body:      (a sub-part of) the response body, located at `path`
 * - envelope:  an object whose `.data` is the body at `path` (axios response, useQuery/useSWR result)
 * - fetchResponse: a fetch() Response; `.json()` yields the body
 */
export type ValueKind = "body" | "envelope" | "fetchResponse";

/**
 * Containers around a value, outermost first:
 * - query:    a React Query / SWR result; `.data` is the value
 * - vueQuery: a Vue Query result; `.data` is a ref to the value
 * - ref:      a Vue ref / computed; `.value` is the value
 */
export type ValueWrapper = "query" | "vueQuery" | "ref";

export interface TrackedValue {
  apiCallId: string;
  kind: ValueKind;
  path: string[];
  flow: DataFlowKind;
  wrappers?: ValueWrapper[];
}

/** The response body (or a part of it) itself, not wrapped in a query result or ref. */
export function isBody(value: TrackedValue | null | undefined): value is TrackedValue {
  return value?.kind === "body" && !value.wrappers?.length;
}

export interface Endpoint {
  pattern: string | null;
  method: HttpMethod | null;
}

export interface ApiCallTarget {
  endpoint: Endpoint;
  /** baseURL of the axios instance the request goes through, when known statically. */
  baseUrl: string | null;
  request: RequestShape;
  /** The API client function a `wrapper` call goes through. */
  wrapper: FunctionLike | null;
  resolution: ApiCallResolution;
  resultKind: ValueKind;
  resultPath: string[];
  resultWrappers?: ValueWrapper[];
  flow: DataFlowKind;
}

export interface RecordedAccess {
  node: Node;
  object: string;
  code: string;
  value: TrackedValue;
}

export type FunctionLike =
  | import("ts-morph").FunctionDeclaration
  | import("ts-morph").FunctionExpression
  | import("ts-morph").ArrowFunction
  | import("ts-morph").MethodDeclaration;

interface WrapperInfo {
  endpointFor(call: CallExpression): Endpoint;
  baseUrl: string | null;
  resultKind: ValueKind;
  resultPath: string[];
  resultWrappers?: ValueWrapper[];
  flow: DataFlowKind;
}

const AXIOS_METHODS = new Set(["get", "post", "put", "delete", "patch"]);
const AXIOS_BODY_METHODS = new Set(["post", "put", "patch"]);
const UNKNOWN_REQUEST: RequestShape = { queryKeys: null, bodyKeys: null };
const ELEMENT_CALLBACK_METHODS = new Set([
  "map", "forEach", "filter", "find", "findLast", "some", "every", "flatMap",
]);
const SAME_ARRAY_METHODS = new Set(["filter", "slice", "sort", "reverse", "toSorted", "toReversed"]);
const ELEMENT_RESULT_METHODS = new Set(["find", "findLast", "at"]);
const QUERY_HOOKS = new Set(["useQuery", "useSuspenseQuery", "useSWR", "useSWRImmutable"]);
const STATE_HOOKS = new Set(["useState", "React.useState"]);
const VUE_REF_FUNCTIONS = new Set(["ref", "shallowRef", "computed", "toRef", "readonly", "shallowReadonly"]);
const VUE_UNREF_FUNCTIONS = new Set(["unref", "toValue"]);

export function isFunctionLike(node: Node): node is FunctionLike {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node)
  );
}

export function nodeLocation(node: Node): { line: number; column: number } {
  return node.getSourceFile().getLineAndColumnAtPos(node.getStart());
}

type SymbolKey = ts.Symbol;

/**
 * Tracks where API response values flow. Values are keyed by TypeScript
 * symbols (not names), so shadowing and cross-file imports resolve
 * correctly. Evaluation is deterministic: anything Tacet cannot follow is
 * either dropped or marked `derived`, never guessed.
 */
export class DataFlowAnalyzer {
  private readonly env = new Map<SymbolKey, TrackedValue>();
  private readonly propsEnv = new Map<SymbolKey, Map<string, TrackedValue>>();
  private readonly setterToState = new Map<SymbolKey, SymbolKey>();
  private readonly callTargets = new Map<Node, ApiCallTarget | null>();
  private readonly wrappers = new Map<Node, WrapperInfo | null>();
  private readonly evaluatingFunctions = new Set<Node>();
  private readonly destructuredAccesses = new Map<Node, RecordedAccess>();

  constructor(
    private readonly config: TacetConfig,
    private readonly callIdOf: (call: CallExpression) => string,
    /** Build-time env variables (`import.meta.env.X`) used to resolve axios baseURLs. */
    private readonly envVars: Record<string, string> = {},
  ) {}

  /** Propagates tracked values through the given files. Run to a fixpoint so declaration order does not matter. */
  propagate(files: SourceFile[], iterations = 2): void {
    for (let i = 0; i < iterations; i++) {
      for (const file of files) {
        file.forEachDescendant((node) => this.visitForPropagation(node));
      }
    }
  }

  get recordedDestructuringAccesses(): RecordedAccess[] {
    return [...this.destructuredAccesses.values()];
  }

  classifyCall(call: CallExpression): ApiCallTarget | null {
    if (this.callTargets.has(call)) return this.callTargets.get(call)!;
    this.callTargets.set(call, null);
    const target = this.computeCallTarget(call);
    this.callTargets.set(call, target);
    return target;
  }

  evaluate(expr: Node): TrackedValue | null {
    const e = unwrap(expr);
    if (Node.isIdentifier(e)) {
      const sym = symbolOf(e);
      return sym ? this.env.get(sym) ?? null : null;
    }
    if (Node.isPropertyAccessExpression(e)) {
      const base = e.getExpression();
      const propsSym = Node.isIdentifier(unwrap(base)) ? symbolOf(unwrap(base)) : undefined;
      if (propsSym && this.propsEnv.has(propsSym)) {
        return this.propsEnv.get(propsSym)!.get(e.getName()) ?? null;
      }
      return step(this.evaluate(base), e.getName());
    }
    if (Node.isElementAccessExpression(e)) {
      const arg = e.getArgumentExpression();
      const segment =
        arg && (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg))
          ? arg.getLiteralValue()
          : "[]";
      return step(this.evaluate(e.getExpression()), segment);
    }
    if (Node.isCallExpression(e)) return this.evaluateCall(e);
    if (Node.isConditionalExpression(e)) {
      return this.evaluate(e.getWhenTrue()) ?? this.evaluate(e.getWhenFalse());
    }
    if (Node.isBinaryExpression(e)) {
      const op = e.getOperatorToken().getKind();
      // `a && a.b` yields its right operand; `a ?? b` / `a || b` yield the left one unless it is missing.
      if (op === SyntaxKind.AmpersandAmpersandToken) {
        return this.evaluate(e.getRight()) ?? this.evaluate(e.getLeft());
      }
      if (op === SyntaxKind.QuestionQuestionToken || op === SyntaxKind.BarBarToken) {
        return this.evaluate(e.getLeft()) ?? this.evaluate(e.getRight());
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Propagation
  // -------------------------------------------------------------------------

  private visitForPropagation(node: Node): void {
    if (Node.isVariableDeclaration(node)) {
      this.bindDeclaration(node);
    } else if (
      Node.isBinaryExpression(node) &&
      node.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
      Node.isIdentifier(node.getLeft())
    ) {
      const value = this.evaluate(node.getRight());
      const sym = symbolOf(node.getLeft());
      if (value && sym) this.env.set(sym, value);
    } else if (
      Node.isBinaryExpression(node) &&
      node.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
      Node.isPropertyAccessExpression(node.getLeft())
    ) {
      // Vue: `items.value = res.data` makes `items` a ref to the response.
      const left = node.getLeft() as import("ts-morph").PropertyAccessExpression;
      const target = unwrap(left.getExpression());
      const value = left.getName() === "value" && Node.isIdentifier(target) ? this.evaluate(node.getRight()) : null;
      const sym = value ? symbolOf(target) : undefined;
      if (value && sym) this.env.set(sym, wrap(value, "ref"));
    } else if (Node.isCallExpression(node)) {
      this.evaluate(node);
    } else if (Node.isJsxAttribute(node)) {
      this.bindJsxProp(node);
    } else if (Node.isForOfStatement(node)) {
      const init = node.getInitializer();
      const value = step(this.evaluate(node.getExpression()), "[]");
      if (value && Node.isVariableDeclarationList(init)) {
        for (const decl of init.getDeclarations()) {
          this.bindTarget(decl.getNameNode(), value, node.getExpression().getText(), decl);
        }
      }
    }
  }

  private bindDeclaration(decl: import("ts-morph").VariableDeclaration): void {
    const init = decl.getInitializer();
    if (!init) return;
    const nameNode = decl.getNameNode();
    const unwrapped = unwrap(init);
    if (
      Node.isArrayBindingPattern(nameNode) &&
      Node.isCallExpression(unwrapped) &&
      STATE_HOOKS.has(unwrapped.getExpression().getText())
    ) {
      const [state, setter] = nameNode.getElements();
      if (Node.isBindingElement(state) && Node.isBindingElement(setter)) {
        const stateSym = symbolOf(state.getNameNode());
        const setterSym = symbolOf(setter.getNameNode());
        if (stateSym && setterSym) this.setterToState.set(setterSym, stateSym);
      }
      return;
    }
    const value = this.evaluate(init);
    if (value) this.bindTarget(nameNode, value, init.getText(), decl);
  }

  /** Binds a name or destructuring pattern to a value, recording destructured field reads as accesses. */
  private bindTarget(nameNode: Node, value: TrackedValue, objectText: string, site: Node): void {
    if (Node.isIdentifier(nameNode)) {
      const sym = symbolOf(nameNode);
      if (sym) this.env.set(sym, value);
      return;
    }
    if (Node.isObjectBindingPattern(nameNode)) {
      for (const element of nameNode.getElements()) {
        if (element.getDotDotDotToken()) {
          this.bindTarget(element.getNameNode(), value, objectText, site);
          continue;
        }
        const key = element.getPropertyNameNode()?.getText() ?? element.getName();
        const child = step(value, key);
        if (!child) continue;
        if (isBody(child) && child.path.length > 0) {
          this.destructuredAccesses.set(element, {
            node: element,
            object: objectText,
            code: site.getText(),
            value: child,
          });
        }
        this.bindTarget(element.getNameNode(), child, objectText, site);
      }
      return;
    }
    if (Node.isArrayBindingPattern(nameNode)) {
      const child = step(value, "[]");
      if (!child) return;
      for (const element of nameNode.getElements()) {
        if (Node.isBindingElement(element)) {
          this.bindTarget(element.getNameNode(), child, objectText, site);
        }
      }
    }
  }

  private bindParam(fn: FunctionLike, index: number, value: TrackedValue, objectText: string): void {
    const param = fn.getParameters()[index];
    if (param) this.bindTarget(param.getNameNode(), value, objectText, param);
  }

  private bindJsxProp(attr: import("ts-morph").JsxAttribute): void {
    const init = attr.getInitializer();
    if (!Node.isJsxExpression(init)) return;
    const expr = init.getExpression();
    const value = expr ? this.evaluate(expr) : null;
    if (!value || !expr) return;

    const opening = attr.getParent().getParent();
    if (!Node.isJsxOpeningElement(opening) && !Node.isJsxSelfClosingElement(opening)) return;
    const component = resolveFunctionNode(opening.getTagNameNode());
    const propsParam = component?.getParameters()[0];
    if (!propsParam) return;

    const propName = attr.getNameNode().getText();
    const propsName = propsParam.getNameNode();
    if (Node.isObjectBindingPattern(propsName)) {
      const element = propsName
        .getElements()
        .find((el) => (el.getPropertyNameNode()?.getText() ?? el.getName()) === propName);
      if (element) this.bindTarget(element.getNameNode(), value, expr.getText(), element);
    } else if (Node.isIdentifier(propsName)) {
      const sym = symbolOf(propsName);
      if (!sym) return;
      const bag = this.propsEnv.get(sym) ?? new Map<string, TrackedValue>();
      bag.set(propName, value);
      this.propsEnv.set(sym, bag);
    }
  }

  // -------------------------------------------------------------------------
  // Call evaluation
  // -------------------------------------------------------------------------

  private evaluateCall(call: CallExpression): TrackedValue | null {
    const target = this.classifyCall(call);
    if (target) {
      return {
        apiCallId: this.callIdOf(call),
        kind: target.resultKind,
        path: target.resultPath,
        flow: target.flow,
        ...(target.resultWrappers?.length ? { wrappers: target.resultWrappers } : {}),
      };
    }

    const callee = unwrap(call.getExpression());
    const args = call.getArguments();
    const calleeText = callee.getText();

    if (QUERY_HOOKS.has(calleeText)) {
      return this.evaluateQueryHook(args, /vue-query$/.test(importSource(callee) ?? "") ? "vueQuery" : "query");
    }
    if (Node.isIdentifier(callee) && isVueImport(callee)) {
      const name = importedName(callee) ?? calleeText;
      if (VUE_REF_FUNCTIONS.has(name) || VUE_UNREF_FUNCTIONS.has(name)) {
        const arg = args[0];
        const value = !arg ? null : isFunctionLike(arg) ? this.evaluateFunctionResult(arg) : this.evaluate(arg);
        if (!value) return null;
        return VUE_REF_FUNCTIONS.has(name) ? wrap(value, "ref") : unwrapRef(value);
      }
    }

    if (Node.isIdentifier(callee)) {
      const sym = symbolOf(callee);
      const stateSym = sym ? this.setterToState.get(sym) : undefined;
      if (stateSym) {
        const value = args[0] ? this.evaluate(args[0]) : null;
        if (value) this.env.set(stateSym, value);
        return null;
      }
    }

    if (Node.isPropertyAccessExpression(callee)) {
      const method = callee.getName();
      const receiver = this.evaluate(callee.getExpression());
      if (receiver) return this.evaluateMethodCall(receiver, method, args, callee);
    }

    return this.evaluateUserFunctionCall(call, args);
  }

  private evaluateMethodCall(
    receiver: TrackedValue,
    method: string,
    args: Node[],
    callee: Node,
  ): TrackedValue | null {
    if (receiver.wrappers?.length) return null;
    if (receiver.kind === "fetchResponse" && method === "json") {
      return { ...receiver, kind: "body", path: [] };
    }
    if (method === "then") {
      const callback = args[0];
      if (callback && isFunctionLike(callback)) {
        this.bindParam(callback, 0, receiver, callee.getText());
        return this.evaluateFunctionResult(callback);
      }
      if (callback && Node.isIdentifier(callback)) {
        const sym = symbolOf(callback);
        const stateSym = sym ? this.setterToState.get(sym) : undefined;
        if (stateSym) this.env.set(stateSym, receiver);
      }
      return null;
    }
    if (receiver.kind !== "body") return null;

    const element = step(receiver, "[]")!;
    if (ELEMENT_CALLBACK_METHODS.has(method)) {
      const callback = args[0];
      if (callback && isFunctionLike(callback)) {
        this.bindParam(callback, 0, element, callee.getText());
      }
    }
    if (SAME_ARRAY_METHODS.has(method)) return receiver;
    if (ELEMENT_RESULT_METHODS.has(method)) return element;
    return null;
  }

  /** Follows a tracked argument into a function defined in the project; falls back to a `derived` value. */
  private evaluateUserFunctionCall(call: CallExpression, args: Node[]): TrackedValue | null {
    const trackedArgs = args.map((arg) => this.evaluate(arg));
    const firstTracked = trackedArgs.find(isBody);
    if (!firstTracked) return null;

    const fn = resolveFunctionNode(call.getExpression());
    if (fn) {
      trackedArgs.forEach((value, i) => {
        if (value) this.bindParam(fn, i, value, args[i].getText());
      });
      const result = this.evaluateFunctionResult(fn);
      if (result) return result;
    }
    return { ...firstTracked, path: [], flow: "derived" };
  }

  private evaluateQueryHook(args: Node[], wrapper: "query" | "vueQuery"): TrackedValue | null {
    for (const arg of args) {
      let fn: Node | undefined = arg;
      if (Node.isObjectLiteralExpression(arg)) {
        const queryFn = arg.getProperty("queryFn");
        fn = Node.isPropertyAssignment(queryFn) ? queryFn.getInitializer() : undefined;
      }
      if (fn && isFunctionLike(fn)) {
        const result = this.evaluateFunctionResult(fn);
        if (result) return wrap(result, wrapper);
      }
    }
    return null;
  }

  private evaluateFunctionResult(fn: FunctionLike): TrackedValue | null {
    if (this.evaluatingFunctions.has(fn)) return null;
    this.evaluatingFunctions.add(fn);
    try {
      for (const decl of fn.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        this.bindDeclaration(decl);
      }
      for (const expr of returnExpressions(fn)) {
        const value = this.evaluate(expr);
        if (value) return value;
      }
      return null;
    } finally {
      this.evaluatingFunctions.delete(fn);
    }
  }

  // -------------------------------------------------------------------------
  // API call classification
  // -------------------------------------------------------------------------

  private computeCallTarget(call: CallExpression): ApiCallTarget | null {
    const callee = unwrap(call.getExpression());
    const args = call.getArguments();
    const key = calleeKey(callee);

    const mapped = key ? this.config.apiClientMap?.[key] : undefined;
    if (mapped) {
      return {
        endpoint: { pattern: normalizePath(mapped.path), method: mapped.method },
        baseUrl: null,
        request: UNKNOWN_REQUEST,
        wrapper: null,
        resolution: "config",
        resultKind: "body",
        resultPath: [],
        flow: "direct",
      };
    }

    if (Node.isPropertyAccessExpression(callee) && AXIOS_METHODS.has(callee.getName())) {
      if (isAxiosInstance(callee.getExpression())) {
        const baseUrl = axiosBaseUrl(callee.getExpression(), this.envVars);
        return {
          endpoint: {
            pattern: args[0] ? resolveEndpointExpression(args[0], baseUrl, this.envVars) : null,
            method: callee.getName().toUpperCase() as HttpMethod,
          },
          baseUrl,
          request: axiosRequest(callee.getName(), args),
          wrapper: null,
          resolution: "direct",
          resultKind: "envelope",
          resultPath: [],
          flow: "direct",
        };
      }
    }

    if (key === "fetch" || key === "window.fetch") {
      return {
        endpoint: {
          pattern: args[0] ? resolveEndpointExpression(args[0], null, this.envVars) : null,
          method: fetchMethod(args[1]),
        },
        baseUrl: null,
        request: fetchRequest(args),
        wrapper: null,
        resolution: "direct",
        resultKind: "fetchResponse",
        resultPath: [],
        flow: "direct",
      };
    }

    const fn = resolveFunctionNode(callee);
    const wrapper = fn ? this.wrapperInfo(fn) : null;
    if (wrapper) {
      return {
        endpoint: wrapper.endpointFor(call),
        baseUrl: wrapper.baseUrl,
        request: UNKNOWN_REQUEST,
        wrapper: fn,
        resolution: "wrapper",
        resultKind: wrapper.resultKind,
        resultPath: wrapper.resultPath,
        resultWrappers: wrapper.resultWrappers,
        flow: wrapper.flow,
      };
    }
    return null;
  }

  /** A function is an API wrapper when one of its return values is traceable to an API call. */
  private wrapperInfo(fn: FunctionLike): WrapperInfo | null {
    if (this.wrappers.has(fn)) return this.wrappers.get(fn)!;
    this.wrappers.set(fn, null);

    const result = this.evaluateFunctionResult(fn);
    const innerCall = result ? this.findInnerApiCall(fn, result.apiCallId) : undefined;
    const innerTarget = innerCall ? this.classifyCall(innerCall) : null;
    if (!result || !innerCall || !innerTarget) return null;

    const urlParamIndex = paramIndexOfUrlArg(fn, innerCall);
    const info: WrapperInfo = {
      endpointFor: (call) => {
        if (innerTarget.endpoint.pattern !== null || urlParamIndex === null) {
          return innerTarget.endpoint;
        }
        const arg = call.getArguments()[urlParamIndex];
        return {
          pattern: arg ? resolveEndpointExpression(arg, innerTarget.baseUrl, this.envVars) : null,
          method: innerTarget.endpoint.method,
        };
      },
      baseUrl: innerTarget.baseUrl,
      resultKind: result.kind,
      resultPath: result.path,
      resultWrappers: result.wrappers,
      flow: result.flow,
    };
    this.wrappers.set(fn, info);
    return info;
  }

  private findInnerApiCall(fn: FunctionLike, apiCallId: string): CallExpression | undefined {
    return fn
      .getDescendantsOfKind(SyntaxKind.CallExpression)
      .find((c) => this.callIdOf(c) === apiCallId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function step(value: TrackedValue | null, segment: string): TrackedValue | null {
  if (!value) return null;
  const [outer, ...rest] = value.wrappers ?? [];
  if (outer) {
    const inner = { ...value, wrappers: rest };
    if (outer === "query" && segment === "data") return inner;
    if (outer === "vueQuery" && segment === "data") return { ...value, wrappers: ["ref", ...rest] };
    if (outer === "ref" && segment === "value") return inner;
    return null;
  }
  if (value.kind === "body") return { ...value, path: [...value.path, segment] };
  if (value.kind === "envelope" && segment === "data") return { ...value, kind: "body" };
  return null;
}

function wrap(value: TrackedValue, wrapper: ValueWrapper): TrackedValue {
  return { ...value, wrappers: [wrapper, ...(value.wrappers ?? [])] };
}

function unwrapRef(value: TrackedValue): TrackedValue {
  return value.wrappers?.[0] === "ref" ? { ...value, wrappers: value.wrappers.slice(1) } : value;
}

/** Module an identifier is imported from (`import { useQuery } from "@tanstack/vue-query"`), if any. */
function importSource(node: Node): string | undefined {
  const decl = (Node.isIdentifier(node) ? node : undefined)?.getSymbol()?.getDeclarations()[0];
  return decl?.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)?.getModuleSpecifierValue();
}

/** Exported name an imported identifier refers to (`ref` for `import { ref as r } from "vue"`). */
function importedName(node: Node): string | undefined {
  const decl = node.getSymbol()?.getDeclarations()[0];
  return Node.isImportSpecifier(decl) ? decl.getName() : undefined;
}

function isVueImport(node: Node): boolean {
  const source = importSource(node);
  return source === "vue" || source === "@vue/reactivity" || source === "@vue/runtime-core";
}

function unwrap(node: Node): Node {
  let current = node;
  while (
    Node.isAwaitExpression(current) ||
    Node.isParenthesizedExpression(current) ||
    Node.isNonNullExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isTypeAssertion(current) ||
    Node.isSatisfiesExpression(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

function symbolOf(node: Node): SymbolKey | undefined {
  return node.getSymbol()?.compilerSymbol;
}

/** Symbol a callee refers to, following import aliases to the original declaration. */
function targetSymbol(node: Node): import("ts-morph").Symbol | undefined {
  const n = unwrap(node);
  const symbol = Node.isPropertyAccessExpression(n) ? n.getNameNode().getSymbol() : n.getSymbol();
  if (symbol?.isAlias()) return symbol.getAliasedSymbol() ?? symbol;
  return symbol;
}

function calleeKey(callee: Node): string | null {
  if (Node.isIdentifier(callee)) return callee.getText();
  if (Node.isPropertyAccessExpression(callee)) {
    return `${callee.getExpression().getText()}.${callee.getName()}`;
  }
  return null;
}

/**
 * True for the `axios` import itself or a variable initialized with an axios instance:
 * `axios.create(...)`, another instance, or a call to a project factory function that returns one
 * (`const api = createApiInstance({ baseURL })`).
 */
function isAxiosInstance(expr: Node, seen = new Set<Node>()): boolean {
  if (!Node.isIdentifier(expr)) return false;
  if (expr.getText() === "axios") return true;
  const decl = targetSymbol(expr)?.getDeclarations()[0];
  if (!Node.isVariableDeclaration(decl) || seen.has(decl)) return false;
  seen.add(decl);
  return createsAxiosInstance(decl.getInitializer(), seen);
}

function createsAxiosInstance(expr: Node | undefined, seen: Set<Node>): boolean {
  if (!expr) return false;
  const e = unwrap(expr);
  if (Node.isIdentifier(e)) return isAxiosInstance(e, seen);
  if (!Node.isCallExpression(e)) return false;
  if (e.getExpression().getText() === "axios.create") return true;
  const fn = resolveFunctionNode(e.getExpression());
  if (!fn || seen.has(fn)) return false;
  seen.add(fn);
  return returnExpressions(fn).some((ret) => createsAxiosInstance(ret, seen));
}

/**
 * The `baseURL` an axios instance was created with: from the object literal passed to `axios.create(...)` or
 * to the factory that made it (`createApiInstance({ baseURL: API_PATH })`), or found inside the factory.
 */
function axiosBaseUrl(expr: Node, env: Record<string, string>, seen = new Set<Node>()): string | null {
  if (!Node.isIdentifier(expr) || expr.getText() === "axios") return null;
  const decl = targetSymbol(expr)?.getDeclarations()[0];
  if (!Node.isVariableDeclaration(decl) || seen.has(decl)) return null;
  seen.add(decl);
  return creationBaseUrl(decl.getInitializer(), env, seen);
}

function creationBaseUrl(expr: Node | undefined, env: Record<string, string>, seen: Set<Node>): string | null {
  if (!expr) return null;
  const e = unwrap(expr);
  if (Node.isIdentifier(e)) return axiosBaseUrl(e, env, seen);
  if (!Node.isCallExpression(e)) return null;
  for (const arg of e.getArguments()) {
    if (!Node.isObjectLiteralExpression(arg)) continue;
    const prop = arg.getProperty("baseURL");
    if (Node.isPropertyAssignment(prop)) {
      const init = prop.getInitializer();
      return init ? resolveStaticString(init, env) : null;
    }
    if (Node.isShorthandPropertyAssignment(prop)) return resolveStaticString(prop, env);
  }
  if (e.getExpression().getText() === "axios.create") return null;
  const fn = resolveFunctionNode(e.getExpression());
  if (!fn || seen.has(fn)) return null;
  seen.add(fn);
  for (const ret of returnExpressions(fn)) {
    const baseUrl = creationBaseUrl(ret, env, seen);
    if (baseUrl !== null) return baseUrl;
  }
  return null;
}

/** axios.get(url, config) / axios.post(url, body, config): query keys from the URL and `config.params`. */
function axiosRequest(method: string, args: Node[]): RequestShape {
  const hasBody = AXIOS_BODY_METHODS.has(method);
  const config = args[hasBody ? 2 : 1];
  const urlKeys = args[0] ? resolveUrlQueryKeys(args[0]) : [];
  let paramKeys: string[] | null = [];
  if (config) {
    if (!Node.isObjectLiteralExpression(config)) {
      paramKeys = null;
    } else {
      const params = config.getProperty("params");
      paramKeys = params === undefined ? [] : Node.isPropertyAssignment(params) ? objectLiteralKeys(params.getInitializer()) : null;
    }
  }
  const body = args[1];
  return {
    queryKeys: urlKeys === null || paramKeys === null ? null : [...urlKeys, ...paramKeys],
    bodyKeys: !hasBody ? [] : body === undefined ? [] : objectLiteralKeys(body),
  };
}

/** fetch(url, { body: JSON.stringify({...}) }) */
function fetchRequest(args: Node[]): RequestShape {
  const queryKeys = args[0] ? resolveUrlQueryKeys(args[0]) : [];
  const options = args[1];
  if (!options) return { queryKeys, bodyKeys: [] };
  if (!Node.isObjectLiteralExpression(options)) return { queryKeys, bodyKeys: null };
  const body = options.getProperty("body");
  if (body === undefined) return { queryKeys, bodyKeys: [] };
  const init = Node.isPropertyAssignment(body) ? body.getInitializer() : undefined;
  if (Node.isCallExpression(init) && init.getExpression().getText() === "JSON.stringify") {
    return { queryKeys, bodyKeys: objectLiteralKeys(init.getArguments()[0]) };
  }
  return { queryKeys, bodyKeys: null };
}

function fetchMethod(options: Node | undefined): HttpMethod {
  if (Node.isObjectLiteralExpression(options)) {
    const prop = options.getProperty("method");
    const init = Node.isPropertyAssignment(prop) ? prop.getInitializer() : undefined;
    if (init && (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init))) {
      return init.getLiteralValue().toUpperCase() as HttpMethod;
    }
  }
  return "GET";
}

/** Resolves a callee / JSX tag to the function-like node it refers to, if it is defined in project source. */
export function resolveFunctionNode(callee: Node): FunctionLike | null {
  const symbol = targetSymbol(callee);
  if (!symbol) return null;

  for (const decl of symbol.getDeclarations()) {
    if (decl.getSourceFile().isDeclarationFile()) continue;
    if (Node.isFunctionDeclaration(decl) || Node.isMethodDeclaration(decl)) return decl;
    if (Node.isVariableDeclaration(decl) || Node.isPropertyAssignment(decl)) {
      const init = decl.getInitializer();
      if (!init) continue;
      if (isFunctionLike(init)) return init;
      // const UserCard = memo((props) => ...)
      if (Node.isCallExpression(init)) {
        const inner = init.getArguments()[0];
        if (inner && isFunctionLike(inner)) return inner;
      }
    }
  }
  return null;
}

function returnExpressions(fn: FunctionLike): Node[] {
  const body = fn.getBody();
  if (!body) return [];
  if (!Node.isBlock(body)) return [body];
  return fn
    .getDescendantsOfKind(SyntaxKind.ReturnStatement)
    .filter((ret) => ret.getFirstAncestor(isFunctionLike) === fn)
    .map((ret) => ret.getExpression())
    .filter((e): e is NonNullable<typeof e> => e !== undefined);
}

/** When a wrapper passes one of its own parameters as the URL (e.g. request(url)), returns that parameter index. */
function paramIndexOfUrlArg(fn: FunctionLike, innerCall: CallExpression): number | null {
  const urlArg = innerCall.getArguments()[0];
  if (!urlArg || !Node.isIdentifier(urlArg)) return null;
  const decl = urlArg.getSymbol()?.getDeclarations()[0];
  if (!decl || !Node.isParameterDeclaration(decl)) return null;
  const index = fn.getParameters().indexOf(decl);
  return index >= 0 ? index : null;
}
