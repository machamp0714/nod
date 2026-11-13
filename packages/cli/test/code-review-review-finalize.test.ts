import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  ACCEPTANCE_ROW,
  commit,
  exploreHandoff,
  git,
  gitOut,
  makeGitRepo,
  type PreparedWork,
  prepareCaseWork,
  put,
  reachRefute,
  refuteVerdict,
  registerRepo,
  runReview,
  runReviewScript,
  SKILL_DIR,
  type Sandbox,
  sandbox,
  type TempNod,
  tempNod,
} from "./code-review-review-helpers";

const read = (path: string) => readFileSync(path, "utf8");
// 受け入れ確認担当の行の要求の出典（反証の判定本文の ACCEPTANCE_ROW をバッククォートを外して読んだ形）
const ROW = "requirements/issue.md:L3（記録の部分）";
const MERGE_OK = "可（人のレビューなしでマージ可）";
const MERGE_NG = "不可（人の判断が要る）";
const RECHECK_OWNER = "受け入れ確認担当（新しい実行）";
const PR = "https://github.com/acme/app/pull/1";
const OTHER = "0123456789abcdef0123456789abcdef01234567";
// Workspace の規約。「必須のチェック」の節の test だけが必須のチェック
const RULES = "# 規約\n\n- 日本語で書く\n\n## 必須のチェック\n\n- test\n";

interface Remaining {
  ref: string;
  owner: string;
  reason: string;
}
interface SavedDoc {
  id: number | null;
  path: string | null;
  problems: string[];
}
interface Ci {
  ran: boolean;
  verdict: string;
  reason: string;
  base: string | null;
  resultHead: string | null;
  record: string;
}
interface Finalize {
  status: string;
  reason: string | null;
  score: number | string;
  scoreValue: number | null;
  remainingCount: number;
  remaining: Remaining[];
  merge: string;
  reportedMerge: string;
  blockers: string[];
  ci: Ci;
  head: { currentHead: string | null; headOk: boolean; baseOk: boolean; problem: string | null } | null;
  documents: { audit: SavedDoc; report: SavedDoc } | null;
  saved: boolean;
  saveProblems: string[];
  logs: { summary: number | null; ci: number | null; ownLogs: number[] };
  label: { operation: string; error: string | null };
  recheck: { evidence: { appended: number; others: number; own: number; events: number } | null };
  reportStartedAt: string;
  savedAt: string;
  reviewSideMerge: { autoCheckRows: string; merge: string; blockers: string[] } | null;
}
interface Recheck {
  n: number;
  checked: boolean;
  reason: string | null;
  merge: string;
  blockers: string[];
  ci: Ci | null;
  added: Remaining[];
  label: { operation: string; log: number | null } | null;
  record: string;
}
interface Check {
  valid: boolean;
  violations: { no: number; message: string }[];
  conflicts?: number;
}
interface Activity {
  kind: string;
  id?: number;
  body?: string;
  logKind?: string | null;
}

const messages = (r: Check | undefined, no: number) =>
  (r?.violations ?? [])
    .filter((v) => v.no === no)
    .map((v) => v.message)
    .join("\n");

// 偽の gh。gh repo view と、ci-checks.ts が使う gh api（--paginate・--slurp・--jq '.<key>[] | tojson'）に設定の応答で答え、
// gh pr view <PR> --json headRefOid,baseRefName には設定の pr を呼ばれた順に返す（最後の値を繰り返す）。それ以外は失敗する
const FAKE_GH = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
const config = JSON.parse(readFileSync(process.env.FAKE_GH_CONFIG, "utf8"));
const fail = (m) => { process.stderr.write(m + "\\n"); process.exit(1); };
if (args[0] === "pr" && args[1] === "view" && args[3] === "--json" && args[4] === "headRefOid,baseRefName") {
  const counter = process.env.FAKE_GH_CONFIG + ".pr";
  const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(n + 1));
  process.stdout.write(JSON.stringify(config.pr[Math.min(n, config.pr.length - 1)]) + "\\n");
  process.exit(0);
}
if (args[0] === "repo" && args[1] === "view") { process.stdout.write(JSON.stringify({ nameWithOwner: config.repo }) + "\\n"); process.exit(0); }
if (args[0] !== "api") fail("fake gh: unsupported: " + args.join(" "));
let paginate = false, slurp = false, jq = null, endpoint = null;
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "--paginate") paginate = true;
  else if (a === "--slurp") slurp = true;
  else if (a === "--jq") jq = args[++i];
  else if (a.startsWith("-")) fail("fake gh: unsupported: " + a);
  else endpoint = a;
}
const api = config.api[endpoint.split("?")[0]];
if (api === undefined) fail("gh: Not Found (HTTP 404)");
const bodies = paginate ? api.pages : api.pages.slice(0, 1);
if (slurp) process.stdout.write(JSON.stringify(bodies) + "\\n");
else if (jq !== null) { const m = /^\\.(\\w*)\\[\\] \\| tojson$/.exec(jq); for (const body of bodies) for (const item of m[1] ? body[m[1]] : body) process.stdout.write(JSON.stringify(item) + "\\n"); }
else for (const body of bodies) process.stdout.write(JSON.stringify(body));
`;

type CheckState = "success" | "failure" | "in_progress" | "none";

// 偽の gh の設定（gh pr view の応答の並びと、gh api の応答）
interface FakeWorld {
  repo: string;
  pr: { headRefOid: string; baseRefName: string }[];
  api: Record<string, { pages: unknown[] }>;
}

interface FakeGh {
  set: (w: FakeWorld) => void;
  calls: () => string[][];
}

// 偽 GitHub: 基点 main は保護なし・ルールセットなし（必須のチェックは Workspace の規約の test だけ）。check はその head の test の check run
function world(head: string, check: CheckState, pr: FakeWorld["pr"] = [{ headRefOid: head, baseRefName: "main" }]): FakeWorld {
  const pending = check === "in_progress";
  const runs =
    check === "none"
      ? []
      : [{ id: 1, name: "test", status: pending ? "in_progress" : "completed", conclusion: pending ? null : check, head_sha: head, app: { id: 15368 }, html_url: "https://github.com/acme/app/actions/runs/1", completed_at: pending ? null : "2026-11-13T00:00:00Z" }];
  return {
    repo: "acme/app",
    pr,
    api: {
      "repos/acme/app/branches/main": { pages: [{ protected: false }] },
      "repos/acme/app/rules/branches/main": { pages: [[]] },
      [`repos/acme/app/commits/${head}`]: { pages: [{ sha: head }] },
      [`repos/acme/app/commits/${head}/check-runs`]: { pages: [{ check_runs: runs }] },
      [`repos/acme/app/commits/${head}/status`]: { pages: [{ statuses: [] }] },
    },
  };
}

function fakeGh(s: Sandbox): FakeGh {
  const script = join(s.t, "fake-gh.ts");
  writeFileSync(script, FAKE_GH);
  const gh = join(s.bin, "fake-gh");
  writeFileSync(gh, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  chmodSync(gh, 0o755);
  const config = join(s.t, "fake-gh.json");
  const log = join(s.t, "fake-gh.log");
  Object.assign(s.env, { NOD_GH: gh, FAKE_GH_CONFIG: config, FAKE_GH_LOG: log });
  return {
    set: (w) => {
      writeFileSync(config, JSON.stringify(w));
      rmSync(`${config}.pr`, { force: true });
    },
    calls: () => (existsSync(log) ? read(log).trimEnd().split("\n").map((l) => JSON.parse(l) as string[]) : []),
  };
}

// 呼ばれたら失敗する gh（CI と PR を読めない環境）
function failingGh(s: Sandbox): void {
  const gh = join(s.bin, "failing-gh");
  writeFileSync(gh, "#!/bin/sh\necho 'gh: not available' >&2\nexit 1\n");
  chmodSync(gh, 0o755);
  s.env.NOD_GH = gh;
}

// 呼ばれたら記録して失敗する偽の nod（評価用の事例で nod を使わないことを確かめる）
function forbiddenNod(s: Sandbox): () => string {
  const log = join(s.t, "nod.log");
  const path = join(s.bin, "fake-nod");
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nexit 9\n`);
  chmodSync(path, 0o755);
  s.env.NOD_CLI = path;
  return () => (existsSync(log) ? read(log) : "");
}

interface IssueRepo {
  nod: TempNod;
  repo: string;
  base: string;
  head: string;
  issue: string;
}

// 一時の nod の DB と、main から分けた feature の1 commit を持つリポジトリ、Workspace の規約、要求の Issue
async function issueRepo(s: Sandbox): Promise<IssueRepo> {
  const nod = tempNod(s);
  const repo = makeGitRepo(s, "app");
  registerRepo(nod.db, repo, "APP");
  const base = gitOut(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "-q", "-b", "feature");
  const head = commit(repo, { "src/a.ts": "export const a = 1;\n" });
  expect((await nod.run(["workspace", "rules", "set", "--text", RULES], repo)).exitCode).toBe(0);
  const issue = (await nod.run(["--json", "issue", "create", "要求の Issue", "--description", "- a は 1 を返す\n- 失敗を記録する"], repo)).json.id as string;
  return { nod, repo, base, head, issue };
}

const comment = async (x: IssueRepo, body: string, replyTo?: number) => (await x.nod.run(["--json", "issue", "comment", x.issue, body, ...(replyTo ? ["--reply-to", String(replyTo)] : [])], x.repo)).json.id as number;
const issueShow = async (x: IssueRepo) => (await x.nod.run(["--json", "issue", "show", x.issue], x.repo)).json as { labels: string[]; activity: Activity[] };
const docShow = async (x: IssueRepo, id: number) => (await x.nod.run(["--json", "doc", "show", String(id)], x.repo)).json as { kind: string; issues: { id: string }[]; content: string };

// 基点はブランチ名 main（CI の照合に使う）。pr なら PR から固定した head、無ければ SHA だけの head（ref なし）
async function prepareIssue(s: Sandbox, x: IssueRepo, name: string, pr: boolean): Promise<PreparedWork> {
  const W = join(s.t, "work", name);
  const r = await runReview<{ ready: boolean }>("prepare", ["--work", W, "--repo", x.repo, "--mode", "commit", "--base", "main", "--head", x.head, "--issue", x.issue, ...(pr ? ["--pr", PR] : [])], s);
  if (r.exitCode !== 0 || !r.json?.ready) throw new Error(`prepare が準備完了を返しません: ${r.stdout}${r.stderr}`);
  return { W, repo: x.repo, base: x.base, head: x.head, clone: join(W, "repo") };
}

async function must(s: Sandbox, p: PreparedWork, sub: string, args: string[] = []): Promise<void> {
  const r = await runReview<{ valid?: boolean; ready?: boolean }>(sub, ["--work", p.W, ...args], s);
  if (r.exitCode !== 0 || r.json?.valid === false || r.json?.ready === false) throw new Error(`${sub} ${args.join(" ")} が通りません: ${r.stdout}${r.stderr}`);
}

// 反証の判定本文を検査し、受け入れ確認への入力を写す（refs が null なら --refs を渡さない評価用の事例）
async function reachAcceptance(s: Sandbox, p: PreparedWork, verdict: string, refs: object[] | null): Promise<void> {
  await reachRefute(s, p, verdict);
  await must(s, p, "check-refute");
  await must(s, p, "acceptance-records");
  const file = join(s.t, `refs-${basename(p.W)}.json`);
  if (refs) put(file, JSON.stringify(refs));
  await must(s, p, "acceptance-input", refs ? ["--refs", file] : []);
}

const checkAcceptance = async (s: Sandbox, p: PreparedWork) => (await runReview<Check>("check-acceptance", ["--work", p.W], s)).json;

// 受け入れ確認を委譲し、結果を置いて受領を記録し、検査する
async function deliverAcceptance(s: Sandbox, p: PreparedWork, result: string): Promise<Check | undefined> {
  await must(s, p, "agent", ["--role", "acceptance", "--event", "start"]);
  put(join(p.W, "acceptance/result.md"), result);
  await must(s, p, "agent", ["--role", "acceptance", "--event", "received", "--agent-id", "agent-acceptance"]);
  return checkAcceptance(s, p);
}

interface ResultOptions {
  verdict?: string;
  parts?: Record<string, string>;
  shortfall?: string;
  gaps?: string[];
  used?: string[];
  conflicts?: string[];
  role?: string;
  rows?: boolean;
}

// 雛形（assets/acceptance-result.md）どおりの受け入れ確認の結果。既定は受け入れ確認担当の行1行を確認済みにする
function acceptanceResult(p: PreparedWork, o: ResultOptions = {}): string {
  const verdict = o.verdict ?? "確認済み";
  const parts: Record<string, string> = {
    成果物の不変版の存在: "確認済み: 記録の写しがある",
    "作業・手順の実施": "確認済み: 記録した作業がある",
    現在の配置: "対象外（要求が求めていない）",
    外部の正本との内容の一致: "対象外（要求が求めていない）",
    更新順序: "対象外（要求が求めていない）",
    ...o.parts,
  };
  const shortfall = o.shortfall ?? (verdict === "確認済み" ? "なし" : "失敗の記録が対象版との対応を示さない");
  const gaps = o.gaps ?? (verdict === "確認済み" ? null : [`| ${ACCEPTANCE_ROW} | ${verdict} | 成果物の不変版の存在 | ${shortfall} |`]);
  const row = [
    `### 行 1: ${ACCEPTANCE_ROW}`,
    "",
    `- 要求の出典: ${ACCEPTANCE_ROW}`,
    `- 対象版: head \`${p.head}\``,
    `- 判定: ${verdict}`,
    ...Object.entries(parts).map(([k, v]) => `- ${k}: ${v}`),
    "- 証拠: records.md の項目と限定 clone の固定版",
    `- 不足理由: ${shortfall}`,
    "- 証拠にしなかった主張: なし",
    "",
  ];
  return [
    "# 受け入れ確認の結果",
    "",
    "## 担当と対象",
    "",
    `- 役割: ${o.role ?? "受け入れ確認"}`,
    "- 定義名: code-reviewer-acceptance",
    "- 担当 ID: 不明",
    "- モデル申告: 未確認",
    `- 対象版: \`${p.clone}\`／commit／merge-base \`${p.base}\`／head \`${p.head}\``,
    "- 受け取った入力: `acceptance-input/` の各ファイル（manifest.md・records.md の sha256 と一致）",
    "- Activity・添付 Document・参照された記録・外部の正本の写し: records.md のとおり",
    `- 終了状態: ${verdict === "確かめられず" ? "確かめられずを含む" : "完了"}`,
    "",
    "## 行ごとの判定",
    "",
    ...(o.rows === false ? [] : row),
    "## 未充足・確かめられずの行",
    "",
    ...(gaps ? ["| 要求の出典 | 判定 | 不足箇所 | 不足理由 |", "|---|---|---|---|", ...gaps] : ["なし"]),
    "",
    "## 判定に使った証拠",
    "",
    ...(o.used?.length ? ["| 項目 | 出典（`records.md` と同じ） | 使った行 | 使い方（5つの部分のどれか） |", "|---|---|---|---|", ...o.used] : ["なし"]),
    "",
    "## 反証の判定と矛盾する証拠",
    "",
    ...(o.conflicts?.length ? ["| 反証の判定の箇所 | 矛盾する証拠 | 理由 |", "|---|---|---|", ...o.conflicts] : ["なし"]),
    "",
    "## 判断を見送った事項",
    "",
    "なし",
    "",
  ].join("\n");
}

const usedRow = (item: string, use = "作業・手順の実施") => `| \`${item}\` | records.md の ${item} | ${ACCEPTANCE_ROW} | ${use} |`;
const finalize = async (s: Sandbox, p: PreparedWork, args: string[] = []) => runReview<Finalize>("finalize", ["--work", p.W, ...args], s);
const recheck = async (s: Sandbox, p: PreparedWork, args: string[] = []) => (await runReview<Recheck>("recheck-ci", ["--work", p.W, ...args], s)).json;
const today = () => new Date().toISOString().slice(0, 10).replaceAll("-", "");
// 印の間（ci-result など）を除いた本文
const outsideCi = (text: string) => text.replace(/<!-- ci-result:begin -->[\s\S]*?<!-- ci-result:end -->/g, "");

// 完了・点数5（要対応0件）で、受け入れ確認担当の行を確認済みにした Issue と PR のレビュー。CI は success
async function cleanIssueReview(s: Sandbox, name: string, used: (c1: number) => string[]): Promise<{ x: IssueRepo; p: PreparedWork; gh: FakeGh; c1: number; logFile: string; verdict: string; result: string }> {
  const gh = fakeGh(s);
  const x = await issueRepo(s);
  const logFile = join(s.t, "evidence/run.log");
  put(logFile, "失敗を記録した\n");
  const c1 = await comment(x, `作業の記録: ${logFile}`);
  gh.set(world(x.head, "success"));
  const p = await prepareIssue(s, x, name, true);
  const verdict = refuteVerdict(p, { clean: true });
  await reachAcceptance(s, p, verdict, [{ type: "file", source: logFile, kind: "参照された記録", from: `activity:${c1}`, at: `records/activity.json の activity:${c1}`, quote: logFile }]);
  const result = acceptanceResult(p, { used: used(c1) });
  expect(await deliverAcceptance(s, p, result)).toMatchObject({ valid: true, violations: [] });
  return { x, p, gh, c1, logFile, verdict, result };
}

describe("code-review の仕上げ（review.ts check-acceptance・finalize・recheck-ci）", () => {
  test("正常保存: 完了・点数5・CI 成功・確認が残る事項0で可にし、監査→結果の順に2つの Document を保存して照合し、作業ログ・merge-ready・[ci-result] と own-logs を残す。13節の再照合は own-logs の id だけで親自身の記録を除く", async () => {
    const s = sandbox();
    const { x, p, c1, verdict, result } = await cleanIssueReview(s, "ok", (c) => [usedRow("evidence/1", "成果物の不変版の存在"), usedRow(`activity:${c}`)]);

    const r = await finalize(s, p);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const f = r.json as Finalize;
    expect(f).toMatchObject({ status: "完了", reason: null, score: 5, scoreValue: 5, remainingCount: 0, merge: MERGE_OK, reportedMerge: MERGE_OK, blockers: [], saved: true, saveProblems: [] });
    expect(f.ci).toMatchObject({ ran: true, verdict: "成功", base: "main", resultHead: x.head, record: "parent/ci/1/result.json" });
    expect(f.head).toMatchObject({ currentHead: x.head, headOk: true, baseOk: true, problem: null });
    expect(f.label).toEqual({ operation: "付けた", error: null });
    expect(f.reportStartedAt <= f.savedAt).toBe(true);
    expect(JSON.parse(read(join(p.W, "parent/finalize.json")))).toEqual(JSON.parse(JSON.stringify({ ok: true, subcommand: "finalize", ...f })));

    // 2つの Document: kind=doc で Issue にリンクし、タイトル見出しを除いた本文が原稿と同じ。監査の印の間は原文のまま
    const auditId = f.documents?.audit.id as number;
    const reportId = f.documents?.report.id as number;
    const audit = await docShow(x, auditId);
    const report = await docShow(x, reportId);
    expect(audit.kind).toBe("doc");
    expect(report.kind).toBe("doc");
    expect(audit.issues.map((i) => i.id)).toEqual([x.issue]);
    expect(report.issues.map((i) => i.id)).toEqual([x.issue]);
    expect(audit.content).toBe(`# ${x.issue} コードレビュー監査（ok）\n\n${read(join(p.W, "parent/audit.md"))}`);
    expect(report.content).toBe(`# ${x.issue} コードレビュー結果（ok）\n\n${read(join(p.W, "parent/report.md"))}`);
    expect(audit.content.split("<!-- refute-verdict:begin -->\n")[1]?.split("<!-- refute-verdict:end -->")[0]).toBe(verdict);
    expect(audit.content.split("<!-- acceptance-result:begin -->\n")[1]?.split("<!-- acceptance-result:end -->")[0]).toBe(result);
    expect(audit.content).toContain(`- runId: ok`);
    expect(audit.content).toContain(`- 作業ディレクトリ: ${p.W}`);
    // 結果は短い結論と監査への参照。原文・全対応表は載せず、CI の結果は印の中だけ
    expect(report.content).toContain(`監査 Document ${auditId}`);
    expect(report.content).toContain("- 最終状態: 完了");
    expect(report.content).toContain("- 確定した要対応の点数: 5");
    expect(report.content).toContain(`<!-- ci-result:begin -->\n- マージ可否: ${MERGE_OK}`);
    expect(report.content).not.toContain("## 採否一覧");
    expect(outsideCi(report.content)).not.toContain("CI 判定");
    expect(outsideCi(audit.content)).not.toContain("CI 判定");

    // 作業ログ（完了は progress。CI の結果は書かない）と [ci-result] の test。どちらの id も own-logs.md に残る
    const shown = await issueShow(x);
    expect(shown.labels).toContain("merge-ready");
    const summary = shown.activity.find((a) => a.id === f.logs.summary);
    expect(summary).toMatchObject({ logKind: "progress" });
    expect(summary?.body).toContain(`結果Document ${reportId}`);
    expect(summary?.body).toContain(`監査Document ${auditId}`);
    expect(summary?.body?.startsWith("[ci-result]")).toBe(false);
    expect(summary?.body).not.toContain("成功");
    const ciLog = shown.activity.find((a) => a.id === f.logs.ci);
    expect(ciLog?.logKind).toBe("test");
    expect(ciLog?.body?.startsWith("[ci-result] merge-ready: 付けた。")).toBe(true);
    expect(ciLog?.body).toContain(`報告Document ${reportId}`);
    const own = read(join(p.W, "parent/acceptance/own-logs.md"));
    expect(own).toContain(`- ${f.logs.summary}: `);
    expect(own).toContain(`- ${f.logs.ci}: `);
    expect(read(join(p.W, "parent/head-check.md"))).toContain("merge-ready を付ける直前");

    // 保存し直さない
    expect((await finalize(s, p)).exitCode).toBe(2);

    // 13節: 同じ head の CI を照合し直す（変化なしなら可のまま）
    const again = await recheck(s, p);
    expect(again).toMatchObject({ n: 2, checked: true, merge: MERGE_OK, blockers: [], added: [] });
    expect(again?.label?.operation).toBe("付けた");
    expect(existsSync(join(p.W, "parent/ci/2/result.json"))).toBe(true);
    expect(read(join(p.W, "parent/recheck-2/record.md"))).toContain(`マージ可否: ${MERGE_OK}`);

    // 保存の後に PM が書いた記録（--own-log で渡す）と、親以外の返信
    const pm = await comment(x, "PR を作った");
    const reply = await comment(x, "補足の返信", c1);
    const third = await recheck(s, p, ["--own-log", String(pm)]);
    expect(third).toMatchObject({ n: 3, checked: true, merge: MERGE_NG });
    const reasons = (third?.added ?? []).map((a) => a.reason).join("\n");
    expect(reasons).toContain(`activity:${reply}`);
    expect(reasons).toContain("親以外の追記");
    expect(reasons).not.toContain(`activity:${pm}`);
    expect(third?.added.every((a) => a.ref === ROW && a.owner === RECHECK_OWNER)).toBe(true);
    expect(third?.label?.operation).toBe("外した");
    expect((await issueShow(x)).labels).not.toContain("merge-ready");
    expect(read(join(p.W, "parent/acceptance/own-logs.md"))).toContain(`- ${pm}: `);
    expect(read(join(p.W, "parent/recheck-3/record.md"))).toContain(`activity:${reply}`);
  });

  test("保存の失敗では merge-ready を付けず、13節で CI の未確定・成功・PR の基点の変化・result.json の head の不一致を照合し直す", async () => {
    const s = sandbox();
    const { x, p, gh } = await cleanIssueReview(s, "ci", () => [usedRow("限定 clone", "成果物の不変版の存在")]);
    // 結果 Document の保存先が既にある（保存の失敗）
    put(join(x.nod.docs, `${x.issue.toLowerCase()}-code-review-${today()}-ci.md`), "既にある\n");
    const f = (await finalize(s, p)).json as Finalize;
    expect(f).toMatchObject({ status: "完了", score: 5, remainingCount: 0, reportedMerge: MERGE_OK, merge: MERGE_NG, saved: false });
    expect(f.documents?.audit.id).toBeNumber();
    expect(f.documents?.report.id).toBeNull();
    expect(f.saveProblems.join("\n")).toContain("コードレビュー結果");
    expect(f.label.operation).toBe("付けていない");
    expect(f.blockers.join("\n")).toContain("報告の保存・照合に失敗");
    const shown = await issueShow(x);
    expect(shown.labels).not.toContain("merge-ready");
    expect(shown.activity.find((a) => a.id === f.logs.ci)?.body?.startsWith("[ci-result] merge-ready: 付けていない（マージ可否が不可: ")).toBe(true);

    // CI の未確定は不可（polling しない）
    gh.set(world(x.head, "in_progress"));
    const pending = await recheck(s, p);
    expect(pending).toMatchObject({ n: 2, checked: true, merge: MERGE_NG });
    expect(pending?.ci?.verdict).toBe("未確定");
    expect(pending?.label?.operation).toBe("付けていない");
    // CI の完了後に成功なら可
    gh.set(world(x.head, "success"));
    expect((await recheck(s, p))?.label?.operation).toBe("付けた");
    // 同じ head で PR の基点が変わった
    gh.set(world(x.head, "success", [{ headRefOid: x.head, baseRefName: "develop" }]));
    const moved = await recheck(s, p);
    expect(moved).toMatchObject({ n: 4, merge: MERGE_NG });
    expect(moved?.blockers.join("\n")).toContain("基点が変わった");
    expect(moved?.label?.operation).toBe("外した");
    gh.set(world(x.head, "success"));
    expect((await recheck(s, p))?.label?.operation).toBe("付けた");
    // result.json の head が target.md の head と違う（同じディレクトリの ci-checks.ts を差し替えた写しで起動する）
    const scripts = join(s.t, "scripts-other-head");
    mkdirSync(scripts, { recursive: true });
    for (const name of ["review.ts", "copy-evidence.ts"]) copyFileSync(join(SKILL_DIR, "scripts", name), join(scripts, name));
    writeFileSync(
      join(scripts, "ci-checks.ts"),
      [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        "const a = process.argv.slice(2);",
        'const arg = (k) => a[a.indexOf(`--${k}`) + 1];',
        `const result = { ok: true, verdict: "成功", repository: "acme/app", base: arg("base"), head: "${OTHER}", observedAt: new Date().toISOString(), sources: {}, required: [{ context: "test", appId: null, sources: ["workspace-rules"], result: "成功", runs: [] }], reason: "成功", files: {} };`,
        'mkdirSync(arg("out"), { recursive: true });',
        'writeFileSync(arg("out") + "/result.json", JSON.stringify(result) + "\\n");',
        "process.stdout.write(JSON.stringify(result) + \"\\n\");",
        "",
      ].join("\n"),
    );
    const otherHead = (await runReviewScript<Recheck>(join(scripts, "review.ts"), "recheck-ci", ["--work", p.W], s)).json;
    expect(otherHead).toMatchObject({ n: 6, checked: true, merge: MERGE_NG });
    expect(otherHead?.ci).toMatchObject({ verdict: "成功", resultHead: OTHER });
    expect(otherHead?.blockers.join("\n")).toContain(`result.json の head ${OTHER} は target.md の head と不一致`);
    expect(otherHead?.label?.operation).toBe("外した");
  });

  test("13節: CI の失敗・必須のチェックの結果なし・付ける直前の head の変化・追加コミットでは付けず、追加コミットなら照合せずに外して記録する", async () => {
    const s = sandbox();
    const { x, p, gh } = await cleanIssueReview(s, "ci2", () => [usedRow("限定 clone", "成果物の不変版の存在")]);
    gh.set(world(x.head, "failure"));
    const f = (await finalize(s, p)).json as Finalize;
    expect(f).toMatchObject({ status: "完了", score: 5, merge: MERGE_NG, saved: true });
    expect(f.ci.verdict).toBe("失敗");
    expect(f.label.operation).toBe("付けていない");
    // 必須のチェックの結果が無い（CI の不足）
    gh.set(world(x.head, "none"));
    const none = await recheck(s, p);
    expect(none?.ci?.verdict).toBe("結果なし");
    expect(none?.merge).toBe(MERGE_NG);
    // マージ可否は可でも、付ける直前に取り直した head が違えば付けない
    gh.set(world(x.head, "success", [{ headRefOid: x.head, baseRefName: "main" }, { headRefOid: OTHER, baseRefName: "main" }]));
    const late = await recheck(s, p);
    expect(late).toMatchObject({ checked: true, merge: MERGE_NG });
    expect(late?.blockers.join("\n")).toContain("追加コミット");
    expect(late?.label?.operation).toBe("付けていない");
    expect(read(join(p.W, "parent/head-check.md"))).toContain(OTHER);
    // 追加コミット: 照合せず（ci/<n> を作らない）、付いていれば外す
    gh.set(world(x.head, "success"));
    expect((await recheck(s, p))?.label?.operation).toBe("付けた");
    gh.set(world(x.head, "success", [{ headRefOid: OTHER, baseRefName: "main" }]));
    const stale = await recheck(s, p);
    expect(stale).toMatchObject({ checked: false, merge: MERGE_NG, ci: null });
    expect(stale?.reason).toContain("判定が古い");
    expect(stale?.label?.operation).toBe("外した");
    expect(existsSync(join(p.W, `parent/ci/${stale?.n}`))).toBe(false);
    expect(read(stale?.record ?? "")).toContain("判定が古い");
    expect((await issueShow(x)).labels).not.toContain("merge-ready");
    expect(gh.calls().some((c) => c[0] === "api" && c.some((a) => a.includes("-X") || a === "--method"))).toBe(false);
  });

  test("評価用の事例: 必要な担当の欠落は未完了・点数なし。確かめられず・未確認・矛盾・要求の変化は完了・点数のまま確認が残る事項にし、nod へ保存せずラベルも扱わない", async () => {
    const s = sandbox();
    const nodCalls = forbiddenNod(s);
    // 受け入れ確認担当の行があるのに受け入れ確認を起動していない
    const a = await prepareCaseWork(s, "case-missing");
    const verdictA = refuteVerdict(a);
    await reachRefute(s, a, verdictA);
    await must(s, a, "check-refute");
    const fa = (await finalize(s, a, ["--auto-check-rows", "block"])).json as Finalize;
    expect(fa).toMatchObject({ status: "未完了", score: "点数なし", scoreValue: null, merge: MERGE_NG, documents: null });
    expect(fa.reason).toContain("有効な結果なし（受け入れ確認。起動していない）");
    expect(fa.ci).toMatchObject({ ran: false, verdict: "照合せず（評価用の事例）", record: "parent/ci/1/not-run.md" });
    expect(fa.head).toBeNull();
    expect(fa.label.operation).toBe("扱わない（評価用の事例）");
    const reportA = read(join(a.W, "parent/report.md"));
    expect(reportA).toContain("- 最終状態: 未完了（理由: ");
    expect(reportA).toContain("- 確定した要対応の点数: 点数なし");
    const auditA = read(join(a.W, "parent/audit.md"));
    expect(auditA.split("<!-- refute-verdict:begin -->\n")[1]?.split("<!-- refute-verdict:end -->")[0]).toBe(verdictA);
    expect(auditA).toContain("<!-- acceptance-result:begin -->\n未受領（");

    // 確かめられず（反証の未確認の候補 SPC-1 を含む）・反証の未確認・反証の判定と矛盾する証拠・事例の要求の変化
    const b = await prepareCaseWork(s, "case-gaps");
    await reachAcceptance(s, b, refuteVerdict(b), null);
    const result = acceptanceResult(b, {
      verdict: "確かめられず",
      parts: { 成果物の不変版の存在: "確かめられず: 記録の写しが無い" },
      used: [usedRow("限定 clone", "作業・手順の実施")],
      conflicts: ["| `requirements/issue.md:L4`（反証の充足） | 限定 clone の `src/a.ts` | 反証の充足と食い違う |"],
    });
    expect(await deliverAcceptance(s, b, result)).toMatchObject({ valid: true, conflicts: 1 });
    put(join(s.t, "dataset/inputs/case-gaps/requirements/issue.md"), "# 変えた要求\n");
    const fb = (await finalize(s, b, ["--auto-check-rows", "block"])).json as Finalize;
    expect(fb).toMatchObject({ status: "完了", reason: null, score: 2, merge: MERGE_NG, documents: null });
    expect(fb.remaining.map((r) => [r.ref, r.owner])).toEqual([
      ["requirements/issue.md:L2", "人"],
      [ROW, "受け入れ確認担当"],
      ["requirements/issue.md:L4（反証の充足）", "人"],
      ["requirements/issue.md", "人"],
    ]);
    expect(fb.remaining[1]?.reason).toContain("確かめられず");
    expect(fb.remaining[1]?.reason).toContain("SPC-1");
    expect(fb.remaining[2]?.reason).toContain("矛盾");
    expect(fb.remaining[3]?.reason).toContain("保存時の要求の変化");
    const reportB = read(join(b.W, "parent/report.md"));
    expect(reportB).toContain("| CAUSE-1（STD-1・REF-1） | High（高）、影響度 2 | 集計が誤る | 集計が誤る | src/a.ts@HEAD:L1 |");
    expect(reportB).toContain("- 確認が残る事項: 4 件");
    expect(reportB).toContain(`監査記録 ${join(b.W, "parent/audit.md")}`);
    expect(read(join(b.W, "parent/audit.md")).split("<!-- acceptance-result:begin -->\n")[1]?.split("<!-- acceptance-result:end -->")[0]).toBe(result);
    expect(nodCalls()).toBe("");
  });

  test("評価用の事例: CI を除いたレビュー側の判定を --auto-check-rows の扱いで別に算出し、通常のマージ可否と CI の規則は変えない。評価では引数が必須", async () => {
    const s = sandbox();
    const nodCalls = forbiddenNod(s);
    // 要対応0件・受け入れ確認担当の行を確認済みにし、L4 を「自動チェック担当」の行にした反証の判定本文
    const AUTO = "| `requirements/issue.md:L4` | 自動チェック担当 | テストで確かめる | なし |";
    const reach = async (name: string) => {
      const p = await prepareCaseWork(s, name);
      const verdict = refuteVerdict(p, { clean: true }).replace("| `requirements/issue.md:L4` | 充足 | `src/a.ts@HEAD:L1` | なし |", AUTO);
      expect(verdict).toContain(AUTO);
      await reachAcceptance(s, p, verdict, null);
      expect(await deliverAcceptance(s, p, acceptanceResult(p))).toMatchObject({ valid: true });
      return p;
    };
    const a = await reach("case-pass");
    // 評価用の事例では自動チェック担当の行の扱いを明示しないと実行しない（引数の誤り。記録も残さない）
    expect((await finalize(s, a)).exitCode).toBe(2);
    expect((await finalize(s, a, ["--auto-check-rows", "maybe"])).exitCode).toBe(2);
    expect(existsSync(join(a.W, "parent/finalize.json"))).toBe(false);
    const fa = (await finalize(s, a, ["--auto-check-rows", "pass"])).json as Finalize;
    expect(fa).toMatchObject({ status: "完了", scoreValue: 5, remainingCount: 0, merge: MERGE_NG, reportedMerge: MERGE_NG });
    expect(fa.blockers.join("／")).toContain("照合せず（評価用の事例）");
    expect(fa.reviewSideMerge).toEqual({ autoCheckRows: "pass", merge: "CI を除いてマージ可", blockers: [] });
    expect(read(join(a.W, "parent/audit.md"))).toContain("- CI を除いたレビュー側の判定（評価用）: CI を除いてマージ可");

    const b = await reach("case-block");
    const fb = (await finalize(s, b, ["--auto-check-rows", "block"])).json as Finalize;
    expect(fb).toMatchObject({ status: "完了", scoreValue: 5, remainingCount: 0, merge: MERGE_NG });
    expect(fb.reviewSideMerge?.autoCheckRows).toBe("block");
    expect(fb.reviewSideMerge?.merge).toBe("CI を除いてマージ不可");
    expect(fb.reviewSideMerge?.blockers.join("／")).toContain("requirements/issue.md:L4（自動チェック担当");
    expect(nodCalls()).toBe("");
  });

  test("受け入れ確認の結果の構造不備を無効にし、有効な矛盾の報告とは区別する。有効な未充足は完了・点数のまま不可にする", async () => {
    const s = sandbox();
    const p = await prepareCaseWork(s, "case-format");
    await reachAcceptance(s, p, refuteVerdict(p), null);
    const used = [usedRow("限定 clone")];
    const unmet = { 成果物の不変版の存在: "未充足: 記録が無い" };
    const valid = acceptanceResult(p, { used });
    const cases: [string, string, number, string][] = [
      ["担当行の欠落", acceptanceResult(p, { used, rows: false }), 3, ROW],
      ["役割の違い", acceptanceResult(p, { used, role: "反証" }), 2, "役割"],
      ["判定の語彙", acceptanceResult(p, { used, verdict: "一部確認" }), 4, "一部確認"],
      ["5つの部分と行の判定の不一致", acceptanceResult(p, { used, parts: { 現在の配置: "未充足: 置かれていない" } }), 4, "行の判定の不一致"],
      ["不足理由の欠落", acceptanceResult(p, { used, verdict: "確かめられず", parts: { 成果物の不変版の存在: "確かめられず: 写しが無い" }, shortfall: "なし", gaps: [`| ${ACCEPTANCE_ROW} | 確かめられず | 成果物の不変版の存在 | 写しが無い |`] }), 4, "不足理由"],
      ["未充足・確かめられずの表との判定の不一致", acceptanceResult(p, { used, verdict: "未充足", parts: unmet, gaps: [`| ${ACCEPTANCE_ROW} | 確かめられず | 成果物の不変版の存在 | 記録が無い |`] }), 4, "同一行の判定の不一致"],
      ["未充足の行が表に無い", acceptanceResult(p, { used, verdict: "未充足", parts: unmet, gaps: [] }), 4, "表に無い"],
      ["目録に無い証拠", acceptanceResult(p, { used: [usedRow("evidence/9")] }), 5, "evidence/9"],
      ["使った行の欠落", acceptanceResult(p, { used: ["| `限定 clone` | 固定版 | 別の行 | 作業・手順の実施 |"] }), 5, "使った行"],
      ["矛盾が自由記述", valid.replace("## 反証の判定と矛盾する証拠\n\nなし", "## 反証の判定と矛盾する証拠\n\nL4 の判定と食い違う証拠がある"), 5, "反証の判定と矛盾する証拠"],
    ];
    await must(s, p, "agent", ["--role", "acceptance", "--event", "start"]);
    for (const [name, text, no, needle] of cases) {
      expect(text).not.toBe(valid);
      put(join(p.W, "acceptance/result.md"), text);
      const r = await checkAcceptance(s, p);
      expect(`${name}: ${r?.valid}`).toBe(`${name}: false`);
      expect(`${name}: ${messages(r, no)}`).toContain(needle);
    }
    expect(existsSync(join(p.W, "parent/acceptance-structure.json"))).toBe(false);

    // 反証の判定と矛盾する証拠の報告は有効な結果（形式違反にしない）
    put(join(p.W, "acceptance/result.md"), acceptanceResult(p, { used, conflicts: ["| `requirements/issue.md:L4` | 限定 clone の `src/a.ts` | 反証の充足と食い違う |"] }));
    expect(await checkAcceptance(s, p)).toMatchObject({ valid: true, conflicts: 1 });
    // 受け入れ確認への入力が変わっていれば無効（同一性）
    const records = join(p.W, "acceptance-input/records.md");
    const original = read(records);
    put(records, `${original}書き換えた\n`);
    const changed = await checkAcceptance(s, p);
    expect(changed?.valid).toBe(false);
    expect(messages(changed, 6)).toContain("records.md");
    put(records, original);

    // 有効な未充足: 完了・反証の点数（2）のまま、その行を確認が残る事項にしてマージ不可
    put(join(p.W, "acceptance/result.md"), acceptanceResult(p, { used, verdict: "未充足", parts: unmet }));
    await must(s, p, "agent", ["--role", "acceptance", "--event", "received", "--agent-id", "agent-acceptance"]);
    expect(await checkAcceptance(s, p)).toMatchObject({ valid: true });
    const f = (await finalize(s, p, ["--auto-check-rows", "block"])).json as Finalize;
    expect(f).toMatchObject({ status: "完了", score: 2, merge: MERGE_NG });
    const row = f.remaining.find((r) => r.ref === ROW);
    expect(row).toMatchObject({ owner: "受け入れ確認担当" });
    expect(row?.reason).toContain("未充足");
  });

  test("保存直前の再照合: 証拠の変化・解決の状態・Document の訂正・親以外の追記（返信と確認依頼）・要求の変化を確認が残る事項にし、own-logs の親自身の記録とイベントは止めない。収録原文の指紋の不一致は保存失敗にする", async () => {
    const s = sandbox();
    failingGh(s);
    const x = await issueRepo(s);
    const logFile = join(s.t, "evidence/run.log");
    put(logFile, "失敗を記録した\n");
    const doc = (await x.nod.run(["--json", "doc", "create", "memo.md", "--title", "メモ", "--kind", "doc", "--issue", x.issue, "--body", "作業のメモ"], x.repo)).json as { id: number; path: string };
    const c1 = await comment(x, `作業の記録: ${logFile}`);
    const p = await prepareIssue(s, x, "changes", false);
    const verdict = refuteVerdict(p, { clean: true });
    await reachAcceptance(s, p, verdict, [{ type: "file", source: logFile, kind: "参照された記録", from: `activity:${c1}`, at: `records/activity.json の activity:${c1}`, quote: logFile }]);
    const result = acceptanceResult(p, { used: [usedRow("evidence/1", "成果物の不変版の存在"), usedRow(`activity:${c1}`), usedRow(`document:${doc.id}`)] });
    expect(await deliverAcceptance(s, p, result)).toMatchObject({ valid: true });

    // 受け入れ確認の後・保存の前の変化
    put(logFile, "書き換えた記録\n");
    expect((await x.nod.run(["issue", "resolve", x.issue, String(c1)], x.repo)).exitCode).toBe(0);
    put(doc.path, `${read(doc.path)}追記した\n`);
    const own = await comment(x, "親が書いた途中経過");
    const reply = await comment(x, "別の人の返信", c1);
    expect((await x.nod.run(["issue", "ask", x.issue, "確認してください"], x.repo)).exitCode).toBe(0);
    expect((await x.nod.run(["issue", "update", x.issue, "--add-label", "other"], x.repo)).exitCode).toBe(0);
    expect((await x.nod.run(["issue", "update", x.issue, "-d", "変えた要求"], x.repo)).exitCode).toBe(0);
    // 検査の後に判定本文が書き換わった（監査の印の間の指紋が検査した原本と違う）
    put(join(p.W, "refute/verdict.md"), `${verdict}書き換えた\n`);

    const f = (await finalize(s, p, ["--own-log", String(own)])).json as Finalize;
    expect(f).toMatchObject({ status: "完了", reason: null, score: 5, merge: MERGE_NG, saved: false });
    expect(f.saveProblems.join("\n")).toContain("refute-verdict");
    expect(f.documents?.audit.id).toBeNumber();
    expect(f.documents?.report.id).toBeNumber();
    const reasons = f.remaining.map((r) => `${r.ref} ${r.owner} ${r.reason}`).join("\n");
    for (const word of ["参照された記録（配置先・成果物を含む）の変化", "対応不明", `証拠の訂正（document:${doc.id}`, `activity:${reply}`, "確認依頼", "保存時の要求の変化"]) expect(reasons).toContain(word);
    expect(reasons).not.toContain(`activity:${own}`);
    expect(f.remaining.filter((r) => r.reason.includes("親以外の追記")).every((r) => r.ref === ROW && r.owner === RECHECK_OWNER)).toBe(true);
    expect(f.recheck.evidence).toMatchObject({ others: 2, own: 1 });
    expect(f.recheck.evidence?.events).toBeGreaterThan(0);
    // ref なしの head は取り直せない。CI を読めなければ決められない。どちらも不可
    expect(f.head?.problem).toContain("ref なし");
    expect(f.ci.verdict).toBe("必須のチェックを決められず");
    expect(f.label.operation).toBe("付けていない");
    const audit = await docShow(x, f.documents?.audit.id as number);
    expect(audit.content).toContain("止めなかった親自身の記録 1 件");
    expect(existsSync(join(p.W, "parent/acceptance-recheck/evidence/1/copy"))).toBe(true);
    expect(read(join(p.W, "parent/acceptance/own-logs.md"))).toContain(`- ${own}: `);
  });

  test("Issue なしの mode: local: 未コミット変更の土台 HEAD・差分の変化を確認が残る事項にし、CI は対象外（未コミット）、報告と監査は手元に残してラベルを扱わない", async () => {
    const s = sandbox();
    const nod = tempNod(s);
    const repo = makeGitRepo(s, "local");
    registerRepo(nod.db, repo, "LOC");
    expect((await nod.run(["workspace", "rules", "set", "--text", RULES], repo)).exitCode).toBe(0);
    const base = gitOut(repo, "rev-parse", "HEAD");
    put(join(repo, "README.md"), "# app\n\n未コミットの変更\n");
    const W = join(s.t, "work", "local");
    const prepared = await runReview<{ ready: boolean; inputs: { path: string; sha256: string }[] }>("prepare", ["--work", W, "--repo", repo, "--mode", "local", "--base", base], s);
    expect(prepared.json?.ready).toBe(true);
    const p: PreparedWork = { W, repo, base, head: base, clone: join(W, "repo") };
    const diff = prepared.json?.inputs.find((i) => i.path === "local/changes.diff")?.sha256 ?? "";
    const local = (text: string) => text.replace(`head \`${p.head}\``, `head \`${p.head}\`／local/changes.diff ${diff}`);
    for (const role of ["standards", "spec"] as const) {
      await must(s, p, "agent", ["--role", role, "--event", "start"]);
      put(join(W, role, "handoff.md"), local(exploreHandoff(role, p)));
      await must(s, p, "agent", ["--role", role, "--event", "received", "--agent-id", `agent-${role}`]);
      await must(s, p, "check-explore", ["--role", role]);
    }
    await must(s, p, "refute-input");
    await must(s, p, "agent", ["--role", "refute", "--event", "start"]);
    put(join(W, "refute/verdict.md"), local(refuteVerdict(p, { acceptance: false })));
    await must(s, p, "agent", ["--role", "refute", "--event", "received", "--agent-id", "agent-refute"]);
    await must(s, p, "check-refute");
    // 反証の後に未コミット変更が変わった
    put(join(repo, "README.md"), "# app\n\n別の変更\n");

    const f = (await finalize(s, p)).json as Finalize;
    expect(f).toMatchObject({ status: "完了", score: 2, merge: MERGE_NG, documents: null, head: null });
    expect(f.ci).toMatchObject({ ran: false, verdict: "対象外（未コミット）" });
    expect(f.label.operation).toBe("扱わない（Issue なし）");
    expect(f.remaining.find((r) => r.ref === "local/changes.diff")).toMatchObject({ owner: "人" });
    expect(f.remaining.find((r) => r.ref === "local/changes.diff")?.reason).toContain("未コミット変更の土台 HEAD・差分の変化");
    expect(read(join(W, "parent/report.md"))).toContain(`監査記録 ${join(W, "parent/audit.md")}`);
    expect(read(join(W, "parent/audit.md"))).toContain("受け入れ確認担当の行なし（起動せず）");
    expect((await runReview("recheck-ci", ["--work", W, "--own-log", "1"], s)).exitCode).toBe(2);
  });
});
