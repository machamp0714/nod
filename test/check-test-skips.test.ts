// skip の照合の道具（scripts/check-test-skips.ts）を、固定の JUnit の結果と許可する skip の一覧でプロセスとして起動し、
// 終了コードと、原因の項目を示すメッセージを確かめる。固定の入力は bun 1.4.4 の --reporter=junit の実際の出力の形に合わせている。
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "../scripts/check-test-skips.ts");

interface Entry {
  file: string;
  name: string[];
  reason: string;
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// bun test の JUnit の結果を組み立てる。suites はファイルごとの testsuite の中身（入れ子の testsuite と testcase）
function junit(...suites: { file: string; body: string }[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites name="bun test" tests="0" assertions="0" failures="0" skipped="0" time="0.01">',
    ...suites.map(
      (s) =>
        `  <testsuite name="${s.file}" file="${s.file}" tests="0" assertions="0" failures="0" skipped="0" time="0" hostname="ci">\n${s.body}\n  </testsuite>`,
    ),
    "</testsuites>",
    "",
  ].join("\n");
}

const suite = (name: string, file: string, ...body: string[]) =>
  `<testsuite name="${name}" file="${file}" line="1" tests="0" assertions="0" failures="0" skipped="0" time="0" hostname="ci">\n${body.join("\n")}\n</testsuite>`;
const ran = (name: string, classname: string, file: string) =>
  `<testcase name="${name}" classname="${classname}" time="0.001" file="${file}" line="2" assertions="1" />`;
const skipped = (name: string, classname: string, file: string) =>
  `<testcase name="${name}" classname="${classname}" time="0" file="${file}" line="3" assertions="0">\n<skipped />\n</testcase>`;
const todo = (name: string, classname: string, file: string) =>
  `<testcase name="${name}" classname="${classname}" time="0" file="${file}" line="4" assertions="0">\n<skipped message="TODO" />\n</testcase>`;
// describe.skip にフックがあると、bun は行番号の無い "(unnamed)" の skip を出す
const unnamed = (classname: string, file: string) =>
  `<testcase name="(unnamed)" classname="${classname}" time="0" file="${file}" assertions="0">\n<skipped />\n</testcase>`;

const A = "packages/a/test/a.test.ts";
const B = "packages/b/test/b.test.ts";

// 入れ子の describe（外側 > 内側）と、XML でエスケープされる名前を含む結果
const NESTED = suite(
  "外側 &lt;&amp;&gt;",
  A,
  suite(
    "内側",
    A,
    ran("走る", "内側 &gt; 外側 &lt;&amp;&gt;", A),
    skipped("成果物が無いと飛ばす &amp; &quot;x&quot;", "内側 &gt; 外側 &lt;&amp;&gt;", A),
  ),
  ran("外の走る", "外側 &lt;&amp;&gt;", A),
);
const NESTED_SKIP = { file: A, name: ["外側 <&>", "内側", '成果物が無いと飛ばす & "x"'], reason: "CI では成果物が無いため" };

function inputs(results: string | null, allowed: Entry[] | string | null): { results: string; allowed: string } {
  const dir = mkdtempSync(join(tmpdir(), "nod-check-skips-"));
  const paths = { results: join(dir, "junit.xml"), allowed: join(dir, "allowed-skips.json") };
  if (results !== null) writeFileSync(paths.results, results);
  if (allowed !== null) writeFileSync(paths.allowed, typeof allowed === "string" ? allowed : JSON.stringify(allowed, null, 2));
  return paths;
}

async function run(paths: { results: string; allowed: string }): Promise<Run> {
  const proc = Bun.spawn([process.execPath, SCRIPT, paths.results, paths.allowed], {
    cwd: mkdtempSync(join(tmpdir(), "nod-check-skips-cwd-")),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout, stderr };
}

// メッセージでの項目の書き方: ファイルと、完全な名前の JSON の配列（一覧の name にそのまま写せる形）
const item = (file: string, name: string[]) => `${file} ${JSON.stringify(name)}`;

describe("skip の照合の道具", () => {
  test("成功: 実際の skip（todo を含む）と一覧が完全に一致すれば、件数を出して 0 で終わる", async () => {
    const results = junit(
      { file: A, body: NESTED },
      { file: B, body: [ran("b走る", "", B), todo("あとで書く", "", B)].join("\n") },
    );
    const r = await run(inputs(results, [NESTED_SKIP, { file: B, name: ["あとで書く"], reason: "未実装の仕様の記録" }]));
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("2 件");
  });

  test("一覧に無い skip があれば、その項目を出して失敗する", async () => {
    const results = junit({ file: A, body: NESTED }, { file: B, body: skipped("記録の無い skip", "", B) });
    const r = await run(inputs(results, [NESTED_SKIP]));
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("一覧に無い skip");
    expect(r.stderr).toContain(item(B, ["記録の無い skip"]));
    expect(r.stderr).not.toContain(item(A, NESTED_SKIP.name));
  });

  test("名前で特定できない skip（describe.skip のフックの (unnamed)）があれば、その項目を出して失敗する", async () => {
    const results = junit(
      { file: A, body: NESTED },
      { file: B, body: suite("フック付き", B, unnamed("フック付き", B), skipped("中のテスト", "フック付き", B)) },
    );
    const r = await run(inputs(results, [NESTED_SKIP, { file: B, name: ["フック付き", "中のテスト"], reason: "CI では実行できないため" }]));
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("名前で特定できない skip");
    expect(r.stderr).toContain(item(B, ["フック付き", "(unnamed)"]));
    expect(r.stderr).not.toContain(item(B, ["フック付き", "中のテスト"]));
  });

  test("一覧にあるのに実行された項目と、結果に現れなかった項目を、どちらも出して失敗する", async () => {
    const results = junit({ file: A, body: NESTED });
    const r = await run(
      inputs(results, [
        NESTED_SKIP,
        { file: A, name: ["外側 <&>", "内側", "走る"], reason: "以前は CI で実行できなかったため" },
        { file: B, name: ["消えたテスト"], reason: "以前は CI で実行できなかったため" },
      ]),
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain(`一覧にあるのに実行された: ${item(A, ["外側 <&>", "内側", "走る"])}`);
    expect(r.stderr).toContain(`一覧にあるのに結果に無い: ${item(B, ["消えたテスト"])}`);
  });

  test("一覧に無い todo があれば、skip と同じに扱って失敗する", async () => {
    const results = junit({ file: A, body: NESTED }, { file: B, body: [ran("b走る", "", B), todo("あとで書く", "", B)].join("\n") });
    const r = await run(inputs(results, [NESTED_SKIP]));
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain(`一覧に無い todo: ${item(B, ["あとで書く"])}`);
  });

  test("結果ファイルが無ければ失敗する", async () => {
    const paths = inputs(null, [NESTED_SKIP]);
    const r = await run(paths);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain(`JUnit の結果ファイルを読めません: ${paths.results}`);
  });

  test("途中で切れた結果ファイルは解析の失敗として失敗する", async () => {
    const full = junit({ file: A, body: NESTED });
    const paths = inputs(full.slice(0, full.indexOf("</testsuite>")), [NESTED_SKIP]);
    const r = await run(paths);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain(`JUnit の結果ファイルを解析できません: ${paths.results}`);
  });

  test("一覧が無い・不正な形（理由が無い、名前の無い skip を許可する）なら失敗する", async () => {
    const results = junit({ file: A, body: NESTED });
    const missing = inputs(results, null);
    const r1 = await run(missing);
    expect(r1.exitCode).not.toBe(0);
    expect(r1.stderr).toContain(`許可する skip の一覧を読めません: ${missing.allowed}`);

    const invalid = inputs(results, JSON.stringify([NESTED_SKIP, { file: A, name: ["外側 <&>", "内側"] }, { file: B, name: ["フック付き", "(unnamed)"], reason: "フック" }]));
    const r2 = await run(invalid);
    expect(r2.exitCode).not.toBe(0);
    expect(r2.stderr).toContain(`${invalid.allowed} の 1 番目: reason`);
    expect(r2.stderr).toContain(`${invalid.allowed} の 2 番目: 名前の無い skip`);
  });
});
