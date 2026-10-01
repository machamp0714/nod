import { useState, type ChangeEvent } from "react";

// URL のクエリに書く文字入力欄を、入力中は手元の値で表示する。
// URL は navigate のあと遅れて変わるため、URL の値をそのまま value に渡すと、IME の変換中に古い値で上書きされて変換が崩れる
// フォーカスが外れたら URL の値の表示に戻す
export function useDraftText(value: string, onChange: (next: string) => void) {
  const [draft, setDraft] = useState<string | null>(null);
  return {
    value: draft ?? value,
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      setDraft(event.target.value);
      onChange(event.target.value);
    },
    onBlur: () => setDraft(null),
  };
}
