import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachDocument, detachDocument, documentTitle, readDocument } from "../src/ops/documents";
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

    expect(getIssue(db, a.id).documents).toEqual([doc]);
    expect(getIssue(db, b.id).documents).toEqual([doc]);
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
    expect(readDocument(db, doc.id)).toEqual({ ...doc, content: "# 検索の設計\n\n本文\n" });
    rmSync(path);
    expect(readDocument(db, doc.id)).toMatchObject({ title: "検索の設計", content: null });
    mkdirSync(path);
    expect(readDocument(db, doc.id).content).toBeNull();
    expect(codeOf(() => readDocument(db, 999))).toBe("NOT_FOUND");
  });
});
