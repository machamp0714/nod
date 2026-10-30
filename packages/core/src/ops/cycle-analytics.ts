import type { Database } from "bun:sqlite";
import { NodError } from "../errors";
import type { SprintAnalytics, SprintClock, SprintDetail } from "../sprint-types";
import { type CycleBreakdownRow, type Status, STATUSES } from "../types";
import { dateFormatter } from "./stats";
import { addDays } from "./cycle-cadence";
import { type CycleClock } from "./cycles";
import { queryIssues } from "./issues";
import { getSprint, resolveLegacyCycle } from "./sprints";

export const STARTED_STATUSES: readonly Status[] = ["in_progress", "in_review"];
export interface SprintAnalyticsOptions { clock?: SprintClock; timezone?: string }

interface AnalysisIssue {
  status: string;
  assignee: string | null;
  labels: string[];
  project: {id: unknown; name: unknown} | null;
  workspace: string;
}

function breakdown(issues: AnalysisIssue[], values: (issue: AnalysisIssue) => [string,string][]): CycleBreakdownRow[] {
  const rows=new Map<string,CycleBreakdownRow>();
  for(const issue of issues) {
    if(issue.status === "canceled") continue;
    for(const [key,label] of values(issue)) {
      const row=rows.get(key) ?? {key,label,total:0,done:0};
      row.total++;
      if(issue.status === "done") row.done++;
      rows.set(key,row);
    }
  }
  return [...rows.values()].sort((a,b)=>b.total-a.total || a.label.localeCompare(b.label));
}

// importedの集計は移行時の写し。終了時の成果として表示しない。
export function sprintAnalytics(db: Database, ref: string, options: SprintAnalyticsOptions = {}): SprintAnalytics {
  const sprint=getSprint(db,ref);
  const imported=sprint.phase === "imported";
  const timezone=sprint.timezone ?? options.timezone ?? null;
  // 不明な旧timezoneを実行マシンのローカルで補完しない。
  if (timezone !== null) dateFormatter(timezone);
  const burnup=imported && timezone ? historyDays(sprint,timezone,options.clock ?? {}) : [];
  const issues: AnalysisIssue[] = imported
    ? sprint.items.filter(item=>!item.snapshot.issue.archived_at).map(item=>({
      status:item.snapshot.issue.status, assignee:typeof item.snapshot.issue.assignee === "string" ? item.snapshot.issue.assignee : null,
      labels:item.snapshot.labels, project:item.snapshot.project as AnalysisIssue["project"], workspace:item.snapshot.workspace.key,
    }))
    : queryIssues(db,{sprint:sprint.id}).issues.map(issue=>({...issue,workspace:issue.workspace}));
  const statuses=STATUSES.map(status=>({status,count:issues.filter(issue=>issue.status===status).length}));
  const count=(status:string)=>statuses.find(row=>row.status===status)?.count ?? 0;
  const scope=issues.filter(issue=>issue.status!=="canceled").length;
  const started=STARTED_STATUSES.reduce((total,status)=>total+count(status),0); const completed=count("done");
  return {
    sprintId:sprint.id,number:sprint.number,statusBasis:imported ? "migration_snapshot" : "live_adopted",capturedAt:sprint.legacy?.capturedAt ?? null,
    scope,started,completed,startedRate:scope ? started/scope : null,completedRate:scope ? completed/scope : null,
    scopeAdded:burnup.length && burnup[0]!.scope !== null && burnup.at(-1)!.scope !== null
      ? burnup.at(-1)!.scope! - burnup[0]!.scope! : null,burnup,statuses,
    breakdown:{
      assignees:breakdown(issues,i=>[[i.assignee ?? "",i.assignee ?? "担当なし"]]),
      labels:breakdown(issues,i=>i.labels.map(label=>[label,label])),
      projects:breakdown(issues,i=>[[String(i.project?.id ?? ""),String(i.project?.name ?? "Project なし")]]),
      workspaces:breakdown(issues,i=>[[i.workspace,i.workspace]]),
    },
    history:{timezone,timezoneBasis:sprint.timezone ? "recorded" : options.timezone ? "requested" : "unknown",unavailableReason:!imported ? "not_recorded" : timezone ? null : "timezone_unknown",
      recordedEventIds:sprint.events.filter(e=>e.association==='recorded').map(e=>e.original.id),
      ambiguousEventIds:sprint.events.filter(e=>e.association==='ambiguous').map(e=>e.original.id)},
  };
}

// 日次の所属・状態は取得済みのイベントだけから読む。写しを開始日に逆投影しない。
function historyDays(sprint: SprintDetail, timezone: string, clock: SprintClock): SprintAnalytics["burnup"] {
  const localDate=dateFormatter(timezone);
  const today=localDate.format(clock.now ?? new Date());
  const last=sprint.endDate < today ? sprint.endDate : today;
  if(last < sprint.startDate) return [];
  const timelines=sprint.evidence.filter(e=>!e.snapshot.issue.archived_at).map(evidence=> {
    const events=sprint.events.filter(e=>e.original.issue_id===evidence.sourceIssueId)
      .sort((a,b)=>Date.parse(a.original.created_at)-Date.parse(b.original.created_at) || a.original.id-b.original.id);
    // 存在が確定したcreatedより前だけは未作成と判断できる。
    let member: boolean | null = events.some(e=>e.original.type==='created' && e.association==='recorded') ? false : null;
    let status: Status | null = null;
    const timeline: {date:string;member:boolean|null;status:Status|null}[]=[{date:'0000-01-01',member,status}];
    for(const event of events) {
      const data=JSON.parse(event.original.data) as Record<string,unknown>;
      if(event.original.type==='created') {
        // 状態の記録は期間作成前も利用する。所属は作成後の明示IDだけで確定する。
        if(event.association==='recorded') member=data.cycle_id===sprint.legacyCycleId;
        status=STATUSES.includes(data.status as Status) ? data.status as Status : null;
      } else if(event.original.type==='cycle_changed' && event.association==='recorded' && 'to_id' in data) {
        member=data.to_id===sprint.legacyCycleId;
      } else if(event.original.type==='status_changed') {
        status=STATUSES.includes(data.to as Status) ? data.to as Status : null;
      }
      timeline.push({date:localDate.format(new Date(event.original.created_at)),member,status});
    }
    return timeline;
  });
  const days: SprintAnalytics["burnup"]=[];
  for(let date=sprint.startDate;date<=last;date=addDays(date,1)) {
    let scope=0,started=0,completed=0,unknown=0;
    for(const timeline of timelines) {
      const state=timeline.filter(s=>s.date<=date).at(-1)!;
      if(state.member===false) continue;
      if(state.member===null || state.status===null) { unknown++; continue; }
      if(state.status==='canceled') continue;
      scope++;
      if(STARTED_STATUSES.includes(state.status)) started++;
      if(state.status==='done') completed++;
    }
    days.push({date,scope:unknown ? null : scope,started:unknown ? null : started,completed:unknown ? null : completed,unknown});
  }
  return days;
}

// 旧ID専用の読取。新しいSprint番号として解決し直さない。
export function cycleAnalytics(db: Database, ref: string, clock: CycleClock = {}): SprintAnalytics {
  if(!/^[1-9]\d*$/.test(ref)) throw new NodError("INVALID_ARGS","旧Cycle IDは正の整数で指定してください。SprintのUUID・共通番号はSprint APIを利用してください");
  const resolved=resolveLegacyCycle(db,Number(ref));
  if(resolved.kind==='deleted') throw new NodError("LEGACY_CYCLE_DELETED",`旧Cycle ${ref} は削除済みです`);
  if(resolved.kind==='not_found') throw new NodError("NOT_FOUND",`旧Cycle ${ref} の移行対応はありません`);
  return sprintAnalytics(db,resolved.sprintId,{timezone:clock.tz,clock:{now:clock.now}});
}
