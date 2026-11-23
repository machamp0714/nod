# @nod/web

nod の Web UI（Vite、React、TanStack Router、TanStack Query）。

## 使い方

```sh
bun install                     # ルートで実行する
bun run server                  # ルートで実行する。http://127.0.0.1:4700 で API を起動する
cd packages/web
bun run dev                     # http://localhost:5173。/api は 4700 に転送する（NOD_API_URL で変えられる）
bun run test                    # 単体テスト（bun test）
bun run test:e2e                # Playwright（初回は bunx playwright install chromium）
bun run typecheck
bun run build
```

web の型検査はこのディレクトリで行う（ルートの `tsconfig.json` は `packages/web` を除いている）。

## e2e

`bun run test:e2e` は、一時ディレクトリ（`NOD_E2E_DIR`）に DB を作り、`e2e/server.ts` を Bun で起動する。
`e2e/server.ts` は、本物の server（`@nod/server` の `startServer`）を 4798 で、テストのデータを入れる口を 4797 で待ち受ける。
Vite は 5199 で起動し、`/api` を 4798 に転送する。

テストは1つの DB を共有するため、1つずつ実行する。
各テストの前に DB を空にし、`test.use({ dataset: "<名前>" })` で選んだデータセット（`e2e/datasets/<名前>.ts`）を入れる。
選ばなければ空の DB から始まる。
テストの中では、`nod` フィクスチャで書き手を選んで core の関数を呼べる（`nod.me.createIssue(...)`、`nod.claude.askQuestion(...)`）。
この書き込みは server とは別の接続で行うため、LLM が `nod` を実行したときと同じく、SSE の `change` が画面に届く。

Playwright のテストは `e2e/*.e2e.ts` に置く。
`*.spec.ts` にすると、ルートの `bun test` が拾ってしまう。

Sprint終了のE2Eでは名前付きdialog内の終了理由を `getByRole("textbox", { name: "終了理由", exact: true })` で指定する。
Playwright 1.63 の `getByLabel` は入れ子のtextareaの初期値もラベルのテキストに含めるため、`exact: true` では「終了理由」と一致しないことをブラウザで確認した。
dialog名とtextboxのアクセシブルな名前は保ち、初期値とは異なる理由を入力して終了記録への保存を検証する。
