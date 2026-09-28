import type { Page } from "@playwright/test";

export const region = (page: Page, name: string) => page.getByRole("region", { name, exact: true });
