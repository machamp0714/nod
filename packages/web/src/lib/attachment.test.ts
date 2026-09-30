import { describe, expect, test } from "bun:test";
import type { IssueAttachment } from "../api/types";
import { attachmentDownloadPath, attachmentMeta, attachmentTitle, attachmentViewPath, formatBytes, mediaAttachments, mediaKind, safeLinkHref, videoBadge } from "./attachment";

const base: IssueAttachment = {
  id: 1, kind: "link", title: null, url: "https://docs.google.com/document/d/1", fileName: null, size: null, mime: null,
  createdBy: "me", createdAt: "2026-09-29T01:00:00Z",
};
const date = new Date("2026-09-29T01:00:00Z").toLocaleDateString("ja-JP", { month: "long", day: "numeric" });

describe("attachmentTitle と attachmentMeta", () => {
  test("タイトル付きのリンクはメタにホスト名を出す", () => {
    const a = { ...base, title: "設計レビュー議事録" };
    expect(attachmentTitle(a)).toBe("設計レビュー議事録");
    expect(attachmentMeta(a)).toBe(`docs.google.com · me · ${date}`);
  });

  test("タイトルなしのリンクはホスト名を題にし、メタは添付者と日付だけ", () => {
    expect(attachmentTitle(base)).toBe("docs.google.com");
    expect(attachmentMeta(base)).toBe(`me · ${date}`);
  });

  test("ファイルはファイル名とサイズ", () => {
    const f = { ...base, kind: "file" as const, url: null, fileName: "error.log", size: 12698, mime: "text/plain", createdBy: "claude-code" };
    expect(attachmentTitle(f)).toBe("error.log");
    expect(attachmentMeta(f)).toBe(`12.4 KB · claude-code · ${date}`);
    expect(attachmentTitle({ ...f, title: "ログ" })).toBe("ログ");
  });
});

test("formatBytes", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1023)).toBe("1023 B");
  expect(formatBytes(1024)).toBe("1.0 KB");
  expect(formatBytes(10 * 1024 * 1024)).toBe("10.0 MB");
});

test("safeLinkHref は http と https だけを返す", () => {
  expect(safeLinkHref("https://e.com/a")).toBe("https://e.com/a");
  expect(safeLinkHref("http://e.com")).toBe("http://e.com/");
  expect(safeLinkHref("javascript:alert(1)")).toBeNull();
  expect(safeLinkHref("data:text/html,x")).toBeNull();
  expect(safeLinkHref(null)).toBeNull();
  expect(safeLinkHref("not a url")).toBeNull();
});

test("attachmentDownloadPath", () => {
  expect(attachmentDownloadPath(12)).toBe("/api/attachments/12/download");
});

describe("メディア添付", () => {
  const file = (mime: string, fileName = "a") => ({ ...base, kind: "file" as const, url: null, fileName, size: 3, mime });
  test("画像と動画のファイルだけをメディアとして種類を返す。svg・pdf・リンクは null", () => {
    expect(mediaKind(file("image/png"))).toBe("image");
    expect(mediaKind(file("image/webp"))).toBe("image");
    expect(mediaKind(file("video/mp4"))).toBe("video");
    expect(mediaKind(file("video/webm"))).toBe("video");
    for (const mime of ["image/svg+xml", "application/pdf", "text/plain; charset=utf-8"]) expect(mediaKind(file(mime))).toBeNull();
    expect(mediaKind({ ...base, mime: "image/png" })).toBeNull();
  });
  test("mediaAttachments は添付順を保ってメディアだけを残す", () => {
    const list = [file("application/pdf"), { ...file("image/png"), id: 2 }, { ...file("video/mp4"), id: 3 }];
    expect(mediaAttachments(list).map(a => a.id)).toEqual([2, 3]);
  });
  test("表示用のパスと動画の拡張子バッジ", () => {
    expect(attachmentViewPath(5)).toBe("/api/attachments/5/view");
    expect(videoBadge(file("video/mp4", "rec.mp4"))).toBe("MP4");
    expect(videoBadge(file("video/webm", "rec.WebM"))).toBe("WEBM");
  });
});
