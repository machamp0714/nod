import {
  AUTOMATION_LIMIT_MAX,
  type AutomationRuleResult,
  type AutomationSettings,
  getAutomationSettings,
  NodError,
  runAutomation,
  setAutomationSettings,
  undoAutoTransition,
} from "@nod/core";
import type { Command } from "commander";
import { act, currentWorkspace } from "../context";
import { print } from "../output";

// "off" はルールを無効にする。commander は解析結果の null を '' に置き換えるため、"off" のまま受け取る。日数の範囲は core で確かめる
function parseDays(option: string) {
  return (value: string): number | "off" => {
    if (value === "off") return "off";
    if (!/^[0-9]+$/.test(value)) throw new NodError("INVALID_ARGS", `${option} は日数（正の整数）か off で指定してください`);
    return Number(value);
  };
}

function parseSwitch(option: string) {
  return (value: string): boolean => {
    if (value === "on") return true;
    if (value === "off") return false;
    throw new NodError("INVALID_ARGS", `${option} は on か off で指定してください`);
  };
}

function parseLimit(value: string): number {
  if (!/^[0-9]+$/.test(value)) throw new NodError("INVALID_ARGS", `--limit は 1〜${AUTOMATION_LIMIT_MAX} の整数で指定してください`);
  return Number(value);
}

function describeSettings(s: AutomationSettings): string {
  return [
    `自動クローズ: ${s.closeAfterDays === null ? "無効" : `${s.closeAfterDays}日間更新のない未完了の Issue を canceled にする`}`,
    `自動アーカイブ: ${s.archiveAfterDays === null ? "無効" : `done / canceled から ${s.archiveAfterDays}日たった Issue をアーカイブする`}`,
    `PR 連動: ${s.prReview ? "PR が open（draft 以外）かマージ済みになったら in_progress の Issue を in_review にする（done にはしない）" : "無効"}`,
    `コミット連動: ${s.commitReview ? "nod git sync でコミットの Closes/Fixes <ID> を読み、Issue を in_review にする（done にはしない）" : "無効"}`,
  ].join("\n");
}

function describePrReview(rule: AutomationRuleResult, dryRun: boolean): string {
  if (!rule.enabled) return "PR 連動: 無効";
  const lines = [`PR 連動（PR が open かマージ済み → in_review）: 対象 ${rule.total} 件`];
  for (const c of rule.candidates) {
    const state = c.prState === "MERGED" ? "マージ済み（完了候補）" : "open";
    lines.push(`  ${c.id}  ${c.status}  PR ${state}  ${c.prUrl}  ${c.title}`);
  }
  if (rule.remaining) lines.push(`  ほか ${rule.remaining} 件は上限を超えたため${dryRun ? "今回の対象外" : "次回の実行で処理します"}`);
  if (!dryRun) {
    lines.push(`  in_review にしました: ${rule.processed.length} 件${rule.processed.length ? `（${rule.processed.join(", ")}）` : ""}`);
    if (rule.skipped.length) lines.push(`  スキップ（実行時に対象外）: ${rule.skipped.join(", ")}`);
    for (const f of rule.failed) lines.push(`  失敗: ${f.id} ${f.message}`);
  }
  return lines.join("\n");
}

function describeRule(rule: AutomationRuleResult, dryRun: boolean): string {
  if (rule.kind === "pr_review") return describePrReview(rule, dryRun);
  const name = rule.kind === "auto_close" ? "自動クローズ" : "自動アーカイブ";
  if (!rule.enabled) return `${name}: 無効`;
  const heading =
    rule.kind === "auto_close"
      ? `${name}（${rule.days}日間更新なし → canceled）: 対象 ${rule.total} 件`
      : `${name}（完了から${rule.days}日経過 → アーカイブ）: 対象 ${rule.total} 件`;
  const since = rule.kind === "auto_close" ? "最終活動" : "完了";
  const lines = [heading];
  for (const c of rule.candidates) {
    lines.push(`  ${c.id}  ${c.status}  ${since} ${c.since.slice(0, 10)}（${c.elapsedDays}日前）  ${c.title}`);
  }
  if (rule.remaining) lines.push(`  ほか ${rule.remaining} 件は上限を超えたため${dryRun ? "今回の対象外" : "次回の実行で処理します"}`);
  if (!dryRun) {
    const verb = rule.kind === "auto_close" ? "canceled にしました" : "アーカイブしました";
    lines.push(`  ${verb}: ${rule.processed.length} 件${rule.processed.length ? `（${rule.processed.join(", ")}）` : ""}`);
    if (rule.skipped.length) lines.push(`  スキップ（実行時に対象外）: ${rule.skipped.join(", ")}`);
    for (const f of rule.failed) lines.push(`  失敗: ${f.id} ${f.message}`);
  }
  return lines.join("\n");
}

export function registerAutomationCommands(program: Command): void {
  const automation = program
    .command("automation")
    .description("Workspace ごとの自動化（長期間更新のない Issue の自動クローズ・完了 Issue の自動アーカイブ）を設定・実行する");
  automation
    .command("show")
    .description("現在の Workspace の自動化の設定を表示する")
    .action(
      act((cli, cmd) => {
        const r = getAutomationSettings(cli.db, currentWorkspace(cli, cmd).key);
        print(cli, r, () => describeSettings(r));
      }),
    );
  automation
    .command("set")
    .description("自動化のルールを有効にする・日数を変える・無効にする（人だけが行える）")
    .option("--close-after-days <days|off>", "この日数だけ更新のない未完了の Issue を canceled にする（1〜3650、off で無効）", parseDays("--close-after-days"))
    .option("--archive-after-days <days|off>", "done / canceled からこの日数たった Issue をアーカイブする（1〜3650、off で無効）", parseDays("--archive-after-days"))
    .option("--pr-review <on|off>", "PR が open（draft 以外）かマージ済みになったら in_progress の Issue を in_review にする（既定 off）", parseSwitch("--pr-review"))
    .option("--commit-review <on|off>", "nod git sync でコミットの Closes/Fixes <ID> を読み、Issue を in_review にする（既定 off）", parseSwitch("--commit-review"))
    .action(
      act((cli, cmd, o: { closeAfterDays?: number | "off"; archiveAfterDays?: number | "off"; prReview?: boolean; commitReview?: boolean }) => {
        if ([o.closeAfterDays, o.archiveAfterDays, o.prReview, o.commitReview].every((v) => v === undefined)) {
          throw new NodError(
            "INVALID_ARGS",
            "--close-after-days・--archive-after-days・--pr-review・--commit-review のどれかを指定してください（例: nod automation set --close-after-days 90）",
          );
        }
        const days = (v: number | "off" | undefined) => (v === "off" ? null : v);
        const r = setAutomationSettings(cli.ctx, currentWorkspace(cli, cmd).key, {
          closeAfterDays: days(o.closeAfterDays),
          archiveAfterDays: days(o.archiveAfterDays),
          prReview: o.prReview,
          commitReview: o.commitReview,
        });
        print(cli, r, () => `自動化の設定を保存しました\n${describeSettings(r)}`);
      }),
    );
  automation
    .command("run")
    .description("有効な自動化ルールを今すぐ1回実行する（実行は人だけ。--dry-run は対象を表示するだけ）")
    .option("--dry-run", "対象を表示するだけで変更しない")
    .option("--limit <n>", `ルールごとに扱う上限（既定 50、最大 ${AUTOMATION_LIMIT_MAX}）。古い順に扱う`, parseLimit)
    .addHelpText(
      "after",
      [
        "",
        "自動クローズの対象: backlog / todo / in_progress / needs_clarification で、最後の活動（更新・event・コメント・質問）から指定日数たったもの。",
        "  triage・in_review・委任中（担当が me 以外）・スヌーズ中・未完了の子を持つ親・ブロック関係のある Issue",
        "  （未完了の Issue をブロックしている、または未完了のブロッカーを待っている）は対象外。done にはしない。",
        "自動アーカイブの対象: done / canceled になってから指定日数たったもの。未完了の子を持つ親は対象外。",
        "同じ回で自動クローズした Issue はアーカイブしない。もう一度実行しても同じ Issue は対象にならない。",
        "PR 連動の対象: in_progress で、保存済みの PR 状態（nod issue pr-status --refresh で取得）が open（draft 以外）かマージ済みのもの。",
        "  gh は呼ばない。in_review にするだけで done にはしない（マージ済みは完了候補として人の承認を待つ）。",
        "  同じ PR で一度進めた Issue は、差し戻し・取消のあとも同じ PR では進めない。取消は nod automation undo <id>。",
      ].join("\n"),
    )
    .action(
      act((cli, cmd, o: { dryRun?: boolean; limit?: number }) => {
        const r = runAutomation(cli.ctx, currentWorkspace(cli, cmd).key, { dryRun: o.dryRun, limit: o.limit });
        print(cli, r, () => {
          const body = r.rules.map((rule) => describeRule(rule, r.dryRun)).join("\n");
          return r.dryRun ? `${body}\n（dry-run のため変更していません。実行するには --dry-run を外してください）` : body;
        });
      }),
    );
  automation
    .command("undo <id>")
    .description("PR 連動・コミット連動（nod git sync）による自動遷移を取り消し、Issue を元の状態に戻す（人だけ。Issue がまだ in_review のときだけ）")
    .action(
      act((cli, _cmd, id: string) => {
        const t = undoAutoTransition(cli.ctx, id);
        const what = t.source === "pr" ? `PR ${t.sourceKey}` : `コミット ${t.sourceKey.slice(0, 12)}`;
        print(cli, t, () => `${t.issueId} を ${t.to} から ${t.from} に戻しました（${what} による自動遷移の取消）。同じ${t.source === "pr" ? " PR" : "コミット"}では再び進めません`);
      }),
    );
}
