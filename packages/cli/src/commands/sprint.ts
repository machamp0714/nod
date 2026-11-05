import { getSprint, listSprints, sprintAnalytics, type Sprint } from "@nod/core";
import { configureScrumWorkspace, getScrumWorkspace, createSprint, updateSprint, addIssueToSprint, removeIssueFromSprint,
  proposeSprintPlan, listSprintPlans, acceptSprintPlan, activateSprint, cancelSprint, NodError,
  type ConfigureScrumWorkspaceInput, type CreateSprintInput, type UpdateSprintInput,
  type ProposeSprintPlanInput, type AcceptSprintPlanInput, type SprintMutation, type CancelSprintInput } from "@nod/core";
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { act, currentWorkspace, globalOpts } from "../context";
import { print } from "../output";
import { registerSprintExecutionCommands } from "./sprint-execution";

const ASSOCIATION_LABEL = { imported: "移行", adopted: "採択", added: "追加", none: "所属外" } as const;

function line(sprint: Sprint): string {
  return `${sprint.number}  ${sprint.name}（${sprint.phase}）  ${sprint.startDate}〜${sprint.endDate}  ${sprint.id}`;
}

// 全書込みで版とrequestKeyをJSONに含める。- はstdin。
function input<T>(cmd: Command): T {
  const file = (cmd.opts() as {input:string}).input;
  let text: string;
  try { text = readFileSync(file === "-" ? 0 : file,"utf8"); }
  catch { throw new NodError("FILE_NOT_FOUND","JSON入力を読み込めません"); }
  try { return JSON.parse(text) as T; }
  catch { throw new NodError("INVALID_ARGS","入力をJSONとして読めません"); }
}

export function registerSprintCommands(program: Command): void {
  const scrum = program.command("scrum").description("Workspaceの方向設定");
  scrum.command("show").description("Workspaceの問題・目標・優先順位を読む")
    .action(act((cli,cmd) => {
      const value = getScrumWorkspace(cli.db,currentWorkspace(cli,cmd).key);
      print(cli,value,()=>`Sprint運用: ${value.enabled ? "有効" : "無効"}（版${value.version}）\n問題: ${value.problem ?? "未設定"}\n目標: ${value.productGoal ?? "未設定"}\n優先順位: ${value.priorityRationale ?? "未設定"}`);
    }));
  scrum.command("configure").description("人がWorkspaceの方向を設定する")
    .requiredOption("--input <file>","JSONファイルまたは -（stdin）。expectedVersion/requestKey必須")
    .action(act((cli,cmd) => {
      const value = configureScrumWorkspace(cli.ctx,currentWorkspace(cli,cmd).key,input<ConfigureScrumWorkspaceInput>(cmd));
      print(cli,value,()=>`Workspaceの方向を保存しました（版${value.version}）`);
    }));
  const sprint = program.command("sprint").description("Sprintを計画・合意・開始し、履歴を読む");
  registerSprintExecutionCommands(sprint);
  sprint.command("create").description("期間・timezoneを指定して下書きを作る")
    .requiredOption("--input <file>","JSONファイルまたは -（stdin）。workspaceKey/expectedVersion:0/requestKey必須")
    .action(act((cli,cmd) => { const value=createSprint(cli.ctx,input<CreateSprintInput>(cmd)); print(cli,value,()=>line(value)); }));
  sprint.command("update <sprint>").description("準備中の期間・名前を更新する")
    .requiredOption("--input <file>","JSONファイルまたは -（stdin）。expectedVersion/requestKey必須")
    .action(act((cli,cmd,ref:string) => { const value=updateSprint(cli.ctx,ref,input<UpdateSprintInput>(cmd)); print(cli,value,()=>line(value)); }));
  sprint.command("add <sprint> <issue>").description("IssueをSprintへ追加し、その時点で所属にする（人の合意・計画の再承認は不要）")
    .action(act((cli,_cmd,ref:string,issueRef:string) => {
      const value=addIssueToSprint(cli.ctx,ref,{issueRef});
      print(cli,value,()=>`${value.added ? "追加しました" : "既に所属しています"}: Sprint ${value.sprint.number}「${value.sprint.name}」 ${value.item.sourceIssueKey}`);
    }));
  sprint.command("remove <sprint> <issue>").description("IssueのSprintへの追加の記録を外す（採択された所属は外せない。所属でなければ何もしない）")
    .action(act((cli,_cmd,ref:string,issueRef:string) => {
      const value=removeIssueFromSprint(cli.ctx,ref,{issueRef});
      print(cli,value,()=>`${value.removed ? "外しました" : "所属ではありません（何もしていません）"}: Sprint ${value.sprint.number}「${value.sprint.name}」 ${value.item?.sourceIssueKey ?? issueRef}`);
    }));
  const plan = sprint.command("plan").description("追記する計画の版と合意");
  plan.command("list <sprint>").action(act((cli,_cmd,ref:string) => {
    const value=listSprintPlans(cli.db,ref); print(cli,value,()=>value.map(p=>`第${p.revision}版 ${p.agreedAt ? "合意済み" : "未合意"} ${p.id} ${p.contentHash}`).join("\n"));
  }));
  plan.command("propose <sprint>").description("ゴール・採択理由・DoD・制約を持つ計画を提案する")
    .requiredOption("--input <file>","JSONファイルまたは -（stdin）。expectedVersion/requestKey必須")
    .action(act((cli,cmd,ref:string) => { const value=proposeSprintPlan(cli.ctx,ref,input<ProposeSprintPlanInput>(cmd)); print(cli,value,()=>`計画第${value.plan.revision}版 ${value.plan.id}\nhash: ${value.plan.contentHash}`); }));
  plan.command("accept <sprint> <plan>").description("人が対象の計画版とhashに合意する")
    .requiredOption("--input <file>","JSONファイルまたは -（stdin）。contentHash/expectedVersion/requestKey必須")
    .action(act((cli,cmd,ref:string,planId:string) => { const value=acceptSprintPlan(cli.ctx,ref,planId,input<AcceptSprintPlanInput>(cmd)); print(cli,value,()=>`計画第${value.plan.revision}版に合意しました（Sprint版${value.sprint.version}）`); }));
  sprint.command("activate <sprint>").description("人が合意済みSprintを期間内に開始する")
    .requiredOption("--input <file>","JSONファイルまたは -（stdin）。expectedVersion/requestKey必須")
    .action(act((cli,cmd,ref:string) => { const value=activateSprint(cli.ctx,ref,input<SprintMutation>(cmd)); print(cli,value,()=>`${line(value)}\nSprintを開始しました。PMの起動は別操作です。`); }));
  sprint.command("cancel <sprint>").description("人が理由を残してSprintを中止する")
    .requiredOption("--input <file>","JSONファイルまたは -（stdin）。reason/expectedVersion/requestKey必須")
    .action(act((cli,cmd,ref:string) => { const value=cancelSprint(cli.ctx,ref,input<CancelSprintInput>(cmd)); print(cli,value,()=>`${line(value)}\n中止理由: ${value.cancelReason}`); }));
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
        `版: ${detail.version}  採用中の計画: ${detail.adoptedPlanId ?? "なし"}`,
        ...detail.plans.map(p=>`計画第${p.revision}版 ${p.agreedAt ? "合意済み" : "未合意"} ${p.id} ${p.contentHash}\n  達成確認: ${p.content.verificationMethod}\n  理由: ${p.changeReason}`),
        `分析（${analytics.statusBasis === "migration_snapshot" ? "移行取得時点の写し" : "所属 Issue の現在状態"}）: Scope ${analytics.scope}  Started ${analytics.started}  Completed ${analytics.completed}`,
        detail.phase === "imported" ? "移行時の関連（状態は取得時点の写し）:" : "item（所属は移行・採択・追加。旧候補と解除済みは所属外）:",
        ...detail.items.map(item=>`  ${item.sourceIssueKey}  ${item.snapshot.workspace.key}  ${item.snapshot.issue.status}  ${item.snapshot.issue.title}  ${ASSOCIATION_LABEL[item.association ?? "none"]}${item.addedBy ? `（追加者: ${item.addedBy}）` : ""}`),
        "取得済みの履歴:",
        ...detail.events.map(event=>`  #${event.original.id} ${event.original.created_at} ${event.original.type}（${event.association === "recorded" ? "確定関連" : "関連未確定"}） ${event.original.data}`),
      ].join("\n"));
    }));
}
