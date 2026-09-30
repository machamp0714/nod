import { getRouteApi, Link } from "@tanstack/react-router";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { useDecision, useOpenQuestions, useWorkspaceName } from "../api/hooks/decision";
import { useIssueDetail } from "../api/hooks/shared";
import type { OpenQuestion, Question } from "../api/types";
import { ActionError } from "../components/split/ActionError";
import { AgentAvatar, Icon, ProgressBar, StatusLabel, WorkspaceBadge } from "../components/ui";
import { formatRelative } from "../lib/format";
import {
  filterOpenQuestionEntries,
  groupOpenQuestions,
  nextOpenQuestionEntry,
  type OpenQuestionEntry,
  type OpenQuestionGroup,
  openQuestionFilterOptions,
  openQuestionSections,
} from "../lib/open-questions";
import type { OpenQuestionsSearch } from "../routes/open-questions-search";
import s from "./open-questions.module.css";

const route = getRouteApi("/open-questions");

const GROUPS: { value: OpenQuestionGroup; label: string }[] = [
  { value: "project", label: "Project" },
  { value: "none", label: "なし" },
];

// 人が付けた未回答の未決事項を Issue 横断で見て回答する（#173）。nod.pen T5k0Dn・S6fqq4・m2aCdE・SbKB6。
// LLM からの質問は Inbox が出すので、ここには出さない
export function OpenQuestionsPage() {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const query = useOpenQuestions();
  const workspaceName = useWorkspaceName();
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const setDraft = (id: number, text: string) => setDrafts((previous) => ({ ...previous, [id]: text }));

  const all = groupOpenQuestions(query.data?.questions ?? []);
  const options = openQuestionFilterOptions(all);
  const entries = filterOpenQuestionEntries(all, { workspace: search.workspace, project: search.project, q: search.q });
  const group: OpenQuestionGroup = search.group === "none" ? "none" : "project";
  const sections = openQuestionSections(entries, group);
  // 一覧に出ている順。Project でまとめると、優先度の順とは並びが変わる
  const order = sections.flatMap((section) => section.entries.map((entry) => entry.issueId));

  // 回答で Issue が一覧から消えたら、消える前の並びで次にあった Issue を選ぶ
  const shown = useRef<{ order: string[]; current?: string }>({ order: [] });
  const currentId =
    search.selected !== undefined && order.includes(search.selected)
      ? search.selected
      : nextOpenQuestionEntry(shown.current.order, order, shown.current.current);
  const current = entries.find((entry) => entry.issueId === currentId);
  useEffect(() => {
    const previous = shown.current.current;
    shown.current = { order, current: currentId };
    if (currentId !== undefined && previous !== undefined && previous !== currentId && search.selected !== currentId) {
      void navigate({ search: (prev) => ({ ...prev, selected: currentId }), replace: true });
    }
  });

  const update = (patch: Partial<OpenQuestionsSearch>) => void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
  const filtered = search.workspace !== undefined || search.project !== undefined || search.q !== undefined;
  const count = entries.reduce((sum, entry) => sum + entry.questions.length, 0);

  return (
    <div className={s.split}>
      <section className={s.list} aria-label="未決事項の一覧">
        <header className={s.header}>
          <h1 className={s.title}>Open questions</h1>
          <span className={s.count} data-testid="open-question-count">{count}</span>
        </header>
        <div className={s.filters}>
          <div className={s.row}>
            <FilterSelect label="Workspace" value={search.workspace ?? ""} onChange={(value) => update({ workspace: value || undefined })}>
              <option value="">All workspaces</option>
              {withCurrent(options.workspaces, search.workspace).map((key) => (
                <option key={key} value={key}>{workspaceName(key)}</option>
              ))}
            </FilterSelect>
            <FilterSelect label="Project" value={search.project === undefined ? "" : String(search.project)} onChange={(value) => update({ project: value ? Number(value) : undefined })}>
              <option value="">すべての Project</option>
              {options.projects.map((p) => (
                <option key={p.id} value={String(p.id)}>{p.name}</option>
              ))}
              {search.project !== undefined && !options.projects.some((p) => p.id === search.project) && (
                <option value={String(search.project)}>Project {search.project}</option>
              )}
            </FilterSelect>
          </div>
          <div className={s.row}>
            <label className={s.search}>
              <Icon name="search" size={14} color="var(--ink3)" />
              <input
                type="search"
                aria-label="未決事項を絞り込む"
                placeholder="質問文・タイトル・ID で絞り込み"
                value={search.q ?? ""}
                onChange={(event) => update({ q: event.target.value || undefined })}
              />
            </label>
            <div role="tablist" aria-label="グループ化" className={s.segmented}>
              {GROUPS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  role="tab"
                  aria-selected={item.value === group}
                  className={s.segment}
                  onClick={() => update({ group: item.value === "none" ? "none" : undefined })}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {query.isPending ? (
          <p className={s.loading}>読み込み中…</p>
        ) : query.isError ? (
          <div className={s.items}><ActionError error={query.error} /></div>
        ) : entries.length === 0 ? (
          <div className={s.emptyState}>
            <Icon name={filtered ? "file-search" : "message-circle-warning"} size={24} color="var(--ink3)" />
            <p>{filtered ? "条件に合う未決事項はありません" : "未回答の未決事項はありません"}</p>
          </div>
        ) : (
          <div className={s.items}>
            {sections.map((section) =>
              section.label === null ? (
                section.entries.map((entry) => <EntryItem key={entry.issueId} entry={entry} search={search} selected={entry === current} />)
              ) : (
                <section key={section.key} role="group" aria-label={section.label} className={s.group}>
                  <h2 className={s.groupHead}>
                    <Icon name="box" size={14} color="var(--ink3)" />
                    <span>{section.label}</span>
                    <span className={s.groupCount}>{section.count}</span>
                  </h2>
                  {section.entries.map((entry) => <EntryItem key={entry.issueId} entry={entry} search={search} selected={entry === current} />)}
                </section>
              ),
            )}
          </div>
        )}
      </section>
      <section className={s.detail} aria-label="詳細">
        {current && <EntryDetail key={current.issueId} entry={current} drafts={drafts} setDraft={setDraft} />}
      </section>
    </div>
  );
}

// URL で指定された値が選択肢に無くても（すべて回答済みになった Workspace など）、選択を保つ
function withCurrent(values: string[], current: string | undefined): string[] {
  return current === undefined || values.includes(current) ? values : [...values, current];
}

function FilterSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (value: string) => void; children: ReactNode }) {
  return (
    <label className={s.select}>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
      <Icon name="chevron-down" size={12} color="var(--ink3)" />
    </label>
  );
}

function EntryItem({ entry, search, selected }: { entry: OpenQuestionEntry; search: OpenQuestionsSearch; selected: boolean }) {
  const oldest = entry.questions.find((q) => q.askedAt === entry.oldestAt) ?? entry.questions[0];
  return (
    <Link to="/open-questions" search={{ ...search, selected: entry.issueId }} className={s.item} data-selected={selected}>
      <div className={s.itemHead}>
        <span className={s.itemTitle}>{entry.issueTitle}</span>
        <span className={s.itemTime}>{formatRelative(entry.oldestAt)}</span>
      </div>
      {oldest && <p className={s.itemQuestion}>{oldest.question}</p>}
      <div className={s.itemMeta}>
        <WorkspaceBadge workspaceKey={entry.workspace} />
        <span className={s.itemId}>{entry.issueId}</span>
        <span className={s.openPill}>未決 {entry.questionCount.answered}/{entry.questionCount.total}</span>
      </div>
    </Link>
  );
}

function EntryDetail({ entry, drafts, setDraft }: { entry: OpenQuestionEntry; drafts: Record<number, string>; setDraft: (id: number, text: string) => void }) {
  const detail = useIssueDetail(entry.issueId);
  const [showDecided, setShowDecided] = useState(false);
  const decided = (detail.data?.questions ?? []).filter((q) => q.answer !== null);
  const count = entry.questionCount;
  return (
    <div className={s.detailBody}>
      <div className={s.crumb}>
        <WorkspaceBadge workspaceKey={entry.workspace} />
        <span className={s.crumbId}>{entry.issueId}</span>
        <span className={s.dot}>·</span>
        <StatusLabel status={entry.status} workspace={entry.workspace} />
        {entry.project && (
          <>
            <span className={s.dot}>·</span>
            <span className={s.crumbProject}>
              <Icon name="box" size={12} color="var(--ink3)" />
              {entry.project.name}
            </span>
          </>
        )}
      </div>
      <h2 className={s.issueTitle}>{entry.issueTitle}</h2>
      <div className={s.heading}>
        <h3 className={s.headingTitle}>未決事項</h3>
        <span className={s.progress}>
          <span>{count.answered} / {count.total} 決定</span>
          <ProgressBar value={count.answered} max={count.total} width={80} />
        </span>
      </div>

      {entry.questions.map((question) => (
        <QuestionCard key={question.id} question={question} answer={drafts[question.id] ?? ""} setAnswer={(text) => setDraft(question.id, text)} />
      ))}

      {count.answered > 0 && (
        <div className={s.decided}>
          <button type="button" className={s.decidedToggle} aria-expanded={showDecided} onClick={() => setShowDecided((open) => !open)}>
            <Icon name={showDecided ? "chevron-down" : "chevron-right"} size={14} />
            決定済み {count.answered} 件
          </button>
          {showDecided && (detail.isError ? <ActionError error={detail.error} /> : decided.map((q) => <DecidedItem key={q.id} question={q} />))}
        </div>
      )}

      <p className={s.note}>
        <Icon name="info" size={14} />
        回答は Issue に記録されます。すべて決まると Issue は元のステータス（Todo / Backlog）に戻ります。
      </p>
      <Link to="/issues/$issueId" params={{ issueId: entry.issueId }} className={s.openIssue}>
        Issue を開く
        <Icon name="arrow-right" size={14} />
      </Link>
    </div>
  );
}

function DecidedItem({ question }: { question: Question }) {
  return (
    <div className={s.decidedItem}>
      <div className={s.decidedHead}>
        <Icon name="check" size={14} color="var(--ready)" />
        <span className={s.decidedQuestion}>{question.question}</span>
        {question.answeredAt && <span className={s.itemTime}>{formatRelative(question.answeredAt)}</span>}
      </div>
      <p className={s.decidedAnswer}>回答：{question.answer}</p>
    </div>
  );
}

// 質問ごとの回答欄。回答は questionId を付けて送り、この質問だけを回答済みにする（Inbox と同じ経路）
function QuestionCard({ question, answer, setAnswer }: { question: OpenQuestion; answer: string; setAnswer: (text: string) => void }) {
  const decision = useDecision();
  const [notice, setNotice] = useState<string | null>(null);
  const text = answer.trim();
  const canSubmit = text !== "" && !decision.isPending;
  const submit = () => {
    if (!canSubmit) return;
    decision.mutate({ op: "answer", issueId: question.issueId, questionId: question.id, answer: text }, { onSuccess: () => setAnswer("") });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(question.question);
      setNotice("質問文をコピーしました");
    } catch {
      setNotice("質問文をコピーできませんでした");
    }
  };
  return (
    <section className={s.card} aria-label="未決事項">
      <div className={s.cardQuestion}>
        <div className={s.cardHead}>
          <AgentAvatar actor={question.askedBy} />
          <span className={s.cardHeadText}>{question.askedBy} が残した未決事項</span>
          <span className={s.cardTime}>{formatRelative(question.askedAt)}</span>
        </div>
        <p className={s.questionText}>{question.question}</p>
      </div>
      <textarea
        className={s.textarea}
        aria-label="回答"
        placeholder="回答を入力…"
        value={answer}
        disabled={decision.isPending}
        onChange={(event) => setAnswer(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className={s.cardFooter}>
        <button type="button" className={s.pillButton} onClick={() => void copy()}>
          <Icon name="copy" size={13} />
          質問文をコピー
        </button>
        <span className={s.notice} role="status">{notice}</span>
        <span className={s.shortcut}>⌘ Enter</span>
        <button type="button" className={`${s.pillButton} ${s.pillPrimary}`} disabled={!canSubmit} onClick={submit}>
          回答を記録
        </button>
      </div>
      {decision.error && <div className={s.cardError}><ActionError error={decision.error} /></div>}
    </section>
  );
}
