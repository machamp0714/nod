// pstack を OMP 向けに使う道具（scripts/pstack-omp/cli.ts）の状態の表示（status）を、プロセスとして起動して外から確かめる。
// 利用者の OMP の設定の置き場・ホーム・データ置き場は一時ディレクトリ（helpers.ts）。
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { put, type Sandbox, skillMd, synced } from "./helpers";

// 同期した上に、今回置くエージェント定義 poteto-agent を OMP 向けのディレクトリに置く
async function withAgent(): Promise<Sandbox> {
  const sb = await synced();
  sb.content("agents/poteto-agent.md", "---\nname: poteto-agent\ndescription: test\n---\n\nYou are poteto.\n");
  return sb;
}

function work(sb: Sandbox): string {
  return join(realpathSync(sb.dataDir), "pstack-omp");
}

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

describe("適用の状態とどの tdd が使われるか", () => {
  test("適用していなければ、そう表示し、利用者の置き場の tdd が使われると表示する", async () => {
    const sb = await synced();
    const userTdd = join(sb.home, ".agents", "skills", "tdd", "SKILL.md");
    put(userTdd, skillMd("tdd", "mine"));

    const run = await sb.run("status");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`写し ${work(sb)}/omp: ありません`);
    expect(run.stdout).toContain("読み込みの設定はありません（pstack は専用ランチャーだけが読み込みます）");
    expect(run.stdout).toContain("→ 適用していません");
    expect(run.stdout).toContain(`適用していないので、利用者の置き場の tdd（${userTdd}）が使われます`);
  });

  test("適用していれば、写しの sha256・生成物の pin・OMP の版がそろっていることと、pstack は専用ランチャーのセッションだけに読み込まれること、ランチャーでは pstack の tdd、通常の omp では利用者の tdd が使われることを表示する", async () => {
    const sb = await synced();
    const userTdd = join(sb.home, ".agents", "skills", "tdd", "SKILL.md");
    put(userTdd, skillMd("tdd", "mine"));
    expect((await sb.run("apply")).exitCode).toBe(0);

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("組のファイルは記録の sha256 と一致しています");
    expect(run.stdout).toContain("元にした pin は固定の記録と一致しています");
    expect(run.stdout).toContain("OMP の版: 19.1.0（固定の記録 19.1.0、適用したときの記録 19.1.0）\n");
    expect(run.stdout).toContain(`→ 適用しています。pstack は専用ランチャー ${work(sb)}/omp/bin/omp から起動したセッションだけに読み込まれます（通常の omp には読み込まれません）`);
    expect(run.stdout).toContain(`専用ランチャーから起動したセッション: pstack の tdd（${work(sb)}/omp/generated/pstack/skills/tdd/SKILL.md）が使われます`);
    expect(run.stdout).toContain(`利用者の置き場の tdd（${userTdd}）は、名前空間つきの <名前空間>/tdd の名前になります`);
    expect(run.stdout).toContain(`通常の omp のセッション: 利用者の置き場の tdd（${userTdd}）が使われます`);
    expect(run.stdout).toContain(`専用ランチャー: ${work(sb)}/omp/bin/omp から起動してください`);
  });

  test("組を別の OMP の設定の置き場に適用していれば、適用しているとも専用ランチャーで pstack の tdd が使われるとも表示せず、置き場が違うことと専用ランチャーが起動しないことを表示する", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    const other = join(sb.root, "other-agent");
    mkdirSync(other);

    const run = await sb.run("status", { env: { PI_CODING_AGENT_DIR: other } });

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    // 組の記録の置き場（まだ無ければ、在る祖先の別名を解いた形）
    const applied = join(realpathSync(sb.home), ".omp", "agent");
    const current = realpathSync(other);
    expect(run.stdout).toContain(`組は別の OMP の設定の置き場 ${applied} に適用したもので、いまの置き場 ${current} と違います。このままでは専用ランチャーは omp を起動しません`);
    expect(run.stdout).toContain(`→ この置き場（${current}）には適用していません（写しは別の置き場 ${applied} に適用したものです）`);
    expect(run.stdout).not.toContain("→ 適用しています");
    expect(run.stdout).not.toContain("→ 適用が壊れています");
    expect(run.stdout).not.toContain("専用ランチャーから起動したセッション: pstack の tdd");
    expect(run.stdout).toContain("適用していないので、pstack の tdd は使われません");
  });

  test("利用者の置き場にも実行したディレクトリのプロジェクトの置き場にも tdd が無ければ、通常の omp のセッションでは tdd が読み込まれないと表示する", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);

    const run = await sb.run("status");

    expect(run.stdout).toContain("通常の omp のセッション: pstack の tdd は読み込まれません（利用者の置き場にも、実行したディレクトリのプロジェクトの置き場にも tdd はありません）");
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

  test.each(precedence)("適用していなければ、$name が使われると表示する", async ({ place }) => {
    const sb = await synced();
    const used = place(sb);

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`適用していないので、利用者の置き場の tdd（${used}）が使われます`);
  });

  test.each(precedence)("適用していれば、通常の omp のセッションでは $name が使われ、ランチャーではそれが名前空間つきになると表示する", async ({ place }) => {
    const sb = await synced();
    const used = place(sb);
    expect((await sb.run("apply")).exitCode).toBe(0);

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`専用ランチャーから起動したセッション: pstack の tdd（${work(sb)}/omp/generated/pstack/skills/tdd/SKILL.md）が使われます`);
    expect(run.stdout).toContain(`利用者の置き場の tdd（${used}）は、名前空間つきの <名前空間>/tdd の名前になります`);
    expect(run.stdout).toContain(`通常の omp のセッション: 利用者の置き場の tdd（${used}）が使われます`);
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

  test.each(projectPrecedence)("実行したディレクトリのプロジェクトで、適用していなければ、$name が使われると表示する", async ({ place }) => {
    const sb = await synced();
    const project = gitProject(sb);
    const { used, where } = place(sb, project);

    const run = await sb.run("status", { cwd: project });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`適用していないので、${where}の tdd（${used}）が使われます`);
  });

  test.each(projectPrecedence)("実行したディレクトリのプロジェクトで、適用していれば、通常の omp のセッションでは $name が使われ、ランチャーではそれが名前空間つきになると表示する", async ({ place }) => {
    const sb = await synced();
    const project = gitProject(sb);
    const { used, where } = place(sb, project);
    expect((await sb.run("apply")).exitCode).toBe(0);

    const run = await sb.run("status", { cwd: project });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`専用ランチャーから起動したセッション: pstack の tdd（${work(sb)}/omp/generated/pstack/skills/tdd/SKILL.md）が使われます`);
    expect(run.stdout).toContain(`${where}の tdd（${used}）は、名前空間つきの <名前空間>/tdd の名前になります`);
    expect(run.stdout).toContain(`通常の omp のセッション: ${where}の tdd（${used}）が使われます`);
  });

  test("利用者の置き場に tdd が無くても、実行したディレクトリのプロジェクトの置き場にあれば、通常の omp のセッションではそれが使われると表示する", async () => {
    const sb = await synced();
    const project = gitProject(sb);
    put(join(project, ".claude", "skills", "tdd", "SKILL.md"), skillMd("tdd", "project"));
    expect((await sb.run("apply")).exitCode).toBe(0);

    const run = await sb.run("status", { cwd: project });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`通常の omp のセッション: プロジェクトの置き場の tdd（${project}/.claude/skills/tdd/SKILL.md）が使われます`);
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
    expect(run.stdout).toContain(`適用していないので、プロジェクトの置き場の tdd（${home}/work/.agents/skills/tdd/SKILL.md）が使われます\n`);
  });

  test("git の作業ツリーの外のホームの外でも、祖先のプロジェクトの .claude/skills の tdd を数える", async () => {
    const sb = await synced();
    const dir = join(realpathSync(sb.root), "outside", "a", "b");
    mkdirSync(dir, { recursive: true });
    put(join(sb.root, "outside", ".claude", "skills", "tdd", "SKILL.md"), skillMd("tdd", "ancestor"));
    put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "user"));
    expect((await sb.run("apply")).exitCode).toBe(0);

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
    expect(run.stdout).toContain(`適用していないので、利用者の置き場の tdd（${userTdd}）が使われます\n`);
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

  test.each(providers)("適用していなければ、$name が使われると表示する", async ({ place, env }) => {
    const sb = await synced();
    const used = place(sb);

    const run = await sb.run("status", { env: env?.(sb) });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`適用していないので、利用者の置き場の tdd（${used}）が使われます\n`);
  });

  test.each([
    ["skills.enabled が false", "skills:\n  enabled: false\n", "OMP の設定の skills.enabled が false なので、通常の omp はスキルを読み込みません"],
    ["disabledExtensions に skill:tdd がある", "disabledExtensions:\n  - skill:tdd\n", "OMP の設定の disabledExtensions に skill:tdd があるので、通常の omp は tdd を読み込みません"],
    ["skills.includeSkills に tdd が合わない", "skills:\n  includeSkills:\n    - git-*\n", "OMP の設定の skills.includeSkills に tdd が合わないので、通常の omp の一覧に tdd は残りません"],
    ["skills.ignoredSkills に tdd が合う", "skills:\n  ignoredSkills:\n    - t*\n", "利用者の置き場にも、実行したディレクトリのプロジェクトの置き場にも tdd はありません"],
  ])("OMP の設定の %s なら、~/.agents/skills に tdd があっても、通常の omp では使われないと表示する", async (_, config, reason) => {
    const sb = await synced();
    put(join(sb.home, ".agents", "skills", "tdd", "SKILL.md"), skillMd("tdd", "agents"));
    put(sb.configPath, config);
    expect((await sb.run("apply")).exitCode).toBe(0);

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`通常の omp のセッション: pstack の tdd は読み込まれません（${reason}）\n`);
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
      `適用していないので、利用者の置き場の tdd（${userTdd}）が使われます。ただし、OMP は ${modules}、${registry} からもスキルを読み、その中は調べていないので、そこに tdd があればそちらが使われます\n`,
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
    expect(run.stdout).toContain(`適用していないので、利用者の置き場の tdd（${customTdd}）が使われます\n`);
  });

  const damages: { name: string; damage(sb: Sandbox): void; shows: string }[] = [
    {
      name: "写しの読み替え表が記録と違う",
      damage: (sb) => writeFileSync(join(sb.copy, "content", "skills", "pstack-omp", "SKILL.md"), "書き換えた\n"),
      shows: "content/skills/pstack-omp/SKILL.md（sha256 が違う）",
    },
    {
      name: "写しの生成したスキル（pstack の tdd）が記録と違う",
      damage: (sb) => writeFileSync(join(sb.copy, "generated", "pstack", "skills", "tdd", "SKILL.md"), skillMd("tdd", "書き換えた")),
      shows: "generated/pstack/skills/tdd/SKILL.md（sha256 が違う）",
    },
    {
      name: "写しの中の生成したスキルの置き場が無い",
      damage: (sb) => rmSync(join(sb.copy, "generated", "cursor-team-kit"), { recursive: true }),
      shows: "/omp/generated/cursor-team-kit/skills がありません",
    },
    {
      name: "写しに記録に無いスキルが足された",
      damage: (sb) => put(join(sb.copy, "generated", "pstack", "skills", "extra", "SKILL.md"), skillMd("extra", "足した")),
      shows: "generated/pstack/skills/extra/SKILL.md（記録に無い）",
    },
    {
      name: "写しの専用ランチャー（bin/omp）が無い",
      damage: (sb) => rmSync(sb.launcher),
      shows: "bin/omp（無い）",
    },
    {
      name: "写しのサンドボックスのプロファイルが記録と違う",
      damage: (sb) => writeFileSync(join(sb.copy, "control", "sandbox.sb"), "(version 1)\n(allow default)\n"),
      shows: "control/sandbox.sb（sha256 が違う）",
    },
  ];

  test.each(damages)("$name: 何が欠けたか・違うかと、適用が壊れていることを表示する", async ({ damage, shows }) => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    damage(sb);

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(shows);
    expect(run.stdout).toContain("→ 適用が壊れています");
    expect(run.stdout).not.toContain("→ 適用しています");
  });

  test("写しの規則・組の記録・config.yml が読めなくても、例外で終わらずに、読めないことと適用が壊れていることを表示する", async () => {
    const sb = await synced();
    put(sb.configPath, "theme: dark\n");
    expect((await sb.run("apply")).exitCode).toBe(0);
    const config = realpathSync(sb.configPath);
    chmodSync(join(sb.copy, "control", "rules.json"), 0o000);
    const rules = await sb.run("status");
    chmodSync(join(sb.copy, "control", "harness.json"), 0o000);
    chmodSync(sb.configPath, 0o000);
    const all = await sb.run("status");

    expect(rules.stderr).toBe("");
    expect(rules.exitCode).toBe(0);
    expect(rules.stdout).toContain("control/rules.json（読めない）");
    expect(rules.stdout).toContain(`制御の規則 ${work(sb)}/omp/control/rules.json: 正しくありません（読めません`);
    expect(rules.stdout).toContain("→ 適用が壊れています");
    expect(all.stderr).toBe("");
    expect(all.exitCode).toBe(0);
    expect(all.stdout).toContain("が正しくありません（無いか、読めません）");
    expect(all.stdout).toContain(`OMP の設定 ${config}: 読めません`);
    expect(all.stdout).toContain("→ 適用が壊れています");
  });

  test("写しの中の生成したスキルの SKILL.md やプロジェクトの置き場の定義のファイルが、在るのに読めなくても、例外で終わらずに、読めないファイル・適用が壊れていること・名前を読めなかった置き場を表示し、ほかの節も最後まで出す", async () => {
    const sb = await withAgent();
    expect((await sb.run("apply")).exitCode).toBe(0);
    const project = join(sb.root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    put(join(project, ".omp", "agents", "poteto-agent.md"), "---\nname: poteto-agent\n---\n\nproject\n");
    put(join(project, ".omp", "agents", "locked.md"), "---\nname: locked\n---\n");
    put(join(project, ".omp", "skills", "locked", "SKILL.md"), skillMd("locked", "project"));
    mkdirSync(join(project, ".claude", "skills", "folder", "SKILL.md"), { recursive: true });
    chmodSync(join(project, ".omp", "agents", "locked.md"), 0o000);
    chmodSync(join(project, ".omp", "skills", "locked", "SKILL.md"), 0o000);
    chmodSync(join(sb.copy, "generated", "pstack", "skills", "tdd", "SKILL.md"), 0o000);
    const real = realpathSync(project);

    const run = await sb.run("status", { cwd: project });

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("generated/pstack/skills/tdd/SKILL.md（読めない）");
    expect(run.stdout).toContain("→ 適用が壊れています");
    expect(run.stdout).toContain("どの tdd が使われるか:\n");
    const section = run.stdout.slice(run.stdout.indexOf(`プロジェクト（${real}）`));
    expect(section.trim().split("\n").slice(1)).toEqual([
      `  ${real}/.omp/agents/poteto-agent.md: エージェント poteto-agent。プロジェクトの定義が優先されるので、このプロジェクトでは今回の定義が使われません`,
      `  ${real}/.omp/agents/locked.md: 読めないので、今回の定義やスキルと同じ名前かを確かめられません`,
      `  ${real}/.omp/skills/locked/SKILL.md: 読めないので、今回の定義やスキルと同じ名前かを確かめられません`,
      `  ${real}/.claude/skills/folder/SKILL.md: 読めないので、今回の定義やスキルと同じ名前かを確かめられません`,
    ]);
  });

  test("config.yml に以前の配置の読み込みの設定が残っていれば、そう表示して apply か remove を案内する", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    put(sb.configPath, `extensions:\n  - ${work(sb)}/omp/control/index.ts\nskills:\n  customDirectories:\n    - ${work(sb)}/omp/generated/pstack/skills\n`);

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(
      `以前の配置の読み込みの設定が残っています（extensions の ${work(sb)}/omp/control/index.ts、skills.customDirectories の ${work(sb)}/omp/generated/pstack/skills）。bun scripts/pstack-omp/cli.ts apply か remove で取り除いてください`,
    );
  });

  test("データ置き場の生成物が消えても、写しが揃っていれば適用しているままで、生成物の行で sync を案内する", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    rmSync(sb.generated, { recursive: true });

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("ありません（bun scripts/pstack-omp/cli.ts sync で作ります）");
    expect(run.stdout).toContain("→ 適用しています");
    expect(run.stdout).toContain("/omp/generated/pstack/skills/tdd/SKILL.md）が使われます");
  });

  test("config.yml が在れば（空でも）、OMP は config.yaml を読まないので、config.yaml の skills.customDirectories の tdd を利用者の置き場の tdd としない", async () => {
    const sb = await synced();
    put(sb.configPath, "");
    put(join(sb.root, "my-skills", "tdd", "SKILL.md"), skillMd("tdd", "mine"));
    put(join(sb.agentDir, "config.yaml"), `skills:\n  customDirectories:\n    - ${join(sb.root, "my-skills")}\n`);

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("適用していないので、pstack の tdd は使われません（利用者の置き場にも、実行したディレクトリのプロジェクトの置き場にも tdd はありません）");
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
  test("実行したディレクトリから git の作業ツリーの根までの置き場にある、今回の定義・読み替え表・生成したスキルと同じ名前を報告する", async () => {
    const sb = await withAgent();
    const project = join(sb.root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    put(join(project, ".omp", "agents", "poteto-agent.md"), "---\nname: poteto-agent\n---\n\nproject\n");
    put(join(project, ".omp", "skills", "tdd", "SKILL.md"), skillMd("tdd", "project"));
    put(join(project, ".agents", "skills", "table", "SKILL.md"), skillMd("pstack-omp", "project"));
    put(join(project, ".omp", "skills", "other", "SKILL.md"), skillMd("other", "project"));
    // OMP は実行したディレクトリから最も近い .omp/agents だけを読むので、遠い方（根の親）は報告しない
    put(join(sb.root, ".omp", "agents", "poteto-agent.md"), "---\nname: poteto-agent\n---\n\noutside\n");
    mkdirSync(join(project, "src"));
    const real = realpathSync(project);

    const run = await sb.run("status", { cwd: join(project, "src") });

    expect(run.exitCode).toBe(0);
    const section = run.stdout.slice(run.stdout.indexOf(`プロジェクト（${real}）`));
    expect(section.trim().split("\n").slice(1)).toEqual([
      `  ${real}/.omp/agents/poteto-agent.md: エージェント poteto-agent。プロジェクトの定義が優先されるので、このプロジェクトでは今回の定義が使われません`,
      `  ${real}/.omp/skills/tdd/SKILL.md: スキル tdd。生成したスキル（skills.customDirectories）が優先され、このスキルは <名前空間>/tdd の名前になります`,
      `  ${real}/.agents/skills/table/SKILL.md: スキル pstack-omp。今回の読み替え表のスキルと同じ名前なので、どちらかが <名前空間>/pstack-omp の名前になり、skill://pstack-omp で今回の表を読めないことがあります`,
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
        "今回の定義やスキルと同じ名前のもの（専用ランチャーから起動したセッションで効く）:\n  ありません\n",
    );
  });

  test("git の作業ツリーの根までに .omp/agents が無ければ、根より上の祖先の最も近い .omp/agents（OMP が読む）にある同じ名前を報告する", async () => {
    const sb = await withAgent();
    const project = join(sb.root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    mkdirSync(join(project, "src"));
    put(join(sb.root, ".omp", "agents", "poteto-agent.md"), "---\nname: poteto-agent\n---\n\noutside\n");

    const run = await sb.run("status", { cwd: join(project, "src") });

    expect(run.exitCode).toBe(0);
    expect(projectSection(run.stdout, realpathSync(project))).toEqual([`  ${realpathSync(sb.root)}/.omp/agents/poteto-agent.md: ${AGENT_CLASH}`]);
  });

  test("実行したディレクトリがホームの下で、それより近い .omp/agents が無ければ、ホームの .omp/agents（~/.omp/agent/agents とは別）にある同じ名前を報告する", async () => {
    const sb = await withAgent();
    const dir = join(sb.home, "work");
    mkdirSync(dir);
    put(join(sb.home, ".omp", "agents", "poteto-agent.md"), "---\nname: poteto-agent\n---\n\nhome\n");

    const run = await sb.run("status", { cwd: dir });

    expect(run.exitCode).toBe(0);
    expect(projectSection(run.stdout, realpathSync(dir))).toEqual([`  ${realpathSync(sb.home)}/.omp/agents/poteto-agent.md: ${AGENT_CLASH}`]);
  });

  test("近い .omp/agents と遠い .omp/agents の両方に同じ名前があれば、OMP が読む近い方だけを報告する", async () => {
    const sb = await withAgent();
    const project = join(sb.root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    put(join(project, ".omp", "agents", "poteto-agent.md"), "---\nname: poteto-agent\n---\n\nfar\n");
    put(join(project, "pkg", ".omp", "agents", "poteto-agent.md"), "---\nname: poteto-agent\n---\n\nnear\n");
    mkdirSync(join(project, "pkg", "src"));
    const real = realpathSync(project);

    const run = await sb.run("status", { cwd: join(project, "pkg", "src") });

    expect(run.exitCode).toBe(0);
    expect(projectSection(run.stdout, real)).toEqual([`  ${real}/pkg/.omp/agents/poteto-agent.md: ${AGENT_CLASH}`]);
  });

  const TDD_CLASH = "スキル tdd。生成したスキル（skills.customDirectories）が優先され、このスキルは <名前空間>/tdd の名前になります";
  const TABLE_CLASH = "スキル pstack-omp。今回の読み替え表のスキルと同じ名前なので、どちらかが <名前空間>/pstack-omp の名前になり、skill://pstack-omp で今回の表を読めないことがあります";

  test("git の作業ツリーの外のホームの下では、OMP と同じくホームの手前までの祖先のプロジェクトの置き場にある同じ名前を報告し、ホームの置き場（利用者の置き場）は報告しない", async () => {
    const sb = await withAgent();
    const { home, env } = realHome(sb);
    const dir = join(home, "work", "sub");
    mkdirSync(dir, { recursive: true });
    put(join(home, "work", ".omp", "skills", "tdd", "SKILL.md"), skillMd("tdd", "ancestor"));
    put(join(home, "work", ".agents", "skills", "table", "SKILL.md"), skillMd("pstack-omp", "ancestor"));
    put(join(home, ".agents", "skills", "table", "SKILL.md"), skillMd("pstack-omp", "user"));

    const run = await sb.run("status", { cwd: dir, env });

    expect(run.exitCode).toBe(0);
    expect(projectSection(run.stdout, dir)).toEqual([`  ${home}/work/.omp/skills/tdd/SKILL.md: ${TDD_CLASH}`, `  ${home}/work/.agents/skills/table/SKILL.md: ${TABLE_CLASH}`]);
  });

  test("git の作業ツリーの外のホームの外でも、祖先のプロジェクトの .claude/skills にある同じ名前を報告する", async () => {
    const sb = await withAgent();
    const root = realpathSync(sb.root);
    const dir = join(root, "outside", "a");
    mkdirSync(dir, { recursive: true });
    put(join(root, "outside", ".claude", "skills", "tdd", "SKILL.md"), skillMd("tdd", "ancestor"));

    const run = await sb.run("status", { cwd: dir });

    expect(run.exitCode).toBe(0);
    expect(projectSection(run.stdout, dir)).toEqual([`  ${root}/outside/.claude/skills/tdd/SKILL.md: ${TDD_CLASH}`]);
  });

  test("OMP が読まないプロジェクトのスキル（description の無い .omp/skills、enabled: false）は報告せず、disabledExtensions で外した名前は、専用ランチャーがその指定を外すので報告する", async () => {
    const sb = await withAgent();
    const project = join(sb.root, "project");
    mkdirSync(join(project, ".git"), { recursive: true });
    put(join(project, ".omp", "skills", "tdd", "SKILL.md"), "---\nname: tdd\n---\n\nproject\n");
    put(join(project, ".claude", "skills", "table", "SKILL.md"), "---\nname: pstack-omp\ndescription: test\nenabled: false\n---\n");
    put(join(project, ".agents", "skills", "t", "SKILL.md"), "---\nname: tdd\n---\n\nagents\n");
    put(sb.configPath, "disabledExtensions:\n  - skill:tdd\n");
    const real = realpathSync(project);

    const run = await sb.run("status", { cwd: project });

    expect(run.exitCode).toBe(0);
    expect(projectSection(run.stdout, real)).toEqual([`  ${real}/.agents/skills/t/SKILL.md: ${TDD_CLASH}`]);
  });
});
