// Date.parse が実在しない日付を翌月へ補正するため、暦日も検証する。
function timestamp(value: string | null): number | null {
  const parts = value && /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return null;
  const [year, month, day] = parts.slice(1, 4).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const at = Date.parse(value!);
  return Number.isFinite(at) ? at : null;
}

export function formatReviewElapsed(startedAt: string | null, submittedAt: string | null): string {
  const start = timestamp(startedAt);
  const end = timestamp(submittedAt);
  if (start === null || end === null || end < start) return "記録なし";
  const minutes = Math.floor((end - start) / 60_000);
  if (minutes === 0) return "1分未満";
  if (minutes < 60) return `${minutes}分`;
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}
