import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { buildProgram } from "../src/main";
import { git, makeRepo, tempDir } from "./helpers";

// Studio から Air の nod を SSH で呼ぶラッパーの候補。
// 本物の ssh・rsync・Air の nod の代わりに偽物を PATH と HOME に置き、本番の DB やネットワークには触れない。
// 偽の ssh は受け取ったリモートのコマンドを手元の bash で実行し、偽の nod が受け取った引数・cwd・環境変数・標準入力を記録する。
const WRAPPER = join(import.meta.dir, "../../../scripts/nod-ssh-wrapper.sh");

const FAKE_SSH = `#!/bin/bash
echo call >> "$HOME/ssh-calls"
printf '%s\\0' "$@" > "$HOME/ssh-argv"
exec /bin/bash -c "\${!#}"
`;

const FAKE_RSYNC = `#!/bin/bash
echo call >> "$HOME/rsync-calls"
exit 1
`;

const FAKE_NOD = `#!/bin/bash
out=$HOME/nod-call
mkdir -p "$out"
printf '%s\\0' "$@" > "$out/argv"
pwd -P > "$out/cwd"
for v in NOD_WORKTREE NOD_BRANCH NOD_ORCA NOD_ACTOR; do
  if [[ -n \${!v+x} ]]; then printf '%s' "\${!v}" > "$out/$v"; fi
done
cat > "$out/stdin"
`;

interface Sandbox {
  home: string;
  bin: string;
  docs: string;
}

function sandbox(): Sandbox {
  const home = tempDir("nod-ssh-home-");
  const bin = join(home, "fake-bin");
  mkdirSync(bin);
  mkdirSync(join(home, ".local", "bin"), { recursive: true });
  writeFileSync(join(bin, "ssh"), FAKE_SSH, { mode: 0o755 });
  writeFileSync(join(bin, "rsync"), FAKE_RSYNC, { mode: 0o755 });
  writeFileSync(join(home, ".local", "bin", "nod"), FAKE_NOD, { mode: 0o755 });
  return { home, bin, docs: join(home, ".local", "share", "nod", "documents") };
}

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

interface NodCall {
  argv: string[];
  cwd: string;
  worktree?: string;
  branch?: string;
  orca?: string;
  actor?: string;
  stdin?: string;
}

interface WrapperResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  sshCalls: number;
  sshArgv: string[];
  rsyncCalls: number;
  // Air の nod が呼ばれなければ null
  nod: NodCall | null;
}

async function runWrapper(
  sb: Sandbox,
  args: string[],
  opts: { cwd: string; stdin?: string; env?: Record<string, string> },
): Promise<WrapperResult> {
  const out = join(sb.home, "nod-call");
  for (const record of ["ssh-calls", "ssh-argv", "rsync-calls", "nod-call"]) rmSync(join(sb.home, record), { recursive: true, force: true });
  // 呼び出し元の nod・git の設定を持ち込まない。HOME は偽の nod と Documents を置いた一時ディレクトリにする
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith("NOD_") && !k.startsWith("GIT_") && !["CLAUDECODE", "OMPCODE", "CODEX_THREAD_ID"].includes(k)) env[k] = v;
  }
  Object.assign(env, { HOME: sb.home, PATH: `${sb.bin}:${process.env.PATH}` }, opts.env);
  const proc = Bun.spawn(["/bin/bash", WRAPPER, ...args], {
    cwd: opts.cwd,
    env,
    stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const nodArgv = readIfExists(join(out, "argv"));
  return {
    exitCode,
    stdout,
    stderr,
    sshCalls: (readIfExists(join(sb.home, "ssh-calls")) ?? "").split("\n").filter(Boolean).length,
    sshArgv: (readIfExists(join(sb.home, "ssh-argv")) ?? "").split("\0").slice(0, -1),
    rsyncCalls: (readIfExists(join(sb.home, "rsync-calls")) ?? "").split("\n").filter(Boolean).length,
    nod:
      nodArgv === undefined
        ? null
        : {
            argv: nodArgv.split("\0").slice(0, -1),
            cwd: (readIfExists(join(out, "cwd")) ?? "").trim(),
            worktree: readIfExists(join(out, "NOD_WORKTREE")),
            branch: readIfExists(join(out, "NOD_BRANCH")),
            orca: readIfExists(join(out, "NOD_ORCA")),
            actor: readIfExists(join(out, "NOD_ACTOR")),
            stdin: readIfExists(join(out, "stdin")),
          },
  };
}

// Air の nod へ引数を変えずに1回だけ SSH で渡し、ファイルを転送していない
function expectPassedThrough(r: WrapperResult, args: string[]): void {
  expect(r.stderr).toBe("");
  expect(r.exitCode).toBe(0);
  expect(r.sshCalls).toBe(1);
  expect(r.sshArgv.slice(0, 3)).toEqual(["-o", "BatchMode=yes", "air"]);
  expect(r.sshArgv).toHaveLength(4);
  expect(r.rsyncCalls).toBe(0);
  expect(r.nod?.argv).toEqual(args);
}

// SSH を呼ばずに止め、理由を出している
function expectRejected(r: WrapperResult): void {
  expect(r.exitCode).toBe(1);
  expect(r.sshCalls).toBe(0);
  expect(r.rsyncCalls).toBe(0);
  expect(r.nod).toBeNull();
  expect(r.stderr).toContain("エラー（LOCAL_PATH_REJECTED）");
}

describe("実行元の受け渡し", () => {
  test("空白を含む worktree から呼ぶと、本体のリポジトリで worktree とブランチを渡し、Orca を止める", async () => {
    const sb = sandbox();
    const repo = makeRepo();
    const wt = join(tempDir("nod-wt-"), "my work tree");
    git(repo, "worktree", "add", "-q", "-b", "feat/space", wt);
    const args = ["issue", "start", "NOD-1", "--json"];

    const r = await runWrapper(sb, args, { cwd: wt });

    expectPassedThrough(r, args);
    expect(r.nod?.cwd).toBe(repo);
    expect(r.nod?.worktree).toBe(wt);
    expect(r.nod?.branch).toBe("feat/space");
    expect(r.nod?.orca).toBe("0");
    expect(r.nod?.actor).toBeUndefined();
  });

  test("detached HEAD の worktree では NOD_BRANCH を HEAD にする（nod はブランチなしとして記録する）", async () => {
    const sb = sandbox();
    const repo = makeRepo();
    const wt = join(tempDir("nod-wt-"), "detached");
    git(repo, "worktree", "add", "-q", "--detach", wt);

    const r = await runWrapper(sb, ["issue", "next"], { cwd: wt });

    expectPassedThrough(r, ["issue", "next"]);
    expect(r.nod?.cwd).toBe(repo);
    expect(r.nod?.worktree).toBe(wt);
    expect(r.nod?.branch).toBe("HEAD");
  });

  test("git リポジトリの外から呼ぶと、従来どおり Air のホームで実行し、実行元は空で渡す", async () => {
    const sb = sandbox();
    const outside = tempDir("nod-outside-");

    const r = await runWrapper(sb, ["workspace", "list"], { cwd: outside });

    expectPassedThrough(r, ["workspace", "list"]);
    expect(r.nod?.cwd).toBe(sb.home);
    expect(r.nod?.worktree).toBe("");
    expect(r.nod?.branch).toBe("");
    expect(r.nod?.orca).toBe("0");
  });

  const actorCases: { env: Record<string, string>; actor: string | undefined }[] = [
    { env: { NOD_ACTOR: "me", OMPCODE: "1", CLAUDECODE: "1", CODEX_THREAD_ID: "thread" }, actor: "me" },
    { env: { OMPCODE: "1", CLAUDECODE: "1", CODEX_THREAD_ID: "thread" }, actor: "omp" },
    { env: { CLAUDECODE: "1", CODEX_THREAD_ID: "thread" }, actor: "claude-code" },
    { env: { CODEX_THREAD_ID: "thread" }, actor: "codex" },
    { env: {}, actor: undefined },
  ];
  for (const { env, actor } of actorCases) test(`実行元の書き手を優先順で判定して渡す: ${actor ?? "未指定"}`, async () => {
    const sb = sandbox();
    const repo = makeRepo();
    const r = await runWrapper(sb, ["issue", "list"], { cwd: repo, env });
    expectPassedThrough(r, ["issue", "list"]);
    expect(r.nod?.actor).toBe(actor);
  });
});

describe("ファイル入力でない値", () => {
  test("手元のファイルと同じ名前のタイトルや本文、PR 内のパス、作成先は書き換えずに渡す", async () => {
    const sb = sandbox();
    const repo = makeRepo();
    writeFileSync(join(repo, "notes.md"), "# 手元のメモ\n");
    const cases = [
      ["issue", "create", "notes.md", "-d", "notes.md"],
      ["issue", "log", "NOD-1", "notes.md"],
      ["issue", "pr-diff", "NOD-1", "--file", "notes.md"],
      ["issue", "pr-diff", "NOD-1", "--file=notes.md"],
      ["doc", "create", "notes.md", "--title", "notes.md"],
      ["issue", "doc", "add", "NOD-1", join(sb.docs, "specs", "a.md"), "--title", "notes.md"],
      ["stats", "--from", "2026-01-01"],
      ["-w", "NOD", "issue", "list"],
      ["--workspace", repo, "issue", "list"],
    ];
    for (const args of cases) {
      const r = await runWrapper(sb, args, { cwd: repo });
      expectPassedThrough(r, args);
      expect(r.nod?.cwd).toBe(repo);
    }
  });
});

describe("Air の Documents の絶対パス", () => {
  test("nod doc create が返す Documents ディレクトリの絶対パスは、手元に同名の写しがあっても転送せずそのまま渡す", async () => {
    const sb = sandbox();
    const repo = makeRepo();
    const doc = join(sb.docs, "plans", "example.md");
    mkdirSync(join(sb.docs, "plans"), { recursive: true });
    writeFileSync(doc, "# Studio の写し\n");
    const cases = [
      ["issue", "doc", "add", "NOD-1", doc],
      ["project", "doc", "remove", "nod", doc],
      ["issue", "plan", "NOD-1", "--from", doc],
      ["issue", "plan", "NOD-1", `--from=${doc}`],
      ["template", "add", "bug", "--from", doc],
      ["workspace", "rules", "set", "--from", doc],
      ["issue", "publish", "NOD-1", "--body-file", doc],
      ["sprint", "create", "--input", doc],
    ];
    for (const args of cases) {
      const r = await runWrapper(sb, args, { cwd: repo });
      expectPassedThrough(r, args);
    }
  });
});

describe("手元のファイル入力の拒否", () => {
  test("相対パス・絶対パス・等号の形・-- の後ろのファイル入力は SSH を呼ばずに止め、代わりの方法を示す", async () => {
    const sb = sandbox();
    const repo = makeRepo();
    writeFileSync(join(repo, "notes.md"), "# 手元のメモ\n");
    const cases: { args: string[]; hint: string }[] = [
      { args: ["issue", "doc", "add", "NOD-1", "notes.md"], hint: "--body - --issue" },
      { args: ["issue", "doc", "add", "NOD-1", "missing.md"], hint: "--body - --issue" },
      { args: ["issue", "doc", "add", "NOD-1", join(repo, "notes.md")], hint: "--body - --issue" },
      { args: ["issue", "doc", "add", "--title", "t", "--", "NOD-1", "notes.md"], hint: "--body - --issue" },
      { args: ["project", "doc", "add", "nod", "notes.md"], hint: "--body - --project" },
      { args: ["issue", "doc", "remove", "NOD-1", "notes.md"], hint: "nod doc unlink" },
      { args: ["issue", "plan", "NOD-1", "--from=notes.md"], hint: "--body -" },
      { args: ["template", "add", "bug", "--from", join(repo, "notes.md")], hint: "--body -" },
      { args: ["workspace", "rules", "set", "--from=notes.md"], hint: "--text" },
      { args: ["issue", "attach", "add", "NOD-1", "--file", "shot.png"], hint: "--url" },
      { args: ["issue", "publish", "NOD-1", "--body-file", "notes.md"], hint: "--body -" },
      { args: ["sprint", "create", "--input", "sprint.json"], hint: "--input -" },
      { args: ["ui", "--web-dir", "dist"], hint: "--web-dir を省いて" },
    ];
    for (const { args, hint } of cases) {
      const r = await runWrapper(sb, args, { cwd: repo });
      expectRejected(r);
      expect(r.stderr).toContain(hint);
    }
  });

  test("Documents ディレクトリの外へ抜けるパスや、名前が似た別のディレクトリは止める", async () => {
    const sb = sandbox();
    const repo = makeRepo();
    const cases = [
      join(sb.docs, "..", "nod.db"),
      `${sb.docs}/plans/../../attachments/x.md`,
      `${sb.docs}-evil/a.md`,
      `${sb.docs}/`,
      "~/.local/share/nod/documents/a.md",
    ];
    for (const path of cases) {
      const r = await runWrapper(sb, ["issue", "plan", "NOD-1", "--from", path], { cwd: repo });
      expectRejected(r);
    }
  });

  test("-w と workspace remove の相対パスは、Air で別の場所を基準に解決されるので止める", async () => {
    const sb = sandbox();
    const repo = makeRepo();
    const cases = [
      ["-w", "../other", "issue", "list"],
      ["-w./other", "issue", "list"],
      ["issue", "list", "--workspace=.", "--json"],
      ["-w", "packages/cli", "issue", "list"],
      ["workspace", "remove", "./api-server", "--yes"],
    ];
    for (const args of cases) {
      const r = await runWrapper(sb, args, { cwd: repo });
      expect(r.exitCode).toBe(1);
      expect(r.sshCalls).toBe(0);
      expect(r.nod).toBeNull();
    }
    const r = await runWrapper(sb, ["-w", "../other", "issue", "list"], { cwd: repo });
    expect(r.stderr).toContain("Workspace のキー");
  });

  test("--json を付けると、nod と同じ形の JSON で標準出力にエラーを返す", async () => {
    const sb = sandbox();
    const repo = makeRepo();

    const r = await runWrapper(sb, ["--json", "issue", "doc", "add", "NOD-1", 'say "hi".md'], { cwd: repo });

    expect(r.exitCode).toBe(1);
    expect(r.sshCalls).toBe(0);
    expect(r.stderr).toBe("");
    const body = JSON.parse(r.stdout);
    expect(body.error.code).toBe("LOCAL_PATH_REJECTED");
    expect(body.error.message).toContain('say "hi".md');
  });
});

describe("標準入力", () => {
  test("--input - と doc create --body - は標準入力ごと Air の nod へ渡す", async () => {
    const sb = sandbox();
    const repo = makeRepo();

    const input = '{"requestKey":"k1"}\n';
    const r1 = await runWrapper(sb, ["sprint", "create", "--input", "-"], { cwd: repo, stdin: input });
    expectPassedThrough(r1, ["sprint", "create", "--input", "-"]);
    expect(r1.nod?.stdin).toBe(input);

    const body = "本文の1行目\n2行目\n";
    const args = ["doc", "create", "specs/example.md", "--body", "-", "--issue", "NOD-1"];
    const r2 = await runWrapper(sb, args, { cwd: repo, stdin: body });
    expectPassedThrough(r2, args);
    expect(r2.nod?.stdin).toBe(body);
  });
});

// nod のコマンド定義からパスを受ける入力を集め、ラッパーがすべてを手元のパスとして止めることを確かめる。
// ファイルを読まない（Air で新しく作る・PR の中のパスを指す）ものだけを除く
const NOT_LOCAL_FILES: Record<string, true> = { "issue pr-diff --file": true, "doc create <path>": true };

interface PathInput {
  name: string;
  argv: string[];
}

function pathInputs(): PathInput[] {
  const found: PathInput[] = [];
  const walk = (cmd: Command, path: string[]) => {
    for (const sub of cmd.commands) walk(sub, [...path, sub.name()]);
    if (cmd.commands.length) return;
    const valueOf = (placeholder: string) => (placeholder === "keyOrPath" ? "../other" : "docs/local.md");
    const args = cmd.registeredArguments;
    args.forEach((arg, n) => {
      if (!["path", "keyOrPath"].includes(arg.name())) return;
      const argv = args.map((a, m) => (m === n ? valueOf(a.name()) : `X${m}`));
      found.push({ name: `${path.join(" ")} <${arg.name()}>`, argv: [...path, ...argv] });
    });
    for (const option of cmd.options) {
      const placeholder = /<(path|file|dir|keyOrPath)>/.exec(option.flags)?.[1];
      if (!placeholder || !option.long) continue;
      const argv = [...path, ...args.map((_, k) => `X${k}`), option.long, valueOf(placeholder)];
      found.push({ name: `${path.join(" ")} ${option.long}`, argv });
    }
  };
  walk(buildProgram(), []);
  return found;
}

describe("nod のコマンド定義との対応", () => {
  test("パスを受けるすべての入力で手元のパスを止め、ファイルを読まない入力だけは通す", async () => {
    const sb = sandbox();
    const repo = makeRepo();
    const inputs = pathInputs();
    expect(inputs.map((i) => i.name)).toEqual(
      expect.arrayContaining(["issue doc add <path>", "workspace remove <keyOrPath>", "sprint create --input", ...Object.keys(NOT_LOCAL_FILES)]),
    );
    for (const input of inputs) {
      const r = await runWrapper(sb, input.argv, { cwd: repo });
      if (NOT_LOCAL_FILES[input.name]) {
        expectPassedThrough(r, input.argv);
      } else {
        expect({ name: input.name, exitCode: r.exitCode, sshCalls: r.sshCalls }).toEqual({ name: input.name, exitCode: 1, sshCalls: 0 });
      }
    }
  });
});
