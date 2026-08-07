import type { ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import type { ProxyOptions } from 'vite'

// When the API is down, vite's proxy would answer a bare 500 with an HTML body,
// which the app surfaces as a misleading "HTTP_500". Answer a JSON 503 with a
// stable code instead so the UI (and anyone reading the network tab) sees the
// real cause: the backend is not running.
const apiProxy = (target: string): ProxyOptions => ({
  target,
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on('error', (err, _req, res) => {
      console.error(`[vite] API proxy error (is the API on ${target} running?):`, err.message)
      const response = res as ServerResponse
      if (response.headersSent || typeof response.writeHead !== 'function') {
        // Mid-stream failure (e.g. the API died during an SSE response): the
        // status is already on the wire — appending a JSON fragment to the
        // body would only confuse stream parsers. Just cut the connection.
        response.destroy?.()
        return
      }
      response.writeHead(503, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          error: 'API_UNREACHABLE',
          message: `API server at ${target} is not reachable — run \`pnpm dev:api\` (or check its logs).`,
        }),
      )
    })
  },
})

export default defineConfig(({ command }) => {
  // Read WEB_PORT/PORT from the monorepo-root .env so `pnpm dev` works without
  // `source .env` — mirroring apps/api/src/env.ts. Shell exports still win:
  // loadEnv never overrides values already present in process.env.
  //
  // serve-only: loadEnv has the side effect of exporting VITE_USER_NODE_ENV,
  // and resolveConfig downgrades an unset-NODE_ENV `vite build` to a
  // development build when the .env carries NODE_ENV=development. Production
  // builds must never read the local .env.
  const rootEnv = command === 'serve' ? loadEnv('development', resolve(__dirname, '../..'), '') : {}
  const envPort = (key: 'WEB_PORT' | 'PORT') =>
    Number(process.env[key] || rootEnv[key]) || undefined

  const WEB_PORT = envPort('WEB_PORT') ?? 3501
  const API_PORT = envPort('PORT') ?? 3502

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    server: {
      port: WEB_PORT,
      // Fail loudly when the port is taken instead of silently drifting to the
      // next free one — a drifted dev server ends up proxying /api to itself or
      // colliding with a sibling checkout's services.
      strictPort: true,
      host: true,
      proxy: {
        '/api': apiProxy(`http://127.0.0.1:${API_PORT}`),
        // 正则锚定 /s/ 开头，避免前缀匹配吞掉 /src/* 等 vite 源文件请求
        // （字符串 key 是前缀匹配，'/s' 会命中 '/src/main.tsx'）
        '^/s/': apiProxy(`http://127.0.0.1:${API_PORT}`),
      },
    },
  }
})
