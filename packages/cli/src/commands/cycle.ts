import {
  createCycle,
  type CycleClock,
  type CycleSummary,
  deleteCycle,
  getCycle,
  listCycles,
  moveOpenIssues,
  NodError,
  updateCycle,
} from "@nod/core";
import type { Command } from "commander";
import { act, currentWorkspace } from "../context";
import { formatIssueLines, print } from "../output";

const STATE_LABEL = { upcoming: "予定", current: "現在", completed: "終了" } as const;

function formatCycle(c: CycleSummary): string {
  const carry = c.state === "completed" && c.open > 0 ? `  持ち越し候補 ${c.open}` : c.open > 0 ? `  未完了 ${c.open}` : "";
  return `${c.id}  ${c.name}（${STATE_LABEL[c.state]}）  ${c.startDate}〜${c.endDate}  ${c.done}/${c.total}${carry}`;
}

function clockOf(o: { tz?: string }): CycleClock {
  return { tz: o.tz };
}

const TZ_HELP = "「現在」の判定に使うタイムゾーン（IANA の名前、既定はこのマシンのローカル）";

export function registerCycleCommands(program: Command): void {
  const cycle = program.command("cycle").description("Workspace の期間（Cycle／スプリント）を操作する。同じ Workspace の Cycle は期間を重ねられない");

  cycle
    .command("list")
    .description("現在の Workspace の Cycle を開始日の順に、進捗つきで一覧する")
    .option("--tz <zone>", TZ_HELP)
    .action(
      act((cli, cmd, o: { tz?: string }) => {
        const list = listCycles(cli.db, currentWorkspace(cli, cmd).id, clockOf(o));
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
      act((cli, cmd, name: string, o: { start: string; end: string; tz?: string }) => {
        const created = createCycle(
          cli.ctx,
          { workspaceId: currentWorkspace(cli, cmd).id, name, startDate: o.start, endDate: o.end },
          clockOf(o),
        );
        print(cli, created, () => `作りました: ${formatCycle(created)}`);
      }),
    );

  cycle
    .command("show <cycle>")
    .description("Cycle の進捗と Issue を表示する（<cycle> は ID・名前・current）")
    .option("--tz <zone>", TZ_HELP)
    .action(
      act((cli, cmd, ref: string, o: { tz?: string }) => {
        const c = getCycle(cli.db, currentWorkspace(cli, cmd).id, ref, clockOf(o));
        print(cli, c, () =>
          [
            formatCycle(c),
            ...(c.state === "completed" && c.open > 0
              ? ["", `未完了 ${c.open} 件は自動では移りません。nod cycle move-open ${c.id} --to <cycle> で移せます`]
              : []),
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
      act((cli, cmd, ref: string, o: { name?: string; start?: string; end?: string; tz?: string }) => {
        if (o.name === undefined && o.start === undefined && o.end === undefined) {
          throw new NodError("INVALID_ARGS", "--name、--start、--end のどれかを指定してください");
        }
        const updated = updateCycle(
          cli.ctx,
          currentWorkspace(cli, cmd).id,
          ref,
          { name: o.name, startDate: o.start, endDate: o.end },
          clockOf(o),
        );
        print(cli, updated, () => `更新しました: ${formatCycle(updated)}`);
      }),
    );

  cycle
    .command("delete <cycle>")
    .description("Cycle を消す（所属 Issue は Cycle なしに戻る）")
    .option("--tz <zone>", TZ_HELP)
    .action(
      act((cli, cmd, ref: string, o: { tz?: string }) => {
        const deleted = deleteCycle(cli.ctx, currentWorkspace(cli, cmd).id, ref, clockOf(o));
        print(cli, deleted, () => `消しました: ${deleted.name}（Cycle から外れた Issue ${deleted.issues} 件）`);
      }),
    );

  cycle
    .command("move-open <from>")
    .description("未完了（done・canceled 以外）の Issue を別の Cycle へまとめて移す。終了した Cycle の持ち越しは自動では行わない")
    .requiredOption("--to <cycle>", "移動先の Cycle（ID・名前・current）")
    .option("--tz <zone>", TZ_HELP)
    .action(
      act((cli, cmd, from: string, o: { to: string; tz?: string }) => {
        const result = moveOpenIssues(cli.ctx, currentWorkspace(cli, cmd).id, from, o.to, clockOf(o));
        print(cli, result, () =>
          result.moved.length
            ? `${result.moved.length} 件を ${result.from.name} から ${result.to.name} へ移しました: ${result.moved.join(", ")}`
            : `${result.from.name} に未完了の Issue はありません`,
        );
      }),
    );
}
