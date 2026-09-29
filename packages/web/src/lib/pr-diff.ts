// PR の差分（#55）の表示。差分はすべて文字列のまま扱い、React のテキストノードとしてだけ描画する（HTML にしない）

export interface DiffRow {
  kind: "hunk" | "context" | "add" | "del" | "note";
  text: string; // 先頭の +・-・空白を除いた本文（hunk・note は行全体）
  oldNo: number | null;
  newNo: number | null;
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function diffRows(patch: string): DiffRow[] {
  if (patch === "") return [];
  const rows: DiffRow[] = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of patch.split("\n")) {
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line, oldNo: null, newNo: null });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: newNo++ });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), oldNo: oldNo++, newNo: null });
    } else if (line.startsWith("\\")) {
      rows.push({ kind: "note", text: line, oldNo: null, newNo: null });
    } else {
      rows.push({ kind: "context", text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return rows;
}

// GitHub の Files タブ。検証した GitHub の PR URL からだけ作る（href に任意の文字列を入れない）
export function githubFilesUrl(prUrl: string): string | null {
  const m = /^(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)\/?$/.exec(prUrl);
  return m ? `${m[1]}/files` : null;
}

export const shortSha = (sha: string) => sha.slice(0, 7);
