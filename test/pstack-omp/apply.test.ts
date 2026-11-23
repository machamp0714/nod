// pstack を OMP 向けに使う道具（scripts/pstack-omp/cli.ts）の適用（apply）・解除（remove）を、プロセスとして起動して外から確かめる。
// 利用者の OMP の設定の置き場（PI_CODING_AGENT_DIR）・ホーム（HOME）・データ置き場（NOD_DATA_DIR）は一時ディレクトリ（helpers.ts）。
// 適用した組の制御の拡張は、OMP の代わりに extension-driver.ts で読み込み、実行時の上書きと tool_call の戻り値を外から確かめる。
// 適用の後に始めるプロセスは、写しの専用ランチャーの中か、写しのサンドボックスのプロファイルで閉じ込めて起動する
// （閉じ込めずに起動すると全ツールを遮断するため）。
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAIN, put, type Sandbox, sandbox, skillMd, snapshot, SUB, synced } from "./helpers";

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

// 適用した写しの制御の拡張を、写しのサンドボックスのプロファイル（control/sandbox.sb）で閉じ込めて読み込むプロセスを起動する
function confined(sb: Sandbox) {
  return sb.extension({ profile: join(sb.copy, "control", "sandbox.sb") });
}

function harnessOf(sb: Sandbox): Record<string, unknown> {
  return JSON.parse(readFileSync(join(sb.copy, "control", "harness.json"), "utf8")) as Record<string, unknown>;
}

function writeHarness(sb: Sandbox, harness: Record<string, unknown>): void {
  writeFileSync(join(sb.copy, "control", "harness.json"), JSON.stringify(harness));
}

// 生成した全スキルと読み替え表のスキル（一覧から外す順）
const MANUAL = ["poteto-mode", "tdd", "control-cli", "control-ui", "deslop", "pstack-omp"];

describe("適用", () => {
  test.each([
    ["在る", USER_CONFIG],
    ["無い", undefined],
  ] as const)("config.yml が%sとき、config.yml を書かずに、写しと専用ランチャーを置き、ランチャーからの起動を案内する", async (_, text) => {
    const sb = await synced();
    if (text !== undefined) writeConfig(sb, text);

    const run = await sb.run("apply");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(existsSync(sb.configPath) ? readFileSync(sb.configPath, "utf8") : undefined).toBe(text);
    expect(existsSync(sb.launcher)).toBe(true);
    if (text === undefined) expect(existsSync(join(sb.home, ".omp"))).toBe(false);
    expect(run.stdout).toContain("読み込みの設定を書いていません");
    expect(run.stdout).toContain(`専用ランチャー: ${copyPath(sb, "omp/bin/omp")} から起動してください`);
    expect(run.stdout).toContain("通常の omp には読み込まれません");
  });

  test("写しに生成物が丸ごと（manifest.json とスキルの外のリンク先の文書を含む）入り、データ置き場の生成物と同じ中身である", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", {
      "pstack/skills/tdd/SKILL.md": skillMd("tdd", "Red, green. Read [the guide](../../docs/guide.md)."),
      "pstack/docs/guide.md": "# Guide\n",
    });
    sb.pin();
    expect((await sb.sync()).exitCode).toBe(0);

    expect((await sb.run("apply")).exitCode).toBe(0);

    expect(snapshot(join(sb.copy, "generated"))).toEqual(snapshot(sb.generated));
    expect(readFileSync(join(sb.copy, "generated", "pstack", "docs", "guide.md"), "utf8")).toBe("# Guide\n");
    expect(JSON.parse(readFileSync(join(sb.copy, "generated", "manifest.json"), "utf8")).pin.pstackVersion).toBe("0.15.46");
  });

  test("専用ランチャーから起動したセッションで、メインの session_start より前（拡張の読み込み）に、利用者の設定の実効値を土台に、スキルの読み込み先・OMP 向けのディレクトリ・一覧から外す全スキルが実行時の層に入る", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    expect((await sb.run("apply")).exitCode).toBe(0);

    const result = await sb.extension({ launcher: sb.launcher }).run({
      settings: {
        extensions: ["/somewhere/ext-a"],
        "skills.customDirectories": ["/somewhere/skills"],
        "skills.manualSkills": ["private-*"],
        disabledExtensions: ["skill:foo", "skill:tdd"],
      },
      sessions: [{ agent: MAIN, toolCalls: 1 }],
    });

    const expected = {
      // 制御の拡張のファイル（子と孫も同じ拡張を読む）と OMP 向けのディレクトリを足す
      extensions: ["/somewhere/ext-a", copyPath(sb, "omp/control/index.ts"), copyPath(sb, "omp/content")],
      // 写しの中の生成した pstack と cursor-team-kit を先頭に置き、pstack の tdd を利用者の置き場の tdd より優先させる
      "skills.customDirectories": [copyPath(sb, "omp/generated/pstack/skills"), copyPath(sb, "omp/generated/cursor-team-kit/skills"), "/somewhere/skills"],
      "skills.manualSkills": ["private-*", ...MANUAL],
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

    const result = await confined(sb).run({
      settings: {},
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

    const result = await confined(sb).run({
      settings: {},
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

    const result = await confined(sb).run({ settings: {}, mirror: true, sessions: [{ agent: SUB, toolCalls: 1 }] });

    expect(result.overrides).toEqual([]);
    expect(result.toolCalls).toEqual([[null]]);
  });
});

// 写しを壊す操作
const damages: { name: string; damage(sb: Sandbox): void }[] = [
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
    name: "写しの生成したスキルの置き場に、記録に無いスキルが足された",
    damage: (sb) => put(join(sb.copy, "generated", "pstack", "skills", "extra", "SKILL.md"), skillMd("extra", "足した")),
  },
  {
    name: "組の記録の skillDirectories が写しの外（データ置き場の生成物）を指す",
    damage: (sb) => writeHarness(sb, { ...harnessOf(sb), skillDirectories: ["pstack", "cursor-team-kit"].map((root) => join(realpathSync(sb.generated), root, "skills")) }),
  },
  {
    name: "写しの規則が書き換えられた（sha256 が記録と違う）",
    damage: (sb) => writeFileSync(join(sb.copy, "control", "rules.json"), "{}"),
  },
];

describe("制御の拡張が読む組が正しくないとき", () => {
  test.each(damages)("$name: メインでも子でも読み込みの設定と規則を書かず、全ツールと子の起動を理由つきで遮断する", async ({ damage }) => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    damage(sb);

    const result = await confined(sb).run({
      settings: {},
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
    expect(result.notices.join("\n")).toContain("ツールを実行しません");
  });

  test("いまの OMP の設定の置き場（PI_CODING_AGENT_DIR）が、組の記録の置き場と違えば遮断する", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);

    const result = await confined(sb).run({ settings: {}, env: { PI_CODING_AGENT_DIR: join(sb.root, "other-agent") }, sessions: [{ agent: MAIN, toolCalls: 1 }] });

    expect(result.overrides).toEqual([]);
    expect(result.toolCalls[0]![0]?.block).toBe(true);
    expect(result.toolCalls[0]![0]?.reason).toContain("いまの置き場");
  });

  test("データ置き場の生成物が消えても、写しが揃っていれば上書きし、ツールを遮断しない", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    rmSync(sb.generated, { recursive: true });

    const result = await confined(sb).run({ settings: {}, sessions: [{ agent: MAIN, toolCalls: 1 }] });

    expect(result.effective["skills.customDirectories"]).toEqual([copyPath(sb, "omp/generated/pstack/skills"), copyPath(sb, "omp/generated/cursor-team-kit/skills")]);
    expect(result.toolCalls).toEqual([[null]]);
  });
});

describe("適用の時刻で組の検証を省かない", () => {
  test("再適用より前に始まったプロセスも、正しい組なら検証してから読み込みの設定と規則を書く", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    // 拡張を読み込むプロセスを先に始めておく（開始が再適用の時刻より前になる）
    const before = confined(sb);
    expect((await sb.run("apply")).exitCode).toBe(0);

    const result = await before.run({ settings: {}, sessions: [{ agent: MAIN, toolCalls: 1 }] });

    expect(result.effective["skills.manualSkills"]).toEqual(MANUAL);
    expect(result.effective["tools.approval"]).toEqual({ eval: "deny" });
    expect(result.toolCalls).toEqual([[null]]);
  });

  test.each(damages)("$name: 再適用より前に始まったプロセスでも、組を検証して、読み込みの設定を書かずに遮断する", async ({ damage }) => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    const before = confined(sb);
    expect((await sb.run("apply")).exitCode).toBe(0);
    damage(sb);

    const result = await before.run({
      settings: {},
      sessions: [
        { agent: MAIN, toolCalls: 2, spawns: ["scout"] },
        { agent: SUB, toolCalls: 1, spawns: ["scout"] },
      ],
    });

    expect(result.overrides).toEqual([]);
    for (const call of [...result.toolCalls.flat(), ...result.spawns.flat()]) expect(call?.block).toBe(true);
    expect(result.harnessEnv).toBeNull();
  });

  test.each([
    ["未来", "2999-01-01T00:00:00.000Z"],
    ["過去", "2000-01-01T00:00:00.000Z"],
  ] as const)("組の記録の適用の時刻を%sにしても、正しい組では読み込みの設定を書き、壊れた組では遮断する", async (_, appliedAt) => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    writeHarness(sb, { ...harnessOf(sb), appliedAt });

    const healthy = await confined(sb).run({ settings: {}, sessions: [{ agent: MAIN, toolCalls: 1 }] });
    rmSync(join(sb.copy, "control", "rules.json"));
    const broken = await confined(sb).run({ settings: {}, sessions: [{ agent: MAIN, toolCalls: 1 }] });

    expect(healthy.effective["skills.manualSkills"]).toEqual(MANUAL);
    expect(healthy.toolCalls).toEqual([[null]]);
    expect(broken.overrides).toEqual([]);
    expect(broken.toolCalls[0]![0]?.block).toBe(true);
  });
});

// 写しの中身。harness.json は適用の時刻を除いた形で比べる
function copyContents(sb: Sandbox): unknown {
  const files = Object.fromEntries(snapshot(sb.copy));
  const harness = harnessOf(sb);
  delete harness.appliedAt;
  delete files["control/harness.json"];
  return { files, harness };
}

describe("解除", () => {
  test("解除すると写し（専用ランチャー・制御の拡張・生成物の写し）が消え、config.yml は変わらない。生成物と上流の clone は残る", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    expect((await sb.run("apply")).exitCode).toBe(0);

    const run = await sb.run("remove");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("専用ランチャーは無くなりました");
    expect(run.stdout).not.toContain("OMP の設定");
    expect(readFileSync(sb.configPath, "utf8")).toBe(USER_CONFIG);
    expect(existsSync(sb.copy)).toBe(false);
    expect(existsSync(join(sb.generated, "manifest.json"))).toBe(true);
    expect(existsSync(sb.clone)).toBe(true);
  });

  test("適用を繰り返しても写しの中身は変わらず、解除を繰り返しても結果が変わらず、適用と解除を繰り返しても同じ結果になる", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    expect((await sb.run("apply")).exitCode).toBe(0);
    const copy = copyContents(sb);

    const again = await sb.run("apply");
    expect(again.stderr).toBe("");
    expect(again.exitCode).toBe(0);
    expect(copyContents(sb)).toEqual(copy);
    expect((await sb.run("remove")).exitCode).toBe(0);
    const twice = await sb.run("remove");
    expect(twice.exitCode).toBe(0);
    expect(twice.stdout).toContain("適用していません");
    expect((await sb.run("apply")).exitCode).toBe(0);
    expect(copyContents(sb)).toEqual(copy);
    expect((await sb.run("remove")).exitCode).toBe(0);

    expect(readFileSync(sb.configPath, "utf8")).toBe(USER_CONFIG);
    expect(existsSync(sb.copy)).toBe(false);
  });

  test("別の OMP の設定の置き場を指した解除と適用は、写しを消さず、何も変えずに止まる", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    const copy = snapshot(sb.copy);
    const other = join(sb.root, "other-agent");
    put(join(other, "config.yml"), USER_CONFIG);

    const runs = [await sb.run("remove", { env: { PI_CODING_AGENT_DIR: other } }), await sb.run("apply", { env: { PI_CODING_AGENT_DIR: other } })];

    for (const run of runs) {
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("別の OMP の設定の置き場");
    }
    expect(snapshot(sb.copy)).toEqual(copy);
    expect(readFileSync(join(other, "config.yml"), "utf8")).toBe(USER_CONFIG);
  });

  const unresolvable: { name: string; env: Record<string, string>; shows: string }[] = [
    { name: "環境変数 OMP_PROFILE で名前つきの profile を選んだ", env: { OMP_PROFILE: "work" }, shows: "名前つきの profile（work）" },
    { name: "環境変数 PI_PROFILE で名前つきの profile を選んだ", env: { PI_PROFILE: "work" }, shows: "名前つきの profile（work）" },
    { name: "環境変数 PI_CONFIG_DIR で OMP の設定の根を変えた", env: { PI_CONFIG_DIR: ".omp-work" }, shows: "PI_CONFIG_DIR" },
  ];

  test.each(unresolvable)("$name: 同期は行えるが、適用・解除・状態の表示は理由を出して止まり、写しも設定も変わらない", async ({ env, shows }) => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    expect((await sb.run("apply")).exitCode).toBe(0);
    const copy = snapshot(sb.copy);

    const resynced = await sb.run("sync", { env });
    const runs = [await sb.run("apply", { env }), await sb.run("remove", { env }), await sb.run("status", { env })];

    expect(resynced.exitCode).toBe(0);
    for (const run of runs) {
      expect(run.exitCode).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("OMP の設定の置き場を決められません");
      expect(run.stderr).toContain(shows);
    }
    expect(snapshot(sb.copy)).toEqual(copy);
    expect(readFileSync(sb.configPath, "utf8")).toBe(USER_CONFIG);
  });
});

// 以前の配置（config.yml に読み込みの設定を入れた適用）が残した config.yml。USER_CONFIG に、写しを指す項目と読み込む全スキルの名前を足した形
function legacyConfig(sb: Sandbox): string {
  return Bun.YAML.stringify(
    {
      modelRoles: { task: "anthropic/claude-opus-5-5:high" },
      extensions: ["/somewhere/ext-a", copyPath(sb, "omp/control/index.ts"), copyPath(sb, "omp/content")],
      skills: {
        customDirectories: [copyPath(sb, "omp/generated/pstack/skills"), copyPath(sb, "omp/generated/cursor-team-kit/skills"), "/somewhere/skills"],
        manualSkills: ["private-*", ...MANUAL],
      },
      disabledExtensions: ["skill:foo"],
    },
    null,
    2,
  );
}

// 適用した写しを、以前の配置のものにする: config.yml に読み込みの設定を入れ、record なら組の記録に config.yml を戻す記録（適用の前は
// USER_CONFIG）を入れる。record でなければ組の記録を消す
function legacy(sb: Sandbox, record: boolean, after: string): void {
  writeConfig(sb, after);
  if (!record) {
    rmSync(join(sb.copy, "control", "harness.json"));
    return;
  }
  writeHarness(sb, {
    ...harnessOf(sb),
    version: 1,
    config: {
      path: realpathSync(sb.configPath),
      before: Buffer.from(USER_CONFIG).toString("base64"),
      after: new Bun.CryptoHasher("sha256").update(legacyConfig(sb)).digest("hex"),
      addedKeys: [],
      addedManualSkills: MANUAL,
    },
  });
}

describe("以前の配置からの切替", () => {
  test.each(["apply", "remove"])("以前の配置の記録があり、その後 config.yml が変わっていなければ、%s で以前の適用の前のバイト（コメントも）に戻る", async (command) => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    legacy(sb, true, legacyConfig(sb));

    const run = await sb.run(command);

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("以前の適用の前のバイトに戻しました");
    expect(readFileSync(sb.configPath, "utf8")).toBe(USER_CONFIG);
  });

  test.each(["apply", "remove"])("以前の配置の記録があり、その後に利用者が config.yml を変えていれば、%s で管理対象の項目だけを外し、既存値と利用者の変更を残す", async (command) => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    const edited = Bun.YAML.parse(legacyConfig(sb)) as { extensions: string[]; skills: { customDirectories: string[]; manualSkills: string[] } };
    legacy(
      sb,
      true,
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

    const run = await sb.run(command);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("以前の配置の読み込みの設定");
    expect(Bun.YAML.parse(readFileSync(sb.configPath, "utf8"))).toEqual({
      modelRoles: { task: "anthropic/claude-opus-5-5:high" },
      extensions: ["/somewhere/ext-a", "/somewhere/ext-b"],
      skills: { customDirectories: ["/somewhere/skills", "/somewhere/more"], manualSkills: ["private-*", "mine"] },
      disabledExtensions: ["skill:foo"],
      theme: "dark",
    });
  });

  test.each(["apply", "remove"])("以前の配置の記録が無ければ、%s で写しを指す項目は外し、skills.manualSkills の名前は外さずに、残ったことを知らせる", async (command) => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    legacy(sb, false, legacyConfig(sb));

    const run = await sb.run(command);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`skills.manualSkills に、以前の配置が足したかもしれない名前 ${MANUAL.join(", ")} が残っています`);
    expect(Bun.YAML.parse(readFileSync(sb.configPath, "utf8"))).toEqual({
      modelRoles: { task: "anthropic/claude-opus-5-5:high" },
      extensions: ["/somewhere/ext-a"],
      skills: { customDirectories: ["/somewhere/skills"], manualSkills: ["private-*", ...MANUAL] },
      disabledExtensions: ["skill:foo"],
    });
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
    {
      name: "~/.agents/skills に生成したスキル（cursor-team-kit の deslop）と同じ名前がある",
      place: (sb) => {
        put(join(sb.home, ".agents", "skills", "deslop", "SKILL.md"), skillMd("deslop", "mine"));
        return join(sb.home, ".agents", "skills", "deslop", "SKILL.md");
      },
    },
    {
      name: "利用者の OMP のスキルの置き場に生成したスキル（pstack の poteto-mode）と同じ名前がある",
      place: (sb) => {
        put(join(sb.agentDir, "skills", "mode", "SKILL.md"), skillMd("poteto-mode", "mine"));
        return join(sb.agentDir, "skills", "mode", "SKILL.md");
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

  test("利用者の置き場の定義やスキルのファイルが在るのに読めないと、同じ名前かを確かめられないので、そのファイルを報告して止まり、設定と写しは何も変わらない", async () => {
    const sb = await synced();
    put(sb.configPath, "theme: dark\n");
    const locked = join(sb.home, ".agents", "skills", "locked", "SKILL.md");
    put(locked, skillMd("locked", "mine"));
    chmodSync(locked, 0o000);
    const folder = join(sb.agentDir, "skills", "folder", "SKILL.md");
    mkdirSync(folder, { recursive: true });

    const run = await sb.run("apply");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("止めました: 利用者の置き場に、読めない定義やスキルのファイルがあり");
    expect(run.stderr).toContain(locked);
    expect(run.stderr).toContain(folder);
    expect(readFileSync(sb.configPath, "utf8")).toBe("theme: dark\n");
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

  test("利用者の置き場に tdd があっても止めず、専用ランチャーでは pstack の tdd が優先されることを報告する", async () => {
    const sb = await synced();
    const mine = join(sb.home, ".agents", "skills", "tdd", "SKILL.md");
    put(mine, skillMd("tdd", "mine"));

    const run = await sb.run("apply");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`利用者の置き場の tdd（${mine}）より、専用ランチャーから起動したセッションでは pstack の tdd が優先されます`);
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

describe("OMP の版と実行ファイル", () => {
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

  test("写しの bin を PATH の先頭に置いた端末から再適用しても、版の確認と組の記録の omp は PATH の次の本物の omp になる", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    const env = { NOD_PSTACK_OMP_OMP_BIN: undefined, PATH: [dirname(sb.launcher), dirname(sb.ompBin), process.env.PATH].join(":") };

    const run = await sb.run("apply", { env });
    const status = await sb.run("status", { env });

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(harnessOf(sb).ompBin).toBe(realpathSync(sb.ompBin));
    expect(readFileSync(sb.launcher, "utf8")).toContain(`'${realpathSync(sb.ompBin)}' -e`);
    expect(status.stdout).toContain("OMP の版: 19.1.0（固定の記録 19.1.0、適用したときの記録 19.1.0）\n");
  });

  test("NOD_PSTACK_OMP_OMP_BIN が写しの中の専用ランチャーを指すと、何も変えずに止まる", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    const copy = snapshot(sb.copy);

    const run = await sb.run("apply", { env: { NOD_PSTACK_OMP_OMP_BIN: sb.launcher } });

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("写し");
    expect(run.stderr).toContain("の中を指しています");
    expect(snapshot(sb.copy)).toEqual(copy);
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

  test("生成物が無ければ（同期していない）、sync を案内して止まり、何も作らない", async () => {
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

  test("以前の配置の項目を取り除く config.yml の置き場に書き込めなければ止まり、config.yml も写しも変わらない", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    legacy(sb, false, legacyConfig(sb));
    const config = readFileSync(sb.configPath, "utf8");
    const copy = snapshot(sb.copy);
    chmodSync(sb.agentDir, 0o555);

    const runs = [await sb.run("apply"), await sb.run("remove")];

    chmodSync(sb.agentDir, 0o755);
    for (const run of runs) {
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain(realpathSync(sb.agentDir));
    }
    expect(readFileSync(sb.configPath, "utf8")).toBe(config);
    expect(snapshot(sb.copy)).toEqual(copy);
  });

  test("前の適用がある状態で、写しの置き場に書き込めず止まっても、前の写しと config.yml はそのまま残る", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    expect((await sb.run("apply")).exitCode).toBe(0);
    const copy = snapshot(sb.copy);
    sb.content("agents/poteto-agent.md", POTETO_AGENT);
    chmodSync(join(sb.dataDir, "pstack-omp"), 0o555);

    const run = await sb.run("apply");

    chmodSync(join(sb.dataDir, "pstack-omp"), 0o755);
    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("設定と写しは適用の前のまま");
    expect(readFileSync(sb.configPath, "utf8")).toBe(USER_CONFIG);
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
  test("写しは読み取り専用にせず（利用者がそのまま消せる）、制御の拡張と組の検証の入口と規則とプロファイルが control に入る", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);

    expect(readdirSync(join(sb.copy, "control")).sort()).toEqual(["harness.json", "index.ts", "omp.d.ts", "preflight.ts", "rules.json", "rules.ts", "sandbox.sb", "verify.ts"]);
    expect(readFileSync(join(sb.copy, "content", "skills", "pstack-omp", "SKILL.md"), "utf8")).toBe(readFileSync(join(sb.packageDir, "skills", "pstack-omp", "SKILL.md"), "utf8"));
    rmSync(sb.copy, { recursive: true });
    expect(existsSync(sb.copy)).toBe(false);
  });

  test("専用ランチャー（実行できる）とプロファイルを組の記録の sha256 に入れ、omp と bun の実行ファイルの実パスを記録する。ランチャーは制御の拡張のファイルを -e で渡し、引数をそのまま omp に渡す", async () => {
    const sb = await synced();

    expect((await sb.run("apply")).exitCode).toBe(0);

    const harness = harnessOf(sb) as { ompBin: string; bunBin: string; files: Record<string, string> };
    expect(harness.ompBin).toBe(realpathSync(sb.ompBin));
    expect(harness.bunBin).toBe(realpathSync(process.execPath));
    expect(Object.keys(harness.files)).toEqual(expect.arrayContaining(["bin/omp", "control/sandbox.sb", "control/preflight.ts", "control/index.ts"]));
    const echoed = await sb.launch('printf "%s|" "$FAKE_OMP_EXTENSION" "$@"', "a b", "it's", "c");
    expect(echoed.stderr).toBe("");
    expect(echoed.stdout).toBe(`${copyPath(sb, "omp/control/index.ts")}|a b|it's|c|`);
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

// リポジトリの実際の読み替え表で生成できる上流（表が示す comment-sicko の定義ファイルを、スキルからのリンクで生成物に入れる）
const REPO_UPSTREAM = {
  "pstack/skills/tdd/SKILL.md": skillMd("tdd", "Red, green."),
  "pstack/skills/no-comments/SKILL.md": skillMd("no-comments", "Spawn [the reviewer](../../agents/comment-sicko.md)."),
  "pstack/agents/comment-sicko.md": "---\nname: comment-sicko\n---\n\nReview comments.\n",
};

// OMP 向けのディレクトリを差し替えず、nod のリポジトリの omp/content（実際の読み替え表とエージェント定義）で同期した sandbox
async function repoSynced(): Promise<Sandbox> {
  const sb = sandbox({ repoTable: true });
  sb.commit("0.15.46", REPO_UPSTREAM);
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
    sb.commit("0.15.46", REPO_UPSTREAM);
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

  test.each(["toString", "constructor", "hasOwnProperty", "__proto__"])("継承されたプロパティと同じ名前のサブコマンド %s は、使い方を出して 2 で終わる", async (name) => {
    const sb = sandbox();

    const run = await sb.run(name);

    expect(run.exitCode).toBe(2);
    expect(run.stderr).toContain("使い方");
  });
});
