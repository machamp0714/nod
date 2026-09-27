# @nod/web

nod の Web UI（Vite、React、TanStack Router、TanStack Query）。

## 使い方

```sh
cd packages/web
bun install
bun run dev        # http://localhost:5173
bun run test       # 単体テスト（bun test）
bun run test:e2e   # Playwright（初回は bunx playwright install chromium）
bun run typecheck
bun run build
```

## ルートのワークスペースとの統合

このパッケージは、ルートの `package.json` がなくても単体で動く。
ルートの `package.json`（`"workspaces": ["packages/*"]`）と一緒になったら、次を行う。

1. `packages/web/bun.lock` と `packages/web/node_modules/` を消し、ルートで `bun install` を実行する。
2. ルートの `tsconfig.json` に `"exclude": ["packages/web"]` を足す（web は JSX と DOM の設定が違うため、このディレクトリで `bun run typecheck` を別に実行する）。
3. ルートで `bun test` を実行し、web の単体テスト（`src/**/*.test.ts`）も通ることを確かめる。

Playwright のテストは `e2e/*.e2e.ts` に置く。
`*.spec.ts` にすると、ルートの `bun test` が拾ってしまう。
