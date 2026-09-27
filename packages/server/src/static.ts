import { statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { NodError } from "@nod/core";
import type { Hono } from "hono";

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function decodePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

// ビルド済みの web を配信する。拡張子のないパスは TanStack Router のディープリンクとして index.html を返す
export function registerStatic(app: Hono, dir: string): void {
  const root = resolve(dir);
  const index = resolve(root, "index.html");
  app.get("*", (c) => {
    const path = decodePath(new URL(c.req.url).pathname);
    if (path !== null) {
      const target = resolve(root, `.${path}`);
      // %2f で区切りを隠した .. を含むパスが、root の外を指していないか確かめる
      const inside = target === root || target.startsWith(root + sep);
      if (inside && isFile(target)) return new Response(Bun.file(target));
      if (extname(path) !== "") throw new NodError("NOT_FOUND", `${c.req.path} はありません`);
    }
    if (!isFile(index)) {
      throw new NodError("NOT_FOUND", `${root} に index.html がありません。web をビルドしてください`);
    }
    return new Response(Bun.file(index));
  });
}
