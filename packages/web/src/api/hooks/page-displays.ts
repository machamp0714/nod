import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { pageDisplayFromSearch, pageSearch, hasDisplayKey, type PageKey, type PageScope } from "../../lib/page-display";
import type { IssueListSearch } from "../../routes/search";
import { apiFetch } from "../client";
import { queryKeys } from "../query-keys";
import type { PageDisplay } from "../types";

type PageDisplays = Record<string, PageDisplay>;

export function usePageDisplays() {
  return useQuery({ queryKey: queryKeys.pageDisplays(), queryFn: () => apiFetch<PageDisplays>("/page-displays") });
}

const pagePath = (page: PageKey) => `/page-displays/${encodeURIComponent(page)}`;

// 表示設定の書き込み。useApiMutation（全クエリを読み直す）は使わず、キャッシュを先に書き換えて表示をすぐ変える。
// scope で書き込みを直列にし、すばやく続けて変えても最後の変更が残るようにする。失敗したら読み直してサーバーの値に戻す
function usePageDisplayMutation<T>(request: (vars: T) => Promise<unknown>, apply: (prev: PageDisplays, vars: T) => PageDisplays) {
  const queryClient = useQueryClient();
  return useMutation({
    scope: { id: "page-displays" },
    mutationFn: request,
    onMutate: async (vars: T) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.pageDisplays() });
      queryClient.setQueryData<PageDisplays>(queryKeys.pageDisplays(), (prev) => apply(prev ?? {}, vars));
    },
    onError: () => queryClient.invalidateQueries({ queryKey: queryKeys.pageDisplays() }),
  });
}

// ページの一覧に渡す状態と、保存・既定に戻す操作。ready になるまで（取得中）は一覧を出さない。取得に失敗したら保存なしとして扱う
export function usePageDisplay(scope: PageScope, url: IssueListSearch) {
  const displays = usePageDisplays();
  const saved = displays.data?.[scope.key] ?? {};
  const put = usePageDisplayMutation(
    ({ display }: { display: PageDisplay }) => apiFetch<PageDisplay>(pagePath(scope.key), { method: "PUT", body: { display } }),
    (prev, { display }) => ({ ...prev, [scope.key]: display }),
  );
  const remove = usePageDisplayMutation(
    (_: void) => apiFetch<{ ok: true }>(pagePath(scope.key), { method: "DELETE" }),
    (prev) => {
      const { [scope.key]: _removed, ...rest } = prev;
      return rest;
    },
  );
  return {
    ready: !displays.isPending,
    search: pageSearch(saved, url),
    // ポップオーバーの変更だけを保存する。見えている表示設定（保存 ＋ URL）に変更を重ねたものを丸ごと保存する
    save: (patch: IssueListSearch) => {
      if (hasDisplayKey(patch)) put.mutate({ display: pageDisplayFromSearch({ ...pageSearch(saved, url), ...patch }, scope) });
    },
    reset: () => remove.mutate(),
    resetDisabled: Object.keys(saved).length === 0 && !hasDisplayKey(url),
  };
}
