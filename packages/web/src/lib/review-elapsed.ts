import { recordedTimestamp } from "@nod/core/src/recorded-time";

export function formatReviewElapsed(startedAt: string | null, submittedAt: string | null): string {
  const start = recordedTimestamp(startedAt);
  const end = recordedTimestamp(submittedAt);
  if (start === null || end === null || end < start) return "記録なし";
  const minutes = Math.floor((end - start) / 60_000);
  if (minutes === 0) return "1分未満";
  if (minutes < 60) return `${minutes}分`;
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}
