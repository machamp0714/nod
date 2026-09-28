# Workspace 色の永続化（#9 / NOD-7）実装計画

> 実装担当へ：PM の次の実装 dispatch 後、superpowers:executing-plans を使って順に実施する。Task 1・2の実装dispatch承認済み。旧パレット順変更案は廃止し、末尾の過去調査は証拠としてのみ残す。

## 実装dispatchの更新（2026-09-28 18:49）

- PMが本計画を承認しTask 1・2を実装する。Task 3の統合・全E2EはPMの指示まで行わない。
- 原本specのWorkspace/#9該当節はDへ直接編集権を移譲済み。他段落を保全し、完了時にBへ引き渡す。
- Aによるポート設定変更の計画は撤回。既存fixture/専用testを使い、固定5199/4798/4797の利用はPMがAの独立レビュー終了を確認してから許可する。大きなE2E基盤を新設しない。
- docs/superpowersはこれ以上force addしない。既にtrackedの本計画だけ通常addする。日本語PR案は未追跡のローカル報告として用意する。

**目的：** 同時に登録されている Workspace に重複しない色値を割り当てて DB に保存し、既存の色表示へ一貫して反映する。

**構成：** core が色の唯一の割り当て元となり、`workspaces.color` を永続化する。server は Workspace をそのまま JSON 化し、Web は既存 `useWorkspaces()` のキャッシュを `WorkspaceBadge` から参照する。各 Page の props と Issue の payload は増やさない。

**技術：** Bun / SQLite、TypeScript、Hono、React、TanStack Query、Playwright。追加依存なし。

**設計根拠：** `/Users/ooidetatsuya/repo/nod/docs/superpowers/specs/2026-09-27-nod-design.md`、Pencil MCP で読む `/Users/ooidetatsuya/repo/nod/design/nod.pen`、今回の承認済み dispatch と PM 回答。

## 作業条件と現在地

- worktree：`/Users/ooidetatsuya/orca/workspaces/nod/nod-workspace-colors`。
- branch：`machamp0714/nod-workspace-colors`。
- 開始 HEAD `fe31f178946963187d902fac87fee1485e2327d4` から B の `b205cf7d9266a29d71f05e8c963774b1a050d43c` へローカル fast-forward 済み。dirty、競合なし。
- `.codegraph/` はないため通常のソース調査を使用した。
- スキーマ変更を含む DB 保存方式はユーザー承認済み。キー特例は入れない。
- PM 回答：24件という新しい上限は不採用。初期パレット後に追加色を決定的に生成し、通常の登録可能性を維持する。色値の一意性と知覚上の識別性は区別する。
- 今回はTask 1・2を実装する。ローカル commit は可。push、PR、main merge は禁止。
- `#21/NOD-19` と `docs/linear-usecases.md` は編集・commit・stash しない。共有 spec の #9 該当箇所は今回のみDへ編集権が移譲され、反映後はBへ引き渡した。他段落は変更しない。
- 実 DB は読書き禁止。テストは一時 `NOD_DB`、`NOD_ORCA=0 NOD_ACTOR=codex`。me ケースだけ一時 DB で me を使う。
- Bun から日本語引数を渡す場合は `Bun.spawnSync` の配列引数を使う。固定 E2E ポートはPMからDへの使用許可済み。完了時に解放を報告する。停止できるのは自分の server のみ。
- リスク分類：標準。主なリスクは migration の rollback、並行登録、必須型追加、取得失敗時の誤色、画面横断回帰。

## 調査で確定した事実

1. API と WEB が同色になる原因は文字コード和 `% 4` の衝突。過去の一時 DB・新規 build で再現済み。キーごとの特例やパレット順変更では解決しない。
2. `schema.ts` は現時点で SQL 配列1版のみ。`db.ts` は各版を `BEGIN IMMEDIATE` 相当の transaction で適用し、最後に user_version を更新する。`initWorkspace()` も既に `tx()` 内にある。
3. Workspace の列は id/key/name/path/next_number/created_at。`WorkspaceRow` と `toWorkspace()` が型変換の入口。`listWorkspaces()`、`findWorkspace()`、登録済み path の再 init、remove の返却値も同じ mapper を使う。
4. `packages/server/src/routes/read.ts` の `GET /api/workspaces` は `listWorkspaces(db)` の結果をそのまま JSON 化する。Web の `api/types.ts` は Workspace を core から再エクスポートしている。両ファイルは色追加のためには編集不要。
5. `WorkspaceBadge` が色計算の唯一の UI 呼び出し元。共有 `useWorkspaces()`、SSE の全 query invalidate を再利用できる。
6. 直接 Workspace INSERT する既存テストは `packages/core/test/db.test.ts` と `packages/cli/test/project.test.ts`。必須 color 追加と同時に修正する。
7. 2026-09-28 の Pencil MCP execute は指定絶対 filePath で復旧を確認。10 Inbox / 11 Issues / 12 Issue 詳細 / 13 Triage / 14 Reviews / 15 Projects にある目印は 8×8、角丸2で、api-server 緑 `#0E9F6E`、nod 紫 `#7C5CFF`、blog 桃 `#DB2777`。これは使用色の参照であり、特定キーへの固定色契約ではない。原本未編集。

## 保存形式と割り当て規則

### 永続データと公開型

- 保存形式は大文字6桁の sRGB HEX、例 `#7C5CFF`。CSS 変数名やパレット添字は保存しない。
- `workspaces.color TEXT` に形式 CHECK、NULL 拒否 trigger、単独 UNIQUE index を付ける。移行中だけ NULL を許す理由と制約は下記に記載する。
- `Workspace` に必須 `color: string` を追加する。optional / null は公開しない。色の変更 API、CLI オプション、Issue ごとの色コピーは追加しない。
- 同じ DB に現在登録されている Workspace 間で色値が一意。別 DB 間、削除後の再登録で同じキーが同じ色になる保証はない。
- 名前、キー、表示順、絞り込み、別 Workspace の追加・削除では既存色を変更しない。移行時の一度だけ既存 hash 色から変わる。

### 初期12色と追加生成

初期12色をこの順に使う。緑・橙は元のトークンより暗くし、既存の薄い選択背景上でも目印として3:1以上となる値を選んだ。tokens.css の既存値を書き換える必要はない。

```ts
const INITIAL_COLORS = [
  "#7C5CFF", "#0D9768", "#C36B04", "#DB2777",
  "#2563EB", "#0F766E", "#B91C1C", "#6D28D9",
  "#A16207", "#0369A1", "#4D7C0F", "#BE123C",
] as const;
```

12色を使い切っても登録を止めない。候補 RGB 空間は24bit、`i=0..0xFFFFFF` について次の順に走査する。

```ts
const value = (i * 0x9E3779) & 0xFFFFFF;
const color = `#${value.toString(16).padStart(6, "0").toUpperCase()}`;
```

乗数は奇数なので24bit空間の順列となり、候補値自体は1周内で重複しない。積は JS の整数精度内。候補は次の条件で採用する。

- 初期色に含まれる値は追加列挙では除外する。
- RGB の最大 channel と最小 channel の差が40以上（ほぼ無彩色を除く）。
- 下記の各背景と、相対輝度 `(明るい方 + .05) / (暗い方 + .05)` で3以上。
- 現在 DB の `SELECT color FROM workspaces` を使った Set に含まれない。

背景は `#FFFFFF`、`#F5F6F8`、`#EEF0F3`、`#FAFBFC`、`#E8EBFC`、`#FDF0D8`。sRGB の各 channel を0〜1へ正規化し、0.04045以下は `/12.92`、それ以外は `((x+.055)/1.055)^2.4`、輝度係数は `.2126/.7152/.0722` とする。これらは現在の表示面に対する設計上の検証値であり、文字には適用しない。ラベル文字色は既存の ink 系を維持し、swatch 色を文字背景として使わない。

`workspaceColorCandidatesV1(): Iterable<string>` と `allocateWorkspaceColor(used: ReadonlySet<string>): string` を core の専用ファイルで提供する。登録は候補列の最初の未使用値を1つ採用する。キー、名前、ランダム値、現在時刻を種にしない。初期12色と生成規則は V1 として固定し、将来変更が必要なら V2 を別定義にする。

通常は12色とその後の少数候補を見るだけ。大量データの migration は候補 iterator を1本共有して進め、各行で先頭から走査しない。新規登録は使用色 Set を読み、先頭から走査するため登録数に概ね比例し、一般的な Workspace 件数で探索最適化や新テーブルは導入しない。

### 限界、枯渇、削除後

- 12件、24件、360件等の登録上限は導入しない。色候補は24bit空間のうち上の視認条件を満たす集合で、有限である。
- 色値が異なっても近い色を人が容易に区別できる保証はない。生成色が増えるほどこの限界が強まる。キー・名前の文字を常に残し、最低色差を登録条件として追加しない。
- 全候補を走査して空きがなければ `NodError("WORKSPACE_COLOR_EXHAUSTED", "Workspace に割り当てられる未使用の色がありません。色の候補を拡張した nod が必要です")`。重複や灰色の代用で登録を成功させない。
- これは RGB 空間の実用を大きく超える限界であり、小さな固定パレットで既存登録を拒むものではない。最大走査1,677万候補は重く、枯渇付近での性能・全色の人間による判別は保証しない。通常25件・1000件の回帰で小さな上限がないことを検証する。
- remove の transaction が commit した時点で色が空く。次の登録で候補順の最初の空きを再利用し、残存 Workspace は再配色しない。同じ path への再 init は既存色を返し候補を消費しない。
- 重複 path/key/name 検査を先に行い、既存の `KEY_TAKEN` / `NAME_TAKEN` 等の優先順位を維持する。

## migration と原子性

### v1 → v2 の順序

現行版を変更せず2番目の migration を追加する。現 spec の末尾にある「まだ使われている DB がないため最初の migration を直す」は過去の別変更の扱いであり、今回は既存 DB の移行が明示要件のため適用しない。

`MigrationStep = string | ((db: Database) => void)` として既存 SQL 配列を維持し、`db.ts` のループで string は exec、関数は同じ transaction 内で呼ぶ。新 migration 関数は `src/migrations/workspace-colors-v2.ts`。関数から openDb / tx / ops を import せず、循環依存を避ける。

1. IMMEDIATE lock を取得し、既存どおり user_version を再確認する。
2. 次の列を追加する。NULL は backfill 中だけ必要であり、公開処理が観測できる状態ではない。

```sql
ALTER TABLE workspaces ADD COLUMN color TEXT
CHECK (color IS NULL OR (
  length(color) = 7 AND length(CAST(color AS BLOB)) = 7
  AND substr(color, 1, 1) = '#'
  AND substr(color, 2) NOT GLOB '*[^0-9A-F]*'
));
```

3. 既存行を `ORDER BY created_at ASC, id ASC` で読む。created_at が同値でも id で確定する。文字列順であり日時の再解釈はしない。全行に初期12色→追加生成色の順で割り当て、`UPDATE workspaces SET color = ? WHERE id = ?` を行う。旧 hash 色は保持しない。
4. NULL が0、色の重複が0であることを確認し、異常なら throw する。
5. `CREATE UNIQUE INDEX workspaces_color_unique ON workspaces(color)` を追加する。
6. NULL 拒否を DB に固定する。既存 workspaces を作り直さず、子テーブルの FK と next_number を保持できる。

```sql
CREATE TRIGGER workspaces_color_required_insert
BEFORE INSERT ON workspaces WHEN NEW.color IS NULL
BEGIN SELECT RAISE(ABORT, 'Workspace color is required'); END;
CREATE TRIGGER workspaces_color_required_update
BEFORE UPDATE OF color ON workspaces WHEN NEW.color IS NULL
BEGIN SELECT RAISE(ABORT, 'Workspace color is required'); END;
```

7. user_version=2 を書いて commit。失敗は ALTER、backfill、index、trigger、user_version を含めて rollback。列に SQL の NOT NULL 属性は付かないが、migration 後は trigger と CHECK と UNIQUE で同等の値制約を保証する。この差をテスト・コメントに明記する。

新規 DB も v1→v2 を通す。再起動で移行済み色は書き換えない。並行 open は既存の IMMEDIATE と版確認で二重 backfill を防ぐ。古いバイナリを再起動すると SCHEMA_TOO_NEW となる。旧バイナリの起動済み接続が色なし INSERT しても trigger で拒否する。稼働中の古い server は配信コードが古いため再起動が必要で、自動停止や DB の巻き戻しは行わない。

### 新規登録の transaction

既存 `initWorkspace()` の `tx()` 内で、重複検査→全使用色の取得→色決定→色を含む INSERT→mapper の返却を完結させる。別プロセスの並行登録は書き込みロックで直列化され、さらに UNIQUE index が最後の防壁となる。5秒の既存 busy timeout 後の `DB_BUSY` はそのまま返し、無制限 retry や transaction 外での色予約はしない。削除と登録の競合も同じロック規則で扱う。

## core / server / Web の共有契約と所有権

```ts
// packages/core/src/types.ts
export interface Workspace {
  id: number;
  key: string;
  name: string;
  path: string;
  color: string;
  createdAt: string;
}
```

`initWorkspace` / `findWorkspace` / `listWorkspaces` / `removeWorkspace` の引数・戻り値の構造は既存のまま、その内側の Workspace に必須 color が増える。`GET /api/workspaces` と CLI JSON に同じ値を載せる。server の新規登録 endpoint は作らない。色枯渇は現在 CLI/core の問題だが、既存serverテストが全coreエラーのHTTP対応を要求するため、`server/src/errors.ts` に `WORKSPACE_COLOR_EXHAUSTED: 409` を追加する。

| 所有者 | ファイルと範囲 | 受け渡し |
|---|---|---|
| D 先行 | core/src/types.ts の Workspace だけ | 必須 color を完成状態で先行 commit、B が local merge |
| D 先行 | core/src/schema.ts、db.ts、ops/workspaces.ts、新規 workspace-colors.ts と migrations/workspace-colors-v2.ts | 実保存・migration・取得を同じ先行 commit に含める |
| D 先行 | core/test/db.test.ts、workspaces.test.ts、新規 workspace-colors.test.ts、workspace-colors-migration.test.ts、workspace-colors-concurrency.test.ts | 必須型と永続値の保証 |
| D 先行 | web/src/fixtures/workspaces.ts、cli/test/project.test.ts、server/test/workspace-colors.test.ts（新規）、cli/test/workspace-colors.test.ts（新規） | 型/直接 INSERT の追従と API/CLI 契約の検証 |
| B | core/src/types.ts の ReviewIssue/AcceptTriageInput/IssueDocumentRef、Inbox.reviews、IssueDetail.documents | Workspace 部分を変更しない |
| B | web/src/api/types.ts、core/src/issue-query.ts、ops/issues.ts、ops/human.ts、server/routes/read.ts、routes/issue-ops.ts、cli/commands/issue.ts、guide.ts | D は編集しない。Workspace は既存 re-export で伝わる |
| D 後続 | web/src/components/ui/badges.tsx、lib/color.ts、lib/color.test.ts、新規 lib/workspace-color.ts と同 test | 共通部品で反映、Page 無編集 |
| D 後続 | web/e2e/workspace-colors.e2e.ts、e2e/datasets/workspace-colors.ts（新規） | 独立した色回帰 |
| B / PM | 原本specはD反映後Bへ返却。固定E2EポートはD検証終了後PMへ返却 | Task 3の統合と全E2EをPMが調整 |

純粋な型だけを先行 commit すると mapper が未実装になり型検査が壊れるため採用しない。先行 commit は小さな縦断変更として DB→core→API/CLI→fixture まで揃え、Web の色表示は後続 commit に分ける。これにより B は型と schema の安定した土台を取り込んでから自身の型追加を行える。既に B が型を編集中なら、該当領域だけ保全して local merge の解決内容を PM に報告する。B の変更を上書きしない。

## Web への伝播

`WorkspaceBadge({ workspaceKey, name })` の既存 props は維持する。内部で `useWorkspaces()` を無条件に呼び、下記の純粋関数を使う。

```ts
export function workspaceColorOf(
  workspaces: readonly Pick<Workspace, "key" | "color">[] | undefined,
  key: string,
): string | undefined {
  const color = workspaces?.find((workspace) => workspace.key === key)?.color;
  return color?.length === 7 && /^#[0-9A-F]{6}$/.test(color) ? color : undefined;
}
```

badge は `background: color ?? "transparent"` とし、`data-workspace-key`、`data-workspace-color-state`（ready/pending/error/missing）を持つ。取得中・失敗・欠損では色を推測せず、空の8px swatchと文字を維持する。取得失敗時の title は「KEY（Workspace の色を取得できません）」とする。既存キャッシュがあれば再取得中もその色を維持し、背景再取得エラーで有効な既存色を消さない。DB値不正の API 応答は HEX 正規表現で拒み、missing として扱う。

すべて同じ queryKey を参照するため通信を共有する。observer は badge 数ぶん増えるが、今回 root provider や Page への props 伝播を新設する必要はない。大規模リストの Map 最適化は測定なしで追加しない。Provider がない直接描画の既存テストがあれば QueryClientProvider で包む。

旧 `workspaceColor(key)` とその固定 hash テストだけを削除する。`agentColor` / `agentInitial` は維持。View の色、Sidebar、カンバンカードへのバッジ新設、文字だけのフィルターへの色追加は対象外。

| 既存表示 | 伝播経路 | 検証 |
|---|---|---|
| Issues / Views / Project 詳細のリスト | IssueTable → WorkspaceBadge | 表示される全 badge と API 保存値を照合 |
| 同3画面の Workspace グループ見出し（list / board） | IssueList → WorkspaceBadge | 新しい既存見出しを回帰に含める |
| Inbox / Triage / Reviews の一覧 | QueueItem → WorkspaceBadge | API/WEB の衝突再発なし |
| 判断画面の選択詳細 | 各 Page → WorkspaceBadge | 一覧と選択側の値が一致 |
| Issue 詳細のパンくず・プロパティ | IssueDetailPage / PropertiesPanel → WorkspaceBadge | 両方とも保存値 |
| Projects | ProjectsPage → WorkspaceBadge | 複数 Workspace が同居しても一意 |

## レビューの重点

1. v1 DB の参照データを失わず、移行中失敗で版と schema も戻る（Task 1）。
2. 別接続/別プロセスの同時 init と remove によって色が重複しない（Task 1）。
3. 13件・25件・1000件を登録でき、小さな固定上限が復活しない（Task 1）。
4. 遅延・エラー時の hash fallback や一瞬の別色表示がない（Task 2）。
5. groupBy 表示、SSE、リロード、ビルド済み配信の全経路で DB 値が維持される（Task 2、3）。

## Task 1：共有契約と永続化を先行 commit

**成果：** B が取り込める、型検査・core/API/CLI 契約が通る commit。Web はこの段階では既存の色表示なので #9 を完了扱いしない。

**ファイル：** 上の D 先行所有ファイル。新規 helper は `workspaceColorCandidatesV1()` / `allocateWorkspaceColor(used)`。migration は `migrateWorkspaceColorsV2(db: Database): void`。

- [ ] `core/test/workspace-colors.test.ts` に初期色・25件・1000件の一意性、HEX、全背景の輝度比、決定性を記述し、未実装での失敗を確認する。

```ts
const used = new Set<string>();
for (let i = 0; i < 1000; i++) {
  const color = allocateWorkspaceColor(used);
  expect(color).toMatch(/^#[0-9A-F]{6}$/);
  expect(used.has(color)).toBe(false);
  used.add(color);
}
expect(used.size).toBe(1000);
expect(allocateWorkspaceColor(new Set())).toBe("#7C5CFF");
```

- [ ] 実DBの枯渇再現のために数百万行は作らない。内部 `firstUnusedColor(used, candidates: Iterable<string>)` を pure helper として分離し、テストで2候補の iterator を渡して全使用時に `WORKSPACE_COLOR_EXHAUSTED` を検証する。製品入口は必ず V1 全候補列を渡す。
- [ ] `workspace-colors-migration.test.ts` で Database と `MIGRATIONS[0]` から raw v1 DB を作る。API/WEB/NOD/BLOG を id順と created_at順が異なる形で登録し、issues/labels/events/relations と next_number を保存して閉じる。openDb 後の割当順、色一意、既存データ不変、`PRAGMA foreign_key_check` 空、再open時不変を確認する。
- [ ] migration 失敗は v1 workspaces に `BEFORE UPDATE` の故意に RAISE する trigger を作り、2行目で失敗させる。raw 接続で user_version=1、color列なし、旧データ不変を確認し、故障 trigger 除去後は移行成功することを検証する。
- [ ] 新版 DB へ直接 NULL / 省略 / 小文字HEX / 不正文字 / 重複色を INSERT・UPDATE して拒否されることを検証する。通常の init/remove と同一 path の冪等性・色再利用も検証する。
- [ ] `schema.ts` の末尾へ関数 migration を追加し、db.ts の step 実行を拡張する。`WorkspaceRow.color`、mapper、公開 Workspace に color を追加し、init の同じ transaction 内に allocator を接続する。API route と Web API re-export は編集しない。
- [ ] fixture の3 Workspace に必須色を追加し、直接 INSERT 2か所を initWorkspace または明示color付きINSERTへ変更する。
- [ ] `workspace-colors-concurrency.test.ts` は一時同一DBへ2つの Bun 子プロセスを起動し、親の開始合図から API/WEB を登録する。両成功時に異なる色、ロック timeout 時に DB_BUSY と行数不変、解除後 retry 成功を検証する。migration 並行 open も同方式で確認する。プロセスの env は一時DBと NOD_ORCA=0 NOD_ACTOR=codex、引数は配列を使う。
- [ ] server 新規テストで `GET /api/workspaces` の color が DB と一致し非nullであることを検証する。CLI 新規テストで init/list/remove の JSON が色を維持し、既存通常出力が壊れないことを確認する。
- [ ] 一時DBを環境変数で指定して対象 test、`bun test`、`bun run typecheck` を実行する。失敗を直した後で必要ファイルのみ add し、`feat: Workspaceの色を割り当てて永続化する` と commit する。
- [ ] HEAD、ファイル一覧、型契約、実行結果を PM へ送り、B への取り込み対象 commit として渡す。先行commitは29f67dc、独立レビューのNUL境界修正は163171b。

## Task 2：既存 WorkspaceBadge を保存色へ切り替える

**ファイル：** D 後続所有の共通 UI と専用 Web unit/E2E/dataset。各 Page と B 所有の PropertiesPanel は編集しない。

- [ ] `workspace-color.test.ts` で undefined、未知キー、空一覧、複数 Workspace、名称・配列順変更、DB不正色の拒否をテストする。hash 固定色テストは削除し、agent 関連テストは残す。
- [ ] `workspaceColorOf` と badge 内 hook を実装し、取得状態属性・透明 swatch を追加する。名前と title の通常表示は既存どおりとする。
- [ ] `workspace-colors` dataset に API/WEB/NOD/BLOG、各Workspaceの todo/triage/awaiting_input/in_review Issue、横断 Project と View を用意する。作成APIは既存 core を使用し、他 dataset を変えない。
- [ ] API/WEB が異色であることと、上表の全画面で保存値どおりであることを実色で確認する。少なくとも1件の表示を必ず待ってから全 badge を検証する。

```ts
const workspaces = await (await page.request.get("/api/workspaces")).json();
expect(new Set(workspaces.map((w: { color: string }) => w.color)).size)
  .toBe(workspaces.length);
for (const workspace of workspaces) {
  const marks = page.locator(`[data-workspace-key="${workspace.key}"]`);
  await expect(marks.first()).toBeVisible();
  const rgb = workspace.color.match(/[0-9A-F]{2}/g)
    .map((value: string) => parseInt(value, 16));
  for (const mark of await marks.all()) {
    await expect(mark).toHaveAttribute("data-workspace-color-state", "ready");
    await expect(mark.locator("span").first())
      .toHaveCSS("background-color", `rgb(${rgb.join(", ")})`);
  }
}
```

上のループは全4Workspaceを表示する専用 dataset の一覧で使用する。単一Workspaceしか出ない詳細は対象キーだけを比較する。初期色のキー固定期待値は書かない。

- [ ] `/api/workspaces` を遅延させて pending の swatch が透明であること、解放後に保存値だけが現れることを検証する。失敗時は文字を残して error、未知キーは missing を確認する。キャッシュありの再取得失敗は既存色が残ることを検証する。
- [ ] SSE ready 後に専用core操作でWorkspace追加・削除を行い、既存色が不変、追加色は未使用、削除後は最初の空きを再利用することを検証する。並べ替え・検索解除・groupBy切替・リロードでも色不変を確認する。
- [ ] E2E は既存 fixture と専用 test を使う。固定5199/4798/4797はPMへ使用確認し、Aの独立レビューから解放された後に実行する。ポート待機中はunit/build/specを進める。
- [ ] 関連unitとE2E成功後、`feat: Workspaceの保存色を既存バッジへ反映する` と commit する。

## Task 3：統合と配信物の回帰

- [ ] B/A の最新変更を PM 指定の順序で local merge し、Workspace 型と各担当の型を両方維持する。
- [ ] 一時DBで `bun test`、`bun run typecheck`、`bun run web:build`。変更していない lockfile を無用に更新しない。
- [ ] PMのTask 3実行指示後に、許可されたポートで全E2Eを実行する。専用serverだけを停止する。
- [ ] 明示したこの worktree の dist と新規一時 DB で nod ui を port 0 起動し、API/WEB の各保存色と Issues/Projects の実色を比較する。CLI起動は Bun.spawnSync/配列引数を使い、長寿命serverは Bun.spawn でPIDを保持して自身だけ停止する。
- [ ] 独立した一時v1 DBからの移行、再起動後の色不変、古いversion拒否も確認する。実DB検証はしない。
- [ ] #9要件の差分、実行したテスト件数、HEAD、残課題を PM へ報告する。push/PR/main merge は行わない。

## 共有 spec への反映内容（反映済み、Bへ所有権返却）

以下の内容を原本のWorkspace/#9該当箇所へ反映し、PMへ所有権返却を通知した。

- データモデル：workspaces に `color` を追加。大文字6桁HEX、現在登録中で一意・必須。DB CHECK、UNIQUE、NULL拒否triggerの実装を補足する。
- Workspace登録：使用済み色を除いて初期パレット→決定的生成から割り当て、登録 transaction で保存。同一path再 init は再配色しない。削除後は空きを再利用する。
- migration：v2を追加し、created_at/id順で既存行を割り当てる。全体rollbackと再open不変を保証する。
- API：Workspace の必須 `color: string`。Issue/Project の色コピーは行わず GET /api/workspaces を参照する。
- Web：既存目印は保存値を表示。未取得・失敗・欠損時にキー由来色へ戻さない。キー・名前の文字を残す。新しいbadge配置は含めない。
- 限界：有限RGB候補の完全枯渇は明示エラー。小さな登録件数制限は導入しない。異なる色値でも人間の識別性は保証しない。
- テスト：旧DB移行、25/1000件、並行登録、削除再利用、全既存目印、通信異常とSSE、dist配信を追加する。

## 今回の完了判定と残作業

- 今回完了：Bのローカル統合、既存計画の見直し、Pencil読み取り、ソースによる共有契約と表示経路の確認、具体的な実装・移行・テスト順序の策定。
- 自己レビュー：旧パレット案を実行手順から撤去、必須型だけの壊れる先行commitを回避、直接INSERTテストと新しいgroupBy badgeを回帰に追加、原子性とNULL制約を明示した。
- 今回の検証：gitの開始/統合後状態、差分境界、計画の形式確認、初期12色の輝度比のローカル算出（対象背景に対する最小値3.1398）、生成規則の検算（2,176候補を走査して初期色込み1,000色の一意性を確認）、コードフェンスの対応確認。これは計画内の算法の独立したPython検算であり、Bun製品実装の性能測定ではない。製品テスト・build・E2Eは今回再実行していない。過去の合格件数を今回の結果として扱わない。
- 残作業：PMによる計画確認と実装dispatch、D先行契約commitをBへ受け渡す時間調整、Aによるspec/ポート設定の取り込み、Task 1〜3の実装・検証。
- 見積もりの前提：新しい登録UIや色設定UIは作らない。Task 1に移行/並行/契約の検証を集め、Task 2に画面横断回帰を集める。ポート分離が利用できれば実装・検証3〜5時間、独立レビューと修正1〜2時間程度。環境調整時間は別枠。

---

## 実装結果（2026-09-28）

- Task 1は完了。先行契約29f67dcをBへ受け渡した。Workspace必須color、v2移行、原子登録、API/CLI/fixtureを同時に揃えた。
- 独立DBレビューは重大指摘なし。NUL形式CHECKの軽微指摘は163171bで修正し、INSERT/UPDATEのRED→GREENと関連22件を確認した。
- Task 2は各Pageを変更せず共通badgeへ保存色解決を集約した。遅延/欠損/障害時は透明、再取得失敗でもキャッシュ色を維持する。
- 専用E2Eは画面横断・groupBy・通信異常・SSE・削除再利用・実際の行順変化・検索・再ロードの20件。
- Task 3のA/B統合・全E2E・dist実配信は今回未実施。PM指示による後続の統合工程へ引き継ぐ。
- 最新の検証結果とPR案は `reports/nod-workspace-colors/implementation.md` と `reports/nod-workspace-colors/pr-draft.md` に保存する。

# 過去調査の証拠（当時の承認状態・次工程の記述は現行方針ではない）

## 追加調査：API / WEB の衝突再現と方式選択（2026-09-28）

### 結論

**#9 の API / WEB が両方橙になる直接原因は、文字コード和を4色に割り当てる関数の衝突。** API は 65+80+73=218、WEB は 87+69+66=222 で、両方とも `sum % 4 === 2` となり `var(--ws-c)`（橙）を返す。新規 build と新設一時 DB でも、Issues / Projects の実画面で同じ現象を再現した。

ソースからバッジへの値の受け渡しと CSS は計算結果どおり動作している。古い dist はこの現象を説明するために必要な仮説ではなく、今回の再現環境では除外できる。過去の実行環境そのものが古い dist だったかどうかは証拠がなく断定しない。

**パレットの並べ替えは不採用。** 同じ添字2を返す API / WEB は、配列の順を替えても同色のままになる。初回計画の最小案と Task 1 は実行しない。API / NOD / BLOG の固定色特例も導入しない。

### 過去の一時 DB の確認

PM 指定の `/private/tmp/claude-501/-Users-ooidetatsuya-repo-nod/a5fb8029-1a49-4c7a-aa6f-e2ee97a9096f/scratchpad/it/` は `No such file or directory` だったため、当時の DB のキーを直接照合できなかった。API / WEB が使われた事実は今回の PM の引き継ぎに基づく。実 DB や別プロジェクトの DB は探索・参照していない。

### 再現方法と観測結果

- 調査 HEAD は `fe31f17` のまま。コード・spec・lockfile の tracked 差分なし。
- 最初の build は依存未導入で `nodenv: tsc: command not found`。`bun install --frozen-lockfile` 後、`NOD_DB=$(mktemp -d)/nod.db NOD_ORCA=0 NOD_ACTOR=codex bun run web:build` が終了コード0で成功した。web の TypeScript 検査と Vite build を含む。
- 一時ルートは `/tmp/nod-color-rootcause.dhnaFq`（macOS では `/private/tmp` 配下）。新設 DB は `pair/nod.db` と `triple/nod.db`。
- 一時スクリプト `serve.ts` から既存 core の `openDb` / `initWorkspace` / `createProject` / `createIssue` を使用。各 DB に1 Project とキーごとの Issue を作成し、書き手は codex とした。
- 同じスクリプトから nod ui が使用する既存 `startUi` を `port: 0`、`open: false`、明示した `dbPath` とこの worktree の `packages/web/dist` で起動。API / WEB はポート57733、API / NOD / BLOG は57735で配信した。固定 E2E ポートは使用していない。
- playwright-cli の専用セッション `nod-color-rootcause` で実ページへ遷移。表示済みの `span[title="キー"] > span:first-child` を待機し、inline style と `getComputedStyle(...).backgroundColor` を取得した。API のモックや CSS の差し替えはしていない。

| 一時 DB のキー | 画面 | キー | inline style | 実際の background-color |
|---|---|---|---|---|
| API / WEB | Issues、Projects の両方 | API | `background: var(--ws-c)` | `rgb(217, 119, 6)`（橙） |
| API / WEB | Issues、Projects の両方 | WEB | `background: var(--ws-c)` | `rgb(217, 119, 6)`（橙） |
| API / NOD / BLOG | Issues、Projects の両方 | API | `background: var(--ws-c)` | `rgb(217, 119, 6)`（橙） |
| API / NOD / BLOG | Issues、Projects の両方 | NOD | `background: var(--ws-b)` | `rgb(14, 159, 110)`（緑） |
| API / NOD / BLOG | Issues、Projects の両方 | BLOG | `background: var(--ws-a)` | `rgb(124, 92, 255)`（紫） |

取得した10件の結果は `/tmp/nod-color-rootcause.dhnaFq/browser-result.txt`、ブラウザ読み取りスクリプトは同ディレクトリの `inspect.js`。Projects の画像は `2-projects.png` と `3-projects.png`。API / WEB の画像でも2つの橙の目印を目視確認した。一時ファイル消去後にも判断できるよう、観測値を上表に記録した。

専用ブラウザは close 済み。自分が作ったプロセスの PID にのみ SIGTERM を送り、2台の `startUi` server を `stop()` したプロセスの終了コード0を確認した。他担当の server は停止していない。C に譲るべき固定 E2E ポートの占有はない。

### ユーザーが選べる2方式

| 観点 | DB に色を保持する | キーから多色を生成する |
|---|---|---|
| 動作 | 初回登録時に既存色と比較して色を割り当て、結果を保存する | キーの順序も反映する固定ハッシュから、多めの検証済み色パレットや色相を選ぶ |
| 安定性 | 登録後はキー・名前・他 Workspace の増減によらず固定。既存 Workspace の移行と削除後の再登録規則が必要 | 同じキー・同じ生成規則なら端末、並び順、追加・削除、再ロードによらず固定。キーまたは生成規則を変えると色が変わる |
| 衝突 | 保存だけでは解決しない。登録・移行時の使用済み色チェックが必要。有限パレットの上限を超える場合は拡張または再使用規則が必要 | 現行4色より衝突を減らせるが、同色も見た目が近い色も残る。衝突なしは保証できない |
| 見分けやすさ | 利用中 Workspace 同士の色差を考慮しやすい。Workspace 数が大きいと色だけの識別には限界 | 背景とのコントラストを満たす範囲に色を制限する必要がある。単純な色相の微差は識別困難 |
| 変更範囲 | schema/migration、core Workspace 型と登録/読取、API、Web 側の色取得、既存データ移行とテスト | 主に共通色関数とテスト。パレットを増やす場合 CSS トークン追加。既存バッジへの反映に各 Page の編集は不要 |
| 承認 | スキーマ変更のユーザー承認が必要。現時点では未承認 | スキーマ変更なし。ただし「別 Workspace の色が重複し得る」ことの受け入れが必要 |

**PM 向け推奨：** 「登録している Workspace 同士をできる限り確実に区別したい」が優先なら、使用済み色の確認を伴う DB 保持案を推奨する。変更範囲を小さくし、衝突が稀に残ることを許容するならキー由来の多色案を選ぶ。どちらも色数・最低限の色差・背景とのコントラストを決め、API / WEB を回帰検証に必ず含める。いずれの案でも名前・キーの表示を残す。

**PM がユーザーへ提示する質問案：**「Workspace の色は、登録済みの色と重ならないよう割り当てて DB に保存する方式（スキーマ変更あり・推奨）と、キーから多くの色を自動生成する方式（スキーマ変更なし・まれな重複あり）のどちらにしますか？」

### 次の工程

方式のユーザー選択を受けてから、色数・衝突時動作・安定性の保証範囲と必要ファイルを具体化し、旧 Task 1 / 2 を新しい受け入れ条件で改訂する。API / WEB を異色にする検証と、API / NOD / BLOG の画面横断での一貫性検証を入れる。現時点で特定色への一致をテストで固定しない。共有 core/types・server app・web api/types・spec は C が先行編集するため、DB 案の場合は PM の取り込み順調整を待つ。

追加調査では full bun test、全体型検査、Playwright 全120件の再実行はしていない。実施した確認は frozen install、web 型検査を含む build、実 DB を使わない2データセット×2画面の色取得、画像確認、起動プロセスの終了確認である。実装・commit・push は行っていない。
