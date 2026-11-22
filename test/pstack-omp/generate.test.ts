// pstack を OMP 向けに使う道具（scripts/pstack-omp/cli.ts）の同期（sync）のうち、取得に続く OMP 向けのコピーの生成を、
// プロセスとして起動して外から確かめる。一時の上流・置き場・読み替え表の作り方は helpers.ts を参照。
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EMPTY_TABLE, GUIDE_LINE, type Run, SAMPLES, sandbox, skillMd, skillNames, snapshot, TERM_KEYS } from "./helpers";

// 用語が当たらない、似た書き方
const LOOKALIKES = [
  "Edit src/foo/loop.ts and run the loop.",
  "Run the `/loop-on-ci` skill.",
  "Push with git push origin pr-123.",
  "A project worker in lower case.",
  "The task list and the subagent type.",
];

function table(keys: string[]): string {
  return EMPTY_TABLE + keys.map((key) => `| ${key} | 読み替え |\n`).join("");
}

// 失敗の報告から、対応行のない用語と、それを使うスキルを読み取る
function missingRows(run: Run): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const line of run.stderr.split("\n")) {
    const match = /^ {2}(.+)（使うスキル: (.+)）$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) rows.set(match[1], match[2].split(", "));
  }
  return rows;
}

function readGenerated(sb: { generated: string }, path: string): string {
  return readFileSync(join(sb.generated, path), "utf8");
}

describe("同期に続けて OMP 向けのコピーを生成する", () => {
  test("pstack の全スキルと cursor-team-kit の3つだけが、データ置き場にスキルとして読まれる形で生成される", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", {
      "pstack/skills/setup-pstack/SKILL.md": skillMd("setup-pstack", "Set up."),
      "pstack/skills/tdd/SKILL.md": skillMd("tdd", "Red, green."),
      "pstack/agents/poteto-agent.md": "---\nname: poteto-agent\n---\n\nAgent.\n",
    });
    sb.pin();

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(sb.generated);
    expect(skillNames(join(sb.generated, "pstack/skills"))).toEqual(["poteto-mode", "setup-pstack", "tdd"]);
    expect(skillNames(join(sb.generated, "cursor-team-kit/skills"))).toEqual(["control-cli", "control-ui", "deslop"]);
    expect(readdirSync(join(sb.generated, "cursor-team-kit/skills")).sort()).toEqual(["control-cli", "control-ui", "deslop"]);
    // スキルから辿られない上流の定義は入れない
    expect(existsSync(join(sb.generated, "pstack/agents"))).toBe(false);
    expect(readdirSync(sb.generated).sort()).toEqual(["cursor-team-kit", "manifest.json", "pstack"]);
  });

  test("manifest に、生成したスキル・案内の1行を入れたスキル・元にした固定の記録が安定した順に書かれる", async () => {
    const sb = sandbox();
    const commit = sb.commit("0.15.46", {
      "pstack/skills/swarm/SKILL.md": skillMd("swarm", "Spawn one `Task` per worker."),
      "pstack/skills/arena/SKILL.md": skillMd("arena", "Pick gpt-5."),
      "cursor-team-kit/skills/control-ui/SKILL.md": skillMd("control-ui", "Read agent-transcripts."),
    });
    sb.pin();
    sb.table(table(["`Task`", "gpt-", "agent-transcripts"]));

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readGenerated(sb, "manifest.json")).toBe(
      JSON.stringify(
        {
          pin: { repository: sb.upstream, commit, pstackVersion: "0.15.46", ompVersion: "19.1.0" },
          skills: { pstack: ["arena", "poteto-mode", "swarm"], "cursor-team-kit": ["control-cli", "control-ui", "deslop"] },
          guided: { pstack: ["arena", "swarm"], "cursor-team-kit": ["control-ui"] },
        },
        null,
        2,
      ) + "\n",
    );
  });
});

describe("Cursor の名前を使うスキルに案内の1行を入れ、ほかは上流のまま保つ", () => {
  test("最初の H1 の直後に案内の1行が入り、ほかの部分は上流と同じバイトになる", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", {
      "pstack/skills/how/SKILL.md":
        "---\nname: how\n# not a heading in frontmatter\n---\n\n```sh\n# not a heading in code\n```\n\n# How\n\n\nSpawn one `Task` subagent.\n\n# Second H1\n",
    });
    sb.pin();
    sb.table(table(["`Task`"]));

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readGenerated(sb, "pstack/skills/how/SKILL.md")).toBe(
      "---\nname: how\n# not a heading in frontmatter\n---\n\n```sh\n# not a heading in code\n```\n\n# How\n\n" +
        GUIDE_LINE +
        "\n\nSpawn one `Task` subagent.\n\n# Second H1\n",
    );
  });

  // 案内の1行は H1 の後の最初の空行の後に置き、上流の空行はすべて残す。足す空行は、案内の1行を独立した段落にするのに要る分だけ
  test.each([
    { blank: 0, upstream: "# How\nSpawn one `Task`.\n", expected: `# How\n\n${GUIDE_LINE}\n\nSpawn one \`Task\`.\n` },
    { blank: 1, upstream: "# How\n\nSpawn one `Task`.\n", expected: `# How\n\n${GUIDE_LINE}\n\nSpawn one \`Task\`.\n` },
    { blank: 3, upstream: "# How\n\n\n\nSpawn one `Task`.\n", expected: `# How\n\n${GUIDE_LINE}\n\n\nSpawn one \`Task\`.\n` },
    { blank: 5, upstream: "# How\n\n\n\n\n\nSpawn one `Task`.\n", expected: `# How\n\n${GUIDE_LINE}\n\n\n\n\nSpawn one \`Task\`.\n` },
  ])("H1 の後の空行が $blank 行でも上流の空行を削らない", async ({ upstream, expected }) => {
    const sb = sandbox();
    const front = "---\nname: how\n---\n\n";
    sb.commit("0.15.46", { "pstack/skills/how/SKILL.md": front + upstream });
    sb.pin();
    sb.table(table(["`Task`"]));

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readGenerated(sb, "pstack/skills/how/SKILL.md")).toBe(front + expected);
  });

  test("用語のないスキルは、付属のファイルの実行属性とリンクも含めて上流と完全に同じになる", async () => {
    const sb = sandbox();
    const files = {
      "pstack/skills/plain/SKILL.md": skillMd("plain", "See [the guide](../../docs/guide/01-setup.md) and [notes](references/notes.md#top)."),
      "pstack/skills/plain/references/notes.md": "# Notes\n\n[back](../SKILL.md)\n",
      "pstack/skills/plain/scripts/run.sh": "#!/bin/sh\necho run\n",
      "pstack/skills/plain/data/table.tsv": "a\tb\n",
      "pstack/docs/guide/01-setup.md": "# Setup\n\n![shot](images/setup.jpg)\n",
      "pstack/docs/guide/images/setup.jpg": "jpeg",
    };
    sb.commit("0.15.46", files, ["pstack/skills/plain/scripts/run.sh"]);
    sb.pin();

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    const generated = snapshot(sb.generated);
    const upstream = snapshot(sb.clone);
    for (const path of Object.keys(files)) expect(generated.get(path)).toEqual(upstream.get(path)!);
    expect(generated.get("pstack/skills/plain/scripts/run.sh")?.executable).toBe(true);
    expect(generated.get("pstack/skills/plain/SKILL.md")?.executable).toBe(false);
    // 上流の pstack/ のほかのファイル（plugin.json など）は入れない
    expect(generated.has("pstack/.cursor-plugin/plugin.json")).toBe(false);
  });

  test("スキルの外へのリンクの先を同じ相対位置に保ち、その先の文書のリンクの先も保つ", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", {
      "pstack/skills/poteto-help/SKILL.md": skillMd("poteto-help", "Read [the README](../../README.md)."),
      "pstack/README.md": "# pstack\n\nSee [the agent](./agents/poteto-agent.md) and [guide](./docs/guide/).\n",
      "pstack/agents/poteto-agent.md": "---\nname: poteto-agent\n---\n\nAgent.\n",
      "pstack/docs/guide/README.md": "# Guide\n",
      "pstack/assets/logo.png": "png",
    });
    sb.pin();
    // リンクの先の定義が用語 poteto-agent を使う
    sb.table(table(["poteto-agent"]));

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    const generated = snapshot(sb.generated);
    const upstream = snapshot(sb.clone);
    for (const path of ["pstack/README.md", "pstack/agents/poteto-agent.md", "pstack/docs/guide/README.md"]) {
      expect(generated.get(path)).toEqual(upstream.get(path)!);
    }
    expect(generated.has("pstack/assets/logo.png")).toBe(false);
    // 上流の定義は、スキルとして読まれる置き場の外にある
    expect(skillNames(join(sb.generated, "pstack/skills"))).toEqual(["poteto-help", "poteto-mode"]);
  });

  test("スキルの外のリンク先（リンク先を経た先も）だけに用語があっても検出し、対応行が無ければ失敗し、あればそのスキルに案内の1行を入れる", async () => {
    const sb = sandbox();
    const caller = skillMd("caller", "Then follow [help](../help/SKILL.md).");
    sb.commit("0.15.46", {
      "pstack/skills/help/SKILL.md": skillMd("help", "Read [the README](../../README.md)."),
      "pstack/README.md": "# pstack\n\nSee [the guide](./docs/guide/05-build.md).\n",
      "pstack/docs/guide/05-build.md": "# Build\n\nSpawn one `Task` per worker.\n",
      // 別の生成するスキルへのリンクは辿らない（そのスキルは自分の案内の1行を持つ）
      "pstack/skills/caller/SKILL.md": caller,
    });
    sb.pin();

    const failed = await sb.sync();
    expect(failed.exitCode).toBe(1);
    expect(missingRows(failed)).toEqual(new Map([["`Task`", ["pstack/help"]]]));
    expect(existsSync(sb.generated)).toBe(false);

    sb.table(table(["`Task`"]));
    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("  `Task`（使うスキル: pstack/help）\n");
    expect(readGenerated(sb, "pstack/skills/help/SKILL.md")).toBe(
      `---\nname: help\ndescription: test\n---\n\n# help\n\n${GUIDE_LINE}\n\nRead [the README](../../README.md).\n`,
    );
    expect(readGenerated(sb, "pstack/skills/caller/SKILL.md")).toBe(caller);
    expect(readGenerated(sb, "pstack/docs/guide/05-build.md")).toBe("# Build\n\nSpawn one `Task` per worker.\n");
    expect(JSON.parse(readGenerated(sb, "manifest.json")).guided).toEqual({ pstack: ["help"], "cursor-team-kit": [] });
  });

  test("生成物の中で解決できない相対リンクがあると、どのファイルのどのリンクかを報告して失敗する", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", {
      // 読み込まない cursor-team-kit のスキルを指すリンク
      "cursor-team-kit/skills/deslop/SKILL.md": skillMd("deslop", "Then run [fix-ci](../fix-ci/SKILL.md)."),
      // 上流に無い先を指すリンクは、上流でも解決しないので問題にしない
      "pstack/skills/broken/SKILL.md": skillMd("broken", "See [gone](../../docs/gone.md)."),
    });
    sb.pin();

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("cursor-team-kit/skills/deslop/SKILL.md");
    expect(run.stderr).toContain("../fix-ci/SKILL.md");
    expect(run.stderr).not.toContain("gone.md");
    expect(existsSync(sb.generated)).toBe(false);
  });

  test("用語を使うスキルの SKILL.md に H1 が無いと、そのスキルを報告して失敗する", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", { "pstack/skills/noh1/SKILL.md": "---\nname: noh1\n---\n\n## Only H2\n\nSpawn one `Task`.\n" });
    sb.pin();
    sb.table(table(["`Task`"]));

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("pstack/skills/noh1/SKILL.md");
    expect(run.stderr).toContain("H1");
    expect(existsSync(sb.generated)).toBe(false);
  });
});

describe("検出する用語の一覧", () => {
  test("26項目あり、各項目を使うスキルが、表が空なら対応行のない用語として報告される", async () => {
    const sb = sandbox();
    const files: Record<string, string> = {};
    SAMPLES.forEach(({ text }, i) => {
      files[`pstack/skills/s${String(i).padStart(2, "0")}/SKILL.md`] = skillMd(`s${i}`, text);
    });
    sb.commit("0.15.46", files);
    sb.pin();

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    const missing = missingRows(run);
    expect([...missing.keys()]).toEqual(TERM_KEYS);
    expect(missing.get("/loop")).toEqual(["pstack/s23", "pstack/s24"]);
    expect(existsSync(sb.generated)).toBe(false);
  });

  test.each(SAMPLES)("$key を「$text」から検出し、表にその行だけ欠けると失敗する", async ({ key, text }) => {
    const sb = sandbox();
    sb.commit("0.15.46", { "pstack/skills/user/SKILL.md": skillMd("user", text) });
    sb.pin();
    sb.table(table(TERM_KEYS.filter((k) => k !== key)));

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(missingRows(run)).toEqual(new Map([[key, ["pstack/user"]]]));
  });

  test("似た書き方では検出せず、案内の1行も入れない", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", { "pstack/skills/lookalike/SKILL.md": skillMd("lookalike", LOOKALIKES.join("\n")) });
    sb.pin();

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readGenerated(sb, "pstack/skills/lookalike/SKILL.md")).toBe(skillMd("lookalike", LOOKALIKES.join("\n")));
  });

  test("参考の文書だけに用語があっても検出し、そのスキルの SKILL.md に案内の1行を入れる。参考の文書は上流のまま", async () => {
    const sb = sandbox();
    const playbook = "# Feature\n\nOpen it with `origin pr create`.\n";
    sb.commit("0.15.46", {
      "pstack/skills/mode/SKILL.md": skillMd("mode", "Pick a playbook."),
      "pstack/skills/mode/playbooks/feature.md": playbook,
    });
    sb.pin();

    const failed = await sb.sync();
    expect(failed.exitCode).toBe(1);
    expect(missingRows(failed)).toEqual(new Map([["origin pr", ["pstack/mode"]]]));

    sb.table(table(["origin pr"]));
    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readGenerated(sb, "pstack/skills/mode/SKILL.md")).toBe(
      `---\nname: mode\ndescription: test\n---\n\n# mode\n\n${GUIDE_LINE}\n\nPick a playbook.\n`,
    );
    expect(readGenerated(sb, "pstack/skills/mode/playbooks/feature.md")).toBe(playbook);
  });
});

describe("読み替え表の対応行", () => {
  test("用語が表の本文・ほかのセル・コードブロックに出てくるだけでは対応行とみなさない", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", { "pstack/skills/user/SKILL.md": skillMd("user", "Use generalPurpose here.") });
    sb.pin();
    sb.table(
      EMPTY_TABLE +
        "| `Task` | generalPurpose の代わりに task |\n" +
        "\nThe generalPurpose agent maps to task.\n\n" +
        "```md\n| generalPurpose | task |\n```\n",
    );

    const failed = await sb.sync();
    expect(failed.exitCode).toBe(1);
    expect(missingRows(failed)).toEqual(new Map([["generalPurpose", ["pstack/user"]]]));

    sb.table(EMPTY_TABLE + "| 子の種類 `generalPurpose` | task |\n");
    const run = await sb.sync();
    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
  });

  test("表のファイルが無いと失敗する", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin();
    sb.table(null);

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("skills/pstack-omp/SKILL.md");
    expect(existsSync(sb.generated)).toBe(false);
  });

  test("失敗しても前回の生成物を変えず、途中の生成物を残さない", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin();
    expect((await sb.sync()).exitCode).toBe(0);
    const before = snapshot(sb.generated);
    sb.commit("0.15.47", { "pstack/skills/user/SKILL.md": skillMd("user", "Spawn one `Task`.") });
    sb.pin();

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(missingRows(run)).toEqual(new Map([["`Task`", ["pstack/user"]]]));
    expect(snapshot(sb.generated)).toEqual(before);
    expect(readdirSync(join(sb.dataDir, "pstack-omp")).sort()).toEqual(["generated", "upstream"]);
  });

  test("表が示す写しの中のパス（<X>/generated/...）が生成物に無い、または生成物の外を指すと、そのパスを報告して失敗する", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", { "pstack/skills/no-comments/SKILL.md": skillMd("no-comments", "Spawn the reviewer.") });
    sb.pin();
    const paths =
      "\n定義は `<X>/generated/pstack/agents/comment-sicko.md`、版は `<X>/generated/manifest.json`、" +
      "スキルは `<X>/generated/pstack/skills/poteto-mode` にある（`<X>` は写しの根）。\n";
    sb.table(table(["comment-sicko"]) + paths + "古い定義は `<X>/upstream/pstack/agents/comment-sicko.md` にある。\n");

    const failed = await sb.sync();
    expect(failed.exitCode).toBe(1);
    const reported = failed.stderr.split("\n").filter((line) => line.startsWith("  "));
    expect(reported).toEqual(["  <X>/generated/pstack/agents/comment-sicko.md", "  <X>/upstream/pstack/agents/comment-sicko.md"]);
    expect(existsSync(sb.generated)).toBe(false);

    sb.commit("0.15.47", {
      "pstack/skills/no-comments/SKILL.md": skillMd("no-comments", "Spawn [the reviewer](../../agents/comment-sicko.md)."),
      "pstack/agents/comment-sicko.md": "---\nname: comment-sicko\n---\n\nReview comments.\n",
    });
    sb.pin();
    sb.table(table(["comment-sicko"]) + paths);
    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(existsSync(join(sb.generated, "pstack/agents/comment-sicko.md"))).toBe(true);
  });
});

describe("同じ入力から同じ出力になる", () => {
  test("別のデータ置き場に生成しても、もう一度生成しても、バイトと実行属性が同じ", async () => {
    const sb = sandbox();
    sb.commit(
      "0.15.46",
      {
        "pstack/skills/zeta/SKILL.md": skillMd("zeta", "Spawn one `Task`."),
        "pstack/skills/alpha/SKILL.md": skillMd("alpha", "Read [guide](../../docs/guide/README.md)."),
        "pstack/skills/alpha/scripts/go.sh": "#!/bin/sh\n",
        "pstack/docs/guide/README.md": "# Guide\n",
      },
      ["pstack/skills/alpha/scripts/go.sh"],
    );
    sb.pin();
    sb.table(table(["`Task`"]));
    const other = join(sb.root, "data-2");

    expect((await sb.sync()).exitCode).toBe(0);
    const first = snapshot(sb.generated);
    expect((await sb.sync()).exitCode).toBe(0);
    expect((await sb.sync(other)).exitCode).toBe(0);

    expect(snapshot(sb.generated)).toEqual(first);
    expect(snapshot(join(other, "pstack-omp", "generated"))).toEqual(first);
    expect(first.get("pstack/skills/alpha/scripts/go.sh")?.executable).toBe(true);
  });
});
