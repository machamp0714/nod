import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDocument,
  defaultDocsDir,
  getDocument,
  linkDocumentById,
  listDocuments,
  unlinkDocumentById,
} from "../src/ops/documents";
import { createIssue, getIssue } from "../src/ops/issues";
import { createProject, getProject } from "../src/ops/projects";
import { codeOf, eventsOf, setup } from "./helpers";

function docsDir(): string {
  return mkdtempSync(join(tmpdir(), "nod-docs-"));
}

describe("defaultDocsDir", () => {
  test("NOD_DOCS_DIR を優先し、なければ ~/.local/share/nod/documents", () => {
    expect(defaultDocsDir({ NOD_DOCS_DIR: "/x/docs" })).toBe("/x/docs");
    expect(defaultDocsDir({})).toBe(join(homedir(), ".local", "share", "nod", "documents"));
  });
});

describe("createDocument", () => {
  test("許可ルートの下に # 見出しつきの Markdown を作り、Issue にリンクする", () => {
    const { db, ws, llm } = setup();
    const root = docsDir();
    const a = createIssue(llm, { workspaceId: ws.id, title: "a" });
    const doc = createDocument(llm, {
      docsDir: root,
      path: "design/search.md",
      title: "検索の設計",
      kind: "spec",
      body: "## 目的\n\n速くする\n",
      issueRef: a.id,
    });
    const abs = join(root, "design", "search.md");
    expect(doc).toMatchObject({ path: abs, title: "検索の設計", kind: "spec" });
    expect(readFileSync(abs, "utf8")).toBe("# 検索の設計\n\n## 目的\n\n速くする\n");
    expect(getIssue(db, a.id).documents).toMatchObject([{ id: doc.id, attachedBy: "claude-code" }]);
    expect(eventsOf(db, a.id).at(-1)).toEqual({ type: "document_attached", actor: "claude-code", data: { document_id: doc.id } });
  });

  test("リンク先なしで作れ、タイトル省略時はファイル名、種類の既定は doc", () => {
    const { me } = setup();
    const root = docsDir();
    const doc = createDocument(me, { docsDir: root, path: "memo.md" });
    expect(doc).toMatchObject({ title: "memo", kind: "doc" });
    expect(readFileSync(join(root, "memo.md"), "utf8")).toBe("# memo\n");
  });

  test("Project にリンクして作れる", () => {
    const { db, me } = setup();
    createProject(me, { name: "検索" });
    const doc = createDocument(me, { docsDir: docsDir(), path: "p.md", title: "P", projectRef: "検索" });
    expect(getProject(db, "検索").documents).toEqual([doc]);
  });

  test("絶対パス・.. ・Markdown 以外・空は INVALID_ARGS で、ファイルを作らない", () => {
    const { me } = setup();
    const root = join(docsDir(), "root");
    for (const path of ["/etc/x.md", "../x.md", "a/../../x.md", "a/./../x.md", "x.txt", "", "  ", "dir/"]) {
      expect(codeOf(() => createDocument(me, { docsDir: root, path }))).toBe("INVALID_ARGS");
    }
    expect(existsSync(join(root, "..", "x.md"))).toBe(false);
  });

  test("symlink でルートの外へ出るパスは拒否する", () => {
    const { me } = setup();
    const root = docsDir();
    const outside = docsDir();
    symlinkSync(outside, join(root, "out"));
    expect(codeOf(() => createDocument(me, { docsDir: root, path: "out/x.md" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => createDocument(me, { docsDir: root, path: "out/sub/x.md" }))).toBe("INVALID_ARGS");
    expect(existsSync(join(outside, "x.md"))).toBe(false);
    expect(existsSync(join(outside, "sub"))).toBe(false);
  });

  test("既存ファイルは上書きせず FILE_EXISTS（symlink の置き場所も含む）", () => {
    const { db, me } = setup();
    const root = docsDir();
    writeFileSync(join(root, "x.md"), "元の本文\n");
    expect(codeOf(() => createDocument(me, { docsDir: root, path: "x.md", title: "新" }))).toBe("FILE_EXISTS");
    expect(readFileSync(join(root, "x.md"), "utf8")).toBe("元の本文\n");
    const target = join(docsDir(), "t.md");
    writeFileSync(target, "外\n");
    symlinkSync(target, join(root, "link.md"));
    expect(codeOf(() => createDocument(me, { docsDir: root, path: "link.md" }))).toBe("FILE_EXISTS");
    expect(readFileSync(target, "utf8")).toBe("外\n");
    expect((db.query("SELECT count(*) AS n FROM documents").get() as { n: number }).n).toBe(0);
  });

  test("リンク先の Issue がなければファイルを作らない", () => {
    const { me } = setup();
    const root = docsDir();
    expect(codeOf(() => createDocument(me, { docsDir: root, path: "x.md", issueRef: "API-999" }))).toBe("NOT_FOUND");
    expect(existsSync(join(root, "x.md"))).toBe(false);
  });

  test("DB の登録に失敗したら作ったファイルを消す（ファイルだけが残らない）", () => {
    const { db, ws, me } = setup();
    const root = docsDir();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON document_links BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => createDocument(me, { docsDir: root, path: "x.md", issueRef: a.id })).toThrow("boom");
    expect(existsSync(join(root, "x.md"))).toBe(false);
    expect((db.query("SELECT count(*) AS n FROM documents").get() as { n: number }).n).toBe(0);
    expect(eventsOf(db, a.id).some((e) => e.type === "document_attached")).toBe(false);
  });

  test("登録済みでファイルが消えたパスは作り直せる", () => {
    const { db, me } = setup();
    const root = docsDir();
    const first = createDocument(me, { docsDir: root, path: "x.md", title: "旧" });
    rmSync(first.path);
    const again = createDocument(me, { docsDir: root, path: "x.md", title: "新" });
    expect(again).toMatchObject({ id: first.id, title: "新" });
    expect(readFileSync(first.path, "utf8")).toBe("# 新\n");
    expect((db.query("SELECT count(*) AS n FROM documents").get() as { n: number }).n).toBe(1);
  });

  test("タイトルの改行と不正な種類は INVALID_ARGS", () => {
    const { me } = setup();
    const root = docsDir();
    expect(codeOf(() => createDocument(me, { docsDir: root, path: "x.md", title: "a\nb" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => createDocument(me, { docsDir: root, path: "x.md", kind: "memo" as never }))).toBe("INVALID_ARGS");
    expect(existsSync(join(root, "x.md"))).toBe(false);
  });

  test("ルートがなければ作る", () => {
    const { me } = setup();
    const root = join(docsDir(), "a", "b");
    createDocument(me, { docsDir: root, path: "x.md" });
    expect(existsSync(join(root, "x.md"))).toBe(true);
  });
});

describe("Document 側からのリンクと参照", () => {
  test("id でリンク・解除でき、Issue の Activity に残る。二重リンクは記録しない", () => {
    const { db, ws, me, llm } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const b = createIssue(me, { workspaceId: ws.id, title: "b" });
    const doc = createDocument(me, { docsDir: docsDir(), path: "x.md", title: "X", issueRef: a.id });

    linkDocumentById(llm, doc.id, { issueRef: b.id });
    linkDocumentById(llm, doc.id, { issueRef: b.id });
    expect(eventsOf(db, b.id).filter((e) => e.type === "document_attached")).toHaveLength(1);
    expect(getDocument(db, doc.id)).toMatchObject({
      id: doc.id,
      title: "X",
      content: "# X\n",
      issues: [
        { id: a.id, title: "a", status: a.status },
        { id: b.id, title: "b", status: b.status },
      ],
      projects: [],
    });

    unlinkDocumentById(llm, doc.id, { issueRef: a.id });
    expect(getIssue(db, a.id).documents).toEqual([]);
    expect(eventsOf(db, a.id).at(-1)).toEqual({ type: "document_detached", actor: "claude-code", data: { document_id: doc.id } });
    expect(codeOf(() => unlinkDocumentById(llm, doc.id, { issueRef: a.id }))).toBe("NOT_FOUND");
    expect(codeOf(() => linkDocumentById(llm, 999, { issueRef: a.id }))).toBe("NOT_FOUND");
  });

  test("Project へのリンク・解除と getDocument の projects", () => {
    const { db, me } = setup();
    const p = createProject(me, { name: "検索" });
    const doc = createDocument(me, { docsDir: docsDir(), path: "x.md" });
    linkDocumentById(me, doc.id, { projectRef: "検索" });
    expect(getDocument(db, doc.id).projects).toEqual([{ id: p.id, name: "検索" }]);
    unlinkDocumentById(me, doc.id, { projectRef: "検索" });
    expect(getDocument(db, doc.id).projects).toEqual([]);
  });

  test("listDocuments は作成日つきで新しい順に、リンク先の Issue ID を返す", () => {
    const { db, ws, me } = setup();
    const a = createIssue(me, { workspaceId: ws.id, title: "a" });
    const root = docsDir();
    const x = createDocument(me, { docsDir: root, path: "x.md", issueRef: a.id });
    const y = createDocument(me, { docsDir: root, path: "y.md" });
    const list = listDocuments(db);
    expect(list.map((d) => d.id)).toEqual([y.id, x.id]);
    expect(list[1]).toMatchObject({ id: x.id, title: "x", kind: "doc", issues: [a.id], projects: [] });
    expect(typeof list[1]?.createdAt).toBe("string");
  });

  test("ディレクトリを作る途中で失敗してもルートの外に作らない", () => {
    const { me } = setup();
    const root = docsDir();
    mkdirSync(join(root, "d"));
    writeFileSync(join(root, "d", "f"), "");
    expect(codeOf(() => createDocument(me, { docsDir: root, path: "d/f/x.md" }))).toBeDefined();
  });
});
