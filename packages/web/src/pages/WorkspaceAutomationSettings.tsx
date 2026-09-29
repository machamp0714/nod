import { useId, useState } from "react";
import { errorMessage } from "../api/errors";
import { useAutomationDryRun, useAutomationSettings, useRunAutomation, useSaveAutomationSettings } from "../api/hooks/automation";
import type { AutomationRuleResult, AutomationRun, AutomationSettings, Workspace } from "../api/types";
import { Button, Icon } from "../components/ui";
import {
  type AutomationDraft,
  automationDraft,
  automationEditState,
  confirmTitle,
  formatEvaluatedAt,
  formatSinceDate,
  type RuleDraft,
  ruleHeading,
  runCounts,
  runToast,
} from "../lib/automation";
import s from "./workspace-settings.module.css";
import { DeleteDialog } from "./WorkspaceSettingsPage";

// 自動化（#71 自動クローズ・#72 自動アーカイブ）。常駐はせず、人がこの画面か CLI から1回ずつ実行する
// （nod.pen「Workspace設定｜自動化（#71/#72）」「自動化｜状態（#71/#72）」）
export function AutomationSection({ workspace, onToast }: { workspace: Workspace; onToast: (message: string) => void }) {
  const titleId = useId();
  const settings = useAutomationSettings(workspace.key);
  return (
    <section className={s.section} aria-labelledby={titleId}>
      <div className={s.sectionHeader}>
        <h2 id={titleId} className={s.sectionTitle}>
          自動化
        </h2>
        <p className={s.description}>日数を過ぎた Issue を自動でクローズ・アーカイブします。LLM は設定を変更できません。</p>
      </div>
      {settings.error ? (
        <ErrorLine message={errorMessage(settings.error)} />
      ) : (
        settings.data && (
          // 保存済みの設定が変わったら（別の場所での更新を含む）下書きを作り直す
          <AutomationEditor key={settings.data.updatedAt ?? ""} workspace={workspace} saved={settings.data} onToast={onToast} />
        )
      )}
    </section>
  );
}

function ErrorLine({ message }: { message: string }) {
  return (
    <p role="alert" className={s.error}>
      <Icon name="circle-alert" size={13} />
      {message}
    </p>
  );
}

function AutomationEditor({ workspace, saved, onToast }: { workspace: Workspace; saved: AutomationSettings; onToast: (message: string) => void }) {
  const [draft, setDraft] = useState<AutomationDraft>(() => automationDraft(saved));
  const [result, setResult] = useState<AutomationRun | null>(null);
  const [confirming, setConfirming] = useState<AutomationRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useSaveAutomationSettings(workspace.key);
  const dryRun = useAutomationDryRun(workspace.key);
  const run = useRunAutomation(workspace.key);
  const state = automationEditState(draft, saved);
  const busy = save.isPending || dryRun.isPending || run.isPending;
  const noRule = saved.closeAfterDays === null && saved.archiveAfterDays === null;
  // 確認・実行は保存済みの設定で行うため、未保存の変更があるときは使えない
  const runBlocked = noRule ? "有効なルールがありません" : state.dirty ? "変更を保存してから確認・実行できます" : undefined;

  async function submit() {
    setError(null);
    try {
      await save.mutateAsync(state.input);
      setResult(null);
      onToast("保存しました");
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function check(): Promise<AutomationRun | null> {
    setError(null);
    try {
      const r = await dryRun.mutateAsync();
      setResult(r);
      return r;
    } catch (err) {
      setError(errorMessage(err));
      return null;
    }
  }

  // 実行前に対象を取り直し、件数を示して確認する。対象がなければ確認結果だけを示す
  async function prepareRun() {
    const r = await check();
    if (!r) return;
    const counts = runCounts(r);
    if (counts.close + counts.archive > 0) setConfirming(r);
  }

  async function execute() {
    setError(null);
    try {
      const r = await run.mutateAsync(undefined);
      setConfirming(null);
      setResult(null);
      onToast(runToast(r));
      const failed = r.rules.flatMap((rule) => rule.failed);
      if (failed.length) setError(failed.map((f) => `${f.id}: ${f.message}`).join(" / "));
    } catch (err) {
      setConfirming(null);
      setError(errorMessage(err));
    }
  }

  const setRule = (name: keyof AutomationDraft) => (rule: RuleDraft) => setDraft((d) => ({ ...d, [name]: rule }));

  return (
    <>
      <div className={s.autoRules}>
        <RuleRow
          label="自動クローズ"
          rule={draft.close}
          invalid={state.closeInvalid}
          onChange={setRule("close")}
          suffix="日間更新のない未完了 Issue を canceled にする"
          note="対象外: triage・in_review・LLM に委任中の Issue、未完了の子を持つ親 Issue"
        />
        <RuleRow
          label="自動アーカイブ"
          rule={draft.archive}
          invalid={state.archiveInvalid}
          onChange={setRule("archive")}
          prefix="done / canceled から"
          suffix="日経過した Issue をアーカイブする"
        />
      </div>
      {error && <ErrorLine message={error} />}
      <div className={s.autoFooter}>
        <Button icon="list-checks" disabled={busy || runBlocked !== undefined} title={runBlocked} onClick={() => void check()}>
          対象を確認
        </Button>
        <Button icon="play" disabled={busy || runBlocked !== undefined} title={runBlocked} onClick={() => void prepareRun()}>
          今すぐ実行
        </Button>
        <span className={s.autoSpacer} />
        <Button variant="primary" className={s.saveButton} disabled={!state.canSave || busy} onClick={() => void submit()}>
          保存
        </Button>
      </div>
      {result && <DryRunResult run={result} />}
      {confirming && (
        <DeleteDialog
          title={confirmTitle(confirming)}
          message="対象は実行時点の条件で決まります。アーカイブした Issue は復元できます。"
          confirmLabel="実行する"
          confirmVariant="primary"
          busy={run.isPending}
          onConfirm={() => void execute()}
          onClose={() => setConfirming(null)}
        />
      )}
    </>
  );
}

function RuleRow({
  label,
  rule,
  invalid,
  onChange,
  prefix,
  suffix,
  note,
}: {
  label: string;
  rule: RuleDraft;
  invalid: boolean;
  onChange: (rule: RuleDraft) => void;
  prefix?: string;
  suffix: string;
  note?: string;
}) {
  const textClass = rule.enabled ? s.autoText : `${s.autoText} ${s.autoTextOff}`;
  return (
    <div className={s.autoRule}>
      <div className={s.autoRow}>
        <button
          type="button"
          role="switch"
          aria-checked={rule.enabled}
          aria-label={label}
          className={`${s.switch} ${rule.enabled ? s.switchOn : ""}`}
          onClick={() => onChange({ ...rule, enabled: !rule.enabled })}
        >
          <span className={s.switchKnob} />
        </button>
        {prefix && <span className={textClass}>{prefix}</span>}
        <input
          className={`${s.daysInput} ${invalid ? s.daysInputInvalid : ""}`}
          inputMode="numeric"
          aria-label={`${label}の日数`}
          aria-invalid={invalid}
          disabled={!rule.enabled}
          value={rule.days}
          onChange={(event) => onChange({ ...rule, days: event.target.value })}
        />
        <span className={textClass}>{suffix}</span>
      </div>
      {note && <p className={s.autoNote}>{note}</p>}
      {invalid && <ErrorLine message="1〜3650 の日数を入力してください" />}
    </div>
  );
}

function DryRunResult({ run }: { run: AutomationRun }) {
  const rules = run.rules.filter((rule) => rule.enabled);
  if (rules.every((rule) => rule.total === 0)) {
    return (
      <div className={s.dryRunEmpty} role="region" aria-label="対象の確認結果">
        対象の Issue はありません
      </div>
    );
  }
  return (
    <div className={s.dryRun} role="region" aria-label="対象の確認結果">
      <div className={s.dryRunHead}>
        <Icon name="list-checks" size={14} />
        <span className={s.dryRunTitle}>対象の確認結果（まだ実行していません）</span>
        <span className={s.autoSpacer} />
        <span className={s.dryRunTime}>{formatEvaluatedAt(run.evaluatedAt)}</span>
      </div>
      {rules.map((rule) => (
        <RuleResult key={rule.kind} rule={rule} />
      ))}
    </div>
  );
}

function RuleResult({ rule }: { rule: AutomationRuleResult }) {
  const heading = ruleHeading(rule.kind, rule.total);
  return (
    <div className={s.dryRunRule}>
      <h3 className={s.dryRunHeading}>{heading}</h3>
      {rule.candidates.length > 0 && (
        <table className={s.dryRunTable} aria-label={heading}>
          <thead>
            <tr>
              <th className={s.colId}>ID</th>
              <th>タイトル</th>
              <th className={s.colDate}>最終更新</th>
              <th className={s.colDays}>経過日数</th>
            </tr>
          </thead>
          <tbody>
            {rule.candidates.map((c) => (
              <tr key={c.id}>
                <td className={s.colId}>{c.id}</td>
                <td className={s.colTitle}>{c.title}</td>
                <td className={s.colDate}>{formatSinceDate(c.since)}</td>
                <td className={s.colDays}>{c.elapsedDays} 日</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {rule.remaining > 0 && <p className={s.dryRunRemaining}>残り {rule.remaining} 件</p>}
    </div>
  );
}
