import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  addWorkspaceLabel,
  clearWorkspaceRules,
  DEFAULT_STATUS_LABELS,
  getStatusNames,
  listWorkspaceLabels,
  removeWorkspaceLabel,
  setStatusNames,
  STATUSES,
  updateWorkspaceLabel,
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

  registerLabelCommands(ws);
  registerStatusNameCommands(ws);
}

function registerLabelCommands(ws: Command): void {
  const labels = ws
    .command("labels")
    .description("Workspace のラベル定義（名前・色・説明）を管理する。変更は人だけが行える。未定義のラベルも Issue に付けられる");
  labels
    .command("list")
    .description("現在の Workspace のラベル定義を一覧する")
    .action(
      act((cli, cmd) => {
        const list = listWorkspaceLabels(cli.db, currentWorkspace(cli, cmd).key);
        print(cli, list, () =>
          list.length
            ? list.map((l) => `${l.name}  ${l.color}  ${l.issueCount}件${l.description ? `  ${l.description}` : ""}`).join("\n")
            : "ラベルの定義はありません",
        );
      }),
    );
  labels
    .command("add <name>")
    .description("ラベルを定義する")
    .requiredOption("--color <hex>", "色（#RRGGBB）")
    .option("-d, --description <text>", "説明（200 文字まで）")
    .action(
      act((cli, cmd, name: string, o: { color: string; description?: string }) => {
        const r = addWorkspaceLabel(cli.ctx, currentWorkspace(cli, cmd).key, { name, color: o.color, description: o.description });
        print(cli, r, () => `ラベル ${r.name}（${r.color}）を定義しました`);
      }),
    );
  labels
    .command("update <name>")
    .description("ラベルの定義を変更する。改名すると、この Workspace の Issue に付いたラベルも置き換える")
    .option("--name <newName>", "新しい名前")
    .option("--color <hex>", "色（#RRGGBB）")
    .option("-d, --description <text>", "説明（空文字で消す）")
    .action(
      act((cli, cmd, name: string, o: { name?: string; color?: string; description?: string }) => {
        if (o.name === undefined && o.color === undefined && o.description === undefined) {
          throw new NodError("INVALID_ARGS", "--name、--color、--description のいずれかを指定してください");
        }
        const r = updateWorkspaceLabel(cli.ctx, currentWorkspace(cli, cmd).key, name, o);
        print(cli, r, () => `ラベル ${r.name}（${r.color}）を更新しました`);
      }),
    );
  labels
    .command("remove <name>")
    .description("ラベルの定義を削除する。Issue に付いたラベルは未定義のラベルとして残る")
    .action(
      act((cli, cmd, name: string) => {
        const r = removeWorkspaceLabel(cli.ctx, currentWorkspace(cli, cmd).key, name);
        print(cli, r, () => `ラベル ${r.name} の定義を削除しました（Issue のラベルは残ります）`);
      }),
    );
}

function registerStatusNameCommands(ws: Command): void {
  const names = ws
    .command("status-names")
    .description("ステータスの表示名を管理する。内部値と状態の意味は変わらない。変更は人だけが行える");
  names
    .command("show")
    .description("現在の Workspace のステータスの表示名を表示する")
    .action(
      act((cli, cmd) => {
        const r = getStatusNames(cli.db, currentWorkspace(cli, cmd).key);
        print(cli, r, () =>
          STATUSES.map((s) => `${s.padEnd(20)}${r.names[s] ?? `${DEFAULT_STATUS_LABELS[s]}（既定）`}`).join("\n"),
        );
      }),
    );
  names
    .command("set <status> <name>")
    .description("1つのステータスの表示名を設定する（status は triage、todo などの内部値）")
    .action(
      act((cli, cmd, status: string, name: string) => {
        const workspace = currentWorkspace(cli, cmd);
        const current = getStatusNames(cli.db, workspace.key).names;
        const r = setStatusNames(cli.ctx, workspace.key, { ...current, [status]: name });
        print(cli, r, () => `${status} の表示名を「${r.names[status as keyof typeof r.names] ?? name}」にしました`);
      }),
    );
  names
    .command("reset [status]")
    .description("表示名を既定に戻す。status を省略するとすべて戻す")
    .action(
      act((cli, cmd, status: string | undefined) => {
        const workspace = currentWorkspace(cli, cmd);
        const current = getStatusNames(cli.db, workspace.key).names;
        if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
          throw new NodError("INVALID_ARGS", `不明なステータスです: ${status}（${STATUSES.join(", ")} のいずれか）`);
        }
        const r = setStatusNames(cli.ctx, workspace.key, status === undefined ? {} : { ...current, [status]: null });
        print(cli, r, () => (status === undefined ? "すべての表示名を既定に戻しました" : `${status} の表示名を既定に戻しました`));
      }),
    );
}
