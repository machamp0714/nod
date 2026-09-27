import { ago } from "./time";

export interface ReviewReport {
  actor: string;
  at: string;
  body: string;
  plan: { done: number; total: number };
}

// nod issue done --summary の報告のダミー。D で API の値に置き換える。
export const REVIEW_REPORTS: Record<string, ReviewReport> = {
  "API-7": {
    actor: "claude-code",
    at: ago(20),
    body: "HMAC-SHA256 で署名を検証し、失敗したときは 401 を返すようにした。既存の Webhook のテストに、署名つきのケースと改ざんされたケースを足した。",
    plan: { done: 4, total: 4 },
  },
};
