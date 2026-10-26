import { getSprint, listSprints, sprintAnalytics, type Sprint } from "@nod/core";
import type { Command } from "commander";
import { act, currentWorkspace, globalOpts } from "../context";
import { print } from "../output";

function line(sprint: Sprint): string {
  return `${sprint.number}  ${sprint.name}（${sprint.phase}）  ${sprint.startDate}〜${sprint.endDate}  ${sprint.id}`;
}

export function registerSprintCommands(program: Command): void {
  const sprint = program.command("sprint").description("Sprintと移行履歴を読む");
  sprint.command("list").description("全Sprintを共通番号順に表示する")
    .action(act((cli,cmd) => {
      const workspaceId = globalOpts(cmd).workspace ? currentWorkspace(cli,cmd).id : undefined;
      const rows = listSprints(cli.db,{workspaceId});
      print(cli,rows,()=>rows.length ? rows.map(line).join("\n") : "Sprintはありません");
    }));
  sprint.command("show <sprint>").description("UUIDまたは共通番号で履歴・写し・イベントを読む")
    .option("--tz <zone>", "旧履歴の日時を解釈するIANA timezone（未指定なら不明）")
    .action(act((cli,cmd,ref:string) => {
      const detail = getSprint(cli.db,ref);
      const analytics=sprintAnalytics(cli.db,detail.id,{timezone:(cmd.opts() as {tz?:string}).tz});
      print(cli,{...detail,analytics},()=>[
        line(detail),
        `Workspace: ${detail.workspaceId ?? "不明"}  タイムゾーン: ${detail.timezone ?? "不明"}`,
        `ゴール: ${detail.goal ?? "不明"}  DoD: ${detail.definitionOfDone ?? "不明"}  達成結果: ${detail.outcome ?? "不明"}`,
        `分析（${analytics.statusBasis === "migration_snapshot" ? "移行取得時点の写し" : "採択Issueの現在状態"}）: Scope ${analytics.scope}  Started ${analytics.started}  Completed ${analytics.completed}`,
        "移行時の関連（状態は取得時点の写し）:",
        ...detail.items.map(item=>`  ${item.sourceIssueKey}  ${item.snapshot.workspace.key}  ${item.snapshot.issue.status}  ${item.snapshot.issue.title}`),
        "取得済みの履歴:",
        ...detail.events.map(event=>`  #${event.original.id} ${event.original.created_at} ${event.original.type}（${event.association === "recorded" ? "確定関連" : "関連未確定"}） ${event.original.data}`),
      ].join("\n"));
    }));
}
