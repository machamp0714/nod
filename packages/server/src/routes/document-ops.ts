import {
  createDocument,
  type DocKind,
  type DocTarget,
  getDocument,
  linkDocumentById,
  type OpCtx,
  unlinkDocumentById,
} from "@nod/core";
import type { Hono } from "hono";
import { type Body, optString, paramInt, readBody, reqString } from "../input";

function targetOf(body: Body): DocTarget {
  return { issueRef: optString(body, "issueRef"), projectRef: optString(body, "projectRef") };
}

// web からの Document の作成とリンク。書き手は me。パスの検証と原子性は core の createDocument が持つ
export function registerDocumentOps(app: Hono, me: OpCtx, docsDir?: string): void {
  app.post("/api/documents", async (c) => {
    const b = await readBody(c, ["path", "title", "kind", "body", "issueRef", "projectRef"]);
    const doc = createDocument(me, {
      path: reqString(b, "path"),
      title: optString(b, "title")?.trim() || undefined,
      kind: optString(b, "kind") as DocKind | undefined,
      body: optString(b, "body"),
      ...targetOf(b),
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
}
