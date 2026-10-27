// e2e のポート。Playwright の設定（Node）、テスト（Node）、e2e の server（Bun）が import するため、ほかのモジュールを import しない
export const WEB_PORT = e2ePort("NOD_E2E_WEB_PORT", 5199); // Vite（/api を API_PORT に転送する）
export const API_PORT = e2ePort("NOD_E2E_API_PORT", 4798); // 本物の server（C の startServer）
export const CONTROL_PORT = e2ePort("NOD_E2E_CONTROL_PORT", 4797); // テストのデータを入れる口（e2e の server と同じプロセス）

function e2ePort(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`${name} のポートが不正です`);
  return port;
}
