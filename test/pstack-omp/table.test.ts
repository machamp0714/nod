// README の一度だけ登録する値が、status が既定の置き場で表示する値と同じで、固定の記録のコミットのものであることと、
// リポジトリの OMP 向けのディレクトリ（poteto-agent だけで、以前の読み替え表のスキルは無い）を確かめる。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    expect(README).toContain(`のコミット \`${PIN.commit}\` から生成した全スキルです。`);
  });

  test("既定の置き場（~/.local/share/nod）の生成物で status が表示する値と、キー・パス・名前・順まで同じである", async () => {
    expect(REGISTRATION).toBeDefined();
    // README の yaml の形（上の正規表現で取り出した、extensions・skills.customDirectories・skills.manualSkills の3つ）
    const parsed = Bun.YAML.parse(REGISTRATION!) as { skills: { manualSkills: string[] } };
    const generated = parsed.skills.manualSkills;
    expect(generated).not.toContain("pstack-omp");
    // pstack の tdd は pstack-tdd の名前で生成するので、登録するのは pstack-tdd（tdd を入れると利用者の tdd がスキルの一覧から外れる）
    expect(generated).toContain("pstack-tdd");
    expect(generated).not.toContain("tdd");
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

describe("リポジトリの OMP 向けのディレクトリ（poteto-agent・spec-planner・spec-consultant）", () => {
  test("エージェント定義 poteto-agent・spec-planner・spec-consultant だけがあり、スキル（以前の読み替え表 pstack-omp）は無い", () => {
    expect(readdirSync(REPO_CONTENT)).toEqual(["agents"]);
    expect(readdirSync(join(REPO_CONTENT, "agents")).sort()).toEqual(["poteto-agent.md", "spec-consultant.md", "spec-planner.md"]);
    expect(existsSync(join(REPO_CONTENT, "skills"))).toBe(false);
  });

  test("poteto-agent は役割 task のモデルで既定の task と poteto-agent を起動でき、読み替え表を自動で読まず、poteto-mode を読んでから生成済みの手順に従う", () => {
    const text = readFileSync(join(REPO_CONTENT, "agents", "poteto-agent.md"), "utf8");
    const [, head, body] = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)!;
    const frontmatter = Bun.YAML.parse(head!) as Record<string, unknown>;

    expect(Object.keys(frontmatter).sort()).toEqual(["description", "model", "name", "spawns"]);
    expect(frontmatter).toMatchObject({ name: "poteto-agent", model: "@task", spawns: ["task", "poteto-agent"] });
    expect(frontmatter.description).toContain("/skill:poteto-mode");
    expect(text).not.toContain("pstack-omp");
    expect(body).toContain("skill://poteto-mode");
    expect(body).toContain("skill://principle-<name>");
    expect(body).toContain("stop and tell your parent");
  });
});
