import { useRef, useState, type ChangeEvent } from "react";

// URL のクエリに書く文字入力欄を、入力中は手元の値で表示する。
// URL は navigate のあと遅れて変わるため、URL の値をそのまま value に渡すと、IME の変換中に古い値で上書きされて変換が崩れる
// フォーカスが外れたら URL の値の表示に戻す。入力中でも、送った覚えのない値に URL が変わったら（戻る・進むなど）URL の値に戻す
export function useDraftText(value: string, onChange: (next: string) => void) {
  const [draft, setDraft] = useState<string | null>(null);
  // base: URL に反映済みの値。pending: 送ったがまだ URL に届いていない値（送った順）
  const sync = useRef<{ base: string; pending: string[] }>({ base: value, pending: [] });
  const s = sync.current;
  let external = false;
  if (draft === null) {
    s.base = value;
    s.pending = [];
  } else if (value !== s.base) {
    const arrived = s.pending.indexOf(value);
    if (arrived >= 0) {
      s.base = value;
      s.pending = s.pending.slice(arrived + 1);
    } else {
      external = true;
      s.base = value;
      s.pending = [];
      setDraft(null);
    }
  }
  return {
    value: external ? value : (draft ?? value),
    onChange: (event: ChangeEvent<HTMLInputElement>) => {
      s.pending.push(event.target.value);
      setDraft(event.target.value);
      onChange(event.target.value);
    },
    onBlur: () => setDraft(null),
  };
}
