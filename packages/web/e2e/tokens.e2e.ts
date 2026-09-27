import { expect, test } from "./fixtures";

test("デザイントークンが body に効いている", async ({ page }) => {
  await page.goto("/");
  const style = await page.evaluate(() => {
    const s = getComputedStyle(document.body);
    return {
      background: s.backgroundColor,
      color: s.color,
      font: s.fontFamily,
      accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
    };
  });
  expect(style.background).toBe("rgb(245, 246, 248)");
  expect(style.color).toBe("rgb(22, 26, 33)");
  expect(style.font).toContain("IBM Plex Sans JP");
  expect(style.accent.toUpperCase()).toBe("#3F51D8");
});
