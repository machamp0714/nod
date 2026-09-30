import { expect, type Locator, type Page } from "@playwright/test";

// Issue 一覧（Issues、My issues、View、Project 詳細、Cycle 詳細）の View Bar と Display のポップオーバーの操作。
// design/nod.pen「11 Issues」（O7KCp3）と「Display Popover」（EMZdB）

const displayButton = (page: Page) => page.getByRole("button", { name: "表示設定", exact: true });

// Display のポップオーバーを開いて返す（開いていればそのまま返す）
export async function openDisplay(page: Page): Promise<Locator> {
  const popover = page.getByRole("dialog", { name: "表示設定", exact: true });
  await expect(displayButton(page)).toBeVisible();
  if (!(await popover.isVisible())) await displayButton(page).click();
  await expect(popover).toBeVisible();
  return popover;
}

// ポップオーバーは一覧の右上に重なるため、下の要素を押す前に閉じる
export async function closeDisplay(page: Page): Promise<void> {
  const popover = page.getByRole("dialog", { name: "表示設定", exact: true });
  if (await popover.isVisible()) await displayButton(page).click();
  await expect(popover).toHaveCount(0);
}

// グループ化、サブグループ、並び順のコンボボックス。今の値は data-value に出る（なしは "none"）
export async function displaySelect(page: Page, label: "グループ化" | "サブグループ" | "並び順"): Promise<Locator> {
  return (await openDisplay(page)).getByRole("button", { name: label, exact: true });
}

// コンボボックスを開いて、表示名で値を選ぶ
export async function chooseDisplay(page: Page, label: "グループ化" | "サブグループ" | "並び順", option: string): Promise<void> {
  const select = await displaySelect(page, label);
  await select.click();
  await page.getByRole("menu", { name: label, exact: true }).getByRole("menuitemradio", { name: option, exact: true }).click();
  await expect(select).toBeFocused();
}

// 並び順の方向のボタン。今の値は data-value に出る（asc、desc）
export async function setDirection(page: Page, direction: "asc" | "desc"): Promise<void> {
  const button = (await openDisplay(page)).getByRole("button", { name: "並び順の方向", exact: true });
  if ((await button.getAttribute("data-value")) !== direction) await button.click();
  await expect(button).toHaveAttribute("data-value", direction);
}

// List と Board の切り替え
export async function setLayout(page: Page, layout: "List" | "Board"): Promise<void> {
  const tab = (await openDisplay(page)).getByRole("tablist", { name: "表示" }).getByRole("tab", { name: layout, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

// 表示する Issue のスイッチ
export async function displaySwitch(page: Page, label: "完了済み Issue を表示" | "子 Issue を表示"): Promise<Locator> {
  return (await openDisplay(page)).getByRole("switch", { name: label, exact: true });
}

// リストの表示列のチップ（押すと切り替わる。表示中は aria-pressed が true）
export async function columnChip(page: Page, name: string): Promise<Locator> {
  return (await openDisplay(page)).getByRole("group", { name: "リストの表示列" }).getByRole("button", { name, exact: true });
}

export async function setColumn(page: Page, name: string, shown: boolean): Promise<void> {
  const chip = await columnChip(page, name);
  if ((await chip.getAttribute("aria-pressed")) !== String(shown)) await chip.click();
  await expect(chip).toHaveAttribute("aria-pressed", String(shown));
}

// 検索欄。View Bar の検索のアイコンボタンから開く（検索語があるあいだは開いたまま）
export async function searchBox(page: Page): Promise<Locator> {
  const box = page.getByRole("textbox", { name: "検索", exact: true });
  const button = page.getByRole("button", { name: "検索を開く", exact: true });
  await expect(box.or(button)).toBeVisible();
  if (!(await box.isVisible())) {
    await button.click();
    await expect(box).toBeFocused();
  }
  return box;
}

// Board の右端の Hidden columns（Issue が 0 件の列）の行
export function hiddenColumn(scope: Page | Locator, name: string): Locator {
  return scope.getByRole("region", { name: "Hidden columns", exact: true }).getByRole("listitem").filter({ hasText: name });
}
