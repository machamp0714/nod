import { addLinkAttachment, type OpCtx, readAttachmentFile, removeAttachment } from "@nod/core";
import type { Hono } from "hono";
import { optString, paramInt, readBody, reqString } from "../input";

// RFC 6266。ASCII だけの filename と、元の名前を保つ filename* を並べる
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// Issue の添付。web から足せるのはリンクだけで、ファイルは CLI で添付する（web はダウンロードと削除）
export function registerAttachmentRoutes(app: Hono, me: OpCtx, attachmentsDir?: string): void {
  app.post("/api/issues/:id/attachments", async (c) => {
    const b = await readBody(c, ["url", "title"]);
    return c.json(addLinkAttachment(me, c.req.param("id"), { url: reqString(b, "url"), title: optString(b, "title") }), 201);
  });
  app.delete("/api/issues/:id/attachments/:attachmentId", (c) => {
    const id = paramInt(c.req.param("attachmentId"), "添付の id ");
    removeAttachment(me, c.req.param("id"), id, attachmentsDir);
    return c.json({ removed: id });
  });
  app.get("/api/attachments/:id/download", (c) => {
    const f = readAttachmentFile(me.db, paramInt(c.req.param("id"), "添付の id "), attachmentsDir);
    return new Response(new Uint8Array(f.data), {
      headers: {
        "Content-Type": f.mime,
        "Content-Length": String(f.size),
        "Content-Disposition": contentDisposition(f.fileName),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "no-store",
      },
    });
  });
}
