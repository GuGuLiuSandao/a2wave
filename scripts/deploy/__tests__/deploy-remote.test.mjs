import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const testDir = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(testDir, '..', '..', '..')
const deployScript = resolve(projectRoot, 'scripts/deploy-remote.sh')
const composeFile = resolve(projectRoot, 'docker-compose.yml')

function writeExecutable(path, body) {
  writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${body}`)
  chmodSync(path, 0o755)
}

function createFakeCommands(directory) {
  writeExecutable(
    join(directory, 'docker'),
    `if [[ \"\${1:-}\" == \"save\" ]]; then printf image; fi`,
  )
  writeExecutable(
    join(directory, 'sshpass'),
    `
last=\"\${!#}\"
if [[ \"$last\" == *\"docker --version\"* ]]; then
  printf 'Docker version 27.0.0\\n'
elif [[ \"$last\" == *\"docker run -d\"* || \"$last\" == *\"'docker' 'run' '-d'\"* ]]; then
  printf '%s' \"$last\" > \"$CAPTURED_REMOTE_COMMAND\"
fi
`,
  )
  writeExecutable(join(directory, 'curl'), `printf '{\"status\":\"ok\"}\\n'`)
  writeExecutable(join(directory, 'sleep'), ':')
}

function captureRemoteDockerCommand(extraEnv = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'a2wave-deploy-test-'))
  const capturedCommand = join(directory, 'remote-command')
  createFakeCommands(directory)

  const result = spawnSync('bash', [deployScript, '--skip-build'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      CAPTURED_REMOTE_COMMAND: capturedCommand,
      TMP_IMAGE: join(directory, 'image.tar.gz'),
      // Host/user have no defaults — the script refuses to run without them so
      // an unconfigured invocation can never reach someone else's machine.
      DEPLOY_HOST: '192.0.2.10',
      DEPLOY_USER: 'deploy',
      DEPLOY_PASS: 'test-password',
      DEPLOY_AUTH_SECRET: 'test-auth-secret',
      DEPLOY_ADMIN_PASS: 'test-admin-password',
      ...extraEnv,
    },
  })

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  return { command: readFileSync(capturedCommand, 'utf8'), directory }
}

function parseRemoteDockerArgs(command, directory, shell = 'bash') {
  const dockerArgsFile = join(directory, 'docker-args')
  writeExecutable(
    join(directory, 'sudo'),
    `
if [[ \"\${1:-}\" == \"-S\" ]]; then shift; fi
exec \"$@\"
`,
  )
  writeExecutable(join(directory, 'docker'), `printf '%s\\0' \"$@\" > \"$DOCKER_ARGS_FILE\"`)

  const marker = join(directory, 'injection-marker')
  execFileSync(shell, ['-c', command], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      DOCKER_ARGS_FILE: dockerArgsFile,
      INJECTION_MARKER: marker,
    },
  })

  return {
    args: readFileSync(dockerArgsFile).toString().split('\0').filter(Boolean),
    marker,
  }
}

function dockerEnv(args) {
  const environment = new Map()
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '-e') continue
    const value = args[index + 1]
    const separator = value.indexOf('=')
    environment.set(value.slice(0, separator), value.slice(separator + 1))
  }
  return environment
}

// issuer + client_id must be supplied together — the script rejects a partial
// config rather than deploying an instance whose SSO can never work. The
// remaining knobs are genuinely optional: a PKCE public client has no secret,
// scopes have a server-side default, and CHANNEL_AUDIENCES only governs the
// OAuth publish channel, which many deployments do not use.
const OIDC_ENV = {
  DEPLOY_OIDC_ISSUER: 'https://issuer.example/',
  DEPLOY_OIDC_CLIENT_ID: 'a2wave-test',
}

function runDeploy(env) {
  const directory = mkdtempSync(join(tmpdir(), 'a2wave-deploy-test-'))
  createFakeCommands(directory)

  return spawnSync('bash', [deployScript, '--skip-build'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      CAPTURED_REMOTE_COMMAND: join(directory, 'remote-command'),
      TMP_IMAGE: join(directory, 'image.tar.gz'),
      DEPLOY_HOST: '192.0.2.10',
      DEPLOY_USER: 'deploy',
      DEPLOY_PASS: 'test-password',
      DEPLOY_AUTH_SECRET: 'test-auth-secret',
      DEPLOY_ADMIN_PASS: 'test-admin-password',
      ...env,
    },
  })
}

test('OIDC config is injected into the container', () => {
  const { command, directory } = captureRemoteDockerCommand({ ...OIDC_ENV })
  const environment = dockerEnv(parseRemoteDockerArgs(command, directory).args)

  assert.equal(environment.get('A2WAVE_OIDC_ISSUER'), OIDC_ENV.DEPLOY_OIDC_ISSUER)
  assert.equal(environment.get('A2WAVE_OIDC_CLIENT_ID'), OIDC_ENV.DEPLOY_OIDC_CLIENT_ID)
})

// A PKCE public client has no secret; requiring one would block a valid setup,
// and injecting an empty one would override an image-level default.
test('OIDC deploys without a client secret, and omits it rather than blanking it', () => {
  const { command, directory } = captureRemoteDockerCommand({ ...OIDC_ENV })
  const environment = dockerEnv(parseRemoteDockerArgs(command, directory).args)

  assert.equal(environment.has('A2WAVE_OIDC_CLIENT_SECRET'), false)
  assert.equal(environment.has('A2WAVE_OIDC_SCOPES'), false)
  assert.equal(environment.has('A2WAVE_OIDC_CHANNEL_AUDIENCES'), false)
})

test('supplied optional knobs are injected alongside the required pair', () => {
  const { command, directory } = captureRemoteDockerCommand({
    ...OIDC_ENV,
    DEPLOY_OIDC_CLIENT_SECRET: 's3cret',
    DEPLOY_OIDC_SCOPES: 'openid email',
    DEPLOY_OIDC_CHANNEL_AUDIENCES: 'partner-service,data-platform',
  })
  const environment = dockerEnv(parseRemoteDockerArgs(command, directory).args)

  assert.equal(environment.get('A2WAVE_OIDC_CLIENT_SECRET'), 's3cret')
  assert.equal(environment.get('A2WAVE_OIDC_SCOPES'), 'openid email')
  assert.equal(environment.get('A2WAVE_OIDC_CHANNEL_AUDIENCES'), 'partner-service,data-platform')
})

test('OIDC env is omitted entirely when unconfigured', () => {
  const { command, directory } = captureRemoteDockerCommand()
  const environment = dockerEnv(parseRemoteDockerArgs(command, directory).args)

  // Injecting empty values would make the backend believe OIDC is configured.
  for (const name of [
    'A2WAVE_OIDC_ISSUER',
    'A2WAVE_OIDC_CLIENT_ID',
    'A2WAVE_OIDC_CLIENT_SECRET',
    'A2WAVE_OIDC_SCOPES',
    'A2WAVE_OIDC_CHANNEL_AUDIENCES',
  ]) {
    assert.equal(environment.has(name), false)
  }
})

test('a partial OIDC config is rejected', () => {
  // Either half alone leaves an instance whose SSO can never complete.
  for (const partial of [
    { DEPLOY_OIDC_ISSUER: 'https://issuer.example/' },
    { DEPLOY_OIDC_CLIENT_ID: 'a2wave-test' },
  ]) {
    const result = runDeploy(partial)
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, /OIDC config/)
  }
})

// Silently ignoring a dependent knob would leave the operator believing SSO is
// configured while the container receives nothing at all.
test('a dependent knob without the required pair is rejected', () => {
  for (const name of [
    'DEPLOY_OIDC_CLIENT_SECRET',
    'DEPLOY_OIDC_SCOPES',
    'DEPLOY_OIDC_CHANNEL_AUDIENCES',
  ]) {
    const result = runDeploy({ [name]: 'x' })
    assert.notEqual(result.status, 0)
    assert.match(result.stdout + result.stderr, new RegExp(name))
  }
})

test('deploy user is required rather than defaulted', () => {
  // Asserted separately from DEPLOY_HOST: the host guard exits first, so a
  // combined case would leave this branch untested.
  const result = runDeploy({ DEPLOY_USER: '' })

  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /DEPLOY_USER/)
})

test('deploy target is required rather than defaulted', () => {
  const directory = mkdtempSync(join(tmpdir(), 'a2wave-deploy-test-'))
  createFakeCommands(directory)

  const result = spawnSync('bash', [deployScript, '--skip-build'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      CAPTURED_REMOTE_COMMAND: join(directory, 'remote-command'),
      TMP_IMAGE: join(directory, 'image.tar.gz'),
      DEPLOY_PASS: 'test-password',
      DEPLOY_AUTH_SECRET: 'test-auth-secret',
      DEPLOY_ADMIN_PASS: 'test-admin-password',
    },
  })

  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /DEPLOY_HOST/)
})

test('OIDC values survive remote shell parsing as single docker arguments', () => {
  const markerExpression = '$(touch "$INJECTION_MARKER")'
  const values = {
    A2WAVE_OIDC_ISSUER: `https://issuer.example/a path/'quoted';${markerExpression}`,
    A2WAVE_OIDC_CLIENT_ID: `client one;${markerExpression}`,
    A2WAVE_OIDC_CLIENT_SECRET: `it's a secret;${markerExpression}`,
    A2WAVE_OIDC_SCOPES: `openid profile;${markerExpression}`,
    A2WAVE_OIDC_CHANNEL_AUDIENCES: `aud one, aud two;${markerExpression} 公钥`,
  }
  const { command, directory } = captureRemoteDockerCommand({
    DEPLOY_OIDC_ISSUER: values.A2WAVE_OIDC_ISSUER,
    DEPLOY_OIDC_CLIENT_ID: values.A2WAVE_OIDC_CLIENT_ID,
    DEPLOY_OIDC_CLIENT_SECRET: values.A2WAVE_OIDC_CLIENT_SECRET,
    DEPLOY_OIDC_SCOPES: values.A2WAVE_OIDC_SCOPES,
    DEPLOY_OIDC_CHANNEL_AUDIENCES: values.A2WAVE_OIDC_CHANNEL_AUDIENCES,
  })
  const { args, marker } = parseRemoteDockerArgs(command, directory)
  const environment = dockerEnv(args)

  for (const [name, value] of Object.entries(values)) {
    assert.equal(environment.get(name), value)
  }
  assert.throws(() => readFileSync(marker), { code: 'ENOENT' })

  const posix = parseRemoteDockerArgs(command, directory, 'dash')
  const posixEnvironment = dockerEnv(posix.args)
  for (const [name, value] of Object.entries(values)) {
    assert.equal(posixEnvironment.get(name), value)
  }
})

test('deploy-remote passes through only configured proxy variables', () => {
  const proxies = {
    HTTPS_PROXY: 'https://proxy.example:8443/a path',
    HTTP_PROXY: 'http://proxy.example:8080',
    https_proxy: 'https://lower.example:8443',
    http_proxy: 'http://lower.example:8080',
  }
  const configured = captureRemoteDockerCommand(proxies)
  const configuredEnv = dockerEnv(
    parseRemoteDockerArgs(configured.command, configured.directory).args,
  )
  for (const [name, value] of Object.entries(proxies)) {
    assert.equal(configuredEnv.get(name), value)
  }

  const unset = captureRemoteDockerCommand({
    HTTPS_PROXY: '',
    HTTP_PROXY: '',
    https_proxy: '',
    http_proxy: '',
  })
  const unsetEnv = dockerEnv(parseRemoteDockerArgs(unset.command, unset.directory).args)
  for (const name of Object.keys(proxies)) {
    assert.equal(unsetEnv.has(name), false)
  }
})

test('docker compose passes through upper- and lowercase proxy variables', () => {
  const compose = readFileSync(composeFile, 'utf8')
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy']) {
    assert.match(compose, new RegExp(`^\\s+- ${name}\\s*$`, 'm'))
  }
})
