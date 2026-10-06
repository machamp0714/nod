import { readFileSync } from "node:fs";
import {
  createDocument,
  type DocKind,
  type DocTarget,
  getDocument,
  linkDocumentById,
  NodError,
  type OpCtx,
  resolveDocumentAsset,
  saveDocumentAsset,
  unlinkDocumentById,
  updateDocumentContent,
} from "@nod/core";
import type { Hono } from "hono";
import { contentDisposition, SAFE_HEADERS } from "./attachments";
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
  // 本文に貼る画像。.md と同じディレクトリの images/ に置く（NOD-3）。multipart はここだけで受ける
  app.post("/api/documents/:id/assets", async (c) => {
    const id = paramInt(c.req.param("id"), "Document の id ");
    const form = await c.req.parseBody();
    const file = form.file;
    if (!(file instanceof File)) throw invalid("file に画像を付けて送ってください");
    const saved = saveDocumentAsset(me.db, id, {
      name: file.name,
      data: new Uint8Array(await file.arrayBuffer()),
      pasted: form.pasted === "1",
    });
    return c.json(saved, 201);
  });
  // .md のディレクトリの下の画像だけを返す。パスの検査は core の resolveDocumentAsset が持つ
  app.get("/api/documents/:id/assets/*", (c) => {
    const id = paramInt(c.req.param("id"), "Document の id ");
    const prefix = `/api/documents/${id}/assets/`;
    let rel: string;
    try {
      // c.req.path は Hono が一度デコード済み（%2F は残る）なので、二重にデコードしないよう生の pathname を使う
      rel = new URL(c.req.url).pathname.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
    } catch {
      throw new NodError("NOT_FOUND", "画像はありません");
    }
    const f = resolveDocumentAsset(me.db, id, rel);
    return new Response(readFileSync(f.abs), {
      headers: { "Content-Type": f.mime, "Content-Disposition": contentDisposition(f.fileName, "inline"), ...SAFE_HEADERS },
    });
  });
}
