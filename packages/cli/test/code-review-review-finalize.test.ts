import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
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
  sha256,
  type TempNod,
  tempNod,
} from "./code-review-review-helpers";

const read = (path: string) => readFileSync(path, "utf8");
const MERGE_OK = "可（人のレビューなしでマージ可）";
const MERGE_NG = "不可（人の判断が要る）";
// 利用者向けの結果に載せる範囲の注記（固定の1文）
const SCOPE = "このレビューはコードレベルの確認であり、ブラウザ検証・見た目やデザイン・実環境での動作・作業手順は確かめておらず、別のフローで扱う。";
const PR = "https://github.com/acme/app/pull/1";
const OTHER = "0123456789abcdef0123456789abcdef01234567";
// Workspace の規約。「必須のチェック」の節の test だけが必須のチェック
const RULES = "# 規約\n\n- 日本語で書く\n\n## 必須のチェック\n\n- test\n";
// nod の作業ログの上限（packages/core/src/work-log.ts の WORK_LOG_MAX_LENGTH。コードポイントで数える）
const LOG_MAX = 4000;
const codePoints = (text: string) => [...text].length;

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
  required: { context: string; result: string }[];
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
  logs: { summary: number | null; ci: number | null };
  label: { operation: string; error: string | null };
  logProblem: string | null;
  reportStartedAt: string;
  savedAt: string;
  reviewSideMerge: { merge: string; blockers: string[] } | null;
}
interface Recheck {
  n: number;
  checked: boolean;
  reason: string | null;
  merge: string;
  blockers: string[];
  ci: Ci | null;
  added: Remaining[];
  label: { operation: string; error: string | null; log: number | null } | null;
  record: string;
}
interface Activity {
  kind: string;
  id?: number;
  body?: string;
  logKind?: string | null;
}

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

const finalize = async (s: Sandbox, p: PreparedWork, args: string[] = []) => runReview<Finalize>("finalize", ["--work", p.W, ...args], s);
const recheck = async (s: Sandbox, p: PreparedWork, args: string[] = []) => (await runReview<Recheck>("recheck-ci", ["--work", p.W, ...args], s)).json;
const today = () => new Date().toISOString().slice(0, 10).replaceAll("-", "");
// 印の間（ci-result など）を除いた本文
const outsideCi = (text: string) => text.replace(/<!-- ci-result:begin -->[\s\S]*?<!-- ci-result:end -->/g, "");
// 反証の判定本文の印の間（監査に原文のまま収める）
const embeddedVerdict = (text: string) => text.split("<!-- refute-verdict:begin -->\n")[1]?.split("<!-- refute-verdict:end -->")[0];

// 完了・点数5（要対応0件）・確認が残る事項0件の Issue と PR のレビュー（3担当だけ）。CI は success。specs は要求資料に足す kind=spec の Document の数
async function cleanIssueReview(s: Sandbox, name: string, specs = 0): Promise<{ x: IssueRepo; p: PreparedWork; gh: FakeGh; verdict: string; specDocs: { id: number; path: string }[] }> {
  const gh = fakeGh(s);
  const x = await issueRepo(s);
  const specDocs: { id: number; path: string }[] = [];
  for (let i = 1; i <= specs; i++) {
    specDocs.push((await x.nod.run(["--json", "doc", "create", `spec-${i}.md`, "--title", `仕様 ${i}`, "--kind", "spec", "--issue", x.issue, "--body", `- 背景 ${i}`], x.repo)).json as { id: number; path: string });
  }
  const files = specs > 0 ? ["| `requirements/issue.md` | あり |", "| `requirements/workspace-rules.md` | なし |", ...specDocs.map((d) => `| \`requirements/spec-${d.id}.md\` | なし |`)] : undefined;
  gh.set(world(x.head, "success"));
  const p = await prepareIssue(s, x, name, true);
  const verdict = refuteVerdict(p, { clean: true, files });
  await reachRefute(s, p, verdict, { files });
  await must(s, p, "check-refute");
  return { x, p, gh, verdict, specDocs };
}

describe("code-review の仕上げ（review.ts finalize・recheck-ci）", () => {
  test("正常保存: 完了・点数5・CI 成功・確認が残る事項0で可にし、監査→結果の順に2つの Document を保存して照合し、作業ログ・merge-ready・[ci-result] を残す。own-logs や受け入れ確認のファイルなしで CI の再照合まで成り立つ", async () => {
    const s = sandbox();
    const { x, p, verdict } = await cleanIssueReview(s, "ok");

    const r = await finalize(s, p);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const f = r.json as Finalize;
    expect(f).toMatchObject({ status: "完了", reason: null, score: 5, scoreValue: 5, remainingCount: 0, merge: MERGE_OK, reportedMerge: MERGE_OK, blockers: [], saved: true, saveProblems: [], reviewSideMerge: null });
    expect(f.ci).toMatchObject({ ran: true, verdict: "成功", base: "main", resultHead: x.head, record: "parent/ci/1/result.json" });
    expect(f.head).toMatchObject({ currentHead: x.head, headOk: true, baseOk: true, problem: null });
    expect(f.label).toEqual({ operation: "付けた", error: null });
    expect(Object.keys(f.logs).sort()).toEqual(["ci", "summary"]);
    expect(f.reportStartedAt <= f.savedAt).toBe(true);
    expect(JSON.parse(read(join(p.W, "parent/finalize.json")))).toEqual(JSON.parse(JSON.stringify({ ok: true, subcommand: "finalize", ...f })));

    // 2つの Document: kind=doc で Issue にリンクし、タイトル見出しを除いた本文が原稿と同じ。監査の印の間は反証の判定本文の原文のまま
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
    expect(embeddedVerdict(audit.content)).toBe(verdict);
    expect(audit.content).not.toContain("受け入れ確認");
    expect(audit.content).toContain(`- runId: ok`);
    expect(audit.content).toContain(`- 作業ディレクトリ: ${p.W}`);
    // 結果は短い結論と、範囲の固定の注記1文と、監査への参照。原文・全対応表は載せず、CI・E2E・QA で担保したとは書かず、CI の結果は印の中だけ
    expect(report.content).toContain(`監査 Document ${auditId}`);
    expect(report.content).toContain("- 最終状態: 完了");
    expect(report.content).toContain("- 確定した要対応の点数: 5");
    expect(report.content.split(SCOPE)).toHaveLength(2);
    expect(report.content).not.toMatch(/E2E|QA/);
    expect(report.content).toContain(`<!-- ci-result:begin -->\n- マージ可否: ${MERGE_OK}`);
    expect(report.content).not.toContain("## 採否一覧");
    expect(outsideCi(report.content)).not.toContain("CI 判定");
    expect(outsideCi(audit.content)).not.toContain("CI 判定");

    // 作業ログ（完了は progress。CI の結果は書かない）と [ci-result] の test。親自身の記録の id の一覧（own-logs）も受け入れ確認の写しも作らない
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
    for (const gone of ["parent/acceptance", "acceptance-input", "acceptance", "parent/acceptance-recheck"]) expect(`${gone}: ${existsSync(join(p.W, gone))}`).toBe(`${gone}: false`);
    expect(read(join(p.W, "parent/head-check.md"))).toContain("merge-ready を付ける直前");

    // 保存し直さない。廃止した --own-log は受け付けない
    expect((await finalize(s, p)).exitCode).toBe(2);
    expect((await runReview("recheck-ci", ["--work", p.W, "--own-log", "1"], s)).exitCode).toBe(2);

    // 13節: 同じ head の CI を照合し直す（変化なしなら可のまま）
    const again = await recheck(s, p);
    expect(again).toMatchObject({ n: 2, checked: true, merge: MERGE_OK, blockers: [], added: [] });
    expect(again?.label?.operation).toBe("付けた");
    expect(existsSync(join(p.W, "parent/ci/2/result.json"))).toBe(true);
    expect(read(join(p.W, "parent/recheck-2/record.md"))).toContain(`マージ可否: ${MERGE_OK}`);

    // 保存の後に誰かが Issue へ書いた記録（コメント・返信）だけでは止めない（受け入れ証拠の再照合は無い）
    const c = await comment(x, "PR を作った");
    await comment(x, "補足の返信", c);
    expect(await recheck(s, p)).toMatchObject({ n: 3, checked: true, merge: MERGE_OK, added: [] });

    // 保存の後に要求資料が変わった: 照合し直しても可にせず、merge-ready を外す
    expect((await x.nod.run(["issue", "update", x.issue, "-d", "変えた要求"], x.repo)).exitCode).toBe(0);
    const changed = await recheck(s, p);
    expect(changed).toMatchObject({ n: 4, checked: true, merge: MERGE_NG });
    expect(changed?.added.map((a) => [a.ref, a.owner])).toEqual([["requirements/issue.md", "人"]]);
    expect(changed?.added[0]?.reason).toContain("保存時の要求の変化");
    expect(changed?.label?.operation).toBe("外した");
    expect((await issueShow(x)).labels).not.toContain("merge-ready");
    expect(read(join(p.W, "parent/recheck-4/record.md"))).toContain("保存時の要求の変化");
  });

  test("13節で CI の未確定・成功・PR の基点の変化・result.json の head の不一致を照合し直す", async () => {
    const s = sandbox();
    const { x, p, gh } = await cleanIssueReview(s, "ci");

    expect((await finalize(s, p)).json).toMatchObject({ saved: true, merge: MERGE_OK });
    // CI の未確定は不可（polling しない）
    gh.set(world(x.head, "in_progress"));
    const pending = await recheck(s, p);
    expect(pending).toMatchObject({ n: 2, checked: true, merge: MERGE_NG });
    expect(pending?.ci?.verdict).toBe("未確定");
    expect(pending?.label?.operation).toBe("外した");
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
    copyFileSync(join(SKILL_DIR, "scripts/review.ts"), join(scripts, "review.ts"));
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

  test.each(["finalize", "recheck-ci"] as const)("%s: 新しく紐付いたspecの本文を取得できなくても要求集合の変化を確認残にする", async (stage) => {
    const s = sandbox();
    const { x, p } = await cleanIssueReview(s, "new-spec");
    if (stage === "recheck-ci") expect((await finalize(s, p)).json?.saved).toBe(true);
    const added = (await x.nod.run(["--json", "doc", "create", "new-spec.md", "--title", "追加仕様", "--kind", "spec", "--issue", x.issue, "--body", "- a は 2 を返す"], x.repo)).json as { id: number };
    const wrapper = join(s.t, "nod-spec-unavailable");
    put(wrapper, `#!/bin/sh\nif [ "$*" = "--json doc show ${added.id}" ]; then echo '取得できない' >&2; exit 1; fi\nexec "${x.nod.env.NOD_CLI}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    s.env.NOD_CLI = wrapper;
    const r = stage === "finalize" ? (await finalize(s, p)).json : await recheck(s, p);
    const remaining = r && ("remaining" in r ? r.remaining : r.added);
    expect(r?.merge).toBe(MERGE_NG);
    expect(remaining?.some((v) => v.ref === "requirements/kind=spec" && v.reason.includes("要求の変化"))).toBe(true);
    expect((await issueShow(x)).labels).not.toContain("merge-ready");
  });

  test.each(["report", "audit"] as const)("保存失敗した %s があれば、CI成功でも再照合でmerge-readyを付けない", async (kind) => {
    const s = sandbox();
    const { x, p } = await cleanIssueReview(s, "savefail");
    const suffix = kind === "audit" ? "-audit" : "";
    put(join(x.nod.docs, `${x.issue.toLowerCase()}-code-review${suffix}-${today()}-savefail.md`), "既にある\n");
    expect((await finalize(s, p)).json).toMatchObject({ saved: false, merge: MERGE_NG });
    const r = await recheck(s, p);
    expect(r).toMatchObject({ checked: false, merge: MERGE_NG, ci: null });
    expect(r?.blockers.join("\n")).toContain("保存");
    expect((await issueShow(x)).labels).not.toContain("merge-ready");
  });

  test.each(["report", "audit"] as const)("保存後の %s 本文やIssueリンクの変化をCI再照合で拒否し、復元されれば同じ原本を再利用できる", async (kind) => {
    const s = sandbox();
    const { x, p } = await cleanIssueReview(s, "saved-changed");
    const f = (await finalize(s, p)).json as Finalize;
    const doc = f.documents?.[kind] as SavedDoc;
    const original = read(doc.path as string);
    // runId/headと反証の印を残す追記でも、全本文の不一致を検出する
    put(doc.path as string, `${original}\n別の本文\n`);
    const changed = await recheck(s, p);
    expect(changed).toMatchObject({ checked: false, merge: MERGE_NG, ci: null });
    expect(changed?.blockers.join("\n")).toContain("指紋");
    expect((await issueShow(x)).labels).not.toContain("merge-ready");
    put(doc.path as string, original);
    expect(await recheck(s, p)).toMatchObject({ checked: true, merge: MERGE_OK });
    expect((await x.nod.run(["doc", "unlink", String(doc.id), "--issue", x.issue], x.repo)).exitCode).toBe(0);
    expect(await recheck(s, p)).toMatchObject({ checked: false, merge: MERGE_NG });
    expect((await issueShow(x)).labels).not.toContain("merge-ready");
  });

  test("13節: CI の失敗・必須のチェックの結果なし・付ける直前の head の変化・追加コミットでは付けず、追加コミットなら照合せずに外して記録する", async () => {
    const s = sandbox();
    const { x, p, gh } = await cleanIssueReview(s, "ci2");
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

  test("保存直前の再照合: 要求資料の変化を確認が残る事項にして不可にし、必須の CI の規約は取り直した Workspace の規約から読む。収録原文の指紋の不一致と、取り直せない head では merge-ready を付けない", async () => {
    const s = sandbox();
    const gh = fakeGh(s);
    const x = await issueRepo(s);
    gh.set(world(x.head, "success"));
    // PR でなく SHA だけで固定した head（ref なし。現在の head を取り直せない）
    const p = await prepareIssue(s, x, "changes", false);
    const verdict = refuteVerdict(p, { clean: true });
    await reachRefute(s, p, verdict);
    await must(s, p, "check-refute");
    // 反証の後・保存の前に、Workspace の規約の必須のチェックを test から lint に変えた
    expect((await x.nod.run(["workspace", "rules", "set", "--text", RULES.replace("- test", "- lint")], x.repo)).exitCode).toBe(0);
    // 検査の後に判定本文が書き換わった（監査の印の間の指紋が検査した原本と違う）
    put(join(p.W, "refute/verdict.md"), `${verdict}書き換えた\n`);

    const f = (await finalize(s, p)).json as Finalize;
    expect(f).toMatchObject({ status: "完了", reason: null, score: 5, merge: MERGE_NG, saved: false });
    expect(f.remaining.map((r) => [r.ref, r.owner])).toEqual([["requirements/workspace-rules.md", "人"]]);
    expect(f.remaining[0]?.reason).toContain("保存時の要求の変化");
    expect(f.saveProblems.join("\n")).toContain("refute-verdict");
    expect(f.documents?.audit.id).toBeNumber();
    expect(f.documents?.report.id).toBeNumber();
    // 必須のチェックは取り直した規約（parent/requirements-recheck/workspace-rules.md）の lint。その check run が無いので結果なし
    expect(f.ci.required.map((r) => r.context)).toEqual(["lint"]);
    expect(f.ci.verdict).toBe("結果なし");
    expect(read(join(p.W, "parent/requirements-recheck/workspace-rules.md"))).toContain("- lint");
    expect(f.head?.problem).toContain("ref なし");
    expect(f.blockers.join("\n")).toContain("確認が残る事項 1 件");
    expect(f.label.operation).toBe("付けていない");
    expect((await issueShow(x)).labels).not.toContain("merge-ready");
  });

  test("評価用の事例: 反証の有効な結果が無ければ未完了・点数なし。完了なら未確認と要求の変化を確認が残る事項にし、表から除いた行は監査の原文だけに残して結果へ転載しない。nod へ保存せずラベルも扱わない", async () => {
    const s = sandbox();
    const nodCalls = forbiddenNod(s);
    // 反証の試行を無効として隔離し、委譲し直していない
    const a = await prepareCaseWork(s, "case-missing");
    await reachRefute(s, a, refuteVerdict(a));
    await must(s, a, "retire-attempt", ["--role", "refute", "--failure", "invalid", "--reason", "7節の4: 形式違反"]);
    const fa = (await finalize(s, a)).json as Finalize;
    expect(fa).toMatchObject({ status: "未完了", score: "点数なし", scoreValue: null, merge: MERGE_NG, documents: null });
    expect(fa.reason).toContain("有効な結果なし（反証。");
    expect(fa.ci).toMatchObject({ ran: false, verdict: "照合せず（評価用の事例）", record: "parent/ci/1/not-run.md" });
    expect(fa.head).toBeNull();
    expect(fa.label.operation).toBe("扱わない（評価用の事例）");
    expect(fa.reviewSideMerge?.merge).toBe("CI を除いてマージ不可");
    expect(fa.reviewSideMerge?.blockers.join("／")).toContain("最終状態 未完了");
    const reportA = read(join(a.W, "parent/report.md"));
    expect(reportA).toContain("- 最終状態: 未完了（理由: ");
    expect(reportA).toContain("- 確定した要対応の点数: 点数なし");
    expect(read(join(a.W, "parent/audit.md"))).toContain("<!-- refute-verdict:begin -->\n未受領（");

    // 反証が Spec 探索の L3 を表から除き、L2 を未確認として足した。事例の要求も保存の前に変わった
    const b = await prepareCaseWork(s, "case-gaps");
    const verdictB = refuteVerdict(b, { removed: true });
    await reachRefute(s, b, verdictB);
    await must(s, b, "check-refute");
    put(join(s.t, "dataset/inputs/case-gaps/requirements/issue.md"), "# 変えた要求\n");
    const fb = (await finalize(s, b)).json as Finalize;
    expect(fb).toMatchObject({ status: "完了", reason: null, score: 2, merge: MERGE_NG, documents: null });
    expect(fb.remaining.map((r) => [r.ref, r.owner])).toEqual([
      ["requirements/issue.md:L2", "人"],
      ["requirements/issue.md", "人"],
    ]);
    expect(fb.remaining[0]?.reason).toContain("記録先の契約");
    expect(fb.remaining[1]?.reason).toContain("保存時の要求の変化");
    expect(fb.reviewSideMerge).toEqual({ merge: "CI を除いてマージ不可", blockers: ["確定した要対応の点数 2", "確認が残る事項 2 件"] });
    const reportB = read(join(b.W, "parent/report.md"));
    expect(reportB).toContain("| CAUSE-1（STD-1・REF-1） | High（高）、影響度 2 | 集計が誤る | 集計が誤る | src/a.ts@HEAD:L1 |");
    expect(reportB).toContain("- 確認が残る事項: 2 件");
    expect(reportB).toContain(`監査記録 ${join(b.W, "parent/audit.md")}`);
    expect(reportB).toContain(SCOPE);
    expect(reportB).not.toContain("表から除いた行");
    expect(reportB).not.toContain("背景の説明で、コードが満たす要求ではない");
    const auditB = read(join(b.W, "parent/audit.md"));
    expect(embeddedVerdict(auditB)).toBe(verdictB);
    expect(auditB.replace(verdictB, "")).not.toContain("表から除いた行");
    expect(nodCalls()).toBe("");
  });

  test("評価用の事例: CI を除いたレビュー側の判定は --auto-check-rows なしで、完了・確定した要対応0件・確認が残る事項0件だけから出す（コード要求0件の空の対応表でも同じ）。通常のマージ可否と CI の規則は変えない", async () => {
    const s = sandbox();
    const nodCalls = forbiddenNod(s);
    const a = await prepareCaseWork(s, "case-clean");
    await reachRefute(s, a, refuteVerdict(a, { clean: true }));
    await must(s, a, "check-refute");
    // 廃止した --auto-check-rows は受け付けない（引数の誤り。記録も残さない）
    expect((await finalize(s, a, ["--auto-check-rows", "pass"])).exitCode).toBe(2);
    expect(existsSync(join(a.W, "parent/finalize.json"))).toBe(false);
    const fa = (await finalize(s, a)).json as Finalize;
    expect(fa).toMatchObject({ status: "完了", scoreValue: 5, remainingCount: 0, merge: MERGE_NG, reportedMerge: MERGE_NG });
    expect(fa.blockers.join("／")).toContain("照合せず（評価用の事例）");
    expect(fa.reviewSideMerge).toEqual({ merge: "CI を除いてマージ可", blockers: [] });
    expect(read(join(a.W, "parent/audit.md"))).toContain("- CI を除いたレビュー側の判定（評価用）: CI を除いてマージ可");

    // コード要求0件: 両探索と反証の空の対応表でも完了・点数5・確認が残る事項0件
    const e = await prepareCaseWork(s, "case-empty");
    await reachRefute(s, e, refuteVerdict(e, { empty: true }), { empty: true });
    await must(s, e, "check-refute");
    const fe = (await finalize(s, e)).json as Finalize;
    expect(fe).toMatchObject({ status: "完了", scoreValue: 5, remainingCount: 0, merge: MERGE_NG });
    expect(fe.reviewSideMerge).toEqual({ merge: "CI を除いてマージ可", blockers: [] });
    expect(nodCalls()).toBe("");
  });

  test("作業ログの上限: 確認が残る事項が多く 4000 字を超える要約も、必須の項目を残して収まらない事項の件数と参照先を書き、実際の nod に保存する", async () => {
    const s = sandbox();
    const gh = fakeGh(s);
    const x = await issueRepo(s);
    gh.set(world(x.head, "success"));
    const p = await prepareIssue(s, x, "many", true);
    // 反証が要求資料の不足による未確認の行を 25 行足した（どれも確認が残る事項になる）
    const lines = Array.from({ length: 25 }, (_, i) => i + 10);
    const verdict = refuteVerdict(p, { clean: true })
      .replace("| `requirements/issue.md:L4` | 充足 | `src/a.ts@HEAD:L1` の `a | b` | なし |\n", (row) => `${row}${lines.map((n) => `| \`requirements/issue.md:L${n}\` | 未確認 | （追加）記録先の契約 ${n} が要求資料に無い | なし |\n`).join("")}`)
      .replace("## 未確認と理由\n\nなし\n", `## 未確認と理由\n\n| 要求の出典または候補ID | 軸 | 種別 | 理由 | 確かめる担当 | 不足箇所 |\n|---|---|---|---|---|---|\n${lines.map((n) => `| \`requirements/issue.md:L${n}\` | Spec | 要求 | 記録先を決める要求資料が無い。${"失敗を記録する経路の保存先とキーの形をコードから決められない。".repeat(3)} | 人 | 記録先の契約 ${n} |\n`).join("")}`)
      .replace("- Spec: 要対応 0 件、未確認 0 件", "- Spec: 要対応 0 件、未確認 25 件");
    await reachRefute(s, p, verdict);
    await must(s, p, "check-refute");

    const f = (await finalize(s, p)).json as Finalize;
    expect(f).toMatchObject({ status: "完了", score: 5, remainingCount: 25, merge: MERGE_NG, saved: true, logProblem: null });
    expect(f.logs.summary).toBeNumber();
    expect(f.logs.ci).toBeNumber();
    const reportId = f.documents?.report.id as number;
    const auditId = f.documents?.audit.id as number;
    const shown = await issueShow(x);
    const summary = shown.activity.find((a) => a.id === f.logs.summary);
    expect(summary?.logKind).toBe("progress");
    const body = summary?.body ?? "";
    expect(codePoints(body)).toBeLessThanOrEqual(LOG_MAX);
    // 必須の項目（状態・点数・要対応・確認が残る事項の件数・Document ID・runId・担当と ID）と、CI を書かず [ci-result] を参照する規則
    for (const part of ["独立コードレビュー完了。確定した要対応の点数 5。", "要対応: なし。", "確認が残る事項 25 件（", `結果Document ${reportId}、監査Document ${auditId}`, "runId many。", "担当: ", "agent-refute", "[ci-result] で始まる --kind test の作業ログを参照", "計測（保存までの確定値。"]) {
      expect(body).toContain(part);
    }
    expect(body).not.toContain("受け入れ確認");
    expect(body.startsWith("[ci-result]")).toBe(false);
    expect(body).not.toContain("成功");
    // 確認が残る事項は先頭から書き、書けなかった件数と全文の場所（結果と監査の Document）を明示する
    const first = f.remaining[0] as Remaining;
    expect(body).toContain(`${first.ref}（${first.owner}、${first.reason}）`);
    expect(body).not.toContain((f.remaining[24] as Remaining).reason);
    const rest = Number(new RegExp(`ほか (\\d+) 件は結果 Document ${reportId}（監査 ${auditId}）を参照`).exec(body)?.[1] ?? Number.NaN);
    expect(rest).toBeGreaterThan(0);
    const cut = body.includes(`…（途中で切った。全文は結果 Document ${reportId}（監査 ${auditId}）を参照）`) ? 1 : 0;
    const whole = (body.match(/不足箇所: 記録先の契約 \d+））/g) ?? []).length;
    expect(whole).toBeGreaterThan(0);
    expect(whole + cut + rest).toBe(25);

    // [ci-result] の記録も保存され、確認が残る事項の件数を不可の理由に書く
    const ciLog = shown.activity.find((a) => a.id === f.logs.ci);
    expect(ciLog?.logKind).toBe("test");
    expect(ciLog?.body?.startsWith("[ci-result] merge-ready: 付けていない（マージ可否が不可: ")).toBe(true);
    expect(ciLog?.body).toContain("確認が残る事項 25 件");
  });

  test("作業ログの上限: CI の再照合で加えた確認が残る事項（要求資料の変化）が多く 4000 字を超える [ci-result] の記録も、操作・head・基点・CI 判定・報告の Document ID・runId・記録の場所を残し、件数と全文の場所を書いて保存する", async () => {
    const s = sandbox();
    const { x, p, specDocs } = await cleanIssueReview(s, "many-ci", 25);
    const f = (await finalize(s, p)).json as Finalize;
    expect(f).toMatchObject({ status: "完了", remainingCount: 0 });
    expect(f.label.operation).toBe("付けた");
    // 保存の後に、要求資料の kind=spec の Document を 25 件とも書き換えた（CI の再照合で確認が残る事項に加わる）
    for (const d of specDocs) put(d.path, "変えた仕様\n");

    const r = await recheck(s, p);
    expect(r).toMatchObject({ n: 2, checked: true, merge: MERGE_NG });
    expect(r?.added).toHaveLength(25);
    expect(r?.label).toMatchObject({ operation: "外した", error: null });
    expect(r?.label?.log).toBeNumber();
    const log = (await issueShow(x)).activity.find((a) => a.id === r?.label?.log);
    expect(log?.logKind).toBe("test");
    const body = log?.body ?? "";
    expect(codePoints(body)).toBeLessThanOrEqual(LOG_MAX);
    expect(body.startsWith("[ci-result] merge-ready: 外した（マージ可否が不可: ")).toBe(true);
    const ciDir = join(p.W, "parent/ci/2");
    for (const part of [`判定した head SHA ${x.head}、現在の head ${x.head}（一致）`, "基点 main", "CI 判定 成功", "必須のチェック: test=成功", `報告Document ${f.documents?.report.id}`, "runId many-ci", "CI の再照合 2", "加えた確認が残る事項 25 件（", `CI の記録 ${ciDir}/（result.json の sha256 ${sha256(read(join(ciDir, "result.json")))}）`]) {
      expect(body).toContain(part);
    }
    // 加えた事項は先頭から書き、書けなかった件数と全文の場所（再照合の記録）を明示する
    const record = join(p.W, "parent/recheck-2/record.md");
    const more = `CI の再照合の記録（${record}）`;
    const first = r?.added[0] as Remaining;
    expect(body).toContain(`${first.ref}（${first.reason}）`);
    const rest = Number(/ほか (\d+) 件は(.+?)を参照/.exec(body.slice(body.indexOf("加えた確認が残る事項 25 件（")))?.[1] ?? Number.NaN);
    expect(body).toContain(`ほか ${rest} 件は${more}を参照`);
    expect(rest).toBeGreaterThan(0);
    const cut = body.includes(`…（途中で切った。全文は${more}を参照）`) ? 1 : 0;
    const whole = (body.match(/取り直し [0-9a-f]{64}））/g) ?? []).length;
    expect(whole).toBeGreaterThan(0);
    expect(whole + cut + rest).toBe(25);
    // 全文は再照合の記録にある
    for (const a of r?.added ?? []) expect(read(record)).toContain(a.reason);
  });

  test("nod が作業ログを拒否したら、終了コードと nod のエラー文を logProblem と label.error に残し、保存できたとは扱わない", async () => {
    const s = sandbox();
    failingGh(s);
    const x = await issueRepo(s);
    const p = await prepareIssue(s, x, "rejected", false);
    // 既知の形の秘密値（GitHub のトークンの形）を含む理由は、nod が SECRET_DETECTED で作業ログを拒否する
    const f = (await finalize(s, p, ["--not-run-reason", `利用者が中止した（ghp_${"A".repeat(36)}）`])).json as Finalize;
    expect(f).toMatchObject({ status: "未実施", logs: { summary: null, ci: null } });
    expect(f.logProblem).toContain("要約の作業ログを書けない（終了コード 1: SECRET_DETECTED: 作業ログにGitHub のトークンらしき値が含まれるため記録しませんでした");
    expect(f.label.error).toContain("[ci-result] の作業ログを書けない（終了コード 1: SECRET_DETECTED: ");
    expect((await issueShow(x)).activity.filter((a) => a.logKind)).toEqual([]);
  });

  test.each(["unchanged", "retarget", "remove", "replace-file"] as const)("local未追跡symlink: %s をリンク先の実体を読まずに固定・再照合する", async (change) => {
    const s = sandbox();
    const nod = tempNod(s);
    const repo = makeGitRepo(s, "local-link");
    registerRepo(nod.db, repo, "LINK");
    const base = gitOut(repo, "rev-parse", "HEAD");
    const link = join(repo, "untracked-link");
    // 存在しないリンク先でも、リンクそのものを固定する
    symlinkSync("missing-original", link);
    const W = join(s.t, "work", "local-link");
    const r = await runReview<{ ready: boolean; inputs: { path: string; sha256: string }[] }>("prepare", ["--work", W, "--repo", repo, "--mode", "local", "--base", base, "--untracked", "untracked-link"], s);
    expect(r.json?.ready).toBe(true);
    expect(readlinkSync(join(W, "input/local/untracked/untracked-link"))).toBe("missing-original");
    const linkInput = r.json?.inputs.find((f) => f.path === "local/untracked/untracked-link");
    expect(linkInput?.sha256).toMatch(/^[a-f0-9]{64}$/);
    const p: PreparedWork = { W, repo, base, head: base, clone: join(W, "repo") };
    const local = (text: string) => text.replace(`head \`${base}\``, `head \`${base}\`／${r.json?.inputs.filter((f) => f.path.startsWith("local/")).map((f) => `${f.path} ${f.sha256}`).join("／")}`);
    const files = ["| `requirements/workspace-rules.md` | なし |"];
    for (const role of ["standards", "spec"] as const) {
      await must(s, p, "agent", ["--role", role, "--event", "start"]);
      put(join(W, role, "handoff.md"), local(exploreHandoff(role, p, { candidates: [], table: [], files })));
      await must(s, p, "agent", ["--role", role, "--event", "received", "--agent-id", `agent-${role}`]);
      await must(s, p, "check-explore", ["--role", role]);
    }
    await must(s, p, "refute-input");
    expect(readlinkSync(join(W, "refute-input/local/untracked/untracked-link"))).toBe("missing-original");
    await must(s, p, "agent", ["--role", "refute", "--event", "start"]);
    put(join(W, "refute/verdict.md"), local(refuteVerdict(p, { empty: true, files })));
    await must(s, p, "agent", ["--role", "refute", "--event", "received", "--agent-id", "agent-refute"]);
    await must(s, p, "check-refute");
    if (change !== "unchanged") rmSync(link);
    if (change === "retarget") symlinkSync("missing-next", link);
    if (change === "replace-file") put(link, "missing-original");
    const f = (await finalize(s, p)).json as Finalize;
    expect(f.remaining.filter((v) => v.ref === "local/untracked/untracked-link").length).toBe(change === "unchanged" ? 0 : 1);
    expect(f.status).toBe("完了");
    expect(f.ci.verdict).toBe("対象外（未コミット）");
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
    // 明示された要求が無い単独レビューの要求資料は Workspace の規約だけ
    const files = ["| `requirements/workspace-rules.md` | あり |"];
    for (const role of ["standards", "spec"] as const) {
      await must(s, p, "agent", ["--role", role, "--event", "start"]);
      put(join(W, role, "handoff.md"), local(exploreHandoff(role, p, { files })));
      await must(s, p, "agent", ["--role", role, "--event", "received", "--agent-id", `agent-${role}`]);
      await must(s, p, "check-explore", ["--role", role]);
    }
    await must(s, p, "refute-input");
    await must(s, p, "agent", ["--role", "refute", "--event", "start"]);
    put(join(W, "refute/verdict.md"), local(refuteVerdict(p, { files })));
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
    expect(read(join(W, "parent/report.md"))).toContain(SCOPE);
  });
});
