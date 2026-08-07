import { App } from 'antd'

/**
 * Context-aware antd feedback APIs (message / modal / notification).
 *
 * antd's static methods (importing `{ Modal, message }` from 'antd' and calling
 * `Modal.confirm` / `message.error` directly) render outside the React tree and
 * therefore outside our `<StyleProvider layer>`, so the antd reset they inject
 * does not land in `@layer antd` — and unlayered styles always outrank layered
 * ones, so the global `a` reset repaints every sidebar `<Link>` link-blue (see
 * the comment at the top of app.tsx).
 *
 * These ESM live bindings bridge the context-aware instances `<App>` provides:
 * an importer reads the current value at call time, i.e. whatever
 * `AntdStaticBridge` registered, so the instances render inside the layer and
 * theme. This is also antd's own recommended way to use `message` from outside
 * the component tree (e.g. in main.tsx).
 */

type AppApi = ReturnType<typeof App.useApp>

// `let`, not `const`: AntdStaticBridge reassigns these, and they are exported as
// live bindings so importers observe the reassignment.
let message: AppApi['message']
let modal: AppApi['modal']
let notification: AppApi['notification']

export { message, modal, notification }

/**
 * Registers the context-aware feedback instances into the live bindings above.
 * Must be rendered once inside `<App>` (which itself sits under StyleProvider +
 * ConfigProvider). Renders nothing.
 */
export function AntdStaticBridge() {
  const app = App.useApp()
  message = app.message
  modal = app.modal
  notification = app.notification
  return null
}
