// 禁止操作を止める制御（nod のリポジトリの omp/control/rules.json と、それを読む制御の拡張・専用ランチャー）を、外から確かめる。
// 適用・解除・状態の表示はプロセスとして起動し（helpers.ts の一時の置き場）、適用した写しの制御の拡張は OMP の代わりに
// extension-driver.ts で読み込んで、実行時の上書きと tool_call・before_subagent_spawn の戻り値を見る。拡張を読み込むプロセスは、
// 写しのサンドボックスのプロファイル（control/sandbox.sb）で閉じ込めて起動する（閉じ込めずに起動すると全ツールを遮断するため）。
// bash.patterns の照合そのものは OMP の実装なので、ここではパターンが実行時の層に入ることまでを確かめる（当たり方は実際の OMP で確かめる）。
// サンドボックスの信頼境界と、omp を起動する前の組の検証は、写しの専用ランチャー（bin/omp）を実際に実行し、偽の omp が起動されたか、
// その中からの書き込みが拒否されるかで確かめる。
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionResult, type ExtensionScenario, git, HARNESS_ENV, MAIN, put, REPO_RULES, type Run, type Sandbox, snapshot, SUB, synced } from "./helpers";

const GRANDCHILD = { kind: "sub", name: "poteto-agent", depth: 2 } as const;

// 写しの中の位置（データ置き場は macOS の /var と /private/var のような別名を解いた形で書かれる）
function work(sb: Sandbox): string {
  return join(realpathSync(sb.dataDir), "pstack-omp");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// 利用者の config.yml が在る状態で適用した sandbox（適用は config.yml を書かない）
async function applied(): Promise<Sandbox> {
  const sb = await synced();
  put(sb.configPath, "theme: dark\n");
  const run = await sb.run("apply");
  if (run.exitCode !== 0) throw new Error(`適用に失敗: ${run.stderr}`);
  return sb;
}

function run(sb: Sandbox, scenario: Partial<ExtensionScenario> & Pick<ExtensionScenario, "sessions">, confine: { profile?: string; launcher?: string; cwd?: string } = { profile: profile(sb) }) {
  return sb.extension(confine).run({ settings: {}, ...scenario });
}

// 制御の拡張が実行時の層の extensions に入れる、写しの制御の拡張のファイル
function entry(sb: Sandbox): string {
  return join(work(sb), "omp", "control", "index.ts");
}

// 写しのサンドボックスのプロファイル
function profile(sb: Sandbox): string {
  return join(sb.copy, "control", "sandbox.sb");
}

// 利用者が既に持っている承認の設定と bash のパターン（allow が先にあっても、規則の deny が勝つように先頭に入ること）
const USER_APPROVAL = { read: "allow", eval: "allow" };
const USER_PATTERNS = [
  { match: "git *", approval: "allow" },
  { match: "rm *", approval: "prompt" },
];

describe("規則の上書きを、読み込みの設定と同じ処理で入れる", () => {
  test("適用の後のメインのセッションで、読み込みの設定と同じ時点（factory）に、eval の拒否と bash の拒否のパターンが実行時の層に入り、利用者の値は後ろに保たれる", async () => {
    const sb = await applied();
    const agentDir = realpathSync(sb.agentDir);

    const result = await run(sb, {
      settings: { extensions: [entry(sb)], "tools.approval": USER_APPROVAL, "bash.patterns": USER_PATTERNS },
      sessions: [{ agent: MAIN, toolCalls: 0 }],
    });

    expect(new Set(result.overrides.map(({ session, phase }) => `${session}:${phase}`))).toEqual(new Set(["0:factory"]));
    const atStart = result.effectiveAtStart[0]!;
    expect(atStart["tools.approval"]).toEqual({ read: "allow", eval: "deny" });
    const patterns = atStart["bash.patterns"] as { match: string; approval: string }[];
    expect(patterns.slice(-2)).toEqual(USER_PATTERNS);
    const denies = patterns.slice(0, -2);
    expect(denies.every((p) => p.approval === "deny")).toBe(true);
    expect(denies.map((p) => p.match)).toEqual(expect.arrayContaining(["*git push", "*git push *", "*git -* push *", "*gh pr create*", "*gh api* --method*", "*origin pr merge*", "*omp config set*", "*pstack-omp/omp*"]));
    // 置き場のプレースホルダは、組の記録の OMP の設定の置き場に解決される
    expect(denies.map((p) => p.match)).toContain(`*${agentDir}/config.yml*`);
    expect(denies.some((p) => p.match.includes("{"))).toBe(false);
    // 読み込みの設定も同じ時点に入っている
    expect(atStart.extensions).toContain(join(work(sb), "omp", "content"));
  });

  test("値が既に同じでも、実行時の層から来ていなければ、固定する全キーを実行時の層に書く。実行時の層の同じ値なら書き直さず、何度計算しても同じ値になる", async () => {
    const sb = await applied();
    const first = await run(sb, {
      settings: { extensions: [entry(sb)], "tools.approval": USER_APPROVAL, "bash.patterns": USER_PATTERNS },
      sessions: [{ agent: MAIN, toolCalls: 0 }],
    });

    const fromOverlay = await run(sb, { settings: first.effective, provenance: "overlay", sessions: [{ agent: MAIN, toolCalls: 0 }] });
    const fromRuntime = await run(sb, { settings: first.effective, provenance: "runtime", sessions: [{ agent: MAIN, toolCalls: 0 }] });

    const all = ["bash.patterns", "disabledExtensions", "extensions", "skills.customDirectories", "skills.manualSkills", "tools.approval"];
    expect(fromOverlay.overrides.map(({ id }) => id).sort()).toEqual(all);
    expect(fromOverlay.effective).toEqual(first.effective);
    expect(fromRuntime.overrides).toEqual([]);
    expect(fromRuntime.effective).toEqual(first.effective);
  });
});

describe("tool_call で構造化された引数を検査する", () => {
  test("github ツールの pr_create と pr_push は、メインでも子でも拒否し、読む操作は通す", async () => {
    const sb = await applied();
    const calls = [
      { toolName: "github", input: { op: "pr_create", title: "x" } },
      { toolName: "github", input: { op: "pr_push" } },
      { toolName: "github", input: { op: "repo_view" } },
      { toolName: "github", input: { op: "pr_checkout", pr: "1" } },
    ];

    const result = await run(sb, {
      sessions: [
        { agent: MAIN, toolCalls: calls },
        { agent: SUB, toolCalls: calls },
      ],
    });

    for (const session of result.toolCalls) {
      expect(session.map((r) => r?.block ?? false)).toEqual([true, true, false, false]);
      expect(session[0]?.reason).toContain("pr_create");
    }
  });

  test("task の isolated: true は誰が起動しても拒否し、子と孫が起動できるエージェントは poteto-agent と既定の task だけ", async () => {
    const sb = await applied();
    const task = (items: Record<string, unknown>[]) => ({ toolName: "task", input: { context: "c", tasks: items.map((item) => ({ task: "t", ...item })) } });
    const calls = [
      task([{ isolated: true }]),
      { toolName: "task", input: { task: "t", isolated: true } },
      task([{ agent: "scout" }]),
      task([{ agent: "poteto-agent" }, {}, { agent: "task" }]),
      task([{ agent: "poteto-agent" }, { agent: "Explore" }]),
      { toolName: "task", input: { task: "t", agent: "reviewer" } },
    ];

    const result = await run(sb, {
      sessions: [
        { agent: MAIN, toolCalls: calls },
        { agent: SUB, toolCalls: calls },
        { agent: GRANDCHILD, toolCalls: calls },
      ],
    });

    const blocked = result.toolCalls.map((session) => session.map((r) => r?.block ?? false));
    expect(blocked[0]).toEqual([true, true, false, false, false, false]);
    expect(blocked[1]).toEqual([true, true, true, false, true, true]);
    expect(blocked[2]).toEqual(blocked[1]);
    expect(result.toolCalls[1]![2]?.reason).toContain("scout");
  });

  test("子と孫が起動しようとする子のエージェントは、実行基盤が渡すエージェントの名前で検査する（before_subagent_spawn）", async () => {
    const sb = await applied();
    const spawns = ["scout", "poteto-agent", "task"];

    const result = await run(sb, {
      sessions: [
        { agent: MAIN, toolCalls: 0, spawns },
        { agent: SUB, toolCalls: 0, spawns },
        { agent: GRANDCHILD, toolCalls: 0, spawns },
      ],
    });

    expect(result.spawns.map((session) => session.map((r) => r?.block ?? false))).toEqual([
      [false, false, false],
      [true, false, false],
      [true, false, false],
    ]);
  });

  test("パスを引数に持つ書き込みのツールで、OMP の設定ファイル・エージェント定義の置き場・nod のデータ置き場の pstack-omp には書けない。ほかの場所には書ける", async () => {
    const sb = await applied();
    const cwd = join(sb.root, "repo");
    put(join(cwd, "a.ts"), "a\n");
    const calls = [
      { toolName: "write", input: { path: sb.configPath, content: "x" } },
      { toolName: "write", input: { path: join(sb.agentDir, "agents", "poteto-agent.md"), content: "x" } },
      { toolName: "write", input: { path: join(sb.copy, "control", "rules.json"), content: "{}" } },
      { toolName: "write", input: { path: `[${join(sb.generated, "pstack", "skills", "tdd", "SKILL.md")}#ABCD]`, content: "x" } },
      // cwd からの相対パス
      { toolName: "write", input: { path: "../home/.omp/agent/config.yml", content: "x" } },
      { toolName: "edit", input: { input: `[a.ts#ABCD]\nPUT 1.=1:\n+b\n[${join(sb.agentDir, "agents", "x.md")}#1234]\nPUT 1.=1:\n+x\n` } },
      { toolName: "edit", input: { input: `[a.ts#ABCD]\nMV ../home/.omp/agent/config.yml\n` } },
      { toolName: "edit", input: { input: `*** Begin Patch\n*** Add File: ${join(sb.copy, "x.md")}\n+x\n*** End Patch\n` } },
      { toolName: "edit", input: { path: sb.configPath, old_text: "a", new_text: "b" } },
      { toolName: "ast_edit", input: { ops: [{ pat: "a", out: "b" }], paths: ["a.ts", join(sb.generated, "pstack")] } },
      { toolName: "write", input: { path: join(cwd, "b.ts"), content: "x" } },
      { toolName: "write", input: { path: join(sb.agentDir, "config.yml.bak"), content: "x" } },
      { toolName: "edit", input: { input: "[a.ts#ABCD]\nPUT 1.=1:\n+b\n" } },
      { toolName: "ast_edit", input: { ops: [{ pat: "a", out: "b" }], paths: ["a.ts"] } },
      // 読むだけのツールは検査しない
      { toolName: "read", input: { path: sb.configPath } },
    ];

    const result = await run(sb, { cwd, sessions: [{ agent: MAIN, toolCalls: calls }] });

    expect(result.toolCalls[0]!.map((r) => r?.block ?? false)).toEqual([true, true, true, true, true, true, true, true, true, true, false, false, false, false, false]);
    expect(result.toolCalls[0]![0]?.reason).toContain(realpathSync(sb.configPath));
  });
});

describe("規則が欠けている、読めない、不正なとき", () => {
  const invalid: { name: string; rules: (base: Record<string, unknown>) => unknown }[] = [
    { name: "JSON として読めない", rules: () => "{" },
    { name: "知らないキーがある", rules: (base) => ({ ...base, extra: true }) },
    { name: "eval が deny ではない", rules: (base) => ({ ...base, toolApproval: { eval: "allow" } }) },
    { name: "bash の拒否が空", rules: (base) => ({ ...base, bashDeny: [] }) },
    { name: "書き込めない置き場が無い", rules: (base) => ({ ...base, protectedPaths: undefined }) },
    { name: "知らないプレースホルダがある", rules: (base) => ({ ...base, protectedPaths: ["{user}/x"] }) },
    { name: "どのプロジェクトでも書かせないパスが絶対パス", rules: (base) => ({ ...base, projectPaths: ["/etc/x"] }) },
    { name: "どのプロジェクトでも書かせないパスがプロジェクトの外を指す", rules: (base) => ({ ...base, projectPaths: ["../x"] }) },
    { name: "照合から外す置き場が無い", rules: (base) => ({ ...base, allowPaths: undefined }) },
    { name: "子が起動できるエージェントの型が違う", rules: (base) => ({ ...base, task: { denyIsolated: true, subAgents: "task" } }) },
  ];

  test.each(invalid)("規則が$name: 適用が止まり、OMP の設定と写しは何も変わらない", async ({ rules }) => {
    const sb = await synced();
    const value = rules(JSON.parse(readFileSync(REPO_RULES, "utf8")));
    sb.rules(typeof value === "string" ? value : JSON.stringify(value));

    const apply = await sb.run("apply");

    expect(apply.exitCode).toBe(1);
    expect(apply.stderr).toContain("制御の規則");
    expect(existsSync(sb.configPath)).toBe(false);
    expect(existsSync(sb.copy)).toBe(false);
  });

  const damages: { name: string; damage(sb: Sandbox): void }[] = [
    {
      name: "写しの規則が消えた",
      damage: (sb) => rmSync(join(sb.copy, "control", "rules.json")),
    },
    {
      name: "写しの規則が書き換えられた（sha256 が記録と違う）",
      damage: (sb) => writeFileSync(join(sb.copy, "control", "rules.json"), JSON.stringify({ ...JSON.parse(readFileSync(REPO_RULES, "utf8")), toolApproval: { eval: "deny", bash: "deny" } })),
    },
    {
      name: "組の記録の files に規則が無い",
      damage: (sb) => {
        const path = join(sb.copy, "control", "harness.json");
        const harness = JSON.parse(readFileSync(path, "utf8"));
        delete harness.files["control/rules.json"];
        writeFileSync(path, JSON.stringify(harness));
      },
    },
    {
      name: "写しの規則が不正で、組の記録の sha256 もそれに合わせて書き換えられた",
      damage: (sb) => {
        const rules = join(sb.copy, "control", "rules.json");
        writeFileSync(rules, JSON.stringify({ version: 1 }));
        const path = join(sb.copy, "control", "harness.json");
        const harness = JSON.parse(readFileSync(path, "utf8"));
        harness.files["control/rules.json"] = sha256(rules);
        writeFileSync(path, JSON.stringify(harness));
      },
    },
  ];

  test.each(damages)("$name: 読み込みの設定も規則も入れず、メインでも子でも全ツールと子の起動を理由つきで遮断する", async ({ damage }) => {
    const sb = await applied();
    damage(sb);

    const result = await run(sb, {
      sessions: [
        { agent: MAIN, toolCalls: 2, spawns: ["poteto-agent"] },
        { agent: SUB, toolCalls: 1 },
      ],
    });

    expect(result.overrides).toEqual([]);
    expect(result.toolCalls.flat()).toHaveLength(3);
    for (const call of [...result.toolCalls.flat(), ...result.spawns.flat()]) {
      expect(call?.block).toBe(true);
      expect(call?.reason).toContain("ツールを実行しません");
    }
    expect(result.harnessEnv).toBeNull();
  });
});

describe("worker thread の子", () => {
  test("メインのスレッドは検証した組の記録の sha256 を環境変数で渡し、worker thread の子はそれが写しの組の記録と同じときだけツールを通す", async () => {
    const sb = await applied();
    const harness = sha256(join(sb.copy, "control", "harness.json"));

    const main = await run(sb, { sessions: [{ agent: MAIN, toolCalls: 0 }] });
    const same = await run(sb, { mirror: true, env: { [HARNESS_ENV]: harness }, sessions: [{ agent: SUB, toolCalls: 1 }] });
    const changed = await run(sb, { mirror: true, env: { [HARNESS_ENV]: "0".repeat(64) }, sessions: [{ agent: SUB, toolCalls: 1 }] });

    expect(main.harnessEnv).toBe(harness);
    expect(same.toolCalls).toEqual([[null]]);
    expect(same.overrides).toEqual([]);
    expect(changed.toolCalls[0]![0]?.block).toBe(true);
    expect(changed.toolCalls[0]![0]?.reason).toContain("ツールを実行しません");
  });
});

describe("状態の表示", () => {
  test("制御の規則の版と sha256、写しの規則がリポジトリの規則と同じかを表示する", async () => {
    const sb = await applied();

    const same = await sb.run("status");
    sb.rules(JSON.stringify({ ...JSON.parse(readFileSync(REPO_RULES, "utf8")), toolApproval: { eval: "deny", bash: "deny" } }));
    const changed = await sb.run("status");

    expect(same.exitCode).toBe(0);
    expect(same.stdout).toContain(`制御の規則 ${work(sb)}/omp/control/rules.json: 版 1、sha256 ${sha256(REPO_RULES)}`);
    expect(same.stdout).toContain("リポジトリの規則と一致しています");
    expect(changed.stdout).toContain("リポジトリの規則と違います");
  });
});

describe("解除", () => {
  test("解除すると、制御の規則と専用ランチャーも写しと一緒に消え、OMP の設定は変わらない", async () => {
    const sb = await applied();

    expect((await sb.run("remove")).exitCode).toBe(0);

    expect(existsSync(join(sb.copy, "control", "rules.json"))).toBe(false);
    expect(existsSync(sb.launcher)).toBe(false);
    expect(readFileSync(sb.configPath, "utf8")).toBe("theme: dark\n");
  });
});

describe("サンドボックスの信頼境界", () => {
  test("閉じ込めずに起動したプロセスでは、メインでも子でも全ツールと子の起動を遮断し、理由に写しの専用ランチャーと書けてしまう置き場を出す", async () => {
    const sb = await applied();

    const result = await run(
      sb,
      {
        sessions: [
          { agent: MAIN, toolCalls: 2, spawns: ["poteto-agent"] },
          { agent: SUB, toolCalls: 1, spawns: ["task"] },
        ],
      },
      {},
    );

    expect(result.overrides).toEqual([]);
    expect(result.toolCalls.flat()).toHaveLength(3);
    for (const call of [...result.toolCalls.flat(), ...result.spawns.flat()]) {
      expect(call?.block).toBe(true);
      expect(call?.reason).toContain(`${work(sb)}/omp/bin/omp から起動してください`);
      expect(call?.reason).toContain(realpathSync(sb.configPath));
    }
    expect(result.notices.join("\n")).toContain("サンドボックスに閉じ込められていません");
    expect(result.harnessEnv).toBeNull();
  });

  test("守る集合の一部（config.yml）を拒否しない弱いプロファイルで閉じ込めても、遮断し、理由にその置き場を出す", async () => {
    const sb = await applied();
    const config = realpathSync(sb.configPath);
    const weak = join(sb.root, "weak.sb");
    const lines = readFileSync(profile(sb), "utf8").split("\n");
    writeFileSync(weak, lines.filter((line) => !line.includes(`"${config}"`)).join("\n"));
    expect(lines.some((line) => line.includes(`"${config}"`))).toBe(true);

    const result = await run(sb, { sessions: [{ agent: MAIN, toolCalls: 1 }] }, { profile: weak });

    expect(result.overrides).toEqual([]);
    expect(result.toolCalls[0]![0]?.block).toBe(true);
    expect(result.toolCalls[0]![0]?.reason).toContain(config);
  });

  const weakProfiles: { name: string; drops(sb: Sandbox, line: string): boolean; place(sb: Sandbox): string }[] = [
    {
      name: "まだ無い守る置き場（OMP の設定の置き場の hooks）",
      drops: (sb, line) => line.includes(`"${join(realpathSync(sb.agentDir), "hooks")}"`),
      place: (sb) => join(realpathSync(sb.agentDir), "hooks"),
    },
    {
      name: "どのプロジェクトでも書かせないパス（.omp/ など）",
      drops: (_, line) => line.includes("(regex "),
      place: (sb) => join(realpathSync(sb.project), ".omp"),
    },
  ];

  test.each(weakProfiles)("$name を拒否しない弱いプロファイルで閉じ込めても、遮断し、理由にその置き場を出し、試しで作ったものを残さない", async ({ drops, place }) => {
    const sb = await applied();
    const weak = join(sb.root, "weak.sb");
    const lines = readFileSync(profile(sb), "utf8").split("\n");
    expect(lines.some((line) => drops(sb, line))).toBe(true);
    writeFileSync(weak, lines.filter((line) => !drops(sb, line)).join("\n"));
    const agentDir = snapshot(sb.agentDir);
    const ompDir = readdirSync(join(sb.home, ".omp")).sort();

    const result = await run(sb, { sessions: [{ agent: MAIN, toolCalls: 1 }] }, { profile: weak });

    expect(result.overrides).toEqual([]);
    expect(result.toolCalls[0]![0]?.block).toBe(true);
    expect(result.toolCalls[0]![0]?.reason).toContain(place(sb));
    expect(readdirSync(sb.project)).toEqual([]);
    expect(existsSync(join(sb.agentDir, "hooks"))).toBe(false);
    expect(snapshot(sb.agentDir)).toEqual(agentDir);
    expect(readdirSync(join(sb.home, ".omp")).sort()).toEqual(ompDir);
  });

  test("同じ利用者が書き込みの権限を外した親（OMP の設定の置き場）の下のまだ無い守る置き場（hooks）を拒否しない弱いプロファイルでは、作成の EACCES を閉じ込めとみなさず遮断する", async () => {
    const sb = await applied();
    const hooks = join(realpathSync(sb.agentDir), "hooks");
    const weak = join(sb.root, "weak.sb");
    const lines = readFileSync(profile(sb), "utf8").split("\n");
    expect(lines.some((line) => line.includes(`"${hooks}"`))).toBe(true);
    writeFileSync(weak, lines.filter((line) => !line.includes(`"${hooks}"`)).join("\n"));
    const mode = statSync(sb.agentDir).mode & 0o7777;
    chmodSync(sb.agentDir, 0o555);
    let result: ExtensionResult;
    try {
      result = await run(sb, { sessions: [{ agent: MAIN, toolCalls: 1 }] }, { profile: weak });
    } finally {
      chmodSync(sb.agentDir, mode);
    }

    expect(result.overrides).toEqual([]);
    expect(result.toolCalls[0]![0]?.block).toBe(true);
    expect(result.toolCalls[0]![0]?.reason).toContain(hooks);
    expect(existsSync(hooks)).toBe(false);
  });

  test("在るプロジェクトの .omp の中に書ける弱いプロファイル（.omp そのものだけを拒否する）では遮断し、試しで作ったものを残さない", async () => {
    const sb = await applied();
    const omp = join(realpathSync(sb.project), ".omp");
    mkdirSync(omp);
    const tmp = join(sb.root, "tmp");
    mkdirSync(tmp);
    const whole = String.raw`(regex #"/\.omp(/|$)")`;
    const weak = join(sb.root, "weak.sb");
    const lines = readFileSync(profile(sb), "utf8").split("\n");
    expect(lines.some((line) => line.includes(whole))).toBe(true);
    writeFileSync(weak, lines.map((line) => line.replace(whole, String.raw`(regex #"/\.omp$")`)).join("\n"));

    const result = await run(sb, { sessions: [{ agent: MAIN, toolCalls: 1 }], env: { TMPDIR: tmp } }, { profile: weak });

    expect(result.overrides).toEqual([]);
    expect(result.toolCalls[0]![0]?.block).toBe(true);
    expect(result.toolCalls[0]![0]?.reason).toContain(omp);
    expect(readdirSync(omp)).toEqual([]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test(".claude が無いプロジェクトでも、.claude の設定とコードの置き場を拒否しない弱いプロファイルでは遮断し、正しいプロファイルでは通す。どちらもプロジェクトと一時ディレクトリに試しのものを残さない", async () => {
    const sb = await applied();
    const tmp = join(sb.root, "tmp");
    mkdirSync(tmp);
    const claude = (line: string) => line.includes(String.raw`/\.claude/`);
    const weak = join(sb.root, "weak.sb");
    const lines = readFileSync(profile(sb), "utf8").split("\n");
    expect(lines.some(claude)).toBe(true);
    writeFileSync(weak, lines.filter((line) => !claude(line)).join("\n"));
    const scenario = { sessions: [{ agent: MAIN, toolCalls: 1 }], env: { TMPDIR: tmp } };

    const loose = await run(sb, scenario, { profile: weak });
    const strict = await run(sb, scenario);

    expect(loose.overrides).toEqual([]);
    expect(loose.toolCalls[0]![0]?.block).toBe(true);
    expect(loose.toolCalls[0]![0]?.reason).toContain(join(realpathSync(sb.project), ".claude", "settings.json"));
    expect(strict.toolCalls[0]![0]).toBeNull();
    expect(readdirSync(sb.project)).toEqual([]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  test("作業ディレクトリの祖先のプロジェクトの .omp が閉じ込めの外の書ける置き場へのリンクなら、専用ランチャーは omp を起動せず、制御の拡張もツールと子の起動を遮断し、理由にそのパスを出し、試しのものを残さない。本物の .omp なら起動する", async () => {
    const sb = await applied();
    const repo = join(sb.root, "repo");
    const sub = join(repo, "src", "deep");
    const outside = join(sb.root, "outside");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(sub, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(repo, ".omp"));
    const omp = join(realpathSync(repo), ".omp");
    const scenario = { sessions: [{ agent: MAIN, toolCalls: 1, spawns: ["poteto-agent"] }] };

    const linked = await sb.launchWith({ cwd: sub }, "printf started");
    const linkedResult = await run(sb, scenario, { profile: profile(sb), cwd: sub });
    const leftovers = readdirSync(outside);
    rmSync(join(repo, ".omp"));
    mkdirSync(join(repo, ".omp"));
    const real = await sb.launchWith({ cwd: sub }, "printf started");
    const realResult = await run(sb, scenario, { profile: profile(sb), cwd: sub });

    expect(linked.exitCode).not.toBe(0);
    expect(linked.stdout).toBe("");
    expect(linked.stderr).toContain("サンドボックスに閉じ込められていません");
    expect(linked.stderr).toContain(omp);
    expect(linked.stderr).toContain("omp を起動しません");
    expect(linkedResult.overrides).toEqual([]);
    for (const call of [...linkedResult.toolCalls.flat(), ...linkedResult.spawns.flat()]) {
      expect(call?.block).toBe(true);
      expect(call?.reason).toContain(omp);
    }
    expect(leftovers).toEqual([]);
    expect(real.stderr).toBe("");
    expect(real.stdout).toBe("started");
    expect(realResult.toolCalls).toEqual([[null]]);
    expect(realResult.spawns).toEqual([[null]]);
    expect(readdirSync(join(repo, ".omp"))).toEqual([]);
    expect(readdirSync(sub)).toEqual([]);
  });

  test("祖先のプロジェクトの .omp や .claude が、規則の allowPaths の下（ホームの ~/.omp の下）へのリンクでも、書いたままのパスで試すので、専用ランチャーは omp を起動せず、制御の拡張もツールと子の起動を遮断し、理由にそのパスを出し、試しのものを残さない", async () => {
    const sb = await applied();
    const repo = join(sb.root, "repo");
    const sub = join(repo, "src");
    const ompTarget = join(sb.home, ".omp", "project-omp");
    const claudeTarget = join(sb.home, ".omp", "project-claude");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(sub);
    mkdirSync(ompTarget);
    mkdirSync(claudeTarget);
    symlinkSync(ompTarget, join(repo, ".omp"));
    symlinkSync(claudeTarget, join(repo, ".claude"));
    const real = realpathSync(repo);
    const homeOmp = readdirSync(join(sb.home, ".omp")).sort();

    const launched = await sb.launchWith({ cwd: sub }, "printf started");
    const result = await run(sb, { sessions: [{ agent: MAIN, toolCalls: 1, spawns: ["poteto-agent"] }] }, { profile: profile(sb), cwd: sub });

    expect(launched.exitCode).not.toBe(0);
    expect(launched.stdout).toBe("");
    expect(launched.stderr).toContain("サンドボックスに閉じ込められていません");
    expect(launched.stderr).toContain(join(real, ".omp"));
    expect(launched.stderr).toContain(join(real, ".claude", "settings.json"));
    expect(launched.stderr).toContain("omp を起動しません");
    expect(result.overrides).toEqual([]);
    for (const call of [...result.toolCalls.flat(), ...result.spawns.flat()]) {
      expect(call?.block).toBe(true);
      expect(call?.reason).toContain(join(real, ".omp"));
    }
    expect(readdirSync(ompTarget)).toEqual([]);
    expect(readdirSync(claudeTarget)).toEqual([]);
    expect(readdirSync(join(sb.home, ".omp")).sort()).toEqual(homeOmp);
  });

  // sb.root の下の一時のリポジトリ（作業ディレクトリは repo/src、実体がディレクトリの .omp を持つ）。omp は .omp の実パス
  function repository(sb: Sandbox): { repo: string; sub: string; omp: string } {
    const repo = join(sb.root, "repo");
    const sub = join(repo, "src");
    mkdirSync(join(repo, ".git"), { recursive: true });
    mkdirSync(sub);
    mkdirSync(join(repo, ".omp"));
    return { repo: realpathSync(repo), sub, omp: join(realpathSync(repo), ".omp") };
  }

  // 写しのプロファイルに規則を1行足した検査用のプロファイル
  function profileWith(sb: Sandbox, rule: string): string {
    const path = join(sb.root, "probe.sb");
    writeFileSync(path, `${readFileSync(profile(sb), "utf8")}${rule}\n`);
    return path;
  }

  // 専用ランチャーが omp を起動せず、制御の拡張がツールと子の起動を遮断し、どちらも理由に place を出した
  function expectRefused(launched: Run, result: ExtensionResult, place: string): void {
    expect(launched.exitCode).not.toBe(0);
    expect(launched.stdout).toBe("");
    expect(launched.stderr).toContain("サンドボックスに閉じ込められていません");
    expect(launched.stderr).toContain(place);
    expect(launched.stderr).toContain("omp を起動しません");
    expect(result.overrides).toEqual([]);
    expect(result.toolCalls.flat()).toHaveLength(1);
    expect(result.spawns.flat()).toHaveLength(1);
    for (const call of [...result.toolCalls.flat(), ...result.spawns.flat()]) {
      expect(call?.block).toBe(true);
      expect(call?.reason).toContain(place);
    }
  }

  const SCENARIO = { sessions: [{ agent: MAIN, toolCalls: 1, spawns: ["poteto-agent"] }] };

  const outsideLinks: { name: string; link(omp: string, outside: string): string }[] = [
    {
      name: "agents（ディレクトリのリンク）",
      link: (omp, outside) => {
        symlinkSync(outside, join(omp, "agents"));
        return join(omp, "agents");
      },
    },
    {
      name: "agents/poteto-agent.md（ファイルのリンク）",
      link: (omp, outside) => {
        mkdirSync(join(omp, "agents"));
        symlinkSync(join(outside, "poteto-agent.md"), join(omp, "agents", "poteto-agent.md"));
        return join(omp, "agents", "poteto-agent.md");
      },
    },
  ];

  test.each(outsideLinks)("実体のディレクトリのプロジェクトの .omp の下の $name が閉じ込めの外の書ける置き場を指すなら、専用ランチャーは omp を起動せず、制御の拡張もツールと子の起動を遮断し、理由にそのリンクのパスを出し、参照先の中身と一覧を変えず試しのものを残さない", async ({ link }) => {
    const sb = await applied();
    const { sub, omp } = repository(sb);
    const outside = join(sb.root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "poteto-agent.md"), "# 利用者の定義\n");
    const place = link(omp, outside);
    const before = { files: snapshot(outside), mode: statSync(outside).mode, fileMode: statSync(join(outside, "poteto-agent.md")).mode };

    const launched = await sb.launchWith({ cwd: sub }, "printf started");
    const result = await run(sb, SCENARIO, { profile: profile(sb), cwd: sub });

    expectRefused(launched, result, place);
    expect({ files: snapshot(outside), mode: statSync(outside).mode, fileMode: statSync(join(outside, "poteto-agent.md")).mode }).toEqual(before);
    expect(readdirSync(sub)).toEqual([]);
  });

  test("プロジェクトの .omp の下のリンクが、OS が解決でき .omp の中（自分自身の祖先を指すもの、ディレクトリへのリンクの後に .. を通るものを含む）か、閉じ込めで書けない守る集合の中を指すなら、専用ランチャーは omp を起動し、制御の拡張もツールと子の起動を遮断しない", async () => {
    const sb = await applied();
    const { sub, omp } = repository(sb);
    const extensions = join(realpathSync(sb.agentDir), "extensions");
    mkdirSync(extensions, { recursive: true });
    mkdirSync(join(omp, "agents", "nested"), { recursive: true });
    writeFileSync(join(omp, "agents", "poteto-agent.md"), "# 利用者の定義\n");
    symlinkSync(join(omp, "agents", "poteto-agent.md"), join(omp, "agents", "alias.md"));
    symlinkSync(omp, join(omp, "loop"));
    symlinkSync(join(omp, "agents"), join(omp, "a"));
    symlinkSync(join(omp, "a"), join(omp, "b"));
    symlinkSync(extensions, join(omp, "extensions"));
    symlinkSync(realpathSync(sb.configPath), join(omp, "agents", "config.md"));
    // OS は d を .omp/agents/nested に解いてから .. を辿るので、参照先は .omp/agents/poteto-agent.md（在る）
    symlinkSync(join(omp, "agents", "nested"), join(omp, "d"));
    symlinkSync("d/../poteto-agent.md", join(omp, "via"));
    const config = sha256(sb.configPath);

    const launched = await sb.launchWith({ cwd: sub }, "printf started");
    const result = await run(sb, SCENARIO, { profile: profile(sb), cwd: sub });

    expect(launched.stderr).toBe("");
    expect(launched.stdout).toBe("started");
    expect(result.toolCalls).toEqual([[null]]);
    expect(result.spawns).toEqual([[null]]);
    expect(readdirSync(omp).sort()).toEqual(["a", "agents", "b", "d", "extensions", "loop", "via"]);
    expect(readdirSync(join(omp, "agents")).sort()).toEqual(["alias.md", "config.md", "nested", "poteto-agent.md"]);
    expect(readdirSync(join(omp, "agents", "nested"))).toEqual([]);
    expect(readdirSync(extensions)).toEqual([]);
    expect(sha256(sb.configPath)).toBe(config);
  });

  test("リンクの参照先が閉じ込めで書けないディレクトリなら、その下の元へ戻るリンクや自分自身を指すリンクで循環しても試しが終わって遮断せず、その下に解けない互いを指すリンクや書ける置き場へのリンクがあれば遮断し、理由にそのパスを出す", async () => {
    const sb = await applied();
    const { sub, omp } = repository(sb);
    const outside = join(sb.root, "outside");
    const open = join(sb.root, "open");
    mkdirSync(join(outside, "sub"), { recursive: true });
    mkdirSync(open);
    writeFileSync(join(outside, "sub", "poteto-agent.md"), "# 利用者の定義\n");
    symlinkSync(outside, join(omp, "agents"));
    symlinkSync(omp, join(outside, "back"));
    symlinkSync(outside, join(outside, "self"));
    symlinkSync(outside, join(outside, "sub", "up"));
    const strict = profileWith(sb, `(deny file-write* (subpath "${realpathSync(outside)}"))`);
    const confine = { profile: strict, cwd: sub };
    const agents = join(omp, "agents");

    const cyclic = await run(sb, SCENARIO, confine);
    symlinkSync(join(outside, "sub", "b"), join(outside, "sub", "a"));
    symlinkSync(join(outside, "sub", "a"), join(outside, "sub", "b"));
    const mutual = await run(sb, SCENARIO, confine);
    rmSync(join(outside, "sub", "a"));
    rmSync(join(outside, "sub", "b"));
    symlinkSync(open, join(outside, "sub", "open"));
    const writable = await run(sb, SCENARIO, confine);

    expect(cyclic.toolCalls).toEqual([[null]]);
    expect(cyclic.spawns).toEqual([[null]]);
    for (const call of [...mutual.toolCalls.flat(), ...mutual.spawns.flat()]) {
      expect(call?.block).toBe(true);
      expect(call?.reason).toContain(join(agents, "sub", "a"));
    }
    for (const call of [...writable.toolCalls.flat(), ...writable.spawns.flat()]) {
      expect(call?.block).toBe(true);
      expect(call?.reason).toContain(join(agents, "sub", "open"));
    }
    expect(mutual.overrides).toEqual([]);
    expect(writable.overrides).toEqual([]);
    expect(readdirSync(outside).sort()).toEqual(["back", "self", "sub"]);
    expect(readdirSync(join(outside, "sub")).sort()).toEqual(["open", "poteto-agent.md", "up"]);
    expect(readdirSync(open)).toEqual([]);
  });

  test("リンクの参照先の閉じ込めで書けないディレクトリの下が多すぎて確かめきれないなら、制御の拡張はツールと子の起動を遮断し、理由に確かめきれないことを出す", async () => {
    const sb = await applied();
    const { sub, omp } = repository(sb);
    const outside = join(sb.root, "outside");
    mkdirSync(outside);
    for (let i = 0; i <= 10_000; i += 1) writeFileSync(join(outside, `f${i}.md`), "");
    symlinkSync(outside, join(omp, "agents"));
    const strict = profileWith(sb, `(deny file-write* (subpath "${realpathSync(outside)}"))`);

    const result = await run(sb, SCENARIO, { profile: strict, cwd: sub });

    expect(result.overrides).toEqual([]);
    for (const call of [...result.toolCalls.flat(), ...result.spawns.flat()]) {
      expect(call?.block).toBe(true);
      expect(call?.reason).toContain("確かめきれません");
    }
    expect(readdirSync(outside)).toHaveLength(10_001);
  });

  test("プロジェクトの .claude/settings.json が、chmod は拒否されるが中身は書けるファイル（他の利用者の持ち物の代わり）へのリンクなら、制御の拡張はツールと子の起動を遮断し、書き込みの権限の無いファイルへのリンクなら遮断しない。どちらも参照先の中身・mode・mtime は変わらない", async () => {
    const sb = await applied();
    const { repo, sub } = repository(sb);
    const target = join(sb.root, "shared", "settings.json");
    put(target, '{ "permissions": {} }\n');
    mkdirSync(join(repo, ".claude"));
    symlinkSync(target, join(repo, ".claude", "settings.json"));
    const modeDenied = profileWith(sb, `(deny file-write-mode (literal "${realpathSync(target)}"))`);
    const state = () => ({ sha: sha256(target), mode: statSync(target).mode, mtime: statSync(target).mtimeMs });

    const writableBefore = state();
    const writable = await run(sb, SCENARIO, { profile: modeDenied, cwd: sub });
    const writableAfter = state();
    chmodSync(target, 0o444);
    const readOnlyBefore = state();
    const readOnly = await run(sb, SCENARIO, { profile: modeDenied, cwd: sub });
    const readOnlyAfter = state();

    expect(writable.overrides).toEqual([]);
    for (const call of [...writable.toolCalls.flat(), ...writable.spawns.flat()]) {
      expect(call?.block).toBe(true);
      expect(call?.reason).toContain(join(repo, ".claude", "settings.json"));
    }
    expect(readOnly.toolCalls).toEqual([[null]]);
    expect(readOnly.spawns).toEqual([[null]]);
    expect(writableAfter).toEqual(writableBefore);
    expect(readOnlyAfter).toEqual(readOnlyBefore);
  });

  // OS が参照先を解決できないリンク（参照先が無い、循環する、たどる権限が無い）か、在るかを確かめられない要素を置き、そのパスを返す。
  // lock は、ディレクトリをたどれない mode にし、テストの後に戻す
  type Fixture = { root: string; repo: string; omp: string; agentDir: string; lock(dir: string): void };
  const unresolvableLinks: { name: string; reason?: string; link(fx: Fixture): string }[] = [
    {
      name: ".omp の下の参照先が .omp の中で無いリンク",
      link: ({ omp }) => {
        symlinkSync(join(omp, "nothing"), join(omp, "missing"));
        return join(omp, "missing");
      },
    },
    {
      name: ".omp の下の参照先が書ける置き場の中で無いリンク",
      link: ({ root, omp }) => {
        symlinkSync(join(root, "none", "deeper", "agents"), join(omp, "agents"));
        return join(omp, "agents");
      },
    },
    {
      name: ".omp の下の参照先が閉じ込めで書けない守る集合の中で無いリンク",
      link: ({ agentDir, omp }) => {
        mkdirSync(join(agentDir, "extensions"), { recursive: true });
        symlinkSync(join(agentDir, "extensions", "nothing.md"), join(omp, "agents"));
        return join(omp, "agents");
      },
    },
    {
      name: ".omp の下の、ディレクトリへのリンクの後に .. を通り、OS が辿ると参照先が無いリンク（字面で解くと .omp の中の在るファイルになる）",
      link: ({ agentDir, omp }) => {
        mkdirSync(join(agentDir, "extensions"), { recursive: true });
        writeFileSync(join(omp, "lexical.md"), "# 利用者の定義\n");
        symlinkSync(join(agentDir, "extensions"), join(omp, "d"));
        symlinkSync("d/../lexical.md", join(omp, "via"));
        return join(omp, "via");
      },
    },
    {
      name: ".omp の下の互いを指すリンク",
      link: ({ omp }) => {
        symlinkSync(join(omp, "b"), join(omp, "a"));
        symlinkSync(join(omp, "a"), join(omp, "b"));
        return join(omp, "a");
      },
    },
    {
      name: ".omp の下の自分自身を指すリンク",
      link: ({ omp }) => {
        symlinkSync(join(omp, "self"), join(omp, "self"));
        return join(omp, "self");
      },
    },
    {
      name: ".omp の下の、たどる権限の無いディレクトリの中を指すリンク",
      link: ({ root, omp, lock }) => {
        mkdirSync(join(root, "locked", "agents"), { recursive: true });
        lock(join(root, "locked"));
        symlinkSync(join(root, "locked", "agents"), join(omp, "agents"));
        return join(omp, "agents");
      },
    },
    {
      name: "プロジェクトの .claude が参照先の無いリンク（.claude/settings.json の途中）",
      link: ({ root, repo }) => {
        symlinkSync(join(root, "none"), join(repo, ".claude"));
        return join(repo, ".claude");
      },
    },
    {
      name: "プロジェクトの .claude がたどる権限の無いディレクトリ（.claude/settings.json が在るかを確かめられない）",
      reason: "パスを解決できません",
      link: ({ repo, lock }) => {
        mkdirSync(join(repo, ".claude"));
        lock(join(repo, ".claude"));
        return join(repo, ".claude", "settings.json");
      },
    },
  ];

  test.each(unresolvableLinks)("$name は、OS がパスを解決できないので、専用ランチャーは omp を起動せず、制御の拡張もツールと子の起動を遮断し、理由にそのパスと解決できないことを出し、参照先を作らず利用者のファイルを変えない", async ({ link, reason = "参照先を解決できません" }) => {
    const sb = await applied();
    const { repo, sub, omp } = repository(sb);
    const root = realpathSync(sb.root);
    const agentDir = realpathSync(sb.agentDir);
    const locked: string[] = [];
    const lock = (dir: string) => {
      chmodSync(dir, 0o000);
      locked.push(dir);
    };
    try {
      const place = link({ root, repo, omp, agentDir, lock });
      const state = () => ({ root: readdirSync(root).sort(), omp: readdirSync(omp).sort(), agentDir: readdirSync(agentDir).sort(), modes: locked.map((dir) => statSync(dir).mode) });
      const before = state();

      const launched = await sb.launchWith({ cwd: sub }, "printf started");
      const result = await run(sb, SCENARIO, { profile: profile(sb), cwd: sub });

      expectRefused(launched, result, place);
      expect(launched.stderr).toContain(reason);
      for (const call of [...result.toolCalls.flat(), ...result.spawns.flat()]) expect(call?.reason).toContain(reason);
      expect(state()).toEqual(before);
      expect(existsSync(join(root, "none"))).toBe(false);
      expect(existsSync(join(omp, "nothing"))).toBe(false);
      expect(existsSync(join(agentDir, "lexical.md"))).toBe(false);
      expect(existsSync(join(agentDir, "extensions", "nothing.md"))).toBe(false);
      expect(readdirSync(sub)).toEqual([]);
    } finally {
      for (const dir of locked) chmodSync(dir, 0o700);
    }
  });

  test("試しの作業用ディレクトリを一時ディレクトリに作れない（一時ディレクトリが守る集合の中にある）なら、正しいプロファイルでも遮断する", async () => {
    const sb = await applied();

    const result = await run(sb, { sessions: [{ agent: MAIN, toolCalls: 1 }], env: { TMPDIR: work(sb) } });

    expect(result.overrides).toEqual([]);
    expect(result.toolCalls[0]![0]?.block).toBe(true);
    expect(result.toolCalls[0]![0]?.reason).toContain("試しの作業用ディレクトリを作れません");
    expect(readdirSync(work(sb)).sort()).toEqual(["generated", "omp", "upstream"]);
  });

  test("専用ランチャーの中からは、OMP の設定・写し・OMP の設定の置き場・omp の実行ファイル・bun の全体の設定を書き換えられず、解除もできない。守る集合の外には書ける", async () => {
    const sb = await applied();
    const config = readFileSync(sb.configPath);
    const copy = snapshot(sb.copy);
    const omp = readFileSync(sb.ompBin);
    const outside = join(sb.root, "work");
    mkdirSync(outside);

    const attempts = [
      await sb.launch('printf x >> "$1"', sb.configPath),
      await sb.launch("printf '{}' > \"$1\"", join(sb.copy, "control", "rules.json")),
      await sb.launch('mv "$1" "$1.moved"', sb.copy),
      await sb.launch('mv "$1" "$1.moved"', sb.agentDir),
      await sb.launch('mkdir -p "$1" && printf x > "$1/x.ts"', join(sb.agentDir, "extensions")),
      await sb.launch('printf x > "$1"', sb.ompBin),
      await sb.launch("printf 'preload = []' > \"$1\"", join(sb.home, ".bunfig.toml")),
    ];
    const remove = await sb.run("remove", { launcher: true });
    const allowed = await sb.launch('printf ok > "$1/a.txt" && mkdir "$1/d" && mv "$1/a.txt" "$1/d/b.txt"', outside);

    for (const attempt of attempts) {
      expect(attempt.exitCode).not.toBe(0);
      expect(attempt.stderr).toContain("Operation not permitted");
    }
    expect(remove.exitCode).toBe(1);
    expect(remove.stderr).toContain("operation not permitted");
    expect(readFileSync(sb.configPath)).toEqual(config);
    expect(snapshot(sb.copy)).toEqual(copy);
    expect(existsSync(`${sb.copy}.moved`)).toBe(false);
    expect(existsSync(`${sb.agentDir}.moved`)).toBe(false);
    expect(existsSync(join(sb.agentDir, "extensions"))).toBe(false);
    expect(readFileSync(sb.ompBin)).toEqual(omp);
    expect(existsSync(join(sb.home, ".bunfig.toml"))).toBe(false);
    expect(allowed.stderr).toBe("");
    expect(allowed.exitCode).toBe(0);
    expect(readFileSync(join(outside, "d", "b.txt"), "utf8")).toBe("ok");
  });

  test("専用ランチャーの中からは、どのプロジェクトでも OMP と Claude Code の設定・同じプロセスで動くコードの置き場を作れず、OMP の設定の置き場の hooks・tools とプラグインの置き場も作れない。利用者の ~/.omp の下の実行時の書き込みと、プロジェクトの普通のファイルには書ける", async () => {
    const sb = await applied();
    const project = sb.project;

    const attempts = [
      await sb.launch("mkdir -p \"$1/.omp\" && printf 'disabledExtensions:\\n  - extension-module:control\\n' > \"$1/.omp/config.yml\"", project),
      await sb.launch('mkdir -p "$1/.omp/extensions" && printf x > "$1/.omp/extensions/x.ts"', project),
      await sb.launch('mkdir -p "$1/.claude" && printf "{}" > "$1/.claude/settings.json"', project),
      await sb.launch('mkdir -p "$1/.claude/tools" && printf x > "$1/.claude/tools/x.ts"', project),
      await sb.launch('mkdir "$1"', join(sb.agentDir, "hooks")),
      await sb.launch('mkdir "$1"', join(sb.agentDir, "tools")),
      await sb.launch('mkdir "$1"', join(sb.home, ".omp", "plugins")),
      await sb.launch('mkdir -p "$1" && printf x > "$1/x.md"', join(sb.home, ".omp", "agents")),
    ];
    const allowed = await sb.launch(
      'mkdir -p "$1/sessions/p" && printf x > "$1/sessions/p/s.jsonl" && printf x > "$2/README.md" && mkdir -p "$2/.claude" && printf x > "$2/.claude/CLAUDE.md" && printf x > "$2/.omplike"',
      sb.agentDir,
      project,
    );

    for (const attempt of attempts) {
      expect(attempt.exitCode).not.toBe(0);
      expect(attempt.stderr).toContain("Operation not permitted");
    }
    expect(existsSync(join(project, ".omp"))).toBe(false);
    expect(existsSync(join(project, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(project, ".claude", "tools"))).toBe(false);
    expect(existsSync(join(sb.agentDir, "hooks"))).toBe(false);
    expect(existsSync(join(sb.agentDir, "tools"))).toBe(false);
    expect(existsSync(join(sb.home, ".omp", "plugins"))).toBe(false);
    expect(existsSync(join(sb.home, ".omp", "agents"))).toBe(false);
    expect(allowed.stderr).toBe("");
    expect(allowed.exitCode).toBe(0);
    expect(readFileSync(join(sb.agentDir, "sessions", "p", "s.jsonl"), "utf8")).toBe("x");
    expect(readdirSync(project).sort()).toEqual([".claude", ".omplike", "README.md"]);
    expect(readdirSync(join(project, ".claude"))).toEqual(["CLAUDE.md"]);
  });

  test("専用ランチャーの中からは、プロジェクトの .omp を、別名で作ってからの rename、書ける置き場へのリンク、.omp を含むブランチの git checkout でも作れない", async () => {
    const sb = await applied();
    const project = join(sb.root, "repo");
    const outside = join(sb.root, "outside");
    mkdirSync(project);
    mkdirSync(outside);
    git(sb.root, project, "init", "-q", "-b", "main");
    put(join(project, "README.md"), "x");
    git(sb.root, project, "add", "-A");
    git(sb.root, project, "commit", "-q", "-m", "main");
    git(sb.root, project, "checkout", "-q", "-b", "other");
    put(join(project, ".omp", "config.yml"), "disabledExtensions:\n  - extension-module:control\n");
    git(sb.root, project, "add", "-A");
    git(sb.root, project, "commit", "-q", "-m", "other");
    git(sb.root, project, "checkout", "-q", "main");
    expect(existsSync(join(project, ".omp"))).toBe(false);

    const attempts = [
      await sb.launch("cd \"$1\" && mkdir x && printf 'disabledExtensions:\\n  - extension-module:control\\n' > x/config.yml && mv x .omp", project),
      await sb.launch('cd "$1" && ln -s "$2" .omp', project, outside),
      await sb.launch('cd "$1" && git checkout -q other', project),
    ];

    for (const attempt of attempts) {
      expect(attempt.exitCode).not.toBe(0);
      expect(attempt.stderr).toContain("Operation not permitted");
    }
    expect(readdirSync(project)).not.toContain(".omp");
    expect(readdirSync(outside)).toEqual([]);
  });

  test("専用ランチャーの中で読み込むと、規則の上書きが入り、メインでも子でも規則どおりに検査する", async () => {
    const sb = await applied();
    const calls = [
      { toolName: "github", input: { op: "pr_create", title: "x" } },
      { toolName: "github", input: { op: "repo_view" } },
      { toolName: "write", input: { path: sb.configPath, content: "x" } },
      { toolName: "bash", input: { command: "ls" } },
    ];

    const result = await run(
      sb,
      {
        sessions: [
          { agent: MAIN, toolCalls: calls, spawns: ["scout"] },
          { agent: SUB, toolCalls: calls, spawns: ["scout", "poteto-agent"] },
        ],
      },
      { launcher: sb.launcher },
    );

    expect(result.effective["tools.approval"]).toEqual({ eval: "deny" });
    expect(result.toolCalls.map((session) => session.map((r) => r?.block ?? false))).toEqual([
      [true, false, true, false],
      [true, false, true, false],
    ]);
    expect(result.spawns.map((session) => session.map((r) => r?.block ?? false))).toEqual([[false], [true, false]]);
    expect(result.harnessEnv).toBe(sha256(join(sb.copy, "control", "harness.json")));
  });
});

describe("専用ランチャーが omp を起動する前の検証", () => {
  // 組の記録の files の sha256 を、いまの写しのファイルに合わせて書き換える（sha256 の照合を通した上で、ほかの検証で拒否されることを確かめる）
  const rehash = (sb: Sandbox, rel: string): void => {
    const path = join(sb.copy, "control", "harness.json");
    const harness = JSON.parse(readFileSync(path, "utf8"));
    harness.files[rel] = sha256(join(sb.copy, rel));
    writeFileSync(path, JSON.stringify(harness));
  };
  const editHarness = (sb: Sandbox, edit: (harness: Record<string, unknown> & { files: Record<string, string> }) => void): void => {
    const path = join(sb.copy, "control", "harness.json");
    const harness = JSON.parse(readFileSync(path, "utf8"));
    edit(harness);
    writeFileSync(path, JSON.stringify(harness));
  };
  const cases: { name: string; damage?(sb: Sandbox): void; env?(sb: Sandbox): Record<string, string>; shows(sb: Sandbox): string }[] = [
    { name: "写しの規則が消えた", damage: (sb) => rmSync(join(sb.copy, "control", "rules.json")), shows: () => "control/rules.json（無い）" },
    {
      name: "写しの規則が不正で、組の記録の sha256 もそれに合わせて書き換えられた",
      damage: (sb) => {
        writeFileSync(join(sb.copy, "control", "rules.json"), JSON.stringify({ version: 1 }));
        rehash(sb, "control/rules.json");
      },
      shows: (sb) => `規則 ${work(sb)}/omp/control/rules.json が正しくありません`,
    },
    { name: "組の記録が無い", damage: (sb) => rmSync(join(sb.copy, "control", "harness.json")), shows: () => "control/harness.json を読めません" },
    { name: "組の記録が JSON として読めない", damage: (sb) => writeFileSync(join(sb.copy, "control", "harness.json"), "{"), shows: () => "control/harness.json を読めません" },
    { name: "組の記録の形が正しくない", damage: (sb) => editHarness(sb, (harness) => delete harness.bunBin), shows: () => "bunBin が絶対パスではありません" },
    { name: "制御の拡張（control/index.ts）が消えた", damage: (sb) => rmSync(join(sb.copy, "control", "index.ts")), shows: () => "control/index.ts（無い）" },
    {
      name: "写しの読み替え表が書き換えられた",
      damage: (sb) => writeFileSync(join(sb.copy, "content", "skills", "pstack-omp", "SKILL.md"), "書き換えた\n"),
      shows: () => "content/skills/pstack-omp/SKILL.md（sha256 が違う）",
    },
    {
      name: "写しに記録に無いスキルが足された",
      damage: (sb) => put(join(sb.copy, "generated", "pstack", "skills", "extra", "SKILL.md"), "---\nname: extra\n---\n"),
      shows: () => "generated/pstack/skills/extra/SKILL.md（記録に無い）",
    },
    {
      name: "写しのファイルが読めない",
      damage: (sb) => chmodSync(join(sb.copy, "content", "skills", "pstack-omp", "SKILL.md"), 0o000),
      shows: () => "content/skills/pstack-omp/SKILL.md（読めない）",
    },
    {
      name: "組の記録の files から専用ランチャーが外された",
      damage: (sb) => editHarness(sb, (harness) => delete harness.files["bin/omp"]),
      shows: () => "組の記録の files に bin/omp がありません",
    },
    { name: "サンドボックスのプロファイルが消えた", damage: (sb) => rmSync(join(sb.copy, "control", "sandbox.sb")), shows: () => "組を確かめられないので、omp を起動しません" },
    { name: "組の検証の入口（preflight.ts）が消えた", damage: (sb) => rmSync(join(sb.copy, "control", "preflight.ts")), shows: () => "組を確かめられないので、omp を起動しません" },
    {
      name: "組の検証を実行する bun が無い",
      damage: (sb) => writeFileSync(sb.launcher, readFileSync(sb.launcher, "utf8").replaceAll(`'${realpathSync(process.execPath)}'`, `'${join(sb.root, "no-bun")}'`)),
      shows: () => "組を確かめられないので、omp を起動しません",
    },
    {
      name: "プロファイルが守る集合の一部（config.yml）を拒否しないものに書き換えられ、組の記録の sha256 もそれに合わせて書き換えられた",
      damage: (sb) => {
        const config = realpathSync(sb.configPath);
        const lines = readFileSync(profile(sb), "utf8").split("\n");
        writeFileSync(profile(sb), lines.filter((line) => !line.includes(`"${config}"`)).join("\n"));
        rehash(sb, "control/sandbox.sb");
      },
      shows: (sb) => `サンドボックスに閉じ込められていません（このプロセスから書けてしまう置き場: ${realpathSync(sb.configPath)}`,
    },
    { name: "試しの作業用ディレクトリを一時ディレクトリに作れない", env: (sb) => ({ TMPDIR: work(sb) }), shows: () => "試しの作業用ディレクトリを作れません" },
    { name: "OMP の設定の置き場（PI_CODING_AGENT_DIR）が組の記録と違う", env: (sb) => ({ PI_CODING_AGENT_DIR: join(sb.root, "other-agent") }), shows: () => "いまの置き場" },
  ];

  test.each(cases)("$name: 理由を出して非0で終わり、omp を起動しない", async ({ damage, env, shows }) => {
    const sb = await applied();
    damage?.(sb);

    const run = await sb.launchWith({ env: env?.(sb) }, "printf started");

    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain(shows(sb));
    expect(run.stderr).toContain("omp を起動しません");
  });

  // 組の検証の入口（preflight.ts）を差し替えようとする bun の設定。preload は無害なフィクスチャで、印のファイルを書いて、検証の前に 0 で終わる
  const preloads: { name: string; place(sb: Sandbox, preload: string): { cwd?: string; env?: Record<string, string> } }[] = [
    { name: "環境変数 BUN_OPTIONS に preload を指定した", place: (_, preload) => ({ env: { BUN_OPTIONS: `--preload ${preload}` } }) },
    {
      name: "ホームの .bunfig.toml に preload を書いた",
      place: (sb, preload) => {
        writeFileSync(join(sb.home, ".bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`);
        return {};
      },
    },
    {
      name: "作業中のプロジェクトの bunfig.toml に preload を書き、.env で BUN_OPTIONS を指定した",
      place: (sb, preload) => {
        writeFileSync(join(sb.project, "bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`);
        writeFileSync(join(sb.project, ".env"), `BUN_OPTIONS="--preload ${preload}"\n`);
        return { cwd: sb.project };
      },
    },
  ];

  test.each(preloads)("$name 環境でも、壊れた写しなら preload を読まずに組を確かめ、omp を起動しない", async ({ place }) => {
    const sb = await applied();
    const mark = join(sb.root, "preloaded");
    const preload = join(sb.root, "preload.js");
    writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(mark)}, "x");\nprocess.exit(0);\n`);
    rmSync(join(sb.copy, "control", "rules.json"));

    const run = await sb.launchWith(place(sb, preload), "printf started");

    expect(run.exitCode).not.toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("control/rules.json（無い）");
    expect(existsSync(mark)).toBe(false);
  });

  test("正しい組では、偽の omp を制御の拡張のファイルの -e 付きで起動する", async () => {
    const sb = await applied();

    const run = await sb.launch('printf "%s" "$FAKE_OMP_EXTENSION"');

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toBe(entry(sb));
  });

  test("ホームを作業ディレクトリにしても、閉じ込められていれば omp を起動し、制御の拡張もツールを遮断しない（~/.omp の下は規則の allowPaths で書ける）", async () => {
    const sb = await applied();
    const ompDir = readdirSync(join(sb.home, ".omp")).sort();

    const launched = await sb.launchWith({ cwd: sb.home }, "printf started");
    const result = await run(sb, { sessions: [{ agent: MAIN, toolCalls: 1 }] }, { profile: profile(sb), cwd: sb.home });

    expect(launched.stderr).toBe("");
    expect(launched.stdout).toBe("started");
    expect(result.toolCalls).toEqual([[null]]);
    expect(readdirSync(join(sb.home, ".omp")).sort()).toEqual(ompDir);
  });
});
