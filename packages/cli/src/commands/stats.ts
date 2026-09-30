import { type CompletionStats, completionStats, type LlmStats, llmStats, NodError, STATS_GRANULARITIES, type StatsGranularity, type StatsQuery, type WorkTime } from "@nod/core";
import type { Command } from "commander";
import { act, type Cli, currentWorkspace } from "../context";
import { print } from "../output";

interface StatsOptions {
  by?: string;
  from?: string;
  to?: string;
  tz?: string;
  project?: string;
  cycle?: string;
  allWorkspaces?: boolean;
}

function withStatsOptions(cmd: Command): Command {
  return cmd
    .option("--by <unit>", "期間の単位（day|week、既定は week）")
    .option("--from <date>", "開始日 YYYY-MM-DD（既定は 日=直近30日、週=直近12週）")
    .option("--to <date>", "終了日 YYYY-MM-DD（この日を含む、既定は今日）")
    .option("--tz <zone>", "期間の境界に使うタイムゾーン（IANA の名前、既定はこのマシンのローカル）")
    .option("--project <project>", "Project の名前か ID")
    .option("--cycle <cycle>", "Cycle の ID・名前・current（名前と current は Workspace を1つに絞ったとき）")
    .option("--all-workspaces", "すべての Workspace を集計する（既定は現在の Workspace）");
}

// stats と stats llm は同じオプションを持つ。どちらに書かれた値も拾うため、親の値と合わせて読む
function statsQuery(cli: Cli, cmd: Command): StatsQuery {
  const o = cmd.optsWithGlobals() as StatsOptions;
  if (o.by !== undefined && !STATS_GRANULARITIES.includes(o.by as StatsGranularity)) {
    throw new NodError("INVALID_ARGS", `--by には ${STATS_GRANULARITIES.join(" か ")} を指定してください（${o.by}）`);
  }
  return {
    by: o.by as StatsGranularity | undefined,
    from: o.from,
    to: o.to,
    tz: o.tz,
    project: o.project,
    cycle: o.cycle,
    workspace: o.allWorkspaces ? undefined : [currentWorkspace(cli, cmd).key],
  };
}

// Reviews の作業時間と同じ書き方にする
export function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "-";
  if (minutes === 0) return "1分未満";
  if (minutes < 60) return `${minutes}分`;
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

export function formatWork(w: WorkTime): string {
  return `中央値 ${formatMinutes(w.medianMinutes)}  合計 ${w.measured ? formatMinutes(w.totalMinutes) : "-"}  記録なし ${w.unrecorded}`;
}

function period(start: string, end: string): string {
  return start === end ? start : `${start}〜${end}`;
}

function formatCompletion(s: CompletionStats): string {
  return [
    `${s.from}〜${s.to}（${s.by === "day" ? "日" : "週"}ごと、${s.tz}）`,
    ...s.buckets.map((b) => `${period(b.start, b.end)}  完了 ${b.completed}  canceled ${b.canceled}  作業時間 ${formatWork(b.work)}`),
    `合計  完了 ${s.totals.completed}  canceled ${s.totals.canceled}  作業時間 ${formatWork(s.totals.work)}`,
  ].join("\n");
}

function formatLlm(s: LlmStats): string {
  const head = `${s.from}〜${s.to}（${s.by === "day" ? "日" : "週"}ごと、${s.tz}）`;
  if (!s.llms.length) return `${head}\nこの期間に LLM の作業はありません`;
  return [
    head,
    ...s.llms.flatMap((l) => [
      "",
      `${l.name}  完了 ${l.totals.completed}  担当開始 ${l.totals.assigned}  レビュー提出 ${l.totals.submitted}  作業時間 ${formatWork(l.totals.work)}`,
      ...l.buckets.map((b) => `  ${period(b.start, b.end)}  完了 ${b.completed}  担当開始 ${b.assigned}  レビュー提出 ${b.submitted}  作業時間 ${formatWork(b.work)}`),
    ]),
  ].join("\n");
}

export function registerStatsCommands(program: Command): void {
  const stats = withStatsOptions(
    program.command("stats").description("完了数と作業時間（着手からレビュー提出まで）の推移を集計する"),
  );
  withStatsOptions(
    stats.command("llm").description("LLM ごとの作業量（完了・担当開始・レビュー提出・作業時間）の推移を集計する"),
  ).action(
    act((cli, cmd) => {
      const result = llmStats(cli.db, statsQuery(cli, cmd));
      print(cli, result, () => formatLlm(result));
    }),
  );
  stats.action(
    act((cli, cmd) => {
      const stats = completionStats(cli.db, statsQuery(cli, cmd));
      print(cli, stats, () => formatCompletion(stats));
    }),
  );
}
