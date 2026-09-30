import { useId, useState } from "react";
import { errorMessage } from "../api/errors";
import { useStatusNames } from "../api/hooks/workspace-labels";
import { useSaveTransitionRules, useTransitionRules } from "../api/hooks/workspace-transitions";
import type { Status, Workspace, WorkspaceTransitionRules } from "../api/types";
import { Icon } from "../components/ui";
import { STATUS_META } from "../lib/meta";
import {
  nextPair,
  RULE_STATUSES,
  type TransitionRulesDraft,
  transitionRulesDraft,
  transitionRulesEditState,
} from "../lib/transition-rules";
import type { StatusNames } from "../lib/workspace-labels";
import s from "./workspace-settings.module.css";

// ステータスの遷移ルール（#73）。許可しない遷移の組とプリセットを全体で置き換えて保存する。LLM・自動化も従う
export function TransitionRulesSection({ workspace, onSaved }: { workspace: Workspace; onSaved: () => void }) {
  const titleId = useId();
  const rules = useTransitionRules(workspace.key);
  const names = useStatusNames();
  if (rules.error) {
    return (
      <section className={s.section} aria-labelledby={titleId}>
        <Header id={titleId} />
        <p role="alert" className={s.error}>
          <Icon name="circle-alert" size={13} />
          {errorMessage(rules.error)}
        </p>
      </section>
    );
  }
  if (!rules.data) return null;
  // 保存済みのルールが変わったら（別の場所での更新を含む）下書きを作り直す
  return (
    <TransitionRulesForm
      key={JSON.stringify(rules.data)}
      titleId={titleId}
      workspace={workspace}
      saved={rules.data}
      names={names.data?.[workspace.key] ?? {}}
      onSaved={onSaved}
    />
  );
}

function Header({ id }: { id: string }) {
  return (
    <div className={s.sectionHeader}>
      <h2 id={id} className={s.sectionTitle}>
        ステータス遷移
      </h2>
      <p className={s.description}>許可しない遷移を設定します。LLM・自動化も従います。LLM は編集できません。</p>
    </div>
  );
}

function TransitionRulesForm({
  titleId,
  workspace,
  saved,
  names,
  onSaved,
}: {
  titleId: string;
  workspace: Workspace;
  saved: WorkspaceTransitionRules;
  names: StatusNames;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<TransitionRulesDraft>(() => transitionRulesDraft(saved));
  const [error, setError] = useState<string | null>(null);
  const save = useSaveTransitionRules(workspace.key);
  const state = transitionRulesEditState(draft, saved, names);
  const label = (status: Status) => names[status] ?? STATUS_META[status].label;

  function setRow(index: number, patch: Partial<{ from: Status; to: Status }>) {
    setDraft({ ...draft, forbidden: draft.forbidden.map((row, i) => (i === index ? { ...row, ...patch } : row)) });
  }

  async function submit() {
    setError(null);
    try {
      await save.mutateAsync(state.input);
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <section className={s.section} aria-labelledby={titleId}>
      <Header id={titleId} />
      <label className={s.transitionPreset}>
        <input
          type="checkbox"
          checked={draft.reviewBeforeDone}
          onChange={(event) => setDraft({ ...draft, reviewBeforeDone: event.target.checked })}
        />
        {label("done")} の前に {label("in_review")} を必須にする
      </label>
      <div className={s.labelList} role="group" aria-label="許可しない遷移">
        {draft.forbidden.length === 0 ? (
          <div className={s.labelEmpty}>制限はありません。すべての遷移を許可しています。</div>
        ) : (
          <ul className={s.labelRows}>
            {draft.forbidden.map((row, i) => {
              const invalid = state.invalidRows.includes(i);
              return (
                <li key={i} className={s.labelRow}>
                  <StatusSelect
                    label={`${i + 1} 行目の遷移元`}
                    value={row.from}
                    invalid={invalid}
                    names={names}
                    onChange={(from) => setRow(i, { from })}
                  />
                  <span className={s.transitionArrow} aria-hidden="true">
                    <Icon name="arrow-right" size={13} />
                  </span>
                  <StatusSelect
                    label={`${i + 1} 行目の遷移先`}
                    value={row.to}
                    invalid={invalid}
                    names={names}
                    onChange={(to) => setRow(i, { to })}
                  />
                  <span className={s.grow} />
                  <button
                    type="button"
                    className={`${s.smallButton} ${s.smallDanger}`}
                    aria-label={`${label(row.from)} → ${label(row.to)} を削除`}
                    onClick={() => setDraft({ ...draft, forbidden: draft.forbidden.filter((_, j) => j !== i) })}
                  >
                    削除
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <div className={s.labelAdd}>
          <div>
            <button
              type="button"
              className={s.smallButton}
              onClick={() => setDraft({ ...draft, forbidden: [...draft.forbidden, nextPair(draft.forbidden)] })}
            >
              + 遷移を追加
            </button>
          </div>
        </div>
      </div>
      {state.error && (
        <p role="alert" className={s.error}>
          <Icon name="circle-alert" size={13} />
          {state.error}
        </p>
      )}
      {error && (
        <p role="alert" className={s.error}>
          <Icon name="circle-alert" size={13} />
          {error}
        </p>
      )}
      <div className={s.footerEnd}>
        <button
          type="button"
          className={s.smallButton}
          disabled={state.empty || save.isPending}
          onClick={() => setDraft({ forbidden: [], reviewBeforeDone: false })}
        >
          すべて解除
        </button>
        <button
          type="button"
          className={`${s.smallButton} ${s.smallPrimary}`}
          aria-label="遷移ルールを保存"
          disabled={!state.canSave || save.isPending}
          onClick={() => void submit()}
        >
          保存
        </button>
      </div>
    </section>
  );
}

function StatusSelect({
  label,
  value,
  invalid,
  names,
  onChange,
}: {
  label: string;
  value: Status;
  invalid: boolean;
  names: StatusNames;
  onChange: (value: Status) => void;
}) {
  return (
    <select
      className={`${s.input} ${s.transitionSelect} ${invalid ? s.inputInvalid : ""}`}
      aria-label={label}
      aria-invalid={invalid}
      value={value}
      onChange={(event) => onChange(event.target.value as Status)}
    >
      {RULE_STATUSES.map((status) => (
        <option key={status} value={status}>
          {names[status] ?? STATUS_META[status].label}
        </option>
      ))}
    </select>
  );
}
