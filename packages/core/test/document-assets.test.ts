import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDocumentAsset, saveDocumentAsset } from "../src/ops/document-assets";
import { attachDocument } from "../src/ops/documents";
import { ATTACHMENT_MAX_BYTES } from "../src/ops/attachments";
import { createIssue } from "../src/ops/issues";
import { codeOf, setup } from "./helpers";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function setupDoc() {
  const ctx = setup();
  const a = createIssue(ctx.me, { workspaceId: ctx.ws.id, title: "a" });
  const dir = mkdtempSync(join(tmpdir(), "nod-asset-"));
  writeFileSync(join(dir, "spec.md"), "# 題\n");
  const doc = attachDocument(ctx.me, { issueRef: a.id }, { path: join(dir, "spec.md") });
  return { ...ctx, dir, id: doc.id };
}

describe("saveDocumentAsset", () => {
  test("貼り付けは時刻とランダムの名前で images/ に保存し、相対パスを返す", () => {
    const { db, dir, id } = setupDoc();
    const r = saveDocumentAsset(db, id, { name: "image.png", data: PNG, pasted: true, now: new Date(2026, 9, 6, 14, 5, 9) });
    expect(r.path).toMatch(/^images\/20261006-140509-[a-z0-9]{4}\.png$/);
    expect(readFileSync(join(dir, r.path))).toEqual(Buffer.from(PNG));
  });

  test("ドロップは元の名前（空白は -）で、同名があれば -2, -3", () => {
    const { db, id } = setupDoc();
    expect(saveDocumentAsset(db, id, { name: "画面 1.png", data: PNG, pasted: false }).path).toBe("images/画面-1.png");
    expect(saveDocumentAsset(db, id, { name: "画面 1.png", data: PNG, pasted: false }).path).toBe("images/画面-1-2.png");
    expect(saveDocumentAsset(db, id, { name: "画面 1.png", data: PNG, pasted: false }).path).toBe("images/画面-1-3.png");
  });

  test("画像以外・大きすぎる・不正な名前は INVALID_ARGS", () => {
    const { db, id } = setupDoc();
    for (const name of ["a.svg", "a.md", ".env.png", "a\u0007.png", "a/b.png", "a\\b.png", "noext", " .png", "\t.png"]) {
      expect([name, codeOf(() => saveDocumentAsset(db, id, { name, data: PNG, pasted: false }))]).toEqual([name, "INVALID_ARGS"]);
    }
    const big = new Uint8Array(ATTACHMENT_MAX_BYTES + 1);
    expect(codeOf(() => saveDocumentAsset(db, id, { name: "a.png", data: big, pasted: false }))).toBe("INVALID_ARGS");
  });

  test(".md のディレクトリがなければ FILE_NOT_FOUND で作らず、images が外を指す symlink なら INVALID_ARGS", () => {
    const { db, dir, id } = setupDoc();
    const outside = mkdtempSync(join(tmpdir(), "nod-out-"));
    symlinkSync(outside, join(dir, "images"));
    expect(codeOf(() => saveDocumentAsset(db, id, { name: "a.png", data: PNG, pasted: false }))).toBe("INVALID_ARGS");
    rmSync(dir, { recursive: true });
    expect(codeOf(() => saveDocumentAsset(db, id, { name: "a.png", data: PNG, pasted: false }))).toBe("FILE_NOT_FOUND");
  });
});

describe("saveDocumentAsset の images の異常", () => {
  test("images がリンク切れの symlink・通常ファイルなら INVALID_ARGS", () => {
    const a = setupDoc();
    symlinkSync(join(a.dir, "nowhere"), join(a.dir, "images"));
    expect(codeOf(() => saveDocumentAsset(a.db, a.id, { name: "a.png", data: PNG, pasted: false }))).toBe("INVALID_ARGS");
    const b = setupDoc();
    writeFileSync(join(b.dir, "images"), "x");
    expect(codeOf(() => saveDocumentAsset(b.db, b.id, { name: "a.png", data: PNG, pasted: false }))).toBe("INVALID_ARGS");
  });
});

describe("resolveDocumentAsset", () => {
  test("画像に見える symlink の行き先が画像でなければ NOT_FOUND", () => {
    const { db, dir, id } = setupDoc();
    mkdirSync(join(dir, "images"));
    writeFileSync(join(dir, ".env"), "SECRET=1");
    symlinkSync("../.env", join(dir, "images", "x.png"));
    expect(codeOf(() => resolveDocumentAsset(db, id, "images/x.png"))).toBe("NOT_FOUND");
  });

  test(".md のディレクトリの下の画像だけを返す", () => {
    const { db, dir, id } = setupDoc();
    mkdirSync(join(dir, "images"));
    writeFileSync(join(dir, "images", "a.png"), PNG);
    writeFileSync(join(dir, ".env"), "SECRET=1");
    expect(resolveDocumentAsset(db, id, "images/a.png")).toMatchObject({ abs: realpathSync(join(dir, "images", "a.png")), mime: "image/png", fileName: "a.png" });
    const outside = mkdtempSync(join(tmpdir(), "nod-out-"));
    writeFileSync(join(outside, "x.png"), PNG);
    symlinkSync(join(outside, "x.png"), join(dir, "images", "link.png"));
    for (const rel of ["../x.png", "images/../../x.png", "/etc/passwd", "a\u0000.png", "spec.md", ".env", "images/none.png", "images/link.png", ""]) {
      expect([rel, codeOf(() => resolveDocumentAsset(db, id, rel))]).toEqual([rel, "NOT_FOUND"]);
    }
  });
});
