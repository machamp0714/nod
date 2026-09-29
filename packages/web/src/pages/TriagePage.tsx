import { getRouteApi, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useDecision, useTriage, useWorkspaceName } from "../api/hooks/decision";
import { useProjectChoicesQuery } from "../api/hooks/issue-detail";
import { useIssueDetail } from "../api/hooks/shared";
import { parseLabels } from "../lib/issue-edit";
import { priorityMeta } from "../lib/meta";
import type { Issue } from "../api/types";
import { ActionError } from "../components/split/ActionError";
import { QueueEmpty, QueueItem } from "../components/split/QueueItem";
import { SplitLayout } from "../components/split/SplitLayout";
import { AgentAvatar, Button, StatusLabel, WorkspaceBadge } from "../components/ui";
import { tomorrow } from "../lib/decision";
import { formatRelative } from "../lib/format";
import d from "./decision.module.css";

const route = getRouteApi("/triage");

export function TriagePage() {
  const { selected } = route.useSearch();
  const triage = useTriage();
  const workspaceName = useWorkspaceName();
  const items = triage.data ?? [];
  const current = items.find((i) => i.id === selected) ?? items[0];
  return (
    <SplitLayout
      title="Triage"
      description="LLM が起票し、受け入れ待ちの Issue"
      count={items.length}
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
  const [labels, setLabels] = useState(issue.labels.join(", "));
  const choices = projects.data ?? [];
  const [mode, setMode] = useState<Mode | null>(null);
  const [value, setValue] = useState("");
  const decision = useDecision();
  const busy = decision.isPending;
  const open = (next: Mode, initial = "") => {
    setMode(next);
    setValue(initial);
    decision.reset();
  };
  return (
    <div className={d.detail}>
      <div className={d.crumb}>
        <WorkspaceBadge workspaceKey={issue.workspace} name={workspaceName} />
        <span className={d.id}>{issue.id}</span>
        <StatusLabel status={issue.status} />
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
      <p className={d.body}>{issue.description ?? "説明はありません"}</p>
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
        <label>Labels<input aria-label="受け入れ時のLabels" value={labels} onChange={e => setLabels(e.target.value)} placeholder="bug, perf" /></label>
        <ActionError error={projects.error} />
      </fieldset>
      <div className={d.actions}>
        <Button variant="primary" icon="check" disabled={busy || projects.isPending || projects.isError} onClick={() => {
          const selected = parseLabels(labels, []);
          decision.mutate({ op: "accept", issueId: issue.id, input: { projectRef: projectRef || null, priority,
            addLabels: selected.filter(l => !issue.labels.includes(l)), removeLabels: issue.labels.filter(l => !selected.includes(l)) } });
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
