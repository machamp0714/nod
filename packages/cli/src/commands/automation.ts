import {
  AUTOMATION_LIMIT_MAX,
  type AutomationRuleResult,
  type AutomationSettings,
  getAutomationSettings,
  NodError,
  runAutomation,
  setAutomationSettings,
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

function parseLimit(value: string): number {
  if (!/^[0-9]+$/.test(value)) throw new NodError("INVALID_ARGS", `--limit は 1〜${AUTOMATION_LIMIT_MAX} の整数で指定してください`);
  return Number(value);
}

function describeSettings(s: AutomationSettings): string {
  return [
    `自動クローズ: ${s.closeAfterDays === null ? "無効" : `${s.closeAfterDays}日間更新のない未完了の Issue を canceled にする`}`,
    `自動アーカイブ: ${s.archiveAfterDays === null ? "無効" : `done / canceled から ${s.archiveAfterDays}日たった Issue をアーカイブする`}`,
  ].join("\n");
}

function describeRule(rule: AutomationRuleResult, dryRun: boolean): string {
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
    .action(
      act((cli, cmd, o: { closeAfterDays?: number | "off"; archiveAfterDays?: number | "off" }) => {
        if (o.closeAfterDays === undefined && o.archiveAfterDays === undefined) {
          throw new NodError("INVALID_ARGS", "--close-after-days か --archive-after-days を指定してください（例: nod automation set --close-after-days 90）");
        }
        const days = (v: number | "off" | undefined) => (v === "off" ? null : v);
        const r = setAutomationSettings(cli.ctx, currentWorkspace(cli, cmd).key, {
          closeAfterDays: days(o.closeAfterDays),
          archiveAfterDays: days(o.archiveAfterDays),
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
}
