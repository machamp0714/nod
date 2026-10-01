import { expect, test } from "bun:test";
import { join } from "node:path";

const MODULE = join(import.meta.dir, "../src/local-time.ts");

// タイムゾーンは起動時に決まるので、TZ を固定した別プロセスで確かめる
function inZone(tz: string, expr: string): string {
  const p = Bun.spawnSync(["bun", "-e", `import { localDate, localMinute } from ${JSON.stringify(MODULE)}; console.log(${expr});`], {
    env: { ...process.env, TZ: tz },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) throw new Error(p.stderr.toString());
  return p.stdout.toString().trim();
}

test("localMinute は記録時刻（UTC の ISO）をそのマシンのローカル時刻の YYYY-MM-DD HH:mm にする", () => {
  expect(inZone("Asia/Tokyo", `localMinute("2026-09-30T12:46:10.000Z")`)).toBe("2026-09-30 21:46");
  expect(inZone("UTC", `localMinute("2026-09-30T12:46:10.000Z")`)).toBe("2026-09-30 12:46");
  // 日付をまたぐ
  expect(inZone("Asia/Tokyo", `localMinute("2026-09-30T15:30:00.000Z")`)).toBe("2026-10-01 00:30");
  expect(inZone("America/Los_Angeles", `localMinute("2026-09-30T03:00:00.000Z")`)).toBe("2026-09-29 20:00");
});

test("localDate はローカルの暦日にする（UTC の日付を切り出さない）", () => {
  expect(inZone("Asia/Tokyo", `localDate("2026-09-30T15:30:00.000Z")`)).toBe("2026-10-01");
  expect(inZone("UTC", `localDate("2026-09-30T15:30:00.000Z")`)).toBe("2026-09-30");
});

test("読めない値はそのまま返す", () => {
  expect(inZone("Asia/Tokyo", `localMinute("記録なし")`)).toBe("記録なし");
  expect(inZone("Asia/Tokyo", `localDate("")`)).toBe("");
});
