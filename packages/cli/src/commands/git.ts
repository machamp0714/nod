import {
  AUTOMATION_DAYS_MAX,
  AUTOMATION_LIMIT_MAX,
  GIT_SYNC_SCAN_MAX,
  GIT_SYNC_SINCE_DAYS_DEFAULT,
  type GitSyncResult,
  NodError,
  syncGitCommits,
} from "@nod/core";
import type { Command } from "commander";
import { actAsync, currentWorkspace } from "../context";
import { print } from "../output";

function parseCount(option: string, max: number) {
  return (value: string): number => {
    if (!/^[0-9]+$/.test(value)) throw new NodError("INVALID_ARGS", `${option} は 1〜${max} の整数で指定してください`);
    return Number(value);
  };
}

function describeSync(r: GitSyncResult): string {
  const lines = [
    `コミット連動（${r.ref}・直近${r.sinceDays}日・${r.scanned} コミットを読みました${r.truncated ? `。上限 ${GIT_SYNC_SCAN_MAX} 件に達したため、それより古いコミットは読んでいません` : ""}）: 対象 ${r.total} 件`,
  ];
  if (!r.enabled) lines.push("  コミット連動は無効です（有効にするのは人: nod automation set --commit-review on）");
  for (const c of r.candidates) {
    lines.push(`  ${c.id}  ${c.status}  ${c.sha.slice(0, 12)} ${c.keyword} 「${c.subject}」  ${c.title}`);
  }
  if (r.remaining) lines.push(`  ほか ${r.remaining} 件は上限を超えたため${r.dryRun ? "今回の対象外" : "次回の実行で処理します"}`);
  if (r.dryRun) {
    lines.push("（dry-run のため変更していません。実行するには --dry-run を外してください）");
  } else {
    lines.push(`  in_review にしました: ${r.processed.length} 件${r.processed.length ? `（${r.processed.join(", ")}）` : ""}`);
    if (r.skipped.length) lines.push(`  スキップ（実行時に対象外）: ${r.skipped.join(", ")}`);
    for (const f of r.failed) lines.push(`  失敗: ${f.id} ${f.message}`);
    if (r.processed.length) lines.push("  誤りなら nod automation undo <id> で元に戻せます（done にはしていません）");
  }
  return lines.join("\n");
}

export function registerGitCommands(program: Command): void {
  const git = program.command("git").description("Workspace のリポジトリの git を読み取って Issue に反映する（git へは読み取りのみ）");
  git
    .command("sync")
    .description("コミットメッセージの Closes/Fixes/Resolves <ID> を読み、Issue を in_review にする（実行は人だけ。--dry-run は対象を表示するだけ）")
    .option("--dry-run", "対象を表示するだけで変更しない（LLM も使える）")
    .option("--since <days>", `直近この日数のコミットを読む（既定 ${GIT_SYNC_SINCE_DAYS_DEFAULT}、最大 ${AUTOMATION_DAYS_MAX}）`, parseCount("--since", AUTOMATION_DAYS_MAX))
    .option("--ref <rev>", "読むブランチ・タグ・コミット（既定 HEAD）")
    .option("--limit <n>", `1回に扱う Issue の上限（既定 50、最大 ${AUTOMATION_LIMIT_MAX}）。古いコミット順に扱う`, parseCount("--limit", AUTOMATION_LIMIT_MAX))
    .addHelpText(
      "after",
      [
        "",
        `Workspace のパスで git log <ref> を読む（fetch はしない。1回 ${GIT_SYNC_SCAN_MAX} コミットまで）。`,
        "拾う書き方: close / closes / closed / fix / fixes / fixed / resolve / resolves / resolved（大文字小文字は問わない）に続く",
        "  この Workspace の Issue ID。「Fixes API-1, API-2 and API-3」のように複数書ける。",
        "対象: backlog / todo / in_progress の Issue。Triage・needs_clarification・in_review・done・canceled・アーカイブ済みは対象外。done にはしない。",
        "同じ Issue・同じコミットでは一度だけ進め、コミットのあとで一度でも in_review になった Issue（差し戻し後など）は進めない。",
        "Workspace で nod automation set --commit-review on にしたときだけ実行できる。誤りは nod automation undo <id> で戻す。",
      ].join("\n"),
    )
    .action(
      actAsync(async (cli, cmd) => {
        const o = cmd.opts<{ dryRun?: boolean; since?: number; ref?: string; limit?: number }>();
        const r = await syncGitCommits(cli.ctx, currentWorkspace(cli, cmd).key, {
          dryRun: o.dryRun,
          sinceDays: o.since,
          ref: o.ref,
          limit: o.limit,
        });
        print(cli, r, () => describeSync(r));
      }),
    );
}
