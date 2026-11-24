// pstack を OMP 向けに使う道具（scripts/pstack-omp/cli.ts）の適用（apply）・解除（remove）を、プロセスとして起動して外から確かめる。
// 利用者の OMP の設定の置き場（PI_CODING_AGENT_DIR）・ホーム（HOME）・データ置き場（NOD_DATA_DIR）は一時ディレクトリ（helpers.ts）。
// 適用は、写しをデータ置き場に置き、OMP が global の設定として読むファイル（config.yml、無ければ config.yaml）に3つの読み込みの設定を入れる。
import { describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { put, type Run, type Sandbox, sandbox, skillMd, snapshot, synced } from "./helpers";

// 利用者が既に書いている config.yml（コメントと、読み込みの設定とほかの設定を含む）
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

// USER_CONFIG の値
const USER_VALUES = {
  modelRoles: { task: "anthropic/claude-opus-5-5:high" },
  extensions: ["/somewhere/ext-a"],
  skills: { customDirectories: ["/somewhere/skills"], manualSkills: ["private-*"] },
  disabledExtensions: ["skill:foo"],
};

// 生成した全スキルと読み替え表のスキル（一覧から外す順）
const MANUAL = ["poteto-mode", "tdd", "control-cli", "control-ui", "deslop", "pstack-omp"];

function writeConfig(sb: Sandbox, text: string): void {
  put(sb.configPath, text);
}

function readYaml(path: string): unknown {
  return Bun.YAML.parse(readFileSync(path, "utf8"));
}

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

// 写しの中の位置（データ置き場は macOS の /var と /private/var のような別名を解いた形で書かれる）
function copyPath(sb: Sandbox, rel: string): string {
  return join(realpathSync(sb.dataDir), "pstack-omp", rel);
}

// 写しの中の生成したスキルの置き場（skills.customDirectories の先頭に入る順）
function skillDirs(sb: Sandbox): string[] {
  return [copyPath(sb, "omp/generated/pstack/skills"), copyPath(sb, "omp/generated/cursor-team-kit/skills")];
}

// USER_CONFIG に適用した後の値
function appliedValues(sb: Sandbox): Record<string, unknown> {
  return {
    ...USER_VALUES,
    extensions: ["/somewhere/ext-a", copyPath(sb, "omp/content")],
    skills: { customDirectories: [...skillDirs(sb), "/somewhere/skills"], manualSkills: ["private-*", ...MANUAL] },
  };
}

function harnessOf(sb: Sandbox): Record<string, unknown> {
  return JSON.parse(readFileSync(join(sb.copy, "harness.json"), "utf8")) as Record<string, unknown>;
}

// 利用者の OMP の設定の置き場の実パス（まだ無くても、ホームの別名を解いた形）
function agentDirReal(sb: Sandbox): string {
  return join(realpathSync(sb.home), ".omp", "agent");
}

describe("適用", () => {
  test("config.yml が在れば、3つの読み込みの設定を入れ、既にある値とほかのキーを保つ", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);

    const run = await sb.run("apply");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readYaml(sb.configPath)).toEqual(appliedValues(sb));
    expect(run.stdout).toContain(`OMP の設定 ${realpathSync(sb.configPath)} に読み込みの設定を入れました`);
    expect(run.stdout).toContain("新しく始める omp のセッションから");
  });

  test("config.yml も config.yaml も無ければ、config.yml を作って3つの読み込みの設定だけを書く", async () => {
    const sb = await synced();

    const run = await sb.run("apply");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readYaml(sb.configPath)).toEqual({ extensions: [copyPath(sb, "omp/content")], skills: { customDirectories: skillDirs(sb), manualSkills: MANUAL } });
    expect(existsSync(join(sb.agentDir, "config.yaml"))).toBe(false);
  });

  test("config.yml が無く config.yaml が在れば、config.yaml に書き、config.yml を作らない", async () => {
    const sb = await synced();
    const yaml = join(sb.agentDir, "config.yaml");
    put(yaml, USER_CONFIG);

    const run = await sb.run("apply");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readYaml(yaml)).toEqual(appliedValues(sb));
    expect(existsSync(sb.configPath)).toBe(false);
    expect(run.stdout).toContain(`OMP の設定 ${realpathSync(yaml)} に読み込みの設定を入れました`);
  });

  test("再適用では項目を重ねず、設定がそのとおりなら config.yml を書き換えない", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    expect((await sb.run("apply")).exitCode).toBe(0);
    const bytes = readFileSync(sb.configPath, "utf8");
    const inode = statSync(sb.configPath).ino;

    const again = await sb.run("apply");

    expect(again.stderr).toBe("");
    expect(again.exitCode).toBe(0);
    expect(readFileSync(sb.configPath, "utf8")).toBe(bytes);
    expect(statSync(sb.configPath).ino).toBe(inode);
    expect(again.stdout).toContain("変えていません");
  });

  test("適用の後に利用者が値を足してから再適用しても、項目を重ねず利用者の値を保つ", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    expect((await sb.run("apply")).exitCode).toBe(0);
    const edited = readYaml(sb.configPath) as { extensions: string[] };
    put(sb.configPath, Bun.YAML.stringify({ ...edited, theme: "dark", extensions: [...edited.extensions, "/somewhere/ext-b"] }, null, 2));

    expect((await sb.run("apply")).exitCode).toBe(0);

    const expected = appliedValues(sb);
    expect(readYaml(sb.configPath)).toEqual({ ...expected, theme: "dark", extensions: ["/somewhere/ext-a", "/somewhere/ext-b", copyPath(sb, "omp/content")] });
  });

  test("写しに OMP 向けのディレクトリ（content）と生成物（generated。manifest.json とスキルの外のリンク先の文書を含む）と組の記録だけが入り、専用ランチャーと制御の置き場は無い", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", {
      "pstack/skills/tdd/SKILL.md": skillMd("tdd", "Red, green. Read [the guide](../../docs/guide.md)."),
      "pstack/docs/guide.md": "# Guide\n",
    });
    sb.pin();
    expect((await sb.sync()).exitCode).toBe(0);

    expect((await sb.run("apply")).exitCode).toBe(0);

    expect(readdirSync(sb.copy).sort()).toEqual(["content", "generated", "harness.json"]);
    expect(snapshot(join(sb.copy, "generated"))).toEqual(snapshot(sb.generated));
    expect(readFileSync(join(sb.copy, "generated", "pstack", "docs", "guide.md"), "utf8")).toBe("# Guide\n");
    expect(readFileSync(join(sb.copy, "content", "skills", "pstack-omp", "SKILL.md"), "utf8")).toBe(readFileSync(join(sb.packageDir, "skills", "pstack-omp", "SKILL.md"), "utf8"));
  });

  test("組の記録は利用者だけが読み書きでき、写しの全ファイルの sha256・読み込みの設定・設定ファイルを戻すための記録を持つ", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);

    expect((await sb.run("apply")).exitCode).toBe(0);

    expect(statSync(join(sb.copy, "harness.json")).mode & 0o777).toBe(0o600);
    const harness = harnessOf(sb) as Record<string, unknown> & { files: Record<string, string>; config: Record<string, unknown> };
    expect(harness).toMatchObject({
      version: 3,
      ompVersion: "19.1.0",
      agentDir: agentDirReal(sb),
      content: copyPath(sb, "omp/content"),
      skillDirectories: skillDirs(sb),
      manualSkills: MANUAL,
    });
    const files = [...snapshot(sb.copy).keys()].filter((path) => path !== "harness.json");
    expect(Object.keys(harness.files).sort()).toEqual(files.sort());
    expect(harness.files["content/skills/pstack-omp/SKILL.md"]).toBe(sha256(readFileSync(join(sb.copy, "content", "skills", "pstack-omp", "SKILL.md"), "utf8")));
    expect(harness.config).toEqual({
      path: realpathSync(sb.configPath),
      before: Buffer.from(USER_CONFIG).toString("base64"),
      after: sha256(readFileSync(sb.configPath, "utf8")),
      addedKeys: [],
      addedManualSkills: MANUAL,
    });
  });

  test("写しは読み取り専用にしない（利用者がそのまま消せる）", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);

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

describe("解除", () => {
  test("適用の後に config.yml が変わっていなければ、適用の前のバイト（コメントも）に戻し、写しを消す。生成物と上流の clone は残る", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    expect((await sb.run("apply")).exitCode).toBe(0);

    const run = await sb.run("remove");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`OMP の設定 ${realpathSync(sb.configPath)} を適用の前のバイトに戻しました`);
    expect(run.stdout).toContain("次に始める omp のセッションから");
    expect(readFileSync(sb.configPath, "utf8")).toBe(USER_CONFIG);
    expect(existsSync(sb.copy)).toBe(false);
    expect(existsSync(join(sb.generated, "manifest.json"))).toBe(true);
    expect(existsSync(sb.clone)).toBe(true);
  });

  test("適用が config.yml を作っていれば、解除で config.yml が無くなる", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);

    expect((await sb.run("remove")).exitCode).toBe(0);

    expect(existsSync(sb.configPath)).toBe(false);
  });

  test("config.yaml に適用していれば、解除で config.yaml が適用の前のバイトに戻る", async () => {
    const sb = await synced();
    const yaml = join(sb.agentDir, "config.yaml");
    put(yaml, USER_CONFIG);
    expect((await sb.run("apply")).exitCode).toBe(0);

    expect((await sb.run("remove")).exitCode).toBe(0);

    expect(readFileSync(yaml, "utf8")).toBe(USER_CONFIG);
    expect(existsSync(sb.configPath)).toBe(false);
  });

  test("適用の後に利用者が config.yml を変えていれば、管理対象の項目だけを外して利用者の値を残す", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    expect((await sb.run("apply")).exitCode).toBe(0);
    const edited = readYaml(sb.configPath) as { skills: { manualSkills: string[] } };
    put(sb.configPath, Bun.YAML.stringify({ ...edited, theme: "dark", skills: { ...edited.skills, manualSkills: [...edited.skills.manualSkills, "mine"] } }, null, 2));

    const run = await sb.run("remove");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("管理対象の項目");
    expect(readYaml(sb.configPath)).toEqual({ ...USER_VALUES, theme: "dark", skills: { customDirectories: ["/somewhere/skills"], manualSkills: ["private-*", "mine"] } });
    expect(existsSync(sb.copy)).toBe(false);
  });

  test("適用が作ったキーは、管理対象の項目を外して空になれば消し、利用者の値が残るキーは残す", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    const edited = readYaml(sb.configPath) as { skills: { manualSkills: string[] } };
    put(sb.configPath, Bun.YAML.stringify({ ...edited, theme: "dark", skills: { ...edited.skills, manualSkills: [...edited.skills.manualSkills, "mine"] } }, null, 2));

    expect((await sb.run("remove")).exitCode).toBe(0);

    expect(readYaml(sb.configPath)).toEqual({ theme: "dark", skills: { manualSkills: ["mine"] } });
  });

  test("適用の前から skills.manualSkills に在った名前は、解除で残す", async () => {
    const sb = await synced();
    writeConfig(sb, "skills:\n  manualSkills:\n    - tdd\n");
    expect((await sb.run("apply")).exitCode).toBe(0);
    const edited = readYaml(sb.configPath) as Record<string, unknown>;
    put(sb.configPath, Bun.YAML.stringify({ ...edited, theme: "dark" }, null, 2));

    expect((await sb.run("remove")).exitCode).toBe(0);

    expect(readYaml(sb.configPath)).toEqual({ theme: "dark", skills: { manualSkills: ["tdd"] } });
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
    expect(readFileSync(sb.configPath, "utf8")).toBe(USER_CONFIG);
    expect((await sb.run("apply")).exitCode).toBe(0);
    expect(copyContents(sb)).toEqual(copy);
    expect((await sb.run("remove")).exitCode).toBe(0);

    expect(readFileSync(sb.configPath, "utf8")).toBe(USER_CONFIG);
    expect(existsSync(sb.copy)).toBe(false);
  });

  test("適用していなければ、何も変えない", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);

    const run = await sb.run("remove");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("適用していません。何も変えていません");
    expect(readFileSync(sb.configPath, "utf8")).toBe(USER_CONFIG);
  });

  test("OMP の版が違っても解除できる", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    expect((await sb.run("apply")).exitCode).toBe(0);
    sb.omp("19.2.0");

    const run = await sb.run("remove");

    expect(run.exitCode).toBe(0);
    expect(readFileSync(sb.configPath, "utf8")).toBe(USER_CONFIG);
    expect(existsSync(sb.copy)).toBe(false);
  });

  test("別の OMP の設定の置き場を指した解除と適用は、写しを消さず、何も変えずに止まる", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    expect((await sb.run("apply")).exitCode).toBe(0);
    const copy = snapshot(sb.copy);
    const config = readFileSync(sb.configPath, "utf8");
    const other = join(sb.root, "other-agent");
    put(join(other, "config.yml"), USER_CONFIG);

    const runs = [await sb.run("remove", { env: { PI_CODING_AGENT_DIR: other } }), await sb.run("apply", { env: { PI_CODING_AGENT_DIR: other } })];

    for (const run of runs) {
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("別の OMP の設定の置き場");
    }
    expect(snapshot(sb.copy)).toEqual(copy);
    expect(readFileSync(join(other, "config.yml"), "utf8")).toBe(USER_CONFIG);
    expect(readFileSync(sb.configPath, "utf8")).toBe(config);
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
    const config = readFileSync(sb.configPath, "utf8");

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
    expect(readFileSync(sb.configPath, "utf8")).toBe(config);
  });
});

// 写しの中身。harness.json は適用の時刻を除いた形で比べる
function copyContents(sb: Sandbox): unknown {
  const files = Object.fromEntries(snapshot(sb.copy));
  const harness = harnessOf(sb);
  delete harness.appliedAt;
  delete files["harness.json"];
  return { files, harness };
}

// 旧管理配置の写し: いまの OMP 向けのディレクトリと生成物の写しに、専用ランチャー（bin/omp）と制御の置き場（control/。拡張・規則・
// サンドボックスのプロファイル・設定の重ね・組の検証）を足したもの。record が在れば control/harness.json に書く
function legacyCopy(sb: Sandbox, record?: Record<string, unknown>): void {
  cpSync(sb.packageDir, join(sb.copy, "content"), { recursive: true });
  cpSync(sb.generated, join(sb.copy, "generated"), { recursive: true });
  put(join(sb.copy, "bin", "omp"), "#!/bin/sh\nexit 1\n");
  for (const name of ["index.ts", "preflight.ts", "verify.ts", "rules.ts", "rules.json", "sandbox.sb", "bash-patterns.yml"]) put(join(sb.copy, "control", name), "old\n");
  if (record !== undefined) put(join(sb.copy, "control", "harness.json"), JSON.stringify(record));
}

// 旧管理配置の組の記録（version 1 は config.yml に読み込みの設定と制御を入れた配置で config の記録を持つ。version 2 は専用ランチャーの配置）
function legacyRecord(sb: Sandbox, version: 1 | 2, config?: Record<string, unknown>): Record<string, unknown> {
  return {
    version,
    appliedAt: "2026-11-20T00:00:00.000Z",
    pin: { repository: "x", commit: "0".repeat(40), pstackVersion: "0.15.46", ompVersion: "19.1.0" },
    ompVersion: "19.1.0",
    content: copyPath(sb, "omp/content"),
    control: copyPath(sb, "omp/control"),
    agentDir: agentDirReal(sb),
    skillDirectories: skillDirs(sb),
    manualSkills: MANUAL,
    files: {},
    ...(config === undefined ? {} : { config }),
  };
}

// 旧 config 配置が USER_CONFIG に入れた形（extensions に写しの control と content、skills.customDirectories の先頭に生成したスキルの置き場、
// skills.manualSkills に読み込む全スキル）
function legacyConfig(sb: Sandbox): string {
  return Bun.YAML.stringify(
    {
      ...USER_VALUES,
      extensions: ["/somewhere/ext-a", copyPath(sb, "omp/control"), copyPath(sb, "omp/content")],
      skills: { customDirectories: [...skillDirs(sb), "/somewhere/skills"], manualSkills: ["private-*", ...MANUAL] },
    },
    null,
    2,
  );
}

// 旧 config 配置（version 1）: config.yml を after にし、記録は config.yml を before（null なら旧の適用が作った）に戻すためのもの
function legacyConfigLayout(sb: Sandbox, after: string, before: string | null = USER_CONFIG): void {
  writeConfig(sb, after);
  legacyCopy(
    sb,
    legacyRecord(sb, 1, {
      path: realpathSync(sb.configPath),
      before: before === null ? null : Buffer.from(before).toString("base64"),
      after: sha256(legacyConfig(sb)),
      addedKeys: [],
      addedManualSkills: MANUAL,
    }),
  );
}

describe("旧管理配置からの切替", () => {
  test("専用ランチャーの配置（version 2）から適用すると、写しの専用ランチャーと制御の置き場が消え、config.yml の利用者の値を保って3つの読み込みの設定が入る", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    legacyCopy(sb, legacyRecord(sb, 2));

    const run = await sb.run("apply");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readdirSync(sb.copy).sort()).toEqual(["content", "generated", "harness.json"]);
    expect(readYaml(sb.configPath)).toEqual(appliedValues(sb));
    expect(run.stdout).toContain("旧管理配置の写し（専用ランチャー・制御の拡張・規則・サンドボックスのプロファイル）を消しました");
  });

  test("専用ランチャーの配置（version 2）から解除すると、写しが消え、config.yml は変わらない", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    legacyCopy(sb, legacyRecord(sb, 2));

    const run = await sb.run("remove");

    expect(run.exitCode).toBe(0);
    expect(existsSync(sb.copy)).toBe(false);
    expect(readFileSync(sb.configPath, "utf8")).toBe(USER_CONFIG);
  });

  test("旧 config 配置（version 1）の記録の after と config.yml が同じなら、適用は旧の適用の前を引き継ぎ、続く解除で旧の適用の前のバイト（コメントも）に戻る", async () => {
    const sb = await synced();
    legacyConfigLayout(sb, legacyConfig(sb));

    const run = await sb.run("apply");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readYaml(sb.configPath)).toEqual(appliedValues(sb));
    expect(readdirSync(sb.copy).sort()).toEqual(["content", "generated", "harness.json"]);
    expect(run.stdout).toContain("旧管理配置の適用の前のバイトに戻しました");
    expect((await sb.run("remove")).exitCode).toBe(0);
    expect(readFileSync(sb.configPath, "utf8")).toBe(USER_CONFIG);
  });

  test("旧 config 配置（version 1）の記録の after と config.yml が同じなら、解除で旧の適用の前のバイトに戻り、写しが消える", async () => {
    const sb = await synced();
    legacyConfigLayout(sb, legacyConfig(sb));

    const run = await sb.run("remove");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readFileSync(sb.configPath, "utf8")).toBe(USER_CONFIG);
    expect(existsSync(sb.copy)).toBe(false);
  });

  // 旧の適用の後に利用者が config.yml を変えた形
  function editedLegacy(sb: Sandbox): string {
    const edited = Bun.YAML.parse(legacyConfig(sb)) as { extensions: string[]; skills: { customDirectories: string[]; manualSkills: string[] } };
    return Bun.YAML.stringify(
      {
        ...edited,
        theme: "dark",
        extensions: [...edited.extensions, "/somewhere/ext-b"],
        skills: { customDirectories: [...edited.skills.customDirectories, "/somewhere/more"], manualSkills: [...edited.skills.manualSkills, "mine"] },
      },
      null,
      2,
    );
  }

  // editedLegacy から旧管理値を外した利用者の値
  const editedUser = {
    ...USER_VALUES,
    theme: "dark",
    extensions: ["/somewhere/ext-a", "/somewhere/ext-b"],
    skills: { customDirectories: ["/somewhere/skills", "/somewhere/more"], manualSkills: ["private-*", "mine"] },
  };

  test("旧 config 配置（version 1）の後に利用者が config.yml を変えていれば、適用は旧管理値だけを外して利用者の値を保ち、3つの読み込みの設定を入れる", async () => {
    const sb = await synced();
    legacyConfigLayout(sb, editedLegacy(sb));

    const run = await sb.run("apply");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("旧管理配置の項目");
    expect(readYaml(sb.configPath)).toEqual({
      ...editedUser,
      extensions: [...editedUser.extensions, copyPath(sb, "omp/content")],
      skills: { customDirectories: [...skillDirs(sb), ...editedUser.skills.customDirectories], manualSkills: [...editedUser.skills.manualSkills, ...MANUAL] },
    });
    expect((await sb.run("remove")).exitCode).toBe(0);
    expect(readYaml(sb.configPath)).toEqual(editedUser);
  });

  test("旧 config 配置（version 1）の後に利用者が config.yml を変えていれば、解除は旧管理値だけを外して利用者の値を残す", async () => {
    const sb = await synced();
    legacyConfigLayout(sb, editedLegacy(sb));

    const run = await sb.run("remove");

    expect(run.exitCode).toBe(0);
    expect(readYaml(sb.configPath)).toEqual(editedUser);
    expect(existsSync(sb.copy)).toBe(false);
  });

  test.each(["apply", "remove"])("旧管理配置の記録が無ければ、%s で写しの中を指す項目は外し、skills.manualSkills の名前は外さずに、残ったことを知らせる", async (command) => {
    const sb = await synced();
    writeConfig(sb, legacyConfig(sb));
    legacyCopy(sb);

    const run = await sb.run(command);

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`skills.manualSkills に、旧管理配置が足したかもしれない名前 ${MANUAL.join(", ")} が残っています`);
    expect(run.stdout).not.toContain("旧管理配置の項目（写しの中を指す extensions・skills.customDirectories と、記録にある");
    const values = readYaml(sb.configPath) as Record<string, unknown> & { extensions: string[] };
    expect(values.extensions).not.toContain(copyPath(sb, "omp/control"));
    if (command === "remove") expect(values).toEqual({ ...USER_VALUES, skills: { customDirectories: ["/somewhere/skills"], manualSkills: ["private-*", ...MANUAL] } });
  });

  // 旧の適用が config.yml を作っていて（記録の before が null）、config.yml がその直後のままなら、取り除きで config.yml が消え、
  // その後の OMP は同じ置き場の config.yaml を global の設定として読む
  function legacyCreated(sb: Sandbox, clash: boolean): { yaml: string; path: string } {
    legacyConfigLayout(sb, legacyConfig(sb), null);
    const path = join(sb.root, "yaml-skills", "pstack-omp", "SKILL.md");
    put(path, skillMd(clash ? "pstack-omp" : "mine", "mine"));
    const yaml = `skills:\n  customDirectories:\n    - ${join(sb.root, "yaml-skills")}\n`;
    put(join(sb.agentDir, "config.yaml"), yaml);
    return { yaml, path };
  }

  test("旧の適用が作った config.yml を消すとき、その後に OMP が読む config.yaml の置き場に同じ名前があれば、止まって報告し、config.yml・config.yaml・写しは何も変わらない", async () => {
    const sb = await synced();
    const { yaml, path } = legacyCreated(sb, true);
    const copy = snapshot(sb.copy);

    const run = await sb.run("apply");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(path);
    expect(run.stderr).toContain("上書きしない");
    expect(readFileSync(sb.configPath, "utf8")).toBe(legacyConfig(sb));
    expect(readFileSync(join(sb.agentDir, "config.yaml"), "utf8")).toBe(yaml);
    expect(snapshot(sb.copy)).toEqual(copy);
  });

  test("旧の適用が作った config.yml を消すとき、その後に OMP が読む config.yaml の置き場に同じ名前が無ければ、config.yml を消して config.yaml に読み込みの設定を入れ、解除で config.yaml が元に戻る", async () => {
    const sb = await synced();
    const { yaml } = legacyCreated(sb, false);

    const run = await sb.run("apply");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(existsSync(sb.configPath)).toBe(false);
    expect(readYaml(join(sb.agentDir, "config.yaml"))).toEqual({
      extensions: [copyPath(sb, "omp/content")],
      skills: { customDirectories: [...skillDirs(sb), join(sb.root, "yaml-skills")], manualSkills: MANUAL },
    });
    expect((await sb.run("remove")).exitCode).toBe(0);
    expect(readFileSync(join(sb.agentDir, "config.yaml"), "utf8")).toBe(yaml);
    expect(existsSync(sb.configPath)).toBe(false);
  });

  // path を置き換え（rename）できなくして（macOS の不変フラグ。読み取りと、同じディレクトリへの一時ファイルの作成は通る）command を実行し、
  // 終わったらフラグを外す
  async function runImmutable(sb: Sandbox, path: string, command: string): Promise<Run> {
    const chflags = (flag: string): void => {
      const run = Bun.spawnSync(["chflags", flag, path]);
      if (run.exitCode !== 0) throw new Error(`chflags ${flag} に失敗: ${run.stderr.toString()}`);
    };
    chflags("uchg");
    try {
      return await sb.run(command);
    } finally {
      chflags("nouchg");
    }
  }

  test.skipIf(process.platform !== "darwin")(
    "旧の適用が作った config.yml を消して config.yaml に書く適用で、config.yaml の置き換えに失敗したら、消した config.yml を元のバイトに戻し、写しも前のままにして止まり、続く適用で移行する",
    async () => {
      const sb = await synced();
      const { yaml } = legacyCreated(sb, false);
      const yamlPath = join(sb.agentDir, "config.yaml");
      const copy = snapshot(sb.copy);

      const run = await runImmutable(sb, yamlPath, "apply");

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("設定と写しは適用の前のまま");
      expect(readFileSync(sb.configPath, "utf8")).toBe(legacyConfig(sb));
      expect(readFileSync(yamlPath, "utf8")).toBe(yaml);
      expect(snapshot(sb.copy)).toEqual(copy);
      const retry = await sb.run("apply");
      expect(retry.stderr).toBe("");
      expect(retry.exitCode).toBe(0);
      expect(existsSync(sb.configPath)).toBe(false);
      expect(readYaml(yamlPath)).toEqual({
        extensions: [copyPath(sb, "omp/content")],
        skills: { customDirectories: [...skillDirs(sb), join(sb.root, "yaml-skills")], manualSkills: MANUAL },
      });
    },
  );

  test.skipIf(process.platform !== "darwin")(
    "旧の適用が作った config.yml を消し、config.yaml から写しの中を指す項目を外す解除で、config.yaml の置き換えに失敗したら、config.yml・config.yaml・写しを前のままにして止まり、続く解除で外れる",
    async () => {
      const sb = await synced();
      const { yaml } = legacyCreated(sb, false);
      const yamlPath = join(sb.agentDir, "config.yaml");
      const withCopy = `${yaml}extensions:\n  - /somewhere/ext-a\n  - ${copyPath(sb, "omp/content")}\n`;
      put(yamlPath, withCopy);
      const copy = snapshot(sb.copy);

      const run = await runImmutable(sb, yamlPath, "remove");

      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain("設定と写しは解除の前のまま");
      expect(readFileSync(sb.configPath, "utf8")).toBe(legacyConfig(sb));
      expect(readFileSync(yamlPath, "utf8")).toBe(withCopy);
      expect(snapshot(sb.copy)).toEqual(copy);
      const retry = await sb.run("remove");
      expect(retry.exitCode).toBe(0);
      expect(existsSync(sb.configPath)).toBe(false);
      expect(readYaml(yamlPath)).toEqual({ skills: { customDirectories: [join(sb.root, "yaml-skills")] }, extensions: ["/somewhere/ext-a"] });
      expect(existsSync(sb.copy)).toBe(false);
    },
  );
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
    {
      name: "利用者の OMP のスキルの置き場の name が、引用符つきの前後の空白（改行を含む）を除くと生成したスキル（pstack の poteto-mode）と同じ（OMP は前後の空白を除く）",
      place: (sb) => {
        put(join(sb.agentDir, "skills", "mode", "SKILL.md"), '---\nname: " poteto-mode\\n"\ndescription: test\n---\n\n# mine\n');
        return join(sb.agentDir, "skills", "mode", "SKILL.md");
      },
    },
    {
      name: "~/.agents/skills の name が空白だけで、ディレクトリ名が pstack-omp（OMP は空になった名前をディレクトリ名にする）",
      place: (sb) => {
        put(join(sb.home, ".agents", "skills", "pstack-omp", "SKILL.md"), '---\nname: "   "\ndescription: test\n---\n\n# mine\n');
        return join(sb.home, ".agents", "skills", "pstack-omp", "SKILL.md");
      },
    },
    {
      name: "~/.agent/skills に生成したスキル（cursor-team-kit の deslop）と同じ名前がある",
      place: (sb) => {
        put(join(sb.home, ".agent", "skills", "deslop", "SKILL.md"), skillMd("deslop", "mine"));
        return join(sb.home, ".agent", "skills", "deslop", "SKILL.md");
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

  test("再適用では、今回置いた定義とスキル（config.yml の写しの中を指す項目）をぶつかりとして扱わない", async () => {
    const sb = await synced();
    sb.content("agents/poteto-agent.md", POTETO_AGENT);
    expect((await sb.run("apply")).exitCode).toBe(0);

    const again = await sb.run("apply");

    expect(again.stderr).toBe("");
    expect(again.exitCode).toBe(0);
  });

  test("利用者の置き場に tdd があっても止めず、pstack の tdd が優先されることを報告する", async () => {
    const sb = await synced();
    const mine = join(sb.home, ".agents", "skills", "tdd", "SKILL.md");
    put(mine, skillMd("tdd", "mine"));

    const run = await sb.run("apply");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`利用者の置き場の tdd（${mine}）より、pstack の tdd が優先されます`);
  });

  const yamlCases: { name: string; place(sb: Sandbox): { yaml: string; path: string } }[] = [
    {
      name: "skills.customDirectories の置き場に pstack-omp がある",
      place: (sb) => {
        put(join(sb.root, "my-skills", "pstack-omp", "SKILL.md"), skillMd("pstack-omp", "mine"));
        return { yaml: `skills:\n  customDirectories:\n    - ${join(sb.root, "my-skills")}\n`, path: join(sb.root, "my-skills", "pstack-omp", "SKILL.md") };
      },
    },
    {
      name: "skills.customDirectories の置き場に生成したスキル（cursor-team-kit の deslop）と同じ名前がある",
      place: (sb) => {
        put(join(sb.root, "my-skills", "deslop", "SKILL.md"), skillMd("deslop", "mine"));
        return { yaml: `skills:\n  customDirectories:\n    - ${join(sb.root, "my-skills")}\n`, path: join(sb.root, "my-skills", "deslop", "SKILL.md") };
      },
    },
    {
      name: "extensions のパッケージに poteto-agent がある",
      place: (sb) => {
        put(join(sb.root, "my-ext", "agents", "poteto-agent.md"), POTETO_AGENT);
        return { yaml: `extensions:\n  - ${join(sb.root, "my-ext")}\n`, path: join(sb.root, "my-ext", "agents", "poteto-agent.md") };
      },
    },
  ];

  test.each(yamlCases)("config.yml が無く、OMP が読む config.yaml の $name: 上書きせずに止まって報告し、設定と写しは何も変わらない", async ({ place }) => {
    const sb = await synced();
    sb.content("agents/poteto-agent.md", POTETO_AGENT);
    const { yaml, path } = place(sb);
    put(join(sb.agentDir, "config.yaml"), yaml);

    const run = await sb.run("apply");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(path);
    expect(run.stderr).toContain("上書きしない");
    expect(readFileSync(join(sb.agentDir, "config.yaml"), "utf8")).toBe(yaml);
    expect(existsSync(sb.configPath)).toBe(false);
    expect(existsSync(sb.copy)).toBe(false);
  });

  test("config.yml が在れば（空でも）、OMP は config.yaml を読まないので、config.yaml の置き場の同じ名前では止めず、config.yml に書く", async () => {
    const sb = await synced();
    put(sb.configPath, "");
    put(join(sb.root, "my-skills", "pstack-omp", "SKILL.md"), skillMd("pstack-omp", "mine"));
    const yaml = `skills:\n  customDirectories:\n    - ${join(sb.root, "my-skills")}\n`;
    put(join(sb.agentDir, "config.yaml"), yaml);

    const run = await sb.run("apply");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readYaml(sb.configPath)).toEqual({ extensions: [copyPath(sb, "omp/content")], skills: { customDirectories: skillDirs(sb), manualSkills: MANUAL } });
    expect(readFileSync(join(sb.agentDir, "config.yaml"), "utf8")).toBe(yaml);
  });

  test("config.yml が無く、OMP が読む config.yaml の置き場にだけ tdd があれば、止めずに報告し、状態の表示もそれが名前空間つきになると出す", async () => {
    const sb = await synced();
    const mine = join(sb.root, "my-skills", "tdd", "SKILL.md");
    put(mine, skillMd("tdd", "mine"));
    put(join(sb.agentDir, "config.yaml"), `skills:\n  customDirectories:\n    - ${join(sb.root, "my-skills")}\n`);

    const run = await sb.run("apply");
    const status = await sb.run("status");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`利用者の置き場の tdd（${mine}）より、pstack の tdd が優先されます`);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain(`通常の omp のセッション: pstack の tdd（${copyPath(sb, "omp/generated/pstack/skills/tdd/SKILL.md")}）が使われます`);
    expect(status.stdout).toContain(`利用者の置き場の tdd（${mine}）は、名前空間つきの <名前空間>/tdd の名前になります`);
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

  test("NOD_PSTACK_OMP_OMP_BIN が無ければ、PATH の omp で版を確かめる", async () => {
    const sb = await synced();

    const run = await sb.run("apply", { env: { NOD_PSTACK_OMP_OMP_BIN: undefined, PATH: [join(sb.ompBin, ".."), process.env.PATH].join(":") } });

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
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

  test.each([
    ["extensions が文字列の配列でない", "extensions: /somewhere\n", "extensions が文字列の配列ではありません"],
    ["skills がマッピングでない", "skills:\n  - a\n", "skills がマッピングではありません"],
  ])("config.yml の %sと止まり、config.yml も写しも変わらない", async (_, text, shows) => {
    const sb = await synced();
    writeConfig(sb, text);

    const run = await sb.run("apply");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(shows);
    expect(readFileSync(sb.configPath, "utf8")).toBe(text);
    expect(existsSync(sb.copy)).toBe(false);
  });

  test.each([
    ["YAML として読めない", "extensions: [unclosed\n", "YAML として読めません"],
    ["skills.customDirectories が文字列の配列でない", "skills:\n  customDirectories: /somewhere\n", "skills.customDirectories が文字列の配列ではありません"],
  ])("config.yml が無く、OMP が読む config.yaml が%sと止まり、config.yaml も写しも変わらない", async (_, text, shows) => {
    const sb = await synced();
    const yaml = join(sb.agentDir, "config.yaml");
    put(yaml, text);

    const run = await sb.run("apply");

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`OMP の設定 ${realpathSync(yaml)}`);
    expect(run.stderr).toContain(shows);
    expect(readFileSync(yaml, "utf8")).toBe(text);
    expect(existsSync(sb.configPath)).toBe(false);
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

  test("config.yml の置き場に書き込めなければ、適用も解除も止まり、config.yml も写しも変わらない", async () => {
    const sb = await synced();
    writeConfig(sb, USER_CONFIG);
    chmodSync(sb.agentDir, 0o555);
    const first = await sb.run("apply");
    chmodSync(sb.agentDir, 0o755);
    expect((await sb.run("apply")).exitCode).toBe(0);
    const config = readFileSync(sb.configPath, "utf8");
    const copy = snapshot(sb.copy);
    chmodSync(sb.agentDir, 0o555);

    const removed = await sb.run("remove");

    chmodSync(sb.agentDir, 0o755);
    expect(first.exitCode).toBe(1);
    expect(first.stderr).toContain(realpathSync(sb.agentDir));
    expect(removed.exitCode).toBe(1);
    expect(removed.stderr).toContain(realpathSync(sb.agentDir));
    expect(readFileSync(sb.configPath, "utf8")).toBe(config);
    expect(snapshot(sb.copy)).toEqual(copy);
  });

  test("旧管理配置の config.yml の置き場に書き込めなければ止まり、config.yml も旧の写しも変わらない", async () => {
    const sb = await synced();
    legacyConfigLayout(sb, legacyConfig(sb));
    const copy = snapshot(sb.copy);
    // 先にロックのファイルを作っておく（ロックを開く失敗ではなく、書き込みの失敗で止まることを確かめる）
    put(`${realpathSync(sb.configPath)}.lock`, "");
    chmodSync(sb.agentDir, 0o555);

    const runs = [await sb.run("apply"), await sb.run("remove")];

    chmodSync(sb.agentDir, 0o755);
    for (const run of runs) {
      expect(run.exitCode).toBe(1);
      expect(run.stderr).toContain(realpathSync(sb.agentDir));
    }
    expect(readFileSync(sb.configPath, "utf8")).toBe(legacyConfig(sb));
    expect(snapshot(sb.copy)).toEqual(copy);
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
