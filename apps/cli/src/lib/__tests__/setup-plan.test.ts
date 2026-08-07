import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PORT,
  buildComposeFile,
  buildEnvFile,
  generateAuthSecret,
  generateProjectName,
  migrateComposeImageToVariable,
  readEnvImage,
  replaceEnvImage,
  validateImageRef,
} from '../setup-plan.js'

describe('generateAuthSecret', () => {
  it('produces a 64-char hex string, unique per call', () => {
    const a = generateAuthSecret()
    const b = generateAuthSecret()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})

describe('generateProjectName', () => {
  it('produces a compose-safe unique name with the a2wave prefix', () => {
    const a = generateProjectName()
    const b = generateProjectName()
    expect(a).toMatch(/^a2wave-[a-z0-9]{8}$/)
    expect(a).not.toBe(b)
  })
})

describe('buildEnvFile', () => {
  const base = {
    authSecret: 'a'.repeat(64),
    port: 3502,
    baseUrl: 'http://localhost:3502',
    projectName: 'a2wave-ab12cd34',
  }

  it('contains required keys', () => {
    const env = buildEnvFile(base)
    expect(env).toContain(`AUTH_SECRET=${'a'.repeat(64)}`)
    expect(env).toContain('A2WAVE_PORT=3502')
    expect(env).toContain('CORS_ORIGIN=http://localhost:3502')
  })

  it('persists a unique COMPOSE_PROJECT_NAME so same-basename installs cannot share volumes', () => {
    // Compose defaults the project name to the dir basename: /srv/a/a2wave and
    // /srv/b/a2wave would otherwise share the a2wave_a2wave-data volume, and
    // either side's `setup --down -v` would delete the other's database.
    expect(buildEnvFile(base)).toContain('COMPOSE_PROJECT_NAME=a2wave-ab12cd34')
  })

  it('does not embed an admin password — first-login setup owns that', () => {
    expect(buildEnvFile(base)).not.toContain('ADMIN_PASSWORD')
  })

  it('disables secure cookies for http base URLs', () => {
    expect(buildEnvFile(base)).toContain('AUTH_COOKIE_SECURE=false')
  })

  it('keeps secure cookies for https base URLs', () => {
    const env = buildEnvFile({ ...base, baseUrl: 'https://a2wave.example.com' })
    expect(env).not.toContain('AUTH_COOKIE_SECURE=false')
  })

  // A URL issuer must be https, so prefilling PUBLIC_URL from an http install
  // would write a value the gateway-signing enable path then rejects.
  it('prefills PUBLIC_URL for https installs', () => {
    const env = buildEnvFile({ ...base, baseUrl: 'https://a2wave.example.com' })
    expect(env).toContain('PUBLIC_URL=https://a2wave.example.com')
  })

  it('omits PUBLIC_URL for http installs', () => {
    expect(buildEnvFile(base)).not.toContain('PUBLIC_URL=')
  })

  it('ends with a trailing newline', () => {
    expect(buildEnvFile(base).endsWith('\n')).toBe(true)
  })
})

describe('buildEnvFile image key', () => {
  it('persists A2WAVE_IMAGE so upgrades are a one-line env edit', () => {
    const env = buildEnvFile({
      authSecret: 'a'.repeat(64),
      port: 3502,
      baseUrl: 'http://localhost:3502',
      projectName: 'a2wave-ab12cd34',
      image: 'a2wave:1.2.0',
    })
    expect(env).toContain('A2WAVE_IMAGE=a2wave:1.2.0')
  })
})

describe('validateImageRef', () => {
  it('accepts normal image references', () => {
    for (const ref of [
      'a2wave:latest',
      'ghcr.io/a2wave/a2wave:v1.3.1',
      'registry.example.com:5000/team/a2wave@sha256:abc123',
      'my_image.name-2:tag_1.x',
    ]) {
      expect(() => validateImageRef(ref)).not.toThrow()
    }
  })

  it('rejects refs that could inject YAML (newlines, spaces, quotes)', () => {
    for (const ref of [
      'a2wave:latest\n    privileged: true',
      'a2wave latest',
      'a2wave:"x"',
      "a2wave:'x'",
      'a2wave:#comment',
    ]) {
      expect(() => validateImageRef(ref)).toThrow(/image/i)
    }
  })
})

describe('buildComposeFile', () => {
  const image = 'ghcr.io/a2wave/a2wave:v1.3.1'

  it('reads the image from .env so an upgrade never has to edit this file', () => {
    // The image is a variable for the same reason the port is: rewriting a
    // hardcoded line means parsing YAML with regexes, which mis-targeted the
    // wrong service in six distinct valid-compose shapes. A2WAVE_IMAGE in .env
    // makes an upgrade a one-line env edit with nothing to parse.
    const compose = buildComposeFile({ image, port: 3510 })
    expect(compose).toContain(`image: \${A2WAVE_IMAGE:-${image}}`)
  })

  it('still records the generation-time image as the inline fallback', () => {
    const compose = buildComposeFile({ image, port: 3510 })
    expect(compose).toContain(image)
    // A2WAVE_PORT in .env must actually drive the mapping (default from generation time)
    expect(compose).toContain('"${A2WAVE_PORT:-3510}:3502"')
  })

  it('accepts an image override', () => {
    const compose = buildComposeFile({ image: 'ghcr.io/acme/a2wave:v9', port: DEFAULT_PORT })
    expect(compose).toContain('ghcr.io/acme/a2wave:v9')
  })

  it('wires env through the .env file and persists data in a named volume', () => {
    const compose = buildComposeFile({ image, port: DEFAULT_PORT })
    expect(compose).toContain('env_file:')
    expect(compose).toContain('a2wave-data:/app/data')
    expect(compose).toContain('restart: unless-stopped')
  })

  it('persists the provider CLI HOME so localSession logins survive container rebuilds', () => {
    const compose = buildComposeFile({ image, port: DEFAULT_PORT })
    expect(compose).toContain('a2wave-cli-home:/home/appuser')
  })

  it('does not leak internal-only settings (P4 / IDaaS / harbor)', () => {
    const compose = buildComposeFile({ image, port: DEFAULT_PORT })
    expect(compose).not.toMatch(/SCM_P4|IDAAS|harbor\./i)
  })
})

describe('buildEnvFile with a custom base URL', () => {
  it('writes the given origin into CORS_ORIGIN (LAN / reverse-proxy installs)', () => {
    const env = buildEnvFile({
      authSecret: 'a'.repeat(64),
      port: 3502,
      baseUrl: 'http://192.168.1.10:3502',
      projectName: 'a2wave-ab12cd34',
    })
    expect(env).toContain('CORS_ORIGIN=http://192.168.1.10:3502')
    expect(env).toContain('AUTH_COOKIE_SECURE=false')
  })
})

describe('readEnvImage / replaceEnvImage', () => {
  const env = 'COMPOSE_PROJECT_NAME=a2wave-dead\nAUTH_SECRET=secret\nA2WAVE_IMAGE=a2wave:1.0\n'

  it('reads the recorded image', () => {
    expect(readEnvImage(env)).toBe('a2wave:1.0')
  })

  it('returns null when the key is absent or empty', () => {
    expect(readEnvImage('AUTH_SECRET=x\n')).toBeNull()
    expect(readEnvImage('A2WAVE_IMAGE=\n')).toBeNull()
  })

  it('rewrites only the image line, leaving secrets byte-identical', () => {
    const after = replaceEnvImage(env, 'a2wave:2.0')
    expect(after).toContain('A2WAVE_IMAGE=a2wave:2.0')
    expect(after).toContain('AUTH_SECRET=secret')
    expect(after).toContain('COMPOSE_PROJECT_NAME=a2wave-dead')
    const strip = (s: string) => s.split('\n').filter((l) => !l.startsWith('A2WAVE_IMAGE='))
    expect(strip(after)).toEqual(strip(env))
  })

  it('appends the key when an older install lacks it', () => {
    const out = replaceEnvImage('AUTH_SECRET=x\n', 'a2wave:2.0')
    expect(out).toBe('AUTH_SECRET=x\nA2WAVE_IMAGE=a2wave:2.0\n')
  })
})

describe('migrateComposeImageToVariable', () => {
  const legacy = (image: string, port = 3510) =>
    buildComposeFile({ image, port }).replace(`\${A2WAVE_IMAGE:-${image}}`, image)

  it('migrates a file this command generated', () => {
    const out = migrateComposeImageToVariable(legacy('a2wave:1.2.0'))
    expect(out).toContain('image: ${A2WAVE_IMAGE:-a2wave:1.2.0}')
  })

  it('returns null when the file already uses the variable', () => {
    expect(
      migrateComposeImageToVariable(buildComposeFile({ image: 'a2wave:1.0', port: 3510 })),
    ).toBeNull()
  })

  it('refuses rather than guessing when a sidecar is declared before a2wave', () => {
    // Picking the first `image:` line rewrote redis and left a2wave hardcoded,
    // so the upgrade silently succeeded on the old image AND broke the sidecar.
    // Anything this command did not generate must be migrated by hand.
    const yaml = 'services:\n  redis:\n    image: redis:7\n  a2wave:\n    image: a2wave:1.2.0\n'
    expect(() => migrateComposeImageToVariable(yaml)).toThrow(/hand|manual/i)
  })

  it('refuses when a top-level anchor block declares its own image', () => {
    const yaml = 'x-common: &c\n  image: busybox\nservices:\n  a2wave:\n    image: a2wave:1.2.0\n'
    expect(() => migrateComposeImageToVariable(yaml)).toThrow(/hand|manual/i)
  })

  it('refuses a quoted value rather than embedding quotes in the default', () => {
    // `${A2WAVE_IMAGE:-"a2wave:1.0"}` makes the fallback include the quotes.
    const yaml = 'services:\n  a2wave:\n    image: "a2wave:1.2.0"\n'
    expect(() => migrateComposeImageToVariable(yaml)).toThrow(/hand|manual/i)
  })

  it('names the exact edit to make so the error is actionable', () => {
    const yaml = 'services:\n  redis:\n    image: redis:7\n  a2wave:\n    image: a2wave:1.2.0\n'
    expect(() => migrateComposeImageToVariable(yaml)).toThrow(/A2WAVE_IMAGE/)
  })
})

describe('migrateComposeImageToVariable substring bypass', () => {
  it('still refuses when A2WAVE_IMAGE appears outside the a2wave service', () => {
    // A whole-file substring check let a sidecar's env/comment mention of the
    // string skip the migration entirely: a2wave stayed hardcoded, only .env
    // changed, and the upgrade reported success on the old image.
    const yaml = [
      'services:',
      '  a2wave:',
      '    image: a2wave:1.0',
      '  helper:',
      '    environment:',
      '      - NOTE=${A2WAVE_IMAGE} is the key',
      '',
    ].join('\n')
    expect(() => migrateComposeImageToVariable(yaml)).toThrow(/hand|manual/i)
  })

  it('returns null only when the a2wave service itself uses the variable', () => {
    const generated = buildComposeFile({ image: 'a2wave:1.0', port: 3510 })
    expect(migrateComposeImageToVariable(generated)).toBeNull()
  })
})
