import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers";

// to-spec 同梱の執筆依頼スクリプトを、agy を偽コマンド（NOD_AGY）に差し替えてプロセスとして起動する
const SCRIPT = join(import.meta.dir, "../../../plugins/nod/skills/to-spec/scripts/write-spec.ts");
const REFERENCE = readFileSync(join(import.meta.dir, "../../../plugins/nod/skills/to-spec/references/spec-writing.md"), "utf8");
const SEP = "<<<NOD-SPEC-META>>>";
const SECTIONS = ["Problem Statement", "Solution", "User Stories", "Implementation Decisions", "Testing Decisions", "Out of Scope", "Further Notes"];

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const DESCRIPTION = "Story: 仕様書を Argon に書かせたい。\n\n## 受け入れ条件\n\n- AC1 Argon が本文を書く";
const ISSUE = {
  id: "NOD-60",
  title: "Spec文書の執筆をArgonへ委譲する",
  description: DESCRIPTION,
  labels: ["needs-spec"],
  status: "todo",
  activity: [{ kind: "comment", body: "ACTIVITY-SECRET 無関係な会話" }],
};
const DECISION_LOG = "# NOD-60 grilling の問いと答え\n\n| 問い | 決定 |\n|---|---|\n| Q1 | 決定ログの決定A |\n";

interface Fake {
  path: string;
  dir: string;
  argv: () => string[];
  request: () => string;
  cwd: () => string;
}

// 偽 agy: 引数と --print= で渡された依頼文・作業ディレクトリを記録し、テストごとに決めた応答を返す
// argv.log には依頼文を除いた "--print=" を書き、argv() で依頼文を戻す（依頼文は複数行なので行単位の記録に混ぜない）
// blockDraft: 本呼び出しの中で、指定した原稿の保存先に先にディレクトリを作り、原稿の書き込みを想定外のエラー（EEXIST）にする
function fakeAgy(opts: { events?: string | Buffer; stderr?: string; exit?: number; hang?: boolean; versionExit?: number; blockDraft?: string } = {}): Fake {
  const dir = tempDir("nod-fake-agy-");
  if (opts.events !== undefined) writeFileSync(join(dir, "events.jsonl"), opts.events);
  if (opts.stderr !== undefined) writeFileSync(join(dir, "stderr.txt"), opts.stderr);
  const path = join(dir, "agy");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `D="${dir}"`,
      'if [ "$1" = "--version" ]; then',
      '  echo called >> "$D/version.log"',
      `  echo "agy 1.5.4"; exit ${opts.versionExit ?? 0}`,
      "fi",
      'pwd > "$D/cwd.log"',
      'for a in "$@"; do',
      '  case "$a" in',
      '    --print=*) printf "%s" "${a#--print=}" > "$D/request.md"; printf "%s\\n" "--print=" >> "$D/argv.log" ;;',
      '    *) printf "%s\\n" "$a" >> "$D/argv.log" ;;',
      "  esac",
      "done",
      opts.blockDraft ? `mkdir "${opts.blockDraft}"` : "",
      // 応答しない動作: 孫プロセスの sleep が標準出力を開いたまま待つ
      opts.hang ? 'sleep 30 & echo $! > "$D/sleep.pid"; wait' : "",
      '[ -f "$D/stderr.txt" ] && cat "$D/stderr.txt" >&2',
      '[ -f "$D/events.jsonl" ] && cat "$D/events.jsonl"',
      `exit ${opts.exit ?? 0}`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
  const request = () => readFileSync(join(dir, "request.md"), "utf8");
  return {
    path,
    dir,
    argv: () =>
      readFileSync(join(dir, "argv.log"), "utf8")
        .trimEnd()
        .split("\n")
        .map((a) => (a === "--print=" ? `--print=${request()}` : a)),
    request,
    cwd: () => readFileSync(join(dir, "cwd.log"), "utf8").trim(),
  };
}

interface EventOpts {
  model?: string | null; // init が報告する選択モデル。null なら init を出さない
  status?: string;
  result?: boolean; // false なら result を出さない
  deltas?: string[]; // 本文の差分。既定は本文を2つに分けたもの（連結すると response と同じ）
}

// agy 1.5.4 の stream-json で観測したイベントの形: init（選択モデル）、step_update（本文の差分）、result（終了状態と本文の全文）
function events(text: string, o: EventOpts = {}): string {
  const half = Math.ceil(text.length / 2);
  const list: unknown[] = [];
  if (o.model !== null) list.push({ event: "init", conversation_id: "sess-123", init: { model: o.model ?? "gemini-4-argon-medium" } });
  for (const d of o.deltas ?? [text.slice(0, half), text.slice(half)]) {
    list.push({ event: "step_update", step_update: { step_type: "agent_response", text_delta: d } });
  }
  list.push("壊れた行");
  if (o.result !== false) list.push({ event: "result", result: { conversation_id: "sess-123", status: o.status ?? "SUCCESS", response: text } });
  return list.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n";
}

const ARGON = { model: "gemini-4-argon-medium", status: "SUCCESS" };

const META_EMPTY = JSON.stringify({ openQuestions: [], changeProposals: [] });

function specBody(sections = SECTIONS): string {
  return [
    "Issue 本文を前提として有効とし、本文は Gemini 4 Argon が執筆した。",
    ...sections.map((s) => `\n## ${s}\n\n${s} の本文。`),
  ].join("\n");
}

function answer(body = specBody(), meta = META_EMPTY): string {
  return `\n\n${body}\n\n${SEP}\n${meta}\n`;
}

interface Inputs {
  docs: string;
  issueJson: string;
  decisionLog: string;
  related: string;
}

function inputs(): Inputs {
  const root = tempDir("nod-to-spec-");
  const docs = join(root, "documents");
  mkdirSync(docs);
  const issueJson = join(root, "issue.json");
  writeFileSync(issueJson, JSON.stringify(ISSUE));
  const decisionLog = join(docs, "nod-60-grilling.md");
  writeFileSync(decisionLog, DECISION_LOG);
  const related = join(root, "related.md");
  writeFileSync(related, "# NOD-55 仕様\n\n関連仕様の本文 RELATED-BODY\n");
  return { docs, issueJson, decisionLog, related };
}

interface Run {
  exitCode: number;
  stdout: string;
  stderr: string;
  json: any;
  ms: number;
}

// fileSizeKb: スクリプトをファイルサイズの上限（ulimit -f、1024 バイト単位）付きで起動する。上限を超える書き込みは short write になる
async function run(args: string[], fake: { path: string } | string, script = SCRIPT, opts: { fileSizeKb?: number } = {}): Promise<Run> {
  const started = Date.now();
  const cmd = [process.execPath, script, ...args];
  const proc = Bun.spawn(opts.fileSizeKb === undefined ? cmd : ["/bin/sh", "-c", `ulimit -f ${opts.fileSizeKb}; exec "$0" "$@"`, ...cmd], {
    cwd: tempDir("nod-to-spec-cwd-"),
    env: { ...process.env, NOD_AGY: typeof fake === "string" ? fake : fake.path },
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let json: any;
  try {
    json = JSON.parse(stdout);
  } catch {
    json = undefined;
  }
  return { exitCode, stdout, stderr, json, ms: Date.now() - started };
}

function baseArgs(i: Inputs, extra: string[] = []): string[] {
  return ["--issue", "NOD-60", "--issue-json", i.issueJson, "--decision-log", i.decisionLog, ...extra];
}

describe("to-spec の執筆依頼スクリプト", () => {
  test("成功: 依頼文に確定事項と参考を分けて入れ、Argon を固定指定して呼び、原稿と実行記録を保存する", async () => {
    const i = inputs();
    const fake = fakeAgy({ events: events(answer()) });
    const r = await run(baseArgs(i, ["--related", `765=${i.related}`]), fake);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);

    // 引数: effort 付きの Argon モデル固定、既定の effort（medium）、sandbox、スラッシュコマンド無効、stream-json 出力、依頼文の全文
    const argv = fake.argv();
    const requestPath = join(i.docs, "nod-60-argon-01-request.md");
    expect(argv).toEqual([
      "--model", "gemini-4-argon-medium", "--effort", "medium", "--sandbox", "--disable-slash-commands",
      "--output-format", "stream-json", `--print=${readFileSync(requestPath, "utf8")}`,
    ]);
    // 作業ディレクトリは依頼ごとの空の一時ディレクトリで、終了後に消える
    expect(fake.cwd()).not.toBe(i.docs);
    expect(existsSync(fake.cwd())).toBe(false);

    // 依頼文: 執筆ルールとテンプレート全文、Issue 本文と受け入れ条件、決定ログ、関連仕様。活動記録は渡さない
    const request = fake.request();
    expect(request).toBe(readFileSync(requestPath, "utf8"));
    expect(request).toContain(REFERENCE.trim());
    expect(request).toContain(SEP);
    expect(request).toContain(DESCRIPTION);
    expect(request).toContain("受け入れ条件");
    expect(request).toContain(DECISION_LOG.trim());
    expect(request).toContain("RELATED-BODY");
    expect(request).not.toContain("ACTIVITY-SECRET");
    const confirmed = request.indexOf("## 確定事項");
    const reference = request.indexOf("## 参考: 関連する既存の正式仕様書");
    expect(confirmed).toBeGreaterThan(-1);
    expect(reference).toBeGreaterThan(confirmed);
    expect(request.indexOf(DESCRIPTION)).toBeGreaterThan(confirmed);
    expect(request.indexOf(DESCRIPTION)).toBeLessThan(reference);
    expect(request.indexOf("RELATED-BODY")).toBeGreaterThan(reference);
    expect(request).toContain("## 不採用案と未確認の情報");

    // 原稿: result の全文の区切りより前の本文を、Document の本文（タイトル見出しの後）と同じ形にそろえて保存する。差分イベントは重ねない
    const draftPath = join(i.docs, "nod-60-argon-01-draft.md");
    const draft = readFileSync(draftPath, "utf8");
    expect(draft).toBe(`${specBody()}\n`);
    const recordPath = join(i.docs, "nod-60-argon-01-record.json");
    const eventsPath = join(i.docs, "nod-60-argon-01-events.jsonl");
    expect(readFileSync(eventsPath, "utf8")).toBe(events(answer()));

    expect(r.json).toEqual({
      ok: true,
      code: null,
      message: expect.any(String),
      issue: "NOD-60",
      attempt: 1,
      dir: i.docs,
      files: { request: requestPath, events: eventsPath, draft: draftPath, record: recordPath },
      draftSha256: sha256(draft),
      openQuestions: [],
      changeProposals: [],
    });

    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    expect(record).toMatchObject({
      issue: "NOD-60",
      mode: "new",
      attempt: 1,
      agyVersion: "agy 1.5.4",
      sessionId: "sess-123",
      request: { file: "nod-60-argon-01-request.md", sha256: sha256(request) },
      draft: { file: "nod-60-argon-01-draft.md", sha256: sha256(draft) },
      openQuestions: [],
      changeProposals: [],
      ok: true,
      code: null,
      files: {
        request: "nod-60-argon-01-request.md",
        events: "nod-60-argon-01-events.jsonl",
        draft: "nod-60-argon-01-draft.md",
        record: "nod-60-argon-01-record.json",
      },
    });
    // init のモデルは agy が選択したモデルの報告であり、実推論モデルの独立した証明ではない
    expect(record.requested).toEqual({ model: "gemini-4-argon-medium", effort: "medium", timeoutSeconds: 600 });
    expect(record.responded).toEqual(ARGON);
    expect(Number.isNaN(Date.parse(record.startedAt))).toBe(false);
    expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
    const issueBytes = readFileSync(i.issueJson);
    expect(record.inputs).toEqual([
      { role: "issue", file: i.issueJson, sha256: sha256(issueBytes), bytes: issueBytes.length },
      { role: "issue-description", sha256: sha256(DESCRIPTION), bytes: Buffer.byteLength(DESCRIPTION) },
      { role: "decision-log", file: i.decisionLog, sha256: sha256(DECISION_LOG), bytes: Buffer.byteLength(DECISION_LOG) },
      { role: "related", documentId: "765", file: i.related, sha256: sha256(readFileSync(i.related)), bytes: readFileSync(i.related).length },
    ]);

    // nod doc create --body - は「# タイトル\n\n本文」で保存するので、タイトルの2行を除くと原稿と同じバイト列になる
    const docBytes = `# NOD-60 仕様\n\n${draft}`;
    expect(sha256(docBytes.split("\n").slice(2).join("\n"))).toBe(r.json.draftSha256);
  });

  test("差分イベントの本文は採用せず、result の response の全文だけを原稿にする", async () => {
    const i = inputs();
    const r = await run(baseArgs(i), fakeAgy({ events: events(answer(), { deltas: ["DELTA-ONLY 途中の本文", answer()] }) }));
    expect(r.json).toMatchObject({ ok: true, code: null });
    const draft = readFileSync(r.json.files.draft, "utf8");
    expect(draft).toBe(`${specBody()}\n`);
    expect(draft).not.toContain("DELTA-ONLY");
  });

  test("--effort low は low の Argon を要求し、選択モデルがそれと一致したときだけ受け入れる", async () => {
    const ok = await run(baseArgs(inputs(), ["--effort", "low"]), fakeAgy({ events: events(answer(), { model: "gemini-4-argon-low" }) }));
    expect(ok.json).toMatchObject({ ok: true, code: null });
    const i = inputs();
    const { r, record } = await expectFailure(i, fakeAgy({ events: events(answer()) }), "MODEL_NOT_ARGON", ["--effort", "low"]);
    expect(r.json.message).toContain("gemini-4-argon-medium");
    expect(r.json.message).toContain("gemini-4-argon-low");
    expect(record.requested).toEqual({ model: "gemini-4-argon-low", effort: "low", timeoutSeconds: 600 });
    expect(record.responded).toEqual(ARGON);
  });

  // 試行が始まった後の失敗: 理由コード付きで非0終了し、原稿は出さず、依頼文・生ログ・実行記録は残す
  async function expectFailure(i: Inputs, fake: { path: string } | string, code: string, extra: string[] = []): Promise<{ r: Run; record: any }> {
    const r = await run(baseArgs(i, extra), fake);
    expect(r.exitCode).toBe(1);
    expect(r.json).toMatchObject({ ok: false, code, issue: "NOD-60", attempt: 1, draftSha256: null });
    expect(r.json.files.draft).toBeNull();
    expect(readdirSync(i.docs).sort()).toEqual([
      "nod-60-argon-01-events.jsonl",
      "nod-60-argon-01-record.json",
      "nod-60-argon-01-request.md",
      "nod-60-grilling.md",
    ]);
    const record = JSON.parse(readFileSync(r.json.files.record, "utf8"));
    expect(record).toMatchObject({ ok: false, code, draft: null, files: { draft: null } });
    expect(record.message).toBe(r.json.message);
    return { r, record };
  }

  test("agy が無ければ AGY_NOT_FOUND", async () => {
    const i = inputs();
    const { r } = await expectFailure(i, join(tempDir(), "no-such-agy"), "AGY_NOT_FOUND");
    expect(r.json.message).toContain("ENOENT");
  });

  test("モデルが見つからないなどの標準エラー付きの失敗は ARGON_UNAVAILABLE で、標準エラーを説明に含める", async () => {
    const i = inputs();
    const stderr = 'Model "gemini-4-argon-medium" not found';
    const { r, record } = await expectFailure(i, fakeAgy({ stderr, exit: 1 }), "ARGON_UNAVAILABLE");
    expect(r.json.message).toContain(stderr);
    expect(r.json.message).toContain("終了コード 1");
    expect(record.stderr).toBe(stderr);
  });

  test("agy --version が失敗すれば本呼び出しをせずに失敗する", async () => {
    const i = inputs();
    const fake = fakeAgy({ events: events(answer()), versionExit: 3 });
    const { r } = await expectFailure(i, fake, "AGY_FAILED");
    expect(r.json.message).toContain("終了コード 3");
    expect(existsSync(join(fake.dir, "argv.log"))).toBe(false);
  });

  test("それ以外の異常終了は AGY_FAILED", async () => {
    const i = inputs();
    const { r } = await expectFailure(i, fakeAgy({ stderr: "panic: boom", exit: 2 }), "AGY_FAILED");
    expect(r.json.message).toContain("終了コード 2");
    expect(r.json.message).toContain("panic: boom");
  });

  test("応答しなければ時間切れで子プロセスを止め、途中の応答を採用しない", async () => {
    const i = inputs();
    const fake = fakeAgy({ events: events(answer()), hang: true });
    const { r } = await expectFailure(i, fake, "TIMEOUT", ["--timeout", "1"]);
    expect(r.ms).toBeLessThan(10000);
    // 孫プロセスまで止まっている
    const sleepPid = Number(readFileSync(join(fake.dir, "sleep.pid"), "utf8"));
    expect(() => process.kill(sleepPid, 0)).toThrow();
  });

  test("agy が選択したモデルが要求した Argon でなければ MODEL_NOT_ARGON", async () => {
    const i = inputs();
    const other = await expectFailure(i, fakeAgy({ events: events(answer(), { model: "claude-opus-5-5" }) }), "MODEL_NOT_ARGON");
    expect(other.r.json.message).toContain("claude-opus-5-5");
    expect(other.record.responded).toEqual({ model: "claude-opus-5-5", status: "SUCCESS" });
    // effort の付かない Argon も、要求したモデルではない
    await expectFailure(inputs(), fakeAgy({ events: events(answer(), { model: "gemini-4-argon" }) }), "MODEL_NOT_ARGON");
    // init が無ければ選択モデルを判定できない（result が SUCCESS でも受け入れない）
    const none = await expectFailure(inputs(), fakeAgy({ events: events(answer(), { model: null }) }), "MODEL_NOT_ARGON");
    expect(none.record.responded).toEqual({ model: null, status: "SUCCESS" });
  });

  test("完了状態が SUCCESS でない、または result が無ければ STOP_REASON で、差分イベントの本文も採用しない", async () => {
    const failed = await expectFailure(inputs(), fakeAgy({ events: events(answer(), { status: "ERROR" }) }), "STOP_REASON");
    expect(failed.r.json.message).toContain("ERROR");
    expect(failed.record.responded).toEqual({ model: "gemini-4-argon-medium", status: "ERROR" });
    // 差分を連結すれば正しい応答になっていても、result が無ければ原稿にしない
    const missing = await expectFailure(inputs(), fakeAgy({ events: events(answer(), { result: false }) }), "STOP_REASON");
    expect(missing.record.responded).toEqual({ model: "gemini-4-argon-medium", status: null });
  });

  test("本文が空なら EMPTY_BODY", async () => {
    await expectFailure(inputs(), fakeAgy({ events: events("") }), "EMPTY_BODY");
    await expectFailure(inputs(), fakeAgy({ events: events(answer("  \n")) }), "EMPTY_BODY");
  });

  test("区切りが無い、または区切りの後が決まった形の JSON でなければ RESPONSE_FORMAT", async () => {
    await expectFailure(inputs(), fakeAgy({ events: events(specBody()) }), "RESPONSE_FORMAT");
    await expectFailure(inputs(), fakeAgy({ events: events(answer(specBody(), "{壊れた JSON")) }), "RESPONSE_FORMAT");
    await expectFailure(inputs(), fakeAgy({ events: events(answer(specBody(), JSON.stringify({ openQuestions: [{ question: "Q" }], changeProposals: [] }))) }), "RESPONSE_FORMAT");
  });

  test("区切りの後の JSON は ```json の囲みが1つあっても読む", async () => {
    const i = inputs();
    const r = await run(baseArgs(i), fakeAgy({ events: events(answer(specBody(), `\`\`\`json\n${META_EMPTY}\n\`\`\``)) }));
    expect(r.json).toMatchObject({ ok: true, code: null });
  });

  test("本文に最上位の見出しがあれば TOP_HEADING（コードブロックの中は除く）", async () => {
    await expectFailure(inputs(), fakeAgy({ events: events(answer(`# NOD-60 仕様\n\n${specBody()}`)) }), "TOP_HEADING");
    const i = inputs();
    const fenced = `${specBody()}\n\n\`\`\`\n# コメント\n\`\`\``;
    expect((await run(baseArgs(i), fakeAgy({ events: events(answer(fenced)) }))).json).toMatchObject({ ok: true });
  });

  test("テンプレートの節が欠けていれば SECTION_MISSING で、欠けた節を示す", async () => {
    const i = inputs();
    const body = specBody(SECTIONS.filter((s) => s !== "Out of Scope" && s !== "Testing Decisions"));
    const { r } = await expectFailure(i, fakeAgy({ events: events(answer(body)) }), "SECTION_MISSING");
    expect(r.json.message).toContain("Testing Decisions");
    expect(r.json.message).toContain("Out of Scope");
  });

  test("未決の疑問が返れば OPEN_QUESTIONS で、疑問を結果と実行記録に出す", async () => {
    const i = inputs();
    const meta = { openQuestions: [{ question: "上限は何秒か", reason: "決定ログに無い" }], changeProposals: [] };
    const { r, record } = await expectFailure(i, fakeAgy({ events: events(answer(specBody(), JSON.stringify(meta))) }), "OPEN_QUESTIONS");
    expect(r.json.openQuestions).toEqual(meta.openQuestions);
    expect(record.openQuestions).toEqual(meta.openQuestions);
  });

  test("変更提案は失敗にせず、原稿とともに結果と実行記録に返す", async () => {
    const i = inputs();
    const meta = { openQuestions: [], changeProposals: [{ decision: "上限600秒", proposal: "900秒にする", reason: "長い仕様" }] };
    const r = await run(baseArgs(i), fakeAgy({ events: events(answer(specBody(), JSON.stringify(meta))) }));
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ ok: true, changeProposals: meta.changeProposals, openQuestions: [] });
    expect(existsSync(r.json.files.draft)).toBe(true);
    expect(JSON.parse(readFileSync(r.json.files.record, "utf8")).changeProposals).toEqual(meta.changeProposals);
  });

  test("再実行では試行番号が進み、前回のファイルを上書きせず、結果は今回のファイルを指す", async () => {
    const i = inputs();
    const first = await run(baseArgs(i), fakeAgy({ events: events(answer()) }));
    const before = Object.fromEntries(readdirSync(i.docs).map((f) => [f, readFileSync(join(i.docs, f), "utf8")]));
    const second = await run(baseArgs(i), fakeAgy({ events: events(answer(specBody().replace("Solution の本文。", "二回目の本文。"))) }));
    expect(first.json.attempt).toBe(1);
    expect(second.json).toMatchObject({ ok: true, attempt: 2 });
    expect(second.json.files).toEqual({
      request: join(i.docs, "nod-60-argon-02-request.md"),
      events: join(i.docs, "nod-60-argon-02-events.jsonl"),
      draft: join(i.docs, "nod-60-argon-02-draft.md"),
      record: join(i.docs, "nod-60-argon-02-record.json"),
    });
    for (const [f, content] of Object.entries(before)) expect(readFileSync(join(i.docs, f), "utf8")).toBe(content);
    expect(readFileSync(second.json.files.draft, "utf8")).toContain("二回目の本文。");
    expect(second.json.draftSha256).not.toBe(first.json.draftSha256);
    const record = JSON.parse(readFileSync(second.json.files.record, "utf8"));
    expect(record).toMatchObject({ attempt: 2, draft: { file: "nod-60-argon-02-draft.md", sha256: second.json.draftSha256 } });
  });

  test("追記は7節を求めず、対象の仕様書を依頼文と実行記録に入れる", async () => {
    const i = inputs();
    const target = join(tempDir(), "target.md");
    writeFileSync(target, "# 既存仕様\n\nTARGET-BODY\n");
    const fake = fakeAgy({ events: events(answer("追記部分を Gemini 4 Argon が執筆した。\n\n### 追記\n\n追記の本文。")) });
    const r = await run(baseArgs(i, ["--mode", "append", "--target", `848=${target}`]), fake);
    expect(r.exitCode).toBe(0);
    const request = fake.request();
    expect(request).toContain("## 改訂の対象の仕様書（Document 848）");
    expect(request).toContain("TARGET-BODY");
    expect(request).toContain("追記");
    const record = JSON.parse(readFileSync(r.json.files.record, "utf8"));
    expect(record.mode).toBe("append");
    expect(record.inputs).toContainEqual({ role: "target", documentId: "848", file: target, sha256: sha256(readFileSync(target)), bytes: readFileSync(target).length });
  });

  test("作り直しは7節を求める", async () => {
    const i = inputs();
    const target = join(tempDir(), "target.md");
    writeFileSync(target, "# 既存仕様\n");
    await expectFailure(i, fakeAgy({ events: events(answer("改訂の本文だけ。")) }), "SECTION_MISSING", ["--mode", "rebuild", "--target", `848=${target}`]);
  });

  test("差し戻しでは前回の実行記録から原稿を読み、主担当の指摘とともに依頼文に入れる", async () => {
    const i = inputs();
    const first = await run(baseArgs(i), fakeAgy({ events: events(answer(specBody().replace("Solution の本文。", "PREVIOUS-DRAFT"))) }));
    expect(first.json.ok).toBe(true);
    const feedback = join(tempDir(), "feedback.md");
    writeFileSync(feedback, "FEEDBACK-TEXT Q1 の決定が反映されていない\n");
    const fake = fakeAgy({ events: events(answer()) });
    const r = await run(baseArgs(i, ["--feedback", feedback, "--previous-record", first.json.files.record]), fake);
    expect(r.exitCode).toBe(0);
    expect(r.json.attempt).toBe(2);
    const request = fake.request();
    expect(request).toContain("## 差し戻し");
    expect(request.indexOf("FEEDBACK-TEXT")).toBeGreaterThan(request.indexOf("### 主担当の指摘"));
    expect(request.indexOf("PREVIOUS-DRAFT")).toBeGreaterThan(request.indexOf("### 前回の原稿"));
    expect(request).not.toContain("### 前回の未決の疑問");
    const record = JSON.parse(readFileSync(r.json.files.record, "utf8"));
    expect(record.inputs.map((x: { role: string }) => x.role)).toEqual(["issue", "issue-description", "decision-log", "feedback", "previous-record", "previous"]);
    expect(record.inputs).toContainEqual({ role: "previous", file: first.json.files.draft, sha256: first.json.draftSha256, bytes: readFileSync(first.json.files.draft).length });
  });

  test("OPEN_QUESTIONS で終わった依頼は、前回の実行記録と主担当の回答で差し戻せ、疑問と回答が Argon に渡る", async () => {
    const i = inputs();
    const meta = { openQuestions: [{ question: "QUESTION-TEXT 上限は何秒か", reason: "REASON-TEXT 決定ログに無いと判断" }], changeProposals: [] };
    const first = await run(baseArgs(i), fakeAgy({ events: events(answer(specBody(), JSON.stringify(meta))) }));
    expect(first.json).toMatchObject({ ok: false, code: "OPEN_QUESTIONS", files: { draft: null } });
    const feedback = join(tempDir(), "feedback.md");
    writeFileSync(feedback, "ANSWER-TEXT 既決: 決定ログ Q8 で上限600秒と決定済み\n");
    const fake = fakeAgy({ events: events(answer()) });
    const r = await run(baseArgs(i, ["--feedback", feedback, "--previous-record", first.json.files.record]), fake);
    expect(r.exitCode).toBe(0);
    expect(r.json).toMatchObject({ ok: true, attempt: 2 });
    const request = fake.request();
    const section = request.slice(request.indexOf("## 差し戻し"));
    expect(section.indexOf("ANSWER-TEXT")).toBeGreaterThan(section.indexOf("### 主担当の指摘"));
    expect(section.indexOf("QUESTION-TEXT")).toBeGreaterThan(section.indexOf("### 前回の未決の疑問"));
    expect(section).toContain("REASON-TEXT");
    expect(section).not.toContain("### 前回の原稿");
    const record = JSON.parse(readFileSync(r.json.files.record, "utf8"));
    expect(record.inputs.map((x: { role: string }) => x.role)).toEqual(["issue", "issue-description", "decision-log", "feedback", "previous-record"]);
    expect(record.inputs).toContainEqual({ role: "previous-record", file: first.json.files.record, sha256: sha256(readFileSync(first.json.files.record)), bytes: readFileSync(first.json.files.record).length });
  });

  test("差し戻しに使えない前回の実行記録は INVALID_INPUT で、agy を呼ばない", async () => {
    const i = inputs();
    const feedback = join(tempDir(), "feedback.md");
    writeFileSync(feedback, "指摘\n");
    const ok = await run(baseArgs(i), fakeAgy({ events: events(answer()) }));
    const failed = await run(baseArgs(i), fakeAgy({ events: events(answer("")) }));
    expect(failed.json.code).toBe("EMPTY_BODY");
    const tampered = join(tempDir(), "tampered-record.json");
    const rec = JSON.parse(readFileSync(ok.json.files.record, "utf8"));
    writeFileSync(tampered, JSON.stringify({ ...rec, draft: { ...rec.draft, sha256: "0".repeat(64) } }));
    // 原稿ファイルは記録と同じディレクトリから読むので、書き換えた記録も同じ場所に置く
    const tamperedInDocs = join(i.docs, "tampered-record.json");
    writeFileSync(tamperedInDocs, readFileSync(tampered));
    const notJson = join(tempDir(), "record.json");
    writeFileSync(notJson, "{");
    const before = readdirSync(i.docs).sort();
    for (const [args, hint] of [
      [["--feedback", feedback, "--previous-record", failed.json.files.record], "OPEN_QUESTIONS"],
      [["--feedback", feedback, "--previous-record", tamperedInDocs], "SHA-256"],
      [["--feedback", feedback, "--previous-record", notJson], "JSON"],
      [["--mode", "append", "--target", `848=${i.related}`, "--feedback", feedback, "--previous-record", ok.json.files.record], "執筆の種類"],
      [["--previous-record", ok.json.files.record], "--feedback"],
    ] as const) {
      const fake = fakeAgy({ events: events(answer()) });
      const r = await run(baseArgs(i, [...args]), fake);
      expect(r.exitCode).toBe(1);
      expect(r.json).toMatchObject({ ok: false, code: "INVALID_INPUT", files: null });
      expect(r.json.message).toContain(hint);
      expect(existsSync(join(fake.dir, "argv.log"))).toBe(false);
      expect(readdirSync(i.docs).sort()).toEqual(before);
    }
  });

  test("原稿の保存が想定外のエラーで失敗すれば UNEXPECTED_ERROR で、実行記録を残し原稿を出さない", async () => {
    const i = inputs();
    const r = await run(baseArgs(i), fakeAgy({ events: events(answer()), blockDraft: join(i.docs, "nod-60-argon-01-draft.md") }));
    expect(r.exitCode).toBe(1);
    expect(r.json).toMatchObject({ ok: false, code: "UNEXPECTED_ERROR", attempt: 1, draftSha256: null });
    expect(r.json.message).toContain("EEXIST");
    expect(r.json.files.draft).toBeNull();
    const record = JSON.parse(readFileSync(r.json.files.record, "utf8"));
    expect(record).toMatchObject({ ok: false, code: "UNEXPECTED_ERROR", draft: null, files: { draft: null } });
    expect(record.responded).toEqual(ARGON);
  });

  // 依頼文と実行記録が上限に収まるよう、小さな執筆ルールを置いたスキルの写しで動かす
  function smallSkill(): string {
    const root = tempDir("nod-to-spec-skill-");
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "references"));
    const script = join(root, "scripts", "write-spec.ts");
    writeFileSync(script, readFileSync(SCRIPT));
    writeFileSync(join(root, "references", "spec-writing.md"), `小さな執筆ルール\n\n${SEP}\n`);
    return script;
  }

  test("原稿の書き込みが short write になれば、不一致の原稿を成功にせず UNEXPECTED_ERROR で原稿を出さない", async () => {
    const script = smallSkill();
    const i = inputs();
    // 生ログは上限の 4KB に収め、原稿だけを上限を超えさせる。不正な UTF-8 の 1 バイトは、原稿では置換文字（3 バイト）になる
    // 差分イベントを出さず、MARK が result の response にだけ1回現れるようにする
    const MARK = "\u0000BAD\u0000";
    const body = specBody().replace("Solution の本文。", MARK);
    const [head, tail] = Buffer.from(events(answer(body), { deltas: [] }))
      .toString("latin1")
      .split(JSON.stringify(MARK).slice(1, -1));
    const oneEvent = Buffer.concat([Buffer.from(head!, "latin1"), Buffer.alloc(2000, 0xff), Buffer.from(tail!, "latin1")]);
    expect(oneEvent.length).toBeLessThan(4096);
    const r = await run(baseArgs(i), fakeAgy({ events: oneEvent }), script, { fileSizeKb: 4 });
    expect(r.exitCode).toBe(1);
    expect(r.json).toMatchObject({ ok: false, code: "UNEXPECTED_ERROR", attempt: 1, draftSha256: null });
    expect(r.json.message).toContain("EFBIG");
    expect(r.json.files.draft).toBeNull();
    expect(existsSync(join(i.docs, "nod-60-argon-01-draft.md"))).toBe(false);
    const record = JSON.parse(readFileSync(r.json.files.record, "utf8"));
    expect(record).toMatchObject({ ok: false, code: "UNEXPECTED_ERROR", draft: null, files: { draft: null } });
    // 生ログは全量を書けており、失敗は原稿の保存で起きている（応答は判定済み）
    expect(readFileSync(join(i.docs, "nod-60-argon-01-events.jsonl"))).toEqual(oneEvent);
    expect(record.responded).toEqual(ARGON);
    // 上限なしなら同じ応答で原稿を全文保存し、指紋が一致する
    const full = await run(baseArgs(i), fakeAgy({ events: oneEvent }), script);
    expect(full.json.ok).toBe(true);
    expect(sha256(readFileSync(full.json.files.draft))).toBe(full.json.draftSha256);
    expect(readFileSync(full.json.files.draft, "utf8")).toContain("\ufffd".repeat(2000));
  });

  test("生ログの書き込みが short write になれば、メモリ上の応答が完全でも成功にせず UNEXPECTED_ERROR で原稿を出さない", async () => {
    const script = smallSkill();
    const i = inputs();
    // 原稿は小さく、生ログだけが上限の 4KB を超える（原稿に入らないイベントで約 6KB にする）。1 回の読み取りで届く大きさにする
    const oneEvent = `${JSON.stringify({ event: "padding", data: "p".repeat(6000) })}\n${events(answer())}`;
    const r = await run(baseArgs(i), fakeAgy({ events: oneEvent }), script, { fileSizeKb: 4 });
    expect(r.exitCode).toBe(1);
    expect(r.json).toMatchObject({ ok: false, code: "UNEXPECTED_ERROR", attempt: 1, draftSha256: null });
    expect(r.json.message).toContain("EFBIG");
    expect(r.json.files.draft).toBeNull();
    expect(existsSync(join(i.docs, "nod-60-argon-01-draft.md"))).toBe(false);
    const record = JSON.parse(readFileSync(r.json.files.record, "utf8"));
    expect(record).toMatchObject({ ok: false, code: "UNEXPECTED_ERROR", draft: null, files: { draft: null } });
    // 上限なしなら同じ応答で生ログを全量保存して成功する
    const full = await run(baseArgs(i), fakeAgy({ events: oneEvent }), script);
    expect(full.json.ok).toBe(true);
    expect(readFileSync(join(i.docs, "nod-60-argon-02-events.jsonl"), "utf8")).toBe(oneEvent);
  });

  test("試行のファイルを作れなければ UNEXPECTED_ERROR の結果 JSON を出し、agy を呼ばない", async () => {
    const i = inputs();
    const fake = fakeAgy({ events: events(answer()) });
    chmodSync(i.docs, 0o555);
    try {
      const r = await run(baseArgs(i), fake);
      expect(r.exitCode).toBe(1);
      expect(r.json).toMatchObject({ ok: false, code: "UNEXPECTED_ERROR", issue: "NOD-60", files: null, draftSha256: null });
      expect(r.json.message).toContain("EACCES");
      expect(existsSync(join(fake.dir, "argv.log"))).toBe(false);
      expect(readdirSync(i.docs)).toEqual(["nod-60-grilling.md"]);
    } finally {
      chmodSync(i.docs, 0o755);
    }
  });

  test("入力の不足・不正は INVALID_INPUT で、agy を呼ばずファイルも作らない", async () => {
    const i = inputs();
    const target = join(tempDir(), "target.md");
    writeFileSync(target, "# 既存仕様\n");
    const fb = join(tempDir(), "fb.md");
    writeFileSync(fb, "指摘\n");
    const notJson = join(tempDir(), "issue.json");
    writeFileSync(notJson, "{");
    const emptyDesc = join(tempDir(), "issue.json");
    writeFileSync(emptyDesc, JSON.stringify({ ...ISSUE, description: "  " }));
    const cases: string[][] = [
      ["--issue-json", i.issueJson, "--decision-log", i.decisionLog],
      ["--issue", "NOD-61", "--issue-json", i.issueJson, "--decision-log", i.decisionLog],
      baseArgs(i, ["--unknown", "x"]),
      baseArgs(i, ["--effort", "max"]),
      baseArgs(i, ["--mode", "rewrite"]),
      baseArgs(i, ["--timeout", "0"]),
      baseArgs(i, ["--mode", "rebuild"]),
      baseArgs(i, ["--mode", "append"]),
      baseArgs(i, ["--target", `848=${target}`]),
      baseArgs(i, ["--feedback", fb]),
      baseArgs(i, ["--related", `765=${join(i.docs, "missing.md")}`]),
      baseArgs(i, ["--related", i.related]),
      ["--issue", "NOD-60", "--issue-json", notJson, "--decision-log", i.decisionLog],
      ["--issue", "NOD-60", "--issue-json", emptyDesc, "--decision-log", i.decisionLog],
    ];
    for (const args of cases) {
      const fake = fakeAgy({ events: events(answer()) });
      const r = await run(args, fake);
      expect(r.exitCode).toBe(1);
      expect(r.json).toMatchObject({ ok: false, code: "INVALID_INPUT", files: null });
      expect(r.json.message).toEqual(expect.any(String));
      expect(existsSync(join(fake.dir, "version.log"))).toBe(false);
      expect(existsSync(join(fake.dir, "argv.log"))).toBe(false);
      expect(readdirSync(i.docs)).toEqual(["nod-60-grilling.md"]);
    }
  });

  test("執筆ルールの参照ファイルはスクリプトの位置から読み、無い・区切りが無いときは INVALID_INPUT", async () => {
    const root = tempDir("nod-to-spec-skill-");
    mkdirSync(join(root, "scripts"));
    const script = join(root, "scripts", "write-spec.ts");
    writeFileSync(script, readFileSync(SCRIPT));
    const i = inputs();
    const missing = await run(baseArgs(i), fakeAgy({ events: events(answer()) }), script);
    expect(missing.json).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(missing.json.message).toContain("spec-writing.md");
    mkdirSync(join(root, "references"));
    writeFileSync(join(root, "references", "spec-writing.md"), "区切りの無いルール\n");
    expect((await run(baseArgs(i), fakeAgy({ events: events(answer()) }), script)).json).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(readdirSync(i.docs)).toEqual(["nod-60-grilling.md"]);
    writeFileSync(join(root, "references", "spec-writing.md"), `COPIED-RULES\n\n${SEP}\n`);
    const fake = fakeAgy({ events: events(answer()) });
    expect((await run(baseArgs(i), fake, script)).json).toMatchObject({ ok: true });
    expect(fake.request()).toContain("COPIED-RULES");
  });
});
