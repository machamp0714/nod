// pstack を OMP 向けに使う道具（scripts/pstack-omp/cli.ts）の同期（sync）のうち取得を、プロセスとして起動して外から確かめる。
// 一時の上流・置き場の作り方は helpers.ts を参照。生成は generate.test.ts で確かめる。
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Pin, sandbox } from "./helpers";

const PIN = join(import.meta.dir, "../../scripts/pstack-omp/pin.json");

describe("固定の記録", () => {
  test("リポジトリの URL・コミット・pstack の版・確かめた OMP の版が書かれている", () => {
    const pin = JSON.parse(readFileSync(PIN, "utf8"));
    expect(pin).toEqual({
      repository: "https://github.com/cursor/plugins.git",
      commit: "792440e8a560a4a3f63748cdee70491ecd412982",
      pstackVersion: "0.15.46",
      ompVersion: "19.1.0",
    });
  });
});

describe("同期", () => {
  test("データ置き場に上流を clone し、記録したコミットにする", async () => {
    const sb = sandbox();
    const pinned = sb.commit("0.15.46");
    sb.commit("0.15.47"); // 記録より新しいコミットが上流の先頭にあっても、記録したコミットにする
    sb.pin({ commit: pinned, pstackVersion: "0.15.46" });

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(sb.cloneHead()).toBe(pinned);
    expect(sb.cloneStatus()).toBe("");
    expect(readFileSync(join(sb.clone, "pstack/skills/poteto-mode/SKILL.md"), "utf8")).toContain("0.15.46");
    expect(run.stdout).toContain(pinned);
  });

  test("もう一度同期しても結果が変わらない。既存の clone を再利用し、手で変えた作業ツリーも記録したコミットに揃える", async () => {
    const sb = sandbox();
    const pinned = sb.commit("0.15.46");
    sb.pin();
    expect((await sb.sync()).exitCode).toBe(0);
    writeFileSync(join(sb.clone, "pstack/skills/poteto-mode/SKILL.md"), "書き換えた\n");
    writeFileSync(join(sb.clone, "untracked.txt"), "足した\n");
    // 上流に届かなくても、手元にあるコミットだけで揃う（clone し直していない）
    renameSync(sb.upstream, `${sb.upstream}-moved`);

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(sb.cloneHead()).toBe(pinned);
    expect(sb.cloneStatus()).toBe("");
    expect(readFileSync(join(sb.clone, "pstack/skills/poteto-mode/SKILL.md"), "utf8")).toBe("---\nname: poteto-mode\n---\n\n0.15.46\n");
    expect(readdirSync(join(sb.dataDir, "pstack-omp")).sort()).toEqual(["generated", "upstream"]);
  });

  test("記録を新しいコミットに上げると、既存の clone に上流から取り寄せて揃える", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin();
    expect((await sb.sync()).exitCode).toBe(0);
    const newer = sb.commit("0.15.47");
    sb.pin();

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(sb.cloneHead()).toBe(newer);
    expect(sb.cloneStatus()).toBe("");
  });
});

describe("OMP の版が記録と違うと、取得せずに止まって理由を報告する", () => {
  test("置き場に何も作らない", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin();
    sb.omp("19.0.1");

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("19.0.1");
    expect(run.stderr).toContain("19.1.0");
    expect(existsSync(sb.dataDir)).toBe(false);
  });

  test("既存の clone を変えない", async () => {
    const sb = sandbox();
    const pinned = sb.commit("0.15.46");
    sb.pin();
    expect((await sb.sync()).exitCode).toBe(0);
    sb.commit("0.15.47");
    sb.pin();
    sb.omp("19.0.1");

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(sb.cloneHead()).toBe(pinned);
    expect(sb.cloneStatus()).toBe("");
  });

  test("omp の版を確かめられないときも止まる", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin();
    sb.omp(null);

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("omp: 壊れている");
    expect(existsSync(sb.dataDir)).toBe(false);
  });
});

describe("取得の途中で失敗すると、止まって報告し、壊れた clone を残さない", () => {
  const MISSING = "0123456789abcdef0123456789abcdef01234567";

  test.each([
    { label: "上流に記録のコミットが無い", over: (): Partial<Pin> => ({ commit: MISSING }), reason: MISSING },
    { label: "clone に失敗する", over: (): Partial<Pin> => ({ repository: "/nonexistent/plugins.git" }), reason: "clone" },
    { label: "コミットの pstack の版が記録と違う", over: (): Partial<Pin> => ({ pstackVersion: "0.15.45" }), reason: "0.15.45" },
  ])("新しく取得するとき: $label", async ({ over, reason }) => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin(over());

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(reason);
    expect(existsSync(sb.clone)).toBe(false);
    expect(readdirSync(join(sb.dataDir, "pstack-omp"))).toEqual([]);
  });

  test.each([
    { label: "上流に記録のコミットが無い", over: (): Partial<Pin> => ({ commit: MISSING }), reason: MISSING },
    { label: "コミットの pstack の版が記録と違う", over: (): Partial<Pin> => ({ pstackVersion: "0.15.45" }), reason: "0.15.45" },
    { label: "origin が記録のリポジトリと違う", over: (): Partial<Pin> => ({ repository: "https://example.com/other.git" }), reason: "origin" },
  ])("既存の clone があるとき: $label。clone を変えない", async ({ over, reason }) => {
    const sb = sandbox();
    const pinned = sb.commit("0.15.46");
    sb.pin();
    expect((await sb.sync()).exitCode).toBe(0);
    sb.commit("0.15.47");
    sb.pin(over());

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(reason);
    expect(sb.cloneHead()).toBe(pinned);
    expect(sb.cloneStatus()).toBe("");
    expect(readdirSync(join(sb.dataDir, "pstack-omp")).sort()).toEqual(["generated", "upstream"]);
  });

  test("置き場に clone でないものがあれば、触らずに止まる", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin();
    mkdirSync(sb.clone, { recursive: true });
    writeFileSync(join(sb.clone, "keep.txt"), "利用者のもの\n");

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(sb.clone);
    expect(readdirSync(sb.clone)).toEqual(["keep.txt"]);
    expect(readFileSync(join(sb.clone, "keep.txt"), "utf8")).toBe("利用者のもの\n");
  });

  test("固定の記録に項目が欠けていれば、取得せずに止まる", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin({ commit: "" });

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("commit");
    expect(existsSync(sb.dataDir)).toBe(false);
  });
});
