import { getSprint, listSprints, sprintAnalytics, type Sprint } from "@nod/core";
import { configureScrumWorkspace, getScrumWorkspace, createSprint, updateSprint, addSprintCandidate, listSprintCandidates,
  proposeSprintPlan, listSprintPlans, acceptSprintPlan, activateSprint, cancelSprint, NodError,
  type ConfigureScrumWorkspaceInput, type CreateSprintInput, type UpdateSprintInput, type AddSprintCandidateInput,
  type ProposeSprintPlanInput, type AcceptSprintPlanInput, type SprintMutation, type CancelSprintInput } from "@nod/core";
import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { act, currentWorkspace, globalOpts } from "../context";
import { print } from "../output";

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
  sprint.command("create").description("期間・timezoneを指定して下書きを作る")
    .requiredOption("--input <file>","JSONファイルまたは -（stdin）。workspaceKey/expectedVersion:0/requestKey必須")
    .action(act((cli,cmd) => { const value=createSprint(cli.ctx,input<CreateSprintInput>(cmd)); print(cli,value,()=>line(value)); }));
  sprint.command("update <sprint>").description("準備中の期間・名前を更新する")
    .requiredOption("--input <file>","JSONファイルまたは -（stdin）。expectedVersion/requestKey必須")
    .action(act((cli,cmd,ref:string) => { const value=updateSprint(cli.ctx,ref,input<UpdateSprintInput>(cmd)); print(cli,value,()=>line(value)); }));
  const candidates = sprint.command("candidates").description("実行対象と分けて候補を扱う");
  candidates.command("list <sprint>").action(act((cli,_cmd,ref:string) => {
    const value=listSprintCandidates(cli.db,ref); print(cli,value,()=>value.map(i=>`${i.sourceIssueKey}  ${i.snapshot.issue.title}  ${i.id}`).join("\n"));
  }));
  candidates.command("add <sprint>").description("Issueを安定した候補itemへ追加する")
    .requiredOption("--input <file>","JSONファイルまたは -（stdin）。issueRef/expectedVersion/requestKey必須")
    .action(act((cli,cmd,ref:string) => { const value=addSprintCandidate(cli.ctx,ref,input<AddSprintCandidateInput>(cmd)); print(cli,value,()=>`候補 ${value.item.sourceIssueKey}（${value.item.id}）`); }));
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
        `分析（${analytics.statusBasis === "migration_snapshot" ? "移行取得時点の写し" : "採択Issueの現在状態"}）: Scope ${analytics.scope}  Started ${analytics.started}  Completed ${analytics.completed}`,
        detail.phase === "imported" ? "移行時の関連（状態は取得時点の写し）:" : "候補（採択と区別した登録時点の写し）:",
        ...detail.items.map(item=>`  ${item.sourceIssueKey}  ${item.snapshot.workspace.key}  ${item.snapshot.issue.status}  ${item.snapshot.issue.title}`),
        "取得済みの履歴:",
        ...detail.events.map(event=>`  #${event.original.id} ${event.original.created_at} ${event.original.type}（${event.association === "recorded" ? "確定関連" : "関連未確定"}） ${event.original.data}`),
      ].join("\n"));
    }));
}
