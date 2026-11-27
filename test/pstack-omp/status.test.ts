// pstack を OMP 向けに使う道具（scripts/pstack-omp/cli.ts）の状態の表示（status）を、プロセスとして起動して外から確かめる。
// 利用者の OMP の設定の置き場・ホーム・データ置き場は一時ディレクトリ（helpers.ts）。status は読むだけなので、利用者が一度だけ手で入れる
// 3つの読み込みの設定は、テストが設定ファイルに直接書く（register）。
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { put, type Sandbox, sandbox, skillMd, snapshot, synced, tddRename } from "./helpers";

// 同期した上に、今回置くエージェント定義 poteto-agent を OMP 向けのディレクトリに置く
async function withAgent(): Promise<Sandbox> {
  const sb = await synced();
  sb.content("agents/poteto-agent.md", "---\nname: poteto-agent\ndescription: test\n---\n\nYou are poteto.\n");
  return sb;
}

// 読み込む全スキル（synced の生成したスキル。生成物の manifest の名前だけ）。pstack の tdd を pstack-tdd に改名したので、tdd ではなく pstack-tdd
const MANUAL = ["poteto-mode", "pstack-tdd", "control-cli", "control-ui", "deslop"];

// 生成先の中の、skills.customDirectories に登録するスキルの置き場
function skillDirs(sb: Sandbox): string[] {
  return [join(sb.generated, "pstack", "skills"), join(sb.generated, "cursor-team-kit", "skills")];
}

// 利用者が README のとおり一度だけ手で入れる3つの読み込みの設定を、設定ファイル（既定は config.yml）の既にある値を残して書く。
// skills.customDirectories は先頭に入れる。parts で入れるものを選べる
function register(
  sb: Sandbox,
  { file = sb.configPath, parts = { extensions: [sb.packageDir], customDirectories: skillDirs(sb), manualSkills: MANUAL } }: {
    file?: string;
    parts?: { extensions?: string[]; customDirectories?: string[]; manualSkills?: string[] };
  } = {},
): void {
  const values = ((existsSync(file) ? Bun.YAML.parse(readFileSync(file, "utf8")) : null) ?? {}) as {
    extensions?: string[];
    skills?: { customDirectories?: string[]; manualSkills?: string[] };
  };
  const skills = values.skills ?? {};
  if (parts.extensions) values.extensions = [...(values.extensions ?? []), ...parts.extensions];
  if (parts.customDirectories) skills.customDirectories = [...parts.customDirectories, ...(skills.customDirectories ?? [])];
  if (parts.manualSkills) skills.manualSkills = [...(skills.manualSkills ?? []), ...parts.manualSkills];
  if (parts.customDirectories || parts.manualSkills) values.skills = skills;
  put(file, Bun.YAML.stringify(values, null, 2));
}

// 生成先の pstack の tdd（pstack-tdd に改名したもの）
function pstackTdd(sb: Sandbox): string {
  return join(sb.generated, "pstack", "skills", "pstack-tdd", "SKILL.md");
}

// 登録した生成先の pstack-tdd を通常の omp が取るときの、pstack の tdd の行
function pstackTddUsable(path: string): string {
  return `  pstack の tdd: pstack-tdd の名前で使えます（${path}。skill://pstack-tdd・/skill:pstack-tdd で呼びます）\n`;
}

// 生成先を登録していないときの、pstack の tdd の行
const PSTACK_TDD_UNREAD = "  pstack の tdd: pstack-tdd の名前で生成していますが、通常の omp は読み込みません（通常の omp が読む置き場に pstack-tdd はありません）\n";

// 登録していないときに status が出す、一度だけ登録する値（そのまま貼れる YAML）
function registration(sb: Sandbox, names = MANUAL): string {
  return [
    "extensions:",
    `  - ${sb.packageDir}`,
    "skills:",
    "  customDirectories:",
    `    - ${sb.generated}/pstack/skills`,
    `    - ${sb.generated}/cursor-team-kit/skills`,
    "  manualSkills:",
    ...names.map((name) => `    - ${name}`),
    "",
  ].join("\n");
}

const REGISTERED = "→ 揃っています。通常の omp の新しく始めるセッションが pstack の生成したスキルと poteto-agent を読み込みます";
// 生成先を先頭に置く理由は、pstack の tdd を改名して名前だけの tdd を利用者に譲ったので、生成したスキルと同じ名前の利用者のスキルより優先するためにした
const HOW_TO_REGISTER =
  "一度だけ、次の3つを手で登録してください。既にある値は残し、skills.customDirectories の2つは先頭に置きます（生成したスキルと同じ名前の利用者のスキルより、生成したスキルを優先するため）。status は設定を書き換えません";

// プロジェクトの置き場の名前のぶつかりの節（見出しの次の行から）
function projectSection(stdout: string, root: string): string[] {
  return stdout.slice(stdout.indexOf(`プロジェクト（${root}）`)).trim().split("\n").slice(1);
}

// ホームを実パスにした環境。OMP 19.1.0 は claude・agents のプロジェクトの置き場を、実行したディレクトリ（実パス）とホームを書いたままの形で
// 比べて遡るので、ホームの下で実行するテストはホームを実パスにする
function realHome(sb: Sandbox): { home: string; env: Record<string, string> } {
  const home = realpathSync(sb.home);
  return { home, env: { HOME: home, PI_CODING_AGENT_DIR: join(home, ".omp", "agent") } };
}

const AGENT_CLASH = "エージェント poteto-agent。プロジェクトの定義が優先されるので、このプロジェクトでは今回の定義が使われません";
const NO_TDD = "通常の omp のセッション: tdd は読み込まれません（通常の omp が読む置き場に tdd はありません）";

describe("生成物・OMP の版・読み込みの設定", () => {
  test("登録していなければ、欠けている3つの読み込みの設定と、一度だけ登録する値をそのまま貼れる YAML（正確なパスと名前。pstack-tdd を含み tdd は含まない）で表示し、利用者の置き場の tdd が使われ、pstack の pstack-tdd は読み込まれないと表示する", async () => {
    const sb = await synced();
    const userTdd = join(sb.home, ".agents", "skills", "tdd", "SKILL.md");
    put(userTdd, skillMd("tdd", "mine"));
    const config = join(realpathSync(sb.home), ".omp", "agent", "config.yml");

    const run = await sb.run("status");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`  生成物 ${sb.generated}: 元にした pin は固定の記録と一致しています（${sb.cloneHead()}）\n`);
    expect(run.stdout).toContain("  OMP の版: 19.1.0（固定の記録 19.1.0）\n");
    expect(run.stdout).toContain(
      `  OMP の設定 ${config}: 読み込みの設定が欠けています（extensions に ${sb.packageDir} がありません、` +
        `skills.customDirectories に ${sb.generated}/pstack/skills がありません、skills.customDirectories に ${sb.generated}/cursor-team-kit/skills がありません、` +
        "skills.manualSkills に poteto-mode, pstack-tdd, control-cli, control-ui, deslop がありません）\n",
    );
    expect(run.stdout).toContain(`  → ${HOW_TO_REGISTER}\n${registration(sb)}どの tdd が使われるか:\n`);
    expect(run.stdout).toContain("    - pstack-tdd\n");
    expect(run.stdout).not.toContain("    - tdd\n");
    expect(run.stdout).not.toContain(REGISTERED);
    expect(run.stdout).toContain(`通常の omp のセッション: 利用者の置き場の tdd（${userTdd}）が使われます\n${PSTACK_TDD_UNREAD}`);
  });

  // pstack の tdd を pstack-tdd に改名したので、登録しても名前だけの tdd は利用者の置き場のもののまま（以前は pstack の tdd が取り、利用者の tdd が名前空間つきになった）
  test("登録していれば、3つの読み込みの設定が揃っていることと、通常の omp で名前だけの tdd は利用者の置き場のものが使われ、pstack の tdd は pstack-tdd の名前で使えることを表示し、登録する値は出さない", async () => {
    const sb = await synced();
    const userTdd = join(sb.home, ".agents", "skills", "tdd", "SKILL.md");
    put(userTdd, skillMd("tdd", "mine"));
    register(sb);

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`OMP の設定 ${realpathSync(sb.configPath)}: 3つの読み込みの設定が揃っています`);
    expect(run.stdout).toContain("元にした pin は固定の記録と一致しています");
    expect(run.stdout).toContain(`  ${REGISTERED}\n`);
    expect(run.stdout).not.toContain(HOW_TO_REGISTER);
    expect(run.stdout).not.toContain("extensions:\n");
    expect(run.stdout).toContain(`通常の omp のセッション: 利用者の置き場の tdd（${userTdd}）が使われます\n${pstackTddUsable(pstackTdd(sb))}`);
    expect(run.stdout).not.toContain("名前空間つき");
    expect(run.stdout).not.toContain("skills.manualSkills の");
  });

  test("~ で書いた登録も、ホームを展開して揃っていると判定する", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", { "pstack/skills/tdd/SKILL.md": skillMd("tdd", "Red, green.") });
    tddRename(sb);
    sb.pin();
    const dataDir = join(sb.home, ".local", "share", "nod");
    expect((await sb.sync(dataDir)).exitCode).toBe(0);
    put(
      sb.configPath,
      [
        "extensions:",
        `  - ${sb.packageDir}`,
        "skills:",
        "  customDirectories:",
        "    - ~/.local/share/nod/pstack-omp/generated/pstack/skills",
        "    - ~/.local/share/nod/pstack-omp/generated/cursor-team-kit/skills",
        "  manualSkills:",
        ...MANUAL.map((name) => `    - ${name}`),
        "",
      ].join("\n"),
    );

    const run = await sb.run("status", { dataDir });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("3つの読み込みの設定が揃っています");
    expect(run.stdout).toContain(`  ${REGISTERED}\n`);
    expect(run.stdout).toContain(`${NO_TDD}\n${pstackTddUsable(`${sb.home}/.local/share/nod/pstack-omp/generated/pstack/skills/pstack-tdd/SKILL.md`)}`);
  });

  const partial: { name: string; parts(sb: Sandbox): Parameters<typeof register>[1]; shows(sb: Sandbox): string }[] = [
    {
      name: "extensions だけ欠けている",
      parts: (sb) => ({ parts: { customDirectories: skillDirs(sb), manualSkills: MANUAL } }),
      shows: (sb) => `extensions に ${sb.packageDir} がありません`,
    },
    {
      name: "skills.customDirectories に cursor-team-kit の置き場だけ欠けている",
      parts: (sb) => ({ parts: { extensions: [sb.packageDir], customDirectories: skillDirs(sb).slice(0, 1), manualSkills: MANUAL } }),
      shows: (sb) => `skills.customDirectories に ${sb.generated}/cursor-team-kit/skills がありません`,
    },
    {
      name: "skills.manualSkills に pstack-tdd だけ欠けている",
      parts: (sb) => ({ parts: { extensions: [sb.packageDir], customDirectories: skillDirs(sb), manualSkills: MANUAL.filter((name) => name !== "pstack-tdd") } }),
      shows: () => "skills.manualSkills に pstack-tdd がありません",
    },
  ];

  test.each(partial)("一部だけ登録していれば（$name）、欠けたものだけを欠けていると表示し、登録する値を出す", async ({ parts, shows }) => {
    const sb = await synced();
    register(sb, parts(sb));

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`OMP の設定 ${realpathSync(sb.configPath)}: 読み込みの設定が欠けています（${shows(sb)}）\n`);
    expect(run.stdout).toContain(`  → ${HOW_TO_REGISTER}\n${registration(sb)}`);
    expect(run.stdout).not.toContain(REGISTERED);
  });

  test("skills.manualSkills の名前は OMP と同じくパターンとしても当て、合えば揃っていると判定する", async () => {
    const sb = await synced();
    register(sb, { parts: { extensions: [sb.packageDir], customDirectories: skillDirs(sb), manualSkills: ["*"] } });

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`  ${REGISTERED}\n`);
  });

  test("固定の記録を変えてスキルが増えたら、sync し直した後に、増えた名前が skills.manualSkills に欠けていると表示する", async () => {
    const sb = await synced();
    register(sb);
    sb.commit("0.15.47", { "pstack/skills/tdd/SKILL.md": skillMd("tdd", "Red, green."), "pstack/skills/added/SKILL.md": skillMd("added", "New.") });
    sb.pin();
    expect((await sb.sync()).exitCode).toBe(0);

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`OMP の設定 ${realpathSync(sb.configPath)}: 読み込みの設定が欠けています（skills.manualSkills に added がありません）\n`);
    expect(run.stdout).toContain(`  → ${HOW_TO_REGISTER}\n${registration(sb, ["added", ...MANUAL])}どの tdd が使われるか:\n`);
  });

  test("リポジトリの omp/content を使っても、一度だけ登録する値の skills.manualSkills は生成したスキルの名前だけで、以前の読み替え表 pstack-omp を含まず、それだけで揃う", async () => {
    const sb = sandbox({ repoContent: true });
    sb.commit("0.15.46", { "pstack/skills/tdd/SKILL.md": skillMd("tdd", "Red, green.") });
    tddRename(sb);
    sb.pin();
    expect((await sb.sync()).exitCode).toBe(0);

    const before = await sb.run("status");
    register(sb);
    const after = await sb.run("status");

    expect(before.exitCode).toBe(0);
    expect(before.stdout).toContain(`  → ${HOW_TO_REGISTER}\n${registration(sb)}どの tdd が使われるか:\n`);
    expect(before.stdout).not.toContain("- pstack-omp");
    expect(after.exitCode).toBe(0);
    expect(after.stdout).toContain(`  ${REGISTERED}\n`);
    expect(after.stdout).not.toContain("読み替え表");
  });

  test("config.yml が無く config.yaml に登録していれば、OMP が読むのは config.yaml であることと、揃っていることを表示する", async () => {
    const sb = await synced();
    const yaml = join(sb.agentDir, "config.yaml");
    put(yaml, "theme: dark\n");
    register(sb, { file: yaml });

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`OMP の設定 ${realpathSync(yaml)}: config.yml が無いので、OMP はこのファイルを読みます`);
    expect(run.stdout).toContain(`OMP の設定 ${realpathSync(yaml)}: 3つの読み込みの設定が揃っています`);
    expect(run.stdout).toContain(`  ${REGISTERED}\n`);
  });

  test("同期していなければ、生成物が無いことと sync を案内し、登録する値の skills.manualSkills の生成したスキルの名前は sync の後に出ることを表示する", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin();

    const run = await sb.run("status");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`  生成物 ${sb.generated}: ありません（bun scripts/pstack-omp/cli.ts sync で作ります）\n`);
    expect(run.stdout).toContain(
      `  → ${HOW_TO_REGISTER}（生成物がまだ無いので、skills.manualSkills の生成したスキルの名前は bun scripts/pstack-omp/cli.ts sync の後に出ます）\n` +
        `${registration(sb, []).replace("  manualSkills:\n", "  manualSkills: []\n")}どの tdd が使われるか:\n`,
    );
  });

  test("登録した後に生成物が消えれば、揃っているとは表示せず、sync するまで生成したスキルが読み込まれないことを表示する", async () => {
    const sb = await synced();
    register(sb);
    rmSync(sb.generated, { recursive: true });

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`  生成物 ${sb.generated}: ありません（bun scripts/pstack-omp/cli.ts sync で作ります）\n`);
    expect(run.stdout).toContain(
      "  → 読み込みの設定は揃っていますが、生成物が無いので、bun scripts/pstack-omp/cli.ts sync するまで pstack の生成したスキルは読み込まれません\n",
    );
    expect(run.stdout).not.toContain(REGISTERED);
  });

  test("生成物の元にした pin が固定の記録と違えば、sync のやり直しを案内する", async () => {
    const sb = await synced();
    const old = sb.cloneHead();
    const next = sb.commit("0.15.47");
    sb.pin();

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`  生成物 ${sb.generated}: 元にした pin（${old}）が固定の記録（${next}）と違います。bun scripts/pstack-omp/cli.ts sync をやり直してください\n`);
  });

  test("OMP の版が固定の記録と違えば、そのことと sync が止まることを表示する", async () => {
    const sb = await synced();
    sb.omp("19.2.0");

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("  OMP の版: 19.2.0（固定の記録 19.1.0）。版が違います（sync は止まります）\n");
  });

  test.each([
    ["登録していない", () => {}],
    ["登録している", (sb: Sandbox) => register(sb)],
  ])("%s状態で表示しても、OMP の設定の置き場とデータ置き場に何も書かない", async (_, setup) => {
    const sb = await synced();
    mkdirSync(sb.agentDir, { recursive: true });
    setup(sb);
    const before = { agent: snapshot(sb.agentDir), data: snapshot(sb.dataDir) };

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect({ agent: snapshot(sb.agentDir), data: snapshot(sb.dataDir) }).toEqual(before);
  });

  test("OMP の設定の置き場が無ければ、作らずに表示する", async () => {
    const sb = await synced();

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(existsSync(sb.agentDir)).toBe(false);
  });

  test("以前の道具が置いた <データ置き場>/pstack-omp/omp と、そこを指す以前の登録が残っていても、その中は見ずに、生成先と omp/content の登録が欠けていると表示する", async () => {
    const sb = await synced();
    const old = join(sb.dataDir, "pstack-omp", "omp");
    put(join(old, "harness.json"), "{}\n");
    put(join(old, "generated", "pstack", "skills", "tdd", "SKILL.md"), skillMd("tdd", "old"));
    register(sb, { parts: { extensions: [join(old, "content")], customDirectories: [join(old, "generated", "pstack", "skills")], manualSkills: MANUAL } });

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(
      `読み込みの設定が欠けています（extensions に ${sb.packageDir} がありません、skills.customDirectories に ${sb.generated}/pstack/skills がありません、` +
        `skills.customDirectories に ${sb.generated}/cursor-team-kit/skills がありません）\n`,
    );
    expect(run.stdout).not.toContain("harness.json");
  });

  // pstack の tdd を pstack-tdd に改名したので、登録しても名前だけの tdd は無い（以前は登録した pstack の tdd が使われた）
  test("利用者の置き場にも実行したディレクトリのプロジェクトの置き場にも tdd が無ければ、登録しても名前だけの tdd は読み込まれず、pstack の tdd は pstack-tdd の名前で使えると表示する", async () => {
    const sb = await synced();
    register(sb);

    const run = await sb.run("status");

    expect(run.stdout).toContain(`${NO_TDD}\n${pstackTddUsable(pstackTdd(sb))}`);
    expect(run.stdout).not.toContain("名前空間つき");
  });

  // 生成物に名前だけの tdd があれば（pstack の tdd を改名していない生成物）、登録した生成先が名前だけの tdd を取る
  test("改名していない生成物で登録していれば、通常の omp で pstack の tdd が使われ、利用者の tdd が名前空間つきになると表示し、pstack-tdd の行は出さない", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", { "pstack/skills/tdd/SKILL.md": skillMd("tdd", "Red, green.") });
    sb.pin();
    expect((await sb.sync()).exitCode).toBe(0);
    const userTdd = join(sb.home, ".agents", "skills", "tdd", "SKILL.md");
    put(userTdd, skillMd("tdd", "mine"));
    register(sb, { parts: { extensions: [sb.packageDir], customDirectories: skillDirs(sb), manualSkills: ["poteto-mode", "tdd", "control-cli", "control-ui", "deslop"] } });

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`  ${REGISTERED}\n`);
    expect(run.stdout).toContain(
      `通常の omp のセッション: pstack の tdd（${join(sb.generated, "pstack", "skills", "tdd", "SKILL.md")}）が使われます（生成先のスキルの置き場が skills.customDirectories にあるため）\n` +
        `    利用者の置き場の tdd（${userTdd}）は、名前空間つきの <名前空間>/tdd の名前になります\n`,
    );
    expect(run.stdout).not.toContain("pstack の tdd: ");
  });

  test("skills.manualSkills に以前の登録の tdd が残っていれば、利用者の tdd がスキルの一覧から外れることと、手で外すことを表示する", async () => {
    const sb = await synced();
    const userTdd = join(sb.home, ".agents", "skills", "tdd", "SKILL.md");
    put(userTdd, skillMd("tdd", "mine"));
    register(sb, { parts: { extensions: [sb.packageDir], customDirectories: skillDirs(sb), manualSkills: [...MANUAL, "tdd"] } });

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`  ${REGISTERED}\n`);
    expect(run.stdout).toContain(
      `通常の omp のセッション: 利用者の置き場の tdd（${userTdd}）が使われます\n` +
        "    skills.manualSkills の tdd が tdd に合うので、この tdd はスキルの一覧から外れます（名前で呼べば使えます）。以前に pstack の tdd のために登録した tdd なら、手で外してください\n" +
        pstackTddUsable(pstackTdd(sb)),
    );
  });

  // 利用者の置き場の2か所以上に内容の違う tdd があるとき、通常の omp で裸の名前 tdd を取るもの（OMP 19.1.0 の skills.ts の resolveCollision と
  // provider の priority: skills.customDirectories の配列の順 > <agentDir>/skills（native 100）> extensions のパッケージの skills/（omp-plugins 90）
  // > ~/.agents/skills（agents 70））
  const precedence: { name: string; place(sb: Sandbox): string }[] = [
    {
      name: "<agentDir>/skills と skills.customDirectories の置き場の両方にあれば、custom directory の tdd",
      place: (sb) => {
        put(join(sb.agentDir, "skills", "tdd", "SKILL.md"), skillMd("tdd", "native"));
        put(join(sb.root, "my-skills", "tdd", "SKILL.md"), skillMd("tdd", "custom"));
        put(sb.configPath, `skills:\n  customDirectories:\n    - ${join(sb.root, "my-skills")}\n`);
        return join(sb.root, "my-skills", "tdd", "SKILL.md");
      },
    },
    {
      name: "~/.agents/skills と extensions のパッケージの skills/ の両方にあれば、パッケージの tdd",
      place: (sb) => {
        put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "agents"));
        put(join(sb.root, "my-ext", "skills", "tdd", "SKILL.md"), skillMd("tdd", "ext"));
        put(sb.configPath, `extensions:\n  - ${join(sb.root, "my-ext")}\n`);
        return join(sb.root, "my-ext", "skills", "tdd", "SKILL.md");
      },
    },
    {
      name: "skills.customDirectories の2つの置き場にあれば、配列の最初の置き場の tdd",
      place: (sb) => {
        put(join(sb.root, "skills-a", "tdd", "SKILL.md"), skillMd("tdd", "a"));
        put(join(sb.root, "skills-b", "tdd", "SKILL.md"), skillMd("tdd", "b"));
        put(sb.configPath, `skills:\n  customDirectories:\n    - ${join(sb.root, "skills-b")}\n    - ${join(sb.root, "skills-a")}\n`);
        return join(sb.root, "skills-b", "tdd", "SKILL.md");
      },
    },
    {
      name: "<agentDir>/skills と ~/.agents/skills の両方にあれば、<agentDir>/skills の tdd",
      place: (sb) => {
        put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "agents"));
        put(join(sb.agentDir, "skills", "tdd", "SKILL.md"), skillMd("tdd", "native"));
        return realpathSync(join(sb.agentDir, "skills", "tdd", "SKILL.md"));
      },
    },
    {
      name: "~/.agents/skills と ~/.agent/skills の両方にあれば、~/.agent/skills の tdd",
      place: (sb) => {
        put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "agents"));
        put(join(sb.home, ".agent", "skills", "tdd", "SKILL.md"), skillMd("tdd", "agent"));
        return join(sb.home, ".agent", "skills", "tdd", "SKILL.md");
      },
    },
  ];

  test.each(precedence)("登録していなければ、$name が使われると表示する", async ({ place }) => {
    const sb = await synced();
    const used = place(sb);

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`通常の omp のセッション: 利用者の置き場の tdd（${used}）が使われます`);
  });

  // pstack の tdd を pstack-tdd に改名したので、登録しても名前だけの tdd は利用者の置き場の優先の順で決まる（以前は pstack の tdd が取った）
  test.each(precedence)("登録していても、通常の omp のセッションでは $name が使われ、pstack の tdd は pstack-tdd の名前で使えると表示する", async ({ place }) => {
    const sb = await synced();
    const used = place(sb);
    register(sb);

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`通常の omp のセッション: 利用者の置き場の tdd（${used}）が使われます\n${pstackTddUsable(pstackTdd(sb))}`);
    expect(run.stdout).not.toContain("名前空間つき");
  });

  // 利用者の置き場と、実行したディレクトリのプロジェクトの置き場の両方に tdd があるとき、通常の omp で裸の名前 tdd を取るもの（OMP 19.1.0:
  // custom directory は provider より優先。native（100）はプロジェクトの .omp/skills の後に <agentDir>/skills、claude（80）はプロジェクトの
  // .claude/skills、agents（70）はプロジェクトの .agent/skills・.agents/skills の後に ~/.agent/skills・~/.agents/skills。OMP が global の設定として
  // 読むファイルの disabledProviders（実行したディレクトリで解いた値）の provider は読まない）。where は表示する置き場の種類
  const projectPrecedence: { name: string; place(sb: Sandbox, project: string): { used: string; where: string } }[] = [
    {
      name: "<agentDir>/skills とプロジェクトの .omp/skills の両方にあれば、プロジェクトの tdd",
      place: (sb, project) => {
        put(join(sb.agentDir, "skills", "tdd", "SKILL.md"), skillMd("tdd", "native"));
        put(join(project, ".omp", "skills", "tdd", "SKILL.md"), skillMd("tdd", "project"));
        return { used: join(project, ".omp", "skills", "tdd", "SKILL.md"), where: "プロジェクトの置き場" };
      },
    },
    {
      name: "~/.agents/skills とプロジェクトの .omp/skills の両方にあれば、プロジェクトの tdd",
      place: (sb, project) => {
        put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "agents"));
        put(join(project, ".omp", "skills", "tdd", "SKILL.md"), skillMd("tdd", "project"));
        return { used: join(project, ".omp", "skills", "tdd", "SKILL.md"), where: "プロジェクトの置き場" };
      },
    },
    {
      name: "プロジェクトの .agents/skills と <agentDir>/skills の両方にあれば、<agentDir>/skills の tdd",
      place: (sb, project) => {
        put(join(project, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "project"));
        put(join(sb.agentDir, "skills", "tdd", "SKILL.md"), skillMd("tdd", "native"));
        return { used: realpathSync(join(sb.agentDir, "skills", "tdd", "SKILL.md")), where: "利用者の置き場" };
      },
    },
    {
      name: "skills.customDirectories の置き場とプロジェクトの .omp/skills の両方にあれば、custom directory の tdd",
      place: (sb, project) => {
        put(join(project, ".omp", "skills", "tdd", "SKILL.md"), skillMd("tdd", "project"));
        put(join(sb.root, "my-skills", "tdd", "SKILL.md"), skillMd("tdd", "custom"));
        put(sb.configPath, `skills:\n  customDirectories:\n    - ${join(sb.root, "my-skills")}\n`);
        return { used: join(sb.root, "my-skills", "tdd", "SKILL.md"), where: "利用者の置き場" };
      },
    },
    {
      name: "disabledProviders に native があれば、プロジェクトの .omp/skills と ~/.agents/skills のうち ~/.agents/skills の tdd",
      place: (sb, project) => {
        put(join(project, ".omp", "skills", "tdd", "SKILL.md"), skillMd("tdd", "project"));
        put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "agents"));
        put(sb.configPath, "disabledProviders:\n  - native\n");
        return { used: join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), where: "利用者の置き場" };
      },
    },
    {
      name: "disabledProviders の path が実行したディレクトリの祖先を指すオブジェクトに claude があれば、プロジェクトの .claude/skills と ~/.agents/skills のうち ~/.agents/skills の tdd",
      place: (sb, project) => {
        put(join(project, ".claude", "skills", "tdd", "SKILL.md"), skillMd("tdd", "project"));
        put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "agents"));
        put(sb.configPath, `disabledProviders:\n  - path: ${realpathSync(sb.root)}\n    providers:\n      - claude\n`);
        return { used: join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), where: "利用者の置き場" };
      },
    },
    {
      name: "disabledProviders の path が実行したディレクトリを覆わないオブジェクトに claude があっても、プロジェクトの .claude/skills の tdd",
      place: (sb, project) => {
        put(join(project, ".claude", "skills", "tdd", "SKILL.md"), skillMd("tdd", "project"));
        put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "agents"));
        put(sb.configPath, `disabledProviders:\n  - path: ${join(realpathSync(sb.root), "elsewhere")}\n    providers:\n      - claude\n`);
        return { used: join(project, ".claude", "skills", "tdd", "SKILL.md"), where: "プロジェクトの置き場" };
      },
    },
    {
      name: "プロジェクトの .github/skills と .opencode/skills の両方にあれば、.opencode/skills の tdd（opencode 55 は github 30 より先）",
      place: (_, project) => {
        put(join(project, ".github", "skills", "tdd", "SKILL.md"), skillMd("tdd", "github"));
        put(join(project, ".opencode", "skills", "tdd", "SKILL.md"), skillMd("tdd", "opencode"));
        return { used: join(project, ".opencode", "skills", "tdd", "SKILL.md"), where: "プロジェクトの置き場" };
      },
    },
    {
      name: "プロジェクトの .codex/skills と ~/.agents/skills の両方にあれば、~/.agents/skills の tdd（同じ priority 70 の agents は codex より先に登録）",
      place: (sb, project) => {
        put(join(project, ".codex", "skills", "tdd", "SKILL.md"), skillMd("tdd", "codex"));
        put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "agents"));
        return { used: join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), where: "利用者の置き場" };
      },
    },
  ];

  // git の作業ツリーの根にした作業中のプロジェクト（実パス）
  function gitProject(sb: Sandbox): string {
    mkdirSync(join(sb.project, ".git"));
    return realpathSync(sb.project);
  }

  test.each(projectPrecedence)("実行したディレクトリのプロジェクトで、登録していなければ、$name が使われると表示する", async ({ place }) => {
    const sb = await synced();
    const project = gitProject(sb);
    const { used, where } = place(sb, project);

    const run = await sb.run("status", { cwd: project });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`通常の omp のセッション: ${where}の tdd（${used}）が使われます`);
  });

  // pstack の tdd を pstack-tdd に改名したので、登録しても名前だけの tdd は置き場の優先の順で決まる（以前は pstack の tdd が取った）
  test.each(projectPrecedence)("実行したディレクトリのプロジェクトで、登録していても、通常の omp のセッションでは $name が使われ、pstack の tdd は pstack-tdd の名前で使えると表示する", async ({ place }) => {
    const sb = await synced();
    const project = gitProject(sb);
    const { used, where } = place(sb, project);
    register(sb);

    const run = await sb.run("status", { cwd: project });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`通常の omp のセッション: ${where}の tdd（${used}）が使われます\n${pstackTddUsable(pstackTdd(sb))}`);
  });

  // OMP 19.2.1 は path の範囲の判定で、範囲からの相対パスが .. そのものか .. と区切り文字で始まるときだけを範囲外とする（pi-utils の
  // relativePathWithinNormalizedRoot）。19.1.1 は .. で始まる名前の子のディレクトリも範囲外とした
  test("実行したディレクトリが disabledProviders の path の範囲の直下の ..work（.. で始まる名前）なら、範囲の中としてオブジェクトの claude を読まず、プロジェクトの .claude/skills と ~/.agents/skills のうち ~/.agents/skills の tdd が使われると表示する", async () => {
    const sb = await synced();
    const scope = realpathSync(sb.project);
    const work = join(scope, "..work");
    mkdirSync(join(work, ".git"), { recursive: true });
    put(join(work, ".claude", "skills", "tdd", "SKILL.md"), skillMd("tdd", "project"));
    put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "agents"));
    put(sb.configPath, `disabledProviders:\n  - path: ${scope}\n    providers:\n      - claude\n`);

    const run = await sb.run("status", { cwd: work });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`通常の omp のセッション: 利用者の置き場の tdd（${join(sb.home, ".agents", "skills", "tdd", "SKILL.md")}）が使われます`);
  });

  // 以前は登録した pstack の tdd が使われ、プロジェクトの tdd が名前空間つきになった
  test("利用者の置き場に tdd が無く、実行したディレクトリのプロジェクトの置き場にあれば、登録した後もそれが使われると表示する", async () => {
    const sb = await synced();
    const project = gitProject(sb);
    put(join(project, ".claude", "skills", "tdd", "SKILL.md"), skillMd("tdd", "project"));
    register(sb);

    const run = await sb.run("status", { cwd: project });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`通常の omp のセッション: プロジェクトの置き場の tdd（${project}/.claude/skills/tdd/SKILL.md）が使われます\n${pstackTddUsable(pstackTdd(sb))}`);
  });

  // git の作業ツリーの外では、OMP 19.1.0 はプロジェクトのスキルを、実行したディレクトリからホームの手前まで（ホームの外ならファイルシステムの根まで。
  // native の .omp/skills は os.tmpdir() などの手前まで）の祖先から読む
  test("git の作業ツリーの外のホームの下では、祖先のプロジェクトの .agents/skills の tdd を数え、~/.agents/skills の tdd より先に使われると表示する", async () => {
    const sb = await synced();
    const { home, env } = realHome(sb);
    const dir = join(home, "work", "sub");
    mkdirSync(dir, { recursive: true });
    put(join(home, "work", ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "ancestor"));
    put(join(home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "user"));

    const run = await sb.run("status", { cwd: dir, env });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`通常の omp のセッション: プロジェクトの置き場の tdd（${home}/work/.agents/skills/tdd/SKILL.md）が使われます\n`);
  });

  // 以前は登録した pstack の tdd が使われ、祖先のプロジェクトの tdd が名前空間つきになった
  test("git の作業ツリーの外のホームの外でも、祖先のプロジェクトの .claude/skills の tdd を数え、登録した後も ~/.agents/skills の tdd より先に使われると表示する", async () => {
    const sb = await synced();
    const dir = join(realpathSync(sb.root), "outside", "a", "b");
    mkdirSync(dir, { recursive: true });
    put(join(sb.root, "outside", ".claude", "skills", "tdd", "SKILL.md"), skillMd("tdd", "ancestor"));
    put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "user"));
    register(sb);

    const run = await sb.run("status", { cwd: dir });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`通常の omp のセッション: プロジェクトの置き場の tdd（${realpathSync(sb.root)}/outside/.claude/skills/tdd/SKILL.md）が使われます\n`);
  });

  // OMP 19.1.0 が読まないスキル（enabled: false。native・custom directory・omp-plugins は description の無いものも）は、通常の omp の tdd に
  // 数えない（agents は description が無くても読む）
  const notRead: { name: string; place(sb: Sandbox): void }[] = [
    {
      name: "<agentDir>/skills の tdd に enabled: false がある",
      place: (sb) => put(join(sb.agentDir, "skills", "tdd", "SKILL.md"), "---\nname: tdd\ndescription: test\nenabled: false\n---\n\nnative\n"),
    },
    {
      name: "<agentDir>/skills の tdd に description が無い",
      place: (sb) => put(join(sb.agentDir, "skills", "tdd", "SKILL.md"), "---\nname: tdd\n---\n\nnative\n"),
    },
    {
      name: "skills.customDirectories の置き場の tdd に description が無い",
      place: (sb) => {
        put(join(sb.root, "my-skills", "tdd", "SKILL.md"), "---\nname: tdd\n---\n\ncustom\n");
        put(sb.configPath, `skills:\n  customDirectories:\n    - ${join(sb.root, "my-skills")}\n`);
      },
    },
    {
      name: "extensions のパッケージの skills/ の tdd に description が無い",
      place: (sb) => {
        put(join(sb.root, "my-ext", "skills", "tdd", "SKILL.md"), "---\nname: tdd\n---\n\next\n");
        put(sb.configPath, `extensions:\n  - ${join(sb.root, "my-ext")}\n`);
      },
    },
  ];

  test.each(notRead)("$name なら、OMP はそれを読まないので、~/.agents/skills の tdd（description が無くても読む）が使われると表示する", async ({ place }) => {
    const sb = await synced();
    const userTdd = join(sb.home, ".agents", "skills", "tdd", "SKILL.md");
    put(userTdd, "---\nname: tdd\n---\n\nagents\n");
    place(sb);

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`通常の omp のセッション: 利用者の置き場の tdd（${userTdd}）が使われます\n`);
  });

  // OMP 19.1.0 が読む、ほかの provider の利用者の置き場（claude 80 > agents 70 > codex 70（同じ priority は登録の順）> omp-managed 5）。
  // ~/.claude・~/.codex は enabledProviders（* を含む）や skills.enableClaudeUser・CLAUDE_CONFIG_DIR で有効にしたときだけ読む
  const providers: { name: string; env?(sb: Sandbox): Record<string, string>; place(sb: Sandbox): string }[] = [
    {
      name: "~/.claude/skills と ~/.agents/skills の両方にあり、有効にしていなければ、~/.agents/skills の tdd",
      place: (sb) => {
        put(join(sb.home, ".claude", "skills", "tdd", "SKILL.md"), skillMd("tdd", "claude"));
        put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "agents"));
        return join(sb.home, ".agents", "skills", "tdd", "SKILL.md");
      },
    },
    {
      name: "~/.claude/skills と ~/.agents/skills の両方にあり、enabledProviders に claude があれば、~/.claude/skills の tdd",
      place: (sb) => {
        put(join(sb.home, ".claude", "skills", "tdd", "SKILL.md"), skillMd("tdd", "claude"));
        put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "agents"));
        put(sb.configPath, "enabledProviders:\n  - claude\n");
        return join(sb.home, ".claude", "skills", "tdd", "SKILL.md");
      },
    },
    {
      name: "~/.claude/skills と ~/.agents/skills の両方にあり、skills.enableClaudeUser が true なら、~/.claude/skills の tdd",
      place: (sb) => {
        put(join(sb.home, ".claude", "skills", "tdd", "SKILL.md"), "---\nname: tdd\n---\n\nclaude\n");
        put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "agents"));
        put(sb.configPath, "skills:\n  enableClaudeUser: true\n");
        return join(sb.home, ".claude", "skills", "tdd", "SKILL.md");
      },
    },
    {
      name: "CLAUDE_CONFIG_DIR の置き場の skills/ と ~/.agents/skills の両方にあれば、CLAUDE_CONFIG_DIR の置き場の tdd",
      env: (sb) => ({ CLAUDE_CONFIG_DIR: join(sb.root, "claude-config") }),
      place: (sb) => {
        put(join(sb.root, "claude-config", "skills", "tdd", "SKILL.md"), skillMd("tdd", "claude"));
        put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "agents"));
        return join(sb.root, "claude-config", "skills", "tdd", "SKILL.md");
      },
    },
    {
      name: "~/.codex/skills と ~/.agents/skills の両方にあれば、enabledProviders が * でも ~/.agents/skills の tdd",
      place: (sb) => {
        put(join(sb.home, ".codex", "skills", "tdd", "SKILL.md"), skillMd("tdd", "codex"));
        put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "agents"));
        put(sb.configPath, "enabledProviders:\n  - '*'\n");
        return join(sb.home, ".agents", "skills", "tdd", "SKILL.md");
      },
    },
    {
      name: "~/.codex/skills だけにあり、enabledProviders に codex があれば、~/.codex/skills の tdd",
      place: (sb) => {
        put(join(sb.home, ".codex", "skills", "tdd", "SKILL.md"), skillMd("tdd", "codex"));
        put(sb.configPath, "enabledProviders:\n  - codex\n");
        return join(sb.home, ".codex", "skills", "tdd", "SKILL.md");
      },
    },
    {
      name: "<agentDir>/managed-skills だけにあれば、managed の tdd",
      place: (sb) => {
        put(join(sb.agentDir, "managed-skills", "tdd", "SKILL.md"), skillMd("tdd", "managed"));
        return realpathSync(join(sb.agentDir, "managed-skills", "tdd", "SKILL.md"));
      },
    },
    {
      name: "<agentDir>/managed-skills と ~/.agents/skills の両方にあれば、~/.agents/skills の tdd",
      place: (sb) => {
        put(join(sb.agentDir, "managed-skills", "tdd", "SKILL.md"), skillMd("tdd", "managed"));
        put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "agents"));
        return join(sb.home, ".agents", "skills", "tdd", "SKILL.md");
      },
    },
  ];

  test.each(providers)("登録していなければ、$name が使われると表示する", async ({ place, env }) => {
    const sb = await synced();
    const used = place(sb);

    const run = await sb.run("status", { env: env?.(sb) });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`通常の omp のセッション: 利用者の置き場の tdd（${used}）が使われます\n`);
  });

  test.each([
    ["skills.enabled が false", "skills:\n  enabled: false\n", "OMP の設定の skills.enabled が false なので、通常の omp はスキルを読み込みません"],
    ["disabledExtensions に skill:tdd がある", "disabledExtensions:\n  - skill:tdd\n", "OMP の設定の disabledExtensions に skill:tdd があるので、通常の omp は tdd を読み込みません"],
    ["skills.includeSkills に tdd が合わない", "skills:\n  includeSkills:\n    - git-*\n", "OMP の設定の skills.includeSkills に tdd が合わないので、通常の omp の一覧に tdd は残りません"],
    ["skills.ignoredSkills に tdd が合う", "skills:\n  ignoredSkills:\n    - t*\n", "通常の omp が読む置き場に tdd はありません"],
  ])("OMP の設定の %s なら、登録した pstack の pstack-tdd と ~/.agents/skills の tdd があっても、通常の omp では名前だけの tdd は使われないと表示する", async (_, config, reason) => {
    const sb = await synced();
    put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "agents"));
    put(sb.configPath, config);
    register(sb);

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`通常の omp のセッション: tdd は読み込まれません（${reason}）\n`);
  });

  test("入れたプラグインの置き場やプラグインの登録があり、選んだ tdd より先に読まれうるなら、その中は調べていないので、そこに tdd があればそちらが使われることを添える", async () => {
    const sb = await synced();
    const userTdd = join(sb.home, ".agents", "skills", "tdd", "SKILL.md");
    put(userTdd, skillMd("tdd", "agents"));
    const modules = join(sb.home, ".omp", "plugins", "node_modules");
    const registry = join(sb.home, ".omp", "plugins", "installed_plugins.json");
    put(join(modules, "some-plugin", "package.json"), "{}\n");
    put(registry, '{"version":2,"plugins":{}}\n');

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(
      `通常の omp のセッション: 利用者の置き場の tdd（${userTdd}）が使われます。ただし、OMP は ${modules}、${registry} からもスキルを読み、その中は調べていないので、そこに tdd があればそちらが使われます\n`,
    );
  });

  test("選んだ tdd が skills.customDirectories のものなら、プラグインや skillshare のスキルは裸の名前を取らないので、調べていないことを添えない", async () => {
    const sb = await synced();
    const customTdd = join(sb.root, "my-skills", "tdd", "SKILL.md");
    put(customTdd, skillMd("tdd", "custom"));
    put(sb.configPath, `skills:\n  customDirectories:\n    - ${join(sb.root, "my-skills")}\n`);
    put(join(sb.home, ".omp", "plugins", "node_modules", "some-plugin", "package.json"), "{}\n");
    put(join(sb.agentDir, "skills.lock.json"), "{}\n");

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`通常の omp のセッション: 利用者の置き場の tdd（${customTdd}）が使われます\n`);
  });

  test("config.yml が読めなくても、例外で終わらずに、読めないことと、確かめられないので登録する値を表示し、OMP の既定の設定で tdd を選ぶ", async () => {
    const sb = await synced();
    put(sb.configPath, "theme: dark\n");
    register(sb);
    const config = realpathSync(sb.configPath);
    chmodSync(sb.configPath, 0o000);

    const run = await sb.run("status");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`OMP の設定 ${config}: 読めません`);
    expect(run.stdout).toContain(`  → OMP の設定を読めないので、揃っているかを確かめられません。${HOW_TO_REGISTER}\n${registration(sb)}`);
    expect(run.stdout).not.toContain(REGISTERED);
    expect(run.stdout).toContain("（OMP の設定を読めないので、OMP の既定の設定で選びました）");
  });

  test("生成先のスキルの SKILL.md やプロジェクトの置き場の定義のファイルが、在るのに読めなくても、例外で終わらずに、名前を読めなかった置き場を表示し、ほかの節も最後まで出す", async () => {
    const sb = await withAgent();
    register(sb);
    const project = join(sb.root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    put(join(project, ".omp", "agents", "poteto-agent.md"), "---\nname: poteto-agent\ndescription: test\n---\n\nproject\n");
    put(join(project, ".omp", "agents", "locked.md"), "---\nname: locked\n---\n");
    put(join(project, ".omp", "skills", "locked", "SKILL.md"), skillMd("locked", "project"));
    mkdirSync(join(project, ".claude", "skills", "folder", "SKILL.md"), { recursive: true });
    chmodSync(join(project, ".omp", "agents", "locked.md"), 0o000);
    chmodSync(join(project, ".omp", "skills", "locked", "SKILL.md"), 0o000);
    chmodSync(pstackTdd(sb), 0o000);
    const real = realpathSync(project);

    const run = await sb.run("status", { cwd: project });

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("どの tdd が使われるか:\n");
    expect(run.stdout).not.toContain("利用者の置き場の /");
    const section = run.stdout.slice(run.stdout.indexOf(`プロジェクト（${real}）`));
    expect(section.trim().split("\n").slice(1)).toEqual([
      `  ${real}/.omp/agents/poteto-agent.md: エージェント poteto-agent。プロジェクトの定義が優先されるので、このプロジェクトでは今回の定義が使われません`,
      `  ${real}/.omp/agents/locked.md: 読めないので、今回の定義やスキルと同じ名前かを確かめられません`,
      `  ${real}/.omp/skills/locked/SKILL.md: 読めないので、今回の定義やスキルと同じ名前かを確かめられません`,
      `  ${real}/.claude/skills/folder/SKILL.md: 読めないので、今回の定義やスキルと同じ名前かを確かめられません`,
    ]);
  });

  const unresolvable: { name: string; env: Record<string, string>; shows: string }[] = [
    { name: "環境変数 OMP_PROFILE で名前つきの profile を選んだ", env: { OMP_PROFILE: "work" }, shows: "名前つきの profile（work）" },
    { name: "環境変数 PI_PROFILE で名前つきの profile を選んだ", env: { PI_PROFILE: "work" }, shows: "名前つきの profile（work）" },
    { name: "環境変数 PI_CONFIG_DIR で OMP の設定の根を変えた", env: { PI_CONFIG_DIR: ".omp-work" }, shows: "PI_CONFIG_DIR" },
  ];

  test.each(unresolvable)("$name: 同期は行えるが、状態の表示は理由を出して止まり、設定は変わらない", async ({ env, shows }) => {
    const sb = await synced();
    register(sb);
    const config = readFileSync(sb.configPath, "utf8");

    const resynced = await sb.run("sync", { env });
    const run = await sb.run("status", { env });

    expect(resynced.exitCode).toBe(0);
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("OMP の設定の置き場を決められません");
    expect(run.stderr).toContain(shows);
    expect(readFileSync(sb.configPath, "utf8")).toBe(config);
  });

  test("config.yml が在れば（空でも）、OMP は config.yaml を読まないので、config.yaml の skills.customDirectories の tdd を利用者の置き場の tdd としない", async () => {
    const sb = await synced();
    put(sb.configPath, "");
    put(join(sb.root, "my-skills", "tdd", "SKILL.md"), skillMd("tdd", "mine"));
    put(join(sb.agentDir, "config.yaml"), `skills:\n  customDirectories:\n    - ${join(sb.root, "my-skills")}\n`);

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(NO_TDD);
  });

  test.each([
    ["YAML として不正", "extensions: [unclosed\n"],
    ["skills.customDirectories が文字列の配列でない", "skills:\n  customDirectories: /somewhere\n"],
  ])("config.yml が無く、OMP が読む config.yaml が%sでも、例外で終わらずに読めないことを表示する", async (_, text) => {
    const sb = await synced();
    put(join(sb.agentDir, "config.yaml"), text);
    const yaml = realpathSync(join(sb.agentDir, "config.yaml"));

    const run = await sb.run("status");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`OMP の設定 ${yaml}: 読めません`);
    expect(run.stdout).toContain("どの tdd が使われるか:\n");
  });
});

describe("プロジェクトの置き場の名前のぶつかり", () => {
  // 生成したスキルの名前は pstack-tdd になったので、ぶつかるのはプロジェクトの pstack-tdd で、プロジェクトの tdd は報告しない（以前は tdd を報告した）
  test("実行したディレクトリから git の作業ツリーの根までの置き場にある、今回の定義（リポジトリの poteto-agent）・生成したスキルと同じ名前を報告し、以前の読み替え表 pstack-omp と同じ名前と、改名で利用者に譲った tdd は報告しない", async () => {
    const sb = await synced({ repoContent: true });
    const project = join(sb.root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    put(join(project, ".omp", "agents", "poteto-agent.md"), "---\nname: poteto-agent\ndescription: test\n---\n\nproject\n");
    put(join(project, ".omp", "skills", "pstack-tdd", "SKILL.md"), skillMd("pstack-tdd", "project"));
    put(join(project, ".omp", "skills", "tdd", "SKILL.md"), skillMd("tdd", "project"));
    put(join(project, ".agents", "skills", "table", "SKILL.md"), skillMd("pstack-omp", "project"));
    put(join(project, ".omp", "skills", "other", "SKILL.md"), skillMd("other", "project"));
    // OMP は実行したディレクトリから最も近い .omp/agents だけを読むので、遠い方（根の親）は報告しない
    put(join(sb.root, ".omp", "agents", "poteto-agent.md"), "---\nname: poteto-agent\ndescription: test\n---\n\noutside\n");
    mkdirSync(join(project, "src"));
    const real = realpathSync(project);

    const run = await sb.run("status", { cwd: join(project, "src") });

    expect(run.exitCode).toBe(0);
    const section = run.stdout.slice(run.stdout.indexOf(`プロジェクト（${real}）`));
    expect(section.trim().split("\n").slice(1)).toEqual([
      `  ${real}/.omp/agents/poteto-agent.md: ${AGENT_CLASH}`,
      `  ${real}/.omp/skills/pstack-tdd/SKILL.md: スキル pstack-tdd。生成したスキル（skills.customDirectories）が優先され、このスキルは <名前空間>/pstack-tdd の名前になります`,
    ]);
  });

  test("同じ名前が無ければ、無いと表示する", async () => {
    const sb = await withAgent();
    const project = join(sb.root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });

    const run = await sb.run("status", { cwd: project });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(
      `プロジェクト（${realpathSync(project)}）の置き場（エージェント定義は、実行したディレクトリから遡って最も近い .omp/agents。根の外やホームにあっても OMP が読む）にある、` +
        "今回の定義やスキルと同じ名前のもの（通常の omp で効く）:\n  ありません\n",
    );
  });

  test("git の作業ツリーの根までに .omp/agents が無ければ、根より上の祖先の最も近い .omp/agents（OMP が読む）にある同じ名前を報告する", async () => {
    const sb = await withAgent();
    const project = join(sb.root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(join(project, "src"));
    put(join(sb.root, ".omp", "agents", "poteto-agent.md"), "---\nname: poteto-agent\ndescription: test\n---\n\noutside\n");

    const run = await sb.run("status", { cwd: join(project, "src") });

    expect(run.exitCode).toBe(0);
    expect(projectSection(run.stdout, realpathSync(project))).toEqual([`  ${realpathSync(sb.root)}/.omp/agents/poteto-agent.md: ${AGENT_CLASH}`]);
  });

  test("実行したディレクトリがホームの下で、それより近い .omp/agents が無ければ、ホームの .omp/agents（~/.omp/agent/agents とは別）にある同じ名前を報告する", async () => {
    const sb = await withAgent();
    const dir = join(sb.home, "work");
    mkdirSync(dir);
    put(join(sb.home, ".omp", "agents", "poteto-agent.md"), "---\nname: poteto-agent\ndescription: test\n---\n\nhome\n");

    const run = await sb.run("status", { cwd: dir });

    expect(run.exitCode).toBe(0);
    expect(projectSection(run.stdout, realpathSync(dir))).toEqual([`  ${realpathSync(sb.home)}/.omp/agents/poteto-agent.md: ${AGENT_CLASH}`]);
  });

  test("近い .omp/agents と遠い .omp/agents の両方に同じ名前があれば、OMP が読む近い方だけを報告する", async () => {
    const sb = await withAgent();
    const project = join(sb.root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    put(join(project, ".omp", "agents", "poteto-agent.md"), "---\nname: poteto-agent\ndescription: test\n---\n\nfar\n");
    put(join(project, "pkg", ".omp", "agents", "poteto-agent.md"), "---\nname: poteto-agent\ndescription: test\n---\n\nnear\n");
    mkdirSync(join(project, "pkg", "src"));
    const real = realpathSync(project);

    const run = await sb.run("status", { cwd: join(project, "pkg", "src") });

    expect(run.exitCode).toBe(0);
    expect(projectSection(run.stdout, real)).toEqual([`  ${real}/pkg/.omp/agents/poteto-agent.md: ${AGENT_CLASH}`]);
  });

  test("frontmatter の前に HTML のコメントがあっても、OMP 19.1.0 と同じくそれを除いた frontmatter の name で、ファイル名の違う定義を同じ名前として報告する", async () => {
    const sb = await withAgent();
    const project = join(sb.root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    put(join(project, ".omp", "agents", "other.md"), "<!-- note -->\n---\nname: poteto-agent\ndescription: test\n---\n\nproject\n");
    const real = realpathSync(project);

    const run = await sb.run("status", { cwd: project });

    expect(run.exitCode).toBe(0);
    expect(projectSection(run.stdout, real)).toEqual([`  ${real}/.omp/agents/other.md: ${AGENT_CLASH}`]);
  });

  test.each([
    ["name が無い（ファイル名は poteto-agent.md）", "---\ndescription: test\n---\n\nproject\n"],
    ["frontmatter が無い（ファイル名は poteto-agent.md）", "project\n"],
    ["description が無い", "---\nname: poteto-agent\n---\n\nproject\n"],
    ["description が空", '---\nname: poteto-agent\ndescription: ""\n---\n\nproject\n'],
    ["name の前後に空白がある（OMP はそのままの形で比べる）", '---\nname: " poteto-agent "\ndescription: test\n---\n\nproject\n'],
  ])("OMP 19.1.0 が定義として読まない、または別の名前とみなすエージェント定義（%s）は報告しない", async (_, text) => {
    const sb = await withAgent();
    const project = join(sb.root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    put(join(project, ".omp", "agents", "poteto-agent.md"), text);
    const real = realpathSync(project);

    const run = await sb.run("status", { cwd: project });

    expect(run.exitCode).toBe(0);
    expect(projectSection(run.stdout, real)).toEqual(["  ありません"]);
  });

  // 生成したスキルの名前は pstack-tdd になったので、ぶつかる名前の例を tdd から pstack-tdd にした
  const PSTACK_TDD_CLASH = "スキル pstack-tdd。生成したスキル（skills.customDirectories）が優先され、このスキルは <名前空間>/pstack-tdd の名前になります";
  const MODE_CLASH = "スキル poteto-mode。生成したスキル（skills.customDirectories）が優先され、このスキルは <名前空間>/poteto-mode の名前になります";

  test("git の作業ツリーの外のホームの下では、OMP と同じくホームの手前までの祖先のプロジェクトの置き場にある同じ名前を報告し、ホームの置き場（利用者の置き場）は報告しない", async () => {
    const sb = await withAgent();
    const { home, env } = realHome(sb);
    const dir = join(home, "work", "sub");
    mkdirSync(dir, { recursive: true });
    put(join(home, "work", ".omp", "skills", "pstack-tdd", "SKILL.md"), skillMd("pstack-tdd", "ancestor"));
    put(join(home, "work", ".agents", "skills", "mode", "SKILL.md"), skillMd("poteto-mode", "ancestor"));
    put(join(home, ".agents", "skills", "mode", "SKILL.md"), skillMd("poteto-mode", "user"));

    const run = await sb.run("status", { cwd: dir, env });

    expect(run.exitCode).toBe(0);
    expect(projectSection(run.stdout, dir)).toEqual([`  ${home}/work/.omp/skills/pstack-tdd/SKILL.md: ${PSTACK_TDD_CLASH}`, `  ${home}/work/.agents/skills/mode/SKILL.md: ${MODE_CLASH}`]);
  });

  test("git の作業ツリーの外のホームの外でも、祖先のプロジェクトの .claude/skills にある同じ名前を報告する", async () => {
    const sb = await withAgent();
    const root = realpathSync(sb.root);
    const dir = join(root, "outside", "a");
    mkdirSync(dir, { recursive: true });
    put(join(root, "outside", ".claude", "skills", "pstack-tdd", "SKILL.md"), skillMd("pstack-tdd", "ancestor"));

    const run = await sb.run("status", { cwd: dir });

    expect(run.exitCode).toBe(0);
    expect(projectSection(run.stdout, dir)).toEqual([`  ${root}/outside/.claude/skills/pstack-tdd/SKILL.md: ${PSTACK_TDD_CLASH}`]);
  });

  test("OMP が読まないプロジェクトのスキル（description の無い .omp/skills、enabled: false）は報告せず、disabledExtensions で外した名前も同じ名前のファイルとして報告する", async () => {
    const sb = await withAgent();
    const project = join(sb.root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    put(join(project, ".omp", "skills", "pstack-tdd", "SKILL.md"), "---\nname: pstack-tdd\n---\n\nproject\n");
    put(join(project, ".claude", "skills", "mode", "SKILL.md"), "---\nname: poteto-mode\ndescription: test\nenabled: false\n---\n");
    put(join(project, ".agents", "skills", "t", "SKILL.md"), "---\nname: pstack-tdd\n---\n\nagents\n");
    put(sb.configPath, "disabledExtensions:\n  - skill:pstack-tdd\n");
    const real = realpathSync(project);

    const run = await sb.run("status", { cwd: project });

    expect(run.exitCode).toBe(0);
    expect(projectSection(run.stdout, real)).toEqual([`  ${real}/.agents/skills/t/SKILL.md: ${PSTACK_TDD_CLASH}`]);
  });
});
