import type { Locator, Page } from "@playwright/test";

export const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });

// プロパティ欄のピル型ボタン（Status、Priority、Project、Milestone、Cycle、Assignee）。今の値は data-value に出る
export const property = (scope: Page | Locator, name: string) => scope.getByRole("button", { name, exact: true });
// ピルを押すと開くメニュー
export const propertyMenu = (scope: Page | Locator, name: string) => scope.getByRole("menu", { name: `${name} を変更`, exact: true });
// メニューを開いて項目を選ぶ
export async function chooseProperty(scope: Page | Locator, name: string, option: string): Promise<void> {
  await property(scope, name).click();
  await propertyMenu(scope, name).getByRole("menuitemradio", { name: option, exact: true }).click();
}
