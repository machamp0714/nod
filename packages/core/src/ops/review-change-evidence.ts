/** unified diffの変更行だけを根拠として扱う。文脈行や名前だけの変更では許可しない。 */
export function changedReviewLines(patch: string): Set<string> {
  const result = new Set<string>();
  let base = "", head = "", oldLine = 0, newLine = 0, inHunk = false;
  const path = (value: string): string => {
    // gitは空白を含むパスの---/+++行の末尾へTABを付ける。
    const raw = value.replace(/\t$/, "");
    if (!raw.startsWith('"')) return raw;
    try {
      const parts: Buffer[] = [];
      for (let i = 1; i < raw.length - 1; i++) {
        if (raw[i] === "\\") {
          const octal = raw.slice(i + 1).match(/^[0-7]{3}/)?.[0];
          if (octal) { parts.push(Buffer.from([parseInt(octal, 8)])); i += 3; continue; }
          parts.push(Buffer.from(JSON.parse('"' + raw.slice(i, i + 2) + '"'))); i++;
        } else {
          const character = String.fromCodePoint(raw.codePointAt(i)!);
          parts.push(Buffer.from(character)); i += character.length - 1;
        }
      }
      return Buffer.concat(parts).toString("utf8");
    } catch { return ""; }
  };
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) { base = head = ""; inHunk = false; }
    else if (!inHunk && line.startsWith("--- ")) base = path(line.slice(4)).replace(/^a\//, "");
    else if (!inHunk && line.startsWith("+++ ")) head = path(line.slice(4)).replace(/^b\//, "");
    else if (line.startsWith("@@ ")) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      inHunk = !!match; if (match) { oldLine = Number(match[1]); newLine = Number(match[2]); }
    } else if (inHunk && line.startsWith("+")) { if (head) result.add(`head:${head}:${newLine}`); newLine++; }
    else if (inHunk && line.startsWith("-")) { if (base) result.add(`base:${base}:${oldLine}`); oldLine++; }
    else if (inHunk && line.startsWith(" ")) { oldLine++; newLine++; }
  }
  return result;
}
