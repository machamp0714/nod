import { useId, useState } from "react";
import { errorMessage } from "../api/errors";
import { useAutomationDryRun, useAutomationSettings, useRunAutomation, useSaveAutomationSettings } from "../api/hooks/automation";
import { useRecurringIssues } from "../api/hooks/recurring";
import type { AutomationRecurringResult, AutomationRuleResult, AutomationRun, AutomationSettings, Workspace } from "../api/types";
import { Button, Icon } from "../components/ui";
import { TONE_COLORS } from "../lib/meta";
import { prStatePillOf, safeCheckUrl } from "../lib/pr-status";
import {
  type AutomationDraft,
  automationDraft,
  automationEditState,
  confirmTitle,
  formatEvaluatedAt,
  formatSinceDate,
  hasRunnableRule,
  prNumberLabel,
  recurringHeading,
  type RuleDraft,
  ruleHeading,
  runCounts,
  runTargets,
  runToast,
} from "../lib/automation";
import s from "./workspace-settings.module.css";
import { DeleteDialog } from "./WorkspaceSettingsPage";

// 自動化（#71 自動クローズ・#72 自動アーカイブ・#66 PR 連動・#68 コミット連動）。常駐はせず、人がこの画面か CLI から1回ずつ実行する。
// 確認・実行には定期Issue（#32）の起票も含める（nod automation run と同じ）。定期Issueの登録は定期Issueのセクションで行う。
// コミット連動はこの画面では有効・無効だけを切り替え、実行は CLI の nod git sync で行う
// （nod.pen「Workspace設定｜自動化（#71/#72）」「自動化｜状態（#71/#72）」「Workspace設定｜PR・コミット連動」）
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
  const recurring = useRecurringIssues(workspace.key);
  const state = automationEditState(draft, saved);
  const busy = save.isPending || dryRun.isPending || run.isPending;
  const noRule = !hasRunnableRule(saved, recurring.data?.filter((r) => r.enabled).length ?? 0);
  // 定期Issueを読み込むまでは、有効なルールが無いとは言えない（自動化ルールが有効なら読み込み中でも使える）
  const loadingRecurring = noRule && recurring.isPending;
  // 確認・実行は保存済みの設定で行うため、未保存の変更があるときは使えない
  const runBlocked = loadingRecurring
    ? "読み込み中…"
    : noRule
      ? "有効なルールがありません"
      : state.dirty
        ? "変更を保存してから確認・実行できます"
        : undefined;

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
    if (counts.recurring + counts.close + counts.archive + counts.prReview > 0) setConfirming(r);
  }

  // 確認ダイアログで示した一覧だけを処理する（その後に対象から外れたものはスキップとして返る）
  async function execute(confirmed: AutomationRun) {
    setError(null);
    try {
      const r = await run.mutateAsync(runTargets(confirmed));
      setConfirming(null);
      setResult(null);
      onToast(runToast(r));
      const failed = [
        ...r.recurring.failed.map((f) => `定期Issue「${f.title}」: ${f.message}`),
        ...r.rules.flatMap((rule) => rule.failed).map((f) => `${f.id}: ${f.message}`),
      ];
      if (failed.length) setError(failed.join(" / "));
    } catch (err) {
      setConfirming(null);
      setError(errorMessage(err));
    }
  }

  const setRule = (name: "close" | "archive") => (rule: RuleDraft) => setDraft((d) => ({ ...d, [name]: rule }));

  return (
    <>
      <div className={s.autoRules}>
        <RuleRow
          label="自動クローズ"
          rule={draft.close}
          invalid={state.closeInvalid}
          onChange={setRule("close")}
          suffix="日間更新のない未完了 Issue を canceled にする"
          note="対象外: triage・in_review・LLM に委任中の Issue、未完了の子を持つ親 Issue、ブロック関係のある Issue"
        />
        <RuleRow
          label="自動アーカイブ"
          rule={draft.archive}
          invalid={state.archiveInvalid}
          onChange={setRule("archive")}
          prefix="done / canceled から"
          suffix="日経過した Issue をアーカイブする"
        />
        <SwitchRow
          label="PR 連動"
          enabled={draft.prReview}
          onChange={(prReview) => setDraft((d) => ({ ...d, prReview }))}
          text="PR が open（draft 以外）かマージ済みになったら in_progress の Issue を in_review にする"
        />
        <SwitchRow
          label="コミット連動"
          enabled={draft.commitReview}
          onChange={(commitReview) => setDraft((d) => ({ ...d, commitReview }))}
          text="コミットの Closes/Fixes <ID> で Issue を in_review にする（nod git sync で実行）"
        />
        <p className={s.autoRulesNote}>
          <Icon name="info" size={13} />
          done にはしません。取消は nod automation undo
        </p>
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
          message="確認した一覧のうち、実行時にも条件に合う Issue だけを処理します。アーカイブした Issue は復元できます。"
          confirmLabel="実行する"
          confirmVariant="primary"
          busy={run.isPending}
          onConfirm={() => void execute(confirming)}
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

// 日数のないルール（PR 連動）。スイッチと説明だけ
function SwitchRow({ label, enabled, onChange, text }: { label: string; enabled: boolean; onChange: (enabled: boolean) => void; text: string }) {
  return (
    <div className={s.autoRule}>
      <div className={s.autoRow}>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={label}
          className={`${s.switch} ${enabled ? s.switchOn : ""}`}
          onClick={() => onChange(!enabled)}
        >
          <span className={s.switchKnob} />
        </button>
        <span className={enabled ? s.autoText : `${s.autoText} ${s.autoTextOff}`}>{text}</span>
      </div>
    </div>
  );
}

function DryRunResult({ run }: { run: AutomationRun }) {
  const rules = run.rules.filter((rule) => rule.enabled);
  const recurring = run.recurring.enabled > 0 || run.recurring.items.length > 0;
  if (rules.every((rule) => rule.total === 0) && run.recurring.items.length === 0) {
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
      {recurring && <RecurringResult result={run.recurring} />}
      {rules.map((rule) => (
        <RuleResult key={rule.kind} rule={rule} />
      ))}
    </div>
  );
}

// 遷移ルール（#73）で実行時にスキップする見込みの候補に添える理由
function RuleSkipNote({ reason }: { reason: string | undefined }) {
  if (!reason) return null;
  return <span className={s.ruleSkip}>{reason}</span>;
}

function RuleResult({ rule }: { rule: AutomationRuleResult }) {
  const heading = ruleHeading(rule.kind, rule.total);
  if (rule.kind === "pr_review") return <PrReviewResult rule={rule} heading={heading} />;
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
                <td className={s.colTitle}>
                  {c.title}
                  <RuleSkipNote reason={c.ruleSkipReason} />
                </td>
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

// 定期Issue（#32）の起票の予定（定期Issue・発生日・スキップ件数）。表は定期Issueのセクションの確認結果と同じ列
function RecurringResult({ result }: { result: AutomationRecurringResult }) {
  const heading = recurringHeading(result.items.length);
  return (
    <div className={s.dryRunRule}>
      <h3 className={s.dryRunHeading}>{heading}</h3>
      {result.items.length > 0 && (
        <table className={s.dryRunTable} aria-label={heading}>
          <thead>
            <tr>
              <th>定期Issue</th>
              <th className={s.colDate}>発生日</th>
              <th className={s.colDays}>スキップ件数</th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((i) => (
              <tr key={i.recurringId}>
                <td className={s.colTitle}>{i.title}</td>
                <td className={s.colDate}>{i.occurrence}</td>
                <td className={s.colDays}>{i.skipped}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// PR 連動の対象（ID・タイトル・PR・PR の状態）。保存済みの PR 状態で評価した一覧
function PrReviewResult({ rule, heading }: { rule: AutomationRuleResult; heading: string }) {
  return (
    <div className={s.dryRunRule}>
      <h3 className={s.dryRunHeading}>{heading}</h3>
      {rule.candidates.length > 0 && (
        <table className={s.dryRunTable} aria-label={heading}>
          <thead>
            <tr>
              <th className={s.colId}>ID</th>
              <th>タイトル</th>
              <th className={s.colPr}>PR</th>
              <th className={s.colPrState}>PR の状態</th>
            </tr>
          </thead>
          <tbody>
            {rule.candidates.map((c) => {
              const url = safeCheckUrl(c.prUrl ?? null);
              const pill = c.prState ? prStatePillOf(c.prState) : null;
              const color = pill ? TONE_COLORS[pill.tone] : null;
              return (
                <tr key={c.id}>
                  <td className={s.colId}>{c.id}</td>
                  <td className={s.colTitle}>
                    {c.title}
                    <RuleSkipNote reason={c.ruleSkipReason} />
                  </td>
                  <td className={s.colPr}>
                    {url ? (
                      <a className={s.prLink} href={url} target="_blank" rel="noreferrer">
                        {prNumberLabel(c.prUrl)}
                      </a>
                    ) : (
                      prNumberLabel(c.prUrl)
                    )}
                  </td>
                  <td className={s.colPrState}>
                    {pill && color && (
                      <span className={s.prPill} style={{ color: color.fg, background: color.bg }}>
                        <Icon name={pill.icon} size={11} />
                        {pill.label}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {rule.remaining > 0 && <p className={s.dryRunRemaining}>残り {rule.remaining} 件</p>}
    </div>
  );
}
