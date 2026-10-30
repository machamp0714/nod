import { useState } from "react";
import type { SprintDetail, SprintRecordLink, SprintRetrospectiveRecord } from "@nod/core";
import { useSprintRecords } from "../../api/hooks/sprints";
import { useSprintCommand } from "../../api/hooks/sprint-planning";
import { errorMessage } from "../../api/errors";
import { Button } from "../ui";
import { SprintClosure } from "./SprintClosure";
import { canAddSprintRecord, SprintRecordLinkFields, SprintRecordLinks, SprintRecordMeta, SprintRecordsLayout, SprintRecordText } from "./SprintRecords";
import s from "./sprint-planning.module.css";

export function SprintRetrospective({ sprint, onBack, onPlan, onOutcomes, readError, onRetry }: {
  sprint: SprintDetail; onBack: () => void; onPlan: () => void; onOutcomes: () => void; readError?: unknown; onRetry: () => void;
}) {
  const records = useSprintRecords(sprint.id);
  const retrospectives = records.data?.filter((record): record is SprintRetrospectiveRecord => record.kind === "retrospective") ?? [];
  return <SprintRecordsLayout sprint={sprint} title="振り返り" onBack={onBack} onPlan={onPlan} onOutcomes={onOutcomes} onRetrospective={() => {}} aside={<>
    {canAddSprintRecord(sprint) ? <SprintRetrospectiveForm sprint={sprint} records={retrospectives} /> : <p>開始前のSprintと旧Cycleの移行履歴には振り返りを追加できません。</p>}
  </>}>
    {!!readError && <p role="alert" className={s.error}>Sprintの再取得に失敗しました。<Button onClick={onRetry}>再読み込み</Button></p>}
    <section className={s.section}><h2>振り返りの記録</h2><p>よかったこと、困ったことと、次に改善することを読み返せます。</p>
      {records.isPending && <p role="status">振り返りの記録を読み込み中…</p>}
      {records.error && <p role="alert" className={s.error}>振り返りの記録を取得できません：{errorMessage(records.error)}。{records.data && "最後に取得した記録を表示しています。"}<Button onClick={() => void records.refetch()}>再読み込み</Button></p>}
      {!records.isPending && !records.error && !retrospectives.length && <p>振り返りは未記録です。</p>}
    </section>
    {retrospectives.map(record => <section id={`record-${record.id}`} key={record.id} className={s.section} aria-label="振り返りの記録">
      <h2>{record.correctsRecordId ? "振り返りの訂正" : "振り返り"}</h2><SprintRecordMeta record={record} />
      <SprintRecordText title="よかったこと" text={record.content.wentWell} />
      <SprintRecordText title="困ったこと" text={record.content.difficulties} />
      <SprintRecordText title="次に改善すること" text={record.content.improvements} />
      <SprintRecordText title="次の行動" text={record.content.nextActions} />
      <div><h3>次の作業・資料への参照</h3><SprintRecordLinks links={record.content.links} /></div>
    </section>)}
    <section className={s.section}><h2>区切り時点の残件</h2>
      {sprint.closureRecord ? <SprintClosure record={sprint.closureRecord} /> : <p>終了・中止時の残件はまだ記録されていません。</p>}
    </section>
  </SprintRecordsLayout>;
}

function SprintRetrospectiveForm({ sprint, records }: { sprint: SprintDetail; records: SprintRetrospectiveRecord[] }) {
  const [wentWell, setWentWell] = useState(""), [difficulties, setDifficulties] = useState("");
  const [improvements, setImprovements] = useState(""), [nextActions, setNextActions] = useState("");
  const [links, setLinks] = useState<SprintRecordLink[]>([]), [correctsRecordId, setCorrection] = useState("");
  const [saved, setSaved] = useState(false);
  const command = useSprintCommand<SprintRetrospectiveRecord>();
  const empty = !wentWell.trim() && !difficulties.trim() && !improvements.trim() && !nextActions.trim() && !links.length;
  return <form className={s.section} aria-label="振り返りを追記" onChange={() => setSaved(false)} onSubmit={e => {
    e.preventDefault();
    if (command.isPending || empty) return;
    setSaved(false);
    const content = { wentWell, difficulties, improvements, nextActions, links: links.map(link => ({ kind: link.kind, ref: link.ref, ...(link.label?.trim() ? { label: link.label } : {}) })) };
    void command.run(`/sprints/${sprint.id}/records`, { kind: "retrospective", content, ...(correctsRecordId ? { correctsRecordId } : {}) }).then(() => {
      setWentWell(""); setDifficulties(""); setImprovements(""); setNextActions(""); setLinks([]); setCorrection(""); setSaved(true);
    }, () => {});
  }}><h2>振り返りを追記</h2><p>訂正や後日の追記も新しい記録として保存します。前の記録は残ります。</p>
    <fieldset disabled={command.isPending} className={s.fields}><legend>振り返りと次の行動</legend>
      <label className={s.field}>訂正元の振り返り（任意）<select value={correctsRecordId} onChange={e => setCorrection(e.target.value)}><option value="">新しい振り返り</option>{records.map(record => <option key={record.id} value={record.id}>{new Date(record.recordedAt).toLocaleString("ja-JP")} / {(record.content.wentWell || record.content.difficulties || record.content.improvements || record.content.nextActions || "関連リンク").slice(0, 50)}</option>)}</select></label>
      <label className={s.field}>よかったこと<textarea maxLength={8000} value={wentWell} onChange={e => setWentWell(e.target.value)} /></label>
      <label className={s.field}>困ったこと<textarea maxLength={8000} value={difficulties} onChange={e => setDifficulties(e.target.value)} /></label>
      <label className={s.field}>次に改善すること<textarea maxLength={8000} value={improvements} onChange={e => setImprovements(e.target.value)} /></label>
      <label className={s.field}>次の行動<textarea maxLength={8000} value={nextActions} onChange={e => setNextActions(e.target.value)} /></label>
    </fieldset>
    <SprintRecordLinkFields links={links} onChange={setLinks} disabled={command.isPending} title="次の作業・資料への参照" />
    <p className={s.muted}>候補の参照先にはSprint IDまたは番号を指定します。候補追加と採択は計画画面で別に操作します。</p>
    <p className={s.muted}>振り返りの保存ではIssueの起票、候補追加、採択変更、Sprintや担当の開始は行いません。</p>
    {command.error && <p role="alert" className={s.error}>保存できませんでした。入力は保持しています：{errorMessage(command.error)}。内容を確認して再試行してください。</p>}
    {saved && <p role="status">振り返りを記録しました。</p>}
    <Button type="submit" variant="primary" disabled={command.isPending || empty}>{command.isPending ? "保存中…" : "振り返りを記録する"}</Button>
  </form>;
}
