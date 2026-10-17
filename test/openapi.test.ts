import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The spec is written first and the code follows it, so this guards against
// a route being added without being documented.
describe("openapi.yaml", () => {
  const spec = readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8");
  const appSource = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");

  const routes = [...appSource.matchAll(/app\.(get|post|patch|delete)\("([^"]+)"/g)].map((m) => ({
    method: m[1] as string,
    path: (m[2] as string).replace(/:(\w+)/g, "{$1}"),
  }));

  it("finds the routes it is meant to check", () => {
    expect(routes.length).toBeGreaterThan(10);
  });

  it.each(routes)("documents $method $path", ({ method, path }) => {
    const start = spec.indexOf(`\n  ${path}:`);
    expect(start, `${path} missing from spec`).toBeGreaterThan(-1);
    const next = spec.indexOf("\n  /", start + 1);
    const block = spec.slice(start, next === -1 ? undefined : next);
    expect(block).toContain(`\n    ${method}:`);
  });
});
