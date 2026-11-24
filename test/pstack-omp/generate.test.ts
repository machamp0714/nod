// pstack を OMP 向けに使う道具（scripts/pstack-omp/cli.ts）の同期（sync）のうち、取得に続く OMP 向けのコピーの生成（変換）を、
// プロセスとして起動して外から確かめる。一時の上流・置き場・変換の入力のディレクトリの作り方は helpers.ts を参照。
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_TRANSFORM, type Run, type Sandbox, sandbox, sha256, skillMd, skillNames, snapshot } from "./helpers";

function readGenerated(sb: { generated: string }, path: string): string {
  return readFileSync(join(sb.generated, path), "utf8");
}

// rules.yml の rules を書く（include は includes に YAML の行で渡す）
function rules(sb: Sandbox, items: Record<string, string>[], includes: string[] = []): void {
  const lines = ["rules:", ...(items.length === 0 ? ["  []"] : items.flatMap(yamlItem))];
  if (includes.length > 0) lines.push("include:", ...includes);
  sb.transform("rules.yml", `${lines.join("\n")}\n`);
}

function forks(sb: Sandbox, items: Record<string, string>[]): void {
  sb.transform("forks.yml", `${["forks:", ...(items.length === 0 ? ["  []"] : items.flatMap(yamlItem))].join("\n")}\n`);
}

// 1項目を YAML の行に（値は JSON の文字列。YAML の flow scalar として読める）
function yamlItem(item: Record<string, string>): string[] {
  return Object.entries(item).map(([key, value], i) => `${i === 0 ? "  - " : "    "}${key}: ${JSON.stringify(value)}`);
}

// 失敗の報告の、拒否リストの当たりの行（パス:行: 語）
function hits(run: Run): string[] {
  return run.stderr.split("\n").flatMap((line) => /^ {2}(\S+:\d+: .+)（一致: .*）$/.exec(line)?.[1] ?? []);
}

const SETUP = "pstack/skills/setup-pstack/SKILL.md";
const SETUP_UPSTREAM = skillMd("setup-pstack", "Write `claude-opus-5-5-high` into `~/.cursor/rules/pstack-models.mdc`.");
const SETUP_BODY = "---\nname: setup-pstack\ndescription: Not used in OMP.\n---\n\n# setup-pstack\n\nNot used in OMP. Spawn one worker only if asked.\n";

describe("生成の対象", () => {
  test("pstack の全スキルと cursor-team-kit の3つだけが、スキルとして読まれる形で生成され、上流の案内・ガイド・アダプター・自動化・上流の poteto-agent の定義は入れず、そこへのリンクは固定のコミットの上流の URL になる", async () => {
    const sb = sandbox();
    const links = "See [the README](../../README.md), [the guide](../../docs/guide/README.md), [the adapter](../../docs/harness/claude-code.md), [benny](../../automations/benny), and [the agent](../../agents/poteto-agent.md).";
    const commit = sb.commit("0.15.46", {
      "pstack/skills/setup-pstack/SKILL.md": skillMd("setup-pstack", "Set up."),
      "pstack/skills/tdd/SKILL.md": skillMd("tdd", `Red, green. ${links}`),
      "pstack/README.md": "# pstack\n",
      "pstack/agents/poteto-agent.md": "---\nname: poteto-agent\n---\n\nAgent.\n",
      "pstack/docs/guide/README.md": "# Guide\n",
      "pstack/docs/harness/claude-code.md": "# Claude Code\n",
      "pstack/automations/benny/README.md": "# Benny\n",
    });
    sb.pin();
    rules(sb, [{ id: "ref-upstream", reason: "上流の文書へのリンク", regex: "\\]\\(\\.\\./\\.\\./([^)]+)\\)", replace: "]({{upstream:pstack/$1}})" }]);

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`OMP 向けのコピーを生成しました: ${sb.generated}（pstack 3 個、cursor-team-kit 3 個）\n`);
    expect(skillNames(join(sb.generated, "pstack/skills"))).toEqual(["poteto-mode", "setup-pstack", "tdd"]);
    expect(readdirSync(join(sb.generated, "cursor-team-kit/skills")).sort()).toEqual(["control-cli", "control-ui", "deslop"]);
    expect(readdirSync(join(sb.generated, "pstack")).sort()).toEqual(["skills"]);
    expect(readdirSync(sb.generated).sort()).toEqual(["cursor-team-kit", "manifest.json", "pstack"]);
    const url = (kind: string, path: string) => `${sb.upstream}/${kind}/${commit}/pstack/${path}`;
    expect(readGenerated(sb, "pstack/skills/tdd/SKILL.md")).toBe(
      skillMd(
        "tdd",
        `Red, green. See [the README](${url("blob", "README.md")}), [the guide](${url("blob", "docs/guide/README.md")}), [the adapter](${url("blob", "docs/harness/claude-code.md")}), [benny](${url("tree", "automations/benny")}), and [the agent](${url("blob", "agents/poteto-agent.md")}).`,
      ),
    );
  });
});

describe("置換規則", () => {
  test("規則は上から順に、前の規則の出力に当たり、成功すると規則ごとの一致数が出る", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", {
      "pstack/skills/swarm/SKILL.md": skillMd("swarm", "Spawn one worker per slice.\nThen spawn one judge."),
      "pstack/skills/swarm/references/notes.md": "# Notes\n\nSpawn one worker per slice.\n",
    });
    sb.pin();
    rules(sb, [
      { id: "worker", reason: "子の起動を OMP の task に書き換える", literal: "Spawn one worker", replace: "Start one `task` worker" },
      { id: "task-worker", reason: "前の規則の出力に当たる", literal: "one `task` worker per slice", replace: "one `task` item per slice" },
    ]);

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readGenerated(sb, "pstack/skills/swarm/SKILL.md")).toBe(skillMd("swarm", "Start one `task` item per slice.\nThen spawn one judge."));
    expect(readGenerated(sb, "pstack/skills/swarm/references/notes.md")).toBe("# Notes\n\nStart one `task` item per slice.\n");
    expect(run.stdout).toContain("規則ごとの一致数:\n  worker: 2 か所\n  task-worker: 2 か所\n");
  });

  test("files で当てる生成物を限定でき、.md 以外のファイルには当てない", async () => {
    const sb = sandbox();
    const other = skillMd("b", "Spawn one worker.");
    const script = "#!/bin/sh\necho 'Spawn one worker.'\n";
    sb.commit(
      "0.15.46",
      {
        "pstack/skills/a/SKILL.md": skillMd("a", "Spawn one worker."),
        "pstack/skills/a/scripts/run.sh": script,
        "pstack/skills/b/SKILL.md": other,
      },
      ["pstack/skills/a/scripts/run.sh"],
    );
    sb.pin();
    rules(sb, [{ id: "only-a", reason: "a だけ", files: "^pstack/skills/a/", literal: "Spawn one worker", replace: "Start one task" }]);

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readGenerated(sb, "pstack/skills/a/SKILL.md")).toBe(skillMd("a", "Start one task."));
    expect(readGenerated(sb, "pstack/skills/b/SKILL.md")).toBe(other);
    expect(snapshot(sb.generated).get("pstack/skills/a/scripts/run.sh")).toEqual({ content: Buffer.from(script).toString("base64"), executable: true });
    expect(run.stdout).toContain("  only-a: 1 か所\n");
  });

  test("regex には flags と $1 などの置換記法を使え、literal の置換文はそのままの文字列になる", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", { "pstack/skills/a/SKILL.md": skillMd("a", "Open A Ledger first.\nopen a ledger later.") });
    sb.pin();
    rules(sb, [
      { id: "ledger", reason: "正規表現", regex: "open a (\\w+)", flags: "i", replace: "start the $1" },
      { id: "later", reason: "literal の $1 は置換記法にしない", literal: "later", replace: "at $1" },
    ]);

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readGenerated(sb, "pstack/skills/a/SKILL.md")).toBe(skillMd("a", "start the Ledger first.\nstart the ledger at $1."));
    expect(run.stdout).toContain("  ledger: 2 か所\n  later: 1 か所\n");
  });

  test("規則も全文差し替えも当たらないファイルは、付属のファイルの実行属性と UTF-8 でないバイトも含めて上流と完全に同じになる", async () => {
    const sb = sandbox();
    const files = {
      "pstack/skills/plain/SKILL.md": skillMd("plain", "See [the guide](https://example.com/guide) and [notes](references/notes.md#top)."),
      "pstack/skills/plain/references/notes.md": "# Notes\n\n[back](../SKILL.md)\n",
      "pstack/skills/plain/references/latin1.md": Buffer.from([0x23, 0x20, 0x43, 0x61, 0x66, 0xe9, 0x0a]),
      "pstack/skills/plain/scripts/run.sh": "#!/bin/sh\necho run\n",
      "pstack/skills/plain/data/table.tsv": "a\tb\n",
      "pstack/skills/other/SKILL.md": skillMd("other", "Spawn one worker."),
    };
    sb.commit("0.15.46", files, ["pstack/skills/plain/scripts/run.sh"]);
    sb.pin();
    rules(sb, [{ id: "worker", reason: "ほかのスキルにだけ当たる", literal: "Spawn one worker", replace: "Start one task" }]);

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    const generated = snapshot(sb.generated);
    const upstream = snapshot(sb.clone);
    for (const path of Object.keys(files).filter((path) => !path.startsWith("pstack/skills/other/"))) expect(generated.get(path)).toEqual(upstream.get(path)!);
    expect(generated.get("pstack/skills/plain/scripts/run.sh")?.executable).toBe(true);
    expect(generated.get("pstack/skills/plain/SKILL.md")?.executable).toBe(false);
    expect(generated.has("pstack/.cursor-plugin/plugin.json")).toBe(false);
  });

  test("どこにも一致しない規則があると、id と理由を報告して失敗し、生成先を作らない。対象の外でだけ一致する規則も一致しないとみなす", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", { "pstack/skills/a/SKILL.md": skillMd("a", "Spawn one worker.") });
    sb.pin();
    rules(sb, [
      { id: "hit", reason: "当たる", literal: "Spawn one worker", replace: "Start one task" },
      { id: "gone", reason: "上流から消えた文", literal: "Pick the judge", replace: "Choose the judge" },
      { id: "elsewhere", reason: "対象の外", files: "^cursor-team-kit/", literal: "Start one task", replace: "x" },
    ]);

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("どこにも一致しない規則があります");
    expect(run.stderr).toContain("  gone（上流から消えた文）\n  elsewhere（対象の外）\n");
    expect(run.stderr).not.toContain("  hit（");
    expect(existsSync(sb.generated)).toBe(false);
  });
});

// リポジトリの denylist.yml の各項目の、上流の実際の書き方の例（固定のコミットのスキルと、Claude Code 向けの adapter・上流の poteto-agent の定義から）。
// grok- と gpt- は固定のコミットの本文に無く、上流の道具の用語の一覧（generate-pstack-harness-trees.mjs の TERMS）の slug の形で書く
const DENIED: { term: string; text: string }[] = [
  { term: "`Task`", text: "If the Task tool rejects a slug, use the nearest valid slug." },
  { term: "`Task`", text: "**Defaults for every `Task` call.**" },
  { term: "AskQuestion", text: "If one exists, confirm intent with `AskQuestion`." },
  { term: "todolist", text: "Open a todolist with one entry per phase before launching anything." },
  { term: "todolist", text: "Copy its steps into the todolist tool first." },
  { term: "generalPurpose", text: "The entry is the parent model, so omit `model` and spawn `generalPurpose`." },
  { term: "`readonly: true`", text: "Spawn one subagent with `readonly: true` that explores and explains in one pass." },
  { term: "`readonly: true`", text: "After all Phase B candidates complete, spawn one readonly judge from the pool." },
  { term: "`readonly: true`", text: "Defaults: agent mode (readonly strips MCP), file pointers not inlined context." },
  { term: '`environment: "cloud"`', text: 'Spawn all N workers in one message with `environment: "cloud"`.' },
  { term: '`environment: "cloud"`', text: 'Use `environment: "local"` only when the worker needs access to local state.' },
  { term: "cloud_base_branch", text: "When a worker must start from a non-default pushed branch, pass `cloud_base_branch`." },
  { term: "`run_in_background: true`", text: "Spawn all N subagents in one message with `run_in_background: true`." },
  { term: "`resume`", text: "| `resume` | Spawn a new agent and paste the earlier context. |" },
  { term: "`file_attachments`", text: "| `file_attachments` | List the paths in the brief. |" },
  { term: "claude-", text: "Pick the runners, by default `claude-fable-5-2-high`." },
  { term: "grok-", text: "Pick `grok-4-fast` for the second opinion." },
  { term: "gpt-", text: "Pick `gpt-5-5-xhigh` for the reviewer." },
  { term: "gemini-", text: "One runner each on `gemini-4-neon-xhigh`." },
  { term: "inherit-parent", text: "A role set to `auto` or `inherit-parent` runs on the chat's model." },
  { term: "pstack-models.mdc", text: "Pick the runners from the `arena runners` line in `pstack-models.mdc`." },
  { term: ".cursor/skills/", text: "Write `.cursor/skills/verify-<app>/SKILL.md` with YAML frontmatter." },
  { term: "~/.cursor/plugins/", text: "Search `~/.cursor/plugins/` for a file whose path ends in the skill." },
  { term: "~/.cursor/plugins/", text: "Use the copy whose `.cursor-plugin/plugin.json` has the highest `version`." },
  { term: ".cursor/rules/", text: "| `.cursor/rules/*.mdc`, always-applied rules | `AGENTS.md` |" },
  { term: "agent-transcripts", text: "The system prompt names the workspace's `agent-transcripts/` directory." },
  { term: "agent-transcripts", text: "Don't glob across `~/.cursor/projects/*/`." },
  { term: "/loop", text: "Pick the wake mechanism using Cursor's `/loop` command." },
  { term: "/loop", text: "Keep a decision log. /loop until done." },
  { term: "subagent_type", text: '**Use `subagent_type: "poteto-agent"` for any subagent you spawn directly.**' },
  { term: "Project worker", text: "Starting any agent, whether a subagent or a Project worker." },
  { term: "Project worker", text: "An explicit model per role, Project workers included." },
  { term: "cloud agent", text: "One verifier per PR, each a Cursor cloud agent, runs the change." },
  { term: "cloud agent", text: "Locate a local transcript, a cloud-agent URL, or a pushed branch." },
  { term: "Cursor Automations", text: "Benny needs external configuration and two live Cursor automations." },
  { term: "Cursor Automations", text: "The URL looks like `https://api2.cursor.sh/automations/webhook/<id>` with no query string." },
  { term: "Cursor Automations", text: "Call `update_state` with target `routine` and action `create`." },
  { term: "Cursor Automations", text: "SendToUser" },
  { term: "built-in PR tool", text: "Open PRs ready, through the run's PR tool with `draft: false`." },
  { term: "built-in PR tool", text: "Claude Code has no built-in PR tool." },
  { term: "create-skill", text: "Use Cursor's built-in `create-skill` skill to author the skill." },
  { term: "create-skill", text: "Drafts or revises a personal -mode skill via create-skill + unslop." },
  { term: "Custom Mode", text: "Do the work under it, and mention once that a Custom Mode keeps it on." },
  { term: "Custom Mode", text: "Option+Enter on Mac or Alt+Enter on Windows, or Use as Mode from the skill entry, keeps it on." },
  { term: "Cursor's built-in skill", text: "PR status → the **Babysit** playbook, not Cursor's built-in babysit skill." },
  { term: "Cursor's built-in skill", text: 'A phrase such as "babysit this pr" can start Cursor\'s own skill for the same job instead.' },
];

// 拒否リストから外した語（OMP でも同じ意味で正しい）と、当たらない似た書き方。上流の実際の書き方の例
const ALLOWED = [
  "Spawn it as a `poteto-agent`, which defaults to Opus 5.5.",
  "Read the comment-sicko notes before reviewing.",
  "Use `origin pr create --status open` when Origin's CLI resolves the repository.",
  "Triage Bugbot skeptically: fix real findings, dismiss noise with a concrete disproof.",
  "Use this reference when the Babysit playbook handles Bugbot or review-automation comments.",
  "`/poteto-mode` copies the playbook's steps into the todo list.",
  "Edit src/foo/loop.ts and run the loop.",
  "Run the `/loop-on-ci` skill.",
  "Push with git push origin pr-123.",
  "A project worker in lower case.",
  "The task list and the subagent type.",
  "Use local browser automation to verify UI behavior.",
];

describe("拒否リスト", () => {
  test("リポジトリの denylist.yml の全項目に、上流の書き方の例がある", () => {
    const repo = Bun.YAML.parse(readFileSync(join(REPO_TRANSFORM, "denylist.yml"), "utf8")) as { terms: { term: string; reason: string }[] };
    expect([...new Set(DENIED.map(({ term }) => term))].sort()).toEqual(repo.terms.map(({ term }) => term).sort());
    expect(repo.terms.every(({ reason }) => reason.length > 0)).toBe(true);
  });

  test.each(DENIED)("$term が「$text」のまま残ると、ファイル・行・語を報告して失敗する", async ({ term, text }) => {
    const sb = sandbox();
    sb.commit("0.15.46", {
      "pstack/skills/user/SKILL.md": skillMd("user", "Plain."),
      "pstack/skills/user/references/notes.md": `# Notes\n\n${text}\n`,
    });
    sb.pin();

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect([...new Set(hits(run))]).toEqual([`pstack/skills/user/references/notes.md:3: ${term}`]);
    expect(existsSync(sb.generated)).toBe(false);
  });

  test("外した語（poteto-agent、comment-sicko、origin pr、Bugbot の名前だけ）と、一般の todo list・似た書き方では失敗しない", async () => {
    const sb = sandbox();
    const body = skillMd("allowed", ALLOWED.join("\n"));
    sb.commit("0.15.46", { "pstack/skills/allowed/SKILL.md": body });
    sb.pin();

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readGenerated(sb, "pstack/skills/allowed/SKILL.md")).toBe(body);
  });

  test("規則の後の文で検査するので、規則で書き換えた語では失敗しない。すべての当たりをファイル・行の順にまとめて報告する", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", {
      "pstack/skills/b/SKILL.md": skillMd("b", "Spawn one `Task` per worker.\nPick `gpt-5-5-xhigh`."),
      "pstack/skills/a/references/notes.md": "# Notes\n\nOpen a todolist.\n",
      "pstack/skills/a/SKILL.md": skillMd("a", "Spawn `generalPurpose` and `claude-opus-5-5-high`."),
    });
    sb.pin();
    rules(sb, [{ id: "task", reason: "Task を task に", literal: "Spawn one `Task` per worker.", replace: "Start one `task` item per worker." }]);

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(hits(run)).toEqual([
      "pstack/skills/a/SKILL.md:8: generalPurpose",
      "pstack/skills/a/SKILL.md:8: claude-",
      "pstack/skills/a/references/notes.md:3: todolist",
      "pstack/skills/b/SKILL.md:9: gpt-",
    ]);
    expect(run.stderr).toContain("変換の後に拒否リストの語が残っています（4 か所。");
    expect(run.stderr).toContain("pstack/skills/b/SKILL.md:9: gpt-（一致: gpt-5）");
  });
});

describe("全文差し替え", () => {
  test("指紋が合えば宣言した本文に差し替え（本文には規則を当てない）、成功の出力に一覧が出る", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", { [SETUP]: SETUP_UPSTREAM, "pstack/skills/a/SKILL.md": skillMd("a", "Spawn one worker.") });
    sb.pin();
    sb.transform("forks/pstack/skills/setup-pstack/SKILL.md", SETUP_BODY);
    forks(sb, [{ path: SETUP, upstreamSha256: sha256(SETUP_UPSTREAM), body: "forks/pstack/skills/setup-pstack/SKILL.md", reason: "OMP では使わない" }]);
    rules(sb, [{ id: "worker", reason: "差し替えの本文には当てない", literal: "Spawn one worker", replace: "Start one task" }]);

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readGenerated(sb, SETUP)).toBe(SETUP_BODY);
    expect(readGenerated(sb, "pstack/skills/a/SKILL.md")).toBe(skillMd("a", "Start one task."));
    expect(run.stdout).toContain(`  worker: 1 か所\n全文差し替え:\n  ${SETUP}（本文 forks/pstack/skills/setup-pstack/SKILL.md）\n`);
  });

  test("上流のファイルの指紋が宣言と違うと、両方の指紋を報告して失敗する", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", { [SETUP]: SETUP_UPSTREAM });
    sb.pin();
    sb.transform("forks/setup.md", SETUP_BODY);
    const declared = sha256("older upstream\n");
    forks(sb, [{ path: SETUP, upstreamSha256: declared, body: "forks/setup.md", reason: "OMP では使わない" }]);

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`  ${SETUP}: 上流のファイルの指紋 ${sha256(SETUP_UPSTREAM)} が宣言の upstreamSha256 ${declared} と違います。`);
    expect(existsSync(sb.generated)).toBe(false);
  });

  test("上流に元のファイルが無いと失敗する", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", { [SETUP]: SETUP_UPSTREAM });
    sb.remove(SETUP);
    sb.pin();
    sb.transform("forks/setup.md", SETUP_BODY);
    forks(sb, [{ path: SETUP, upstreamSha256: sha256(SETUP_UPSTREAM), body: "forks/setup.md", reason: "OMP では使わない" }]);

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`  ${SETUP}: 上流に元のファイルがありません。`);
    expect(existsSync(sb.generated)).toBe(false);
  });

  test("差し替えた本文も拒否リストで検査する", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", { [SETUP]: SETUP_UPSTREAM });
    sb.pin();
    sb.transform("forks/setup.md", `${SETUP_BODY}Pick \`gpt-5-5-xhigh\`.\n`);
    forks(sb, [{ path: SETUP, upstreamSha256: sha256(SETUP_UPSTREAM), body: "forks/setup.md", reason: "OMP では使わない" }]);

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(hits(run)).toEqual([`${SETUP}:9: gpt-`]);
    expect(existsSync(sb.generated)).toBe(false);
  });
});

describe("include", () => {
  test("宣言した上流の文書を生成物の宣言した位置に入れ、規則と拒否リストを当てる", async () => {
    const sb = sandbox();
    const sicko = "---\nname: comment-sicko\n---\n\nSpawn one `Task` per file.\n";
    sb.commit("0.15.46", {
      "pstack/skills/no-comments/SKILL.md": skillMd("no-comments", "Review comments."),
      "pstack/agents/comment-sicko.md": sicko,
      "pstack/agents/poteto-agent.md": "---\nname: poteto-agent\n---\n\nAgent.\n",
    });
    sb.pin();
    const include = ["  - from: pstack/agents/comment-sicko.md", "    to: pstack/skills/no-comments/references/comment-sicko.md", "    reason: no-comments の付属文書"];
    rules(sb, [], include);

    const failed = await sb.sync();
    expect(failed.exitCode).toBe(1);
    expect(hits(failed)).toEqual(["pstack/skills/no-comments/references/comment-sicko.md:5: `Task`"]);

    rules(
      sb,
      [{ id: "sicko", reason: "付属文書の子の起動", files: "^pstack/skills/no-comments/references/", literal: "Spawn one `Task`", replace: "Start one `task` item" }],
      include,
    );
    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readGenerated(sb, "pstack/skills/no-comments/references/comment-sicko.md")).toBe("---\nname: comment-sicko\n---\n\nStart one `task` item per file.\n");
    expect(existsSync(join(sb.generated, "pstack/agents"))).toBe(false);
  });

  test("上流に無い文書、既にある生成物と重なる位置は報告して失敗する", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", { "pstack/agents/comment-sicko.md": "Review.\n" });
    sb.pin();
    rules(
      sb,
      [],
      [
        "  - from: pstack/agents/gone.md",
        "    to: pstack/skills/poteto-mode/references/gone.md",
        "    reason: 消えた",
        "  - from: pstack/agents/comment-sicko.md",
        "    to: pstack/skills/poteto-mode/SKILL.md",
        "    reason: 重なる",
      ],
    );

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain("  pstack/agents/gone.md → pstack/skills/poteto-mode/references/gone.md: 上流に pstack/agents/gone.md がありません\n");
    expect(run.stderr).toContain("  pstack/agents/comment-sicko.md → pstack/skills/poteto-mode/SKILL.md: 生成物の pstack/skills/poteto-mode/SKILL.md が既にあります\n");
    expect(existsSync(sb.generated)).toBe(false);
  });
});

describe("参照の変換と検査", () => {
  test("置換文の {{upstream:<上流のパス>}} は、固定の記録のリポジトリ（末尾の .git と / を除く）とコミットの上流の URL になり、ファイルは blob、ディレクトリは tree になる", async () => {
    const sb = sandbox();
    const commit = sb.commit("0.15.46", {
      "pstack/skills/help/SKILL.md": skillMd("help", "The [README](../../README.md) and [the guide](../../docs/guide/) have the details."),
      "pstack/README.md": "# pstack\n",
      "pstack/docs/guide/01-setup.md": "# Setup\n",
    });
    sb.pin({ repository: join(sb.upstream, ".git") });
    rules(sb, [
      { id: "ref-readme", reason: "上流の案内", literal: "[README](../../README.md)", replace: "[README]({{upstream:pstack/README.md}})" },
      { id: "ref-guide", reason: "上流のガイド", literal: "[the guide](../../docs/guide/)", replace: "[the guide]({{upstream:pstack/docs/guide}})" },
    ]);

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readGenerated(sb, "pstack/skills/help/SKILL.md")).toBe(
      skillMd("help", `The [README](${sb.upstream}/blob/${commit}/pstack/README.md) and [the guide](${sb.upstream}/tree/${commit}/pstack/docs/guide) have the details.`),
    );
  });

  test("全文差し替えの本文の {{upstream:<上流のパス>}} も上流の URL になる", async () => {
    const sb = sandbox();
    const commit = sb.commit("0.15.46", { [SETUP]: SETUP_UPSTREAM, "pstack/README.md": "# pstack\n" });
    sb.pin();
    sb.transform("forks/setup.md", `${SETUP_BODY}See {{upstream:pstack/README.md}}.\n`);
    forks(sb, [{ path: SETUP, upstreamSha256: sha256(SETUP_UPSTREAM), body: "forks/setup.md", reason: "OMP では使わない" }]);

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readGenerated(sb, SETUP)).toBe(`${SETUP_BODY}See ${sb.upstream}/blob/${commit}/pstack/README.md.\n`);
  });

  test("固定のコミットの上流に無いパスや正規の形でないパスの {{upstream:...}} は、解決できない参照として報告して失敗し、前回の生成物を残す", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", { "pstack/skills/a/SKILL.md": skillMd("a", "Plain.") });
    sb.pin();
    expect((await sb.sync()).exitCode).toBe(0);
    const before = snapshot(sb.generated);
    rules(sb, [{ id: "ref-gone", reason: "上流に無い文書", literal: "Plain.", replace: "See {{upstream:pstack/docs/gone.md}} and {{upstream:../outside.md}}." }]);

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      "解決できない参照があります（2 か所。規則か全文差し替えの本文を直してください）:\n" +
        "  pstack/skills/a/SKILL.md:8: {{upstream:pstack/docs/gone.md}}（固定のコミットの上流にありません）\n" +
        "  pstack/skills/a/SKILL.md:8: {{upstream:../outside.md}}（上流の相対パスの正規の形ではありません）\n",
    );
    expect(snapshot(sb.generated)).toEqual(before);
  });

  // 静的な参照の先が生成物に無い書き方と、報告の理由。pstack/skills/a/SKILL.md の本文（8 行目から）に書く
  test.each([
    { label: "skill:// の名前が生成するスキルに無い", text: "Read `skill://nope` and follow it.", report: "8: skill://nope（生成するスキルにありません）" },
    { label: "skill:// のパスがそのスキルに無い", text: "Read `skill://b/references/gone.md`.", report: "8: skill://b/references/gone.md（スキル b の中にありません）" },
    {
      label: "skill:// のパスが .. を含む",
      text: "Read `skill://b/../a/SKILL.md`.",
      report: "8: skill://b/../a/SKILL.md（skill:// のパスが正規の形ではありません。OMP は skill:// の .. を辿りません）",
    },
    { label: "コードブロックの中の skill://", text: "```sh\ncat skill://nope/notes.md\n```", report: "9: skill://nope/notes.md（生成するスキルにありません）" },
    { label: "/skill: の名前が生成するスキルに無い", text: "Type `/skill:nope <ask>`.", report: "8: /skill:nope（生成するスキルにありません）" },
    {
      label: "相対リンクがスキルのディレクトリの外を指す",
      text: "Follow [b](../b/SKILL.md).",
      report: "8: ../b/SKILL.md（スキルのディレクトリ pstack/skills/a の外を指しています。OMP は skill:// の .. を辿りません）",
    },
    { label: "相対リンクの先が生成物に無い", text: "See [notes](references/gone.md#top).", report: "8: references/gone.md#top（生成物にありません）" },
  ])("$label と、解決できない参照として報告して失敗する", async ({ text, report }) => {
    const sb = sandbox();
    sb.commit("0.15.46", {
      "pstack/skills/a/SKILL.md": skillMd("a", text),
      "pstack/skills/b/SKILL.md": skillMd("b", "B."),
      "pstack/skills/b/references/notes.md": "# Notes\n",
    });
    sb.pin();

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`解決できない参照があります（1 か所。規則か全文差し替えの本文を直してください）:\n  pstack/skills/a/SKILL.md:${report}\n`);
    expect(existsSync(sb.generated)).toBe(false);
  });

  test("先が生成物にある静的な参照、利用者のプロジェクトで決まる動的な参照、外部へのリンク、コードの中の相対リンクでは失敗しない", async () => {
    const sb = sandbox();
    const body = [
      "Read `skill://b` and follow it. Read `skill://b/references/notes.md`, `skill://b/references/`, and `skill://deslop`.",
      'Run `"$(realpath skill://b)/scripts/run.sh"`.',
      "Type `/skill:b <ask>` or `/skill:deslop`.",
      "See [notes](references/notes.md#top), [the folder](references/), [self](./SKILL.md), and [top](#top).",
      "Write `skill://verify-<app>`, `/skill:verify-<app>`, `/skill:<handle>-mode`, `skill://{name}`, and [a feature](features/<feature>.md) in the project.",
      "See [the docs](https://example.com/docs) and [mail](mailto:a@example.com).",
      "Write `[parent](../../README.md)` in the project README.",
      "```md\n[parent](../../README.md)\n```",
      "Use /b when stuck.",
    ].join("\n");
    sb.commit(
      "0.15.46",
      {
        "pstack/skills/a/SKILL.md": skillMd("a", body),
        "pstack/skills/a/references/notes.md": "# Notes\n\n[back](../SKILL.md)\n",
        "pstack/skills/b/SKILL.md": skillMd("b", "B."),
        "pstack/skills/b/references/notes.md": "# Notes\n",
        "pstack/skills/b/scripts/run.sh": "#!/bin/sh\n",
      },
      ["pstack/skills/b/scripts/run.sh"],
    );
    sb.pin();

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readGenerated(sb, "pstack/skills/a/SKILL.md")).toBe(skillMd("a", body));
  });

  test("include した文書の参照も検査する", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", {
      "pstack/skills/no-comments/SKILL.md": skillMd("no-comments", "Review comments."),
      "pstack/agents/comment-sicko.md": "# Comment Sicko\n\nRun `/why` from the [why skill](../../why/SKILL.md).\n",
    });
    sb.pin();
    rules(sb, [], ["  - from: pstack/agents/comment-sicko.md", "    to: pstack/skills/no-comments/references/comment-sicko.md", "    reason: no-comments の付属文書"]);

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(
      "  pstack/skills/no-comments/references/comment-sicko.md:3: ../../why/SKILL.md（スキルのディレクトリ pstack/skills/no-comments の外を指しています。OMP は skill:// の .. を辿りません）\n",
    );
  });
});

describe("リポジトリの rules.yml の参照の規則", () => {
  test("代表的な規則と include を写した一時の変換で、仕様の形（read と skill://、/skill:、固定のコミットの上流の URL）になり、リポジトリの拒否リストと参照の検査を通る。文脈の分からない /<名前> と上流の案内は入らない", async () => {
    const repo = Bun.YAML.parse(readFileSync(join(REPO_TRANSFORM, "rules.yml"), "utf8")) as {
      rules: Record<string, string>[];
      include: { from: string; to: string; reason: string }[];
    };
    // 代表的な literal の規則の id と、その文を置く生成物のパス（規則の files に当たること）
    const picked: Record<string, string> = {
      "ref-comment-sicko-frontmatter": "pstack/skills/no-comments/references/comment-sicko.md",
      "ref-no-comments-delegate": "pstack/skills/no-comments/SKILL.md",
      "ref-poteto-help-readme": "pstack/skills/poteto-help/SKILL.md",
      "ref-create-verification-point-at-maintain": "pstack/skills/create-verification-skill/SKILL.md",
      "ref-ketchup-video-follow-ketchup": "pstack/skills/ketchup-video/SKILL.md",
      "ref-typescript-patterns": "pstack/skills/typescript-best-practices/SKILL.md",
    };
    const items = Object.entries(picked).map(([id, path]) => {
      const item = repo.rules.find((rule) => rule.id === id);
      expect(item?.literal).toBeString();
      expect(new RegExp(item!.files!).test(path)).toBe(true);
      return item!;
    });
    const literal = (id: string) => items.find((item) => item.id === id)!.literal!;
    const sicko = repo.include.find((item) => item.to === "pstack/skills/no-comments/references/comment-sicko.md")!;
    expect(sicko.from).toBe("pstack/agents/comment-sicko.md");
    const sb = sandbox();
    const commit = sb.commit("0.15.46", {
      [sicko.from]: `${literal("ref-comment-sicko-frontmatter")}# Comment Sicko\n\nReport only.\n`,
      "pstack/skills/no-comments/SKILL.md": skillMd("no-comments", `${literal("ref-no-comments-delegate")}\nAsk /poteto-mode later.`),
      "pstack/skills/poteto-help/SKILL.md": skillMd("poteto-help", `The ${literal("ref-poteto-help-readme")} has the details.`),
      "pstack/skills/create-verification-skill/SKILL.md": skillMd("create-verification-skill", `${literal("ref-create-verification-point-at-maintain")} for upkeep.`),
      "pstack/skills/maintain-verification-skill/SKILL.md": skillMd("maintain-verification-skill", "Keep the map honest."),
      "pstack/skills/ketchup-video/SKILL.md": skillMd("ketchup-video", `${literal("ref-ketchup-video-follow-ketchup")} show a video.`),
      "pstack/skills/ketchup/SKILL.md": skillMd("ketchup", "Catch up."),
      "pstack/skills/typescript-best-practices/SKILL.md": skillMd("typescript-best-practices", literal("ref-typescript-patterns")),
      "pstack/skills/typescript-best-practices/references/patterns.md": "# Patterns\n",
      "pstack/README.md": "# pstack\n",
      "pstack/docs/guide/README.md": "# Guide\n",
      "pstack/docs/harness/claude-code.md": "# Claude Code\n",
      "pstack/automations/benny/README.md": "# Benny\n",
      "pstack/agents/poteto-agent.md": "---\nname: poteto-agent\n---\n\nAgent.\n",
    });
    sb.pin();
    rules(sb, items, [`  - from: ${JSON.stringify(sicko.from)}`, `    to: ${JSON.stringify(sicko.to)}`, `    reason: ${JSON.stringify(sicko.reason)}`]);

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(readGenerated(sb, sicko.to)).toBe("# Comment Sicko\n\nReport only.\n");
    const noComments = readGenerated(sb, "pstack/skills/no-comments/SKILL.md");
    expect(noComments).toContain("Call the `task` tool with `agent` omitted");
    expect(noComments).toContain("`read` on `skill://no-comments/references/comment-sicko.md`");
    expect(noComments).toContain("\nAsk /poteto-mode later.\n");
    expect(readGenerated(sb, "pstack/skills/poteto-help/SKILL.md")).toContain(`The [README](${sb.upstream}/blob/${commit}/pstack/README.md) has the details.`);
    expect(readGenerated(sb, "pstack/skills/create-verification-skill/SKILL.md")).toContain("Point the user at `/skill:maintain-verification-skill` for upkeep.");
    expect(readGenerated(sb, "pstack/skills/ketchup-video/SKILL.md")).toContain("Read `skill://ketchup` with `read` and follow it");
    expect(readGenerated(sb, "pstack/skills/typescript-best-practices/SKILL.md")).toContain("`read` `skill://typescript-best-practices/references/patterns.md`");
    expect(readdirSync(join(sb.generated, "pstack")).sort()).toEqual(["skills"]);
  });
});

describe("リポジトリの rules.yml の Cursor 固有の手順の規則", () => {
  // 上流の babysit の、1回だけ状態を見るモードと既存の Bugbot のコメントの仕分けの行（固定のコミットの書き方）。どの規則も当てない
  const BABYSIT = [
    "### Babysit",
    "",
    "- Declare the mode in your first line, before any poll. Modes: `drive` loops to merge-ready, `threads-only` touches only review threads, `check` is one status pass and a report.",
    "- Triage Bugbot skeptically: fix real findings, dismiss noise with a concrete disproof, escalate billing, data, auth, and security.",
    "",
  ].join("\n");
  // 止まる文の4要素（対象外であること、始めずに止まること、どのスキルのどの手順で何の理由で止まったかの報告、子なら親への最終の返答）
  const STOP = [/is out of scope for this OMP setup/, /Do not start /, /Stop, and report that the .+ stopped at .+ because /, /If you are a subagent, put that report in your final reply to your parent\./];

  test("代表的な規則を写した一時の変換で、OMP の task・ask・todo の書き方、model を渡さない文、止まる文、OMP でスキルを作る置き場・名前・frontmatter・書いた後の確認、OMP の置き場になり、リポジトリの拒否リストと参照の検査を通る。babysit の1回だけのモードと Bugbot の仕分けは残る", async () => {
    const repo = Bun.YAML.parse(readFileSync(join(REPO_TRANSFORM, "rules.yml"), "utf8")) as { rules: Record<string, string>[] };
    // 代表的な literal の規則の id と、その文を置く生成物のパス（規則の files に当たること）
    const picked: [string, string][] = [
      ["task-how-explain", "pstack/skills/how/SKILL.md"],
      ["task-poteto-mode-defaults", "pstack/skills/poteto-mode/SKILL.md"],
      ["cursor-poteto-mode-babysit", "pstack/skills/poteto-mode/SKILL.md"],
      ["ask-automate-me-interview", "pstack/skills/automate-me/SKILL.md"],
      ["record-automate-me-transcripts", "pstack/skills/automate-me/SKILL.md"],
      ["authoring-automate-me-draft", "pstack/skills/automate-me/SKILL.md"],
      ["todo-arena-phases", "pstack/skills/arena/SKILL.md"],
      ["model-arena-runners", "pstack/skills/arena/SKILL.md"],
      ["stop-swarm-cloud", "pstack/skills/swarm/SKILL.md"],
      ["stop-shipping-verifiers", "pstack/skills/poteto-mode/playbooks/shipping.md"],
      ["stop-bug-fix-loop", "pstack/skills/poteto-mode/playbooks/bug-fix.md"],
      ["authoring-playbook-steps", "pstack/skills/poteto-mode/playbooks/authoring-a-skill.md"],
      ["help-cursor-only-steps", "pstack/skills/poteto-help/SKILL.md"],
      ["path-reflect-destination", "pstack/skills/reflect/SKILL.md"],
    ];
    const items = picked.map(([id, path]) => {
      const item = repo.rules.find((rule) => rule.id === id);
      expect(item?.literal).toBeString();
      expect(new RegExp(item!.files!).test(path)).toBe(true);
      return item!;
    });
    // 生成物のパスごとに、規則の literal を段落にして置く（SKILL.md は frontmatter つき）
    const bodies = new Map<string, string[]>();
    picked.forEach(([, path], i) => bodies.set(path, [...(bodies.get(path) ?? []), items[i]!.literal!]));
    // babysit と、置換文が名指す setup-pstack（/skill:setup-pstack の先）
    const files: Record<string, string> = {
      "pstack/skills/poteto-mode/playbooks/babysit.md": BABYSIT,
      [SETUP]: skillMd("setup-pstack", "Set up."),
    };
    for (const [path, literals] of bodies) {
      const name = /^pstack\/skills\/([^/]+)\/SKILL\.md$/.exec(path)?.[1];
      files[path] = name === undefined ? `${literals.join("\n\n")}\n` : skillMd(name, literals.join("\n\n"));
    }
    const sb = sandbox();
    sb.commit("0.15.46", files);
    sb.pin();
    rules(sb, items);

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    const out = (path: string) => readGenerated(sb, path);
    // task: { context, tasks } の1回の呼び出し、readonly は agent を省いて書き換えないよう頼み git status で確かめる、model と effort を渡さない
    const how = out("pstack/skills/how/SKILL.md");
    expect(how).toContain("`task` tool");
    expect(how).toContain("`agent` omitted");
    expect(how).toContain("`git status`");
    const potetoMode = out("pstack/skills/poteto-mode/SKILL.md");
    expect(potetoMode).toContain("`{ context, tasks: [...] }`");
    expect(potetoMode).toContain("Never pass `model` or `effort`");
    expect(potetoMode).toContain("`modelRoles`");
    expect(potetoMode).toContain("`~/.omp/agent/config.yml`");
    expect(potetoMode).toContain("Roles in `/model`");
    expect(potetoMode).toContain("a grandchild has no `task` tool");
    // PR の状態は babysit のプレイブックで見て、Cursor の組み込みの babysit を名指さない
    expect(potetoMode).toContain("`skill://poteto-mode/playbooks/babysit.md`");
    expect(potetoMode).not.toContain("Cursor's built-in babysit");
    // ask: html の1つの form、UI の無いセッションと子では最終の返答に書く
    const automateMe = out("pstack/skills/automate-me/SKILL.md");
    expect(automateMe).toContain("`ask` tool");
    expect(automateMe).toContain("`<form>`");
    expect(automateMe).toContain("final reply");
    // 記録の置き場: OMP のセッションの記録
    expect(automateMe).toContain("`~/.omp/agent/sessions/<encoded-cwd>/`");
    // スキルの作成: 置き場・名前・frontmatter・書いた後の確認
    for (const text of [
      "`.omp/skills/<handle>-mode/SKILL.md`",
      "`~/.omp/agent/skills/<handle>-mode/SKILL.md`",
      "Never save into pstack's generated copy",
      "the same as the directory name",
      "one non-empty YAML string",
      "`/skill:<handle>-mode`",
      "`disable-model-invocation: true`",
      "hides the skill from the model's skill list",
      "`omp skill list --json`",
      "`filePath`",
      "`hide: true`",
    ]) {
      expect(automateMe).toContain(text);
    }
    expect(automateMe).not.toContain("every turn");
    const authoring = out("pstack/skills/poteto-mode/playbooks/authoring-a-skill.md");
    for (const text of [
      "`.omp/skills/<name>/SKILL.md`",
      "`~/.omp/agent/skills/<name>/SKILL.md`",
      "Never save into pstack's generated copy",
      "the same as the directory name",
      "one non-empty YAML string",
      "parses as YAML",
      "`omp skill list --json`",
      "`filePath`",
      "`hide`",
    ]) {
      expect(authoring).toContain(text);
    }
    // todo: init と list、子には todo が無い
    const arena = out("pstack/skills/arena/SKILL.md");
    expect(arena).toContain('`todo` tool with `op: "init"`');
    expect(arena).toContain("A subagent has no `todo` tool");
    // 座席はスキルの数のまま、どの座席も OMP の設定のモデルで動くと返答に書く
    expect(arena).toContain("every seat ran on the model OMP's settings gave it");
    // 使わない範囲: 止まる文の4要素。OMP に無いとは断言しない
    for (const path of ["pstack/skills/swarm/SKILL.md", "pstack/skills/poteto-mode/playbooks/shipping.md", "pstack/skills/poteto-mode/playbooks/bug-fix.md"]) {
      for (const element of STOP) expect(out(path)).toMatch(element);
      expect(out(path)).not.toMatch(/OMP (?:has no|does not have|lacks)/);
    }
    expect(out("pstack/skills/poteto-help/SKILL.md")).toContain("starting or waiting for Bugbot");
    expect(out("pstack/skills/reflect/SKILL.md")).toContain("`.omp/skills/<skill>/`");
    expect(out("pstack/skills/reflect/SKILL.md")).toContain("`~/.omp/agent/skills/<skill>/`");
    // 規則の当たらない babysit は上流のまま
    expect(out("pstack/skills/poteto-mode/playbooks/babysit.md")).toBe(BABYSIT);
  });
});

describe("リポジトリの forks.yml の setup-pstack", () => {
  // リポジトリの forks.yml の setup-pstack の宣言（path・upstreamSha256・body・reason）
  function declared(): Record<string, string> {
    const repo = Bun.YAML.parse(readFileSync(join(REPO_TRANSFORM, "forks.yml"), "utf8")) as { forks: Record<string, string>[] };
    const fork = repo.forks.find((item) => item.path === SETUP);
    expect(fork).toBeDefined();
    expect(fork!.upstreamSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fork!.reason).toBeString();
    return fork!;
  }

  // 一時の上流に files を置き、リポジトリの全文差し替えの本文を写した sandbox。宣言は over で差し替える
  function forked(files: Record<string, string>, over: Record<string, string> = {}): Sandbox {
    const fork = declared();
    const sb = sandbox();
    sb.commit("0.15.46", files);
    sb.pin();
    sb.transform(fork.body!, readFileSync(join(REPO_TRANSFORM, fork.body!)));
    forks(sb, [{ ...fork, ...over }]);
    return sb;
  }

  test("宣言した本文に差し替え、リポジトリの拒否リストと参照の検査を通り、一覧に出る。本文は OMP では使わないこと・モデルは OMP の設定で決まること・実行を求められたら実行せずそう答えることを示す", async () => {
    const fork = declared();
    const sb = forked({ [SETUP]: SETUP_UPSTREAM }, { upstreamSha256: sha256(SETUP_UPSTREAM) });

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain(`全文差し替え:\n  ${SETUP}（本文 ${fork.body}）\n`);
    const body = readGenerated(sb, SETUP);
    expect(body).toBe(readFileSync(join(REPO_TRANSFORM, fork.body!), "utf8"));
    // OMP がスキルとして読む frontmatter（name と、OMP では使わないことが分かる description）
    const front = Bun.YAML.parse(/^---\n([\s\S]*?)\n---\n/.exec(body)![1]!) as Record<string, unknown>;
    expect(front.name).toBe("setup-pstack");
    expect(front.description).toContain("Not used in this OMP setup");
    expect(body).toContain("`modelRoles`");
    expect(body).toContain("agent definition");
    expect(body).toContain("Do not run any setup step");
    expect(body).toContain("`~/.omp/agent/config.yml`");
  });

  test("上流の setup-pstack の指紋が宣言と違うと、宣言の指紋を報告して失敗する", async () => {
    const fork = declared();
    const sb = forked({ [SETUP]: SETUP_UPSTREAM });

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`  ${SETUP}: 上流のファイルの指紋 ${sha256(SETUP_UPSTREAM)} が宣言の upstreamSha256 ${fork.upstreamSha256} と違います。`);
    expect(existsSync(sb.generated)).toBe(false);
  });

  test("上流に setup-pstack が無いと失敗する", async () => {
    const sb = forked({}, { upstreamSha256: sha256(SETUP_UPSTREAM) });

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`  ${SETUP}: 上流に元のファイルがありません。`);
    expect(existsSync(sb.generated)).toBe(false);
  });
});

describe("失敗の報告と前回の生成物", () => {
  test("複数の失敗の理由をまとめて報告し、0 でない終了コードで終わり、前回の生成物と利用者の設定を変えず、途中の生成物を残さない", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", { [SETUP]: SETUP_UPSTREAM, "pstack/skills/a/SKILL.md": skillMd("a", "Plain.") });
    sb.pin();
    sb.transform("forks/setup.md", SETUP_BODY);
    forks(sb, [{ path: SETUP, upstreamSha256: sha256(SETUP_UPSTREAM), body: "forks/setup.md", reason: "OMP では使わない" }]);
    expect((await sb.sync()).exitCode).toBe(0);
    const before = snapshot(sb.generated);
    sb.commit("0.15.47", { [SETUP]: `${SETUP_UPSTREAM}Changed.\n`, "pstack/skills/a/SKILL.md": skillMd("a", "Open a todolist.") });
    sb.pin();
    rules(sb, [{ id: "gone", reason: "消えた文", literal: "Pick the judge", replace: "Choose the judge" }], ["  - from: pstack/gone.md", "    to: pstack/skills/a/gone.md", "    reason: 消えた"]);

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stdout).not.toContain("生成しました");
    expect(run.stderr).toStartWith(`止めました: OMP 向けのコピーを生成できません。生成先 ${sb.generated} と利用者の OMP の設定は変えていません。\n`);
    for (const title of [
      "上流から入れる文書（rules.yml の include）に問題があります:\n  pstack/gone.md → pstack/skills/a/gone.md: 上流に pstack/gone.md がありません\n",
      `全文差し替え（forks.yml）に問題があります:\n  ${SETUP}: 上流のファイルの指紋 `,
      "どこにも一致しない規則があります（上流の文が変わっていないか確かめ、規則を直してください）:\n  gone（消えた文）\n",
      "変換の後に拒否リストの語が残っています（1 か所。規則で書き換えてください）:\n  pstack/skills/a/SKILL.md:8: todolist（一致: todolist）\n",
      "検査できなかった範囲:\n  入れられなかった include の文書には、規則と拒否リストを当てていません\n",
    ]) {
      expect(run.stderr).toContain(title);
    }
    expect(snapshot(sb.generated)).toEqual(before);
    expect(readdirSync(join(sb.dataDir, "pstack-omp")).sort()).toEqual(["generated", "upstream"]);
    expect(existsSync(sb.agentDir)).toBe(false);
  });

  // 変換の入力が正しくないとき。報告する理由と、そのために検査できなかった範囲
  test.each([
    { label: "rules.yml が YAML として読めない", file: "rules.yml", text: "rules: [\n", reports: ["rules.yml: YAML として読めません", "rules.yml を読めないので、規則を当てず"] },
    { label: "rules.yml が無い", file: "rules.yml", text: null, reports: ["rules.yml: 読めません", "rules.yml を読めないので、include の文書を生成物に入れていません"] },
    {
      label: "規則に必須の項目が無い",
      file: "rules.yml",
      text: 'rules:\n  - id: a\n    literal: "x"\n    replace: "y"\n',
      reports: ["rules.yml の rules の 1 番目（id: a）: reason がありません", "rules.yml の規則が正しくないので、規則を当てず"],
    },
    {
      label: "literal と regex の両方がある",
      file: "rules.yml",
      text: 'rules:\n  - id: a\n    reason: r\n    literal: "x"\n    regex: "x"\n    replace: "y"\n',
      reports: ["rules.yml の rules の 1 番目（id: a）: literal と regex のどちらか1つだけを書いてください"],
    },
    {
      label: "literal も regex も無い",
      file: "rules.yml",
      text: 'rules:\n  - id: a\n    reason: r\n    replace: "y"\n',
      reports: ["rules.yml の rules の 1 番目（id: a）: literal と regex のどちらか1つだけを書いてください"],
    },
    {
      label: "正規表現が正しくない",
      file: "rules.yml",
      text: 'rules:\n  - id: a\n    reason: r\n    regex: "("\n    replace: "y"\n',
      reports: ["rules.yml の rules の 1 番目（id: a）: regex が正規表現として正しくありません"],
    },
    {
      label: "id が重複している",
      file: "rules.yml",
      text: 'rules:\n  - id: a\n    reason: r\n    literal: "x"\n    replace: "y"\n  - id: a\n    reason: r\n    literal: "z"\n    replace: "y"\n',
      reports: ["rules.yml の rules の 2 番目（id: a）: id a が重複しています"],
    },
    {
      label: "知らない項目がある",
      file: "rules.yml",
      text: 'rules:\n  - id: a\n    reason: r\n    regexp: "x"\n    replace: "y"\n',
      reports: ["rules.yml の rules の 1 番目（id: a）: 知らない項目 regexp があります"],
    },
    {
      label: "拒否リストの正規表現が正しくない",
      file: "denylist.yml",
      text: 'terms:\n  - term: bad\n    regex: "["\n    reason: r\n',
      reports: ["denylist.yml の terms の 1 番目（term: bad）: regex が正規表現として正しくありません", "denylist.yml の正しくない項目（bad）の語は検査していません"],
    },
    {
      label: "拒否リストの terms が無い",
      file: "denylist.yml",
      text: "words: []\n",
      reports: ["denylist.yml: 知らない項目 words があります", "denylist.yml: terms がありません", "denylist.yml を読めないので、変換の後の拒否リストの検査はしていません"],
    },
    {
      label: "全文差し替えの本文が読めない",
      file: "forks.yml",
      text: `forks:\n  - path: ${SETUP}\n    upstreamSha256: ${sha256(SETUP_UPSTREAM)}\n    body: forks/missing.md\n    reason: r\n`,
      reports: [`forks.yml の forks の 1 番目（path: ${SETUP}）: 本文 forks/missing.md を読めません`, `${SETUP}: 全文差し替えの本文を使えないので、このファイルの拒否リストと参照の検査はしていません`],
    },
    {
      label: "全文差し替えの path が無い",
      file: "forks.yml",
      text: "forks:\n  - body: forks/setup.md\n    reason: r\n",
      reports: ["forks.yml の forks の 1 番目: path がありません", "forks.yml の path が正しくない項目: 全文差し替えの宣言を読めないので"],
    },
  ])("$label: 理由と検査できなかった範囲を報告して失敗し、前回の生成物を変えない", async ({ file, text, reports }) => {
    const sb = sandbox();
    sb.commit("0.15.46", { [SETUP]: SETUP_UPSTREAM });
    sb.pin();
    sb.transform("forks/setup.md", SETUP_BODY);
    forks(sb, [{ path: SETUP, upstreamSha256: sha256(SETUP_UPSTREAM), body: "forks/setup.md", reason: "OMP では使わない" }]);
    expect((await sb.sync()).exitCode).toBe(0);
    const before = snapshot(sb.generated);
    sb.transform(file, text);

    const run = await sb.sync();

    expect(run.exitCode).toBe(1);
    expect(run.stderr).toContain(`変換の入力（${sb.transformDir}）が正しくありません:\n`);
    for (const report of reports) expect(run.stderr).toContain(report);
    expect(snapshot(sb.generated)).toEqual(before);
  });
});

describe("成功したときの生成先と manifest", () => {
  test("生成先を丸ごと入れ替え、manifest に固定の記録・生成したスキル・変換の入力の指紋・規則ごとの一致数・全文差し替えを書く", async () => {
    const sb = sandbox();
    sb.commit("0.15.46", { "pstack/skills/old/SKILL.md": skillMd("old", "Old.") });
    sb.pin();
    expect((await sb.sync()).exitCode).toBe(0);
    sb.remove("pstack/skills/old/SKILL.md");
    const commit = sb.commit("0.15.47", { [SETUP]: SETUP_UPSTREAM, "pstack/skills/a/SKILL.md": skillMd("a", "Spawn one worker.") });
    sb.pin();
    sb.transform("forks/setup.md", SETUP_BODY);
    forks(sb, [{ path: SETUP, upstreamSha256: sha256(SETUP_UPSTREAM), body: "forks/setup.md", reason: "OMP では使わない" }]);
    rules(sb, [{ id: "worker", reason: "子の起動", literal: "Spawn one worker", replace: "Start one task" }]);

    const run = await sb.sync();

    expect(run.stderr).toBe("");
    expect(run.exitCode).toBe(0);
    expect(existsSync(join(sb.generated, "pstack/skills/old"))).toBe(false);
    expect(run.stdout).toContain("規則ごとの一致数:\n  worker: 1 か所\n全文差し替え:\n  pstack/skills/setup-pstack/SKILL.md（本文 forks/setup.md）\n");
    const input = (path: string) => sha256(readFileSync(join(sb.transformDir, path)));
    expect(readGenerated(sb, "manifest.json")).toBe(
      JSON.stringify(
        {
          pin: { repository: sb.upstream, commit, pstackVersion: "0.15.47", ompVersion: "19.1.0" },
          skills: { pstack: ["a", "poteto-mode", "setup-pstack"], "cursor-team-kit": ["control-cli", "control-ui", "deslop"] },
          transform: { "rules.yml": input("rules.yml"), "denylist.yml": input("denylist.yml"), "forks.yml": input("forks.yml") },
          rules: [{ id: "worker", matches: 1 }],
          forks: [{ path: SETUP, upstreamSha256: sha256(SETUP_UPSTREAM), body: "forks/setup.md", bodySha256: sha256(SETUP_BODY) }],
        },
        null,
        2,
      ) + "\n",
    );
  });

  test("規則も全文差し替えも無ければ、そう表示する", async () => {
    const sb = sandbox();
    sb.commit("0.15.46");
    sb.pin();

    const run = await sb.sync();

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("規則ごとの一致数: 規則はありません\n全文差し替え: ありません\n");
  });
});

describe("同じ入力から同じ出力になる", () => {
  test("別のデータ置き場に生成しても、もう一度生成しても、バイトと実行属性が同じ", async () => {
    const sb = sandbox();
    sb.commit(
      "0.15.46",
      {
        [SETUP]: SETUP_UPSTREAM,
        "pstack/skills/zeta/SKILL.md": skillMd("zeta", "Spawn one worker."),
        "pstack/skills/alpha/SKILL.md": skillMd("alpha", "Read the notes."),
        "pstack/skills/alpha/scripts/go.sh": "#!/bin/sh\n",
        "pstack/agents/comment-sicko.md": "Spawn one worker per file.\n",
      },
      ["pstack/skills/alpha/scripts/go.sh"],
    );
    sb.pin();
    sb.transform("forks/setup.md", SETUP_BODY);
    forks(sb, [{ path: SETUP, upstreamSha256: sha256(SETUP_UPSTREAM), body: "forks/setup.md", reason: "OMP では使わない" }]);
    rules(
      sb,
      [{ id: "worker", reason: "子の起動", regex: "Spawn one (\\w+)", replace: "Start one $1" }],
      ["  - from: pstack/agents/comment-sicko.md", "    to: pstack/skills/alpha/references/comment-sicko.md", "    reason: 付属文書"],
    );
    const other = join(sb.root, "data-2");

    expect((await sb.sync()).exitCode).toBe(0);
    const first = snapshot(sb.generated);
    expect((await sb.sync()).exitCode).toBe(0);
    expect((await sb.sync(other)).exitCode).toBe(0);

    expect(snapshot(sb.generated)).toEqual(first);
    expect(snapshot(join(other, "pstack-omp", "generated"))).toEqual(first);
    expect(first.get("pstack/skills/alpha/scripts/go.sh")?.executable).toBe(true);
    expect(readGenerated(sb, "pstack/skills/alpha/references/comment-sicko.md")).toBe("Start one worker per file.\n");
  });
});
