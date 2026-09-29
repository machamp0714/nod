export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ApiRequest {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown; // 一括編集の失敗一覧など、code と message の補足

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

// server の API を呼ぶ。失敗の本文は CLI の --json と同じ {"error": {"code", "message"}} を前提とする。
export async function apiFetch<T>(
  path: string,
  req: ApiRequest = {},
  fetchImpl: FetchLike = (url, init) => fetch(url, init),
): Promise<T> {
  const init: RequestInit = { method: req.method ?? "GET" };
  if (req.body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(req.body);
  }
  const res = await fetchImpl(`/api${path}`, init);
  const body = parseJson(await res.text());
  if (!res.ok) {
    const error = (body as { error?: { code?: unknown; message?: unknown; details?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" ? error.code : "HTTP_ERROR";
    const message = typeof error?.message === "string" ? error.message : `HTTP ${res.status}`;
    throw new ApiError(res.status, code, message, error?.details);
  }
  return body as T;
}

function parseJson(text: string): unknown {
  if (text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
