import type { Database } from "bun:sqlite";
import { recordedTimestamp } from "./recorded-time";

// Issue の最後の活動時刻（ミリ秒）。作成・更新日時、event、コメント、確認依頼の質問・回答の最大値で、
// 正しく読めない日時は無視する。停滞の診断（#60）と自動クローズ（#71）で同じ定義を使う
export function latestActivity(db: Database, issueId: number, createdAt: string | null, updatedAt: string | null): number | null {
  const rows = db
    .query(`SELECT created_at AS at FROM events WHERE issue_id = ?1
      UNION ALL SELECT created_at FROM comments WHERE issue_id = ?1
      UNION ALL SELECT asked_at FROM questions WHERE issue_id = ?1
      UNION ALL SELECT answered_at FROM questions WHERE issue_id = ?1`)
    .all(issueId) as { at: string | null }[];
  let latest: number | null = null;
  for (const timestamp of [createdAt, updatedAt, ...rows.map((row) => row.at)]) {
    const value = recordedTimestamp(timestamp);
    if (value !== null && (latest === null || value > latest)) latest = value;
  }
  return latest;
}
