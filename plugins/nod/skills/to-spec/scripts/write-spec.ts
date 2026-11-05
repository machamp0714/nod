#!/usr/bin/env bun
// nod:to-spec の仕様書本文の執筆を Gemini 4 Argon（Omp 経由）へ依頼する。
// 責任は入力の検査、依頼文の組み立て、Argon の呼び出し、応答の検証、原稿と実行記録の保存まで。nod への登録は主担当が行う。
// 使い方:
//   bun write-spec.ts --issue <ID> --issue-json <file> --decision-log <file>
//     [--related <docId>=<file>]... [--mode new|rebuild|append] [--target <docId>=<file>]
//     [--feedback <file> --previous-record <前回の record.json>] [--effort low|medium|high] [--timeout <seconds>]
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const PROVIDER = "google-antigravity";
const MODEL = "gemini-4-argon";
const SEP = "<<<NOD-SPEC-META>>>";
const SECTIONS = ["Problem Statement", "Solution", "User Stories", "Implementation Decisions", "Testing Decisions", "Out of Scope", "Further Notes"];
const INSTRUCTION = "添付した執筆依頼に従い、仕様書の本文を書いてください。";
const STDERR_CAP = 2000;
// スクリプトの位置から解決する（リポジトリや作業ディレクトリに依存しない）
const REFERENCE = join(import.meta.dir, "../references/spec-writing.md");
// NOD_OMP はテスト用の口（NOD_GH と同じ）: omp の代わりに起動するコマンド。通常は設定しない
const OMP = process.env.NOD_OMP || "omp";

type Mode = "new" | "rebuild" | "append";
type Effort = "low" | "medium" | "high";
interface OpenQuestion {
  question: string;
  reason: string;
}
interface ChangeProposal {
  decision: string;
  proposal: string;
  reason: string;
}
interface DocInput {
  documentId: string;
  file: string;
  text: string;
  bytes: Buffer;
}
interface FileInput {
  file: string;
  text: string;
  bytes: Buffer;
}
// 差し戻しの元にする前回の試行。原稿（成功した試行）か未決の疑問（OPEN_QUESTIONS の試行）のどちらかを持つ
interface Previous {
  record: FileInput;
  draft: FileInput | null;
  openQuestions: OpenQuestion[];
}
interface Options {
  issue: string;
  issueJson: FileInput;
  issueData: { id: string; title: string; description: string; labels: string[] };
  decisionLog: FileInput;
  related: DocInput[];
  mode: Mode;
  target: DocInput | null;
  feedback: FileInput | null;
  previous: Previous | null;
  effort: Effort;
  timeoutSeconds: number;
  reference: string;
}

class Failure extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const invalid = (message: string) => new Failure("INVALID_INPUT", message);

function readInput(path: string, label: string): FileInput {
  const file = resolve(path);
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (e) {
    throw invalid(`${label} のファイルを読めません: ${file}（${(e as NodeJS.ErrnoException).code ?? e}）`);
  }
  return { file, bytes, text: bytes.toString("utf8") };
}

function readDoc(spec: string, label: string): DocInput {
  const at = spec.indexOf("=");
  const documentId = at > 0 ? spec.slice(0, at).trim() : "";
  const path = at > 0 ? spec.slice(at + 1) : "";
  if (!documentId || !path) throw invalid(`${label} は <DocumentID>=<ファイル> の形で指定してください: ${spec}`);
  return { documentId, ...readInput(path, `${label} ${documentId}`) };
}

// 前回の試行の実行記録から、差し戻しに渡す原稿か未決の疑問を読む。原稿は記録の SHA-256 と照合する
function readPrevious(path: string, issue: string, mode: Mode): Previous {
  const record = readInput(path, "--previous-record");
  let r: any;
  try {
    r = JSON.parse(record.text);
  } catch {
    throw invalid(`--previous-record が JSON ではありません: ${record.file}`);
  }
  if (!r || typeof r !== "object" || r.issue !== issue) throw invalid(`--previous-record の Issue（${r?.issue}）が --issue ${issue} と一致しません`);
  if (r.mode !== mode) throw invalid(`--previous-record の執筆の種類（${r.mode}）が --mode ${mode} と一致しません`);
  if (r.ok === true && typeof r.draft?.file === "string") {
    const draft = readInput(join(dirname(record.file), basename(r.draft.file)), "--previous-record の原稿");
    if (sha256(draft.bytes) !== r.draft.sha256) throw invalid(`前回の原稿が実行記録の SHA-256 と一致しません: ${draft.file}`);
    return { record, draft, openQuestions: [] };
  }
  const questions = Array.isArray(r.openQuestions) ? r.openQuestions : [];
  const valid = questions.every((q: any) => q && typeof q.question === "string" && typeof q.reason === "string");
  if (r.code === "OPEN_QUESTIONS" && questions.length && valid) {
    return { record, draft: null, openQuestions: questions.map((q: OpenQuestion) => ({ question: q.question, reason: q.reason })) };
  }
  throw invalid(`差し戻せるのは、原稿を保存した試行か OPEN_QUESTIONS で終わった試行の実行記録だけです: ${record.file}`);
}

function parseArgs(argv: string[]): Options {
  const single = new Map<string, string>();
  const related: string[] = [];
  const known = ["--issue", "--issue-json", "--decision-log", "--mode", "--target", "--feedback", "--previous-record", "--effort", "--timeout"];
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]!;
    if (name !== "--related" && !known.includes(name)) throw invalid(`不明な引数です: ${name}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw invalid(`${name} に値がありません`);
    i++;
    if (name === "--related") related.push(value);
    else if (single.has(name)) throw invalid(`${name} が重複しています`);
    else single.set(name, value);
  }
  const required = (name: string) => {
    const v = single.get(name);
    if (!v) throw invalid(`${name} を指定してください`);
    return v;
  };
  const issue = required("--issue");
  const mode = (single.get("--mode") ?? "new") as Mode;
  if (!["new", "rebuild", "append"].includes(mode)) throw invalid(`--mode は new / rebuild / append のどれかです: ${mode}`);
  const effort = (single.get("--effort") ?? "medium") as Effort;
  if (!["low", "medium", "high"].includes(effort)) throw invalid(`--effort は low / medium / high のどれかです: ${effort}`);
  const timeoutText = single.get("--timeout") ?? "600";
  const timeoutSeconds = Number(timeoutText);
  if (!/^\d+(\.\d+)?$/.test(timeoutText) || !(timeoutSeconds > 0)) throw invalid(`--timeout は正の秒数です: ${timeoutText}`);
  const targetSpec = single.get("--target");
  if (mode === "new" && targetSpec !== undefined) throw invalid("--mode new では --target を指定できません");
  if (mode !== "new" && targetSpec === undefined) throw invalid(`--mode ${mode} では --target <DocumentID>=<ファイル> が必要です`);
  if (single.has("--feedback") !== single.has("--previous-record")) throw invalid("--feedback と --previous-record は両方そろえて指定してください");

  const issueJson = readInput(required("--issue-json"), "--issue-json");
  let data: any;
  try {
    data = JSON.parse(issueJson.text);
  } catch {
    throw invalid(`--issue-json が JSON ではありません: ${issueJson.file}`);
  }
  if (!data || typeof data !== "object" || data.id !== issue) throw invalid(`--issue-json の Issue（${data?.id}）が --issue ${issue} と一致しません`);
  if (typeof data.description !== "string" || !data.description.trim()) throw invalid(`${issue} の本文が空です`);
  const labels = Array.isArray(data.labels) ? data.labels.filter((l: unknown): l is string => typeof l === "string") : [];
  const issueData = { id: issue, title: typeof data.title === "string" ? data.title : "", description: data.description as string, labels };

  const decisionLog = readInput(required("--decision-log"), "--decision-log");
  const relatedDocs = related.map((s) => readDoc(s, "--related"));
  const target = targetSpec === undefined ? null : readDoc(targetSpec, "--target");
  const feedback = single.has("--feedback") ? readInput(single.get("--feedback")!, "--feedback") : null;
  const previous = single.has("--previous-record") ? readPrevious(single.get("--previous-record")!, issue, mode) : null;

  let reference: string;
  try {
    reference = readFileSync(REFERENCE, "utf8");
  } catch {
    throw invalid(`執筆ルールの参照ファイルがありません: ${REFERENCE}`);
  }
  if (!reference.split("\n").some((l) => l.trimEnd() === SEP)) throw invalid(`執筆ルールの参照ファイルに区切り ${SEP} がありません: ${REFERENCE}`);

  return { issue, issueJson, issueData, decisionLog, related: relatedDocs, mode, target, feedback, previous, effort, timeoutSeconds, reference };
}

const tag = (name: string, body: string, attrs = "") => `<input name="${name}"${attrs}>\n${body.trimEnd()}\n</input>`;

const MODE_TEXT: Record<Mode, string> = {
  new: "新規: テンプレートの7節をそろえた仕様書の全文を書いてください。",
  rebuild: "作り直し: 下の「改訂の対象の仕様書」と確定事項を踏まえ、テンプレートの7節をそろえた改訂版の全文を書いてください。",
  append: "追記: 下の「改訂の対象の仕様書」の末尾にそのまま加える追記部分だけを書いてください。既存の本文を繰り返したり書き換えたりしないでください。",
};

function buildRequest(o: Options): string {
  const d = o.issueData;
  const parts = [
    `# 仕様書の執筆依頼（${o.issue}）`,
    `あなたは nod の Issue ${o.issue}「${d.title}」の仕様書（kind=spec の Document）の本文を書きます。\n下の「執筆ルールと仕様書テンプレート」に従い、この依頼に含まれる入力だけを使って書いてください。ツールは使えません。\n各入力は <input name="..."> と </input> で囲んであります。`,
    "## 執筆ルールと仕様書テンプレート",
    tag("spec-writing-rules", o.reference),
    "## 執筆の種類",
    [`- ${MODE_TEXT[o.mode]}`, ...(o.feedback ? ["- 差し戻し: 下の「差し戻し」の主担当の指摘と、前回の原稿または前回の未決の疑問を踏まえ、同じ執筆の種類の原稿を最初から全文書き直してください。指摘に無い確定事項は変えないでください。"] : [])].join("\n"),
    "## 確定事項",
    "### 対象 Issue の本文（前提として有効）",
    "Issue の本文（Story・背景・受け入れ条件を含む）はそのまま前提として有効です。変えないでください。",
    tag("issue", `Issue: ${d.id}\nタイトル: ${d.title}\nラベル: ${d.labels.length ? d.labels.join(", ") : "なし"}\n\n本文:\n${d.description}`),
    "### 決定ログ",
    [
      "決定ログの読み方:",
      "- 突き合わせの表の「決定」の列、「合意したテストの seam」、「最終合意」は確定事項です。",
      "- 「主担当の推奨」「照会先の回答」のうち決定に採られなかった案は不採用案です。",
      "- 「事前に確かめた事実」などの事実の記録は参考です。",
      "- 推測・推定・未確認と書かれた情報は未確認の情報です。",
    ].join("\n"),
    tag("decision-log", o.decisionLog.text),
    "## 参考: 関連する既存の正式仕様書",
    ...(o.related.length
      ? ["確定事項と食い違うときは確定事項を優先してください。", ...o.related.flatMap((r) => [`### Document ${r.documentId}`, tag("related", r.text, ` document-id="${r.documentId}"`)])]
      : ["なし"]),
    ...(o.target ? [`## 改訂の対象の仕様書（Document ${o.target.documentId}）`, tag("target", o.target.text, ` document-id="${o.target.documentId}"`)] : []),
    ...(o.feedback && o.previous
      ? [
          "## 差し戻し",
          "### 主担当の指摘",
          ...(o.previous.openQuestions.length ? ["前回の未決の疑問への主担当の回答（既決事項の根拠）を含みます。"] : []),
          tag("feedback", o.feedback.text),
          ...(o.previous.draft ? ["### 前回の原稿", tag("previous", o.previous.draft.text)] : []),
          ...(o.previous.openQuestions.length
            ? ["### 前回の未決の疑問", tag("previous-open-questions", o.previous.openQuestions.map((q) => `- 疑問: ${q.question}\n  理由: ${q.reason}`).join("\n"))]
            : []),
        ]
      : []),
    "## 不採用案と未確認の情報",
    [
      "- 不採用案を確定した決定として書かないでください。",
      "- 未確認の情報や推定は確定事項として書かず、Further Notes に推定・未実測と明記してください。",
      "- 入力だけでは決められない点は未決の疑問に、決定を変えたほうがよい点は変更提案に書いてください（応答の形式を参照）。",
    ].join("\n"),
  ];
  return `${parts.join("\n\n")}\n`;
}

// 試行番号は既存の <issue>-argon-<NN>-* の最大値 + 1
function nextAttempt(dir: string, issue: string): number {
  const prefix = `${issue.toLowerCase()}-argon-`;
  let max = 0;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix)) continue;
    const m = /^(\d+)-/.exec(name.slice(prefix.length));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

interface OmpResult {
  timedOut: boolean;
  spawnError: NodeJS.ErrnoException | null;
  // 生ログの書き込みに失敗した（想定外のエラー）
  writeError: unknown;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

// 子プロセスはプロセスグループごと起動し、時間切れではグループ全体を止める
function callOmp(args: string[], cwd: string, timeoutMs: number, eventsFd: number): Promise<OmpResult> {
  return new Promise((done) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let timedOut = false;
    let spawnError: NodeJS.ErrnoException | null = null;
    let writeError: unknown = null;
    let settled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      done({ timedOut, spawnError, writeError, exitCode, signal, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
    };
    const child = spawn(OMP, args, { cwd, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // すでに終了している
      }
    };
    child.stdout!.on("data", (b: Buffer) => {
      out.push(b);
      if (writeError) return;
      try {
        // writeSync は short write でも例外を出さずに書けたバイト数を返す。チャンクの全量を書き切る（書けなければ例外で失敗にする）
        for (let off = 0; off < b.length; ) {
          const n = writeSync(eventsFd, b, off);
          if (n <= 0) throw new Error(`生ログを書き切れません（${off}/${b.length} バイト）`);
          off += n;
        }
      } catch (e) {
        writeError = e;
        killGroup("SIGKILL");
      }
    });
    child.stderr!.on("data", (b: Buffer) => err.push(b));
    child.on("error", (e) => {
      spawnError = e as NodeJS.ErrnoException;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
    timers.push(
      setTimeout(() => {
        timedOut = true;
        killGroup("SIGTERM");
        timers.push(setTimeout(() => killGroup("SIGKILL"), 2000));
        // グループ外のプロセスが出力を開いたままでも待ち続けない
        timers.push(
          setTimeout(() => {
            child.stdout!.destroy();
            child.stderr!.destroy();
            finish(null, null);
          }, 4000),
        );
      }, timeoutMs),
    );
  });
}

interface Assistant {
  provider?: unknown;
  model?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
  content?: unknown;
}

// omp v18.16.0 の JSON イベント（決定ログ F2）: 最後のアシスタントメッセージと最初の session イベントの id を読む
function readEvents(stdout: string): { last: Assistant | null; sessionId: string | null } {
  let last: Assistant | null = null;
  let sessionId: string | null = null;
  const isAssistant = (m: any): m is Assistant => m && typeof m === "object" && m.role === "assistant";
  for (const line of stdout.split("\n")) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || typeof ev !== "object") continue;
    if (sessionId === null && ev.type === "session" && typeof ev.id === "string") sessionId = ev.id;
    if (isAssistant(ev.message)) last = ev.message;
    if (Array.isArray(ev.messages)) for (const m of ev.messages) if (isAssistant(m)) last = m;
  }
  return { last, sessionId };
}

const str = (v: unknown) => (typeof v === "string" ? v : null);
const cap = (s: string) => (s.length > STDERR_CAP ? `${s.slice(0, STDERR_CAP)}…` : s);

interface Verdict {
  body: string;
  openQuestions: OpenQuestion[];
  changeProposals: ChangeProposal[];
}

function parseMeta(text: string): { openQuestions: OpenQuestion[]; changeProposals: ChangeProposal[] } {
  let t = text.trim();
  const fence = /^```(?:json)?[ \t]*\n([\s\S]*?)\n```$/.exec(t);
  if (fence) t = fence[1]!.trim();
  let meta: any;
  try {
    meta = JSON.parse(t);
  } catch {
    throw new Failure("RESPONSE_FORMAT", `区切りの後が JSON ではありません: ${cap(t)}`);
  }
  const ok = (v: unknown) => typeof v === "string" && v.trim() !== "";
  const list = (v: unknown, keys: string[]) => Array.isArray(v) && v.every((x) => x && typeof x === "object" && keys.every((k) => ok(x[k])));
  if (!meta || typeof meta !== "object" || !list(meta.openQuestions, ["question", "reason"]) || !list(meta.changeProposals, ["decision", "proposal", "reason"])) {
    throw new Failure("RESPONSE_FORMAT", "区切りの後の JSON は {openQuestions: [{question, reason}], changeProposals: [{decision, proposal, reason}]} の形にしてください");
  }
  return {
    openQuestions: meta.openQuestions.map((q: OpenQuestion) => ({ question: q.question, reason: q.reason })),
    changeProposals: meta.changeProposals.map((p: ChangeProposal) => ({ decision: p.decision, proposal: p.proposal, reason: p.reason })),
  };
}

function judge(text: string, mode: Mode): Verdict {
  const lines = text.split("\n");
  const seps = lines.flatMap((l, i) => (l.trimEnd() === SEP ? [i] : []));
  const bodyLines = seps.length ? lines.slice(0, seps[0]) : lines;
  const body = bodyLines.join("\n");
  if (!body.trim()) throw new Failure("EMPTY_BODY", "応答の本文が空です");
  if (seps.length !== 1) throw new Failure("RESPONSE_FORMAT", `区切り ${SEP} の行が ${seps.length} 個あります（1個にしてください）`);
  const meta = parseMeta(lines.slice(seps[0]! + 1).join("\n"));
  let fenced = false;
  const outside: string[] = [];
  for (const l of bodyLines) {
    if (/^ {0,3}(```|~~~)/.test(l)) fenced = !fenced;
    else if (!fenced) outside.push(l.trimEnd());
  }
  if (outside.some((l) => /^ {0,3}#(?:[ \t]|$)/.test(l))) throw new Failure("TOP_HEADING", "本文に最上位の見出し（#）があります");
  if (mode !== "append") {
    const missing = SECTIONS.filter((s) => !outside.includes(`## ${s}`));
    if (missing.length) throw new Failure("SECTION_MISSING", `テンプレートの節が欠けています: ${missing.join("、")}`);
  }
  if (meta.openQuestions.length) throw Object.assign(new Failure("OPEN_QUESTIONS", `未決の疑問が ${meta.openQuestions.length} 件あります`), { meta });
  return { body, ...meta };
}

// nod doc create --body - は「# タイトル\n\n本文」で保存する。先頭の空行と末尾の空白を除き、改行1つで終える
const normalize = (body: string) => `${body.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd()}\n`;

// 理由コードの列挙に当たらない想定外のエラー（書き込み失敗など）。理由コード付きの失敗として返す
function unexpected(e: unknown): Failure {
  if (e instanceof Failure) return e;
  const err = e as NodeJS.ErrnoException;
  const detail = err && typeof err === "object" ? [err.code, err.message].filter(Boolean).join(": ") : String(e);
  return new Failure("UNEXPECTED_ERROR", `想定外のエラーで中断しました: ${cap(detail || String(e))}`);
}

function classify(r: OmpResult, what: string): Failure | null {
  if (r.writeError) return unexpected(r.writeError);
  if (r.timedOut) return new Failure("TIMEOUT", `${what}が時間内に終わりませんでした`);
  if (r.spawnError) return new Failure("OMP_NOT_FOUND", `omp を起動できません: ${OMP}（${r.spawnError.code ?? r.spawnError.message}）`);
  if (r.exitCode !== 0) {
    const stderr = cap(r.stderr.trim());
    const status = r.exitCode === null ? `シグナル ${r.signal}` : `終了コード ${r.exitCode}`;
    const unavailable = /not found|unknown model|no (api )?key|auth|login|unauthori[sz]ed|credential|forbidden|\b40[13]\b/i.test(stderr);
    return new Failure(unavailable ? "ARGON_UNAVAILABLE" : "OMP_FAILED", `${what}が${status}で失敗しました: ${stderr || "（標準エラーなし）"}`);
  }
  return null;
}

function emit(result: Record<string, unknown>, ok: boolean): never {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(ok ? 0 : 1);
}

// 試行のファイルを作る前の失敗の結果（ファイルなし）
const bare = (f: Failure, issue: string | null = null) => ({
  ok: false, code: f.code, message: f.message, issue, attempt: null, dir: null, files: null, draftSha256: null, openQuestions: [], changeProposals: [],
});

async function main(): Promise<void> {
  let o: Options;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    emit(bare(unexpected(e)), false);
  }

  const startedAt = new Date();
  let dir: string;
  let request: string;
  let attempt: number;
  let prefix: string;
  try {
    dir = dirname(realpathSync(o.decisionLog.file));
    request = buildRequest(o);
    // 既存ファイルは上書きしない。同時に作られていたら次の番号にする
    attempt = nextAttempt(dir, o.issue);
    for (;;) {
      prefix = `${o.issue.toLowerCase()}-argon-${String(attempt).padStart(2, "0")}`;
      try {
        writeFileSync(join(dir, `${prefix}-request.md`), request, { flag: "wx" });
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        attempt++;
      }
    }
  } catch (e) {
    emit(bare(unexpected(e), o.issue), false);
  }
  const names = { request: `${prefix}-request.md`, events: `${prefix}-events.jsonl`, draft: `${prefix}-draft.md`, record: `${prefix}-record.json` };
  const requestPath = join(dir, names.request);
  const draftPath = join(dir, names.draft);

  let ompVersion: string | null = null;
  let responded = { provider: null as string | null, model: null as string | null, stopReason: null as string | null };
  let sessionId: string | null = null;
  let stderr = "";
  let openQuestions: OpenQuestion[] = [];
  let changeProposals: ChangeProposal[] = [];
  let draft: string | null = null;
  let draftCreated = false;
  let failure: Failure | null = null;
  let eventsFd: number | null = null;
  let work: string | null = null;
  try {
    eventsFd = openSync(join(dir, names.events), "wx");
    work = realpathSync(mkdtempSync(join(tmpdir(), "nod-argon-")));
    const version = spawnSync(OMP, ["--version"], { cwd: work, env: process.env, encoding: "utf8", timeout: o.timeoutSeconds * 1000 });
    const versionFailure = classify(
      {
        timedOut: (version.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
        spawnError: version.error && (version.error as NodeJS.ErrnoException).code !== "ETIMEDOUT" ? (version.error as NodeJS.ErrnoException) : null,
        writeError: null,
        exitCode: version.status,
        signal: version.signal,
        stdout: version.stdout ?? "",
        stderr: version.stderr ?? "",
      },
      "omp --version ",
    );
    if (versionFailure) throw versionFailure;
    ompVersion = (version.stdout ?? "").trim() || null;

    const args = ["-p", "--model", `${PROVIDER}/${MODEL}`, "--thinking", o.effort, "--no-tools", "--no-session", "--no-skills", "--no-rules", "--no-context-files", "--no-extensions", "--mode", "json", `@${requestPath}`, INSTRUCTION];
    const r = await callOmp(args, work, o.timeoutSeconds * 1000, eventsFd);
    stderr = cap(r.stderr.trim());
    const callFailure = classify(r, "Argon の呼び出し");
    if (callFailure) throw callFailure;

    const { last, sessionId: sid } = readEvents(r.stdout);
    sessionId = sid;
    if (last) responded = { provider: str(last.provider), model: str(last.model), stopReason: str(last.stopReason) };
    if (!last) throw new Failure("MODEL_NOT_ARGON", "応答したモデルを判定できません（アシスタントのメッセージがありません）");
    if (responded.provider !== PROVIDER || responded.model !== MODEL) {
      throw new Failure("MODEL_NOT_ARGON", `応答したモデルが Argon ではありません: ${responded.provider}/${responded.model}`);
    }
    if (responded.stopReason !== "stop") {
      const reason = str(last.errorMessage);
      throw new Failure("STOP_REASON", `停止理由が正常ではありません: ${responded.stopReason}${reason ? `（${reason}）` : ""}`);
    }
    const text = (Array.isArray(last.content) ? last.content : [])
      .filter((c: any) => c && c.type === "text" && typeof c.text === "string")
      .map((c: any) => c.text as string)
      .join("");
    try {
      const v = judge(text, o.mode);
      openQuestions = v.openQuestions;
      changeProposals = v.changeProposals;
      draft = normalize(v.body);
    } catch (e) {
      const meta = (e as { meta?: { openQuestions: OpenQuestion[]; changeProposals: ChangeProposal[] } }).meta;
      if (meta) ({ openQuestions, changeProposals } = meta);
      throw e;
    }
    const fd = openSync(draftPath, "wx");
    draftCreated = true;
    try {
      // writeSync は short write でも例外を出さずに書けたバイト数を返す。全量を書き切る（書けなければ例外で失敗にする）
      writeFileSync(fd, draft);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    failure = unexpected(e);
  } finally {
    try {
      if (eventsFd !== null) closeSync(eventsFd);
      if (work) rmSync(work, { recursive: true, force: true });
    } catch {
      // 後始末の失敗は結果を変えない
    }
  }

  // 失敗の試行には原稿を残さない（自分で作った原稿ファイルだけを消す）
  const dropDraft = () => {
    draft = null;
    if (!draftCreated) return;
    try {
      unlinkSync(draftPath);
    } catch {
      // 消せなくても結果は失敗のまま（files.draft は null）
    }
  };
  if (failure) dropDraft();

  const inputs = [
    { role: "issue", file: o.issueJson.file, sha256: sha256(o.issueJson.bytes), bytes: o.issueJson.bytes.length },
    { role: "issue-description", sha256: sha256(o.issueData.description), bytes: Buffer.byteLength(o.issueData.description) },
    { role: "decision-log", file: o.decisionLog.file, sha256: sha256(o.decisionLog.bytes), bytes: o.decisionLog.bytes.length },
    ...o.related.map((r) => ({ role: "related", documentId: r.documentId, file: r.file, sha256: sha256(r.bytes), bytes: r.bytes.length })),
    ...(o.target ? [{ role: "target", documentId: o.target.documentId, file: o.target.file, sha256: sha256(o.target.bytes), bytes: o.target.bytes.length }] : []),
    ...[o.feedback && { role: "feedback", ...o.feedback }, o.previous && { role: "previous-record", ...o.previous.record }, o.previous?.draft && { role: "previous", ...o.previous.draft }]
      .filter((x) => !!x)
      .map((x) => ({ role: x.role, file: x.file, sha256: sha256(x.bytes), bytes: x.bytes.length })),
  ];
  const draftSha256 = () => (draft === null ? null : sha256(draft));
  const message = () => (failure ? failure.message : `原稿を保存しました（試行 ${attempt}）`);
  const record = {
    issue: o.issue,
    mode: o.mode,
    attempt,
    startedAt: startedAt.toISOString(),
    elapsedMs: Date.now() - startedAt.getTime(),
    ompVersion,
    requested: { provider: PROVIDER, model: MODEL, thinking: o.effort, timeoutSeconds: o.timeoutSeconds },
    responded,
    sessionId,
    inputs,
    request: { file: names.request, sha256: sha256(request) },
    draft: draft === null ? null : { file: names.draft, sha256: draftSha256() },
    openQuestions,
    changeProposals,
    ok: !failure,
    code: failure?.code ?? null,
    message: message(),
    stderr,
    files: { request: names.request, events: names.events, draft: draft === null ? null : names.draft, record: names.record },
  };
  let recordSaved = false;
  try {
    writeFileSync(join(dir, names.record), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
    recordSaved = true;
  } catch (e) {
    // 実行記録が無い原稿は採用できない。失敗にして原稿を消す
    const why = unexpected(e).message;
    failure = failure ? new Failure(failure.code, `${failure.message}（実行記録も保存できません: ${why}）`) : new Failure("UNEXPECTED_ERROR", `実行記録を保存できません: ${why}`);
    dropDraft();
  }

  emit(
    {
      ok: !failure,
      code: failure?.code ?? null,
      message: message(),
      issue: o.issue,
      attempt,
      dir,
      files: { request: requestPath, events: join(dir, names.events), draft: draft === null ? null : draftPath, record: recordSaved ? join(dir, names.record) : null },
      draftSha256: draftSha256(),
      openQuestions,
      changeProposals,
    },
    !failure,
  );
}

// 最後の砦: どの経路の想定外の例外でも、理由コード付きの結果 JSON を1つ出して非0で終える
process.on("uncaughtException", (e) => emit(bare(unexpected(e)), false));
await main().catch((e) => emit(bare(unexpected(e)), false));
