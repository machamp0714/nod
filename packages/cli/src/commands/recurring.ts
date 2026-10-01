import {
  addRecurringIssue,
  getRecurringIssue,
  listRecurringIssues,
  NodError,
  RECURRENCE_CADENCES,
  type RecurrenceCadence,
  type RecurringIssue,
  type RecurringIssuePatch,
  type RecurringRun,
  removeRecurringIssue,
  runRecurringIssues,
  updateRecurringIssue,
} from "@nod/core";
import type { Command } from "commander";
import { collect, orNull, parsePositiveInt, parsePriority, PRIORITY_HELP } from "../args";
import { act, currentWorkspace } from "../context";
import { print } from "../output";

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const WEEKDAY_NAMES = ["日", "月", "火", "水", "木", "金", "土"] as const;

function parseCadence(value: string): RecurrenceCadence {
  if (!RECURRENCE_CADENCES.includes(value as RecurrenceCadence)) {
    throw new NodError("INVALID_ARGS", `--every には ${RECURRENCE_CADENCES.join(" / ")} のどれかを指定してください（${value}）`);
  }
  return value as RecurrenceCadence;
}

// mon / 月 / 1 のどれでも受け付ける（0 = 日曜）
function parseWeekday(value: string): number {
  const v = value.toLowerCase();
  const n = /^[0-6]$/.test(v) ? Number(v) : Math.max(WEEKDAYS.indexOf(v as never), WEEKDAY_NAMES.indexOf(v as never));
  if (n < 0) throw new NodError("INVALID_ARGS", `--weekday は ${WEEKDAYS.join(" / ")}（または 日〜土、0〜6）で指定してください（${value}）`);
  return n;
}

// 範囲（1〜31）は core で確かめる
function parseDay(value: string): number {
  if (!/^\d+$/.test(value)) throw new NodError("INVALID_ARGS", `--day は 1〜31 の日で指定してください（${value}）`);
  return Number(value);
}

function parseId(value: string): number {
  return parsePositiveInt(value, "定期Issueの ID ");
}

export function describeCadence(r: Pick<RecurringIssue, "cadence" | "weekday" | "monthDay">): string {
  if (r.cadence === "daily") return "毎日";
  if (r.cadence === "weekly") return `毎週 ${WEEKDAY_NAMES[r.weekday!]}曜`;
  return r.monthDay! >= 29 ? `毎月 ${r.monthDay}日（無い月は月末）` : `毎月 ${r.monthDay}日`;
}

function describeRecurring(r: RecurringIssue): string {
  return [
    `#${r.id}  ${r.title}${r.enabled ? "" : "  （停止中）"}`,
    `  周期: ${describeCadence(r)}（${r.startDate} から、${r.timeZone}）`,
    `  次回: ${r.nextOccurrence ?? "なし"}  前回: ${r.lastOccurrence ? `${r.lastOccurrence}${r.lastIssueId ? `（${r.lastIssueId}）` : ""}` : "なし"}`,
  ].join("\n");
}

function describeDetail(r: RecurringIssue): string {
  const lines = [describeRecurring(r)];
  if (r.template) lines.push(`  テンプレート: ${r.template}`);
  if (r.project) lines.push(`  Project: ${r.project}`);
  if (r.labels.length) lines.push(`  ラベル: ${r.labels.join(", ")}`);
  if (r.priority) lines.push(`  優先度: ${r.priority}`);
  if (r.assignee) lines.push(`  担当: ${r.assignee}`);
  if (r.description) lines.push("", r.description);
  return lines.join("\n");
}

function describeRun(r: RecurringRun): string {
  const verb = r.dryRun ? "起票する予定" : "起票しました";
  const lines = [`${verb}: ${r.items.length} 件`];
  for (const i of r.items) {
    const skipped = i.skipped ? `（前回から ${i.skipped} 回分は起票せずに飛ばします）` : "";
    lines.push(`  ${i.issueId ?? "-"}  ${i.occurrence} 分  #${i.recurringId} ${i.title}${skipped}`);
  }
  for (const f of r.failed) lines.push(`  失敗: #${f.recurringId} ${f.title}（${f.occurrence} 分）: ${f.message}`);
  if (r.dryRun) lines.push("（dry-run のため起票していません。起票するには --dry-run を外してください）");
  return lines.join("\n");
}

interface Options {
  title?: string;
  description?: string;
  template?: string;
  project?: string;
  label?: string[];
  priority?: number;
  assignee?: string;
  every?: RecurrenceCadence;
  weekday?: number;
  day?: number;
  start?: string;
  tz?: string;
  enable?: boolean;
  disable?: boolean;
}

function withRuleOptions(cmd: Command, update: boolean): Command {
  const clear = update ? "（空文字で外す）" : "";
  return cmd
    .option("--every <cadence>", "周期（daily / weekly / monthly）", parseCadence)
    .option("--weekday <day>", "毎週の曜日（mon〜sun、日〜土、0〜6）", parseWeekday)
    .option("--day <n>", "毎月の日（1〜31。その日が無い月は月末）", parseDay)
    .option("--start <date>", "開始日（YYYY-MM-DD）")
    .option("--tz <zone>", "発生日を決めるタイムゾーン（Asia/Tokyo のような IANA の名前。省くと実行環境のもの）")
    .option("-d, --description <text>", `起票する Issue の説明${clear}`)
    .option("--template <name>", `説明にするテンプレート（起票のたびに最新の本文を使う）${clear}`)
    .option("--project <name>", `Project${clear}`)
    .option("-l, --label <label>", update ? "ラベル（繰り返し可。指定したもので置き換える）" : "ラベル（繰り返し可）", collect)
    .option("--priority <priority>", PRIORITY_HELP, parsePriority)
    .option("--assignee <name>", `担当${clear}`);
}

function patchOf(o: Options): RecurringIssuePatch {
  if (o.enable && o.disable) throw new NodError("INVALID_ARGS", "--enable と --disable は同時に指定できません");
  return {
    title: o.title,
    description: orNull(o.description),
    template: orNull(o.template),
    projectRef: orNull(o.project),
    labels: o.label,
    priority: o.priority,
    assignee: orNull(o.assignee),
    cadence: o.every,
    weekday: o.weekday,
    monthDay: o.day,
    startDate: o.start,
    timeZone: o.tz,
    enabled: o.enable ? true : o.disable ? false : undefined,
  };
}

export function registerRecurringCommands(program: Command): void {
  const recurring = program
    .command("recurring")
    .description("定期Issue（毎日・毎週・毎月に起票する Issue）を管理・実行する。登録・変更・実行は人だけ（--dry-run は誰でも）")
    .addHelpText(
      "after",
      [
        "",
        "常駐はしません。nod recurring run か nod automation run を実行したときに、発生日が来ている定期Issueを起票します。",
        "前回から何回分も空いていても起票するのは最新の1件だけで、飛ばした回数を表示します。同じ発生日の Issue は二度作りません。",
        "例: nod recurring add 週次レビュー --every weekly --weekday mon --start 2026-10-05 --tz Asia/Tokyo --template review",
      ].join("\n"),
    );

  withRuleOptions(recurring.command("add <title>").description("定期Issueを登録する"), false)
    .option("--disabled", "停止した状態で登録する")
    .action(
      act((cli, cmd, title: string, o: Options & { disabled?: boolean }) => {
        if (!o.every) throw new NodError("INVALID_ARGS", "--every で周期（daily / weekly / monthly）を指定してください");
        if (!o.start) throw new NodError("INVALID_ARGS", "--start で開始日（YYYY-MM-DD）を指定してください");
        const r = addRecurringIssue(cli.ctx, currentWorkspace(cli, cmd).key, {
          title,
          description: o.description,
          template: o.template,
          projectRef: o.project,
          labels: o.label,
          priority: o.priority,
          assignee: o.assignee,
          cadence: o.every,
          weekday: o.weekday,
          monthDay: o.day,
          startDate: o.start,
          timeZone: o.tz,
          enabled: !o.disabled,
        });
        print(cli, r, () => `定期Issueを登録しました\n${describeRecurring(r)}`);
      }),
    );

  recurring
    .command("list")
    .description("現在の Workspace の定期Issueを一覧する")
    .action(
      act((cli, cmd) => {
        const list = listRecurringIssues(cli.db, currentWorkspace(cli, cmd).key);
        print(cli, list, () => (list.length ? list.map(describeRecurring).join("\n") : "定期Issueは登録されていません"));
      }),
    );

  recurring
    .command("show <id>")
    .description("定期Issueの設定を表示する")
    .action(
      act((cli, cmd, id: string) => {
        const r = getRecurringIssue(cli.db, currentWorkspace(cli, cmd).key, parseId(id));
        print(cli, r, () => describeDetail(r));
      }),
    );

  withRuleOptions(recurring.command("update <id>").description("定期Issueを変更する（指定した項目だけ）"), true)
    .option("--title <title>", "タイトル")
    .option("--enable", "再開する")
    .option("--disable", "停止する（停止中は起票しない）")
    .action(
      act((cli, cmd, id: string, o: Options) => {
        const patch = patchOf(o);
        if (Object.values(patch).every((v) => v === undefined)) {
          throw new NodError("INVALID_ARGS", "変更する項目を指定してください（nod recurring update --help）");
        }
        const r = updateRecurringIssue(cli.ctx, currentWorkspace(cli, cmd).key, parseId(id), patch);
        print(cli, r, () => `定期Issueを変更しました\n${describeRecurring(r)}`);
      }),
    );

  recurring
    .command("remove <id>")
    .description("定期Issueを削除する（起票済みの Issue は残る）")
    .action(
      act((cli, cmd, id: string) => {
        const r = removeRecurringIssue(cli.ctx, currentWorkspace(cli, cmd).key, parseId(id));
        print(cli, r, () => `定期Issueを削除しました: #${r.id} ${r.title}`);
      }),
    );

  recurring
    .command("run")
    .description("発生日が来ている定期Issueを今すぐ起票する（実行は人だけ。--dry-run は起票する予定を表示するだけ）")
    .option("--dry-run", "起票する予定を表示するだけで変更しない")
    .action(
      act((cli, cmd, o: { dryRun?: boolean }) => {
        const r = runRecurringIssues(cli.ctx, currentWorkspace(cli, cmd).key, { dryRun: o.dryRun });
        print(cli, r, () => describeRun(r));
      }),
    );
}
