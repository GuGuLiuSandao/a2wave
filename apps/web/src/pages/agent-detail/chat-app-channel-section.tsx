/**
 * Publish tab → 对话网页 (chat app) channel section.
 *
 * Extracted from publish-tab.tsx to keep that file under the 3000-line gate; it
 * owns only this channel's presentation config, which is copy — never credentials.
 */
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { CopyButton } from '@/pages/agent-detail/copy-button'
import { CHAT_APP_SUGGESTED_QUESTIONS_MAX } from '@a2wave/shared'
import { Switch } from 'antd'
import { ExternalLink } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export interface ChatAppChannelSectionProps {
  agentId: string | undefined
  chatAppUrl: string
  displayName: string
  onDisplayNameChange: (value: string) => void
  welcomeMessage: string
  onWelcomeMessageChange: (value: string) => void
  suggestedQuestions: string
  onSuggestedQuestionsChange: (value: string) => void
  showCreator: boolean
  onShowCreatorChange: (value: boolean) => void
  allowAttachments: boolean
  onAllowAttachmentsChange: (value: boolean) => void
  showThinking: boolean
  onShowThinkingChange: (value: boolean) => void
}

export function ChatAppChannelSection({
  agentId,
  chatAppUrl,
  displayName: chatAppDisplayName,
  onDisplayNameChange: setChatAppDisplayName,
  welcomeMessage: chatAppWelcomeMessage,
  onWelcomeMessageChange: setChatAppWelcomeMessage,
  suggestedQuestions: chatAppSuggestedQuestions,
  onSuggestedQuestionsChange: setChatAppSuggestedQuestions,
  showCreator: chatAppShowCreator,
  onShowCreatorChange: setChatAppShowCreator,
  allowAttachments: chatAppAllowAttachments,
  onAllowAttachmentsChange: setChatAppAllowAttachments,
  showThinking: chatAppShowThinking,
  onShowThinkingChange: setChatAppShowThinking,
}: ChatAppChannelSectionProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-5">
      {agentId ? (
        <div className="flex flex-col gap-2">
          <Label className="text-sm font-medium text-foreground">
            {t('agentPublish.chatAppLink')}
          </Label>
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-sm">
            <code className="flex-1 truncate">{chatAppUrl}</code>
            <CopyButton text={chatAppUrl} label={t('agentPublish.copyEndpoint')} />
            <span className="flex items-center border-l border-border pl-2">
              <a
                href={chatAppUrl}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t('agentPublish.chatAppOpen')}
                title={t('agentPublish.chatAppOpen')}
                className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
              >
                <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{t('agentPublish.chatAppLinkHelp')}</p>
        </div>
      ) : (
        <div className="info-panel px-3 py-2.5 text-sm text-muted-foreground">
          {t('agentPublish.chatAppLinkAfterSave')}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Label className="text-sm font-medium text-foreground">
          {t('agentPublish.chatAppDisplayName')}
        </Label>
        <input
          value={chatAppDisplayName}
          onChange={(event) => setChatAppDisplayName(event.target.value.slice(0, 100))}
          placeholder={t('agentPublish.chatAppDisplayNamePlaceholder')}
          className="rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label className="text-sm font-medium text-foreground">
          {t('agentPublish.chatAppWelcomeMessage')}
        </Label>
        <Textarea
          value={chatAppWelcomeMessage}
          onChange={(event) => setChatAppWelcomeMessage(event.target.value.slice(0, 5000))}
          placeholder={t('agentPublish.chatAppWelcomeMessagePlaceholder')}
          rows={3}
          className="resize-none text-sm"
        />
        <p className="text-xs text-muted-foreground">
          {t('agentPublish.chatAppWelcomeMessageHelp')}
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label className="text-sm font-medium text-foreground">
          {t('agentPublish.chatAppSuggestedQuestions')}
        </Label>
        <Textarea
          value={chatAppSuggestedQuestions}
          onChange={(event) => setChatAppSuggestedQuestions(event.target.value)}
          placeholder={t('agentPublish.chatAppSuggestedQuestionsPlaceholder')}
          rows={4}
          className="resize-none text-sm"
        />
        <p className="text-xs text-muted-foreground">
          {t('agentPublish.chatAppSuggestedQuestionsHelp', {
            max: CHAT_APP_SUGGESTED_QUESTIONS_MAX,
          })}
        </p>
      </div>

      <div className="space-y-3 rounded-lg bg-muted/40 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">{t('agentPublish.chatAppShowCreator')}</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('agentPublish.chatAppShowCreatorHelp')}
            </p>
          </div>
          <Switch checked={chatAppShowCreator} onChange={setChatAppShowCreator} />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">
              {t('agentPublish.chatAppAllowAttachments')}
            </Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('agentPublish.chatAppAllowAttachmentsHelp')}
            </p>
          </div>
          <Switch checked={chatAppAllowAttachments} onChange={setChatAppAllowAttachments} />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">{t('agentPublish.chatAppShowThinking')}</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('agentPublish.chatAppShowThinkingHelp')}
            </p>
          </div>
          <Switch checked={chatAppShowThinking} onChange={setChatAppShowThinking} />
        </div>
      </div>

      <div className="info-panel space-y-1 px-3 py-2.5 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{t('agentPublish.chatAppAccessTitle')}</p>
        <p>{t('agentPublish.chatAppAccessHelp')}</p>
      </div>
    </div>
  )
}
