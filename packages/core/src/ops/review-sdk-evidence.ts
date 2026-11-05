/** 実版と引用中の値を照合する。範囲指定や版文字列の部分一致を実版の証明にしない。 */
export function exactSdkVersionQuoted(version: unknown, quote: unknown): boolean {
  if (typeof version !== "string" || typeof quote !== "string") return false;
  if (/[\s^~*<>=|]/.test(version)) return false;
  const release = version.slice(version.lastIndexOf("@") + 1);
  if (!/^v?\d[\w.+-]*$/.test(release) || /(?:^|\.)[xX](?:\.|$)/.test(release)) return false;
  const matches = (value: string) => value === version || value.endsWith(`@${version}`);
  // JSON/TOML等の文字列全体を照合し、"^1.2.3"や"1.2.3 - 2.0.0"から数値だけを取り出さない。
  const quoted = [...quote.matchAll(/"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'/g)];
  if (quoted.length) return quoted.some(match => matches(match[1] ?? match[2]!));
  // 単純なlockfileの非引用値も扱う。未知の構文を推測して受理しない。
  const value = quote.trim().replace(/\s+#.*$/, "").replace(/^[\w.-]+\s*[:=]\s*/, "").replace(/:$/, "");
  return matches(value);
}
