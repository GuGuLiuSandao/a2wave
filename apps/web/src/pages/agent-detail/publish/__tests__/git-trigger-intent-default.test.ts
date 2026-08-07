/**
 * The prefilled intent is a *template*: it must reach the textarea with its
 * `{{repo}}` / `{{number}}` placeholders intact, because the API substitutes
 * them at trigger time. Those braces are also i18next's interpolation syntax,
 * and it happens to leave a placeholder alone when no matching variable is
 * passed — which is exactly what makes this worth pinning. Nothing in the copy
 * declares the dependency, so an interpolation config change (or a stray
 * variable named `repo`) would blank the placeholders and hand the user a
 * prompt full of holes, with no test failing anywhere near the cause.
 */
import i18n from '@/i18n'
import { GIT_TRIGGER_INTENT_PLACEHOLDERS } from '@a2wave/shared'
import { describe, expect, it } from 'vitest'
import {
  gitTriggerIntentDefaultKey,
  resolveGitTriggerIntentDefault,
} from '../git-trigger-channel-section'

describe('git trigger default intent', () => {
  it('maps each provider to its own copy key', () => {
    expect(gitTriggerIntentDefaultKey('glab')).toBe('agentPublish.glabIntentDefault')
    expect(gitTriggerIntentDefaultKey('gh')).toBe('agentPublish.ghIntentDefault')
  })

  for (const language of ['zh', 'en'] as const) {
    describe(`in ${language}`, () => {
      it('keeps placeholders literal instead of interpolating them away', async () => {
        await i18n.changeLanguage(language)
        const intent = resolveGitTriggerIntentDefault('glab', i18n.t.bind(i18n))
        expect(intent).toContain('{{repo}}')
        expect(intent).toContain('{{number}}')
        expect(intent).toContain('{{url}}')
        expect(intent).not.toContain('{{}}')
      })

      it('uses only placeholders the API knows how to render', async () => {
        await i18n.changeLanguage(language)
        for (const provider of ['glab', 'gh'] as const) {
          const intent = resolveGitTriggerIntentDefault(provider, i18n.t.bind(i18n))
          const used = intent.match(/\{\{[a-z_]+\}\}/g) ?? []
          expect(used.length).toBeGreaterThan(0)
          for (const placeholder of used) {
            expect(GIT_TRIGGER_INTENT_PLACEHOLDERS).toContain(placeholder)
          }
        }
      })

      it('resolves to real copy rather than echoing the key back', async () => {
        await i18n.changeLanguage(language)
        const intent = resolveGitTriggerIntentDefault('gh', i18n.t.bind(i18n))
        expect(intent).not.toContain('agentPublish.')
        expect(intent.length).toBeGreaterThan(20)
      })
    })
  }

  it('differs between the two providers — MR and PR are not interchangeable', async () => {
    await i18n.changeLanguage('en')
    const glab = resolveGitTriggerIntentDefault('glab', i18n.t.bind(i18n))
    const gh = resolveGitTriggerIntentDefault('gh', i18n.t.bind(i18n))
    expect(glab).not.toBe(gh)
    expect(glab).toContain('!{{number}}')
    expect(gh).toContain('#{{number}}')
  })
})
