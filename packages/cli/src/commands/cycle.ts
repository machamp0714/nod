import {
  clearCadence,
  createCycle,
  type CycleCadence,
  type CycleClock,
  cycleAnalytics,
  type CycleSummary,
  deleteCycle,
  getCadence,
  getCycle,
  listCycles,
  NodError,
  resolveCycle,
  setCadence,
  syncCycles,
  updateCycle,
} from "@nod/core";
import type { Command } from "commander";
import { act } from "../context";
import { formatIssueLines, print } from "../output";

const STATE_LABEL = { upcoming: "予定", current: "現在", completed: "終了" } as const;

function formatCycle(c: CycleSummary): string {
  const carry = c.state === "completed" && c.open > 0 ? `  持ち越し候補 ${c.open}` : c.open > 0 ? `  未完了 ${c.open}` : "";
  return `${c.id}  ${c.name}（${STATE_LABEL[c.state]}）  ${c.startDate}〜${c.endDate}  ${c.done}/${c.total}${carry}`;
}

function formatCadence(c: CycleCadence | null): string {
  if (!c) return "周期は未設定です";
  return `${c.weeks}週間ごと · 自動持ち越し ${c.autoCarryOver ? "ON" : "OFF"} · 次の名前 Cycle ${c.nextNumber}`;
}

function clockOf(o: { tz?: string }): CycleClock {
  return { tz: o.tz };
}

const TZ_HELP = "「現在」の判定に使うタイムゾーン（IANA の名前、既定はこのマシンのローカル）";

export function registerCycleCommands(program: Command): void {
  const cycle = program.command("cycle").description("全体の期間（Cycle／スプリント）を操作する。Cycle は期間を重ねられない");

  cycle
    .command("list")
    .description("Cycle を開始日の順に、進捗つきで一覧する")
    .option("--tz <zone>", TZ_HELP)
    .action(
      act((cli, _cmd, o: { tz?: string }) => {
        const list = listCycles(cli.db, clockOf(o));
        print(cli, list, () => (list.length ? list.map(formatCycle).join("\n") : "Cycle はありません"));
      }),
    );

  cycle
    .command("create <name>")
    .description("Cycle を作る（期間は両端の日を含む）")
    .requiredOption("--start <date>", "開始日 YYYY-MM-DD")
    .requiredOption("--end <date>", "終了日 YYYY-MM-DD")
    .option("--tz <zone>", TZ_HELP)
    .action(
      act((cli, _cmd, name: string, o: { start: string; end: string; tz?: string }) => {
        const created = createCycle(cli.ctx, { name, startDate: o.start, endDate: o.end }, clockOf(o));
        print(cli, created, () => `作りました: ${formatCycle(created)}`);
      }),
    );

  cycle
    .command("show <cycle>")
    .description("Cycle の進捗と Issue を表示する（<cycle> は ID・名前・current）")
    .option("--tz <zone>", TZ_HELP)
    .action(
      act((cli, _cmd, ref: string, o: { tz?: string }) => {
        // current が日付の変わり目で別の Cycle を指さないよう、ref は一度だけ解決する
        const id = String(resolveCycle(cli.db, ref, clockOf(o)).id);
        const c = getCycle(cli.db, id, clockOf(o));
        const a = cycleAnalytics(cli.db, id, clockOf(o));
        print(cli, { ...c, analytics: a }, () =>
          [
            formatCycle(c),
            `Scope ${a.scope}${a.scopeAdded ? `（開始後 ${a.scopeAdded > 0 ? "+" : ""}${a.scopeAdded}）` : ""}  Started ${a.started}  Completed ${a.completed}（${a.completedRate === null ? "—" : `${Math.round(a.completedRate * 100)}%`}）`,
            `担当: ${a.breakdown.assignees.map((r) => `${r.label} ${r.done}/${r.total}`).join("  ") || "なし"}`,
            `Workspace: ${a.breakdown.workspaces.map((r) => `${r.label} ${r.done}/${r.total}`).join("  ") || "なし"}`,
            `status: ${a.statuses.filter((s) => s.count > 0).map((s) => `${s.status} ${s.count}`).join("  ") || "なし"}`,
            "",
            "Issue:",
            ...formatIssueLines(c.issues).map((line) => `  ${line}`),
          ].join("\n"),
        );
      }),
    );

  cycle
    .command("update <cycle>")
    .description("Cycle の名前・期間を変える（所属 Issue は変えない）")
    .option("--name <name>", "名前")
    .option("--start <date>", "開始日 YYYY-MM-DD")
    .option("--end <date>", "終了日 YYYY-MM-DD")
    .option("--tz <zone>", TZ_HELP)
    .action(
      act((cli, _cmd, ref: string, o: { name?: string; start?: string; end?: string; tz?: string }) => {
        if (o.name === undefined && o.start === undefined && o.end === undefined) {
          throw new NodError("INVALID_ARGS", "--name、--start、--end のどれかを指定してください");
        }
        const updated = updateCycle(cli.ctx, ref, { name: o.name, startDate: o.start, endDate: o.end }, clockOf(o));
        print(cli, updated, () => `更新しました: ${formatCycle(updated)}`);
      }),
    );

  cycle
    .command("delete <cycle>")
    .description("Cycle を消す（所属 Issue は Cycle なしに戻る）")
    .option("--tz <zone>", TZ_HELP)
    .action(
      act((cli, _cmd, ref: string, o: { tz?: string }) => {
        const deleted = deleteCycle(cli.ctx, ref, clockOf(o));
        print(cli, deleted, () => `消しました: ${deleted.name}（Cycle から外れた Issue ${deleted.issues} 件）`);
      }),
    );

  const cadence = cycle.command("cadence").description("Cycle の周期を設定する。設定すると、今日を含む Cycle と次の1つを自動で作る");
  cadence
    .command("show")
    .description("周期の設定を表示する")
    .action(
      act((cli) => {
        const c = getCadence(cli.db);
        print(cli, c, () => formatCadence(c));
      }),
    );
  cadence
    .command("set")
    .description("周期を設定する（人だけ）。週数の変更は次に作る Cycle から反映する")
    .requiredOption("--weeks <n>", "周期の週数（1〜4）")
    .option("--carry-over", "終了した Cycle の未完了を次の Cycle へ自動で移す（既定）")
    .option("--no-carry-over", "自動では移さない")
    .option("--start <date>", "Cycle が1つもないときの最初の開始日 YYYY-MM-DD（既定は今日）")
    .option("--tz <zone>", TZ_HELP)
    .action(
      act((cli, cmd, o: { weeks: string; carryOver?: boolean; start?: string; tz?: string }) => {
        // どちらも指定しないとき commander は carryOver を true にするので、既存の設定を保つため undefined にする
        const carryOver = cmd.getOptionValueSource("carryOver") === "default" ? undefined : o.carryOver;
        const c = setCadence(cli.ctx, { weeks: Number(o.weeks), autoCarryOver: carryOver, anchorDate: o.start }, clockOf(o));
        syncCycles(cli.ctx, clockOf(o));
        print(cli, c, () => `設定しました: ${formatCadence(c)}`);
      }),
    );
  cadence
    .command("clear")
    .description("周期を外す（人だけ）。既存の Cycle は残る")
    .action(
      act((cli) => {
        clearCadence(cli.ctx);
        print(cli, { ok: true }, () => "周期を外しました");
      }),
    );
}
