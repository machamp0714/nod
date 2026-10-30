import { Link } from "@tanstack/react-router";
import type { SprintClosureRecord } from "@nod/core";

export function SprintClosure({ record }: { record: SprintClosureRecord }) {
  const label = record.kind === "ended" ? "終了" : "中止";
  return <section aria-label={`${label}時の記録`}>
    <p><strong>{label}時の記録</strong> / 記録日時：<time dateTime={record.recordedAt}>{new Date(record.recordedAt).toLocaleString("ja-JP")}</time></p>
    <p>{label}理由：{record.reason}</p>
    <p>操作時点の残件です。現在の状態とログは各Issueで確認できます。</p>
    <details open><summary>未完了Issue（{record.issues.length}件）</summary>
      {record.issues.length === 0 && <p>未完了Issueはありません。</p>}
      {record.issues.map(issue => <p key={issue.issueId}><Link to="/issues/$issueId" params={{ issueId: issue.issueId }} aria-label={`${issue.issueId}の現在のIssue`}>{issue.issueId}</Link>：<code>{issue.status}</code></p>)}
    </details>
    <details open><summary>未回答質問（{record.questions.length}件）</summary>
      {record.questions.length === 0 && <p>未回答質問はありません。</p>}
      {record.questions.map(question => <p key={question.questionId}>質問 #{question.questionId} / <Link to="/issues/$issueId" params={{ issueId: question.issueId }}>{question.issueId}の質問とログ</Link></p>)}
    </details>
  </section>;
}
