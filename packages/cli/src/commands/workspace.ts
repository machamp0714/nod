import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  clearWorkspaceRules,
  countIssues,
  findWorkspace,
  getWorkspaceRules,
  initWorkspace,
  listWorkspaces,
  NodError,
  removeWorkspace,
  setWorkspaceRules,
} from "@nod/core";
import type { Command } from "commander";
import { act, currentWorkspace, repoRootOf } from "../context";
import { print } from "../output";

export function registerWorkspaceCommands(program: Command): void {
  program
    .command("init")
    .description("今いる git リポジトリを Workspace として登録する")
    .option("--key <key>", "Issue の ID に使うキー（英大文字と数字の2〜6文字。省略時はリポジトリ名から作る）")
    .option("--name <name>", "表示名（省略時はリポジトリのディレクトリ名）")
    .action(
      act((cli, _cmd, o: { key?: string; name?: string }) => {
        // repoRootOf は realpath にそろえたルートを返す。シンボリックリンク経由でも実体のパスで登録する
        const root = repoRootOf(process.cwd());
        if (!root) {
          throw new NodError("NOT_A_GIT_REPO", `${process.cwd()} は git リポジトリではありません。登録するリポジトリの中で実行してください`);
        }
        const r = initWorkspace(cli.db, { path: root, key: o.key, name: o.name });
        print(cli, r, () =>
          r.created
            ? `Workspace ${r.workspace.name}（キー ${r.workspace.key}）を登録しました: ${r.workspace.path}`
            : `すでに登録済みです: ${r.workspace.name}（キー ${r.workspace.key}）`,
        );
      }),
    );

  const ws = program.command("workspace").description("登録済みの Workspace を管理する");
  ws.command("list")
    .description("登録済みの Workspace を一覧する")
    .action(
      act((cli) => {
        const list = listWorkspaces(cli.db);
        print(cli, list, () =>
          list.length ? list.map((w) => `${w.key}  ${w.name}  ${w.path}`).join("\n") : "登録済みの Workspace はありません",
        );
      }),
    );
  ws.command("remove <keyOrPath>")
    .description("Workspace の登録を解除する（その Workspace の Issue も消える）")
    .option("--yes", "確認なしで解除する")
    .action(
      act((cli, _cmd, keyOrPath: string, o: { yes?: boolean }) => {
        const target = findWorkspace(cli.db, keyOrPath) ?? findWorkspace(cli.db, resolve(keyOrPath));
        if (!target) throw new NodError("NOT_FOUND", `Workspace ${keyOrPath} は登録されていません`);
        if (!o.yes) {
          throw new NodError(
            "CONFIRM_REQUIRED",
            `${target.name} の登録を解除すると、Issue ${countIssues(cli.db, target.id)} 件も消えます。よければ --yes を付けて再実行してください`,
          );
        }
        const r = removeWorkspace(cli.db, target.key);
        print(cli, r, () => `登録を解除しました: ${r.workspace.name}（Issue ${r.deletedIssues} 件を削除）`);
      }),
    );

  const rules = ws.command("rules").description("LLM に守らせる作業規約（Markdown）を管理する。変更は人だけが行える");
  rules
    .command("show")
    .description("現在の Workspace の作業規約を表示する")
    .action(
      act((cli, cmd) => {
        const r = getWorkspaceRules(cli.db, currentWorkspace(cli, cmd).key);
        print(cli, r, () => (r ? r.body : "作業規約は登録されていません"));
      }),
    );
  rules
    .command("set")
    .description("作業規約を登録・更新する（10,000 文字まで。空にすると削除）")
    .option("--text <markdown>", "規約の本文")
    .option("--from <path>", "規約を書いた Markdown ファイル")
    .action(
      act((cli, cmd, o: { text?: string; from?: string }) => {
        if ((o.text === undefined) === (o.from === undefined)) {
          throw new NodError("INVALID_ARGS", "--text か --from のどちらか一方で本文を指定してください（例: nod workspace rules set --from rules.md）");
        }
        let body = o.text;
        if (o.from !== undefined) {
          try {
            body = readFileSync(resolve(o.from), "utf8");
          } catch {
            throw new NodError("INVALID_ARGS", `${o.from} を読めません`);
          }
        }
        const workspace = currentWorkspace(cli, cmd);
        const r = setWorkspaceRules(cli.ctx, workspace.key, body ?? "");
        print(cli, r, () => (r ? `${workspace.name} の作業規約を保存しました（${r.body.length} 文字）` : `${workspace.name} の作業規約を削除しました`));
      }),
    );
  rules
    .command("clear")
    .description("作業規約を削除する")
    .action(
      act((cli, cmd) => {
        const workspace = currentWorkspace(cli, cmd);
        const r = clearWorkspaceRules(cli.ctx, workspace.key);
        print(cli, r, () => `${workspace.name} の作業規約を削除しました`);
      }),
    );
}
