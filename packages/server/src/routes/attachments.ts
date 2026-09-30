import {
  addLinkAttachment,
  type ByteRange,
  isInlineAttachmentMime,
  NodError,
  type OpCtx,
  openAttachmentStream,
  readAttachmentRange,
  removeAttachment,
} from "@nod/core";
import type { Hono } from "hono";
import { optString, paramInt, readBody, reqString } from "../input";

// RFC 6266。ASCII だけの filename と、元の名前を保つ filename* を並べる
export function contentDisposition(fileName: string, type: "attachment" | "inline" = "attachment"): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\%]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// 添付を配信するときに必ず付けるヘッダー。中身から種類を推測させず、開かれてもスクリプトを動かさず、ほかのサイトに埋め込ませない
const SAFE_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; sandbox",
  "Cache-Control": "no-store",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// Range ヘッダーのうち、1 つの範囲だけを読む（bytes=a-b・bytes=a-・bytes=-n）。読めない書き方・逆順・複数範囲は null（全体を返す）
export function parseRange(header: string | undefined, total: number): ByteRange | null {
  const m = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const n = Number(m[2]);
    return n === 0 ? { start: total, end: total } : { start: Math.max(0, total - n), end: total - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === "" ? Number.MAX_SAFE_INTEGER : Number(m[2]);
  // bytes=5-2 のような逆順は RFC 9110 では無効な書き方なので、416 にせず全体を返す
  return start > end ? null : { start, end };
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
  // 本文は全体をメモリに載せずストリームで返す（HEAD は app 全体で 404 にしているので、ここへは来ない）
  app.get("/api/attachments/:id/download", (c) => {
    const f = openAttachmentStream(me.db, paramInt(c.req.param("id"), "添付の id "), attachmentsDir);
    return new Response(f.stream, {
      headers: {
        "Content-Type": f.mime,
        "Content-Length": String(f.size),
        "Content-Disposition": contentDisposition(f.fileName),
        ...SAFE_HEADERS,
      },
    });
  });
  // 画面に埋め込む配信。画像と動画だけ inline にし、それ以外は download と同じく attachment にする。
  // 動画のシークのため Range に応える。1 回に返すのは ATTACHMENT_RANGE_MAX_BYTES までで、Range が無ければストリームで返す
  app.get("/api/attachments/:id/view", (c) => {
    const id = paramInt(c.req.param("id"), "添付の id ");
    let f: ReturnType<typeof readAttachmentRange>;
    try {
      f = readAttachmentRange(me.db, id, attachmentsDir, (total) => parseRange(c.req.header("range"), total));
    } catch (e) {
      if (!(e instanceof NodError) || e.code !== "RANGE_NOT_SATISFIABLE") throw e;
      const { total } = e.details as { total: number };
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${total}`, ...SAFE_HEADERS } });
    }
    const headers: Record<string, string> = {
      "Content-Type": f.mime,
      "Content-Length": String(f.size),
      "Content-Disposition": contentDisposition(f.fileName, isInlineAttachmentMime(f.mime) ? "inline" : "attachment"),
      "Accept-Ranges": "bytes",
      ...SAFE_HEADERS,
    };
    if (!f.range) return new Response(f.stream, { headers });
    headers["Content-Range"] = `bytes ${f.range.start}-${f.range.end}/${f.total}`;
    // Buffer をコピーせず、同じメモリを指す Uint8Array として渡す
    return new Response(new Uint8Array(f.data.buffer, f.data.byteOffset, f.data.byteLength), { status: 206, headers });
  });
}
