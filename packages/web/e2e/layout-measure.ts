import type { Page } from "@playwright/test";

// 画面の寸法を測る（#184、#185）。値は design/nod.pen と突き合わせ、PR に実測値として書く

// Analytics と Summary のフィルタの行（Header のすぐ下の View Bar）
export async function measureFilterBar(page: Page) {
  return page.evaluate(() => {
    const main = document.querySelector("main") as HTMLElement;
    const header = main.querySelector("header") as HTMLElement;
    const bar = header.nextElementSibling as HTMLElement;
    const h = header.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    // タブ、期間のボタン、ラベルつきの select、トグル
    const controls = [...bar.querySelectorAll<HTMLElement>('[role="tab"], [aria-pressed], label:has(select), [role="switch"]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { center: r.y + r.height / 2, right: r.right };
    });
    // 中心が近いものを同じ行とみなし、行ごとに中心の差の最大を取る
    const rows: number[][] = [];
    for (const c of controls) {
      const row = rows.find((r) => Math.abs(r[0]! - c.center) <= 10);
      if (row) row.push(c.center);
      else rows.push([c.center]);
    }
    const selects = [...bar.querySelectorAll<HTMLElement>("label:has(select)")];
    return {
      headerHeight: h.height,
      headerControls: header.querySelectorAll("select, button").length,
      barTop: b.y - h.bottom,
      barHeight: b.height,
      controls: controls.length,
      rows: rows.length,
      centerDiff: Math.max(...rows.map((r) => Math.max(...r) - Math.min(...r))),
      selectHeights: [...new Set(selects.map((el) => el.getBoundingClientRect().height))],
      selectRadius: [...new Set(selects.map((el) => getComputedStyle(el).borderTopLeftRadius))],
      // フィルタの右端から View Bar の右端まで。負ならはみ出している
      rightGap: Math.round(b.right - Math.max(...controls.map((c) => c.right))),
      mainOverflow: main.scrollWidth - main.clientWidth,
      pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

// Inbox、Reviews、Triage の一覧（幅 400 の列）。label は一覧の aria-label
export async function measureSplitList(page: Page, label: string) {
  return page.evaluate((listLabel) => {
    const list = document.querySelector(`section[aria-label="${listLabel}"]`) as HTMLElement;
    const header = list.querySelector("header") as HTMLElement;
    const title = header.querySelector("h1") as HTMLElement;
    const l = list.getBoundingClientRect();
    const h = header.getBoundingClientRect();
    const parts = [...header.children].map((el) => el.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 1);
    const centers = parts.map((r) => r.y + r.height / 2);
    const rows = [...list.querySelectorAll<HTMLElement>("a")];
    const first = rows[0];
    const selected = rows.find((el) => el.dataset.selected === "true");
    const row = first?.getBoundingClientRect();
    const rowStyle = first && getComputedStyle(first);
    // 行の入れ物。上の余白は、その上端から最初の行まで
    const items = first?.parentElement?.getBoundingClientRect();
    const tabs = [...header.querySelectorAll<HTMLElement>('[role="tab"]')];
    const weights = (selector: string) => [...new Set([...list.querySelectorAll<HTMLElement>(selector)].map((el) => getComputedStyle(el).fontWeight))];
    return {
      listWidth: l.width,
      headerHeight: h.height,
      headerOverflow: header.scrollWidth - header.clientWidth,
      title: `${getComputedStyle(title).fontSize} / ${getComputedStyle(title).fontWeight}`,
      // Header の中の要素（題名、説明文、件数、タブ）は重ならず、中心が揃う
      headerParts: parts.length,
      headerGap: Math.min(...parts.slice(1).map((r, n) => Math.round(r.x - parts[n]!.right))),
      headerCenterDiff: Math.max(...centers) - Math.min(...centers),
      headerRight: Math.round(h.right - parts.at(-1)!.right),
      tabHeights: [...new Set(tabs.map((el) => el.getBoundingClientRect().height))],
      tabRadius: [...new Set(tabs.map((el) => getComputedStyle(el).borderTopLeftRadius))],
      rows: rows.length,
      row: row && rowStyle && items && {
        left: row.x - l.x,
        right: list.clientWidth - (row.right - l.x),
        top: row.y - items.y,
        bottom: Math.round(items.bottom - rows.at(-1)!.getBoundingClientRect().bottom),
        radius: rowStyle.borderTopLeftRadius,
        padding: rowStyle.padding,
        borderTop: rowStyle.borderTopWidth,
      },
      selectedBackground: selected ? getComputedStyle(selected).backgroundColor : null,
      // 行の題名は、1行目の2つ目の要素（アバターか未読の点の次）。既読は通知の行だけにある
      titleWeights: weights('a:not([data-unread="false"]) > div:first-child > :nth-child(2)'),
      readTitleWeights: weights('a[data-unread="false"] > div:first-child > :nth-child(2)'),
    };
  }, label);
}
