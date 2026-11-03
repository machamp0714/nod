import { useLocation, useRouter } from "@tanstack/react-router";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { atPoint, forgetListScroll, isScrollKey, type ListDraftKey, type ListScrollKey, type ListScrollSnapshot, recallListDraft, recallListScroll, rememberListDraft, rememberListScroll, type ScrollPoint } from "../../lib/list-scroll";

// ページが一覧に渡す同一性と取得の状態（NOD-52）。fetching はキャッシュを表示したまま読み直している間 true
export interface ListScrollRestoration extends ListScrollKey {
  fetching: boolean;
}

// 一覧の本体に出ているもの。rows は表か Board、empty は空・未検出の表示
export type ListContent = "loading" | "error" | "empty" | "rows";

// スクロール領域（data-scroll-region）を集める。主領域は一覧の外側の <main>
function regionsOf(root: HTMLElement): Map<string, HTMLElement> {
  const regions = new Map<string, HTMLElement>();
  const main = root.closest<HTMLElement>('[data-scroll-region="main"]');
  if (main) regions.set("main", main);
  for (const el of root.querySelectorAll<HTMLElement>("[data-scroll-region]")) {
    const key = el.dataset.scrollRegion;
    if (key) regions.set(key, el);
  }
  return regions;
}

function measure(root: HTMLElement): Record<string, ScrollPoint> {
  return Object.fromEntries([...regionsOf(root)].map(([key, el]) => [key, { x: el.scrollLeft, y: el.scrollTop }]));
}

// 一覧から離れる直前の各領域の位置を履歴エントリごとに覚え、同じエントリへ戻ったら復元する。
// 行がそろうまで待ち、短い表示では到達できる端に収めたうえで元の目標を保ち、領域が伸びたら目標へ当て直す。
// 利用者がスクロールに関わる操作をしたら、それ以降は古い目標を当てない。一覧から離れたら保留中の復元は捨てる
export function useListScrollRestoration(root: RefObject<HTMLElement | null>, restoration: ListScrollRestoration | undefined, content: ListContent): void {
  const router = useRouter();
  const entryKey = useLocation({ select: (location) => location.state.__TSR_key });
  const entryIndex = useLocation({ select: (location) => location.state.__TSR_index });
  const latest = useRef({ restoration, content });
  latest.current = { restoration, content };
  // 位置を記録する履歴エントリ。履歴の push・replace・戻る・進むを同期で受けて更新する（描画を待つと、続けて行う replace と push の間で古くなる）
  const entry = useRef<{ key: string | undefined; index: number } | null>(null);
  // 最後に描画したエントリ。replace で置き換わっただけか、別のエントリへ移ったかを見分ける
  const rendered = useRef<{ key: string | undefined; index: number } | null>(null);
  // 復元の目標。復元を終えたか、利用者が操作したか、別の一覧になったら null
  const pending = useRef<ListScrollSnapshot | null>(null);
  // 戻る・進むで移った先のエントリ。履歴の位置と URL の条件は別々に描画へ届くことがあるため、条件がそろった描画で目標を探す
  const arriving = useRef<string | null>(null);

  const apply = useRef(() => {
    const el = root.current;
    const { restoration: current, content: shown } = latest.current;
    if (arriving.current && current) {
      const found = recallListScroll(arriving.current, current);
      if (found) {
        arriving.current = null;
        pending.current = found;
      }
    }
    const target = pending.current;
    if (!target || !el) return;
    if (!current || current.kind !== target.kind || current.target !== target.target || current.identity !== target.identity) {
      pending.current = null;
      return;
    }
    if (shown === "loading") return;
    // 最終的な取得エラーや空の一覧では通常の表示を保ち、復元を待ち続けない
    if (shown === "error" || (shown === "empty" && !current.fetching)) {
      pending.current = null;
      return;
    }
    let settled = shown === "rows" && !current.fetching;
    for (const [key, node] of regionsOf(el)) {
      const point = target.regions[key];
      if (!point) continue;
      // 代入した値はブラウザが到達できる範囲に収める。届かない分は目標のまま残し、伸びたら当て直す
      if (!atPoint({ x: node.scrollLeft, y: 0 }, { x: point.x, y: 0 })) node.scrollLeft = point.x;
      if (!atPoint({ x: 0, y: node.scrollTop }, { x: 0, y: point.y })) node.scrollTop = point.y;
      if (!atPoint({ x: node.scrollLeft, y: node.scrollTop }, point)) settled = false;
    }
    if (settled) pending.current = null;
  }).current;

  // 表示する履歴エントリが変わったら、そのエントリの目標を探す
  useLayoutEffect(() => {
    const previous = rendered.current;
    rendered.current = { key: entryKey, index: entryIndex };
    if (!previous) entry.current = { key: entryKey, index: entryIndex };
    const current = latest.current.restoration;
    if (!current || !entryKey) return;
    // replace で同じ位置のエントリが置き換わっただけなら、同じ一覧として復元を続ける
    if (previous && previous.key !== entryKey && previous.index === entryIndex) return;
    pending.current = null;
    arriving.current = entryKey;
    // 新しく開いた一覧には、前の画面の位置を残さない
    if (!previous && !recallListScroll(entryKey, current) && root.current) {
      const main = regionsOf(root.current).get("main");
      if (main) main.scrollTo({ left: 0, top: 0, behavior: "instant" });
    }
  }, [entryKey, entryIndex, root]);

  // 描画のたびに（行がそろった・再取得が終わった・表示が伸びた）目標を当て直す
  useLayoutEffect(() => {
    apply();
  });

  // 描画を伴わない寸法の変化（Board の中身や主領域の大きさ）にも当て直す
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    let frame = 0;
    const schedule = () => {
      if ((!pending.current && !arriving.current) || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        apply();
      });
    };
    const mutations = new MutationObserver(schedule);
    mutations.observe(el, { childList: true, subtree: true });
    const sizes = new ResizeObserver(schedule);
    sizes.observe(el);
    const main = regionsOf(el).get("main");
    if (main) sizes.observe(main);
    return () => {
      mutations.disconnect();
      sizes.disconnect();
      cancelAnimationFrame(frame);
      // 一覧から離れたら、この復帰に属する保留中の復元を捨てる
      pending.current = null;
      arriving.current = null;
    };
  }, [root, apply]);

  // 利用者の新しい操作（ホイール、タッチ、ポインタでの押下やスクロールバーのドラッグ、スクロールに関わるキー）を優先する。
  // 復元自身の scrollTop の代入は scroll イベントしか生まないため、ここで区別できる
  useEffect(() => {
    const cancel = () => {
      arriving.current = null;
      if (!pending.current) return;
      pending.current = null;
      if (entry.current?.key) forgetListScroll(entry.current.key);
    };
    const onPointer = (event: PointerEvent) => {
      // マウスの戻る・進むのボタンは画面を離れる操作なので、目標を消さない
      if (event.button === 3 || event.button === 4) return;
      cancel();
    };
    const onKey = (event: KeyboardEvent) => {
      if (isScrollKey(event.key)) cancel();
    };
    const options = { capture: true, passive: true };
    window.addEventListener("wheel", cancel, options);
    window.addEventListener("touchstart", cancel, options);
    window.addEventListener("pointerdown", onPointer, options);
    window.addEventListener("keydown", onKey, options);
    return () => {
      window.removeEventListener("wheel", cancel, options);
      window.removeEventListener("touchstart", cancel, options);
      window.removeEventListener("pointerdown", onPointer, options);
      window.removeEventListener("keydown", onKey, options);
    };
  }, []);

  // 一覧のエントリから離れる直前（詳細を開く・戻る・進む）に、そのエントリへ位置を記録する。
  // 履歴の通知は push・popstate と同期で届くため、DOM はまだ離れる前の一覧のまま
  useEffect(
    () =>
      router.history.subscribe(({ location, action }) => {
        const leaving = entry.current;
        entry.current = { key: location.state.__TSR_key, index: location.state.__TSR_index };
        // replace は同じエントリの置き換え（表示状態の記録・条件の変更など）なので、記録先だけを新しいキーにする
        if (action.type === "REPLACE" || !leaving?.key || leaving.key === location.state.__TSR_key) return;
        const el = root.current;
        const { restoration: current, content: shown } = latest.current;
        const target = pending.current;
        pending.current = null;
        arriving.current = null;
        if (!current || !el) return;
        // 復元を待っている間に離れたら、途中の座標ではなく元の目標を残す
        if (target) {
          rememberListScroll(leaving.key, target);
          return;
        }
        // 読み込み中・エラー・空の表示の座標は、元の一覧の位置として残さない
        if (shown !== "rows") return;
        rememberListScroll(leaving.key, { kind: current.kind, target: current.target, identity: current.identity, regions: measure(el) });
      }),
    [router, root],
  );
}

// URL にない保存前の状態（View の保存前の Filter）を、履歴エントリごとの一時状態として持つ useState。
// 一覧のエントリから離れる直前（詳細を開く・戻る・進む）に今の値を記録し、同じエントリへ戻って開き直したら、保存済みの定義（key.base）が同じときだけ使う
export function useListDraft<T>(key: ListDraftKey, initial: T): [T, (value: T) => void] {
  const router = useRouter();
  const entryKey = useLocation({ select: (location) => location.state.__TSR_key });
  const [value, setValue] = useState<T>(() => (entryKey !== undefined ? recallListDraft<T>(entryKey, key) : undefined) ?? initial);
  const latest = useRef({ key, value });
  latest.current = { key, value };
  // 値を記録する履歴エントリ。replace では同じエントリのキーが変わるため、通知のたびに追う
  const entry = useRef(entryKey);
  useEffect(
    () =>
      router.history.subscribe(({ location, action }) => {
        const leaving = entry.current;
        entry.current = location.state.__TSR_key;
        if (action.type === "REPLACE" || !leaving || leaving === location.state.__TSR_key) return;
        rememberListDraft(leaving, latest.current.key, latest.current.value);
      }),
    [router],
  );
  return [value, setValue];
}
