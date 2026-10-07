import { getRouteApi, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useDecision, useTriage, useTriageProposalCounts, useTriageProposals, useTriageSuggestions, useWorkspaceName } from "../api/hooks/decision";
import { useCycles } from "../api/hooks/cycles";
import { useProjectChoicesQuery } from "../api/hooks/issue-detail";
import { useIssueDetail } from "../api/hooks/shared";
import { cycleMenu } from "../lib/bulk-selection";
import { assigneeChoices, parseLabels } from "../lib/issue-edit";
import { priorityMeta } from "../lib/meta";
import type { DuplicateSuggestion, Issue, SuggestionReason, TriageProposal, TriageSuggestions } from "../api/types";
import { Markdown } from "../components/markdown/Markdown";
import { ActionError } from "../components/split/ActionError";
import { QueueEmpty, QueueItem } from "../components/split/QueueItem";
import { SplitLayout } from "../components/split/SplitLayout";
import { AgentAvatar, Button, Icon, LabelDot, StatusLabel, WorkspaceBadge } from "../components/ui";
import { tomorrow } from "../lib/decision";
import { formatRelative } from "../lib/format";
import { applyAcceptProposal, proposalAttributes, proposalBadge, proposalsHeading } from "../lib/triage-proposal";
import d from "./decision.module.css";

const route = getRouteApi("/triage");

export function TriagePage() {
  const { selected } = route.useSearch();
  const triage = useTriage();
  const proposalCounts = useTriageProposalCounts();
  const workspaceName = useWorkspaceName();
  const items = triage.data ?? [];
  const current = items.find((i) => i.id === selected) ?? items[0];
  return (
    <SplitLayout
      title="Triage"
      description="LLM が起票し、受け入れ待ちの Issue"
      listLabel="Triage の一覧"
      list={
        triage.isPending ? (
          <QueueEmpty>読み込み中…</QueueEmpty>
        ) : triage.isError ? (
          <ActionError error={triage.error} />
        ) : items.length === 0 ? (
          <QueueEmpty>Triage の Issue はありません</QueueEmpty>
        ) : (
          items.map((issue) => (
            <QueueItem
              key={issue.id}
              to="/triage"
              issueId={issue.id}
              title={issue.title}
              actor={issue.createdBy}
              at={issue.createdAt}
              body={issue.description ?? undefined}
              workspaceKey={issue.workspace}
              workspaceName={workspaceName(issue.workspace)}
              selected={issue === current}
              proposalCount={proposalCounts.data?.[issue.id] ?? 0}
            />
          ))
        )
      }
      detail={
        current ? (
          <TriageDetail key={current.id} issue={current} workspaceName={workspaceName(current.workspace)} />
        ) : (
          <p className={d.empty}>{triage.isPending ? "読み込み中…" : "Triage の Issue はありません"}</p>
        )
      }
    />
  );
}

type Mode = "duplicate" | "snooze" | "decline";

function TriageDetail({ issue, workspaceName }: { issue: Issue; workspaceName: string }) {
  const projects = useProjectChoicesQuery();
  const detail = useIssueDetail(issue.id);
  const created = detail.data?.activity.find(a => a.kind === "event" && a.type === "created");
  const source = created?.kind === "event" && typeof created.data.discovered_from === "string" ? created.data.discovered_from : null;
  const [projectRef, setProjectRef] = useState(issue.project ? String(issue.project.id) : "");
  const [priority, setPriority] = useState(issue.priority);
  // 終了していない Cycle を選べる（Issue 詳細の Cycle と同じ並び）。今付いている Cycle は終了していても残す
  const cycles = useCycles();
  const [cycleRef, setCycleRef] = useState(issue.cycle ? String(issue.cycle.id) : "");
  const cycleChoices = cycleMenu(cycles.data ?? []).map(c => ({ id: c.id, name: c.name }));
  if (issue.cycle && !cycleChoices.some(c => c.id === issue.cycle?.id)) cycleChoices.push(issue.cycle);
  const [labels, setLabels] = useState(issue.labels.join(", "));
  const [assignee, setAssignee] = useState(issue.assignee ?? "");
  const choices = projects.data ?? [];
  const [mode, setMode] = useState<Mode | null>(null);
  const [value, setValue] = useState("");
  const decision = useDecision();
  const busy = decision.isPending;
  // 判断を送ったあとは Issue が Triage から外れ、取り直すと NOT_IN_TRIAGE になるため止める
  const suggestions = useTriageSuggestions(issue.id, decision.isIdle);
  const proposals = useTriageProposals(issue.id, decision.isIdle);
  const open = (next: Mode, initial = "") => {
    setMode(next);
    setValue(initial);
    decision.reset();
  };
  // LLM の提案をフォームに入れる（#62）。確定は人が既存のボタンで行う
  const applyProposal = (p: TriageProposal) => {
    if (p.decision === "duplicate") return open("duplicate", p.duplicateOf ?? "");
    if (p.decision === "decline") return open("decline", p.reason ?? "");
    const next = applyAcceptProposal({ projectRef, priority, labels: parseLabels(labels, []), assignee }, p);
    setProjectRef(next.projectRef);
    setPriority(next.priority);
    setLabels(next.labels.join(", "));
    setAssignee(next.assignee);
    setMode(null);
    decision.reset();
  };
  return (
    <div className={d.detail}>
      <div className={d.crumb}>
        <WorkspaceBadge workspaceKey={issue.workspace} name={workspaceName} />
        <span className={d.id}>{issue.id}</span>
        <StatusLabel status={issue.status} workspace={issue.workspace} />
      </div>
      <h2 className={d.title}>{issue.title}</h2>
      <div className={d.reporter}>
        <AgentAvatar actor={issue.createdBy} />
        <span>
          {issue.createdBy} が起票 · {formatRelative(issue.createdAt)}
        </span>
      </div>
      {detail.isError ? <ActionError error={detail.error} /> : detail.isPending ? <p className={d.muted}>起票元を読み込み中…</p> :
        <p className={d.muted}>{source ? <><Link to="/issues/$issueId" params={{ issueId: source }}>{source}</Link> の作業中に発見</> : "起票元は記録されていません"}</p>}
      {issue.description ? <Markdown breaks>{issue.description}</Markdown> : <p className={d.body}>説明はありません</p>}
      <div className={d.acceptGroup}>
        {proposals.isError ? <ActionError error={proposals.error} /> :
          <Proposals proposals={proposals.data ?? []} workspace={issue.workspace} disabled={busy} onApply={applyProposal} />}
        <fieldset className={d.acceptFields} disabled={busy}>
          <legend>受け入れ時に設定:</legend>
          <label>Project<select aria-label="受け入れ時のProject" value={projectRef} disabled={projects.isPending || projects.isError} onChange={e => setProjectRef(e.target.value)}>
            <option value="">なし</option>
            {issue.project && !choices.some(p => p.id === issue.project?.id) && <option value={String(issue.project.id)}>{issue.project.name}</option>}
            {choices.map(p => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
          </select></label>
          <label>Priority<select aria-label="受け入れ時のPriority" value={priority} onChange={e => setPriority(Number(e.target.value))}>
            {[0, 1, 2, 3, 4].map(p => <option key={p} value={p}>{priorityMeta(p).label}</option>)}
          </select></label>
          <label>Cycle<select aria-label="受け入れ時のCycle" value={cycleRef} disabled={cycles.isPending || cycles.isError} onChange={e => setCycleRef(e.target.value)}>
            <option value="">なし</option>
            {cycleChoices.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
          </select></label>
          <label>Labels<input aria-label="受け入れ時のLabels" value={labels} onChange={e => setLabels(e.target.value)} placeholder="bug, perf" /></label>
          <label>Assignee<select aria-label="受け入れ時のAssignee" value={assignee} onChange={e => setAssignee(e.target.value)}>
            <option value="">担当者を選択</option>
            {assigneeChoices(assignee || null).map(a => <option key={a} value={a}>{a}</option>)}
          </select></label>
          <ActionError error={projects.error} />
          <ActionError error={cycles.error} />
          <Candidates suggestions={suggestions.data} workspace={issue.workspace} labels={parseLabels(labels, [])} assignee={assignee}
            onLabel={l => setLabels(parseLabels(labels, []).concat(l).join(", "))} onAssignee={setAssignee} />
        </fieldset>
      </div>
      {suggestions.isError ? <ActionError error={suggestions.error} /> :
        <DuplicateHints duplicates={suggestions.data?.duplicates ?? []} disabled={busy} onDuplicate={id => open("duplicate", id)} />}
      <div className={d.actions}>
        <Button variant="primary" icon="check" disabled={busy || projects.isPending || projects.isError} onClick={() => {
          const selected = parseLabels(labels, []);
          decision.mutate({ op: "accept", issueId: issue.id, input: { projectRef: projectRef || null, priority,
            addLabels: selected.filter(l => !issue.labels.includes(l)), removeLabels: issue.labels.filter(l => !selected.includes(l)),
            ...(cycleRef !== (issue.cycle ? String(issue.cycle.id) : "") ? { cycleRef: cycleRef || null } : {}),
            ...(assignee !== (issue.assignee ?? "") ? { assignee: assignee || null } : {}) } });
        }}>
          受け入れる
        </Button>
        <Button icon="copy" disabled={busy} onClick={() => open("duplicate")}>
          重複にする
        </Button>
        <Button icon="alarm-clock" disabled={busy} onClick={() => open("snooze", tomorrow())}>
          後回し
        </Button>
        <span className={d.spacer} />
        <Button variant="danger" icon="x" disabled={busy} onClick={() => open("decline")}>
          却下
        </Button>
      </div>

      {mode === "duplicate" && (
        <div className={d.subform}>
          <input
            className={d.input}
            aria-label="元の Issue の ID"
            placeholder="例: API-12"
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button
            variant="primary"
            disabled={busy || value.trim() === ""}
            onClick={() => decision.mutate({ op: "duplicate", issueId: issue.id, original: value })}
          >
            重複として閉じる
          </Button>
          <Button disabled={busy} onClick={() => setMode(null)}>
            やめる
          </Button>
        </div>
      )}
      {mode === "snooze" && (
        <div className={d.subform}>
          <input
            className={d.input}
            type="date"
            aria-label="後回しの期限"
            min={tomorrow()}
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button
            variant="primary"
            disabled={busy || value < tomorrow()}
            onClick={() => {
              if (value >= tomorrow()) decision.mutate({ op: "snooze", issueId: issue.id, until: value });
            }}
          >
            後回しにする
          </Button>
          <Button disabled={busy} onClick={() => setMode(null)}>
            やめる
          </Button>
        </div>
      )}
      {mode === "decline" && (
        <div className={d.subform}>
          <input
            className={d.input}
            aria-label="却下の理由（任意）"
            placeholder="理由（任意）"
            value={value}
            disabled={busy}
            onChange={(e) => setValue(e.target.value)}
          />
          <Button variant="danger" disabled={busy} onClick={() => decision.mutate({ op: "decline", issueId: issue.id, reason: value })}>
            却下する
          </Button>
          <Button disabled={busy} onClick={() => setMode(null)}>
            やめる
          </Button>
        </div>
      )}
      <ActionError error={decision.error} />
    </div>
  );
}

// Triage の提案（#62）。LLM のほか me も記録できる。更新の新しい順に並べ、「フォームに反映」は入力欄を埋めるだけで確定は人が行う
function Proposals({ proposals, workspace, disabled, onApply }: {
  proposals: TriageProposal[];
  workspace: string;
  disabled: boolean;
  onApply: (p: TriageProposal) => void;
}) {
  if (proposals.length === 0) return null;
  const heading = proposalsHeading(proposals);
  return (
    <section className={d.proposals} aria-label={heading}>
      <div className={d.proposalsHead}>
        <Icon name="sparkles" size={13} />
        <span className={d.proposalsTitle}>{heading}</span>
        <span className={d.proposalsCount}>{proposals.length}</span>
      </div>
      {proposals.map((p) => {
        const badge = proposalBadge(p);
        const attrs = proposalAttributes(p);
        return (
          <article key={p.actor} className={d.proposal} aria-label={`${p.actor} の提案`}>
            <div className={d.proposalBody}>
              <div className={d.proposalHead}>
                <AgentAvatar actor={p.actor} />
                <span className={d.proposalActor}>{p.actor}</span>
                <span className={d.proposalTime}>{formatRelative(p.updatedAt)}</span>
                <span className={`${d.proposalBadge} ${d[`badge_${badge.tone}`]}`}><Icon name={badge.icon} size={11} />{badge.text}</span>
              </div>
              {attrs.length > 0 && (
                <div className={d.proposalAttrs}>
                  {attrs.map((a) => (
                    <span key={a.key} className={d.proposalAttr}>
                      <Icon name={a.icon} size={11} /><span className={d.proposalAttrKey}>{a.label}</span>
                      {a.key === "labels"
                        ? p.labels.map((l) => <span key={l} className={d.proposalLabel} data-label={l}><LabelDot workspace={workspace} name={l} />{l}</span>)
                        : a.value}
                    </span>
                  ))}
                </div>
              )}
              {p.reason && <p className={d.proposalReason} title={p.reason}>{p.reason}</p>}
            </div>
            <button type="button" className={d.proposalApply} disabled={disabled} aria-label={`${p.actor} の提案をフォームに反映`} onClick={() => onApply(p)}>
              <Icon name="arrow-down-to-line" size={12} />フォームに反映
            </button>
          </article>
        );
      })}
    </section>
  );
}

function reasonText(r: SuggestionReason, label?: string): string {
  switch (r.kind) {
    case "similar":
      return `類似Issue ${r.issues.length}件${label === undefined ? "の担当" : "に付与"}（${r.issues[0]}${r.issues.length > 1 ? " 他" : ""}）`;
    case "text":
      return `${r.field === "title" ? "タイトル" : "本文"}に“${label}”を含む`;
    case "source":
      return `起票元 ${r.issue} の担当`;
  }
}

// ラベル・担当の候補（#41）。クリックで受け入れフォームに入れるだけで、確定は「受け入れる」で人が行う
function Candidates({ suggestions, workspace, labels, assignee, onLabel, onAssignee }: {
  suggestions: TriageSuggestions | undefined;
  workspace: string;
  labels: string[];
  assignee: string;
  onLabel: (label: string) => void;
  onAssignee: (assignee: string) => void;
}) {
  const labelItems = (suggestions?.labels ?? []).filter(l => !labels.includes(l.label));
  const assigneeItems = (suggestions?.assignees ?? []).filter(a => a.assignee !== assignee);
  if (labelItems.length === 0 && assigneeItems.length === 0) return null;
  return (
    <div className={d.candidates} role="group" aria-label="候補">
      <span className={d.candidatesLabel}>候補:</span>
      {labelItems.map(l => (
        <div key={`label:${l.label}`} className={d.candidate}>
          <button type="button" className={d.chip} aria-label={`ラベル ${l.label} を追加`} onClick={() => onLabel(l.label)}>+ <LabelDot workspace={workspace} name={l.label} />{l.label}</button>
          <span className={d.reason}>{l.reasons.map(r => reasonText(r, l.label)).join(" / ")}</span>
        </div>
      ))}
      {assigneeItems.map(a => (
        <div key={`assignee:${a.assignee}`} className={d.candidate}>
          <button type="button" className={d.chip} aria-label={`担当を ${a.assignee} にする`} onClick={() => onAssignee(a.assignee)}>→ {a.assignee}</button>
          <span className={d.reason}>{a.reasons.map(r => reasonText(r)).join(" / ")}</span>
        </div>
      ))}
    </div>
  );
}

// 重複候補（#41）。一致率の高い順に最大5件並べる。「重複にする」は既存の重複の入力欄に ID を入れるだけで、確定は人が行う
function DuplicateHints({ duplicates, disabled, onDuplicate }: {
  duplicates: DuplicateSuggestion[];
  disabled: boolean;
  onDuplicate: (id: string) => void;
}) {
  if (duplicates.length === 0) return null;
  return (
    <ul className={d.hints} aria-label="似た Issue">
      {duplicates.map((c) => (
        <li key={c.id} className={d.hint}>
          <Icon name="copy" size={14} />
          <div className={d.hintBody}>
            <div className={d.hintLine}>
              <span className={d.hintLabel}>似た Issue:</span>
              <span className={d.hintId}>{c.id}</span>
              <span className={d.hintTitle}>「{c.title}」</span>
              <span className={d.hintStatus}><StatusLabel status={c.status} workspace={c.workspace} /></span>
            </div>
            <div className={d.hintMeta}>
              一致 {Math.round(c.score * 100)}%{c.sharedTerms.length > 0 && ` · 共通語: ${c.sharedTerms.join(", ")}`}
              {c.via && ` · ${c.via} の重複元`}
            </div>
          </div>
          <Link className={`${d.hintButton} ${d.hintCompare}`} to="/issues/$issueId" params={{ issueId: c.id }} aria-label={`${c.id} と比較`}>比較</Link>
          <button type="button" className={d.hintButton} disabled={disabled} aria-label={`${c.id} の重複にする`} onClick={() => onDuplicate(c.id)}>重複にする</button>
        </li>
      ))}
    </ul>
  );
}
