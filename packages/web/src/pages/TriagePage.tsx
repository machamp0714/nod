import { getRouteApi } from "@tanstack/react-router";
import { useState } from "react";
import { useDecision, useTriage, useWorkspaceName } from "../api/hooks/decision";
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
      <p className={d.body}>{issue.description ?? "説明はありません"}</p>
      <div className={d.actions}>
        <Button variant="primary" icon="check" disabled={busy} onClick={() => decision.mutate({ op: "accept", issueId: issue.id })}>
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
            disabled={busy || value === ""}
            onClick={() => decision.mutate({ op: "snooze", issueId: issue.id, until: value })}
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
