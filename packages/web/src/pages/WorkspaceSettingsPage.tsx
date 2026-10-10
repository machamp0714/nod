import { useSaveSpecAssessment } from "../api/hooks/spec-assessment";
import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { errorMessage, isNotFoundError } from "../api/errors";
import { useSaveDefaultAgent } from "../api/hooks/orca";
import { useWorkspaces } from "../api/hooks/shared";
import { useDeleteWorkspaceRules, useSaveWorkspaceRules, useWorkspaceRules } from "../api/hooks/workspace-rules";
import type { Workspace, WorkspaceRules } from "../api/types";
import { Button, Icon, PageError, PageHeader, PageLoading, RadioPills } from "../components/ui";
import { ORCA_AGENT_OPTIONS } from "../lib/orca-feature";
import { formatRulesCount, formatRulesUpdated, RULES_MAX_LENGTH, rulesEditState } from "../lib/workspace-rules";
import { NotFoundMessage } from "./NotFoundPage";
import { AutomationSection } from "./WorkspaceAutomationSettings";
import { GithubRepoSection } from "./WorkspaceGithubSettings";
import { LabelsSection, StatusNamesSection } from "./WorkspaceLabelSettings";
import { RecurringSection } from "./WorkspaceRecurringSettings";
import { TemplatesSection } from "./WorkspaceTemplateSettings";
import { TransitionRulesSection } from "./WorkspaceTransitionSettings";
import s from "./workspace-settings.module.css";

const route = getRouteApi("/workspaces/$workspaceKey/settings");

// Workspace の設定。作業規約、ラベル定義、ステータスの表示名、ステータス遷移（#73）、テンプレート（#160）、自動化、定期Issueを置く
// （nod.pen「Workspace設定｜作業規約（#27）」「Workspace設定｜ラベル・表示名（#26）」「Workspace設定｜自動化（#71/#72）」「Workspace設定｜定期Issue（#32）」）
export function WorkspaceSettingsPage() {
  const { workspaceKey } = route.useParams();
  const workspaces = useWorkspaces();
  const workspace = workspaces.data?.find((w) => w.key === workspaceKey.toUpperCase());
  const rules = useWorkspaceRules(workspace?.key ?? workspaceKey, workspace !== undefined);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  if (workspaces.error) return <PageError message={errorMessage(workspaces.error)} />;
  if (!workspaces.data) return <PageLoading />;
  if (!workspace) return <NotFoundMessage title="Workspace が見つかりません" />;
  if (rules.error) {
    return isNotFoundError(rules.error) ? <NotFoundMessage title="Workspace が見つかりません" /> : <PageError message={errorMessage(rules.error)} />;
  }
  if (rules.data === undefined) return <PageLoading />;
  return (
    <div className={s.page}>
      <PageHeader>
        <span className={s.crumbWorkspace}>{workspace.name}</span>
        <span className={s.crumbSep}>
          <Icon name="chevron-right" size={12} />
        </span>
        <span className={s.crumbCurrent}>設定</span>
      </PageHeader>
      <div className={s.content}>
        <h1 className={s.title}>{workspace.name} の設定</h1>
        {/* 保存済みの本文が変わったら（別の場所での更新を含む）下書きを作り直す */}
        <RulesSection
          key={`${workspace.key}:${rules.data?.updatedAt ?? ""}`}
          workspace={workspace}
          saved={rules.data}
          onSaved={() => setToast("保存しました")}
        />
        <SpecAssessmentSettings workspace={workspace} onSaved={() => setToast("保存しました")} />
        <LabelsSection workspace={workspace} onSaved={setToast} />
        <StatusNamesSection workspace={workspace} onSaved={() => setToast("保存しました")} />
        <TransitionRulesSection workspace={workspace} onSaved={() => setToast("保存しました")} />
        <TemplatesSection onSaved={setToast} />
        <DefaultAgentSection workspace={workspace} onSaved={() => setToast("保存しました")} />
        <GithubRepoSection workspace={workspace} onSaved={setToast} />
        <AutomationSection workspace={workspace} onToast={setToast} />
        <RecurringSection workspace={workspace} onSaved={setToast} />
      </div>
      {toast && (
        <div role="status" className={s.toast}>
          <span className={s.toastIcon}>
            <Icon name="circle-check" />
          </span>
          {toast}
        </div>
      )}
    </div>
  );
}

// Issue 詳細の「Orca で作業を始める」（#210）で起動する既定のエージェント。選ぶとすぐ保存する（nod.pen に見本がなく、既存の節の書き方にならった）
function DefaultAgentSection({ workspace, onSaved }: { workspace: Workspace; onSaved: () => void }) {
  const titleId = useId();
  const [error, setError] = useState<string | null>(null);
  const save = useSaveDefaultAgent(workspace.key);
  // 選んだ値をすぐ見せ、保存に失敗したら保存済みの値に戻す。保存済みの値が変わったら（別の場所での更新を含む）それに合わせる
  const [chosen, setChosen] = useState(workspace.defaultAgent);
  useEffect(() => setChosen(workspace.defaultAgent), [workspace.defaultAgent]);

  async function choose(agent: Workspace["defaultAgent"]) {
    if (agent === chosen) return;
    setChosen(agent);
    setError(null);
    try {
      await save.mutateAsync(agent);
      onSaved();
    } catch (err) {
      setChosen(workspace.defaultAgent);
      setError(errorMessage(err));
    }
  }

  return (
    <section className={s.section} aria-labelledby={titleId}>
      <div className={s.sectionHeader}>
        <h2 id={titleId} className={s.sectionTitle}>
          Orca で起動するエージェント
        </h2>
        <p className={s.description}>Issue 詳細の「Orca で作業を始める」で起動する既定のエージェントです。作成するときに選び直せます。</p>
      </div>
      <div>
        <RadioPills label="既定のエージェント" name={`default-agent-${workspace.key}`} items={ORCA_AGENT_OPTIONS} value={chosen}
          disabled={save.isPending} onChange={(agent) => void choose(agent)} />
      </div>
      {error && (
        <p role="alert" className={s.error}>
          <Icon name="circle-alert" size={13} />
          {error}
        </p>
      )}
    </section>
  );
}

function RulesSection({ workspace, saved, onSaved }: { workspace: Workspace; saved: WorkspaceRules | null; onSaved: () => void }) {
  const titleId = useId();
  const descriptionId = useId();
  const [draft, setDraft] = useState(saved?.body ?? "");
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useSaveWorkspaceRules(workspace.key);
  const remove = useDeleteWorkspaceRules(workspace.key);
  const state = rulesEditState(draft, saved?.body ?? null);
  const busy = save.isPending || remove.isPending;

  async function submit() {
    setError(null);
    try {
      await save.mutateAsync(draft);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function confirmDelete() {
    setError(null);
    try {
      await remove.mutateAsync(undefined);
      setConfirming(false);
    } catch (err) {
      setConfirming(false);
      setError(errorMessage(err));
    }
  }

  return (
    <section className={s.section} aria-labelledby={titleId}>
      <div className={s.sectionHeader}>
        <h2 id={titleId} className={s.sectionTitle}>
          LLM に守らせる作業規約
        </h2>
        <p id={descriptionId} className={s.description}>
          nod skills get / issue show / next / start の出力に含まれます。LLM は編集できません。
        </p>
      </div>
      <div className={`${s.editor} ${state.over ? s.editorOver : ""}`}>
        <textarea
          className={s.textarea}
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          aria-invalid={state.over}
          placeholder="例: コミットメッセージは日本語で書く"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <span className={`${s.counter} ${state.over ? s.counterOver : ""}`} data-testid="rules-count">
          {formatRulesCount(state.length)}
        </span>
      </div>
      {state.over && (
        <p role="alert" className={s.error}>
          <Icon name="circle-alert" size={13} />
          {RULES_MAX_LENGTH.toLocaleString("en-US")} 文字以内で入力してください
        </p>
      )}
      {error && (
        <p role="alert" className={s.error}>
          <Icon name="circle-alert" size={13} />
          {error}
        </p>
      )}
      <div className={s.footer}>
        <span className={s.meta}>{saved ? formatRulesUpdated(saved) : "未登録"}</span>
        <div className={s.buttons}>
          {saved && (
            <Button variant="danger" disabled={busy} onClick={() => setConfirming(true)}>
              規約を削除
            </Button>
          )}
          <Button variant="primary" className={s.saveButton} disabled={!state.canSave || busy} onClick={() => void submit()}>
            保存
          </Button>
        </div>
      </div>
      {confirming && (
        <DeleteDialog
          title="作業規約を削除しますか？"
          message="LLM の出力から消えます"
          busy={remove.isPending}
          onConfirm={() => void confirmDelete()}
          onClose={() => setConfirming(false)}
        />
      )}
    </section>
  );
}

// 確認ダイアログ。既定は削除の確認で、自動化の実行は confirmLabel と primary で使う
export function DeleteDialog({
  title,
  message,
  busy,
  onConfirm,
  onClose,
  confirmLabel = "削除する",
  confirmVariant = "destructive",
  className,
}: {
  title: string;
  message: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
  confirmLabel?: string;
  confirmVariant?: "destructive" | "primary";
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const messageId = useId();
  useEffect(() => {
    // 開発時の StrictMode は effect を2回呼ぶため、開いていなければ開く
    if (!ref.current?.open) ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      role="alertdialog"
      className={`${s.dialog} ${className ?? ""}`}
      aria-labelledby={titleId}
      aria-describedby={messageId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className={s.dialogBody}>
        <div className={s.dialogText}>
          <h2 id={titleId} className={s.dialogTitle}>
            {title}
          </h2>
          <p id={messageId} className={s.dialogMessage}>
            {message}
          </p>
        </div>
        <div className={s.dialogButtons}>
          <Button onClick={onClose}>キャンセル</Button>
          <Button variant={confirmVariant} disabled={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}

function SpecAssessmentSettings({ workspace, onSaved }: { workspace: Workspace; onSaved: () => void }) {
  const save = useSaveSpecAssessment(workspace.key);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState(workspace.specAssessmentEnabled ? "on" : "off");
  useEffect(() => setChosen(workspace.specAssessmentEnabled ? "on" : "off"), [workspace.specAssessmentEnabled]);
  async function choose(value: string) {
    setChosen(value);
    setError(null);
    try { await save.mutateAsync(value === "on"); onSaved(); } catch (err) { setChosen(workspace.specAssessmentEnabled ? "on" : "off"); setError(errorMessage(err)); }
  }
  return <section className={s.section} aria-label="仕様要否の自動判定">
    <div className={s.sectionHeader}>
      <h2 className={s.sectionTitle}>仕様要否の自動判定</h2>
      <p className={s.description}>新しいIssueの本文をJevで判定し、仕様整理が必要ならneeds-specを付けます。判定後のラベルは人間が管理します。既存Issueの一括判定は行いません。</p>
    </div>
    <RadioPills label="仕様要否の自動判定" name={`spec-assessment-${workspace.key}`} items={[{ value: "off", label: "無効" }, { value: "on", label: "有効" }]}
      value={chosen} disabled={save.isPending} onChange={value => void choose(value)} />
    {save.isPending && <p role="status">設定を保存しています…</p>}
    {error && <p role="alert" className={s.error}>{error}</p>}
  </section>;
}
