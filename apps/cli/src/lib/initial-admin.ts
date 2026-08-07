/**
 * Submit first-time administrator credentials to the platform.
 *
 * The password lives only in this call's body — never in argv, the environment,
 * or a file — which is why the request is built here rather than inline at the
 * call site.
 */
export function submitInitialAdminPassword(
  localUrl: string,
  password: string,
  confirmation: string,
): Promise<Response> {
  return fetch(`${localUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, confirmPassword: confirmation }),
  })
}
