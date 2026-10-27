import { SprintEditConflict } from "./SprintEditConflict";
import { useState } from "react";
import type { SprintDetail, SprintPlan, SprintPlanResult } from "@nod/core";
import { errorMessage } from "../../api/errors";
import { useSprintCommand } from "../../api/hooks/sprint-planning";
import { Button } from "../ui";
import s from "./sprint-planning.module.css";

export function SprintPlanEditor({ sprint, plan, onClose, onSaved }: { sprint: SprintDetail; plan?: SprintPlan; onClose: () => void; onSaved: () => void }) {
  const [version, setVersion] = useState(sprint.version);
  const [goal, setGoal] = useState(plan?.content.goal ?? "");
  const [verification, setVerification] = useState(plan?.content.verificationMethod ?? "");
  const [selected, setSelected] = useState(plan?.content.items.map(i => i.itemId) ?? []);
  const [details, setDetails] = useState<Record<string, { contribution: string; executionPlan: string }>>(Object.fromEntries(plan?.content.items.map(i => [i.itemId, { contribution: i.contribution, executionPlan: i.executionPlan }]) ?? []));
  const [dod, setDod] = useState(plan?.content.definitionOfDone ?? [{ id: crypto.randomUUID(), text: "" }]);
  const [constraints, setConstraints] = useState(plan?.content.constraints ?? { executionScope: "", maxParallel: 1, notes: "" });
  const [reason, setReason] = useState("");
  const save = useSprintCommand<SprintPlanResult>();
  return <form className={s.editor} aria-label="計画案の編集" onSubmit={event => {
    event.preventDefault(); if (save.isPending) return;
    void save.run(`/sprints/${sprint.id}/plans`, { expectedVersion: version, goal, verificationMethod: verification, items: selected.map(itemId => ({ itemId, ...details[itemId] })), definitionOfDone: dod, constraints, changeReason: reason }).then(onSaved, () => {});
  }}>
    <fieldset disabled={save.isPending} style={{ border: 0, padding: 0, margin: 0 }}>
      <div className={s.columns}>
        <div className={s.main}>
          <section className={s.section}><h2>ゴールと達成の確認</h2>
            <label className={s.field}>今回のゴール<input required autoFocus value={goal} onChange={e => setGoal(e.target.value)} /></label>
            <label className={s.field}>達成の確認方法<textarea required value={verification} onChange={e => setVerification(e.target.value)} /></label>
            <p className={s.muted}>期間：{sprint.startDate} – {sprint.endDate} · {sprint.timezone}。期間変更後は新しい計画として保存します。</p>
          </section>
          <section className={s.section}><h2>今回取り組むIssue</h2><p className={s.muted}>採択予定にして保存しても、人が合意して開始するまでは実行されません。未選択のIssueは候補として保留・採択外です。</p>
            {sprint.items.map(item => {
              const chosen = selected.includes(item.id), detail = details[item.id] ?? { contribution: "", executionPlan: "" };
              return <div key={item.id} className={s.item}>
                <label><input type="checkbox" aria-label={`${item.sourceIssueKey}を採択予定にする`} checked={chosen} disabled={item.issueId === null} onChange={e => { setSelected(e.target.checked ? [...selected, item.id] : selected.filter(id => id !== item.id)); setDetails(prev => ({ ...prev, [item.id]: detail })); }} /> {item.sourceIssueKey} {item.snapshot.issue.title}{item.issueId === null && "（削除済み）"}</label>
                {chosen && <><label className={s.field}>{item.sourceIssueKey}のゴールへの貢献<textarea required value={detail.contribution} onChange={e => setDetails(prev => ({ ...prev, [item.id]: { ...detail, contribution: e.target.value } }))} /></label>
                  <label className={s.field}>{item.sourceIssueKey}の実行計画<textarea required value={detail.executionPlan} onChange={e => setDetails(prev => ({ ...prev, [item.id]: { ...detail, executionPlan: e.target.value } }))} /></label></>}
              </div>;
            })}
            {!sprint.items.length && <p>候補はありません。計画案を閉じて候補を追加してください。</p>}
          </section>
          <section className={s.section}><label className={s.field}>変更理由<textarea required value={reason} onChange={e => setReason(e.target.value)} /></label></section>
        </div>
        <aside className={s.aside}>
          <section className={s.section}><h2>完成の定義</h2>
            {dod.map((d, index) => <div key={d.id}><label className={s.field}>完成の定義 {index + 1}<textarea required value={d.text} onChange={e => setDod(prev => prev.map(v => v.id === d.id ? { ...v, text: e.target.value } : v))} /></label>{dod.length > 1 && <Button onClick={() => setDod(prev => prev.filter(v => v.id !== d.id))}>完成条件{index + 1}を除外</Button>}</div>)}
            <Button onClick={() => setDod(prev => [...prev, { id: crypto.randomUUID(), text: "" }])}>完成条件を追加</Button>
          </section>
          <section className={s.section}><h2>実行範囲と制約</h2>
            <label className={s.field}>実行範囲<textarea required value={constraints.executionScope} onChange={e => setConstraints({ ...constraints, executionScope: e.target.value })} /></label>
            <label className={s.field}>並行上限<input type="number" min={1} required value={constraints.maxParallel} onChange={e => setConstraints({ ...constraints, maxParallel: Number(e.target.value) })} /></label>
            <label className={s.field}>制約の補足<textarea required value={constraints.notes} onChange={e => setConstraints({ ...constraints, notes: e.target.value })} /></label>
            {(["executionTarget", "model", "effort"] as const).map((key, index) => <label key={key} className={s.field}>{["実行先（任意）", "モデル（任意）", "思考量（任意）"][index]}<input value={constraints[key] ?? ""} onChange={e => { const next = { ...constraints }; if (e.target.value) next[key] = e.target.value; else delete next[key]; setConstraints(next); }} /></label>)}
          </section>
        </aside>
      </div>
      <div className={s.controls}><Button onClick={onClose}>計画案を閉じる</Button><Button type="submit" variant="primary" disabled={save.isPending}>{save.isPending ? "保存中…" : "計画案を保存"}</Button></div>
    </fieldset>
    <SprintEditConflict error={save.error} onContinue={() => { setVersion(sprint.version); save.reset(); }}><p>計画 第{sprint.plans.at(-1)?.revision ?? "—"}版 / {sprint.plans.at(-1)?.content.goal ?? "計画なし"}</p><p>期間：{sprint.startDate} – {sprint.endDate} / {sprint.timezone}</p></SprintEditConflict>
    {save.error && <p role="alert" className={s.error}>保存できませんでした。入力は保持しています：{errorMessage(save.error)}。計画案を保存から再試行できます。</p>}
  </form>;
}
