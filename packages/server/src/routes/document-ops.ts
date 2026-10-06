import {
  createDocument,
  type DocKind,
  type DocTarget,
  getDocument,
  linkDocumentById,
  type OpCtx,
  unlinkDocumentById,
  updateDocumentContent,
} from "@nod/core";
import type { Hono } from "hono";
import { type Body, invalid, optString, optStringArray, paramInt, readBody, reqString } from "../input";

function targetOf(body: Body): DocTarget {
  return { issueRef: optString(body, "issueRef"), projectRef: optString(body, "projectRef") };
}

// web からの Document の作成とリンク。書き手は me。パスの検証と原子性は core の createDocument が持つ
export function registerDocumentOps(app: Hono, me: OpCtx, docsDir?: string): void {
  app.post("/api/documents", async (c) => {
    const b = await readBody(c, ["path", "title", "kind", "body", "issueRef", "issueRefs", "projectRef"]);
    const doc = createDocument(me, {
      path: reqString(b, "path"),
      title: optString(b, "title")?.trim() || undefined,
      kind: optString(b, "kind") as DocKind | undefined,
      body: optString(b, "body"),
      ...targetOf(b),
      issueRefs: optStringArray(b, "issueRefs"),
      docsDir,
    });
    return c.json(doc, 201);
  });
  app.post("/api/documents/:id/link", async (c) => {
    const id = paramInt(c.req.param("id"), "Document の id ");
    linkDocumentById(me, id, targetOf(await readBody(c, ["issueRef", "projectRef"])));
    return c.json(getDocument(me.db, id));
  });
  app.post("/api/documents/:id/unlink", async (c) => {
    const id = paramInt(c.req.param("id"), "Document の id ");
    unlinkDocumentById(me, id, targetOf(await readBody(c, ["issueRef", "projectRef"])));
    return c.json(getDocument(me.db, id));
  });

  // 本文の保存。mtime は GET で受け取った値をそのまま返してもらい、違えば 409（CONFLICT）
  app.put("/api/documents/:id/content", async (c) => {
    const id = paramInt(c.req.param("id"), "Document の id ");
    const b = await readBody(c, ["content", "mtime"]);
    const content = reqString(b, "content");
    if (typeof b.mtime !== "number" || !Number.isFinite(b.mtime)) throw invalid("mtime は数値で指定してください");
    return c.json(updateDocumentContent(me, id, { content, mtime: b.mtime }));
  });
}
