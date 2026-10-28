import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildRegexDefinitions,
  collectRoutePaths,
} from "./generate-manifest";

function createFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "routes-fixture-"));
  const routes = path.join(root, "routes");
  mkdirSync(path.join(routes, "_public", "post"), { recursive: true });
  mkdirSync(path.join(routes, "_auth"), { recursive: true });
  mkdirSync(path.join(routes, "admin", "posts"), { recursive: true });
  mkdirSync(path.join(routes, "oauth"), { recursive: true });

  writeFileSync(path.join(routes, "__root.tsx"), "export {};\n");
  writeFileSync(path.join(routes, "_public", "route.tsx"), "export {};\n");
  writeFileSync(path.join(routes, "_public", "index.tsx"), "export {};\n");
  writeFileSync(path.join(routes, "_public", "posts.tsx"), "export {};\n");
  writeFileSync(
    path.join(routes, "_public", "post", "$slug.tsx"),
    "export {};\n",
  );
  writeFileSync(path.join(routes, "_auth", "route.tsx"), "export {};\n");
  writeFileSync(path.join(routes, "oauth", "consent.tsx"), "export {};\n");
  writeFileSync(path.join(routes, "admin", "route.tsx"), "export {};\n");
  writeFileSync(path.join(routes, "admin", "index.tsx"), "export {};\n");
  writeFileSync(
    path.join(routes, "admin", "posts", "edit.$id.tsx"),
    "export {};\n",
  );
  writeFileSync(
    path.join(routes, "admin", "posts", "index.tsx"),
    "export {};\n",
  );

  return root;
}

describe("manifest generation", () => {
  it("derives paths from route source files, ignoring layouts and pathless groups", () => {
    const root = createFixture();
    try {
      expect(collectRoutePaths(path.join(root, "routes"))).toEqual([
        "/",
        "/admin",
        "/admin/posts",
        "/admin/posts/edit/$id",
        "/oauth/consent",
        "/post/$slug",
        "/posts",
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("builds anchored regexes with params and trailing slash support", () => {
    const definitions = buildRegexDefinitions(["/", "/post/$slug"]);
    expect(definitions).toEqual([
      "/^\\/$/",
      "/^\\/post\\/[^/]+\\/?$/",
    ]);
  });

  it("keeps the real project's key routes in the manifest", () => {
    const paths = collectRoutePaths(path.join(process.cwd(), "src", "routes"));
    expect(paths).toContain("/");
    expect(paths).toContain("/post/$slug");
    expect(paths).toContain("/admin/posts/edit/$id");
    expect(paths.length).toBe(22);
  });
});
