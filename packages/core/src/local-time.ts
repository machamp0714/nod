// 記録時刻（UTC の ISO）の表示用の変換。保存する値と --json の値は UTC の ISO のまま変えない
const pad = (n: number) => String(n).padStart(2, "0");

// このマシンのローカルの暦日（YYYY-MM-DD）。読めない値はそのまま返す
export function localDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// このマシンのローカル時刻の YYYY-MM-DD HH:mm。読めない値はそのまま返す
export function localMinute(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${localDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
