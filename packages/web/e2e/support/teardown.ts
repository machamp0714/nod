import { rmSync } from "node:fs";

// すべてのテストの後に、e2e の一時ディレクトリ（DB とテストが書いたファイル）を消す
export default function teardown(): void {
  const dir = process.env.NOD_E2E_DIR;
  if (dir) rmSync(dir, { recursive: true, force: true });
}
