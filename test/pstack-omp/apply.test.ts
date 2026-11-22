// pstack を OMP 向けに使う道具（scripts/pstack-omp/cli.ts）の適用（apply）・解除（remove）を、プロセスとして起動して外から確かめる。
// 利用者の OMP の設定の置き場（PI_CODING_AGENT_DIR）・ホーム（HOME）・データ置き場（NOD_DATA_DIR）は一時ディレクトリ（helpers.ts）。
// 適用した組の制御の拡張は、OMP の代わりに extension-driver.ts で読み込み、実行時の上書きと tool_call の戻り値を外から確かめる。
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAIN, put, type Sandbox, sandbox, skillMd, snapshot, startExtension, SUB, synced } from "./helpers";

// 利用者が既に書いている config.yml（コメントと、制御の拡張が触る設定とほかの設定を含む）
const USER_CONFIG = `# 利用者のコメント
modelRoles:
  task: anthropic/claude-opus-5-5:high
extensions:
  - /somewhere/ext-a
skills:
  customDirectories:
    - /somewhere/skills
  manualSkills:
    - private-*
disabledExtensions:
  - skill:foo
`;

function writeConfig(sb: Sandbox, text: string): void {
  put(sb.configPath, text);
}

// 写しの中の位置（データ置き場は macOS の /var と /private/var のような別名を解いた形で書かれる）
function copyPath(sb: Sandbox, rel: string): string {
  return join(realpathSync(sb.dataDir), "pstack-omp", rel);
}

describe("適用", () => {
  test("config.yml に、OMP 向けのディレクトリの登録（extensions）・スキルの読み込み先（skills.customDirectories の先頭）・一覧から外す全スキル（skills.manualSkills）が入り、既にある値とほかのキーは保たれる", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);

    const run = await sb.run("apply");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(Bun.YAML.parse(readFileSync(sb.configPath, "utf8"))).toEqual({
      modelRoles: { task: "anthropic/claude-opus-5-5:high" },
      extensions: ["/somewhere/ext-a", copyPath(sb, "omp/control"), copyPath(sb, "omp/content")],
      skills: {
        // 写しの中の生成した pstack と cursor-team-kit を先頭に置き、pstack の tdd を利用者の置き場の tdd より優先させる
        customDirectories: [copyPath(sb, "omp/generated/pstack/skills"), copyPath(sb, "omp/generated/cursor-team-kit/skills"), "/somewhere/skills"],
        // 生成した全スキルと読み替え表のスキル
        manualSkills: ["private-*", "poteto-mode", "tdd", "control-cli", "control-ui", "deslop", "pstack-omp"],
      },
      disabledExtensions: ["skill:foo"],
    });
  });

  test("config.yml が無ければ、3つの読み込みの設定だけを持つ config.yml を作る", async () => {
    const sb = await synced();

    expect((await sb.run("apply")).exitCode).toBe(0);

    expect(Bun.YAML.parse(readFileSync(sb.configPath, "utf8"))).toEqual({
      extensions: [copyPath(sb, "omp/control"), copyPath(sb, "omp/content")],
      skills: {
        customDirectories: [copyPath(sb, "omp/generated/pstack/skills"), copyPath(sb, "omp/generated/cursor-team-kit/skills")],
        manualSkills: ["poteto-mode", "tdd", "control-cli", "control-ui", "deslop", "pstack-omp"],
      },
    });
  });

  test("写しに生成したスキルが入り、データ置き場の生成物と同じ中身である", async () => {
    const sb = await synced();

    expect((await sb.run("apply")).exitCode).toBe(0);

    for (const root of ["pstack", "cursor-team-kit"]) {
      expect(snapshot(join(sb.copy, "generated", root, "skills"))).toEqual(snapshot(join(sb.generated, root, "skills")));
    }
    expect(readFileSync(join(sb.copy, "generated", "pstack", "skills", "tdd", "SKILL.md"), "utf8")).toContain("Red, green.");
  });

  test("適用の後に始めたセッションで、メインの session_start より前（拡張の読み込み）に、config.yml と同じスキルの読み込み先・OMP 向けのディレクトリ・一覧から外す全スキルが実行時の層にも固定され、既にある値は保たれる", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    expect((await sb.run("apply")).exitCode).toBe(0);
    const control = copyPath(sb, "omp/control");

    const result = await startExtension(join(sb.copy, "control", "index.ts")).run({
      settings: {
        extensions: ["/somewhere/ext-a", control],
        "skills.customDirectories": ["/somewhere/skills"],
        "skills.manualSkills": ["private-*"],
        disabledExtensions: ["skill:foo", "skill:tdd"],
      },
      sessions: [{ agent: MAIN, toolCalls: 1 }],
    });

    const expected = {
      extensions: ["/somewhere/ext-a", control, copyPath(sb, "omp/content")],
      // 写しの中の生成した pstack と cursor-team-kit を先頭に置き、pstack の tdd を利用者の置き場の tdd より優先させる
      "skills.customDirectories": [copyPath(sb, "omp/generated/pstack/skills"), copyPath(sb, "omp/generated/cursor-team-kit/skills"), "/somewhere/skills"],
      // 生成した全スキルと読み替え表のスキル
      "skills.manualSkills": ["private-*", "poteto-mode", "tdd", "control-cli", "control-ui", "deslop", "pstack-omp"],
      // 読み込むスキルを無効にする指定は外す
      disabledExtensions: ["skill:foo"],
    };
    // メインの task ツールがエージェント定義を探す時点（session_start の前）に、OMP 向けのディレクトリが extensions に入っている
    // （規則の上書き tools.approval と bash.patterns は control.test.ts で確かめる）
    expect(result.effectiveAtStart).toHaveLength(1);
    expect(result.effectiveAtStart[0]).toMatchObject(expected);
    expect(result.effective).toMatchObject(expected);
    expect(result.toolCalls).toEqual([[null]]);
  });

  test("TUI に読み込みを後回しにされないよう、どのセッションでも message renderer を登録する", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);

    const result = await startExtension(join(sb.copy, "control", "index.ts")).run({
      settings: { extensions: [copyPath(sb, "omp/control")] },
      sessions: [
        { agent: MAIN, toolCalls: 0 },
        { agent: SUB, toolCalls: 0 },
      ],
    });

    expect(result.renderers).toEqual([["pstack-omp"], ["pstack-omp"]]);
  });

  test("同じプロセスの子と孫の読み込みでは、メインが書いた値を書き直さず、値も変わらず、ツールも遮断しない", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);

    const result = await startExtension(join(sb.copy, "control", "index.ts")).run({
      settings: { extensions: [copyPath(sb, "omp/control")] },
      sessions: [
        { agent: MAIN, toolCalls: 0 },
        { agent: SUB, toolCalls: 1 },
        { agent: { kind: "sub", name: "poteto-agent", depth: 2 }, toolCalls: 1 },
      ],
    });

    expect(new Set(result.overrides.map(({ session, phase }) => `${session}:${phase}`))).toEqual(new Set(["0:factory"]));
    // 固定する全キーを、値が変わらなくても実行時の層に入れる（メインの1度だけ）
    expect(result.overrides.map(({ id }) => id).sort()).toEqual(["bash.patterns", "disabledExtensions", "extensions", "skills.customDirectories", "skills.manualSkills", "tools.approval"]);
    expect(result.effectiveAtStart[1]).toEqual(result.effectiveAtStart[0]);
    expect(result.effectiveAtStart[2]).toEqual(result.effectiveAtStart[0]);
    expect(result.toolCalls).toEqual([[], [null], [null]]);
  });

  test("worker thread の子（設定がメインのスレッドの設定の写し）では上書きせず、ツールも遮断しない", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);

    const result = await startExtension(join(sb.copy, "control", "index.ts")).run({
      settings: { extensions: [copyPath(sb, "omp/control")] },
      mirror: true,
      sessions: [{ agent: SUB, toolCalls: 1 }],
    });

    expect(result.overrides).toEqual([]);
    expect(result.toolCalls).toEqual([[null]]);
  });

  test("適用より前に始まったプロセスに後から読み込まれても、上書きも遮断もしない", async () => {
    const sb = await synced();
    // 拡張を読み込むプロセスを先に始めておく（開始が適用の時刻より前になる）
    const before = startExtension(join(sb.copy, "control", "index.ts"));
    expect((await sb.run("apply")).exitCode).toBe(0);

    const result = await before.run({ settings: {}, sessions: [{ agent: MAIN, toolCalls: 1 }] });

    expect(result.overrides).toEqual([]);
    expect(result.toolCalls).toEqual([[null]]);
  });
});

describe("制御の拡張が読む組の記録が正しくないとき", () => {
  const cases: { name: string; damage(sb: Sandbox): void }[] = [
    {
      name: "組の記録（harness.json）が無い",
      damage: (sb) => rmSync(join(sb.copy, "control", "harness.json")),
    },
    {
      name: "組の記録が JSON として読めない",
      damage: (sb) => writeFileSync(join(sb.copy, "control", "harness.json"), "{"),
    },
    {
      name: "組のファイル（読み替え表）が記録の sha256 と違う",
      damage: (sb) => writeFileSync(join(sb.copy, "content", "skills", "pstack-omp", "SKILL.md"), "書き換えた\n"),
    },
    {
      name: "写しの生成したスキル（pstack の tdd）が記録の sha256 と違う",
      damage: (sb) => writeFileSync(join(sb.copy, "generated", "pstack", "skills", "tdd", "SKILL.md"), skillMd("tdd", "書き換えた")),
    },
    {
      name: "記録が指す写しの中の生成したスキルの置き場が無い",
      damage: (sb) => rmSync(join(sb.copy, "generated", "cursor-team-kit"), { recursive: true }),
    },
    {
      name: "組の記録の skillDirectories が写しの外（データ置き場の生成物）を指す",
      damage: (sb) => {
        const path = join(sb.copy, "control", "harness.json");
        const harness = JSON.parse(readFileSync(path, "utf8"));
        harness.skillDirectories = ["pstack", "cursor-team-kit"].map((root) => join(realpathSync(sb.generated), root, "skills"));
        writeFileSync(path, JSON.stringify(harness));
      },
    },
  ];

  test.each(cases)("$name: メインでも子でも上書きせず、全ツールを理由つきで遮断する", async ({ damage }) => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    damage(sb);

    const result = await startExtension(join(sb.copy, "control", "index.ts")).run({
      settings: { extensions: [copyPath(sb, "omp/control")] },
      sessions: [
        { agent: MAIN, toolCalls: 2 },
        { agent: SUB, toolCalls: 1 },
      ],
    });

    expect(result.overrides).toEqual([]);
    for (const call of result.toolCalls.flat()) {
      expect(call?.block).toBe(true);
      expect(call?.reason).toContain("ツールを実行しません");
    }
    expect(result.toolCalls.flat()).toHaveLength(3);
    expect(result.notices.join("\n")).toContain("ツールを実行しません");
  });

  test("データ置き場の生成物が消えても、写しが揃っていれば上書きし、ツールを遮断しない", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    rmSync(sb.generated, { recursive: true });

    const result = await startExtension(join(sb.copy, "control", "index.ts")).run({
      settings: { extensions: [copyPath(sb, "omp/control")] },
      sessions: [{ agent: MAIN, toolCalls: 1 }],
    });

    expect(result.effective["skills.customDirectories"]).toEqual([copyPath(sb, "omp/generated/pstack/skills"), copyPath(sb, "omp/generated/cursor-team-kit/skills")]);
    expect(result.toolCalls).toEqual([[null]]);
  });

  // 適用より前から動いている OMP のプロセス（利用者や親のセッション）が、config.yml の読み直しなどで、壊れた・入れ替え中の組を後から読み込む場面
  const beforeApply = [
    ...cases,
    {
      name: "写しの規則が書き換えられた（sha256 が記録と違う）",
      damage: (sb: Sandbox) => writeFileSync(join(sb.copy, "control", "rules.json"), "{}"),
    },
  ];

  test.each(beforeApply)("$name: 適用より前に始まったプロセスに後から読み込まれたら、組を検証せず、上書きも遮断もしない", async ({ damage }) => {
    const sb = await synced();
    const before = startExtension(join(sb.copy, "control", "index.ts"));
    expect((await sb.run("apply")).exitCode).toBe(0);
    damage(sb);

    const result = await before.run({
      settings: { extensions: [copyPath(sb, "omp/control")] },
      sessions: [
        { agent: MAIN, toolCalls: 2, spawns: ["scout"] },
        { agent: SUB, toolCalls: 1, spawns: ["scout"] },
      ],
    });

    expect(result.overrides).toEqual([]);
    expect(result.toolCalls).toEqual([[null, null], [null]]);
    expect(result.spawns).toEqual([[null], [null]]);
    expect(result.harnessEnv).toBeNull();
    expect(result.notices.join("\n")).toContain("より前に始まったプロセス");
  });
});

// 写しの中身。harness.json は適用の時刻を除いた形で比べる
function copyContents(sb: Sandbox): unknown {
  const files = Object.fromEntries(snapshot(sb.copy));
  const harness = JSON.parse(readFileSync(join(sb.copy, "control", "harness.json"), "utf8"));
  delete harness.appliedAt;
  delete files["control/harness.json"];
  return { files, harness };
}

describe("解除", () => {
  test("適用の後に解除すると、config.yml が適用の前のバイト（コメントも）に戻り、写しが消える。生成物と上流の clone は残る", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    expect((await sb.run("apply")).exitCode).toBe(0);

    const run = await sb.run("remove");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readFileSync(sb.configPath, "utf8")).toBe(USER_CONFIG);
    expect(existsSync(sb.copy)).toBe(false);
    expect(existsSync(join(sb.generated, "manifest.json"))).toBe(true);
    expect(existsSync(sb.clone)).toBe(true);
  });

  test("config.yml が無い状態から適用して解除すると、config.yml が無い状態に戻る", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);

    expect((await sb.run("remove")).exitCode).toBe(0);

    expect(existsSync(sb.configPath)).toBe(false);
    expect(existsSync(sb.copy)).toBe(false);
  });

  // 適用の前に3つの読み込みの設定のキーがある config.yml と、無い config.yml（コメントと無関係なキーだけ）
  const befores = [
    { name: "3つのキーがある", text: USER_CONFIG },
    { name: "3つのキーが無い", text: "# 利用者のコメント\ntheme: dark # 行末のコメント\n" },
  ];

  test.each(befores)("適用を繰り返しても config.yml と写しの中身は変わらず、その後の解除で最初の適用の前に戻る（適用の前に$name）", async ({ text }) => {
    const sb = await synced();
    writeConfig(sb, text);
    expect((await sb.run("apply")).exitCode).toBe(0);
    const config = readFileSync(sb.configPath, "utf8");
    const copy = copyContents(sb);

    const again = await sb.run("apply");

    expect(again.stderr).toBe("");
    expect(again.exitCode).toBe(0);
    expect(readFileSync(sb.configPath, "utf8")).toBe(config);
    expect(copyContents(sb)).toEqual(copy);
    expect((await sb.run("remove")).exitCode).toBe(0);
    expect(readFileSync(sb.configPath, "utf8")).toBe(text);
  });

  test.each(befores)("解除を繰り返しても結果が変わらず、適用と解除を繰り返しても同じ結果になる（適用の前に$name）", async ({ text }) => {
    const sb = await synced();
    writeConfig(sb, text);
    expect((await sb.run("apply")).exitCode).toBe(0);
    const applied = readFileSync(sb.configPath, "utf8");
    expect((await sb.run("remove")).exitCode).toBe(0);

    const again = await sb.run("remove");

    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("適用していません");
    expect(readFileSync(sb.configPath, "utf8")).toBe(text);
    expect(existsSync(sb.copy)).toBe(false);
    expect((await sb.run("apply")).exitCode).toBe(0);
    expect(readFileSync(sb.configPath, "utf8")).toBe(applied);
    expect((await sb.run("remove")).exitCode).toBe(0);
    expect(readFileSync(sb.configPath, "utf8")).toBe(text);
  });

  test("適用の後に利用者が config.yml を変えていたら、自分の項目だけを外し、利用者が変えた値・元の値・適用の前からの一覧から外す名前は保つ", async () => {
    const sb = await synced();
    // 生成したスキルの名前（tdd）を、適用の前から一覧から外していた
    const before = USER_CONFIG.replace("    - private-*\n", "    - private-*\n    - tdd\n");
    writeConfig(sb, before);
    expect((await sb.run("apply")).exitCode).toBe(0);
    const edited = Bun.YAML.parse(readFileSync(sb.configPath, "utf8")) as { extensions: string[]; skills: { customDirectories: string[]; manualSkills: string[] } };
    writeFileSync(
      sb.configPath,
      Bun.YAML.stringify(
        {
          ...edited,
          theme: "dark",
          extensions: [...edited.extensions, "/somewhere/ext-b"],
          skills: { customDirectories: [...edited.skills.customDirectories, "/somewhere/more"], manualSkills: [...edited.skills.manualSkills, "mine"] },
        },
        null,
        2,
      ),
    );

    const run = await sb.run("remove");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("自分の項目");
    expect(Bun.YAML.parse(readFileSync(sb.configPath, "utf8"))).toEqual({
      modelRoles: { task: "anthropic/claude-opus-5-5:high" },
      extensions: ["/somewhere/ext-a", "/somewhere/ext-b"],
      skills: { customDirectories: ["/somewhere/skills", "/somewhere/more"], manualSkills: ["private-*", "tdd", "mine"] },
      disabledExtensions: ["skill:foo"],
      theme: "dark",
    });
  });

  test.each([
    ["解除する", false],
    ["再適用してから解除する", true],
  ] as const)("config.yml が無い状態から適用し、利用者が config.yml を変えてから%sと、利用者の変更は保たれ、適用が作ったキーは残らない", async (_, reapply) => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    const edited = Bun.YAML.parse(readFileSync(sb.configPath, "utf8")) as Record<string, unknown>;
    writeFileSync(sb.configPath, Bun.YAML.stringify({ ...edited, theme: "dark" }, null, 2));
    if (reapply) expect((await sb.run("apply")).exitCode).toBe(0);

    expect((await sb.run("remove")).exitCode).toBe(0);

    // 適用の前に extensions・skills のキーは無かったので、外した後に空の配列やマッピングを残さない
    expect(Bun.YAML.parse(readFileSync(sb.configPath, "utf8"))).toEqual({ theme: "dark" });
  });
});

// 今回置くエージェント定義（OMP 向けのディレクトリの agents/poteto-agent.md）
const POTETO_AGENT = "---\nname: poteto-agent\ndescription: test\n---\n\nYou are poteto.\n";

describe("名前のぶつかり", () => {
  const cases: { name: string; place(sb: Sandbox): string }[] = [
    {
      name: "利用者のエージェント定義に poteto-agent がある（frontmatter の name）",
      place: (sb) => {
        put(join(sb.agentDir, "agents", "reviewer.md"), POTETO_AGENT);
        return join(sb.agentDir, "agents", "reviewer.md");
      },
    },
    {
      name: "利用者の OMP のスキルの置き場に pstack-omp がある（frontmatter の name）",
      place: (sb) => {
        put(join(sb.agentDir, "skills", "table", "SKILL.md"), skillMd("pstack-omp", "mine"));
        return join(sb.agentDir, "skills", "table", "SKILL.md");
      },
    },
    {
      name: "~/.agents/skills に pstack-omp がある（frontmatter に name が無ければディレクトリ名）",
      place: (sb) => {
        put(join(sb.home, ".agents", "skills", "pstack-omp", "SKILL.md"), "# mine\n");
        return join(sb.home, ".agents", "skills", "pstack-omp", "SKILL.md");
      },
    },
    {
      name: "config.yml の skills.customDirectories の置き場に pstack-omp がある",
      place: (sb) => {
        put(join(sb.root, "my-skills", "pstack-omp", "SKILL.md"), skillMd("pstack-omp", "mine"));
        writeConfig(sb, `skills:\n  customDirectories:\n    - ${join(sb.root, "my-skills")}\n`);
        return join(sb.root, "my-skills", "pstack-omp", "SKILL.md");
      },
    },
    {
      name: "config.yml の extensions のパッケージに poteto-agent がある",
      place: (sb) => {
        put(join(sb.root, "my-ext", "agents", "poteto-agent.md"), POTETO_AGENT);
        writeConfig(sb, `extensions:\n  - ${join(sb.root, "my-ext")}\n`);
        return join(sb.root, "my-ext", "agents", "poteto-agent.md");
      },
    },
  ];

  test.each(cases)("$name: 上書きせずに止まって報告し、設定と写しは何も変わらない", async ({ place }) => {
    const sb = await synced();
    sb.content("agents/poteto-agent.md", POTETO_AGENT);
    const path = place(sb);
    const config = existsSync(sb.configPath) ? readFileSync(sb.configPath, "utf8") : undefined;

    const run = await sb.run("apply");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(path);
    expect(run.stderr).toContain("上書きしない");
    expect(existsSync(sb.configPath) ? readFileSync(sb.configPath, "utf8") : undefined).toBe(config);
    expect(existsSync(sb.copy)).toBe(false);
  });

  test("再適用では、今回置いた定義とスキルをぶつかりとして扱わない", async () => {
    const sb = await synced();
    sb.content("agents/poteto-agent.md", POTETO_AGENT);
    expect((await sb.run("apply")).exitCode).toBe(0);

    const again = await sb.run("apply");

    expect(again.stderr).toBe("");
    expect(again.exitCode).toBe(0);
  });

  test("利用者の置き場に tdd があっても止めない（生成した pstack の tdd が優先される）", async () => {
    const sb = await synced();
    put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "mine"));

    const run = await sb.run("apply");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
  });

  test("リポジトリの実際の poteto-agent の定義でも、利用者のエージェント定義の poteto-agent とぶつかると止まり、設定と写しは何も変わらない", async () => {
    const sb = await repoSynced();
    const mine = join(sb.agentDir, "agents", "poteto-agent.md");
    put(mine, "---\nname: poteto-agent\ndescription: mine\n---\n\nMine.\n");

    const run = await sb.run("apply");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(mine);
    expect(run.stderr).toContain("上書きしない");
    expect(existsSync(sb.configPath)).toBe(false);
    expect(existsSync(sb.copy)).toBe(false);
  });
});

describe("OMP の版", () => {
  test("OMP の版が固定の記録と違うと適用が止まり、設定と写しは何も変わらない", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    sb.omp("19.2.0");

    const run = await sb.run("apply");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("19.2.0");
    expect(readFileSync(sb.configPath, "utf8")).toBe(USER_CONFIG);
    expect(existsSync(sb.copy)).toBe(false);
  });

  test.each([
    ["違う版", "19.2.0"],
    ["版を確かめられない omp", null],
  ] as const)("適用の後に OMP が%sになっても、状態の表示と解除は行える", async (_, version) => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    expect((await sb.run("apply")).exitCode).toBe(0);
    sb.omp(version);

    const status = await sb.run("status");
    const remove = await sb.run("remove");

    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(version === null ? "OMP の版: 確かめられません" : "OMP の版: 19.2.0（固定の記録 19.1.0、適用したときの記録 19.1.0）。版が違います");
    expect(remove.exitCode).toBe(0);
    expect(readFileSync(sb.configPath, "utf8")).toBe(USER_CONFIG);
    expect(existsSync(sb.copy)).toBe(false);
  });
});

describe("途中の失敗", () => {
  test("config.yml が YAML として読めないと止まり、config.yml も写しも変わらない", async () => {
    const sb = await synced();
    writeConfig(sb, "extensions: [unclosed\n");

    const run = await sb.run("apply");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("YAML として読めません");
    expect(readFileSync(sb.configPath, "utf8")).toBe("extensions: [unclosed\n");
    expect(existsSync(sb.copy)).toBe(false);
  });

  test("生成物が無ければ（同期していない）、sync を案内して止まり、config.yml を作らない", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin();

    const run = await sb.run("apply");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("sync");
    expect(existsSync(sb.configPath)).toBe(false);
    expect(existsSync(sb.copy)).toBe(false);
  });

  test("生成物の元にした固定の記録が、いまの固定の記録と違えば、sync を案内して止まる", async () => {
    const sb = await synced();
    sb.commit("0.15.47");
    sb.pin();

    const run = await sb.run("apply");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("sync");
    expect(existsSync(sb.configPath)).toBe(false);
    expect(existsSync(sb.copy)).toBe(false);
  });

  test("OMP の設定の置き場に書き込めなければ止まり、config.yml も写しも変わらない", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    chmodSync(sb.agentDir, 0o555);

    const run = await sb.run("apply");

    chmodSync(sb.agentDir, 0o755);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(realpathSync(sb.agentDir));
    expect(readFileSync(sb.configPath, "utf8")).toBe(USER_CONFIG);
    expect(existsSync(sb.copy)).toBe(false);
  });

  test("前の適用がある状態で、写しの置き場に書き込めず止まっても、前の写しと config.yml はそのまま残る", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    expect((await sb.run("apply")).exitCode).toBe(0);
    const config = readFileSync(sb.configPath, "utf8");
    const copy = snapshot(sb.copy);
    sb.content("agents/poteto-agent.md", POTETO_AGENT);
    chmodSync(join(sb.dataDir, "pstack-omp"), 0o555);

    const run = await sb.run("apply");

    chmodSync(join(sb.dataDir, "pstack-omp"), 0o755);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("設定と写しは適用の前のまま");
    expect(readFileSync(sb.configPath, "utf8")).toBe(config);
    expect(snapshot(sb.copy)).toEqual(copy);
  });

  test("実行中の OMP が config.yml のロックを持ち続けていると、待った後に止まり、何も変わらない", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    const lock = `${realpathSync(sb.configPath)}.lock`;
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { dlopen, FFIType } = require("bun:ffi"); const fs = require("node:fs");
         const fd = fs.openSync(${JSON.stringify(lock)}, fs.constants.O_RDONLY | fs.constants.O_CREAT, 0o600);
         dlopen("libc.dylib", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } }).symbols.flock(fd, 2);
         console.log("locked"); setInterval(() => {}, 1000);`,
      ],
      { stdout: "pipe" },
    );
    const reader = holder.stdout.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("locked");

    const run = await sb.run("apply");

    holder.kill();
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("ロック");
    expect(readFileSync(sb.configPath, "utf8")).toBe(USER_CONFIG);
    expect(existsSync(sb.copy)).toBe(false);
  });
});

describe("写し", () => {
  test("写しは読み取り専用にせず（利用者がそのまま消せる）、組の記録（適用の前の config.yml を持つ）は利用者だけが読み書きできる", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);

    expect(statSync(join(sb.copy, "control", "harness.json")).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(sb.copy, "control")).sort()).toEqual(["harness.json", "index.ts", "omp.d.ts", "rules.json", "rules.ts"]);
    expect(readFileSync(join(sb.copy, "content", "skills", "pstack-omp", "SKILL.md"), "utf8")).toBe(readFileSync(join(sb.packageDir, "skills", "pstack-omp", "SKILL.md"), "utf8"));
    rmSync(sb.copy, { recursive: true });
    expect(existsSync(sb.copy)).toBe(false);
  });

  test("写しに、リポジトリの poteto-agent の定義（役割 task のモデルで、読み替え表を自動で読み、既定の task と poteto-agent を起動できる）が入る", async () => {
    const sb = await repoSynced();

    expect((await sb.run("apply")).exitCode).toBe(0);

    const text = readFileSync(join(sb.copy, "content", "agents", "poteto-agent.md"), "utf8");
    const frontmatter = Bun.YAML.parse(/^---\n([\s\S]*?)\n---\n/.exec(text)![1]!) as Record<string, unknown>;
    expect(frontmatter).toMatchObject({ name: "poteto-agent", model: "@task", spawns: ["task", "poteto-agent"], "autoload-skills": "pstack-omp" });
    expect(text).toBe(readFileSync(join(sb.packageDir, "agents", "poteto-agent.md"), "utf8"));
  });
});

// OMP 向けのディレクトリを差し替えず、nod のリポジトリの omp/content（実際の読み替え表とエージェント定義）で同期した sandbox
async function repoSynced(): Promise<Sandbox> {
  const sb = sandbox({ repoTable: true });
  sb.commit("0.15.46", { "pstack/skills/tdd/SKILL.md": skillMd("tdd", "Red, green.") });
  sb.pin();
  const run = await sb.sync();
  if (run.exitCode !== 0) throw new Error(`同期に失敗: ${run.stderr}`);
  return sb;
}

// Claude Code と Codex 向けのプラグインの内容（nod のリポジトリの plugins/、.claude-plugin/、.agents/plugins/）のハッシュ
function pluginHash(): string {
  const repo = join(import.meta.dir, "..", "..");
  const hasher = new Bun.CryptoHasher("sha256");
  for (const dir of ["plugins", ".claude-plugin", ".agents/plugins"]) {
    for (const [path, entry] of snapshot(join(repo, dir))) hasher.update(`${dir}/${path}\0${entry.executable}\0${entry.content}\0`);
  }
  return hasher.digest("hex");
}

describe("プラグインと nod の CLI", () => {
  test("同期・適用・状態の表示・解除を実行しても、Claude Code と Codex 向けのプラグインの内容が変わらない", async () => {
    const before = pluginHash();
    const sb = sandbox({ repoTable: true });
    sb.commit("0.15.46", { "pstack/skills/tdd/SKILL.md": skillMd("tdd", "Red, green.") });
    sb.pin();

    const runs = [await sb.sync(), await sb.run("apply"), await sb.run("status"), await sb.run("remove")];

    expect(runs.map((run) => run.exitCode)).toEqual([0, 0, 0, 0]);
    expect(pluginHash()).toBe(before);
  });

  test("nod の CLI（packages/cli）に pstack のコマンドが無い", () => {
    const cli = join(import.meta.dir, "..", "..", "packages", "cli", "src");
    const mentions = [...snapshot(cli)].filter(([, entry]) => Buffer.from(entry.content, "base64").toString("utf8").includes("pstack")).map(([path]) => path);

    expect(mentions).toEqual([]);
  });
});
