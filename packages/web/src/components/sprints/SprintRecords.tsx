import { useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { SprintDetail, SprintOutcomeContent, SprintRecord, SprintRecordLink } from "@nod/core";
import { useSprintRecords } from "../../api/hooks/sprints";
import { useSprintCommand } from "../../api/hooks/sprint-planning";
import { errorMessage } from "../../api/errors";
import { Markdown } from "../markdown/Markdown";
import { Button, PageHeader, PageTitle, Spacer } from "../ui";
import { SPRINT_PHASE_LABEL } from "../../lib/sprints";
import { SprintClosure } from "./SprintClosure";
import s from "./sprint-planning.module.css";

export const SPRINT_TEST_RESULT_LABEL = { passed: "合格", failed: "不合格", unverified: "未確認" } as const;

export function canAddSprintRecord(sprint: SprintDetail) {
  return ["active", "ended", "canceled"].includes(sprint.phase);
}

export function SprintRecordMeta({ record }: { record: SprintRecord }) {
  return <p className={s.muted}>記録者：{record.recordedBy === "me" ? "利用者本人（me）" : `エージェント（${record.recordedBy}）`} / 記録日時：<time dateTime={record.recordedAt}>{new Date(record.recordedAt).toLocaleString("ja-JP")}</time>{record.correctsRecordId && <> / <a href={`#record-${record.correctsRecordId}`}>訂正元の記録</a></>}</p>;
}

export function SprintRecordLinks({ links }: { links: SprintRecordLink[] }) {
  return links.length ? <ul>{links.map((link, index) => <li key={index}>{link.kind === "document"
    ? <Link to="/documents/$documentId" params={{ documentId: link.ref }}>{link.label ?? `Document ${link.ref}`}</Link>
    : link.kind === "issue" ? <Link to="/issues/$issueId" params={{ issueId: link.ref }}>{link.label ?? link.ref}</Link>
      : <a href={link.ref} target="_blank" rel="noreferrer">{link.label ?? link.ref}</a>}</li>)}</ul> : <p>未記録</p>;
}

export function SprintRecordText({ title, text }: { title: string; text: string }) {
  return <div><h3>{title}</h3>{text ? <Markdown>{text}</Markdown> : <p>未記録</p>}</div>;
}

export function SprintRecordLinkFields({ links, onChange, disabled }: { links: SprintRecordLink[]; onChange: (links: SprintRecordLink[]) => void; disabled: boolean }) {
  return <fieldset disabled={disabled} className={s.fields}><legend>成果リンク（Document・Issue・PR・URL）</legend>
    {links.map((link, index) => <div key={index} className={s.fields}>
      <div className={s.row}><label className={s.field}>リンクの種類<select value={link.kind} onChange={e => onChange(links.map((item, i) => i === index ? { ...item, kind: e.target.value as SprintRecordLink["kind"] } : item))}><option value="document">Document</option><option value="issue">Issue</option><option value="url">PR・URL</option></select></label>
        <label className={s.field}>参照先<input required value={link.ref} placeholder={link.kind === "document" ? "Document ID" : link.kind === "issue" ? "NOD-41" : "https://…"} onChange={e => onChange(links.map((item, i) => i === index ? { ...item, ref: e.target.value } : item))} /></label></div>
      <label className={s.field}>リンク名（任意）<input value={link.label ?? ""} onChange={e => onChange(links.map((item, i) => i === index ? { ...item, label: e.target.value } : item))} /></label>
      <Button onClick={() => onChange(links.filter((_, i) => i !== index))}>リンクを除く</Button>
    </div>)}
    <Button onClick={() => onChange([...links, { kind: "url", ref: "" }])}>リンクを追加</Button>
  </fieldset>;
}

export function SprintRecordsLayout({ sprint, title, onBack, onPlan, children, aside }: {
  sprint: SprintDetail; title: string; onBack: () => void; onPlan: () => void; children: ReactNode; aside?: ReactNode;
}) {
  return <div className={s.page}><PageHeader><Link to="/sprints">Sprints</Link><PageTitle>{sprint.name}</PageTitle><span>{SPRINT_PHASE_LABEL[sprint.phase]}</span><Spacer /><Button onClick={onPlan}>計画</Button><Button aria-pressed={title === "成果と評価"}>成果と評価</Button></PageHeader>
    <div className={s.bar}><Button onClick={onBack}>タスク一覧へ戻る</Button><strong>{title}</strong></div>
    <div className={`${s.body} ${s.columns}`}><div className={s.main}>{children}</div><aside className={s.aside}>{aside}</aside></div>
  </div>;
}

export function SprintOutcomes({ sprint, onBack, onPlan, readError, onRetry }: { sprint: SprintDetail; onBack: () => void; onPlan: () => void; readError?: unknown; onRetry: () => void }) {
  const records = useSprintRecords(sprint.id);
  const outcomes = records.data?.filter(record => record.kind === "outcome") ?? [];
  return <SprintRecordsLayout sprint={sprint} title="成果と評価" onBack={onBack} onPlan={onPlan} aside={<section className={s.section}><h2>利用者の感想</h2><p>未記録</p></section>}>
    {!!readError && <p role="alert" className={s.error}>Sprintの再取得に失敗しました。<Button onClick={onRetry}>再読み込み</Button></p>}
    <section className={s.section}><h2>成果</h2><p>成果のリンク、変更の要約、試し方とテスト結果を確認できます。</p>
      {records.isPending && <p role="status">成果の記録を読み込み中…</p>}
      {records.error && <p role="alert" className={s.error}>成果の記録を取得できません：{errorMessage(records.error)}。{records.data && "最後に取得した記録を表示しています。"}<Button onClick={() => void records.refetch()}>再読み込み</Button></p>}
      {!records.isPending && !records.error && outcomes.length === 0 && <p>成果は未記録です。</p>}
    </section>
    {outcomes.map(record => <section id={`record-${record.id}`} key={record.id} className={s.section} aria-label="成果の記録">
      <h2>{record.correctsRecordId ? "成果の訂正" : "成果の記録"}</h2><SprintRecordMeta record={record} />
      <SprintRecordText title="変更の要約" text={record.content.summary} />
      <div><h3>成果リンク</h3><SprintRecordLinks links={record.content.links} /></div>
      <SprintRecordText title="試し方" text={record.content.howToTry} />
      <SprintRecordText title="実施したテスト" text={record.content.tests} />
      <p>テスト結果：<strong>{SPRINT_TEST_RESULT_LABEL[record.content.testResult]}</strong></p>
    </section>)}
    {canAddSprintRecord(sprint) ? <SprintOutcomeForm sprint={sprint} outcomes={outcomes} /> : <p>開始前のSprintと旧Cycleの移行履歴には記録を追加できません。</p>}
    {sprint.closureRecord && <section className={s.section}><SprintClosure record={sprint.closureRecord} /></section>}
  </SprintRecordsLayout>;
}

function SprintOutcomeForm({ sprint, outcomes }: { sprint: SprintDetail; outcomes: SprintRecord[] }) {
  const [summary, setSummary] = useState(""), [howToTry, setHowToTry] = useState(""), [tests, setTests] = useState("");
  const [testResult, setResult] = useState<SprintOutcomeContent["testResult"]>("unverified");
  const [links, setLinks] = useState<SprintRecordLink[]>([]), [correctsRecordId, setCorrection] = useState("");
  const [saved, setSaved] = useState(false);
  const command = useSprintCommand<SprintRecord>();
  const empty = !summary.trim() && !howToTry.trim() && !tests.trim() && links.length === 0;
  return <form className={s.section} aria-label="成果を追記" onSubmit={e => {
    e.preventDefault();
    if (command.isPending || empty) return;
    setSaved(false);
    const content = { summary, howToTry, tests, testResult, links: links.map(link => ({ kind: link.kind, ref: link.ref, ...(link.label?.trim() ? { label: link.label } : {}) })) };
    void command.run(`/sprints/${sprint.id}/records`, { kind: "outcome", content, ...(correctsRecordId ? { correctsRecordId } : {}) }).then(() => {
      setSummary(""); setHowToTry(""); setTests(""); setLinks([]); setResult("unverified"); setCorrection(""); setSaved(true);
    }, () => {});
  }}><h2>成果を追記</h2><p>訂正も新しい記録として保存します。過去の記録は残ります。</p>
    <fieldset disabled={command.isPending} className={s.fields}><legend>成果の内容</legend>
      <label className={s.field}>訂正元（任意）<select value={correctsRecordId} onChange={e => setCorrection(e.target.value)}><option value="">新しい成果</option>{outcomes.map(record => <option key={record.id} value={record.id}>{new Date(record.recordedAt).toLocaleString("ja-JP")} / {record.content.summary.slice(0, 50) || "成果の記録"}</option>)}</select></label>
      <label className={s.field}>変更の要約<textarea maxLength={8000} value={summary} onChange={e => setSummary(e.target.value)} /></label>
      <label className={s.field}>試し方<textarea maxLength={8000} value={howToTry} onChange={e => setHowToTry(e.target.value)} /></label>
      <label className={s.field}>実施したテスト<textarea maxLength={8000} value={tests} onChange={e => setTests(e.target.value)} /></label>
      <label className={s.field}>テスト結果<select value={testResult} onChange={e => setResult(e.target.value as SprintOutcomeContent["testResult"])}>{Object.entries(SPRINT_TEST_RESULT_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    </fieldset>
    <SprintRecordLinkFields links={links} onChange={setLinks} disabled={command.isPending} />
    <p className={s.muted}>IssueのDoneやPRのmergeから合格を推測しません。既存資料はリンクで参照できます。</p>
    {command.error && <p role="alert" className={s.error}>保存できませんでした。入力は保持しています：{errorMessage(command.error)}</p>}
    {saved && <p role="status">成果を記録しました。</p>}
    <Button type="submit" variant="primary" disabled={command.isPending || empty}>{command.isPending ? "保存中…" : "成果を記録する"}</Button>
  </form>;
}
