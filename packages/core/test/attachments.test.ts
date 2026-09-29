import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTACHMENT_MAX_BYTES,
  addFileAttachment,
  addLinkAttachment,
  attachmentFile,
  defaultAttachmentsDir,
  gcAttachments,
  listIssueAttachments,
  normalizeAttachmentUrl,
  removeAttachment,
} from "../src/ops/attachments";
import { archiveIssue, copyIssue, createIssue, getIssue } from "../src/ops/issues";
import { initWorkspace, removeWorkspace } from "../src/ops/workspaces";
import { codeOf, eventsOf, setup } from "./helpers";

function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function fixture() {
  const s = setup();
  const issue = createIssue(s.me, { workspaceId: s.ws.id, title: "添付の対象" });
  const src = tempDir("nod-attach-src-");
  const dir = join(tempDir("nod-attach-root-"), "attachments"); // まだ無いディレクトリ。最初の添付で作る
  return { ...s, issue, src, dir };
}

function write(dir: string, name: string, content: string | Buffer = "hello"): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("defaultAttachmentsDir", () => {
  test("NOD_ATTACHMENTS_DIR があればそれ、なければ ~/.local/share/nod/attachments", () => {
    expect(defaultAttachmentsDir({ NOD_ATTACHMENTS_DIR: "/tmp/x" })).toBe("/tmp/x");
    expect(defaultAttachmentsDir({})).toMatch(/\.local\/share\/nod\/attachments$/);
  });
});

describe("normalizeAttachmentUrl", () => {
  test("http と https だけを受け付ける", () => {
    expect(normalizeAttachmentUrl(" https://example.com/a b ")).toBe("https://example.com/a%20b");
    expect(normalizeAttachmentUrl("http://localhost:3000/x")).toBe("http://localhost:3000/x");
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>",
      "file:///etc/passwd",
      "vbscript:x",
      "ftp://example.com",
      "example.com",
      "",
      "https://",
    ]) {
      expect(codeOf(() => normalizeAttachmentUrl(bad))).toBe("INVALID_ARGS");
    }
  });

  test("user:password@ を含む URL は拒否する", () => {
    for (const bad of ["https://u:p@example.com/", "https://u@example.com/", "https://:p@example.com/"]) {
      expect(codeOf(() => normalizeAttachmentUrl(bad))).toBe("INVALID_ARGS");
    }
  });

  test("2048 文字を超える URL は拒否する", () => {
    const base = "https://example.com/";
    expect(normalizeAttachmentUrl(base + "a".repeat(2048 - base.length))).toHaveLength(2048);
    expect(codeOf(() => normalizeAttachmentUrl(base + "a".repeat(2049 - base.length)))).toBe("INVALID_ARGS");
  });
});

describe("リンクの添付", () => {
  test("追加すると Issue の詳細と Activity に載り、LLM も追加できる", () => {
    const { db, me, llm, issue } = fixture();
    const a = addLinkAttachment(me, issue.id, { url: "https://example.com/spec", title: "  仕様  " });
    expect(a).toMatchObject({ kind: "link", url: "https://example.com/spec", title: "仕様", fileName: null, size: null, createdBy: "me" });
    const b = addLinkAttachment(llm, issue.id, { url: "https://github.com/a/b/pull/1" });
    expect(b).toMatchObject({ title: null, createdBy: "claude-code" });

    expect(getIssue(db, issue.id).attachments.map((x) => x.id)).toEqual([a.id, b.id]);
    expect(eventsOf(db, issue.id).filter((e) => e.type === "attachment_added")).toEqual([
      { type: "attachment_added", actor: "me", data: { attachment_id: a.id, kind: "link", name: "仕様" } },
      { type: "attachment_added", actor: "claude-code", data: { attachment_id: b.id, kind: "link", name: "github.com" } },
    ]);
  });

  test("危険なスキーム・長すぎるタイトル・改行入りタイトルは拒否する", () => {
    const { db, me, issue } = fixture();
    expect(codeOf(() => addLinkAttachment(me, issue.id, { url: "javascript:alert(1)" }))).toBe("INVALID_ARGS");
    expect(codeOf(() => addLinkAttachment(me, issue.id, { url: "https://e.com", title: "a".repeat(201) }))).toBe("INVALID_ARGS");
    expect(codeOf(() => addLinkAttachment(me, issue.id, { url: "https://e.com", title: "a\nb" }))).toBe("INVALID_ARGS");
    for (const title of ["evil\u202Etxt.exe", "a\u200Bb", "a\u0007b", "a\u2066b"]) {
      expect(codeOf(() => addLinkAttachment(me, issue.id, { url: "https://e.com", title }))).toBe("INVALID_ARGS");
    }
    expect(listIssueAttachments(db, issue.id)).toEqual([]);
  });

  test("存在しない Issue は NOT_FOUND", () => {
    const { me } = fixture();
    expect(codeOf(() => addLinkAttachment(me, "API-999", { url: "https://e.com" }))).toBe("NOT_FOUND");
  });
});

describe("ファイルの添付", () => {
  test("許可ルートの下にコピーし、元ファイルを消しても読める", () => {
    const { db, me, issue, src, dir } = fixture();
    const path = write(src, "報告 1.pdf", "%PDF-1.4");
    const a = addFileAttachment(me, issue.id, { path, dir });
    expect(a).toMatchObject({ kind: "file", url: null, title: null, fileName: "報告 1.pdf", size: 8, mime: "application/pdf" });

    const file = attachmentFile(db, a.id, dir);
    expect(file.abs.startsWith(realpathSync(dir) + "/")).toBe(true);
    expect(file.abs).not.toBe(path);
    expect(readFileSync(file.abs, "utf8")).toBe("%PDF-1.4");
    expect(file).toMatchObject({ fileName: "報告 1.pdf", mime: "application/pdf", size: 8 });
  });

  test("同じ名前のファイルを何度添付しても上書きしない", () => {
    const { db, me, issue, src, dir } = fixture();
    const one = addFileAttachment(me, issue.id, { path: write(src, "log.txt", "one"), dir });
    const two = addFileAttachment(me, issue.id, { path: write(src, "log.txt", "two"), dir });
    expect(readFileSync(attachmentFile(db, one.id, dir).abs, "utf8")).toBe("one");
    expect(readFileSync(attachmentFile(db, two.id, dir).abs, "utf8")).toBe("two");
  });

  test("相対パスは cwd から解決する", () => {
    const { me, issue, src, dir } = fixture();
    write(src, "a.csv", "x,y");
    expect(addFileAttachment(me, issue.id, { path: "a.csv", cwd: src, dir }).fileName).toBe("a.csv");
  });

  test("拡張子で MIME を決め、許可していない拡張子は拒否する", () => {
    const { me, issue, src, dir } = fixture();
    expect(addFileAttachment(me, issue.id, { path: write(src, "a.PNG"), dir }).mime).toBe("image/png");
    expect(addFileAttachment(me, issue.id, { path: write(src, "a.yml"), dir }).mime).toBe("application/yaml");
    for (const name of ["a.html", "a.htm", "a.svg", "a.js", "a.exe", "noext", ".env"]) {
      expect(codeOf(() => addFileAttachment(me, issue.id, { path: write(src, name), dir }))).toBe("INVALID_ARGS");
    }
  });

  test("上限を超えるファイルは拒否し、上限ちょうどは受け付ける", () => {
    const { me, issue, src, dir } = fixture();
    expect(addFileAttachment(me, issue.id, { path: write(src, "ok.txt", Buffer.alloc(ATTACHMENT_MAX_BYTES)), dir }).size).toBe(
      ATTACHMENT_MAX_BYTES,
    );
    expect(codeOf(() => addFileAttachment(me, issue.id, { path: write(src, "big.txt", Buffer.alloc(ATTACHMENT_MAX_BYTES + 1)), dir }))).toBe(
      "INVALID_ARGS",
    );
  });

  test("symlink・ディレクトリ・無いファイルは拒否する", () => {
    const { me, issue, src, dir } = fixture();
    const target = write(src, "secret.txt", "secret");
    symlinkSync(target, join(src, "link.txt"));
    expect(codeOf(() => addFileAttachment(me, issue.id, { path: join(src, "link.txt"), dir }))).toBe("INVALID_ARGS");
    mkdirSync(join(src, "d.txt"));
    expect(codeOf(() => addFileAttachment(me, issue.id, { path: join(src, "d.txt"), dir }))).toBe("INVALID_ARGS");
    expect(codeOf(() => addFileAttachment(me, issue.id, { path: join(src, "none.txt"), dir }))).toBe("FILE_NOT_FOUND");
  });

  test("失敗したときは許可ルートにファイルを残さない", () => {
    const { me, issue, src, dir } = fixture();
    expect(codeOf(() => addFileAttachment(me, "API-999", { path: write(src, "a.txt"), dir }))).toBe("NOT_FOUND");
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    expect(codeOf(() => addFileAttachment(me, issue.id, { path: write(src, "a.txt"), dir, title: "x".repeat(201) }))).toBe("INVALID_ARGS");
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  test("許可ルートの外に出る保存先（DB の値の改ざん）はダウンロードも削除もしない", () => {
    const { db, me, issue, src, dir } = fixture();
    const a = addFileAttachment(me, issue.id, { path: write(src, "a.txt"), dir });
    const outside = write(src, "outside.txt", "outside");
    db.query("UPDATE issue_attachments SET file_path = ? WHERE id = ?").run("../../" + outside, a.id);
    expect(codeOf(() => attachmentFile(db, a.id, dir))).toBe("FILE_NOT_FOUND");
    removeAttachment(me, issue.id, a.id, dir);
    expect(readFileSync(outside, "utf8")).toBe("outside");
  });

  test("保存先の実体が symlink に差し替わっていたらダウンロードしない", () => {
    const { db, me, issue, src, dir } = fixture();
    const a = addFileAttachment(me, issue.id, { path: write(src, "a.txt"), dir });
    const abs = attachmentFile(db, a.id, dir).abs;
    const secret = write(src, "secret.txt", "secret");
    Bun.spawnSync(["rm", abs]);
    symlinkSync(secret, abs);
    expect(codeOf(() => attachmentFile(db, a.id, dir))).toBe("FILE_NOT_FOUND");
  });

  test("リンクの添付はダウンロードできない", () => {
    const { db, me, issue, dir } = fixture();
    const a = addLinkAttachment(me, issue.id, { url: "https://e.com" });
    expect(codeOf(() => attachmentFile(db, a.id, dir))).toBe("NOT_FOUND");
    expect(codeOf(() => attachmentFile(db, 999, dir))).toBe("NOT_FOUND");
  });
});

describe("元ファイルの場所の制限", () => {
  // 一時ディレクトリを狭めて、Workspace でも一時ディレクトリでもない場所を作る
  function restricted() {
    const f = fixture();
    const tmpRoot = tempDir("nod-attach-tmp-");
    const wsPath = tempDir("nod-attach-ws-");
    initWorkspace(f.db, { path: wsPath });
    return { ...f, tmpRoot, wsPath };
  }

  test("登録済み Workspace と一時ディレクトリの下は添付でき、それ以外は拒否する", () => {
    const { me, issue, src, dir, tmpRoot, wsPath } = restricted();
    mkdirSync(join(wsPath, "logs"));
    expect(addFileAttachment(me, issue.id, { path: write(join(wsPath, "logs"), "a.txt"), dir, tmpRoot }).fileName).toBe("a.txt");
    expect(addFileAttachment(me, issue.id, { path: write(tmpRoot, "b.txt"), dir, tmpRoot }).fileName).toBe("b.txt");
    const err = (() => {
      try {
        addFileAttachment(me, issue.id, { path: write(src, "c.txt"), dir, tmpRoot });
      } catch (e) {
        return e as { code: string; message: string };
      }
    })();
    expect(err).toMatchObject({ code: "INVALID_ARGS", message: "Workspace 内のファイルだけ添付できます" });
    expect(readdirSync(dir)).toHaveLength(2);
  });

  test("ドットで始まるディレクトリの中は拒否する（.ssh・.aws・.git など）", () => {
    const { me, issue, dir, tmpRoot, wsPath } = restricted();
    for (const d of [".ssh", ".aws", ".config/gh", ".git"]) {
      mkdirSync(join(tmpRoot, d), { recursive: true });
      expect(codeOf(() => addFileAttachment(me, issue.id, { path: write(join(tmpRoot, d), "k.txt"), dir, tmpRoot }))).toBe("INVALID_ARGS");
    }
    mkdirSync(join(wsPath, ".github"));
    expect(codeOf(() => addFileAttachment(me, issue.id, { path: write(join(wsPath, ".github"), "ci.yml"), dir, tmpRoot }))).toBe(
      "INVALID_ARGS",
    );
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  test("親ディレクトリが symlink なら、指す先が許可された場所でも拒否する", () => {
    const { me, issue, dir, tmpRoot, wsPath } = restricted();
    mkdirSync(join(wsPath, "real"));
    write(join(wsPath, "real"), "a.txt");
    symlinkSync(join(wsPath, "real"), join(wsPath, "via"));
    expect(codeOf(() => addFileAttachment(me, issue.id, { path: join(wsPath, "via", "a.txt"), dir, tmpRoot }))).toBe("INVALID_ARGS");
    // 許可されない場所を指す symlink ディレクトリも同じく拒否する
    const outside = tempDir("nod-attach-outside-");
    write(outside, "secret.txt", "secret");
    symlinkSync(outside, join(tmpRoot, "out"));
    expect(codeOf(() => addFileAttachment(me, issue.id, { path: join(tmpRoot, "out", "secret.txt"), dir, tmpRoot }))).toBe("INVALID_ARGS");
  });

  test("FIFO は待たずに拒否する", () => {
    const { me, issue, dir, tmpRoot } = restricted();
    const fifo = join(tmpRoot, "pipe.txt");
    Bun.spawnSync(["mkfifo", fifo]);
    expect(codeOf(() => addFileAttachment(me, issue.id, { path: fifo, dir, tmpRoot }))).toBe("INVALID_ARGS");
  });

  test("ファイル名の制御文字・書式文字（U+202E など）は拒否する", () => {
    const { me, issue, src, dir } = fixture();
    for (const name of ["a\u202Etxt.log", "a\u200B.txt", "a\u0007.txt"]) {
      expect(codeOf(() => addFileAttachment(me, issue.id, { path: write(src, name), dir }))).toBe("INVALID_ARGS");
    }
  });

  test("保存先はディレクトリ 0700・ファイル 0600 で作り、Activity に元ファイルの実体パスを残す", () => {
    const { db, me, issue, dir, tmpRoot } = restricted();
    const path = write(tmpRoot, "a.txt");
    const a = addFileAttachment(me, issue.id, { path, dir, tmpRoot });
    const abs = attachmentFile(db, a.id, dir).abs;
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(abs, "..")).mode & 0o777).toBe(0o700);
    expect(statSync(abs).mode & 0o777).toBe(0o600);
    expect(eventsOf(db, issue.id).filter((e) => e.type === "attachment_added")).toEqual([
      { type: "attachment_added", actor: "me", data: { attachment_id: a.id, kind: "file", name: "a.txt", source_path: realpathSync(path) } },
    ]);
  });
});

describe("Workspace の削除と gc", () => {
  test("Workspace を消すと、その Issue の添付ファイルも消え、他の Workspace のものは残る", () => {
    const { db, me, ws, issue, src, dir } = fixture();
    const other = initWorkspace(db, { path: "/tmp/repos/other" }).workspace;
    const keep = createIssue(me, { workspaceId: other.id, title: "残す" });
    addFileAttachment(me, issue.id, { path: write(src, "a.txt"), dir });
    const kept = addFileAttachment(me, keep.id, { path: write(src, "b.txt"), dir });
    expect(readdirSync(dir)).toHaveLength(2);
    removeWorkspace(db, ws.key, dir);
    expect(readdirSync(dir)).toHaveLength(1);
    expect(readFileSync(attachmentFile(db, kept.id, dir).abs, "utf8")).toBe("hello");
  });

  test("gc は DB に無い <uuid> ディレクトリだけを消し、--dry-run では消さない", () => {
    const { db, me, issue, src, dir } = fixture();
    const a = addFileAttachment(me, issue.id, { path: write(src, "a.txt"), dir });
    const orphan = "00000000-0000-4000-8000-000000000000";
    const fresh = "11111111-1111-4111-8111-111111111111";
    mkdirSync(join(dir, orphan));
    write(join(dir, orphan), "x.txt");
    mkdirSync(join(dir, fresh));
    mkdirSync(join(dir, "not-a-uuid"));
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(dir, orphan), old, old);
    symlinkSync(src, join(dir, "22222222-2222-4222-8222-222222222222"));

    expect(gcAttachments(db, { dir, dryRun: true })).toMatchObject({ removed: [orphan], dryRun: true });
    expect(existsSync(join(dir, orphan))).toBe(true);
    expect(gcAttachments(db, { dir })).toMatchObject({ removed: [orphan], dryRun: false });
    expect(existsSync(join(dir, orphan))).toBe(false);
    // 参照中・作ってすぐ・uuid でない名前・symlink は残す
    expect(readdirSync(dir).sort()).toHaveLength(4);
    expect(readFileSync(attachmentFile(db, a.id, dir).abs, "utf8")).toBe("hello");
    expect(existsSync(join(src, "a.txt"))).toBe(true);
  });

  test("添付ディレクトリが無ければ何もしない", () => {
    const { db, dir } = fixture();
    expect(gcAttachments(db, { dir })).toEqual({ dir, removed: [], dryRun: false });
  });
});

describe("添付の削除", () => {
  test("行とコピーしたファイルを消し、Activity に残す", () => {
    const { db, me, llm, issue, src, dir } = fixture();
    const f = addFileAttachment(me, issue.id, { path: write(src, "a.txt"), dir });
    const l = addLinkAttachment(me, issue.id, { url: "https://e.com", title: "e" });
    const abs = attachmentFile(db, f.id, dir).abs;
    removeAttachment(llm, issue.id, f.id, dir);
    removeAttachment(me, issue.id, l.id, dir);
    expect(existsSync(abs)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(listIssueAttachments(db, issue.id)).toEqual([]);
    expect(eventsOf(db, issue.id).filter((e) => e.type === "attachment_removed")).toEqual([
      { type: "attachment_removed", actor: "claude-code", data: { attachment_id: f.id, kind: "file", name: "a.txt" } },
      { type: "attachment_removed", actor: "me", data: { attachment_id: l.id, kind: "link", name: "e" } },
    ]);
  });

  test("別の Issue の添付や無い添付は NOT_FOUND", () => {
    const { me, ws, issue, dir } = fixture();
    const other = createIssue(me, { workspaceId: ws.id, title: "別" });
    const a = addLinkAttachment(me, issue.id, { url: "https://e.com" });
    expect(codeOf(() => removeAttachment(me, other.id, a.id, dir))).toBe("NOT_FOUND");
    expect(codeOf(() => removeAttachment(me, issue.id, 999, dir))).toBe("NOT_FOUND");
  });
});

describe("アーカイブと複製", () => {
  test("アーカイブ中は追加も削除もできないが、一覧とダウンロードはできる", () => {
    const { db, me, issue, src, dir } = fixture();
    const f = addFileAttachment(me, issue.id, { path: write(src, "a.txt"), dir });
    archiveIssue(me, issue.id);
    expect(codeOf(() => addLinkAttachment(me, issue.id, { url: "https://e.com" }))).toBe("ISSUE_ARCHIVED");
    expect(codeOf(() => addFileAttachment(me, issue.id, { path: write(src, "b.txt"), dir }))).toBe("ISSUE_ARCHIVED");
    expect(codeOf(() => removeAttachment(me, issue.id, f.id, dir))).toBe("ISSUE_ARCHIVED");
    expect(getIssue(db, issue.id).attachments).toHaveLength(1);
    expect(readFileSync(attachmentFile(db, f.id, dir).abs, "utf8")).toBe("hello");
    expect(readdirSync(dir)).toHaveLength(1);
  });

  test("複製した Issue には添付を引き継がない", () => {
    const { db, me, issue } = fixture();
    addLinkAttachment(me, issue.id, { url: "https://e.com" });
    const copy = copyIssue(me, issue.id);
    expect(getIssue(db, copy.id).attachments).toEqual([]);
  });
});
