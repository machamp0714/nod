import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  addWorkspaceLabel,
  clearWorkspaceRules,
  DEFAULT_STATUS_LABELS,
  getStatusNames,
  getTransitionRules,
  localMinute,
  resetTransitionRules,
  setTransitionRules,
  TRANSITION_PRESET_LABELS,
  TRANSITION_PRESETS,
  type WorkspaceTransitionRules,
  listWorkspaceLabels,
  removeWorkspaceLabel,
  setStatusNames,
  STATUSES,
  updateWorkspaceLabel,
  countIssues,
  findWorkspace,
  getWorkspaceRules,
  initWorkspace,
  listIssueDeletions,
  listWorkspaces,
  NodError,
  removeWorkspace,
  setWorkspaceRules,
  ORCA_AGENT_LABELS,
  ORCA_AGENTS,
  setWorkspaceDefaultAgent,
  clearWorkspaceGithubRepo,
  getWorkspaceGithubRepoView,
  gitRunner,
  setWorkspaceGithubRepo,
} from "@nod/core";
import type { Command } from "commander";
import { collect } from "../args";
import { act, actAsync, currentWorkspace, repoRootOf } from "../context";
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

  ws.command("audit")
    .description("現在の Workspace で完全に削除した Issue の記録（ID・タイトル・削除者・日時）を新しい順に表示する")
    .action(
      act((cli, cmd) => {
        const list = listIssueDeletions(cli.db, currentWorkspace(cli, cmd).key);
        print(cli, list, () =>
          list.length
            ? list.map((d) => `${localMinute(d.deletedAt)}  ${d.issueId}  ${d.title}  （削除: ${d.deletedBy}）`).join("\n")
            : "削除した Issue の記録はありません",
        );
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
  registerAgentCommands(ws);
  registerGithubRepoCommands(ws);
  registerTransitionCommands(ws);
}

function registerLabelCommands(ws: Command): void {
  const labels = ws
    .command("labels")
    .description("Workspace のラベル定義（名前・色・説明）を管理する。削除は人だけが行える。未定義のラベルも Issue に付けられる");
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

// Web の「Orca で作業を始める」（#210）で起動する既定のエージェント。作成時に画面で選び直せる
function registerAgentCommands(ws: Command): void {
  const agent = ws
    .command("agent")
    .description("Web の「Orca で作業を始める」で起動する既定のエージェントを管理する。変更は人だけが行える");
  agent
    .command("show")
    .description("現在の Workspace の既定のエージェントを表示する")
    .action(
      act((cli, cmd) => {
        const workspace = currentWorkspace(cli, cmd);
        const r = { workspaceKey: workspace.key, defaultAgent: workspace.defaultAgent };
        print(cli, r, () => `${ORCA_AGENT_LABELS[r.defaultAgent]}（${r.defaultAgent}）`);
      }),
    );
  agent
    .command("set <agent>")
    .description(`既定のエージェントを変える（${ORCA_AGENTS.join("、")} のいずれか）`)
    .action(
      act((cli, cmd, value: string) => {
        const updated = setWorkspaceDefaultAgent(cli.ctx, currentWorkspace(cli, cmd).key, value);
        const r = { workspaceKey: updated.key, defaultAgent: updated.defaultAgent };
        print(cli, r, () => `既定のエージェントを ${ORCA_AGENT_LABELS[r.defaultAgent]}（${r.defaultAgent}）にしました`);
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

function formatTransitionRules(r: WorkspaceTransitionRules): string {
  if (r.forbidden.length === 0 && r.presets.length === 0) return "遷移ルールはありません（すべての遷移を許可）";
  return [
    ...r.presets.map((p) => `プリセット ${p}: ${TRANSITION_PRESET_LABELS[p]}`),
    ...r.forbidden.map((p) => `禁止 ${p.from} → ${p.to}`),
  ].join("\n");
}

// from:to の形の指定を読む
function parsePair(value: string): { from: string; to: string } {
  const m = /^([a-z_]+):([a-z_]+)$/.exec(value.trim());
  if (!m) throw new NodError("INVALID_ARGS", `--forbid は from:to の形で指定してください（例: --forbid backlog:done）: ${value}`);
  return { from: m[1]!, to: m[2]! };
}

function registerTransitionCommands(ws: Command): void {
  const transitions = ws
    .command("transitions")
    .description("ステータスの遷移ルール（許可しない遷移）を管理する。LLM・自動化も従う。変更は人だけが行える");
  transitions
    .command("show")
    .description("現在の Workspace の遷移ルールを表示する")
    .action(
      act((cli, cmd) => {
        const r = getTransitionRules(cli.db, currentWorkspace(cli, cmd).key);
        print(cli, r, () => formatTransitionRules(r));
      }),
    );
  transitions
    .command("set")
    .description("遷移ルールを全体で置き換える（指定しなかったルールは消える）")
    .option("--forbid <from:to>", "許可しない遷移（繰り返し可。例: --forbid backlog:done）", collect)
    .option("--preset <name>", `プリセット（繰り返し可。${TRANSITION_PRESETS.join(", ")}）`, collect)
    .action(
      act((cli, cmd, o: { forbid?: string[]; preset?: string[] }) => {
        if (!o.forbid?.length && !o.preset?.length) {
          throw new NodError("INVALID_ARGS", "--forbid か --preset を1つ以上指定してください（すべて解除するには nod workspace transitions reset）");
        }
        const workspace = currentWorkspace(cli, cmd);
        const r = setTransitionRules(cli.ctx, workspace.key, { forbidden: (o.forbid ?? []).map(parsePair), presets: o.preset ?? [] });
        print(cli, r, () => `${workspace.name} の遷移ルールを保存しました\n${formatTransitionRules(r)}`);
      }),
    );
  transitions
    .command("reset")
    .description("遷移ルールをすべて解除する（すべての遷移を許可）")
    .action(
      act((cli, cmd) => {
        const workspace = currentWorkspace(cli, cmd);
        const r = resetTransitionRules(cli.ctx, workspace.key);
        print(cli, r, () => `${workspace.name} の遷移ルールをすべて解除しました`);
      }),
    );
}

// nod issue publish で GitHub Issue を作る公開先。未設定なら origin から推定した候補を示す
function registerGithubRepoCommands(ws: Command): void {
  const github = ws.command("github").description("GitHub の公開先（nod issue publish で Issue を作る repo）を管理する。変更は人だけが行える");
  github
    .command("show")
    .description("現在の Workspace の公開先を表示する。未設定なら origin から推定した候補を示す")
    .action(
      actAsync(async (cli, cmd) => {
        const r = await getWorkspaceGithubRepoView(cli.db, currentWorkspace(cli, cmd).key, gitRunner);
        print(cli, r, () =>
          r.repo ? `公開先: ${r.repo}` : `公開先は未設定です${r.originCandidate ? `（origin の候補: ${r.originCandidate}。nod workspace github set ${r.originCandidate} で設定できます）` : ""}`,
        );
      }),
    );
  github
    .command("set <owner/repo>")
    .description("公開先を設定する（作成済みの対応と送信中の宛先は変わらない）")
    .action(
      act((cli, cmd, repo: string) => {
        const r = setWorkspaceGithubRepo(cli.ctx, currentWorkspace(cli, cmd).key, repo);
        print(cli, r, () => `公開先を ${r.repo} にしました`);
      }),
    );
  github
    .command("clear")
    .description("公開先を解除する")
    .action(
      act((cli, cmd) => {
        const r = clearWorkspaceGithubRepo(cli.ctx, currentWorkspace(cli, cmd).key);
        print(cli, r, () => "公開先を解除しました");
      }),
    );
}
