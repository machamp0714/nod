import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachDocument, detachDocument, documentTitle, getDocument, leadingTitle, readDocument, updateDocumentContent } from "../src/ops/documents";
import { createIssue, getIssue } from "../src/ops/issues";
import { createProject, getProject } from "../src/ops/projects";
import { codeOf, eventsOf, setup } from "./helpers";

function writeDoc(name: string, content: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "nod-doc-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return { dir, path };
}

describe("documentTitle", () => {
  test("最初の # 見出し、なければファイル名", () => {
    expect(documentTitle("/d/spec.md", "前書き\n\n# 検索の設計\n\n## 目的\n")).toBe("検索の設計");
    expect(documentTitle("/d/spec.md", "## 小見出しだけ\n")).toBe("spec.md");
  });
});

describe("attachDocument と detachDocument", () => {
  test("Issue に添付し、同じファイルを別の Issue と Project にも添付できる", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    createProject(me, { name: "検索" });
    const { dir } = writeDoc("spec.md", "# 検索の設計\n");

    const doc = attachDocument(me, { issueRef: a.id }, { path: "spec.md", kind: "spec", cwd: dir });
    expect(doc).toMatchObject({ path: join(dir, "spec.md"), title: "検索の設計", kind: "spec" });
    attachDocument(me, { issueRef: a.id }, { path: join(dir, "spec.md") });
    attachDocument(me, { issueRef: b.id }, { path: join(dir, "spec.md") });
    attachDocument(me, { projectRef: "検索" }, { path: join(dir, "spec.md") });

    expect(getIssue(db, a.id).documents).toMatchObject([doc]);
    expect(getIssue(db, b.id).documents).toMatchObject([doc]);
    expect(getProject(db, "検索").documents).toEqual([doc]);
    expect((db.query("SELECT count(*) AS n FROM documents").get() as { n: number }).n).toBe(1);
    expect(eventsOf(db, a.id).filter((e) => e.type === "document_attached")).toEqual([
      { type: "document_attached", actor: "me", data: { document_id: doc.id } },
    ]);
  });

  test("タイトルを明示すれば上書きし、解除すると events に残る", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const { path } = writeDoc("notes.md", "本文だけ\n");
    expect(attachDocument(me, { issueRef: a.id }, { path }).title).toBe("notes.md");
    expect(attachDocument(me, { issueRef: a.id }, { path, title: "調査メモ" }).title).toBe("調査メモ");
    detachDocument(me, { issueRef: a.id }, path);
    expect(getIssue(db, a.id).documents).toEqual([]);
    expect(eventsOf(db, a.id).at(-1)?.type).toBe("document_detached");
    expect(codeOf(() => detachDocument(me, { issueRef: a.id }, path))).toBe("NOT_FOUND");
  });

  test("大文字小文字だけ違うパスの添付・解除は同じ Document として扱う（#101）", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const { dir, path } = writeDoc("Spec.md", "# 設計\n");
    if (!existsSync(join(dir, "spec.md"))) return; // 大文字小文字を区別する FS では別ファイル
    const doc = attachDocument(me, { issueRef: a.id }, { path });
    expect(attachDocument(me, { issueRef: a.id }, { path: join(dir, "spec.md") }).id).toBe(doc.id);
    expect((db.query("SELECT count(*) AS n FROM documents").get() as { n: number }).n).toBe(1);
    detachDocument(me, { issueRef: a.id }, join(dir, "SPEC.md"));
    expect(getIssue(db, a.id).documents).toEqual([]);
  });

  test("ファイルがなければ FILE_NOT_FOUND、対象の指定が1つでなければ INVALID_ARGS", () => {
    const { ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    expect(codeOf(() => attachDocument(me, { issueRef: a.id }, { path: "/nope/x.md" }))).toBe("FILE_NOT_FOUND");
    const { path } = writeDoc("x.md", "# x\n");
    expect(codeOf(() => attachDocument(me, {}, { path }))).toBe("INVALID_ARGS");
  });
});

describe("readDocument", () => {
  test("登録済みの Document を id で読み、ファイルが消えたりディレクトリに変わったりしたら content を null にする", () => {
    const { db, ws, me } = setup();
    const i = createIssue(me, { workspaceId: ws.id, title: "t" });
    const { path } = writeDoc("spec.md", "# 検索の設計\n\n本文\n");
    const doc = attachDocument(me, { issueRef: i.id }, { path });
    expect(readDocument(db, doc.id)).toEqual({ ...doc, content: "# 検索の設計\n\n本文\n", mtime: statSync(path).mtimeMs });
    rmSync(path);
    expect(readDocument(db, doc.id)).toMatchObject({ title: "検索の設計", content: null, mtime: null });
    mkdirSync(path);
    expect(readDocument(db, doc.id).content).toBeNull();
    expect(codeOf(() => readDocument(db, 999))).toBe("NOT_FOUND");
  });
});

describe("leadingTitle", () => {
  test("最初の空でない行が # 見出しのときだけ返す", () => {
    expect(leadingTitle("\n\n# 新しい題\n\n本文\n")).toBe("新しい題");
    expect(leadingTitle("本文\n\n# 後ろの見出し\n")).toBeNull();
    expect(leadingTitle("## 小見出し\n")).toBeNull();
    expect(leadingTitle("")).toBeNull();
  });
});

describe("updateDocumentContent", () => {
  function setupDoc(content = "# 元の題\n\n本文\n") {
    const ctx = setup();
    const a = createIssue(ctx.me, { workspaceId: ctx.ws.id, title: "a" });
    const { path } = writeDoc("spec.md", content);
    const doc = attachDocument(ctx.me, { issueRef: a.id }, { path });
    return { ...ctx, path, doc };
  }

  test("mtime が一致すれば書き、新しい mtime と本文を返す", () => {
    const { db, me, path, doc } = setupDoc();
    const before = getDocument(db, doc.id);
    expect(before.mtime).toBe(statSync(path).mtimeMs);
    const after = updateDocumentContent(me, doc.id, { content: "# 元の題\n\n書き換えた\n", mtime: before.mtime as number });
    expect(readFileSync(path, "utf8")).toBe("# 元の題\n\n書き換えた\n");
    expect(after.content).toBe("# 元の題\n\n書き換えた\n");
    expect(after.mtime).toBe(statSync(path).mtimeMs);
  });

  test("mtime が違えば CONFLICT でファイルを変えない", () => {
    const { me, path, doc } = setupDoc();
    utimesSync(path, new Date(2000, 0, 1), new Date(2000, 0, 1));
    expect(codeOf(() => updateDocumentContent(me, doc.id, { content: "x", mtime: 1 }))).toBe("CONFLICT");
    expect(readFileSync(path, "utf8")).toBe("# 元の題\n\n本文\n");
  });

  test("ファイルがなければ FILE_NOT_FOUND で作り直さず、Document がなければ NOT_FOUND", () => {
    const { me, path, doc } = setupDoc();
    rmSync(path);
    expect(codeOf(() => updateDocumentContent(me, doc.id, { content: "x", mtime: 0 }))).toBe("FILE_NOT_FOUND");
    expect(existsSync(path)).toBe(false);
    expect(codeOf(() => updateDocumentContent(me, 999, { content: "x", mtime: 0 }))).toBe("NOT_FOUND");
  });

  test("先頭の見出しを変えるとタイトルが追従し、消すと前のタイトルを保つ（後ろの # 行やファイル名を拾わない）", () => {
    const { db, me, doc } = setupDoc();
    let d = updateDocumentContent(me, doc.id, { content: "# 新しい題\n\n本文\n", mtime: getDocument(db, doc.id).mtime as number });
    expect(d.title).toBe("新しい題");
    d = updateDocumentContent(me, doc.id, { content: "本文だけ\n\n# 後ろの見出し\n", mtime: d.mtime as number });
    expect(d.title).toBe("新しい題");
  });

  test("docsDir の外にある Document も書ける", () => {
    const { db, me, path, doc } = setupDoc();
    // writeDoc は tmpdir 直下の一時ディレクトリに作るので、docsDir の外にある
    updateDocumentContent(me, doc.id, { content: "外\n", mtime: getDocument(db, doc.id).mtime as number });
    expect(readFileSync(path, "utf8")).toBe("外\n");
  });
});
