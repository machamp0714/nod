// OMP の定義のファイル（スキルの SKILL.md・エージェント定義）の frontmatter を、OMP 19.1.0 と同じ形で読む（omp-skills.ts・places.ts が使う）。
import { isMapping } from "./config";

// @oh-my-pi/pi-utils@19.1.0 の parseFrontmatter のうち、name・description・enabled を読むのに要る部分: 改行を \n にそろえ、frontmatter の前の
// HTML のコメントを除き、--- で始まらなければ無し。最初の \n--- までを YAML として読み（タブは空白2つに、コメントは除く）、読めなければ
// 「キー: 値」の曖昧な値を引用符で囲んで読み直し、それでも読めなければ行ごとの「キー: 値」として読む。キーの kebab-case の読み替えはしない
export function parseFrontmatter(text: string): Record<string, unknown> {
  let content = text.replace(/\r\n?/g, "\n");
  const leading = /^(?:(?:\s*<!--[\s\S]*?-->)+)/.exec(content);
  if (leading !== null && /^\s*---/.test(content.slice(leading[0].length))) content = content.slice(leading[0].length).replace(/^\s+/, "");
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end === -1) return {};
  const metadata = content.slice(4, end).replace(/<!--[\s\S]*?-->/g, "");
  const record = (yaml: string): Record<string, unknown> => {
    const loaded: unknown = Bun.YAML.parse(yaml.replaceAll("\t", "  "));
    return isMapping(loaded) ? loaded : {};
  };
  try {
    return record(metadata);
  } catch {
    // 下で読み直す
  }
  const quoted = quoteAmbiguousPlainScalars(metadata);
  if (quoted !== undefined) {
    try {
      return record(quoted);
    } catch {
      // 下の行ごとの読み方にする
    }
  }
  const fallback: Record<string, unknown> = {};
  for (const line of metadata.split("\n")) {
    const match = /^([\w-]+):\s*(.*)$/.exec(line);
    if (match === null) continue;
    const raw = match[2]!.trim();
    let value: unknown = raw;
    if (raw.length > 0) {
      try {
        const parsed: unknown = Bun.YAML.parse(raw);
        if ((parsed !== null && typeof parsed !== "object") || Array.isArray(parsed)) value = parsed;
      } catch {
        // そのままの文字列にする
      }
    }
    fallback[match[1]!] = value;
  }
  return fallback;
}

// 「キー: 値」の値が引用符などで始まらず、中に ": " を含む行の値を、JSON の文字列にする（変えた行が無ければ undefined）
function quoteAmbiguousPlainScalars(metadata: string): string | undefined {
  let changed = false;
  const lines = metadata.split("\n").map((line) => {
    const match = /^(\s*[A-Za-z_][\w-]*:\s+)(\S.*?)(\s*)$/.exec(line);
    if (match === null) return line;
    const value = match[2]!.trimEnd();
    if (!value.includes(": ") || ['"', "'", "[", "{", "|", ">", "!", "&", "*", "#"].includes(value[0]!)) return line;
    changed = true;
    return `${match[1]}${JSON.stringify(value)}${match[3]}`;
  });
  return changed ? lines.join("\n") : undefined;
}
