// 画像のアップロードが終わるまで本文に置いておく文字列。終わったら同じ文字列を探して置き換えるので、
// その間に入力が続いても位置がずれない
export function uploadPlaceholder(): string {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
  return `![アップロード中…](uploading-${id})`;
}

export function insertAt(text: string, at: number, insert: string): string {
  return text.slice(0, at) + insert + text.slice(at);
}

// replacement の $& などを置換パターンとして読ませないよう、関数で渡す
export function replacePlaceholder(text: string, placeholder: string, replacement: string): string {
  return text.replace(placeholder, () => replacement);
}

// 保存した画像の Markdown。空白・括弧・<> を含むパスはそのままだとリンク先が途中で切れるので <> で囲む
// （<> の中では < と > をエスケープする）
export function imageMarkdown(path: string): string {
  if (!/[\s()<>]/.test(path)) return `![](${path})`;
  return `![](<${path.replace(/[<>]/g, (c) => `\\${c}`)}>)`;
}
