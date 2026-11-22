// nod のリポジトリの読み替え表（omp/content/skills/pstack-omp/SKILL.md）の実物で生成できることを、同期をプロセスとして起動して外から確かめる。
// OMP 向けのディレクトリは差し替えず既定のまま使うので、表から用語の行が落ちると失敗する（上流の更新で用語が増えたときの見落としも、一覧に足せばここで分かる）。
import { describe, expect, test } from "bun:test";
import { SAMPLES, sandbox, skillMd, TERM_KEYS } from "./helpers";

describe("リポジトリの読み替え表", () => {
  test("一覧の26種類の用語をすべて使う上流から、既定の OMP 向けのディレクトリの表で生成でき、全用語が使われたと報告される", async () => {
    const sb = sandbox({ repoTable: true });
    const files: Record<string, string> = {};
    SAMPLES.forEach(({ text }, i) => {
      files[`pstack/skills/s${String(i).padStart(2, "0")}/SKILL.md`] = skillMd(`s${i}`, text);
    });
    sb.commit("0.15.46", files);
    sb.pin();

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    const reported = run.stdout.split("\n").flatMap((line) => /^ {2}(.+)（使うスキル: .+）$/.exec(line)?.[1] ?? []);
    expect(reported).toEqual(TERM_KEYS);
  });
});
