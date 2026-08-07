import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const isBlockedHostMock = vi.fn()
vi.mock('../url-safety.js', () => ({
  isBlockedHost: (host: string) => isBlockedHostMock(host),
}))

vi.mock('../../db/client.js', () => ({
  db: { transaction: vi.fn() },
}))

vi.mock('../../db/schema.js', () => ({
  agents: {},
  kbDocuments: {},
  mcpServers: {},
  providers: {},
  scmSources: {},
  skills: {},
}))

vi.mock('../skill-storage.js', () => ({
  ensureDir: vi.fn(),
  getSkillStoragePath: (id: string) => `/tmp/skills/${id}`,
}))

vi.mock('../id.js', () => ({
  createId: vi.fn((prefix?: string) => `${prefix}_test`),
}))

import {
  AGENT_IMPORT_ARCHIVE_LIMITS,
  importAgentFromUrl,
  preflightAgentImportArchive,
  validateImportUrl,
} from '../agent-import.js'

const PUBLIC_DNS = [{ address: '93.184.216.34', family: 4 }]
const dispatcherFactory = () => ({ destroy: vi.fn(async () => {}) })

beforeEach(() => {
  isBlockedHostMock.mockReset()
  isBlockedHostMock.mockReturnValue(false)
})

describe('preflightAgentImportArchive', () => {
  function archive(entries: Array<{ path: string; content?: string }>): Buffer {
    const zip = new AdmZip()
    for (const entry of entries) zip.addFile(entry.path, Buffer.from(entry.content ?? 'x'))
    return zip.toBuffer()
  }

  it('rejects a high-compression entry from declared size before decompressing it', async () => {
    const zip = archive([{ path: 'skills/bomb/payload.bin', content: '\0'.repeat(1024 * 1024) }])
    const parsedZip = new AdmZip(zip)
    const entry = parsedZip.getEntries()[0]
    const getData = vi.spyOn(entry, 'getData')

    expect(() =>
      preflightAgentImportArchive(parsedZip, {
        ...AGENT_IMPORT_ARCHIVE_LIMITS,
        maxEntryUncompressedBytes: 512 * 1024,
      }),
    ).toThrow(/single entry.*512KB/i)
    expect(getData).not.toHaveBeenCalled()
  })

  it('rejects aggregate uncompressed size beyond the budget', async () => {
    const zip = archive([
      { path: 'one.bin', content: '123456' },
      { path: 'two.bin', content: '123456' },
    ])

    expect(() =>
      preflightAgentImportArchive(zip, {
        ...AGENT_IMPORT_ARCHIVE_LIMITS,
        maxEntryUncompressedBytes: 10,
        maxTotalUncompressedBytes: 10,
      }),
    ).toThrow(/total uncompressed.*10 bytes/i)
  })

  it('accepts an entry exactly at both size boundaries', async () => {
    const zip = archive([{ path: 'hello.txt', content: '1234567890' }])
    expect(() =>
      preflightAgentImportArchive(zip, {
        ...AGENT_IMPORT_ARCHIVE_LIMITS,
        maxEntryUncompressedBytes: 10,
        maxTotalUncompressedBytes: 10,
      }),
    ).not.toThrow()
  })

  it('rejects too many archive entries', async () => {
    const zip = archive([{ path: 'one.txt' }, { path: 'two.txt' }, { path: 'three.txt' }])
    expect(() =>
      preflightAgentImportArchive(zip, { ...AGENT_IMPORT_ARCHIVE_LIMITS, maxEntries: 2 }),
    ).toThrow(/more than 2 entries/i)
  })

  it.each([
    '../escape.txt',
    'skills/../escape.txt',
    'skills/./escape.txt',
    '/absolute.txt',
    'C:/windows.txt',
    'skills\\windows.txt',
    'skills//double.txt',
    'nul\0byte.txt',
  ])('rejects unsafe or malformed entry path %j', (path) => {
    const zip = {
      getEntries: () => [
        {
          entryName: path,
          isDirectory: false,
          header: { size: 1, compressedSize: 1 },
          getData: vi.fn(),
        },
      ],
    } as unknown as AdmZip
    expect(() => preflightAgentImportArchive(zip)).toThrow(/illegal path/i)
  })

  it('accepts a safe filename that contains two consecutive dots', async () => {
    expect(() =>
      preflightAgentImportArchive(archive([{ path: 'skills/example/hello..md' }])),
    ).not.toThrow()
  })

  it('rejects duplicate paths before any data is read', async () => {
    const entries = [
      {
        entryName: 'skills/example/file.txt',
        isDirectory: false,
        header: { size: 1, compressedSize: 1 },
        getData: vi.fn(),
      },
      {
        entryName: 'skills/example/file.txt',
        isDirectory: false,
        header: { size: 1, compressedSize: 1 },
        getData: vi.fn(),
      },
    ]
    const zip = { getEntries: () => entries } as unknown as AdmZip
    expect(() => preflightAgentImportArchive(zip)).toThrow(/duplicate ZIP entry path/i)
    expect(entries.every((entry) => entry.getData.mock.calls.length === 0)).toBe(true)
  })

  it('rejects a file that is also used as a parent directory', async () => {
    const entries = [
      {
        entryName: 'skills/example',
        isDirectory: false,
        header: { size: 1, compressedSize: 1 },
      },
      {
        entryName: 'skills/example/file.txt',
        isDirectory: false,
        header: { size: 1, compressedSize: 1 },
      },
    ]
    expect(() =>
      preflightAgentImportArchive({ getEntries: () => entries } as unknown as AdmZip),
    ).toThrow(/conflicts with a file/i)
  })

  it('rejects a parent file even when its child entry appears first', async () => {
    const entries = [
      {
        entryName: 'skills/example/file.txt',
        isDirectory: false,
        header: { size: 1, compressedSize: 1 },
      },
      {
        entryName: 'skills/example',
        isDirectory: false,
        header: { size: 1, compressedSize: 1 },
      },
    ]
    expect(() =>
      preflightAgentImportArchive({ getEntries: () => entries } as unknown as AdmZip),
    ).toThrow(/conflicts with a directory/i)
  })

  it('checks raw central-directory paths before AdmZip can sanitize them', async () => {
    const raw = archive([{ path: 'aa/x', content: 'safe' }])
    const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02])
    const central = raw.indexOf(signature)
    expect(central).toBeGreaterThanOrEqual(0)
    raw.write('../x', central + 46, 'utf-8')

    expect(() => preflightAgentImportArchive(raw)).toThrow(/illegal path/i)
  })

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid or ZIP64-sized declared entry size %s',
    (size) => {
      const entry = {
        entryName: 'payload.bin',
        isDirectory: false,
        header: { size, compressedSize: 1 },
        getData: vi.fn(),
      }
      const zip = { getEntries: () => [entry] } as unknown as AdmZip
      expect(() => preflightAgentImportArchive(zip)).toThrow(/invalid uncompressed size/i)
      expect(entry.getData).not.toHaveBeenCalled()
    },
  )

  it('enforces the existing 10MiB per-Skill aggregate contract', async () => {
    const zip = archive([
      { path: 'skills/example/one.bin', content: '123456' },
      { path: 'skills/example/two.bin', content: '123456' },
    ])
    expect(() =>
      preflightAgentImportArchive(zip, {
        ...AGENT_IMPORT_ARCHIVE_LIMITS,
        maxEntryUncompressedBytes: 10,
        maxTotalUncompressedBytes: 20,
        maxSkillUncompressedBytes: 10,
      }),
    ).toThrow(/Skill.*10 bytes/i)
  })

  it('enforces the per-Skill file-count budget', async () => {
    const zip = archive([{ path: 'skills/example/one.txt' }, { path: 'skills/example/two.txt' }])
    expect(() =>
      preflightAgentImportArchive(zip, {
        ...AGENT_IMPORT_ARCHIVE_LIMITS,
        maxSkillFiles: 1,
      }),
    ).toThrow(/Skill.*more than 1 files/i)
  })

  it('rejects symbolic-link entries before reading their data', async () => {
    const entry = {
      entryName: 'skills/example/link',
      isDirectory: false,
      attr: 0o120777 << 16,
      header: { size: 1, compressedSize: 1 },
      getData: vi.fn(),
    }
    expect(() =>
      preflightAgentImportArchive({ getEntries: () => [entry] } as unknown as AdmZip),
    ).toThrow(/symbolic link/i)
    expect(entry.getData).not.toHaveBeenCalled()
  })
})

describe('validateImportUrl', () => {
  it('returns a URL object on valid http/https input', async () => {
    expect(validateImportUrl('https://example.com/x').hostname).toBe('example.com')
    expect(validateImportUrl('http://example.com/y').protocol).toBe('http:')
  })

  it('rejects malformed URLs', async () => {
    expect(() => validateImportUrl('not a url')).toThrow(/Invalid URL/)
  })

  it('rejects non-http(s) schemes', async () => {
    expect(() => validateImportUrl('file:///etc/passwd')).toThrow(
      /Only the http\/https protocols are supported/,
    )
    expect(() => validateImportUrl('ftp://example.com/x')).toThrow(
      /Only the http\/https protocols are supported/,
    )
  })

  it('rejects blocked hosts (internal/private)', async () => {
    isBlockedHostMock.mockReturnValue(true)
    expect(() => validateImportUrl('http://internal.local/x')).toThrow(
      /internal network addresses is not allowed/,
    )
    expect(isBlockedHostMock).toHaveBeenCalledWith('internal.local')
  })
})

describe('importAgentFromUrl', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('runs the URL validation first', async () => {
    isBlockedHostMock.mockReturnValue(true)
    await expect(importAgentFromUrl('http://x.local/y', 'usr_1')).rejects.toThrow(
      /internal network addresses is not allowed/,
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a redirect to a blocked host per-hop, without fetching the internal host', async () => {
    isBlockedHostMock.mockImplementation((host) => host === 'evil.internal')
    // Public first hop replies 302 → internal. safeFetch must validate the Location
    // before following, so the internal host is never actually requested (no blind SSRF).
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: new Headers({ location: 'http://evil.internal/x' }),
      }),
    )
    await expect(
      importAgentFromUrl('http://example.com/x', 'usr_1', undefined, false, {
        fetchImpl: fetchMock,
        resolveHostname: async (hostname) =>
          hostname === 'evil.internal' ? [{ address: '10.0.0.8', family: 4 }] : PUBLIC_DNS,
        dispatcherFactory,
      }),
    ).rejects.toThrow()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('http://example.com/x')
    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual')
  })

  it('throws when the HTTP response is not ok, including body text', async () => {
    fetchMock.mockResolvedValue(
      new Response('upstream down', { status: 502, statusText: 'Bad Gateway' }),
    )
    await expect(
      importAgentFromUrl('http://example.com/x', 'usr_1', undefined, false, {
        fetchImpl: fetchMock,
        resolveHostname: async () => PUBLIC_DNS,
        dispatcherFactory,
      }),
    ).rejects.toThrow(/Failed to download from the remote URL.*502.*upstream down/)
  })

  it('throws when the response is not a ZIP', async () => {
    fetchMock.mockResolvedValue(
      new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }),
    )
    await expect(
      importAgentFromUrl('http://example.com/x', 'usr_1', undefined, false, {
        fetchImpl: fetchMock,
        resolveHostname: async () => PUBLIC_DNS,
        dispatcherFactory,
      }),
    ).rejects.toThrow(/did not return a ZIP file/)
  })

  it('accepts a response whose body starts with the ZIP magic bytes even with a generic content-type', async () => {
    const zipMagic = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x00])
    fetchMock.mockResolvedValue(
      new Response(zipMagic, { headers: { 'content-type': 'application/octet-stream' } }),
    )
    // We mocked db.transaction to undefined, so the import will throw inside importAgentFromZip
    // when it tries to read manifest.json. That's OK — what we care about is that we got past
    // the content-type check.
    // The few magic bytes pass the content-type sniff but the buffer isn't a real ZIP,
    // so AdmZip throws — what we want to assert is that we got past the type guard
    // (the error is no longer "did not return a ZIP file").
    await expect(
      importAgentFromUrl('http://example.com/x', 'usr_1', undefined, false, {
        fetchImpl: fetchMock,
        resolveHostname: async () => PUBLIC_DNS,
        dispatcherFactory,
      }),
    ).rejects.toThrow(/(zip|ZIP)/i)
  })

  it('rejects a hostname with mixed public and private DNS answers before fetching', async () => {
    const pinnedFetch = vi.fn()
    await expect(
      importAgentFromUrl('https://mixed.example/agent.zip', 'usr_1', undefined, false, {
        fetchImpl: pinnedFetch,
        resolveHostname: async () => [...PUBLIC_DNS, { address: '10.0.0.5', family: 4 }],
        dispatcherFactory,
      }),
    ).rejects.toThrow()
    expect(pinnedFetch).not.toHaveBeenCalled()
  })

  it('allows an exact trusted hostname on ordinary private DNS but never metadata', async () => {
    const pinnedFetch = vi.fn(async () => new Response('no zip', { status: 400 }))
    await expect(
      importAgentFromUrl('https://import.internal.example/agent.zip', 'usr_1', undefined, false, {
        fetchImpl: pinnedFetch,
        trustedHosts: new Set(['import.internal.example']),
        resolveHostname: async () => [{ address: '10.10.0.8', family: 4 }],
        dispatcherFactory,
      }),
    ).rejects.toThrow(/Failed to download/)
    expect(pinnedFetch).toHaveBeenCalledOnce()

    pinnedFetch.mockClear()
    await expect(
      importAgentFromUrl('https://metadata.google.internal/compute', 'usr_1', undefined, false, {
        fetchImpl: pinnedFetch,
        trustedHosts: new Set(['metadata.google.internal']),
        resolveHostname: async () => [{ address: '169.254.169.254', family: 4 }],
        dispatcherFactory,
      }),
    ).rejects.toThrow()
    expect(pinnedFetch).not.toHaveBeenCalled()
  })

  it.each(['100.100.100.200', 'fd00:ec2::254', '64:ff9b::6464:64c8'])(
    'rejects trusted import DNS resolving to cloud metadata %s',
    async (address) => {
      const pinnedFetch = vi.fn()
      await expect(
        importAgentFromUrl('https://import.internal.example/agent.zip', 'usr_1', undefined, false, {
          fetchImpl: pinnedFetch,
          trustedHosts: new Set(['import.internal.example']),
          resolveHostname: async () => [{ address, family: address.includes(':') ? 6 : 4 }],
          dispatcherFactory,
        }),
      ).rejects.toThrow(/private or reserved/i)
      expect(pinnedFetch).not.toHaveBeenCalled()
    },
  )

  it('rejects an oversized Content-Length before reading the body', async () => {
    const cancel = vi.fn(async () => {})
    const body = new ReadableStream<Uint8Array>({ cancel })
    const pinnedFetch = vi.fn(
      async () =>
        new Response(body, {
          headers: {
            'content-type': 'application/zip',
            'content-length': String(50 * 1024 * 1024 + 1),
          },
        }),
    )
    await expect(
      importAgentFromUrl('https://public.example/agent.zip', 'usr_1', undefined, false, {
        fetchImpl: pinnedFetch,
        resolveHostname: async () => PUBLIC_DNS,
        dispatcherFactory,
      }),
    ).rejects.toThrow(/must not exceed 50MB/)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('cancels a no-Content-Length stream as soon as it crosses 50MiB', async () => {
    const cancel = vi.fn(async () => {})
    let sent = 0
    const chunk = new Uint8Array(10 * 1024 * 1024)
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent++
        controller.enqueue(chunk)
      },
      cancel,
    })
    const pinnedFetch = vi.fn(
      async () => new Response(body, { headers: { 'content-type': 'application/zip' } }),
    )
    await expect(
      importAgentFromUrl('https://public.example/agent.zip', 'usr_1', undefined, false, {
        fetchImpl: pinnedFetch,
        resolveHostname: async () => PUBLIC_DNS,
        dispatcherFactory,
      }),
    ).rejects.toThrow(/must not exceed 50MB/)
    expect(sent).toBeLessThanOrEqual(7)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('aborts a remote import that exceeds its overall timeout', async () => {
    const pinnedFetch = vi.fn(
      async (_url: string | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        }),
    )
    await expect(
      importAgentFromUrl('https://slow.example/agent.zip', 'usr_1', undefined, false, {
        fetchImpl: pinnedFetch,
        resolveHostname: async () => PUBLIC_DNS,
        dispatcherFactory,
        timeoutMs: 10,
      }),
    ).rejects.toThrow(/timed out/)
  })

  it('strips custom credentials when a redirect changes origin', async () => {
    const pinnedFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://canonical.example/agent.zip' },
        }),
      )
      .mockResolvedValueOnce(new Response('not found', { status: 404 }))
    await expect(
      importAgentFromUrl(
        'https://public.example/agent.zip',
        'usr_1',
        { Authorization: 'Bearer secret', 'X-Company-Token': 'secret' },
        false,
        {
          fetchImpl: pinnedFetch,
          resolveHostname: async () => PUBLIC_DNS,
          dispatcherFactory,
        },
      ),
    ).rejects.toThrow(/Failed to download/)
    const redirectedHeaders = new Headers(pinnedFetch.mock.calls[1]?.[1]?.headers)
    expect(redirectedHeaders.get('authorization')).toBeNull()
    expect(redirectedHeaders.get('x-company-token')).toBeNull()
  })
})
