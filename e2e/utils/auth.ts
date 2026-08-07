import { type Page, expect } from '@playwright/test'
import { API_BASE, WEB_BASE, getE2ePassword } from './test-constants'

const COOKIE_NAME = 'a2wave_session'

interface LoginResponse {
  data: {
    token: string
    user: { id: string; username: string; role: string }
  }
}

// Cache the login promise per worker process so all parallel tests in the same
// worker share one HTTP request and don't trigger the rate limiter.
let adminTokenPromise: Promise<string> | null = null

async function login(username: string, password: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) {
    throw new Error(`Login failed: ${res.status}`)
  }
  const body = (await res.json()) as LoginResponse
  return body.data.token
}

export async function loginAsAdmin(page: Page): Promise<void> {
  if (!adminTokenPromise) {
    adminTokenPromise = login('admin', getE2ePassword()).catch((err) => {
      // 失败时清掉缓存，避免后续用例永久拿到 rejected Promise
      adminTokenPromise = null
      throw err
    })
  }
  const token = await adminTokenPromise
  await page.context().addCookies([
    {
      name: COOKIE_NAME,
      value: token,
      url: WEB_BASE,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
}

// Per-username login promise cache so parallel tests within one worker share a
// single /auth/login call per identity (mirrors the admin cache behavior).
const userTokenPromises = new Map<string, Promise<string>>()

/**
 * Log in as an arbitrary user and seed the JWT into localStorage before page
 * load. Intended for e2e tests that need to switch identities (owner / editor
 * / viewer / stranger) without hitting the rate limiter.
 */
export async function loginAs(page: Page, username: string, password: string): Promise<void> {
  let promise = userTokenPromises.get(username)
  if (!promise) {
    promise = login(username, password).catch((err) => {
      userTokenPromises.delete(username)
      throw err
    })
    userTokenPromises.set(username, promise)
  }
  const token = await promise
  await page.context().addCookies([
    {
      name: COOKIE_NAME,
      value: token,
      url: WEB_BASE,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
}

/**
 * Dismiss the first-time-user onboarding tour if it is showing.
 *
 * On a fresh database the FTUE tour is active, and `onboarding-tour.tsx` sets
 * `overlayClickAction: false` — antd's Tour mask then swallows pointer events
 * outside the spotlight, so ANY click on the sidebar (e.g. opening the user
 * menu) fails with "element intercepts pointer events". Call this in
 * `beforeEach` for specs that interact with the chrome around the page.
 *
 * Safe to call unconditionally: it no-ops when the prompt is absent (already
 * dismissed, or a database that has seen it before).
 */
export async function dismissOnboarding(page: Page): Promise<void> {
  const dismissButton = page.getByRole('button', {
    name: /^(不再提示|Don't show again)$/,
  })
  const opened = await dismissButton
    .waitFor({ state: 'visible', timeout: 2_000 })
    .then(() => true)
    .catch(() => false)
  if (!opened) return

  // Await the PATCH round trip, not just the button disappearing. The button
  // hiding is a client-side signal: navigating before the dismissal is persisted
  // lets the tour reappear on the next page load, which surfaces as a flake in a
  // later test rather than a failure here.
  const dismissed = page.waitForResponse(
    (response) =>
      response.url().includes('/api/auth/onboarding') && response.request().method() === 'PATCH',
  )
  await dismissButton.click()
  expect((await dismissed).ok()).toBeTruthy()
  await dismissButton.waitFor({ state: 'hidden' })
}
