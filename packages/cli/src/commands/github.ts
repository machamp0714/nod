// packages/cli/src/commands/github.ts
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  checkGithubPublishText,
  clearUnknownGithubPublish,
  createCommandRunner,
  type GithubIssueState,
  type GithubPublishDeps,
  type GithubPublishPreview,
  isLlm,
  type LeakFinding,
  linkGithubIssue,
  NodError,
  previewGithubPublish,
  publishGithubIssue,
  unlinkGithubIssue,
} from "@nod/core";
import type { Command } from "commander";
import { act, actAsync, type Cli } from "../context";
import { print } from "../output";

// nod の Issue を GitHub Issue として作成する（人だけ。LLM は --dry-run の下見だけ）。対話の確認は差し替えられるようにする（テストのため）
export interface PublishIo {
  interactive(): boolean;
  write(text: string): void;
  confirm(question: string): Promise<boolean>;
}

// y・yes だけを承認とする。EOF・Ctrl-C（null）・ほかの入力は送らない
export function isYes(answer: string | null): boolean {
  return answer !== null && /^(?:y|yes)$/i.test(answer.trim());
}

export const terminalIo: PublishIo = {
  interactive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  write: (text) => void process.stdout.write(text),
  confirm: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await new Promise<string | null>((resolve) => {
        rl.once("close", () => resolve(null));
        rl.on("SIGINT", () => rl.close());
        rl.question(question, resolve);
      });
      return isYes(answer);
    } finally {
      rl.close();
    }
  },
};

export interface PublishOptions {
  title?: string;
  bodyFile?: string;
  dryRun?: boolean;
  clearUnknown?: boolean;
}

// 端末の表示を乱す制御文字・向きの制御文字を見える形にする。改行・タブ・CRLF の \r は残す
export function visibleControls(text: string): string {
  return text.replace(/\r(?!\n)|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}}`);
}

function describeFindings(findings: LeakFinding[]): string[] {
  return findings.map((f) => `  ${f.field === "title" ? "タイトル" : "本文"} ${f.line} 行 ${f.column} 桁: ${visibleControls(f.text)} — ${f.reason}`);
}

function describePreview(p: GithubPublishPreview): string {
  const lines = [`${p.issueId} を GitHub に作成するときの内容（dry-run のため送っていません）`];
  lines.push(p.repo ? `宛先: ${p.repo}` : `宛先: 未設定${p.repoCandidate ? `（origin の候補: ${p.repoCandidate}。nod workspace github set ${p.repoCandidate} で設定できます）` : ""}`);
  lines.push(p.ghLogin ? `gh アカウント: ${p.ghLogin}` : `gh アカウント: 確かめられません（${p.ghError?.message ?? ""}）`);
  for (const b of p.blockers) lines.push(`公開できません: ${b.message}`);
  if (p.findings.length) lines.push(`nod の情報が ${p.findings.length} 件見つかりました（このままでは送れません）`, ...describeFindings(p.findings));
  else lines.push("nod の情報は見つかりませんでした");
  lines.push(`タイトル: ${visibleControls(p.title)}`, "本文:", "---", visibleControls(p.body), "---");
  return lines.join("\n");
}

function describeConfirmation(c: { repo: string; ghLogin: string; title: string; body: string }): string {
  return [`宛先: ${c.repo}（gh アカウント: ${c.ghLogin}）`, `タイトル: ${visibleControls(c.title)}`, "本文:", "---", visibleControls(c.body), "---", ""].join("\n");
}

function readBodyFile(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    throw new NodError("INVALID_ARGS", `--body-file ${path} を読めません: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function runPublishCommand(cli: Cli, id: string, o: PublishOptions, io: PublishIo, deps: GithubPublishDeps): Promise<void> {
  if (cli.json && !o.dryRun) throw new NodError("INVALID_ARGS", "--json は --dry-run と一緒にだけ使えます");
  if (o.clearUnknown) {
    if (o.dryRun || o.title !== undefined || o.bodyFile !== undefined) {
      throw new NodError("INVALID_ARGS", "--clear-unknown は --dry-run・--title・--body-file と一緒に使えません");
    }
    const state = clearUnknownGithubPublish(cli.ctx, id);
    print(cli, state, () => `${state.issueId} の結果不明の送信を解除しました。作成するときは、もう一度 nod issue publish ${state.issueId} で内容を確かめてください`);
    return;
  }
  const preview = await previewGithubPublish(cli.ctx, id, deps);
  const title = o.title ?? preview.title;
  const body = o.bodyFile !== undefined ? readBodyFile(o.bodyFile) : preview.body;
  const same = title === preview.title && body === preview.body;
  // 差し替えた文面は checkGithubPublishText が長さも確かめる（超えていれば INVALID_ARGS）ため、nod の文面の長さの理由は外す
  const findings = same ? preview.findings : checkGithubPublishText(cli.db, { title, body }, deps);
  const blockers = same ? preview.blockers : preview.blockers.filter((b) => b.code !== "INVALID_ARGS");
  const view: GithubPublishPreview = { ...preview, title, body, findings, blockers };
  if (o.dryRun) {
    print(cli, view, () => describePreview(view));
    return;
  }
  if (isLlm(cli.ctx)) {
    throw new NodError("FORBIDDEN_FOR_LLM", "LLM は GitHub Issue を作成できません（nod issue publish --dry-run での確認はできます）。作成は me に依頼してください");
  }
  const blocker = view.blockers[0];
  if (blocker) throw new NodError(blocker.code, blocker.message);
  if (!preview.repo) {
    throw new NodError(
      "GITHUB_REPO_NOT_SET",
      preview.repoCandidate
        ? `公開先が未設定です。origin から推定した候補は ${preview.repoCandidate} です。nod workspace github set ${preview.repoCandidate} で設定してから実行してください`
        : "公開先が未設定です。nod workspace github set <owner/repo> で設定してから実行してください",
    );
  }
  if (preview.ghError || !preview.ghLogin) throw new NodError(preview.ghError?.code ?? "GH_FAILED", preview.ghError?.message ?? "gh のアカウントを確かめられません");
  if (findings.length) {
    throw new NodError("LEAK_DETECTED", ["nod の情報が見つかったため送信しません。書き換えてから実行してください", ...describeFindings(findings)].join("\n"), { findings });
  }
  if (!io.interactive()) {
    throw new NodError("NOT_INTERACTIVE", "対話できない環境では送信しません。端末で実行するか、Web の Issue 詳細から作成してください（--dry-run での確認はできます）");
  }
  io.write(describeConfirmation({ repo: preview.repo, ghLogin: preview.ghLogin, title, body }));
  if (!(await io.confirm("この内容で GitHub に Issue を作成しますか？ [y/N] "))) {
    io.write("送信しませんでした\n");
    return;
  }
  const r = await publishGithubIssue(cli.ctx, id, { title, body, repo: preview.repo, ghLogin: preview.ghLogin }, deps);
  io.write(`${r.issueId} の GitHub Issue を作成しました: ${r.url}\n${r.message ? `${r.message}\n` : ""}`);
}

// NOD_GH はテスト用の口（pr-status と同じ）: gh の代わりに起動するコマンド。通常は設定しない
function ghDeps(): GithubPublishDeps {
  return { gh: createCommandRunner(process.env.NOD_GH || "gh") };
}

function describeState(s: GithubIssueState): string {
  return s.link ? `${s.issueId} は ${s.link.url} に紐付いています` : `${s.issueId} は GitHub Issue に紐付いていません`;
}

export function registerGithubIssueCommands(issue: Command, io: PublishIo = terminalIo): void {
  issue
    .command("publish <id>")
    .description("nod の Issue を GitHub Issue として1回だけ作成する（実行は人だけ。--dry-run は内容の確認だけで LLM も使える）")
    .option("--title <text>", "送信用のタイトル（nod のタイトルは変えない）")
    .option("--body-file <path>", "送信用の本文を読むファイル（nod の本文は変えない）")
    .option("--dry-run", "送らずに、宛先・アカウント・内容・nod の情報の検出結果を表示する")
    .option("--clear-unknown", "結果不明の送信を解除する（GitHub に作られていないことを確かめてから使う。送信はしない）")
    .addHelpText(
      "after",
      [
        "",
        "送るのはタイトルと本文だけで、作成後の同期・更新・close・コメントはしない。",
        "送る前に nod の情報（Issue ID・番号だけの参照・nod の URL とコマンド・手元のパス・nod でしか開けないリンク）を調べ、",
        "  見つかれば行番号付きで示して送らない（自動では消さない）。",
        "確認画面で宛先・gh アカウント・全文を示し、y で送る（既定は N）。端末でないときは送らない。",
        "結果が分からなかったときは再送しない。GitHub を確かめ、作られていれば nod issue link-github、",
        "  作られていなければ --clear-unknown で解除してから、もう一度 publish する。",
      ].join("\n"),
    )
    .action(
      actAsync(async (cli, cmd, id: string) => {
        await runPublishCommand(cli, id, cmd.opts<PublishOptions>(), io, ghDeps());
      }),
    );

  issue
    .command("link-github <id> <url>")
    .description("既存の GitHub Issue を nod の Issue に紐付ける（実行は人だけ。done・アーカイブ済みにも付けられる）")
    .action(
      actAsync(async (cli, _cmd, id: string, url: string) => {
        const state = await linkGithubIssue(cli.ctx, id, url, ghDeps().gh);
        print(cli, state, () => describeState(state));
      }),
    );

  issue
    .command("unlink-github <id>")
    .description("GitHub Issue の紐付けを外す（実行は人だけ。外した GitHub Issue は import で取り込み直さない）")
    .action(
      act((cli, _cmd, id: string) => {
        const state = unlinkGithubIssue(cli.ctx, id);
        print(cli, state, () => describeState(state));
      }),
    );
}
