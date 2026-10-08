import { Node, SyntaxKind } from "ts-morph";
import { normalizePath, PARAM_PLACEHOLDER } from "@tacet-api/core";

/**
 * Statically resolves the URL argument of an API call into a path pattern.
 * Returns null when the URL is fully dynamic (e.g. a bare variable), because
 * guessing would produce false links in the index.
 */
export function resolveEndpointExpression(
  expr: Node,
  baseUrl: string | null = null,
  env: Record<string, string> = {},
): string | null {
  const raw = resolveRaw(expr, env);
  if (raw === null || raw === PARAM_PLACEHOLDER) return null;
  // axios prepends baseURL unless the URL is absolute.
  if (baseUrl !== null && !ABSOLUTE_URL.test(raw)) return normalizePath(`${stripOrigin(baseUrl)}/${raw}`);
  if (!raw.includes("/")) return null;
  return normalizePath(stripOrigin(raw));
}

/**
 * Evaluates an expression to a string only when every part of it is known statically: literals, `const`
 * variables (also imported ones), template literals, `+`, and `import.meta.env.X` / `process.env.X` looked
 * up in `env`. Used for axios `baseURL`s, which usually come from build-time env variables.
 */
export function resolveStaticString(expr: Node, env: Record<string, string>, depth = 0): string | null {
  if (depth > 20) return null;
  const next = (e: Node) => resolveStaticString(e, env, depth + 1);
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) return expr.getLiteralValue();
  if (Node.isTemplateExpression(expr)) {
    let out = expr.getHead().getLiteralText();
    for (const span of expr.getTemplateSpans()) {
      const value = next(span.getExpression());
      if (value === null) return null;
      out += value + span.getLiteral().getLiteralText();
    }
    return out;
  }
  if (Node.isBinaryExpression(expr) && expr.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
    const left = next(expr.getLeft());
    const right = left === null ? null : next(expr.getRight());
    return left === null || right === null ? null : left + right;
  }
  if (Node.isParenthesizedExpression(expr) || Node.isAsExpression(expr) || Node.isNonNullExpression(expr)) {
    return next(expr.getExpression());
  }
  if (Node.isPropertyAccessExpression(expr)) {
    const object = expr.getExpression().getText().replace(/\s+/g, "");
    if (object === "import.meta.env" || object === "process.env") return env[expr.getName()] ?? null;
    return null;
  }
  if (Node.isIdentifier(expr) || Node.isShorthandPropertyAssignment(expr)) {
    let symbol = Node.isShorthandPropertyAssignment(expr) ? expr.getValueSymbol() : expr.getSymbol();
    if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol() ?? symbol;
    const decl = symbol?.getDeclarations()[0];
    if (!Node.isVariableDeclaration(decl)) return null;
    const init = decl.getInitializer();
    return init ? next(init) : null;
  }
  return null;
}

/** Query parameter names written into the URL itself, e.g. `/users?page=1&size=${n}` -> ["page", "size"]. */
export function resolveUrlQueryKeys(expr: Node): string[] | null {
  const raw = resolveRaw(expr);
  if (raw === null) return null;
  const query = raw.split("?")[1];
  if (query === undefined) return [];
  return query
    .split("&")
    .map((pair) => pair.split("=")[0])
    .filter((key) => key !== "" && key !== PARAM_PLACEHOLDER);
}

/** Keys of an object literal, or null when they cannot be known statically (spreads, computed keys, non-literals). */
export function objectLiteralKeys(expr: Node | undefined): string[] | null {
  if (!expr || !Node.isObjectLiteralExpression(expr)) return null;
  const keys: string[] = [];
  for (const prop of expr.getProperties()) {
    if (Node.isPropertyAssignment(prop) || Node.isShorthandPropertyAssignment(prop) || Node.isMethodDeclaration(prop)) {
      const name = prop.getNameNode();
      if (Node.isComputedPropertyName(name)) return null;
      keys.push(Node.isStringLiteral(name) ? name.getLiteralValue() : name.getText());
    } else {
      return null;
    }
  }
  return keys;
}

/** URL text with dynamic parts as `{param}`; constants (`${BASE_PATH}/items`) are inlined. */
function resolveRaw(expr: Node, env: Record<string, string> = {}): string | null {
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.getLiteralValue();
  }
  if (Node.isTemplateExpression(expr)) {
    let out = expr.getHead().getLiteralText();
    for (const span of expr.getTemplateSpans()) {
      out += (resolveStaticString(span.getExpression(), env) ?? PARAM_PLACEHOLDER) + span.getLiteral().getLiteralText();
    }
    return out;
  }
  if (Node.isIdentifier(expr) || Node.isPropertyAccessExpression(expr)) {
    return resolveStaticString(expr, env);
  }
  if (Node.isBinaryExpression(expr) && expr.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
    const left = resolveRaw(expr.getLeft(), env);
    const right = resolveRaw(expr.getRight(), env);
    if (left === null && right === null) return null;
    return (left ?? PARAM_PLACEHOLDER) + (right ?? PARAM_PLACEHOLDER);
  }
  if (Node.isParenthesizedExpression(expr)) {
    return resolveRaw(expr.getExpression(), env);
  }
  return null;
}

const ABSOLUTE_URL = /^([a-z]+:)?\/\//i;

function stripOrigin(url: string): string {
  const match = url.match(/^[a-z]+:\/\/[^/]+(\/.*)?$/i);
  if (match) return match[1] ?? "/";
  return url.startsWith("/") ? url : `/${url}`;
}
