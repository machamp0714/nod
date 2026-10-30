import { SprintEditConflict } from "./SprintEditConflict";
import { useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { SprintDetail, SprintPlan } from "@nod/core";
import { errorMessage } from "../../api/errors";
import { useSprintPlanningStatus, useSprintFlow, useSprintCommand } from "../../api/hooks/sprint-planning";
import { useIssueRows } from "../../api/hooks/issues";
import { useSprints } from "../../api/hooks/sprints";
import { ProjectViewSwitch, ProjectFlowSection, type ProjectView } from "../projects/ProjectFlow";
import { BlockedFilter } from "../issue-list/FilterBar";
import { IssueList } from "../issue-list/IssueList";
import { Button, PageHeader, PageTitle, Spacer } from "../ui";
import type { IssueListSearch } from "../../routes/search";
import { SprintPlanEditor } from "./SprintPlanEditor";
import s from "./sprint-planning.module.css";

export function PlanSummary({ plan, label }: { plan: SprintPlan; label: string }) {
  return <section className={s.section} aria-label={label}>
    <h2>計画 第{plan.revision}版 · {plan.agreedHash === plan.contentHash && plan.agreedAt ? "合意済み" : "未合意"}</h2>
    <p><strong>{plan.content.goal}</strong></p><p>達成の確認：{plan.content.verificationMethod}</p>
    <p>期間：{plan.content.period.startDate} – {plan.content.period.endDate} · {plan.content.period.timezone}</p>
    <p>稼働曜日：{plan.content.period.workingDays.map(day => "日月火水木金土"[day]).join("・")}</p>
    <div><h3>完成の定義</h3>{plan.content.definitionOfDone.map(dod => <p key={dod.id}>{dod.text}</p>)}</div>
    <p>実行範囲：{plan.content.constraints.executionScope} / 並行上限：{plan.content.constraints.maxParallel}</p>
    <p>制約：{plan.content.constraints.notes}</p>
    <p>{[plan.content.constraints.executionTarget, plan.content.constraints.model, plan.content.constraints.effort].filter(Boolean).join(" / ")}</p>
    <p>変更理由：{plan.changeReason}</p>
    <p className={s.hash}>hash: {plan.contentHash}</p>
    <p className={s.muted}>提案：{plan.createdBy} / {plan.createdAt}</p>
    {plan.agreedAt && <p>第{plan.revision}版に合意済み · {plan.agreedBy} / {plan.agreedAt}{plan.agreementSource && ` / 出典：${plan.agreementSource.source} / 原文：${plan.agreementSource.quote}`}</p>}
  </section>;
}

export function SprintPlanning({ sprint, search, onSearchChange, onBack, onOutcomes, onRetrospective, onActivated, view, onViewChange, readError, lastCheckedAt, onRetry }: {
  sprint: SprintDetail; readError?: unknown; lastCheckedAt: number; onRetry: () => void; view: ProjectView; onViewChange: (view: ProjectView) => void; search: IssueListSearch; onSearchChange: (patch: IssueListSearch) => void; onBack: () => void; onOutcomes: () => void; onRetrospective: () => void; onActivated: () => void;
}) {
  const switchFocus = useRef(false);
  const [editing, setEditing] = useState(false);
  const [candidateRef, setCandidate] = useState("");
  const [showCandidates, setCandidates] = useState(false);
  const [viewedId, setViewedId] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [quote, setQuote] = useState("");
  const [periodEdit, setPeriodEdit] = useState(false);
  const [message, setMessage] = useState("");
  const command = useSprintCommand();
  const allRows = useIssueRows({ workspace: sprint.workspaceSnapshot ? [sprint.workspaceSnapshot.key] : undefined, blocked: search.blocked }, view === "list");
  const sprints = useSprints();
  const availability = useSprintPlanningStatus(sprint.id);
  const editorButton = useRef<HTMLButtonElement>(null);
  const latest = sprint.plans.at(-1);
  const adopted = sprint.plans.find(p => p.id === sprint.adoptedPlanId && p.agreedBy === "me" && p.agreedAt && p.agreedHash === p.contentHash);
  const started = sprint.activatedAt !== null;
  const plan = started ? adopted : sprint.plans.find(p => p.id === viewedId) ?? latest;
  const flow = useSprintFlow(sprint.id, plan?.id ?? null, view === "flow");
  const proposal = latest && latest.id !== adopted?.id ? latest : null;
  const writable = ["draft", "ready", "active"].includes(sprint.phase) && sprint.workspaceId !== null;
  const currentItemIds = new Set(plan?.content.items.map(item => item.itemId) ?? []);
  const keys = new Set(sprint.items.filter(item => showCandidates ? !currentItemIds.has(item.id) : currentItemIds.has(item.id)).map(item => item.sourceIssueKey));
  const rows = allRows.rows.filter(row => keys.has(row.issue.id));
  const otherActive = sprints.data?.find(item => item.workspaceId === sprint.workspaceId && item.id !== sprint.id && item.phase === "active");
  async function run(path: string, body: Record<string, unknown>, success: string) {
    setMessage("");
    try { await command.run(`/sprints/${sprint.id}${path}`, { expectedVersion: sprint.version, ...body }); setMessage(success); return true; } catch { return false; }
  }
  const agree = (target: SprintPlan) => <section className={s.section} aria-label="合意と開始">
    <p>合意対象：第{target.revision}版 / hash <span className={s.hash}>{target.contentHash}</span></p>
    <p>ゴール・期間・採択{target.content.items.length}件・完成の定義・制約を確認して合意します。</p>
    <label className={s.field}>合意の出典（任意）<input value={source} onChange={e => setSource(e.target.value)} disabled={command.isPending} /></label>
    <label className={s.field}>合意原文（出典を使う場合）<textarea value={quote} onChange={e => setQuote(e.target.value)} disabled={command.isPending} /></label>
    <Button variant="primary" disabled={command.isPending || (!!source !== !!quote)} onClick={() => void run(`/plans/${target.id}/accept`, { contentHash: target.contentHash, ...(source && quote ? { agreementSource: { source, quote } } : {}) }, `計画 第${target.revision}版への合意を記録しました`)}>{command.isPending ? "保存中…" : "この計画に合意する"}</Button>
    <p className={s.muted}>内容を変えた案へ過去の合意は適用しません。同内容の記録済み合意は再利用されます。</p>
  </section>;
  const readFailure = readError ? <p role="alert" className={s.error}>計画の再取得に失敗しました。最後の確認：{new Date(lastCheckedAt).toLocaleString("ja-JP")}。<Button onClick={onRetry}>再読み込み</Button></p> : null;
  const intro = <>{readFailure}
    <div className={s.bar}><Button onClick={onBack}>タスク一覧</Button><strong>計画</strong><Spacer />
      {!started && sprint.plans.length > 0 && <label className={s.field}>表示する計画<select value={plan?.id ?? ""} onChange={e => setViewedId(e.target.value)}>{sprint.plans.map(p => <option key={p.id} value={p.id}>第{p.revision}版 {p.agreedAt ? "合意済み" : "未合意"}</option>)}</select></label>}
    </div>
    {command.error && <p role="alert" className={s.error}>保存できませんでした。入力は保持しています：{errorMessage(command.error)}。同じ操作から再試行できます。</p>}
    {message && <p role="status" className={s.bar}>{message}</p>}
    <div className={`${s.body} ${s.columns}`}>
      <div className={s.main}>
        {plan ? <PlanSummary plan={plan} label="表示中の計画" /> : <section className={s.section}><h2>計画はまだありません</h2><p>候補を追加してゴールと採択予定を提案してください。</p></section>}
        <section className={s.section}><p>{started ? "有効な合意済み計画の採択集合を表示します。未合意の追加案は含みません。" : "採択予定・開始前。合意して開始するまでは実行されません。"}</p>
          {plan?.content.items.map(item => <details key={item.itemId}><summary>{sprint.items.find(i => i.id === item.itemId)?.sourceIssueKey ?? "削除されたIssue"}の貢献と実行計画</summary><p>採択理由・ゴールへの貢献：{item.contribution}</p><p>実行計画：{item.executionPlan}</p><p>合意時の要求：{item.requirement.title}</p><p>{item.requirement.description}</p></details>)}
        </section>
        {writable && <section className={s.section}><div className={s.controls}><Button ref={editorButton} disabled={command.isPending} onClick={() => setEditing(true)}>計画案を編集</Button>{!started && <Button disabled={command.isPending} onClick={() => setPeriodEdit(value => !value)}>期間を編集</Button>}</div>
          <form className={s.controls} aria-label="候補の追加" onSubmit={e => { e.preventDefault(); if (command.isPending) return; void run("/candidates", { issueRef: candidateRef }, "候補に追加しました。採択は計画案で選びます。").then(ok => { if (ok) setCandidate(""); }); }}>
            <label className={s.field}>候補に追加するIssue<input required value={candidateRef} onChange={e => setCandidate(e.target.value)} disabled={command.isPending} placeholder="AAA-1" /></label>
            <Button type="submit" disabled={command.isPending}>{command.isPending ? "保存中…" : "候補に追加"}</Button>
          </form>
        </section>}
        {periodEdit && !started && <PeriodEditor sprint={sprint} onSaved={() => setPeriodEdit(false)} />}
      </div>
      <aside className={s.aside}>
        {started && proposal && <><PlanSummary plan={proposal} label="未合意の変更案" /><div className={s.notice}>変更案は採択集合へ反映しません。追加・除外と変更理由を確認して、この版へ合意してください。</div>
          <section className={s.section}><h3>採択範囲の変更</h3><p>追加：{proposal.content.items.filter(i => !adopted?.content.items.some(a => a.itemId === i.itemId)).map(i => sprint.items.find(a => a.id === i.itemId)?.sourceIssueKey).join("・") || "なし"}</p><p>除外：{adopted?.content.items.filter(i => !proposal.content.items.some(a => a.itemId === i.itemId)).map(i => sprint.items.find(a => a.id === i.itemId)?.sourceIssueKey).join("・") || "なし"}</p></section>
          {writable && !proposal.agreedAt && agree(proposal)}</>}
        {!started && writable && plan?.id === latest?.id && !plan?.agreedAt && plan && agree(plan)}
        {!started && <section className={s.section} aria-label="開始条件">
          <h2>合意と開始</h2><p>{sprint.phase === "ready" && adopted ? `第${adopted.revision}版に合意済み` : "合意済みの最新計画が必要です"}</p>
          {otherActive && <p className={s.notice}>{otherActive.name}が同じWorkspaceで実行中です。開始できません。</p>}
          {availability.error ? <p role="alert">開始条件を取得できません：{errorMessage(availability.error)} <Button onClick={() => void availability.refetch()}>再読み込み</Button></p> : availability.data && <p role="status">{availability.data.reason?.message ?? "開始条件を満たしています"} / 確認：{availability.data.observedAt}</p>}
          <p className={s.muted}>期間内・有効なWorkspace設定・同Workspaceに他の実行中Sprintがない場合に開始できます。保存時に最新条件を確認します。</p>
          <Button variant="primary" disabled={command.isPending || sprint.phase !== "ready" || !!otherActive || !availability.data?.canStart || !!availability.error || availability.data.sprintVersion !== sprint.version} onClick={() => void run("/activate", {}, "Sprintを開始しました。監督・workerの状態は保存された実行記録で確認してください。").then(ok => { if (ok) onActivated(); })}>{command.isPending ? "保存中…" : "Sprintを開始する"}</Button>
        </section>}
        {started && <section className={s.section}><h2>開始後の状態</h2><p>開始：{sprint.activatedAt}</p><p>期間は固定されています。保存された監督・workerの実行記録はタスク一覧で確認できます。</p></section>}
        <section className={s.section}><h2>計画の版と合意の記録</h2>{sprint.plans.map(p => <details key={p.id}><summary>第{p.revision}版 · {p.agreedAt ? "合意済み" : "未合意"}{p.id === sprint.adoptedPlanId && " · 採用中"}</summary><PlanSummary plan={p} label={`過去の計画 第${p.revision}版`} /></details>)}</section>
      </aside>
    </div>
  </>;
  if (editing) return <div className={s.page}><PageHeader><PageTitle>{sprint.name} · 計画案</PageTitle></PageHeader><SprintPlanEditor sprint={sprint} plan={latest} onClose={() => { setEditing(false); requestAnimationFrame(() => editorButton.current?.focus()); }} onSaved={() => { setEditing(false); setViewedId(null); setCandidates(false); requestAnimationFrame(() => editorButton.current?.focus()); }} /></div>;
  const heading = <div className={s.bar}><strong>{showCandidates && view === "list" ? "候補（未採択）" : started ? "採択済みのIssue" : "採択予定のIssue"} · {view === "flow" ? plan?.content.items.length ?? 0 : keys.size}件</strong>
    {view === "list" && <><Button aria-pressed={!showCandidates} onClick={() => setCandidates(false)}>採択{started ? "済み" : "予定"}</Button><Button aria-pressed={showCandidates} onClick={() => setCandidates(true)}>候補</Button></>}
    <Spacer /><ProjectViewSwitch value={view} onChange={onViewChange} focusOnMount={switchFocus} /></div>;
  if (view === "flow") return <div className={s.page}><PageHeader><PageTitle>{sprint.name} · 計画</PageTitle><Spacer /><Button aria-pressed>計画</Button><Button onClick={onOutcomes}>成果と評価</Button><Button onClick={onRetrospective}>振り返り</Button></PageHeader>{readFailure}
    <div className={s.bar}><Button onClick={onBack}>タスク一覧</Button><strong>{plan?.content.goal ?? "計画なし"}</strong><span>計画 第{plan?.revision ?? "—"}版 · {plan?.agreedAt ? "合意済み" : "未合意"} · {sprint.startDate} – {sprint.endDate}</span></div>
    {heading}<div className={s.body}><ProjectFlowSection flow={flow} beforeStart={!started} externalLabel="Sprint外・参照のみ" observedAt={flow.data?.observedAt}
      scopeNote={`${started ? "有効な合意済み計画" : "表示中の計画案"} 第${plan?.revision ?? "—"}版の採択${started ? "済み" : "予定"}${plan?.content.items.length ?? 0}件。候補・未合意の追加は含みません。一覧の検索・絞り込み・一括操作は適用されません。Sprint外の前提は参照のみで採択件数に含めません。表示だけでは採択・合意・着手は更新されません。`} />
      {!started && <p className={s.notice}>計画の合意・Sprintの開始を待っています。依存に問題がなくても開始前は着手しません。</p>}
      {flow.data?.missingItems.length ? <p role="note">削除・アーカイブ済みの採択：{flow.data.missingItems.join("・")}。採択履歴を保持しています。</p> : null}
      {flow.data?.eligibility.map(item => <p key={item.itemId} className={s.muted}>{item.issueId ?? "削除されたIssue"}：{item.eligible ? "採択と既存の着手条件を確認済み（実行の許可・予約ではありません）" : item.reason?.message}</p>)}
    </div></div>;
  return <div className={s.page}><IssueList crumb={<Link to="/sprints">Sprints</Link>} title={sprint.name} intro={intro}
    actions={<><Button aria-pressed>計画</Button><Button onClick={onOutcomes}>成果と評価</Button><Button onClick={onRetrospective}>振り返り</Button></>}
    heading={heading}
    filterBar={<div role="group" aria-label="絞り込み条件"><BlockedFilter value={search.blocked} onChange={blocked => onSearchChange({ blocked })} /></div>}
    rows={rows} loading={allRows.loading} error={allRows.error} onRetry={allRows.retry} search={search} onSearchChange={onSearchChange} readOnly={!writable} />
  </div>;
}

function PeriodEditor({ sprint, onSaved }: { sprint: SprintDetail; onSaved: () => void }) {
  const [version, setVersion] = useState(sprint.version);
  const [startDate, setStart] = useState(sprint.startDate), [endDate, setEnd] = useState(sprint.endDate), [timezone, setTimezone] = useState(sprint.timezone ?? "");
  const save = useSprintCommand();
  return <form className={s.section} aria-label="Sprintの期間変更" onSubmit={e => { e.preventDefault(); if (save.isPending) return; void save.run(`/sprints/${sprint.id}`, { expectedVersion: version, startDate, endDate, timezone }, "PATCH").then(onSaved, () => {}); }}>
    <div className={s.row}><label className={s.field}>開始日<input required type="date" value={startDate} onChange={e => setStart(e.target.value)} disabled={save.isPending} /></label><label className={s.field}>終了日<input required type="date" value={endDate} onChange={e => setEnd(e.target.value)} disabled={save.isPending} /></label></div>
    <label className={s.field}>タイムゾーン<input required value={timezone} onChange={e => setTimezone(e.target.value)} disabled={save.isPending} /></label><p>期間変更後は新しい計画を保存して合意してください。</p>
    <SprintEditConflict error={save.error} onContinue={() => { setVersion(sprint.version); save.reset(); }}><p>{sprint.startDate} – {sprint.endDate} / {sprint.timezone}</p></SprintEditConflict>
    <Button type="submit" disabled={save.isPending}>{save.isPending ? "保存中…" : "期間を保存"}</Button>{save.error && <p role="alert">{errorMessage(save.error)}。入力は保持しています。</p>}
  </form>;
}
