import type { Question } from "../../api/types";
import { countQuestions, formatQuestionCount, formatRelative } from "../../lib/format";
import { Button, Icon, ProgressBar } from "../ui";
import s from "./issue-detail.module.css";

// spec：決定数 / 総数と質問の一覧を出し、質問ごとに「質問文をコピー」と「回答を記録」を置く。「未決事項を追加」も置く。
// 操作は G で API につなぐ。
export function QuestionsPanel({ questions }: { questions: Question[] }) {
  const count = countQuestions(questions);
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
                ) : (
                  <div className={s.questionActions}>
                    <Button icon="copy" disabled title="準備中">
                      質問文をコピー
                    </Button>
                    <Button icon="square-pen" disabled title="準備中">
                      回答を記録
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className={s.panelFooter}>
        <Button icon="plus" disabled title="準備中">
          未決事項を追加
        </Button>
      </div>
    </section>
  );
}
