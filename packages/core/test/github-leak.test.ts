import { describe, expect, test } from "bun:test";
import { detectLeaks, type LeakConfig, leakConfigOf, type LeakRule } from "../src/github-leak";
import { setup } from "./helpers";

const CONFIG: LeakConfig = { workspaceKeys: ["NOD", "API"], knownPaths: ["/srv/nod"], webPorts: [4700] };
const rulesOf = (body: string, title = "タイトル") => detectLeaks({ title, body }, CONFIG).map((f) => f.rule);

describe("検出する", () => {
  test.each<[string, LeakRule]>([
    ["NOD-4 を直す", "issue_id"],
    ["api-12 の続き", "issue_id"],
    ["<!-- NOD-4 -->", "issue_id"],
    ["```\nNOD-4\n```", "issue_id"],
    ["#12 の続き", "issue_ref"],
    ["see #3.", "issue_ref"],
    ["(#7)", "issue_ref"],
    ["owner/repo#5 を見る", "issue_ref"],
    ["色は #123456", "issue_ref"],
    ["http://localhost:4700/issues", "nod_web"],
    ["127.0.0.1:4700", "nod_web"],
    ["nod issue show で読む", "nod_command"],
    ["---\n取り込み元: https://github.com/a/b/issues/1", "import_footer"],
    ["/Users/alice/x", "absolute_path"],
    ["/home/bob", "absolute_path"],
    ["~/x を見る", "absolute_path"],
    ["/tmp/a.md", "absolute_path"],
    ["/private/var/x", "absolute_path"],
    ["/var/folders/x", "absolute_path"],
    ["C:\\work", "absolute_path"],
    ["c:/work", "absolute_path"],
    ["/srv/nod/docs/a.md", "absolute_path"],
    ["`/srv/nod`", "absolute_path"],
    ["file:///Users/alice/x", "absolute_path"],
    ["https://example.com/?p=%2FUsers%2Falice", "absolute_path"],
    ["https://example.com/x?p=/Users/alice", "absolute_path"],
    ["https://github.com/a/b/issues/1/NOD-4", "issue_id"],
    ["![](images/a.png)", "link_target"],
    ["[a [b] c](images/x.png)", "link_target"],
    ["[x](<images/a b.png>)", "link_target"],
    ["[foo\nbar](images/a.png)", "link_target"],
    ["[x](images/a.png (title))", "link_target"],
    ["https://x.com/%2FUsers%2Falice?q=%E0%A4%A", "absolute_path"],
    ["[spec](../spec.md)", "link_target"],
    ["[x](/api/attachments/3)", "link_target"],
    ["[x](www.example.com)", "link_target"],
    ["[x]()", "link_target"],
    ["[ref]: ./a.md", "link_target"],
    ['<img src="images/a.png">', "link_target"],
    ["<a href='x.md'>x</a>", "link_target"],
    ["<foo:bar>", "link_target"],
  ])("%s → %s", (body, rule) => {
    expect(rulesOf(body)).toContain(rule);
  });

  test("タイトルも調べる", () => {
    expect(detectLeaks({ title: "NOD-4 の続き", body: "" }, CONFIG)).toEqual([
      { field: "title", line: 1, column: 1, text: "NOD-4", rule: "issue_id", reason: expect.any(String) },
    ]);
  });

  test("位置は原文の行と桁（コードポイント数）。CRLF・日本語・絵文字でもずれない", () => {
    const [f] = detectLeaks({ title: "t", body: "あ😀\r\nx NOD-1" }, CONFIG);
    expect(f).toMatchObject({ field: "body", line: 2, column: 3, text: "NOD-1" });
    const [lf] = detectLeaks({ title: "t", body: "あ😀\nx NOD-1" }, CONFIG);
    expect(lf).toMatchObject({ line: 2, column: 3 });
  });

  test("リンク先と URL の両方に当たるときは両方を示す", () => {
    expect(rulesOf("[x](file:///Users/a)").sort()).toEqual(["absolute_path", "link_target"]);
  });
});

describe("通す", () => {
  test.each([
    "SHA-256 と UTF-8 と ISO-8601",
    "CVE-2024-1234",
    "/api/issues/:id",
    "/etc/hosts",
    "/tmpfile",
    "foo/Users/x",
    "/srv/nod-backup",
    "https://github.com/a/b/issues/12",
    "https://github.com/a/b/pull/3 を参照。",
    "[x](https://example.com)",
    "[m](mailto:a@b.c)",
    "[h](#heading)",
    "<https://example.com/a>",
    "&#123; と &#x7B;",
    "# 見出し",
    "C:work",
    "www.example.com",
    "",
  ])("%s", (body) => {
    expect(detectLeaks({ title: "タイトル", body }, CONFIG)).toEqual([]);
  });

  test("GitHub の URL の例外はその範囲だけ。前後の本文や別ホストは調べる", () => {
    expect(rulesOf("https://github.com/a/b/issues/1 と NOD-2")).toEqual(["issue_id"]);
    expect(rulesOf("https://github.com.evil/a/b/issues/1#2").length).toBeGreaterThan(0);
  });

  test("長い [ の連続でも遅くならない", () => {
    const t = performance.now();
    detectLeaks({ title: "t", body: "[".repeat(65536) }, CONFIG);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  test("壊れた percent-encoding でも落ちない", () => {
    expect(() => detectLeaks({ title: "t", body: "https://example.com/%E0%A4%A" }, CONFIG)).not.toThrow();
  });

  test("Workspace が1つもなければ ID の規則は使わない", () => {
    expect(detectLeaks({ title: "NOD-4", body: "" }, { workspaceKeys: [], knownPaths: [], webPorts: [4700] })).toEqual([]);
  });
});

describe("DB から設定を作る", () => {
  test("登録済みのキー・パス・Documents・添付・DB のパス・HOME とポートを集める", () => {
    const { db } = setup();
    const config = leakConfigOf(db, { webPort: 5123, env: { HOME: "/Users/tester", NOD_DOCS_DIR: "/srv/docs", NOD_ATTACHMENTS_DIR: "/srv/att" } });
    expect(config.workspaceKeys).toEqual(["API"]);
    expect(config.knownPaths).toEqual(expect.arrayContaining(["/Users/tester", "/tmp/repos/api-server", "/srv/docs", "/srv/att", db.filename]));
    expect(config.webPorts).toEqual([4700, 5123]);
  });
});
