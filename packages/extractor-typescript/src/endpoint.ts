import { Node, SyntaxKind } from "ts-morph";
import { normalizePath, PARAM_PLACEHOLDER } from "@tacet-api/core";

/**
 * Statically resolves the URL argument of an API call into a path pattern.
 * Returns null when the URL is fully dynamic (e.g. a bare variable), because
 * guessing would produce false links in the index.
 */
export function resolveEndpointExpression(expr: Node): string | null {
  const raw = resolveRaw(expr);
  if (raw === null || !raw.includes("/")) return null;
  return normalizePath(stripOrigin(raw));
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

function resolveRaw(expr: Node): string | null {
  if (Node.isStringLiteral(expr) || Node.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.getLiteralValue();
  }
  if (Node.isTemplateExpression(expr)) {
    let out = expr.getHead().getLiteralText();
    for (const span of expr.getTemplateSpans()) {
      out += PARAM_PLACEHOLDER + span.getLiteral().getLiteralText();
    }
    return out;
  }
  if (Node.isBinaryExpression(expr) && expr.getOperatorToken().getKind() === SyntaxKind.PlusToken) {
    const left = resolveRaw(expr.getLeft());
    const right = resolveRaw(expr.getRight());
    if (left === null && right === null) return null;
    return (left ?? PARAM_PLACEHOLDER) + (right ?? PARAM_PLACEHOLDER);
  }
  if (Node.isParenthesizedExpression(expr)) {
    return resolveRaw(expr.getExpression());
  }
  return null;
}

function stripOrigin(url: string): string {
  const match = url.match(/^[a-z]+:\/\/[^/]+(\/.*)?$/i);
  if (match) return match[1] ?? "/";
  return url.startsWith("/") ? url : `/${url}`;
}
