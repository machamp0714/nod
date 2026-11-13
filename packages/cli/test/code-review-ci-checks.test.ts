import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers";

// code-review の親が同じ head SHA の CI の結果を照合するスクリプトを、プロセスとして起動する
const SCRIPT = join(import.meta.dir, "../../../plugins/nod/skills/code-review/scripts/ci-checks.ts");

const REPO = "acme/shop";
const BASE = "develop";
const HEAD = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const OTHER_SHA = "0123456789abcdef0123456789abcdef01234567";
// GitHub Actions の app id
const APP = 15368;
const PATHS = {
  branch: `repos/${REPO}/branches/${BASE}`,
  rules: `repos/${REPO}/rules/branches/${BASE}`,
  commit: `repos/${REPO}/commits/${HEAD}`,
  checkRuns: `repos/${REPO}/commits/${HEAD}/check-runs`,
  status: `repos/${REPO}/commits/${HEAD}/status`,
};

// Workspace 規約の既定: 「必須のチェック」の節に lint と typecheck。別の節の箇条書きは必須にしない
const RULES = "# 作業規約\n\n## 必須のチェック\n\n- `lint`\n- typecheck\n\n## そのほか\n\n- docs-build\n";
const UNREGISTERED = "作業規約は登録されていません\n";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

// 偽の gh。引数を記録し、`gh repo view --json nameWithOwner` と `gh api <endpoint>`（--paginate・--slurp・--jq '.<key>[] | tojson' だけ）に、
// 設定の固定の応答で答える。--paginate ならすべてのページ、無ければ最初のページだけを返し、--jq も --slurp も無ければ本物と同じくページの JSON を連結する。
// 知らない引数（-X・--method・-f・-F など書き込みに使うもの）は応答せずに失敗する
const FAKE_GH = `
import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
const config = JSON.parse(readFileSync(process.env.FAKE_GH_CONFIG, "utf8"));
const unsupported = () => { process.stderr.write("fake gh: unsupported: " + args.join(" ") + "\\n"); process.exit(64); };
const httpError = (status, message) => {
  process.stdout.write(JSON.stringify({ message, status: String(status) }));
  process.stderr.write("gh: " + message + " (HTTP " + status + ")\\n");
  process.exit(1);
};
if (args.length === 4 && args[0] === "repo" && args[1] === "view" && args[2] === "--json" && args[3] === "nameWithOwner") {
  if (config.repo === null) { process.stderr.write("none of the git remotes configured for this repository point to a known GitHub host\\n"); process.exit(1); }
  process.stdout.write(JSON.stringify({ nameWithOwner: config.repo }) + "\\n");
  process.exit(0);
}
if (args[0] !== "api") unsupported();
let paginate = false, slurp = false, jq = null, endpoint = null;
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === "--paginate") paginate = true;
  else if (a === "--slurp") slurp = true;
  else if (a === "--jq" || a === "-q") jq = args[++i];
  else if (a.startsWith("-")) unsupported();
  else if (endpoint === null) endpoint = a;
  else unsupported();
}
if (endpoint === null || (slurp && (!paginate || jq !== null))) unsupported();
const api = config.api[endpoint.split("?")[0]];
if (api === undefined) httpError(404, "Not Found");
if (api.status !== undefined) httpError(api.status, api.message ?? "Error");
const bodies = paginate ? api.pages : api.pages.slice(0, 1);
if (slurp) process.stdout.write(JSON.stringify(bodies) + "\\n");
else if (jq !== null) {
  const m = /^\\.(\\w*)\\[\\] \\| tojson$/.exec(jq);
  if (!m) unsupported();
  for (const body of bodies) for (const item of m[1] ? body[m[1]] : body) process.stdout.write(JSON.stringify(item) + "\\n");
} else for (const body of bodies) process.stdout.write(JSON.stringify(body, null, 2));
`;

// 偽の gh の応答。pages はページごとの応答本文、status があればその HTTP の失敗を返す
interface Api {
  pages?: unknown[];
  status?: number;
  message?: string;
}
interface FakeGitHub {
  repo: string | null;
  api: Record<string, Api>;
}

interface RunRecord {
  kind: string;
  id: number | null;
  name: string;
  status: string;
  conclusion: string | null;
  appId: number | null;
  url: string | null;
  completedAt: string | null;
}
interface Required {
  context: string;
  appId: number | null;
  sources: string[];
  result: string;
  runs: RunRecord[];
}
interface SourceRecord {
  status: string;
  message?: string;
  checks: { context: string; appId: number | null }[];
}
// スクリプトが標準出力に出す結果（1行の JSON）
interface Result {
  ok: boolean;
  code?: string;
  message?: string;
  verdict?: string;
  repository?: string | null;
  base?: string;
  head?: string;
  observedAt?: string;
  sources?: { branchProtection: SourceRecord; rulesets: SourceRecord; workspaceRules: SourceRecord };
  required?: Required[];
  reason?: string;
  files?: Record<string, string>;
}

interface Call {
  args: string[];
  cwd: string;
}
interface Run {
  exitCode: number | null;
  json: Result | undefined;
  stdout: string;
  stderr: string;
  calls: Call[];
}

interface Setup {
  t: string;
  repo: string;
  rules: string;
  out: string;
  gh: string;
  config: string;
  log: string;
}

function setup(rulesBody = RULES): Setup {
  const t = tempDir("nod-ci-checks-");
  const repo = join(t, "repo");
  mkdirSync(repo);
  const rules = join(t, "workspace-rules.md");
  writeFileSync(rules, rulesBody);
  const fake = join(t, "fake-gh.ts");
  writeFileSync(fake, FAKE_GH);
  const gh = join(t, "gh");
  writeFileSync(gh, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(gh, 0o755);
  return { t, repo, rules, out: join(t, "parent/ci/1"), gh, config: join(t, "fake-gh.json"), log: join(t, "fake-gh.log") };
}

function argv(s: Setup, o: { base?: string; head?: string; out?: string } = {}): string[] {
  return ["--repo", s.repo, "--base", o.base ?? BASE, "--head", o.head ?? HEAD, "--rules", s.rules, "--out", o.out ?? s.out];
}

async function run(s: Setup, world: FakeGitHub, args: string[] = argv(s)): Promise<Run> {
  writeFileSync(s.config, JSON.stringify(world));
  const proc = Bun.spawn([process.execPath, SCRIPT, ...args], {
    cwd: tempDir("nod-ci-checks-cwd-"),
    env: { ...process.env, NOD_GH: s.gh, FAKE_GH_CONFIG: s.config, FAKE_GH_LOG: s.log },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30000,
    killSignal: "SIGKILL",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let json: Result | undefined;
  try {
    json = JSON.parse(stdout) as Result;
  } catch {
    json = undefined;
  }
  const calls = existsSync(s.log)
    ? readFileSync(s.log, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Call)
    : [];
  return { exitCode: proc.signalCode === "SIGKILL" ? null : exitCode, json, stdout, stderr, calls };
}

function checkRun(id: number, name: string, o: { status?: string; conclusion?: string; appId?: number; headSha?: string } = {}) {
  const status = o.status ?? "completed";
  return {
    id,
    name,
    head_sha: o.headSha ?? HEAD,
    status,
    conclusion: status === "completed" ? (o.conclusion ?? "success") : null,
    app: { id: o.appId ?? APP, slug: "github-actions" },
    html_url: `https://github.com/${REPO}/actions/runs/7/job/${id}`,
    completed_at: status === "completed" ? "2026-11-13T01:00:00Z" : null,
  };
}

function commitStatus(id: number, context: string, state: string) {
  return { id, context, state, target_url: `https://ci.example.com/builds/${id}`, updated_at: "2026-11-13T01:00:00Z" };
}

const protectedBranch = (requiredStatusChecks: unknown) => ({
  pages: [{ name: BASE, protected: true, protection: { enabled: true, required_status_checks: requiredStatusChecks } }],
});

// 既定の GitHub: ブランチ保護が rspec（Actions）、ルールセットが rspec（Actions）と lint を求め、
// rspec・lint の check run と typecheck の commit status がすべて成功。一覧の応答は1件ずつ別のページに分ける
function github(
  o: {
    repo?: string | null;
    branch?: Api;
    rules?: Api;
    commit?: Api;
    checkRuns?: unknown[];
    checkRunsApi?: Api;
    statuses?: unknown[];
    statusApi?: Api;
  } = {},
): FakeGitHub {
  const checkRuns = o.checkRuns ?? [checkRun(1, "rspec"), checkRun(2, "lint")];
  const statuses = o.statuses ?? [commitStatus(11, "typecheck", "success")];
  const pages = <T>(items: T[]) => (items.length === 0 ? [[]] : items.map((item) => [item]));
  return {
    repo: o.repo === undefined ? REPO : o.repo,
    api: {
      [PATHS.branch]: o.branch ?? protectedBranch({ enforcement_level: "everyone", contexts: ["rspec"], checks: [{ context: "rspec", app_id: APP }] }),
      [PATHS.rules]: o.rules ?? {
        pages: [
          [
            {
              type: "required_status_checks",
              ruleset_source_type: "Repository",
              ruleset_source: REPO,
              ruleset_id: 42,
              parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: "rspec", integration_id: APP }, { context: "lint" }] },
            },
          ],
          [{ type: "deletion" }],
        ],
      },
      [PATHS.commit]: o.commit ?? { pages: [{ sha: HEAD, commit: { message: "feat" } }] },
      [PATHS.checkRuns]: o.checkRunsApi ?? { pages: pages(checkRuns).map((page) => ({ total_count: checkRuns.length, check_runs: page })) },
      [PATHS.status]: o.statusApi ?? { pages: pages(statuses).map((page) => ({ state: "success", sha: HEAD, total_count: statuses.length, statuses: page })) },
    },
  };
}

// 結果に挙がった必須のチェック（context・app・出典・結果）
const summary = (r: Run) => r.json?.required?.map(({ context, appId, sources, result }) => ({ context, appId, sources, result }));
const resultOf = (r: Run, context: string) => r.json?.required?.find((item) => item.context === context)?.result;

function expectVerdict(r: Run, verdict: string) {
  expect(r.stderr).toBe("");
  expect({ exitCode: r.exitCode, ok: r.json?.ok, verdict: r.json?.verdict }).toEqual({ exitCode: 0, ok: true, verdict });
  expect(r.json?.reason?.length).toBeGreaterThan(0);
}

// GitHub へは読み取りだけ: gh repo view か、書き込みの指定の無い gh api だけを、--repo を作業ディレクトリにして呼ぶ
const WRITE_FLAGS = /^(-X|--method|-f|-F|--field|--raw-field|--input)(=|$)|^-[XfF]./;
function expectReadOnly(r: Run, s: Setup) {
  expect(r.calls.length).toBeGreaterThan(0);
  for (const call of r.calls) {
    expect(call.cwd).toBe(s.repo);
    if (call.args[0] === "repo") expect(call.args).toEqual(["repo", "view", "--json", "nameWithOwner"]);
    else {
      expect(call.args[0]).toBe("api");
      expect(call.args.filter((a) => WRITE_FLAGS.test(a))).toEqual([]);
    }
  }
}

function expectInvalid(r: Run, s: Setup) {
  expect({ exitCode: r.exitCode, ok: r.json?.ok, code: r.json?.code }).toEqual({ exitCode: 2, ok: false, code: "INVALID_INPUT" });
  expect(r.json?.message?.length).toBeGreaterThan(0);
  expect(r.calls).toEqual([]);
  expect(existsSync(join(s.out, "result.json"))).toBe(false);
}

describe("code-review の CI の照合（ci-checks）", () => {
  test("ブランチ保護・ルールセット・Workspace 規約の和集合の必須のチェックが、同じ head ですべて成功なら成功", async () => {
    const s = setup();
    const r = await run(s, github());
    expectVerdict(r, "成功");
    expect(r.json).toMatchObject({ repository: REPO, base: BASE, head: HEAD });
    const observedAt = r.json?.observedAt ?? "";
    expect(new Date(observedAt).toISOString()).toBe(observedAt);
    // 同じ context と app の項目は1件にまとめて出典を並べる。ブランチ保護の contexts は checks の写しなので重ねない
    expect(summary(r)).toEqual([
      { context: "rspec", appId: APP, sources: ["branch-protection", "rulesets"], result: "成功" },
      { context: "lint", appId: null, sources: ["rulesets", "workspace-rules"], result: "成功" },
      { context: "typecheck", appId: null, sources: ["workspace-rules"], result: "成功" },
    ]);
    expect(r.json?.sources).toMatchObject({
      branchProtection: { status: "read", checks: [{ context: "rspec", appId: APP }] },
      rulesets: { status: "read", checks: [{ context: "rspec", appId: APP }, { context: "lint", appId: null }] },
      workspaceRules: { status: "read", checks: [{ context: "lint", appId: null }, { context: "typecheck", appId: null }] },
    });
    expect(r.json?.required?.[0]?.runs).toEqual([
      {
        kind: "check-run",
        id: 1,
        name: "rspec",
        status: "completed",
        conclusion: "success",
        appId: APP,
        url: `https://github.com/${REPO}/actions/runs/7/job/1`,
        completedAt: "2026-11-13T01:00:00Z",
      },
    ]);
    expect(r.json?.required?.[2]?.runs).toMatchObject([{ kind: "status", id: 11, name: "typecheck", conclusion: "success", url: "https://ci.example.com/builds/11" }]);

    // 記録: 標準出力と同じ result.json と、gh の生の応答。結果の files に各ファイルの sha256
    expect(readFileSync(join(s.out, "result.json"), "utf8")).toBe(r.stdout);
    const recorded = ["branch.json", "check-runs.ndjson", "commit.json", "repo.json", "rules.json", "statuses.ndjson"];
    expect(readdirSync(s.out).sort()).toEqual([...recorded, "result.json"].sort());
    expect(Object.keys(r.json?.files ?? {}).sort()).toEqual(recorded);
    for (const name of recorded) expect(r.json?.files?.[name]).toBe(sha256(readFileSync(join(s.out, name))));
    // ページを跨いだ一覧も壊さずに読む（1行1件）
    expect(readFileSync(join(s.out, "check-runs.ndjson"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(s.out, "rules.json"), "utf8"))).toHaveLength(2);

    expectReadOnly(r, s);
  });

  test("必須のチェックの1件に check run も commit status も無ければ、その項目も全体も結果なし", async () => {
    const s = setup();
    const r = await run(s, github({ statuses: [] }));
    expectVerdict(r, "結果なし");
    expect(resultOf(r, "typecheck")).toBe("結果なし");
    expect(r.json?.required?.find((item) => item.context === "typecheck")?.runs).toEqual([]);
    expect(r.json?.reason).toContain("typecheck");
  });

  test.each(["failure", "neutral", "skipped", "cancelled", "timed_out", "action_required", "stale", "startup_failure"])(
    "check run の結論が %s なら失敗（成功にしない）",
    async (conclusion) => {
      const s = setup();
      const r = await run(s, github({ checkRuns: [checkRun(1, "rspec", { conclusion }), checkRun(2, "lint")] }));
      expectVerdict(r, "失敗");
      expect(resultOf(r, "rspec")).toBe("失敗");
      expect(r.json?.required?.[0]?.runs[0]?.conclusion).toBe(conclusion);
      expect(r.json?.reason).toContain("rspec");
    },
  );

  test.each(["failure", "error"])("commit status が %s なら失敗", async (state) => {
    const s = setup();
    const r = await run(s, github({ statuses: [commitStatus(11, "typecheck", state)] }));
    expectVerdict(r, "失敗");
    expect(resultOf(r, "typecheck")).toBe("失敗");
  });

  test("同じ名前の候補のどれかが失敗なら、ほかが成功・未完了でも失敗。失敗は未確定・結果なしより優先する", async () => {
    const s = setup();
    const r = await run(
      s,
      github({
        checkRuns: [checkRun(1, "rspec"), checkRun(2, "lint", { status: "in_progress" })],
        statuses: [commitStatus(11, "lint", "failure")],
      }),
    );
    expectVerdict(r, "失敗");
    expect(resultOf(r, "lint")).toBe("失敗");
    expect(resultOf(r, "typecheck")).toBe("結果なし");
  });

  test.each(["in_progress", "queued"])("check run が %s なら未確定", async (status) => {
    const s = setup();
    const r = await run(s, github({ checkRuns: [checkRun(1, "rspec", { status }), checkRun(2, "lint")] }));
    expectVerdict(r, "未確定");
    expect(resultOf(r, "rspec")).toBe("未確定");
    expect(r.json?.required?.[0]?.runs[0]).toMatchObject({ status, conclusion: null });
  });

  test("commit status が pending なら未確定。未確定は結果なしより優先する", async () => {
    const s = setup();
    const r = await run(s, github({ checkRuns: [checkRun(1, "rspec")], statuses: [commitStatus(11, "typecheck", "pending")] }));
    expectVerdict(r, "未確定");
    expect(resultOf(r, "typecheck")).toBe("未確定");
    expect(resultOf(r, "lint")).toBe("結果なし");
  });

  test("3つの出典のどれにも必須のチェックが無ければ、CI がすべて成功でも必須のチェックなし", async () => {
    const s = setup(UNREGISTERED);
    const r = await run(s, github({ branch: { pages: [{ name: BASE, protected: false }] }, rules: { pages: [[]] } }));
    expectVerdict(r, "必須のチェックなし");
    expect(r.json?.required).toEqual([]);
    expect(r.json?.sources).toMatchObject({
      branchProtection: { status: "none", checks: [] },
      rulesets: { status: "none", checks: [] },
      workspaceRules: { status: "none", checks: [] },
    });

    // 保護されていても、必須のステータスチェックの強制が off なら0件。規約に節が無ければ0件
    const t = setup("# 作業規約\n\n## レビュー\n\n- 日本語で書く\n");
    const off = await run(
      t,
      github({ branch: protectedBranch({ enforcement_level: "off", contexts: ["rspec"], checks: [{ context: "rspec", app_id: null }] }), rules: { pages: [[]] } }),
    );
    expectVerdict(off, "必須のチェックなし");
    expect(off.json?.sources?.branchProtection.status).toBe("none");
    expect(off.json?.sources?.workspaceRules.status).toBe("none");
  });

  test("保護されたブランチの必須のステータスチェックが見えなければ、ほかが成功でも必須のチェックを決められず", async () => {
    const s = setup();
    const r = await run(s, github({ branch: { pages: [{ name: BASE, protected: true, protection: { enabled: true } }] } }));
    expectVerdict(r, "必須のチェックを決められず");
    expect(r.json?.sources?.branchProtection.status).toBe("undetermined");
    // 読めた出典の項目は照合する
    expect(summary(r)?.map((item) => item.result)).toEqual(["成功", "成功", "成功"]);
  });

  test("ブランチ保護やルールセットの取得が失敗したら必須のチェックを決められずにし、gh の失敗を errors.txt に残す", async () => {
    const s = setup();
    const missing = await run(s, github({ branch: { status: 404, message: "Branch not found" } }));
    expectVerdict(missing, "必須のチェックを決められず");
    expect(missing.json?.sources?.branchProtection.status).toBe("undetermined");
    expect(readFileSync(join(s.out, "errors.txt"), "utf8")).toContain("Branch not found");
    expect(missing.json?.files?.["errors.txt"]).toBe(sha256(readFileSync(join(s.out, "errors.txt"))));
    expect(existsSync(join(s.out, "branch.json"))).toBe(false);

    const t = setup();
    const broken = await run(t, github({ rules: { status: 500, message: "Server Error" } }));
    expectVerdict(broken, "必須のチェックを決められず");
    expect(broken.json?.sources?.rulesets.status).toBe("undetermined");
  });

  test("リポジトリを決められない、または基点がブランチ名でない（SHA）なら必須のチェックを決められず", async () => {
    const s = setup();
    const noRepo = await run(s, github({ repo: null }));
    expectVerdict(noRepo, "必須のチェックを決められず");
    expect(noRepo.json?.repository).toBeNull();

    const t = setup();
    const sha = await run(t, github(), argv(t, { base: OTHER_SHA }));
    expectVerdict(sha, "必須のチェックを決められず");
    expect(sha.json?.sources?.branchProtection.status).toBe("undetermined");
    expect(sha.json?.sources?.rulesets.status).toBe("undetermined");
  });

  test.each([404, 422])("head が GitHub に無い（commits/{sha} が %i）なら結果なしにし、check run を読まない", async (status) => {
    const s = setup();
    const r = await run(s, github({ commit: { status, message: "No commit found for SHA" } }));
    expectVerdict(r, "結果なし");
    expect(summary(r)?.map((item) => item.result)).toEqual(["結果なし", "結果なし", "結果なし"]);
    expect(r.calls.some((call) => call.args.some((a) => a.includes("check-runs") || a.includes("/status")))).toBe(false);
    expect(r.json?.reason).toContain(HEAD);
  });

  test("commits/{sha} が別の SHA を返したら、head が GitHub に無いとして結果なし", async () => {
    const s = setup();
    const r = await run(s, github({ commit: { pages: [{ sha: OTHER_SHA }] } }));
    expectVerdict(r, "結果なし");
  });

  test("check run や commit status の取得が失敗したら取得できず", async () => {
    const s = setup();
    const r = await run(s, github({ checkRunsApi: { status: 502, message: "Bad Gateway" } }));
    expectVerdict(r, "取得できず");
    expect(readFileSync(join(s.out, "errors.txt"), "utf8")).toContain("Bad Gateway");

    const t = setup();
    expectVerdict(await run(t, github({ statusApi: { status: 500, message: "Server Error" } })), "取得できず");
  });

  test("app 指定のある必須のチェックは、別の app の同名の check run や commit status では満たさない", async () => {
    const s = setup();
    const r = await run(
      s,
      github({
        checkRuns: [checkRun(1, "rspec", { appId: 999 }), checkRun(2, "lint")],
        statuses: [commitStatus(11, "typecheck", "success"), commitStatus(12, "rspec", "success")],
      }),
    );
    expectVerdict(r, "結果なし");
    expect(resultOf(r, "rspec")).toBe("結果なし");
    expect(r.json?.required?.[0]?.runs).toEqual([]);

    // app 指定の無い必須のチェックは、どの app の check run でも commit status でも満たす
    const t = setup();
    const any = await run(t, github({ checkRuns: [checkRun(1, "rspec"), checkRun(2, "lint", { appId: 999 })] }));
    expectVerdict(any, "成功");
  });

  test("head_sha が head と違う check run は使わない", async () => {
    const s = setup();
    const r = await run(s, github({ checkRuns: [checkRun(1, "rspec"), checkRun(2, "lint", { headSha: OTHER_SHA })] }));
    expectVerdict(r, "結果なし");
    expect(resultOf(r, "lint")).toBe("結果なし");
    expect(r.json?.required?.[1]?.runs).toEqual([]);
  });

  test("Workspace 規約の「必須のチェック」の節: 見出しの級・* の箇条書き・バッククォート・複数の節を読み、ほかの節の箇条書きは読まない", async () => {
    const s = setup(
      [
        "# 作業規約",
        "",
        "### 必須のチェック",
        "",
        "- `rspec`",
        "* lint",
        "  - 字下げした補足は名前にしない",
        "",
        "## テスト",
        "",
        "- e2e",
        "",
        "#必須のチェック",
        "- typecheck",
        "- `lint`",
        "",
      ].join("\n"),
    );
    const r = await run(
      s,
      github({
        branch: { pages: [{ name: BASE, protected: false }] },
        rules: { pages: [[]] },
        checkRuns: [checkRun(1, "rspec"), checkRun(2, "lint"), checkRun(3, "e2e", { conclusion: "failure" })],
      }),
    );
    expectVerdict(r, "成功");
    expect(summary(r)).toEqual([
      { context: "rspec", appId: null, sources: ["workspace-rules"], result: "成功" },
      { context: "lint", appId: null, sources: ["workspace-rules"], result: "成功" },
      { context: "typecheck", appId: null, sources: ["workspace-rules"], result: "成功" },
    ]);
    expect(r.json?.sources?.workspaceRules.status).toBe("read");
  });

  test("--out が無ければ作って記録する", async () => {
    const s = setup();
    const out = join(s.t, "fresh/nested/ci");
    const r = await run(s, github(), argv(s, { out }));
    expectVerdict(r, "成功");
    expect(readFileSync(join(out, "result.json"), "utf8")).toBe(r.stdout);
  });

  test("引数の誤り（相対パス・SHA の形式・空でない --out・読めない --rules・足りない引数）は gh を呼ばずに終了コード 2 と INVALID_INPUT", async () => {
    const s = setup();
    const base = argv(s);
    const replace = (key: string, value: string) => base.map((a, i) => (base[i - 1] === key ? value : a));
    const cases = [
      replace("--repo", "repo"),
      replace("--out", "parent/ci/1"),
      replace("--rules", "workspace-rules.md"),
      replace("--rules", join(s.t, "missing.md")),
      replace("--head", HEAD.slice(0, 12)),
      replace("--head", "g".repeat(40)),
      replace("--base", ""),
      replace("--base", "-x"),
      base.slice(0, -2),
      [...base, "--extra", "x"],
    ];
    for (const args of cases) {
      const r = await run(s, github(), args);
      expectInvalid(r, s);
    }

    mkdirSync(s.out, { recursive: true });
    writeFileSync(join(s.out, "result.json"), "previous\n");
    const used = await run(s, github());
    expect({ exitCode: used.exitCode, code: used.json?.code }).toEqual({ exitCode: 2, code: "INVALID_INPUT" });
    expect(used.calls).toEqual([]);
    expect(readFileSync(join(s.out, "result.json"), "utf8")).toBe("previous\n");
  });
});
