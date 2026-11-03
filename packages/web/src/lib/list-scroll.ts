// Issue 一覧のスクロール位置を、履歴エントリごとに覚える（NOD-52）。
// 詳細を開く直前の各スクロール領域の座標を、同じ WebView の中だけの一時状態として持つ。DB・View・ページ表示設定には書かない。
// 戻ったときは、履歴エントリ（__TSR_key）に加えて、画面の種類・対象・実効の条件と表示がすべて同じときだけ使う

export interface ScrollPoint {
  x: number;
  y: number;
}

// 一覧の同一性。identity は実効の条件と表示（保存した表示設定と URL を合わせたもの）を listIdentity で文字列にしたもの
export interface ListScrollKey {
  kind: string; // 画面の種類（"issues"、"view"、"sprint" など）
  target: string; // 対象の正規化した ID（Issues は ""）
  identity: string;
}

export interface ListScrollSnapshot extends ListScrollKey {
  // スクロール領域のキー（data-scroll-region）ごとの座標。順序ではなくキーで対応付ける
  regions: Record<string, ScrollPoint>;
}

// 覚えておく履歴エントリの数の上限。古いものから捨てる
const MAX_ENTRIES = 100;
const snapshots = new Map<string, ListScrollSnapshot>();

function remember<T>(map: Map<string, T>, entry: string, value: T): void {
  map.delete(entry);
  map.set(entry, value);
  while (map.size > MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export function rememberListScroll(entry: string, snapshot: ListScrollSnapshot): void {
  remember(snapshots, entry, snapshot);
}

// 同じ履歴エントリで、画面の種類・対象・実効の条件と表示が同じときだけ返す
export function recallListScroll(entry: string, key: ListScrollKey): ListScrollSnapshot | null {
  const snapshot = snapshots.get(entry);
  if (!snapshot) return null;
  return snapshot.kind === key.kind && snapshot.target === key.target && snapshot.identity === key.identity ? snapshot : null;
}

export function forgetListScroll(entry: string): void {
  snapshots.delete(entry);
}

// 一覧の画面が持つ、URL にない保存前の状態（View の保存前の Filter）。スクロール位置と同じく履歴エントリごとの一時状態で、View の定義には書かない。
// base は保存済みの定義（View の条件と表示設定）を listIdentity にしたもの。戻るまでに定義が変わったら使わない
export interface ListDraftKey {
  kind: string;
  target: string;
  base: string;
}

interface ListDraft extends ListDraftKey {
  value: unknown;
}

const drafts = new Map<string, ListDraft>();

export function rememberListDraft(entry: string, key: ListDraftKey, value: unknown): void {
  remember(drafts, entry, { ...key, value });
}

// 同じ履歴エントリで、画面の種類・対象・保存済みの定義が同じときだけ返す
export function recallListDraft<T>(entry: string, key: ListDraftKey): T | undefined {
  const draft = drafts.get(entry);
  if (!draft || draft.kind !== key.kind || draft.target !== key.target || draft.base !== key.base) return undefined;
  return draft.value as T;
}

// 条件と表示を、キーの順と undefined の有無によらない文字列にする
export function listIdentity(value: unknown): string {
  return JSON.stringify(normalize(value)) ?? "";
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

// スクロール領域のキー。表とグループ別 Board はグループ（とサブグループ）のキーで区別する
export function scrollRegionKey(kind: "table" | "board", groups: readonly string[] = []): string {
  return groups.length === 0 ? kind : `${kind}:${JSON.stringify(groups)}`;
}

// 小数の座標や端数の丸めを同じ位置とみなす幅（px）
const TOLERANCE = 1;

export function atPoint(current: ScrollPoint, target: ScrollPoint): boolean {
  return Math.abs(current.x - target.x) <= TOLERANCE && Math.abs(current.y - target.y) <= TOLERANCE;
}

// スクロール操作に関わるキー。押したら、保留中の復元より利用者の操作を優先する
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End", " ", "Spacebar", "Tab"]);

export function isScrollKey(key: string): boolean {
  return SCROLL_KEYS.has(key);
}
