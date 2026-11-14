import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  type Sandbox,
  sandbox,
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
const RULES = "# 規約\n\n- 日本語で書く\n";
// mode: local のマージ可否の理由（マージ可否の対象外で常に不可）
const LOCAL = "未コミット変更のレビュー（mode: local）。commit 後に新しいレビューが要る";
// 廃止した CI の照合の印・作業ログの先頭・スクリプト名・記録の場所と CI 判定の語。報告・監査・作業ログのどこにも出さない
const NO_CI = /ci-(?:result|checks)|CI 判定|parent\/ci\b/;
// 廃止した CI の再照合のサブコマンド名
const OLD_RECHECK = ["recheck", "ci"].join("-");
// finalize の結果の JSON の項目（CI の照合の記録と評価用の別の判定は無い）
const FINALIZE_KEYS = ["audit", "auditSha256", "blockers", "documents", "head", "label", "logProblem", "logs", "merge", "mode", "ok", "reason", "recheck", "remaining", "remainingCount", "report", "reportSha256", "reportStartedAt", "reportedMerge", "runId", "saveProblems", "saved", "savedAt", "score", "scoreValue", "status", "subcommand", "usage"];
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
  head: { currentHead: string | null; currentBase: string | null; reviewedBase: string | null; headOk: boolean; baseOk: boolean; problem: string | null } | null;
  documents: { audit: SavedDoc; report: SavedDoc } | null;
  saved: boolean;
  saveProblems: string[];
  logs: { summary: number | null; mergeReady: number | null };
  label: { operation: string; error: string | null };
  logProblem: string | null;
  reportStartedAt: string;
  savedAt: string;
}
interface Activity {
  kind: string;
  id?: number;
  body?: string;
  logKind?: string | null;
}

// 偽の gh。gh pr view <PR> --json headRefOid,baseRefName にだけ、設定の応答を呼ばれた順に返す（最後の値を繰り返す）。
// それ以外（CI を読む gh api など）は失敗する。呼び出しはすべて記録する
const FAKE_GH = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + "\\n");
if (args[0] === "pr" && args[1] === "view" && args[3] === "--json" && args[4] === "headRefOid,baseRefName") {
  const prs = JSON.parse(readFileSync(process.env.FAKE_GH_CONFIG, "utf8"));
  const counter = process.env.FAKE_GH_CONFIG + ".n";
  const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) : 0;
  writeFileSync(counter, String(n + 1));
  process.stdout.write(JSON.stringify(prs[Math.min(n, prs.length - 1)]) + "\\n");
  process.exit(0);
}
process.stderr.write("fake gh: unsupported: " + args.join(" ") + "\\n");
process.exit(1);
`;

// gh pr view の応答（PR の現在の head と基点）
interface PrView {
  headRefOid: string;
  baseRefName: string;
}
const pr = (head: string, base = "main"): PrView => ({ headRefOid: head, baseRefName: base });

interface FakeGh {
  set: (prs: PrView[]) => void;
  calls: () => string[][];
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
    set: (prs) => {
      writeFileSync(config, JSON.stringify(prs));
      rmSync(`${config}.n`, { force: true });
    },
    calls: () => (existsSync(log) ? read(log).trimEnd().split("\n").map((l) => JSON.parse(l) as string[]) : []),
  };
}

// 呼ばれたら失敗する gh（PR を読めない環境）
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

const issueShow = async (x: IssueRepo) => (await x.nod.run(["--json", "issue", "show", x.issue], x.repo)).json as { labels: string[]; activity: Activity[] };
const docShow = async (x: IssueRepo, id: number) => (await x.nod.run(["--json", "doc", "show", String(id)], x.repo)).json as { kind: string; issues: { id: string }[]; content: string };
const addMergeReady = async (x: IssueRepo) => expect((await x.nod.run(["issue", "update", x.issue, "--add-label", "merge-ready"], x.repo)).exitCode).toBe(0);

// 基点の指定は既定でブランチ名 main（レビューした基点）。pr なら PR から固定した head、無ければ SHA だけの head（ref なし）
async function prepareIssue(s: Sandbox, x: IssueRepo, name: string, pr: boolean, base = "main"): Promise<PreparedWork> {
  const W = join(s.t, "work", name);
  const r = await runReview<{ ready: boolean }>("prepare", ["--work", W, "--repo", x.repo, "--mode", "commit", "--base", base, "--head", x.head, "--issue", x.issue, ...(pr ? ["--pr", PR] : [])], s);
  if (r.exitCode !== 0 || !r.json?.ready) throw new Error(`prepare が準備完了を返しません: ${r.stdout}${r.stderr}`);
  return { W, repo: x.repo, base: x.base, head: x.head, clone: join(W, "repo") };
}

async function must(s: Sandbox, p: PreparedWork, sub: string, args: string[] = []): Promise<void> {
  const r = await runReview<{ valid?: boolean; ready?: boolean }>(sub, ["--work", p.W, ...args], s);
  if (r.exitCode !== 0 || r.json?.valid === false || r.json?.ready === false) throw new Error(`${sub} ${args.join(" ")} が通りません: ${r.stdout}${r.stderr}`);
}

const finalize = async (s: Sandbox, p: PreparedWork, args: string[] = []) => runReview<Finalize>("finalize", ["--work", p.W, ...args], s);
const today = () => new Date().toISOString().slice(0, 10).replaceAll("-", "");
// 反証の判定本文の印の間（監査に原文のまま収める）
const embeddedVerdict = (text: string) => text.split("<!-- refute-verdict:begin -->\n")[1]?.split("<!-- refute-verdict:end -->")[0];

// 完了・点数5（要対応0件）・確認が残る事項0件の Issue と PR のレビュー（3担当だけ）。PR の現在の head と基点はレビューした版と同じ。
// shaBase なら基点をブランチ名でなく SHA で指定する
async function cleanIssueReview(s: Sandbox, name: string, opts: { shaBase?: boolean } = {}): Promise<{ x: IssueRepo; p: PreparedWork; gh: FakeGh; verdict: string }> {
  const gh = fakeGh(s);
  const x = await issueRepo(s);
  gh.set([pr(x.head)]);
  const p = await prepareIssue(s, x, name, true, opts.shaBase ? x.base : "main");
  const verdict = refuteVerdict(p, { clean: true });
  await reachRefute(s, p, verdict);
  await must(s, p, "check-refute");
  return { x, p, gh, verdict };
}

describe("code-review の仕上げ（review.ts finalize）", () => {
  test("正常保存: CI を照合せず、完了・点数5・確認が残る事項0・現在の head と基点がレビューした版と同じなら可にし、監査→結果の順に2つの Document を保存して照合し、要約の作業ログ・merge-ready・[merge-ready] で始まる progress の作業ログ1件を残す", async () => {
    const s = sandbox();
    const { x, p, gh, verdict } = await cleanIssueReview(s, "ok");

    const r = await finalize(s, p);
    expect(r.stderr).toBe("");
    expect(r.exitCode).toBe(0);
    const f = r.json as Finalize;
    expect(f).toMatchObject({ status: "完了", reason: null, score: 5, scoreValue: 5, remainingCount: 0, merge: MERGE_OK, reportedMerge: MERGE_OK, blockers: [], saved: true, saveProblems: [] });
    expect(f.head).toMatchObject({ currentHead: x.head, currentBase: "main", reviewedBase: "main", headOk: true, baseOk: true, problem: null });
    expect(f.label).toEqual({ operation: "付けた", error: null });
    expect(Object.keys(f.logs).sort()).toEqual(["mergeReady", "summary"]);
    expect(Object.keys(f).sort()).toEqual(FINALIZE_KEYS);
    expect(f.reportStartedAt <= f.savedAt).toBe(true);
    expect(JSON.parse(read(join(p.W, "parent/finalize.json")))).toEqual(JSON.parse(JSON.stringify({ ok: true, subcommand: "finalize", ...f })));
    // CI を照合しない: gh は PR の現在の head と基点の取り直しにだけ使い（CI の応答を読まない）、CI の記録を作らない
    expect(gh.calls().length).toBeGreaterThan(0);
    expect(gh.calls().filter((c) => c.join(" ") !== `pr view ${PR} --json headRefOid,baseRefName`)).toEqual([]);
    expect(existsSync(join(p.W, "parent/ci"))).toBe(false);

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
    // 結果は短い結論と、範囲の固定の注記1文と、監査への参照。原文・全対応表は載せず、E2E・QA で担保したとは書かない。
    // マージ可否・現在の head と基点の照合・merge-ready は通常の本文に書き、CI の照合の印・節・記録は無い
    expect(report.content).toContain(`監査 Document ${auditId}`);
    expect(report.content).toContain("- 最終状態: 完了");
    expect(report.content).toContain("- 確定した要対応の点数: 5");
    expect(report.content.split(SCOPE)).toHaveLength(2);
    expect(report.content).not.toMatch(/E2E|QA/);
    expect(report.content).toContain(`- マージ可否: ${MERGE_OK}`);
    expect(report.content).not.toContain("## 採否一覧");
    expect(audit.content).toContain(`- マージ可否: ${MERGE_OK}`);
    expect(audit.content).toContain(`- 現在の head と基点の照合: 現在の head ${x.head}（固定した head と一致）、現在の基点 main（レビューした基点 main と一致）`);
    expect(audit.content).not.toContain("### CI の結果");
    for (const [name, text] of [
      ["結果", report.content],
      ["監査", audit.content],
    ] as const) {
      expect(`${name}: ${text.match(NO_CI)?.[0] ?? "なし"}`).toBe(`${name}: なし`);
    }

    // 作業ログ: 要約（完了は progress）と、本文が [merge-ready] で始まる progress の1件。--kind test の記録は残さない
    const shown = await issueShow(x);
    expect(shown.labels).toContain("merge-ready");
    const logs = shown.activity.filter((a) => a.logKind);
    for (const a of logs) expect(`${a.id}: ${a.body?.match(NO_CI)?.[0] ?? "なし"}`).toBe(`${a.id}: なし`);
    expect(logs.filter((a) => a.logKind === "test")).toEqual([]);
    const summary = logs.find((a) => a.id === f.logs.summary);
    expect(summary).toMatchObject({ logKind: "progress" });
    expect(summary?.body).toContain(`結果Document ${reportId}`);
    expect(summary?.body).toContain(`監査Document ${auditId}`);
    expect(summary?.body).toContain("マージ可否・merge-ready は [merge-ready] で始まる作業ログを参照");
    expect(summary?.body?.startsWith("[merge-ready]")).toBe(false);
    const mergeReady = logs.filter((a) => a.body?.startsWith("[merge-ready]"));
    expect(mergeReady).toHaveLength(1);
    expect(mergeReady[0]).toMatchObject({ id: f.logs.mergeReady, logKind: "progress" });
    const body = mergeReady[0]?.body ?? "";
    expect(body.startsWith("[merge-ready] merge-ready: 付けた。")).toBe(true);
    for (const part of [`判定した head SHA ${x.head}、現在の head ${x.head}（一致）`, "レビューした基点 main（基点の指定 main、", "現在の基点 main（一致）", `マージ可否 ${MERGE_OK}`, `報告Document ${reportId}`, "runId ok"]) {
      expect(body).toContain(part);
    }
    for (const gone of ["parent/acceptance", "acceptance-input", "acceptance", "parent/acceptance-recheck"]) expect(`${gone}: ${existsSync(join(p.W, gone))}`).toBe(`${gone}: false`);
    expect(read(join(p.W, "parent/head-check.md"))).toContain("merge-ready を付ける直前");

    // 保存し直さない
    expect((await finalize(s, p)).exitCode).toBe(2);
    // 廃止した CI の再照合のサブコマンドは知らないサブコマンドとして引数の誤りにし、記録もラベルも変えない
    const old = await runReview<{ ok: boolean; code: string }>(OLD_RECHECK, ["--work", p.W], s);
    expect(old.exitCode).toBe(2);
    expect(old.json).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    expect(existsSync(join(p.W, `parent/${OLD_RECHECK}.json`))).toBe(false);
    expect((await issueShow(x)).labels).toContain("merge-ready");
  });

  test.each([
    { name: "追加コミット", prs: (_: string) => [pr(OTHER)], blocker: `対象版が現在の head と違う（追加コミット。現在の head ${OTHER}）`, reported: MERGE_NG, at: "マージ可否を決める直前" },
    { name: "PR の基点の変化", prs: (h: string) => [pr(h, "develop")], blocker: "基点が変わった（レビューした基点 main、現在の基点 develop）", reported: MERGE_NG, at: "マージ可否を決める直前" },
    { name: "付ける直前の追加コミット", prs: (h: string) => [pr(h), pr(OTHER)], blocker: `対象版が現在の head と違う（追加コミット。現在の head ${OTHER}）`, reported: MERGE_OK, at: "merge-ready を付ける直前" },
    { name: "付ける直前の基点の変化", prs: (h: string) => [pr(h), pr(h, "develop")], blocker: "基点が変わった（レビューした基点 main、現在の基点 develop）", reported: MERGE_OK, at: "merge-ready を付ける直前" },
  ])("現在の head と基点がレビューした版と違えば、ほかの条件がそろっていても不可にして merge-ready を付けず、付いていれば外す: $name", async (c) => {
    const s = sandbox();
    const { x, p, gh } = await cleanIssueReview(s, "moved");
    await addMergeReady(x);
    gh.set(c.prs(x.head));

    const f = (await finalize(s, p)).json as Finalize;
    expect(f).toMatchObject({ status: "完了", score: 5, remainingCount: 0, saved: true, merge: MERGE_NG, reportedMerge: c.reported });
    expect(f.blockers).toEqual([c.blocker]);
    expect(f.label).toEqual({ operation: "外した", error: null });
    const shown = await issueShow(x);
    expect(shown.labels).not.toContain("merge-ready");
    const log = shown.activity.find((a) => a.id === f.logs.mergeReady);
    expect(log?.logKind).toBe("progress");
    expect(log?.body?.startsWith(`[merge-ready] merge-ready: 外した（マージ可否が不可: ${c.blocker}）。`)).toBe(true);
    const headCheck = read(join(p.W, "parent/head-check.md"));
    expect(headCheck).toContain(`## ${c.at}`);
    expect(headCheck).toContain(`- 結果: ${c.blocker}`);
    if (c.reported === MERGE_NG) expect(read(join(p.W, "parent/report.md"))).toContain(`- 理由: ${c.blocker}`);
  });

  test("基点の指定をブランチ名に解決できない（SHA で指定した）ときは、レビューした基点が無く現在の基点と照合できないので、変わったと断定せずに不可にする", async () => {
    const s = sandbox();
    const { x, p } = await cleanIssueReview(s, "sha-base", { shaBase: true });

    const f = (await finalize(s, p)).json as Finalize;
    const blocker = `基点をブランチ名に解決できず、現在の基点と照合できない（基点の指定 ${x.base}）`;
    expect(f).toMatchObject({ status: "完了", score: 5, remainingCount: 0, saved: true, merge: MERGE_NG, reportedMerge: MERGE_NG, blockers: [blocker] });
    expect(f.head).toMatchObject({ currentHead: x.head, headOk: true, currentBase: "main", reviewedBase: null, baseOk: false, problem: null });
    expect(f.label.operation).toBe("付けていない");
    expect(read(join(p.W, "parent/report.md"))).toContain(`- 理由: ${blocker}`);
    expect(read(join(p.W, "parent/head-check.md"))).toContain(`- 結果: ${blocker}`);
    const shown = await issueShow(x);
    expect(shown.labels).not.toContain("merge-ready");
    expect(shown.activity.find((a) => a.id === f.logs.mergeReady)?.body?.startsWith(`[merge-ready] merge-ready: 付けていない（マージ可否が不可: ${blocker}）。`)).toBe(true);
  });

  test("新しく紐付いたspecの本文を取得できなくても要求集合の変化を確認残にする", async () => {
    const s = sandbox();
    const { x, p } = await cleanIssueReview(s, "new-spec");
    const added = (await x.nod.run(["--json", "doc", "create", "new-spec.md", "--title", "追加仕様", "--kind", "spec", "--issue", x.issue, "--body", "- a は 2 を返す"], x.repo)).json as { id: number };
    const wrapper = join(s.t, "nod-spec-unavailable");
    put(wrapper, `#!/bin/sh\nif [ "$*" = "--json doc show ${added.id}" ]; then echo '取得できない' >&2; exit 1; fi\nexec "${x.nod.env.NOD_CLI}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    s.env.NOD_CLI = wrapper;
    const f = (await finalize(s, p)).json as Finalize;
    expect(f.merge).toBe(MERGE_NG);
    expect(f.remaining.some((v) => v.ref === "requirements/kind=spec" && v.reason.includes("要求の変化"))).toBe(true);
    expect((await issueShow(x)).labels).not.toContain("merge-ready");
  });

  test("Issue再取得が非JSONで失敗しても不可判定・ラベル解除・記録保存へ進む", async () => {
    const s = sandbox();
    const { x, p } = await cleanIssueReview(s, "issue-unavailable");
    await addMergeReady(x);
    const wrapper = join(s.t, "nod-issue-unavailable");
    // この1回の取得だけを失敗させ、ラベル操作・保存など後続のnodコマンドは実物へ通す
    const failed = join(s.t, "issue-fetch-failed");
    put(wrapper, `#!/bin/sh\nif [ "$*" = "--json issue show ${x.issue}" ] && [ ! -f "${failed}" ]; then touch "${failed}"; printf '{"title":'; exit 1; fi\nexec "${x.nod.env.NOD_CLI}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    s.env.NOD_CLI = wrapper;
    const r = await finalize(s, p);
    expect(r.exitCode).toBe(0);
    expect(r.json?.merge).toBe(MERGE_NG);
    expect(r.json?.remaining.some((v) => v.ref === "requirements/issue.md")).toBe(true);
    expect((await issueShow(x)).labels).not.toContain("merge-ready");
    const audit = read(join(p.W, "parent/audit.md"));
    expect(audit).toContain("requirements/issue.md");
    expect(audit).toContain("nod issue show が失敗");
    expect(audit).toContain("Issue の取得記録を解析できない");
    expect(read(join(p.W, "parent/requirements-recheck/issue-snapshot.json"))).toBe('{"title":');
    expect(r.json).toMatchObject({ saved: true });
  });

  test.each(["report", "audit"] as const)("保存に失敗した %s があれば、ほかの条件がそろっていても不可にして merge-ready を付けない", async (kind) => {
    const s = sandbox();
    const { x, p } = await cleanIssueReview(s, "savefail");
    const suffix = kind === "audit" ? "-audit" : "";
    put(join(x.nod.docs, `${x.issue.toLowerCase()}-code-review${suffix}-${today()}-savefail.md`), "既にある\n");
    const f = (await finalize(s, p)).json as Finalize;
    expect(f).toMatchObject({ saved: false, merge: MERGE_NG, reportedMerge: MERGE_OK });
    expect(f.blockers.join("\n")).toContain("報告の保存・照合に失敗");
    expect(f.label.operation).toBe("付けていない");
    expect((await issueShow(x)).labels).not.toContain("merge-ready");
  });

  test("保存直前の再照合: 要求資料の変化を確認が残る事項にして不可にする。収録原文の指紋の不一致と、取り直せない head（ref なし）では merge-ready を付けない", async () => {
    const s = sandbox();
    const gh = fakeGh(s);
    const x = await issueRepo(s);
    gh.set([pr(x.head)]);
    // PR でなく SHA だけで固定した head（ref なし。現在の head を取り直せない）
    const p = await prepareIssue(s, x, "changes", false);
    const verdict = refuteVerdict(p, { clean: true });
    await reachRefute(s, p, verdict);
    await must(s, p, "check-refute");
    // 反証の後・保存の前に、Workspace の規約を変えた
    expect((await x.nod.run(["workspace", "rules", "set", "--text", RULES.replace("日本語", "英語")], x.repo)).exitCode).toBe(0);
    // 検査の後に判定本文が書き換わった（監査の印の間の指紋が検査した原本と違う）
    put(join(p.W, "refute/verdict.md"), `${verdict}書き換えた\n`);

    const f = (await finalize(s, p)).json as Finalize;
    expect(f).toMatchObject({ status: "完了", reason: null, score: 5, merge: MERGE_NG, saved: false });
    expect(f.remaining.map((r) => [r.ref, r.owner])).toEqual([["requirements/workspace-rules.md", "人"]]);
    expect(f.remaining[0]?.reason).toContain("保存時の要求の変化");
    expect(f.saveProblems.join("\n")).toContain("refute-verdict");
    expect(f.documents?.audit.id).toBeNumber();
    expect(f.documents?.report.id).toBeNumber();
    expect(read(join(p.W, "parent/requirements-recheck/workspace-rules.md"))).toContain("- 英語で書く");
    expect(f.head?.problem).toBe("現在の head を取り直せない（ref なし: head を SHA だけで固定した）");
    expect(f.blockers).toContain("確認が残る事項 1 件");
    expect(f.blockers).toContain("現在の head を取り直せない（ref なし: head を SHA だけで固定した）");
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
    expect(fa.head).toBeNull();
    expect(fa.label.operation).toBe("扱わない（評価用の事例）");
    expect(fa.blockers).toEqual([`最終状態 未完了（理由: ${fa.reason}）`, "点数なし"]);
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
    expect(fb.blockers).toEqual(["確定した要対応の点数 2", "確認が残る事項 2 件"]);
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

  test("評価用の事例: 現在の head と基点の照合対象が無いので照合せず、マージ可否を完了・確定した要対応0件・確認が残る事項0件だけで決める（--auto-check-rows なし。コード要求0件の空の対応表でも同じ）", async () => {
    const s = sandbox();
    const nodCalls = forbiddenNod(s);
    const a = await prepareCaseWork(s, "case-clean");
    await reachRefute(s, a, refuteVerdict(a, { clean: true }));
    await must(s, a, "check-refute");
    // 廃止した --auto-check-rows は受け付けない（引数の誤り。記録も残さない）
    expect((await finalize(s, a, ["--auto-check-rows", "pass"])).exitCode).toBe(2);
    expect(existsSync(join(a.W, "parent/finalize.json"))).toBe(false);
    const fa = (await finalize(s, a)).json as Finalize;
    expect(fa).toMatchObject({ status: "完了", scoreValue: 5, remainingCount: 0, merge: MERGE_OK, reportedMerge: MERGE_OK, blockers: [], head: null });
    expect(fa.label.operation).toBe("扱わない（評価用の事例）");
    expect(Object.keys(fa).sort()).toEqual(FINALIZE_KEYS);
    const auditA = read(join(a.W, "parent/audit.md"));
    expect(auditA).toContain(`- マージ可否: ${MERGE_OK}`);
    expect(auditA).toContain("- 現在の head と基点の照合: 照合せず（評価用の事例）");
    expect(read(join(a.W, "parent/report.md"))).toContain(`- マージ可否: ${MERGE_OK}`);
    expect(existsSync(join(a.W, "parent/ci"))).toBe(false);

    // コード要求0件: 両探索と反証の空の対応表でも完了・点数5・確認が残る事項0件
    const e = await prepareCaseWork(s, "case-empty");
    await reachRefute(s, e, refuteVerdict(e, { empty: true }), { empty: true });
    await must(s, e, "check-refute");
    const fe = (await finalize(s, e)).json as Finalize;
    expect(fe).toMatchObject({ status: "完了", scoreValue: 5, remainingCount: 0, merge: MERGE_OK, blockers: [] });
    expect(nodCalls()).toBe("");
  });

  test("作業ログの上限: 確認が残る事項が多く 4000 字を超える要約も、必須の項目を残して収まらない事項の件数と参照先を書き、実際の nod に保存する", async () => {
    const s = sandbox();
    const gh = fakeGh(s);
    const x = await issueRepo(s);
    gh.set([pr(x.head)]);
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
    expect(f.logs.mergeReady).toBeNumber();
    const reportId = f.documents?.report.id as number;
    const auditId = f.documents?.audit.id as number;
    const shown = await issueShow(x);
    const summary = shown.activity.find((a) => a.id === f.logs.summary);
    expect(summary?.logKind).toBe("progress");
    const body = summary?.body ?? "";
    expect(codePoints(body)).toBeLessThanOrEqual(LOG_MAX);
    // 必須の項目（状態・点数・要対応・確認が残る事項の件数・Document ID・runId・担当と ID）と、マージ可否を書かず [merge-ready] を参照する規則
    for (const part of ["独立コードレビュー完了。確定した要対応の点数 5。", "要対応: なし。", "確認が残る事項 25 件（", `結果Document ${reportId}、監査Document ${auditId}`, "runId many。", "担当: ", "agent-refute", "マージ可否・merge-ready は [merge-ready] で始まる作業ログを参照", "計測（保存までの確定値。"]) {
      expect(body).toContain(part);
    }
    expect(body).not.toContain("受け入れ確認");
    expect(body.startsWith("[merge-ready]")).toBe(false);
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

    // [merge-ready] の記録も progress で保存され、確認が残る事項の件数を不可の理由に書く
    const mergeReady = shown.activity.find((a) => a.id === f.logs.mergeReady);
    expect(mergeReady?.logKind).toBe("progress");
    expect(mergeReady?.body?.startsWith("[merge-ready] merge-ready: 付けていない（マージ可否が不可: ")).toBe(true);
    expect(mergeReady?.body).toContain("確認が残る事項 25 件");
  });

  test("nod が作業ログを拒否したら、終了コードと nod のエラー文を logProblem と label.error に残し、保存できたとは扱わない", async () => {
    const s = sandbox();
    failingGh(s);
    const x = await issueRepo(s);
    const p = await prepareIssue(s, x, "rejected", false);
    // 既知の形の秘密値（GitHub のトークンの形）を含む理由は、nod が SECRET_DETECTED で作業ログを拒否する
    const f = (await finalize(s, p, ["--not-run-reason", `利用者が中止した（ghp_${"A".repeat(36)}）`])).json as Finalize;
    expect(f).toMatchObject({ status: "未実施", logs: { summary: null, mergeReady: null } });
    expect(f.logProblem).toContain("要約の作業ログを書けない（終了コード 1: SECRET_DETECTED: 作業ログにGitHub のトークンらしき値が含まれるため記録しませんでした");
    expect(f.label.error).toContain("[merge-ready] の作業ログを書けない（終了コード 1: SECRET_DETECTED: ");
    expect((await issueShow(x)).activity.filter((a) => a.logKind)).toEqual([]);
  });

  test.each(["unchanged", "retarget", "remove", "replace-file", "replace-file-collision", "replace-link-collision", "tamper-input", "tamper-refute-input"] as const)("未追跡symlinkと写し: %s をリンク先の実体を読まずに固定・再照合する", async (change) => {
    const s = sandbox();
    const nod = tempNod(s);
    const repo = makeGitRepo(s, "local-link");
    registerRepo(nod.db, repo, "LINK");
    const base = gitOut(repo, "rev-parse", "HEAD");
    const link = join(repo, "untracked-link");
    // 存在しないリンク先でも、リンクそのものを固定する
    if (change === "replace-link-collision") put(link, "link\0missing-original");
    else symlinkSync("missing-original", link);
    const W = join(s.t, "work", "local-link");
    const r = await runReview<{ ready: boolean; inputs: { path: string; sha256: string }[] }>("prepare", ["--work", W, "--repo", repo, "--mode", "local", "--base", base, "--untracked", "untracked-link"], s);
    expect(r.json?.ready).toBe(true);
    if (change !== "replace-link-collision") expect(readlinkSync(join(W, "input/local/untracked/untracked-link"))).toBe("missing-original");
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
    if (change !== "replace-link-collision") expect(readlinkSync(join(W, "refute-input/local/untracked/untracked-link"))).toBe("missing-original");
    await must(s, p, "agent", ["--role", "refute", "--event", "start"]);
    put(join(W, "refute/verdict.md"), local(refuteVerdict(p, { empty: true, files })));
    await must(s, p, "agent", ["--role", "refute", "--event", "received", "--agent-id", "agent-refute"]);
    await must(s, p, "check-refute");
    if (change === "tamper-input" || change === "tamper-refute-input") {
      const copy = join(W, change === "tamper-input" ? "input" : "refute-input", "local/untracked/untracked-link");
      rmSync(copy);
      put(copy, "link\0missing-original");
      const checked = await runReview<{ valid: boolean; identity: { ok: boolean; items: { ok: boolean; detail: string }[] } }>("check-refute", ["--work", W], s);
      expect(checked.json?.valid).toBe(false);
      expect(checked.json?.identity.ok).toBe(false);
      expect(checked.json?.identity.items.some((i) => !i.ok && i.detail.includes("local/untracked/untracked-link"))).toBe(true);
      return;
    }
    if (change !== "unchanged") rmSync(link);
    if (change === "retarget") symlinkSync("missing-next", link);
    if (change === "replace-file") put(link, "missing-original");
    if (change === "replace-file-collision") put(link, "link\0missing-original");
    if (change === "replace-link-collision") symlinkSync("missing-original", link);
    const f = (await finalize(s, p)).json as Finalize;
    expect(f.remaining.filter((v) => v.ref === "local/untracked/untracked-link").length).toBe(change === "unchanged" ? 0 : 1);
    expect(f.status).toBe("完了");
    // mode: local はマージ可否の対象外で常に不可（現在の head は照合しない）。変化が無く完了・点数5・確認が残る事項0でも同じ
    expect(f).toMatchObject({ merge: MERGE_NG, head: null });
    if (change === "unchanged") expect(f).toMatchObject({ scoreValue: 5, remainingCount: 0, blockers: [LOCAL] });
    else expect(f.blockers).toContain(LOCAL);
  });

  test("Issue なしの mode: local: 未コミット変更の土台 HEAD・差分の変化を確認が残る事項にし、マージ可否は mode: local として不可、報告と監査は手元に残してラベルを扱わない", async () => {
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
    expect(f.blockers).toContain(LOCAL);
    expect(f.label.operation).toBe("扱わない（Issue なし）");
    expect(f.remaining.find((r) => r.ref === "local/changes.diff")).toMatchObject({ owner: "人" });
    expect(f.remaining.find((r) => r.ref === "local/changes.diff")?.reason).toContain("未コミット変更の土台 HEAD・差分の変化");
    const report = read(join(W, "parent/report.md"));
    expect(report).toContain(`監査記録 ${join(W, "parent/audit.md")}`);
    expect(report).toContain(SCOPE);
    expect(report).toContain(`- 理由: ${[...f.blockers].join("／")}`);
    expect(read(join(W, "parent/audit.md"))).toContain("- 現在の head と基点の照合: 照合せず（mode: local）");
  });
});
