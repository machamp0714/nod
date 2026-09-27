// e2e のポート。Playwright の設定（Node）、テスト（Node）、e2e の server（Bun）が import するため、ほかのモジュールを import しない
export const WEB_PORT = 5199; // Vite（/api を API_PORT に転送する）
export const API_PORT = 4798; // 本物の server（C の startServer）
export const CONTROL_PORT = 4797; // テストのデータを入れる口（e2e の server と同じプロセス）
