// README の一度だけ登録する値が、status が既定の置き場で表示する値と同じで、固定の記録のコミットのものであることと、
// リポジトリの poteto-agent の定義を確かめる（どちらも Task 4 で新しい方式に合わせて直す）。
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { REPO_CONTENT, sandbox } from "./helpers";

const REPO = resolve(REPO_CONTENT, "..", "..");
const README = readFileSync(join(REPO, "README.md"), "utf8");
const PIN = JSON.parse(readFileSync(join(REPO, "scripts", "pstack-omp", "pin.json"), "utf8")) as Record<string, string>;
// README の一度だけ登録する値（manualSkills を含む yaml のコードブロック）
const REGISTRATION = /```yaml\n(extensions:\n[\s\S]*?\n {2}manualSkills:\n[\s\S]*?)\n```/.exec(README)?.[1];
const CURSOR_TEAM_KIT = ["control-cli", "control-ui", "deslop"];

describe("README の一度だけ登録する値", () => {
  test("固定の記録のコミットのものと書かれている", () => {
    expect(README).toContain(`のコミット \`${PIN.commit}\` から生成した全スキルと \`pstack-omp\``);
  });

  test("既定の置き場（~/.local/share/nod）の生成物で status が表示する値と、キー・パス・名前・順まで同じである", async () => {
    expect(REGISTRATION).toBeDefined();
    // README の yaml の形（上の正規表現で取り出した、extensions・skills.customDirectories・skills.manualSkills の3つ）
    const parsed = Bun.YAML.parse(REGISTRATION!) as { skills: { manualSkills: string[] } };
    const names = parsed.skills.manualSkills;
    const generated = names.filter((name) => name !== "pstack-omp");
    const sb = sandbox({ repoContent: true });
    sb.commit("0.15.46");
    sb.pin();
    const pin = JSON.parse(readFileSync(join(sb.root, "pin.json"), "utf8")) as Record<string, string>;
    // NOD_DATA_DIR を外し、既定の <HOME>/.local/share/nod の生成先に、README の名前の manifest を置く
    const dir = join(sb.home, ".local", "share", "nod", "pstack-omp", "generated");
    mkdirSync(dir, { recursive: true });
    const skills = { pstack: generated.filter((name) => !CURSOR_TEAM_KIT.includes(name)), "cursor-team-kit": generated.filter((name) => CURSOR_TEAM_KIT.includes(name)) };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ pin, skills }));

    const run = await sb.run("status", { cwd: sb.project, env: { NOD_DATA_DIR: undefined } });

    expect(run.exitCode).toBe(0);
    expect(skills["cursor-team-kit"]).toEqual(CURSOR_TEAM_KIT);
    expect(run.stdout).toContain(`${REGISTRATION!.replace("<nod のリポジトリの絶対パス>", REPO).replaceAll("~/", `${sb.home}/`)}\n`);
  });
});

describe("リポジトリの OMP 向けのディレクトリ（poteto-agent）", () => {
  test("リポジトリの poteto-agent の定義は、役割 task のモデルで、読み替え表を自動で読み、既定の task と poteto-agent を起動できる", () => {
    const text = readFileSync(join(REPO_CONTENT, "agents", "poteto-agent.md"), "utf8");
    const frontmatter = Bun.YAML.parse(/^---\n([\s\S]*?)\n---\n/.exec(text)![1]!) as Record<string, unknown>;

    expect(frontmatter).toMatchObject({ name: "poteto-agent", model: "@task", spawns: ["task", "poteto-agent"], "autoload-skills": "pstack-omp" });
  });
});
