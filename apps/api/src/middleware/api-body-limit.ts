import { GatewayErrorCode } from '@a2wave/shared'
import { bodyLimit } from 'hono/body-limit'
import { createOAuthGatewayError } from '../lib/oauth-gateway-errors.js'

export const API_BODY_LIMIT_BYTES = 10 * 1024 * 1024

function formatByteLimit(bytes: number): string {
  const mib = 1024 * 1024
  if (bytes % mib === 0) return `${bytes / mib} MiB`
  return `${bytes}-byte`
}

export function apiBodyLimit(maxSize = API_BODY_LIMIT_BYTES) {
  return bodyLimit({
    maxSize,
    onError: (c) => {
      if (c.req.path.startsWith('/api/oauth/')) {
        return c.json(
          createOAuthGatewayError(
            GatewayErrorCode.PAYLOAD_TOO_LARGE,
            `The request body exceeds the ${formatByteLimit(maxSize)} API limit. Reduce the message or context size, then retry.`,
            { source: 'caller', action: 'fix_request', retryable: false },
          ),
          413,
        )
      }
      return c.text('Payload Too Large', 413)
    },
  })
}
