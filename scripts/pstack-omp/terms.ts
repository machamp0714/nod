// 生成の対象のスキルから検出する Cursor の用語の一覧。スキルのディレクトリ以下の .md と、そこから相対リンクで辿れるスキルの外の .md の
// どれかに当たれば、そのスキルは用語を使う（generate.ts）。
// key は読み替え表（OMP 向けのディレクトリの skills/pstack-omp/SKILL.md）の対応行の最初のセルに、そのまま入っていなければならない文字列。
// 先頭の22種類は上流の道具（cursor/plugins の scripts/generate-pstack-harness-trees.mjs の TERMS）の key と正規表現をそのまま写したもの。
// 上流の ROUTE_KEY（Run another pstack skill）は入れない。
// 残りの4種類は上流の一覧にない、pstack の本文にある Cursor 由来の呼び方。似た書き方（foo/loop、/loop-on-ci、origin pr-123 など）に当たらないよう前後を限る。
export interface Term {
  key: string;
  re: RegExp;
}

export const TERMS: readonly Term[] = [
  { key: "`Task`", re: /`Task`|\bTask (tool|subagent|call)/ },
  { key: "`AskQuestion`", re: /AskQuestion/ },
  { key: "todolist", re: /\btodo ?list\b/i },
  { key: "generalPurpose", re: /generalPurpose/ },
  { key: "poteto-agent", re: /poteto-agent/ },
  { key: "comment-sicko", re: /comment-sicko/ },
  { key: "`readonly: true`", re: /readonly: (true|false)|readonly\/Ask/ },
  { key: '`environment: "cloud"`', re: /environment: "(cloud|local)"/ },
  { key: "cloud_base_branch", re: /cloud_base_branch/ },
  { key: "`run_in_background: true`", re: /run_in_background/ },
  { key: "`resume`", re: /`resume`/ },
  { key: "`file_attachments`", re: /file_attachments/ },
  { key: "claude-", re: /\bclaude-[a-z]+-\d/ },
  { key: "grok-", re: /\bgrok-\d/ },
  { key: "gpt-", re: /\bgpt-\d/ },
  { key: "inherit-parent", re: /inherit-parent/ },
  { key: "pstack-models.mdc", re: /pstack-models\.mdc/ },
  { key: ".cursor/skills/", re: /\.cursor\/skills/ },
  { key: "~/.cursor/plugins/", re: /\.cursor\/plugins|\.cursor-plugin/ },
  { key: ".cursor/rules/", re: /\.cursor\/rules|always-applied rule/ },
  { key: "agent-transcripts", re: /agent-transcripts|\.cursor\/projects/ },
  { key: "Cursor-only features", re: /Bugbot|Cursor [Aa]utomation|cursor\.(sh|com)\/automations|[Cc]loud [Aa]gent|built-in PR tool/ },
  // Cursor の組み込みの起床の仕組み（`/loop` や /loop until done）。パスの一部（foo/loop）や別のコマンド（/loop-on-ci）には当てない
  { key: "/loop", re: /(?<![\w./-])\/loop(?![\w/-])/ },
  // Origin の CLI（origin pr view <pr> など）。origin pr-123 のような枝の名前には当てない
  { key: "origin pr", re: /\borigin pr(?![\w-])/ },
  { key: "subagent_type", re: /\bsubagent_type\b/ },
  // Cursor の Project の worker（a Project worker、Project workers included）
  { key: "Project worker", re: /\bProject workers?\b/ },
];
