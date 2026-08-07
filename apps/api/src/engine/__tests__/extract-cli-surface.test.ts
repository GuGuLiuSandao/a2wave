import { describe, expect, it } from 'vitest'
import { extractCliSurface } from './helpers/extract-cli-surface.js'

const surfaceOf = (source: string) => extractCliSurface(source, 'fixture.ts').surface

describe('extractCliSurface', () => {
  it('pairs a flag with a static value and leaves a dynamic value bare', () => {
    const source = `
      class E {
        private buildArgs(prompt: string, model: string): string[] {
          const args = ['-p', prompt, '--output-format', 'stream-json']
          if (model) args.push('--model', model)
          return args
        }
      }
    `
    expect(surfaceOf(source)).toEqual(['--model', '--output-format=stream-json', '-p'])
  })

  it('does not pair two adjacent flags', () => {
    const source = `
      class E {
        private buildArgs(): string[] {
          return ['--json', '--skip-git-repo-check']
        }
      }
    `
    expect(surfaceOf(source)).toEqual(['--json', '--skip-git-repo-check'])
  })

  it('records subcommands passed to a spawn helper', () => {
    const source = `
      class E {
        async probe() {
          return runStatusProbe(this.config.path, ['provider', 'list', '--json'], { logTag: 'k' })
        }
      }
    `
    expect(surfaceOf(source)).toEqual(['--json', 'list', 'provider'])
  })

  it('resolves an argv variable assembled across conditional branches', () => {
    const source = `
      class E {
        async listAvailableModels(options: { authMode: string }) {
          const args = ['--list-models']
          if (options.authMode === 'apiKey') {
            args.push('--config-dir', dir)
          }
          return runStatusProbe(this.config.path, args, { logTag: 'q' })
        }
      }
    `
    expect(surfaceOf(source)).toEqual(['--config-dir', '--list-models'])
  })

  it('renders template values with a ${} placeholder', () => {
    const source = `
      class E {
        private buildArgs(minutes: number, model: string): string[] {
          const args: string[] = []
          args.push('-c', \`model.name=\${model}\`)
          args.push('--query-timeout', \`\${minutes}m\`)
          return args
        }
      }
    `
    expect(surfaceOf(source)).toEqual(['--query-timeout=${}m', '-c=model.name=${}'])
  })

  it('captures literals pinned at the args-builder call site', () => {
    const source = `
      class E {
        async execute() {
          const args = this.buildArgs(prompt, model, 'stream-json', chatId)
        }
        private buildArgs(p: string, m: string, format: string): string[] {
          return ['--output-format', format]
        }
      }
    `
    expect(surfaceOf(source)).toEqual(['--output-format', 'stream-json'])
  })

  it('ignores flag arrays that never reach the Provider CLI', () => {
    const source = `
      function filterArgs(args: string[]): string[] {
        return stripPromptArg(args, ['-p', '--append-system-prompt'])
      }
      function readKeychain() {
        return execFileSync('security', ['find-generic-password', '-s', 'name', '-w'])
      }
    `
    const result = extractCliSurface(source, 'fixture.ts')
    expect(result.surface).toEqual([])
    expect(result.unclassifiedFlags).toEqual(['--append-system-prompt', '-p', '-s', '-w'])
  })

  it('does not report a flag as unclassified when it also reaches the CLI', () => {
    const source = `
      function filterArgs(args: string[]): string[] {
        return stripPromptArg(args, ['-p'])
      }
      class E {
        private buildArgs(prompt: string): string[] {
          return ['-p', prompt]
        }
      }
    `
    expect(extractCliSurface(source, 'fixture.ts').unclassifiedFlags).toEqual([])
  })

  it('throws rather than skip an argv expression it cannot resolve', () => {
    const source = `
      class E {
        async probe() {
          return runStatusProbe(this.config.path, buildProbeArgv(), {})
        }
      }
    `
    expect(() => extractCliSurface(source, 'fixture.ts')).toThrow(/Unsupported argv expression/)
  })
})
