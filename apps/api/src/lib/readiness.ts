/**
 * Process readiness — "may this instance receive traffic yet?"
 *
 * Deliberately distinct from liveness (`GET /api/health`), which answers "is the
 * process alive" and whose failure should restart the pod. Readiness is false
 * during the boot window where the HTTP port is already bound but env-driven
 * settings have not been written to SQLite yet. Serving in that window is not
 * harmless: `GET /auth/oauth/config` answers 200 with an empty config, so the
 * login page renders without its enterprise SSO entry and only a manual refresh
 * brings it back.
 *
 * Plain module state is the right scope here: readiness describes this one
 * process, and a restart must reset it — persisting it would be a bug.
 */
let ready = false

/** Flip to ready. Idempotent: boot may settle through more than one path. */
export function markReady(): void {
  ready = true
}

export function isReady(): boolean {
  return ready
}

/** Test-only reset; production code never returns to not-ready once booted. */
export function resetReadinessForTests(): void {
  ready = false
}
