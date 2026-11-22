// 禁止操作を止める制御（nod のリポジトリの omp/control/rules.json と、それを読む制御の拡張）を、外から確かめる。
// 適用・解除・状態の表示はプロセスとして起動し（helpers.ts の一時の置き場）、適用した写しの制御の拡張は OMP の代わりに
// extension-driver.ts で読み込んで、実行時の上書きと tool_call・before_subagent_spawn の戻り値を見る。拡張を読み込むプロセスは、
// 写しのサンドボックスのプロファイル（control/sandbox.sb）で閉じ込めて起動する（閉じ込めずに起動すると全ツールを遮断するため）。
// bash.patterns の照合そのものは OMP の実装なので、ここではパターンが実行時の層に入ることまでを確かめる（当たり方は実際の OMP で確かめる）。
// サンドボックスの信頼境界は、写しの起動の入口（bin/omp）を実際に実行し、その中からの書き込みが拒否されることで確かめる。
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionScenario, HARNESS_ENV, MAIN, put, REPO_RULES, type Sandbox, snapshot, SUB, synced } from "./helpers";

const GRANDCHILD = { kind: "sub", name: "poteto-agent", depth: 2 } as const;

// 写しの中の位置（データ置き場は macOS の /var と /private/var のような別名を解いた形で書かれる）
function work(sb: Sandbox): string {
  return join(realpathSync(sb.dataDir), "pstack-omp");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function applied(): Promise<Sandbox> {
  const sb = await synced();
  const run = await sb.run("apply");
  if (run.exitCode !== 0) throw new Error(`適用に失敗: ${run.stderr}`);
  return sb;
}

function run(sb: Sandbox, scenario: Partial<ExtensionScenario> & Pick<ExtensionScenario, "sessions">, confine: { profile?: string; launcher?: string } = { profile: profile(sb) }) {
  return sb.extension(confine).run({ settings: { extensions: [entry(sb)] }, ...scenario });
}

// config.yml の extensions に入る、写しの制御の拡張のファイル
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
  test("解除すると、制御の規則も写しと一緒に消え、OMP の設定に制御の項目が残らない", async () => {
    const sb = await applied();

    expect((await sb.run("remove")).exitCode).toBe(0);

    expect(existsSync(join(sb.copy, "control", "rules.json"))).toBe(false);
    expect(existsSync(sb.configPath)).toBe(false);
  });
});

describe("サンドボックスの信頼境界", () => {
  test("閉じ込めずに起動したプロセスでは、メインでも子でも全ツールと子の起動を遮断し、理由に写しの起動の入口と書けてしまう置き場を出す", async () => {
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
    expect(result.notices.join("\n")).toContain("サンドボックスの外で起動しています");
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

  test("起動の入口の中からは、OMP の設定・写し・OMP の設定の置き場・omp の実行ファイルを書き換えられず、解除もできない。守る集合の外には書ける", async () => {
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
    expect(allowed.stderr).toBe("");
    expect(allowed.exitCode).toBe(0);
    expect(readFileSync(join(outside, "d", "b.txt"), "utf8")).toBe("ok");
  });

  test("起動の入口の中からは、どのプロジェクトでも OMP と Claude Code の設定・同じプロセスで動くコードの置き場を作れず、OMP の設定の置き場の hooks・tools とプラグインの置き場も作れない。利用者の ~/.omp の下の実行時の書き込みと、プロジェクトの普通のファイルには書ける", async () => {
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
    expect(allowed.stderr).toBe("");
    expect(allowed.exitCode).toBe(0);
    expect(readFileSync(join(sb.agentDir, "sessions", "p", "s.jsonl"), "utf8")).toBe("x");
    expect(readdirSync(project).sort()).toEqual([".claude", ".omplike", "README.md"]);
    expect(readdirSync(join(project, ".claude"))).toEqual(["CLAUDE.md"]);
  });

  test("起動の入口の中で読み込むと、規則の上書きが入り、メインでも子でも規則どおりに検査する", async () => {
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
