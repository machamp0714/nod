import {
  createCommandRunner,
  GITHUB_IMPORT_LIMIT_DEFAULT,
  GITHUB_IMPORT_LIMIT_MAX,
  GITHUB_IMPORT_OPEN_STATUSES,
  GITHUB_IMPORT_STATES,
  type GithubImportOpenStatus,
  type GithubImportResult,
  type GithubImportState,
  importGithubIssues,
  NodError,
} from "@nod/core";
import type { Command } from "commander";
import { actAsync, currentWorkspace } from "../context";
import { print } from "../output";

function parseLimit(value: string): number {
  if (!/^[0-9]+$/.test(value)) throw new NodError("INVALID_ARGS", `--limit は 1〜${GITHUB_IMPORT_LIMIT_MAX} の整数で指定してください`);
  return Number(value);
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function describeImport(r: GithubImportResult): string {
  const fresh = r.items.filter((i) => !i.existing && !i.deleted).length;
  const deleted = r.items.filter((i) => i.deleted).length;
  const lines = [
    `GitHub ${r.repo}（${r.state}）から ${r.workspaceKey} へ${r.project ? `・Project「${r.project}」へ` : ""}: ${r.items.length} 件を読みました（新規 ${fresh} 件・取り込み済み ${r.items.length - fresh - deleted} 件${deleted ? `・削除済み ${deleted} 件` : ""}）`,
  ];
  if (r.truncated) lines.push(`  --limit に達したため、それより古い Issue は読んでいません（--limit を増やすか --label で絞ると読めます）`);
  for (const i of r.items) {
    const where = i.existing ? `取り込み済み（${i.existing}）` : i.deleted ? "削除済み・紐付け解除済み（取り込まない）" : `→ ${i.status}`;
    const labels = i.labels.length ? `  [${i.labels.join(", ")}]` : "";
    lines.push(`  #${i.number}  ${i.state}${i.stateReason && i.state === "CLOSED" ? `/${i.stateReason}` : ""}  ${where}  ${i.title}${labels}`);
  }
  if (r.dryRun) {
    lines.push("（dry-run のため変更していません。取り込むには --dry-run を外してください。実行は人だけ）");
  } else {
    lines.push(`  取り込みました: ${r.imported.length} 件${r.imported.length ? `（${r.imported.map((i) => i.id).join(", ")}）` : ""}`);
    if (r.skipped.length) lines.push(`  スキップ（取り込み済み・上書きしない）: ${r.skipped.map((s) => s.id).join(", ")}`);
    if (r.deleted.length) lines.push(`  スキップ（nod で削除済み・紐付け解除済み。作り直さない）: ${r.deleted.map((d) => d.sourceKey).join(", ")}`);
    for (const f of r.failed) lines.push(`  失敗: ${f.sourceKey} ${f.message}`);
    if (r.failed.length) lines.push("  失敗した Issue は取り込まれていません。再実行すると、取り込み済みを飛ばしてそれだけを取り込みます");
  }
  return lines.join("\n");
}

export function registerImportCommands(program: Command): void {
  const imp = program.command("import").description("他のツールの Issue を nod に取り込む");
  imp
    .command("github")
    .description("GitHub Issues を gh で読み、現在の Workspace に Issue として取り込む（実行は人だけ。--dry-run は対応を表示するだけ）")
    .argument("<owner/repo>", "取り込み元の GitHub リポジトリ（例: machamp0714/nod）")
    .option("--dry-run", "取り込む内容と状態の対応を表示するだけで変更しない（LLM も使える）")
    .option("--state <state>", `読む Issue の状態 ${GITHUB_IMPORT_STATES.join("|")}（既定 open）`)
    .option("--label <name>", "このラベルを持つ Issue に絞る（複数指定ですべてを持つもの）", collect)
    .option("--limit <n>", `読む件数の上限（既定 ${GITHUB_IMPORT_LIMIT_DEFAULT}、最大 ${GITHUB_IMPORT_LIMIT_MAX}）。新しい Issue から読む`, parseLimit)
    .option("--open-status <status>", `open の Issue の取り込み先 ${GITHUB_IMPORT_OPEN_STATUSES.join("|")}（既定 triage）`)
    .option("--project <name|id>", "取り込んだ Issue を入れる Project")
    .addHelpText(
      "after",
      [
        "",
        "gh issue list / gh issue view で読むだけで、GitHub へは書き込まない（PR は含まない）。",
        "対応: タイトル・本文・ラベル（名前のまま）・コメント（書き手は取り込んだ人、本文の先頭に「@login が GitHub でコメント（日時）」）。",
        "  状態は open → --open-status（既定 triage）、close（NOT_PLANNED・DUPLICATE）→ canceled、それ以外の close → done。",
        "  close 済みの Issue は最初から done・canceled で作り、完了数（nod stats）と要約の完了・キャンセルには数えない。",
        "  担当は写さず、GitHub の作成者・作成日時・close 日時・担当は本文の末尾に残す。nod の日時は取り込んだ時刻になる。",
        "取り込んだ Issue は対応表に残し、再実行では作り直さず、nod 側の変更も上書きしない。nod で削除した Issue も作り直さない。",
        "1件ずつ確定し、失敗した Issue は取り込まずに一覧で示す（再実行でその分だけ取り込める）。",
        "--limit は取り込み済みの Issue も数える（gh は新しい順に返す）。古い Issue まで届かないときは --limit を増やすか --label で絞る。",
      ].join("\n"),
    )
    .action(
      actAsync(async (cli, cmd, repo: string) => {
        const o = cmd.opts<{
          dryRun?: boolean;
          state?: GithubImportState;
          label?: string[];
          limit?: number;
          openStatus?: GithubImportOpenStatus;
          project?: string;
        }>();
        // NOD_GH はテスト用の口（pr-status と同じ）: gh の代わりに起動するコマンド。通常は設定しない
        const r = await importGithubIssues(
          cli.ctx,
          currentWorkspace(cli, cmd).key,
          repo,
          { dryRun: o.dryRun, state: o.state, labels: o.label, limit: o.limit, openStatus: o.openStatus, projectRef: o.project },
          createCommandRunner(process.env.NOD_GH || "gh"),
        );
        print(cli, r, () => describeImport(r));
      }),
    );
}
