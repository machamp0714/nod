// nod のリポジトリの読み替え表（omp/content/skills/pstack-omp/SKILL.md）の実物で生成できることを、同期をプロセスとして起動して外から確かめる。
// OMP 向けのディレクトリは差し替えず既定のまま使うので、表から用語の行が落ちると失敗する（上流の更新で用語が増えたときの見落としも、一覧に足せばここで分かる）。
// 表が示す生成先の中のパス（定義ファイルと manifest.json）が生成物に無くても失敗する。
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_CONTENT, SAMPLES, sandbox, skillMd, TERM_KEYS } from "./helpers";

describe("リポジトリの OMP 向けのディレクトリ（読み替え表と poteto-agent）", () => {
  test("一覧の26種類の用語をすべて使う上流から、既定の OMP 向けのディレクトリの表で生成でき、全用語が使われたと報告され、表が示す定義ファイルと manifest.json が生成物に在る", async () => {
    const sb = sandbox({ repoTable: true });
    const files: Record<string, string> = {};
    SAMPLES.forEach(({ text }, i) => {
      files[`pstack/skills/s${String(i).padStart(2, "0")}/SKILL.md`] = skillMd(`s${i}`, text);
    });
    // 上流の no-comments と同じく、スキルの外の comment-sicko の定義をリンクする
    files["pstack/skills/no-comments/SKILL.md"] = skillMd("no-comments", "Spawn [Comment Sicko](../../agents/comment-sicko.md).");
    files["pstack/agents/comment-sicko.md"] = "---\nname: comment-sicko\n---\n\nReview comments.\n";
    sb.commit("0.15.46", files);
    sb.pin();

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    const reported = run.stdout.split("\n").flatMap((line) => /^ {2}(.+)（使うスキル: .+）$/.exec(line)?.[1] ?? []);
    expect(reported).toEqual(TERM_KEYS);
    // <X> は生成先の親（<データ置き場>/pstack-omp）で、<X>/generated/ が生成先
    expect(existsSync(join(sb.generated, "pstack/agents/comment-sicko.md"))).toBe(true);
    expect(existsSync(join(sb.generated, "manifest.json"))).toBe(true);
    expect(existsSync(join(sb.generated, "pstack/skills/poteto-mode/SKILL.md"))).toBe(true);
  });

  test("リポジトリの poteto-agent の定義は、役割 task のモデルで、読み替え表を自動で読み、既定の task と poteto-agent を起動できる", () => {
    const text = readFileSync(join(REPO_CONTENT, "agents", "poteto-agent.md"), "utf8");
    const frontmatter = Bun.YAML.parse(/^---\n([\s\S]*?)\n---\n/.exec(text)![1]!) as Record<string, unknown>;

    expect(frontmatter).toMatchObject({ name: "poteto-agent", model: "@task", spawns: ["task", "poteto-agent"], "autoload-skills": "pstack-omp" });
  });
});
