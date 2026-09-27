// 現在から minutes 分前の時刻。表示の「12分前」がいつ開いても同じになるようにする。
export function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}
