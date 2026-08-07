import type { Locator, Page } from '@playwright/test'

export abstract class BasePage {
  constructor(protected readonly page: Page) {}

  abstract goto(): Promise<void>

  async waitForLoad(): Promise<void> {
    await this.page.waitForLoadState('networkidle')
  }

  get sidebar(): Locator {
    return this.page.locator('aside')
  }

  get mainContent(): Locator {
    return this.page.locator('#main-content')
  }

  get brandTitle(): Locator {
    return this.page.locator('aside h1')
  }

  sidebarLink(name: string): Locator {
    return this.sidebar.getByRole('link', { name })
  }

  async navigateTo(linkName: string): Promise<void> {
    await this.sidebarLink(linkName).click()
    await this.waitForLoad()
  }
}
