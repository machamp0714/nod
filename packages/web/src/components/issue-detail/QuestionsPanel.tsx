import { useEffect, useRef, useState } from "react";
import type { AskResult, Question } from "../../api/types";
import { countQuestions, formatQuestionCount, formatRelative } from "../../lib/format";
import { hasText } from "../../lib/issue-edit";
import { Button, Icon, ProgressBar } from "../ui";
import s from "./issue-detail.module.css";
import { useAsyncAction } from "./useAsyncAction";

// spec：決定数 / 総数と質問の一覧を出し、質問ごとに「質問文をコピー」と「回答を記録」を置く。「未決事項を追加」も置く。
export function QuestionsPanel({
  questions,
  onAnswer,
  onAsk,
  answerRequest,
  onBusyChange,
}: {
  answerRequest?: { questionId: number; requestId: number };
  onBusyChange?: (busy: boolean) => void;
  questions: Question[];
  onAnswer: (questionId: number, answer: string) => Promise<unknown>;
  onAsk: (question: string) => Promise<AskResult>;
}) {
  const count = countQuestions(questions);
  const [answering, setAnswering] = useState<number | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const answer = answering === null ? "" : drafts[answering] ?? "";
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const handledRequest = useRef<number | undefined>(undefined);
  const [focusRequest, setFocusRequest] = useState(0);
  const [adding, setAdding] = useState(false);
  const [newQuestion, setNewQuestion] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const action = useAsyncAction();

  useEffect(() => { onBusyChange?.(action.busy); }, [action.busy, onBusyChange]);

  useEffect(() => {
    if (!answerRequest || handledRequest.current === answerRequest.requestId) return;
    handledRequest.current = answerRequest.requestId;
    if (action.busy) return;
    const question = questions.find((q) => q.id === answerRequest.questionId);
    if (!question || question.answer !== null) {
      setNotice("この質問はすでに回答済みです");
      return;
    }
    setNotice(null);
    action.clearError();
    setAdding(false);
    setAnswering(question.id);
    setFocusRequest((n) => n + 1);
  }, [answerRequest, questions, action.busy]);

  useEffect(() => {
    if (answering !== null && !questions.some((q) => q.id === answering && q.answer === null)) {
      setAnswering(null);
    }
  }, [questions, answering]);

  useEffect(() => {
    if (answering === null) return;
    answerRef.current?.scrollIntoView({ block: "center" });
    answerRef.current?.focus({ preventScroll: true });
  }, [answering, focusRequest]);

  function resetMessages() {
    setNotice(null);
    action.clearError();
  }

  function startAnswer(questionId: number) {
    resetMessages();
    setAdding(false);
    setAnswering(questionId);
    setFocusRequest((n) => n + 1);
  }

  // 失敗（別の場所で先に回答された 409 など）は、パネルの下にメッセージを出す。
  // ページが読み直した質問は回答済みになるため、フォームは質問の側で閉じる。
  async function record(questionId: number) {
    if (action.busy) return;
    if (await action.run(() => onAnswer(questionId, answer.trim()), "記録できませんでした")) {
      setAnswering(null);
      setDrafts((previous) => { const next = { ...previous }; delete next[questionId]; return next; });
    }
  }

  async function copy(question: Question) {
    resetMessages();
    try {
      await navigator.clipboard.writeText(question.question);
      setNotice("質問文をコピーしました");
    } catch {
      setNotice("質問文をコピーできませんでした");
    }
  }

  async function ask() {
    let created = true;
    const ok = await action.run(async () => {
      created = (await onAsk(newQuestion.trim())).created;
    }, "追加できませんでした");
    if (!ok) return;
    setAdding(false);
    setNewQuestion("");
    if (!created) setNotice("同じ未決事項がすでにあります");
  }

  return (
    <section className={s.panel} aria-label="未決事項">
      <header className={s.questionsHead}>
        <div className={s.panelTitleRow}>
          <Icon name="message-circle-warning" />
          <h2 className={s.panelTitle}>未決事項</h2>
          <span className={s.spacer} />
          <span>{formatQuestionCount(count)} 決定</span>
        </div>
        {count.total > 0 && <ProgressBar value={count.decided} max={count.total} tone="ask" width="100%" />}
      </header>
      {questions.length === 0 ? (
        <p className={s.panelEmpty}>未決事項はありません</p>
      ) : (
        <ul>
          {questions.map((q) => (
            <li key={q.id} className={s.question}>
              <span className={s.questionIcon}>
                <Icon name={q.answer === null ? "circle" : "circle-check"} color={q.answer === null ? "var(--ask)" : "var(--ready)"} />
              </span>
              <div className={s.questionBody}>
                <p className={s.questionText}>{q.question}</p>
                <p className={s.questionMeta}>
                  {q.askedBy} · {formatRelative(q.askedAt)}
                </p>
                {q.answer !== null ? (
                  <p className={s.answer}>回答：{q.answer}</p>
                ) : answering === q.id ? (
                  <div className={s.form}>
                    <textarea
                      ref={answerRef}
                      disabled={action.busy}
                      className={s.textarea}
                      aria-label="回答"
                      rows={3}
                      value={answer}
                      onChange={(e) => setDrafts((previous) => ({ ...previous, [q.id]: e.target.value }))}
                    />
                    <div className={s.formActions}>
                      <Button onClick={() => setAnswering(null)} disabled={action.busy}>
                        キャンセル
                      </Button>
                      <Button variant="primary" icon="check" onClick={() => void record(q.id)} disabled={action.busy || !hasText(answer)}>
                        記録する
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className={s.questionActions}>
                    <Button icon="copy" onClick={() => void copy(q)} disabled={action.busy}>
                      質問文をコピー
                    </Button>
                    <Button icon="square-pen" onClick={() => startAnswer(q.id)} disabled={action.busy}>
                      回答を記録
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {(notice || action.error) && (
        <div className={s.panelMessages}>
          {notice && (
            <p className={s.notice} role="status">
              {notice}
            </p>
          )}
          {action.error && (
            <p className={s.error} role="alert">
              {action.error}
            </p>
          )}
        </div>
      )}
      <div className={s.panelFooter}>
        {adding ? (
          <div className={s.form}>
            <textarea
              disabled={action.busy}
              className={s.textarea}
              aria-label="未決事項"
              rows={2}
              value={newQuestion}
              onChange={(e) => setNewQuestion(e.target.value)}
            />
            <div className={s.formActions}>
              <Button onClick={() => setAdding(false)} disabled={action.busy}>
                キャンセル
              </Button>
              <Button variant="primary" icon="plus" onClick={() => void ask()} disabled={action.busy || !hasText(newQuestion)}>
                追加する
              </Button>
            </div>
          </div>
        ) : (
          <Button
            disabled={action.busy}
            icon="plus"
            onClick={() => {
              resetMessages();
              setAnswering(null);
              setAdding(true);
            }}
          >
            未決事項を追加
          </Button>
        )}
      </div>
    </section>
  );
}
