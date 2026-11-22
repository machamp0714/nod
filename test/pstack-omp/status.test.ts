// pstack を OMP 向けに使う道具（scripts/pstack-omp/cli.ts）の状態の表示（status）を、プロセスとして起動して外から確かめる。
// 利用者の OMP の設定の置き場・ホーム・データ置き場は一時ディレクトリ（helpers.ts）。
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { put, type Sandbox, skillMd, synced, unlockSandboxes, writable } from "./helpers";

afterAll(unlockSandboxes);

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

  test("適用していれば、登録・写しの sha256・生成物の pin・OMP の版がそろっていることと、pstack の tdd が使われ、利用者の tdd が名前空間つきになることを表示する", async () => {
    const sb = await synced();
    const userTdd = join(sb.home, ".agents", "skills", "tdd", "SKILL.md");
    put(userTdd, skillMd("tdd", "mine"));
    expect((await sb.run("apply")).exitCode).toBe(0);
    const work = join(realpathSync(sb.dataDir), "pstack-omp");

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`extensions に ${work}/omp/control を登録しています`);
    expect(run.stdout).toContain("組のファイルは記録の sha256 と一致しています");
    expect(run.stdout).toContain("元にした pin は固定の記録と一致しています");
    expect(run.stdout).toContain("OMP の版: 19.1.0（固定の記録 19.1.0、適用したときの記録 19.1.0）\n");
    expect(run.stdout).toContain("→ 適用しています");
    expect(run.stdout).toContain(`pstack の tdd（${work}/generated/pstack/skills/tdd/SKILL.md）が使われます`);
    expect(run.stdout).toContain(`利用者の置き場の tdd（${userTdd}）は、名前空間つきの <名前空間>/tdd の名前になります`);
  });

  test("写しのファイルが記録と違えば、そのファイルと、適用が壊れていることを表示する", async () => {
    const sb = await synced();
    expect((await sb.run("apply")).exitCode).toBe(0);
    const table = join(sb.copy, "content", "skills", "pstack-omp", "SKILL.md");
    writable(table);
    writeFileSync(table, "書き換えた\n");

    const run = await sb.run("status");

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("content/skills/pstack-omp/SKILL.md（sha256 が違う）");
    expect(run.stdout).toContain("→ 適用が壊れています");
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
