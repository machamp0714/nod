import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { errorMessage } from "../api/errors";
import { useProjects } from "../api/hooks/projects";
import {
  useAddRecurringIssue,
  useRecurringIssues,
  useRemoveRecurringIssue,
  useRunRecurringIssues,
  useTemplates,
  useUpdateRecurringIssue,
} from "../api/hooks/recurring";
import type { RecurringIssue, RecurringRun, Workspace } from "../api/types";
import { Icon } from "../components/ui";
import { priorityMeta } from "../lib/meta";
import {
  CADENCE_CHOICES,
  cadenceLabel,
  formatNext,
  formFromRecurring,
  inputFromForm,
  MONTH_DAY_CHOICES,
  newRecurringForm,
  type RecurringForm,
  recurringFormError,
  runToast,
  templateMissing,
  WEEKDAY_ORDER,
} from "../lib/recurring";
import r from "./recurring-settings.module.css";
import s from "./workspace-settings.module.css";
import { DeleteDialog } from "./WorkspaceSettingsPage";

function ErrorLine({ message }: { message: string }) {
  return (
    <p role="alert" className={s.error}>
      <Icon name="circle-alert" size={13} />
      {message}
    </p>
  );
}

function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function todayIn(timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// ブラウザの一覧には UTC が含まれないことがあるため足す。保存済みの値が一覧に無くても選べるよう先頭に置く
function timeZones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  return [...new Set([current, "UTC", ...all])];
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type Editing = { mode: "add" } | { mode: "edit"; target: RecurringIssue } | null;

// 定期Issue（#32）。nod.pen「Workspace設定｜定期Issue（#32）」。起票は「今すぐ実行」のときだけ行う
export function RecurringSection({ workspace, onSaved }: { workspace: Workspace; onSaved: (message: string) => void }) {
  const titleId = useId();
  const list = useRecurringIssues(workspace.key);
  const update = useUpdateRecurringIssue(workspace.key);
  const remove = useRemoveRecurringIssue(workspace.key);
  const run = useRunRecurringIssues(workspace.key);
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<RecurringIssue | null>(null);
  const [preview, setPreview] = useState<RecurringRun | null>(null);
  const [lastRun, setLastRun] = useState<RecurringRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const items = list.data ?? [];

  async function toggle(target: RecurringIssue) {
    setError(null);
    try {
      await update.mutateAsync({ id: target.id, patch: { enabled: !target.enabled } });
      setPreview(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  async function confirmRemove(target: RecurringIssue) {
    setError(null);
    try {
      await remove.mutateAsync(target.id);
      setRemoving(null);
      setPreview(null);
      if (editing?.mode === "edit" && editing.target.id === target.id) setEditing(null);
      onSaved("削除しました");
    } catch (err) {
      setRemoving(null);
      setError(errorMessage(err));
    }
  }

  async function execute(dryRun: boolean) {
    setError(null);
    try {
      const result = await run.mutateAsync(dryRun);
      if (dryRun) {
        setPreview(result);
        setLastRun(null);
      } else {
        setPreview(null);
        setLastRun(result);
        onSaved(runToast(result));
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const failures = templateMissing(preview ?? lastRun ?? { workspaceKey: "", dryRun: true, evaluatedAt: "", items: [], failed: [] }, items);

  return (
    <section className={s.section} aria-labelledby={titleId}>
      <div className={s.sectionHeader}>
        <h2 id={titleId} className={s.sectionTitle}>
          定期Issue
        </h2>
        <p className={s.description}>周期ごとに Issue を起票します。起票は『今すぐ実行』か nod recurring run のときだけ行います。LLM は変更できません。</p>
      </div>
      {list.error ? (
        <ErrorLine message={errorMessage(list.error)} />
      ) : items.length === 0 && list.data ? (
        editing === null && (
          <div className={r.empty}>
            <p className={r.emptyMessage}>定期Issue はまだありません</p>
            <button type="button" className={r.button} onClick={() => setEditing({ mode: "add" })}>
              <Icon name="plus" size={13} />
              定期Issue を追加
            </button>
          </div>
        )
      ) : (
        <table className={r.table} aria-label="定期Issue">
          <thead>
            <tr>
              <th className={r.colTitle}>タイトル</th>
              <th className={r.colCadence}>周期</th>
              <th className={r.colNext}>次回</th>
              <th className={r.colLast}>前回作成</th>
              <th className={r.colEnabled}>有効</th>
              <th className={r.colActions}>
                <span className={r.srOnly}>操作</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td className={r.cellTitle}>{item.title}</td>
                <td className={r.cell}>{cadenceLabel(item)}</td>
                <td className={r.cell} title={item.nextOccurrence ?? undefined}>
                  {formatNext(item.nextOccurrence)}
                </td>
                <td className={r.cell}>
                  {item.lastIssueId ? (
                    <Link to="/issues/$issueId" params={{ issueId: item.lastIssueId }} className={r.issueLink}>
                      {item.lastIssueId}
                    </Link>
                  ) : (
                    "—"
                  )}
                </td>
                <td className={r.cell}>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={item.enabled}
                    aria-label={`${item.title} を有効にする`}
                    className={`${r.switch} ${item.enabled ? r.switchOn : ""}`}
                    disabled={update.isPending}
                    onClick={() => void toggle(item)}
                  >
                    <span className={r.knob} />
                  </button>
                </td>
                <td className={r.cellActions}>
                  <button type="button" className={s.smallButton} aria-label={`${item.title} を編集`} onClick={() => setEditing({ mode: "edit", target: item })}>
                    編集
                  </button>
                  <button
                    type="button"
                    className={`${s.smallButton} ${s.smallDanger}`}
                    aria-label={`${item.title} を削除`}
                    onClick={() => setRemoving(item)}
                  >
                    削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <RecurringFormPanel
          key={editing.mode === "edit" ? `edit:${editing.target.id}:${editing.target.updatedAt}` : "add"}
          workspace={workspace}
          editing={editing}
          onDone={(message) => {
            setEditing(null);
            setPreview(null);
            onSaved(message);
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {items.length > 0 && (
        <div className={r.actions}>
          <button type="button" className={r.button} disabled={editing !== null} onClick={() => setEditing({ mode: "add" })}>
            <Icon name="plus" size={13} />
            定期Issue を追加
          </button>
          <span className={r.spacer} />
          <button type="button" className={r.button} disabled={run.isPending} onClick={() => void execute(true)}>
            <Icon name="list-checks" size={13} />
            対象を確認
          </button>
          <button type="button" className={r.button} disabled={run.isPending} onClick={() => void execute(false)}>
            <Icon name="play" size={13} />
            今すぐ実行
          </button>
        </div>
      )}
      {error && <ErrorLine message={error} />}
      {failures.map((f) => (
        <div key={f.recurringId} role="alert" className={r.failure}>
          <p className={r.failureHead}>
            <Icon name="circle-alert" size={14} />
            {f.template ? `テンプレート『${f.template}』が見つかりません` : f.message}
          </p>
          <p className={r.failureDetail}>
            この定期Issue の起票をスキップしました。{f.template ? "テンプレートを登録するか、本文に切り替えてください。" : ""}
          </p>
        </div>
      ))}
      {preview && <PreviewPanel run={preview} />}
      {removing && (
        <DeleteDialog
          title={`定期Issue「${removing.title}」を削除しますか？`}
          message="今後の起票が止まります。これまでに起票した Issue は残ります。"
          busy={remove.isPending}
          onConfirm={() => void confirmRemove(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}

function PreviewPanel({ run }: { run: RecurringRun }) {
  return (
    <div className={r.preview} role="region" aria-label="対象の確認結果">
      <div className={r.previewHead}>
        <Icon name="list-checks" size={14} />
        <span className={r.previewTitle}>起票する · {run.items.length}件</span>
        <span className={r.spacer} />
        <span className={r.previewTime}>{formatTime(run.evaluatedAt)} 時点 · まだ起票していません</span>
      </div>
      {run.items.length > 0 && (
        <table className={r.previewTable}>
          <thead>
            <tr>
              <th>定期Issue</th>
              <th className={r.colOccurrence}>発生日</th>
              <th className={r.colSkipped}>スキップ件数</th>
            </tr>
          </thead>
          <tbody>
            {run.items.map((i) => (
              <tr key={i.recurringId}>
                <td className={r.previewName}>{i.title}</td>
                <td>{i.occurrence}</td>
                <td>{i.skipped}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className={r.previewNote}>スキップ: 前回の起票以降に実行しなかった周期の分は、まとめて 1 件だけ起票します。</p>
    </div>
  );
}

function RecurringFormPanel({
  workspace,
  editing,
  onDone,
  onCancel,
}: {
  workspace: Workspace;
  editing: NonNullable<Editing>;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const ids = { title: useId(), body: useId(), project: useId(), labels: useId(), priority: useId(), assignee: useId(), cadence: useId(), start: useId(), tz: useId() };
  const [form, setForm] = useState<RecurringForm>(() =>
    editing.mode === "edit" ? formFromRecurring(editing.target) : newRecurringForm(todayIn(browserTimeZone()), browserTimeZone()),
  );
  const [labelDraft, setLabelDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const templates = useTemplates();
  const projects = useProjects();
  const add = useAddRecurringIssue(workspace.key);
  const update = useUpdateRecurringIssue(workspace.key);
  const busy = add.isPending || update.isPending;
  const set = (patch: Partial<RecurringForm>) => setForm((f) => ({ ...f, ...patch }));

  function addLabel() {
    const label = labelDraft.trim();
    if (label && !form.labels.includes(label)) set({ labels: [...form.labels, label] });
    setLabelDraft("");
  }

  async function submit() {
    const invalid = recurringFormError(form);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    try {
      if (editing.mode === "edit") {
        await update.mutateAsync({ id: editing.target.id, patch: inputFromForm(form) });
        onDone("保存しました");
      } else {
        await add.mutateAsync(inputFromForm(form));
        onDone("追加しました");
      }
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <form
      className={r.form}
      aria-label={editing.mode === "edit" ? `定期Issue「${editing.target.title}」を編集` : "定期Issue を追加"}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className={r.formTitle}>{editing.mode === "edit" ? "定期Issue を編集" : "定期Issue を追加"}</p>
      <div className={r.field}>
        <label htmlFor={ids.title} className={r.fieldLabel}>
          タイトル
        </label>
        <input id={ids.title} className={`${s.input} ${s.grow}`} value={form.title} onChange={(e) => set({ title: e.target.value })} />
      </div>
      <div className={r.field}>
        <span id={ids.body} className={r.fieldLabel}>
          本文
        </span>
        <div className={r.control}>
          <div className={r.segmented} role="radiogroup" aria-labelledby={ids.body}>
            {(["description", "template"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={form.bodyMode === mode}
                className={`${r.segment} ${form.bodyMode === mode ? r.segmentOn : ""}`}
                onClick={() => set({ bodyMode: mode })}
              >
                {mode === "description" ? "本文" : "テンプレート"}
              </button>
            ))}
          </div>
          {form.bodyMode === "template" ? (
            <select aria-label="テンプレート" className={`${s.input} ${s.grow}`} value={form.template} onChange={(e) => set({ template: e.target.value })}>
              <option value="">テンプレートを選ぶ</option>
              {form.template && !templates.data?.some((t) => t.name === form.template) && <option value={form.template}>{form.template}</option>}
              {templates.data?.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          ) : (
            <input
              aria-label="起票する Issue の説明"
              className={`${s.input} ${s.grow}`}
              placeholder="起票する Issue の説明（任意）"
              value={form.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          )}
        </div>
      </div>
      <div className={r.field}>
        <label htmlFor={ids.project} className={r.fieldLabel}>
          Project
        </label>
        <select id={ids.project} className={`${s.input} ${s.grow}`} value={form.project} onChange={(e) => set({ project: e.target.value })}>
          <option value="">なし</option>
          {form.project && !projects.data?.some((p) => p.name === form.project) && <option value={form.project}>{form.project}</option>}
          {projects.data?.map((p) => (
            <option key={p.id} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className={r.field}>
        <span id={ids.labels} className={r.fieldLabel}>
          ラベル
        </span>
        <div className={r.control} role="group" aria-labelledby={ids.labels}>
          {form.labels.map((label) => (
            <span key={label} className={r.chip}>
              {label}
              <button type="button" className={r.chipRemove} aria-label={`ラベル ${label} を外す`} onClick={() => set({ labels: form.labels.filter((l) => l !== label) })}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
          <input
            aria-label="ラベルを追加"
            className={`${s.input} ${r.labelInput}`}
            placeholder="ラベル"
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                addLabel();
              }
            }}
          />
          <button type="button" className={r.addLabel} aria-label="ラベルを足す" disabled={!labelDraft.trim()} onClick={addLabel}>
            <Icon name="plus" size={12} />
          </button>
        </div>
      </div>
      <div className={r.field}>
        <label htmlFor={ids.priority} className={r.fieldLabel}>
          優先度
        </label>
        <select id={ids.priority} className={`${s.input} ${r.narrow}`} value={form.priority} onChange={(e) => set({ priority: Number(e.target.value) })}>
          {[0, 1, 2, 3, 4].map((p) => (
            <option key={p} value={p}>
              {priorityMeta(p).label}
            </option>
          ))}
        </select>
      </div>
      <div className={r.field}>
        <label htmlFor={ids.assignee} className={r.fieldLabel}>
          担当
        </label>
        <input
          id={ids.assignee}
          className={`${s.input} ${r.narrow}`}
          list={`${ids.assignee}-list`}
          placeholder="なし"
          value={form.assignee}
          onChange={(e) => set({ assignee: e.target.value })}
        />
        <datalist id={`${ids.assignee}-list`}>
          <option value="me" />
        </datalist>
      </div>
      <div className={r.field}>
        <span id={ids.cadence} className={r.fieldLabel}>
          周期
        </span>
        <div className={r.control}>
          <div className={r.segmented} role="radiogroup" aria-labelledby={ids.cadence}>
            {CADENCE_CHOICES.map((c) => (
              <button
                key={c.value}
                type="button"
                role="radio"
                aria-checked={form.cadence === c.value}
                className={`${r.segment} ${form.cadence === c.value ? r.segmentOn : ""}`}
                onClick={() => set({ cadence: c.value })}
              >
                {c.label}
              </button>
            ))}
          </div>
          {form.cadence === "weekly" && (
            <div className={r.days} role="radiogroup" aria-label="曜日">
              {WEEKDAY_ORDER.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  role="radio"
                  aria-checked={form.weekday === d.value}
                  aria-label={`${d.label}曜`}
                  className={`${r.day} ${form.weekday === d.value ? r.dayOn : ""}`}
                  onClick={() => set({ weekday: d.value })}
                >
                  {d.label}
                </button>
              ))}
            </div>
          )}
          {form.cadence === "monthly" && (
            <select aria-label="毎月の日" className={`${s.input} ${r.monthDay}`} value={form.monthDay} onChange={(e) => set({ monthDay: Number(e.target.value) })}>
              {MONTH_DAY_CHOICES.map((d) => (
                <option key={d.value} value={d.value}>
                  {d.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
      <div className={r.field}>
        <label htmlFor={ids.start} className={r.fieldLabel}>
          開始日
        </label>
        <div className={r.control}>
          <input id={ids.start} type="date" className={`${s.input} ${r.date}`} value={form.startDate} onChange={(e) => set({ startDate: e.target.value })} />
          <label htmlFor={ids.tz} className={r.tzLabel}>
            TZ
          </label>
          <select id={ids.tz} className={`${s.input} ${r.tz}`} value={form.timeZone} onChange={(e) => set({ timeZone: e.target.value })}>
            {timeZones(form.timeZone).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error && <ErrorLine message={error} />}
      <div className={r.formFooter}>
        <button type="button" className={r.button} onClick={onCancel}>
          キャンセル
        </button>
        <button type="submit" className={`${r.button} ${r.primary}`} disabled={busy}>
          保存
        </button>
      </div>
    </form>
  );
}
