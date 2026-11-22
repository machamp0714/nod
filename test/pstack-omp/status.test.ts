// pstack を OMP 向けに使う道具（scripts/pstack-omp/cli.ts）の状態の表示（status）を、プロセスとして起動して外から確かめる。
// 利用者の OMP の設定の置き場・ホーム・データ置き場は一時ディレクトリ（helpers.ts）。
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { put, type Sandbox, skillMd, synced } from "./helpers";

// 同期した上に、今回置くエージェント定義 poteto-agent を OMP 向けのディレクトリに置く
async function withAgent(): Promise<Sandbox> {
  const sb = await synced();
  sb.content("agents/poteto-agent.md", "---\nname: poteto-agent\ndescription: test\n---\n\nYou are poteto.\n");
  return sb;
}

describe("適用の状態とどの tdd が使われるか", () => {
  test("適用していなければ、そう表示し、利用者の置き場の tdd が使われると表示する", async () => {
    const sb = await synced();
    const userTdd = join(sb.home, ".agents", "skills", "tdd", "SKILL.md");
    put(userTdd, skillMd("tdd", "mine"));

    const run = await sb.run("status");

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("を登録していません");
    expect(run.stdout).toContain("→ 適用していません");
    expect(run.stdout).toContain(`適用していないので、利用者の置き場の tdd（${userTdd}）が使われます`);
  });

  test("適用していれば、3つの読み込みの設定の登録・写しの sha256・生成物の pin・OMP の版がそろっていることと、写しの中の pstack の tdd が使われ、利用者の tdd が名前空間つきになることを表示する", async () => {
    const sb = await synced();
    const userTdd = join(sb.home, ".agents", "skills", "tdd", "SKILL.md");
    put(userTdd, skillMd("tdd", "mine"));
    expect((await sb.run("apply")).exitCode).toBe(0);
    const work = join(realpathSync(sb.dataDir), "pstack-omp");

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(
      `3つの読み込みの設定を登録しています（extensions に ${work}/omp/control/index.ts と ${work}/omp/content、skills.customDirectories の先頭に写しの中の生成したスキルの置き場、skills.manualSkills に読み込む 6 個のスキル）`,
    );
    expect(run.stdout).toContain("組のファイルは記録の sha256 と一致しています");
    expect(run.stdout).toContain("元にした pin は固定の記録と一致しています");
    expect(run.stdout).toContain("OMP の版: 19.1.0（固定の記録 19.1.0、適用したときの記録 19.1.0）\n");
    expect(run.stdout).toContain("→ 適用しています");
    expect(run.stdout).toContain(`pstack の tdd（${work}/omp/generated/pstack/skills/tdd/SKILL.md）が使われます`);
    expect(run.stdout).toContain(`利用者の置き場の tdd（${userTdd}）は、名前空間つきの <名前空間>/tdd の名前になります`);
    expect(run.stdout).toContain(`起動の入口: ${work}/omp/bin/omp から起動してください`);
    expect(run.stdout).toContain("全ツールを遮断");
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
      shows: "生成したスキルの置き場 ",
    },
    {
      name: "config.yml の skills.manualSkills から読み込むスキルの名前が消えた",
      damage: (sb) => writeFileSync(sb.configPath, readFileSync(sb.configPath, "utf8").replace(/^ +- tdd\n/m, "")),
      shows: "読み込みの設定が欠けています: skills.manualSkills の tdd",
    },
    {
      name: "config.yml の extensions から OMP 向けのディレクトリが消えた",
      damage: (sb) => writeFileSync(sb.configPath, readFileSync(sb.configPath, "utf8").replace(/^ +- .*\/omp\/content\n/m, "")),
      shows: "読み込みの設定が欠けています: extensions の ",
    },
    {
      name: "config.yml の extensions の制御の拡張がファイルではなくディレクトリ（disabledExtensions で外せる形）に書き換えられた",
      damage: (sb) => writeFileSync(sb.configPath, readFileSync(sb.configPath, "utf8").replace("/omp/control/index.ts\n", "/omp/control\n")),
      shows: "読み込みの設定が欠けています: extensions の ",
    },
    {
      name: "写しの起動の入口（bin/omp）が無い",
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
    // git の作業ツリーの外（根の親）は、このプロジェクトの置き場ではない
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
    expect(run.stdout).toContain(`プロジェクト（${realpathSync(project)}）の置き場にある、今回の定義やスキルと同じ名前のもの:\n  ありません\n`);
  });
});
