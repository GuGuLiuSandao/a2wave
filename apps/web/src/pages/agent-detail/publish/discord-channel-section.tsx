/**
 * Publish tab → Discord channel section.
 *
 * Extracted from publish-tab.tsx to keep that file under the 3000-line gate;
 * fully controlled, with all state owned by the parent so `handlePublish` can
 * still assemble one atomic publish payload.
 */
import { Label } from '@/components/ui/label'
import { Checkbox, Radio, Switch } from 'antd'
import { useTranslation } from 'react-i18next'

export type DiscordGuildReplyMode = 'reply' | 'new' | 'none'
export type DiscordDmReplyMode = 'reply' | 'none'

export interface DiscordChannelSectionProps {
  applicationId: string
  onApplicationIdChange: (value: string) => void
  botToken: string
  onBotTokenChange: (value: string) => void
  guildTriggerOnMention: boolean
  onGuildTriggerOnMentionChange: (value: boolean) => void
  guildTriggerOnNewMessage: boolean
  onGuildTriggerOnNewMessageChange: (value: boolean) => void
  guildReplyMode: DiscordGuildReplyMode
  onGuildReplyModeChange: (value: DiscordGuildReplyMode) => void
  dmReplyMode: DiscordDmReplyMode
  onDmReplyModeChange: (value: DiscordDmReplyMode) => void
  sendArtifactsAsFile: boolean
  onSendArtifactsAsFileChange: (value: boolean) => void
}

export function DiscordChannelSection({
  applicationId: discordApplicationId,
  onApplicationIdChange: setDiscordApplicationId,
  botToken: discordBotToken,
  onBotTokenChange: setDiscordBotToken,
  guildTriggerOnMention: discordGuildTriggerOnMention,
  onGuildTriggerOnMentionChange: setDiscordGuildTriggerOnMention,
  guildTriggerOnNewMessage: discordGuildTriggerOnNewMessage,
  onGuildTriggerOnNewMessageChange: setDiscordGuildTriggerOnNewMessage,
  guildReplyMode: discordGuildReplyMode,
  onGuildReplyModeChange: setDiscordGuildReplyMode,
  dmReplyMode: discordDmReplyMode,
  onDmReplyModeChange: setDiscordDmReplyMode,
  sendArtifactsAsFile: discordSendArtifactsAsFile,
  onSendArtifactsAsFileChange: setDiscordSendArtifactsAsFile,
}: DiscordChannelSectionProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-5">
      <div className="info-panel space-y-1 px-3 py-2.5 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{t('agentPublish.discordSetupTitle')}</p>
        <p>{t('agentPublish.discordSetupHelp')}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label required>{t('agentPublish.discordApplicationId')}</Label>
          <input
            value={discordApplicationId}
            onChange={(event) => setDiscordApplicationId(event.target.value)}
            placeholder="123456789012345678"
            className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label required>{t('agentPublish.discordBotToken')}</Label>
          <input
            type="password"
            value={discordBotToken}
            onChange={(event) => setDiscordBotToken(event.target.value)}
            placeholder={t('agentPublish.discordBotTokenPlaceholder')}
            className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
          />
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3 rounded-lg bg-muted/40 px-4 py-3">
          <Label className="font-semibold">{t('agentPublish.discordGuildSection')}</Label>
          <div className="flex flex-col gap-1.5">
            <Checkbox
              checked={discordGuildTriggerOnMention}
              onChange={(event) => setDiscordGuildTriggerOnMention(event.target.checked)}
            >
              {t('agentPublish.discordTriggerOnMention')}
            </Checkbox>
            <div>
              <Checkbox
                checked={discordGuildTriggerOnNewMessage}
                onChange={(event) => setDiscordGuildTriggerOnNewMessage(event.target.checked)}
              >
                {t('agentPublish.discordTriggerOnNewMessage')}
              </Checkbox>
              <p className="mt-1 pl-6 text-xs text-muted-foreground">
                {t('agentPublish.discordTriggerOnNewMessageHint')}
              </p>
            </div>
          </div>
          <Radio.Group
            value={discordGuildReplyMode}
            onChange={(event) => setDiscordGuildReplyMode(event.target.value)}
            className="flex flex-col gap-1.5"
          >
            <Radio value="reply">{t('agentPublish.discordReply')}</Radio>
            <Radio value="new">{t('agentPublish.nativeReplyNew')}</Radio>
            <Radio value="none">{t('agentPublish.nativeReplyNone')}</Radio>
          </Radio.Group>
        </div>
        <div className="space-y-3 rounded-lg bg-muted/40 px-4 py-3">
          <Label className="font-semibold">{t('agentPublish.discordDmSection')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('agentPublish.nativeDmAlwaysTriggers')}
          </p>
          <Radio.Group
            value={discordDmReplyMode}
            onChange={(event) => setDiscordDmReplyMode(event.target.value)}
            className="flex flex-col gap-1.5"
          >
            <Radio value="reply">{t('agentPublish.discordReply')}</Radio>
            <Radio value="none">{t('agentPublish.nativeReplyNone')}</Radio>
          </Radio.Group>
        </div>
      </div>

      <div className="flex items-center justify-between rounded-lg bg-muted/40 px-4 py-3">
        <div>
          <Label className="text-sm font-medium">
            {t('agentPublish.nativeSendArtifactsAsFile')}
          </Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t('agentPublish.discordSendArtifactsAsFileHelp')}
          </p>
        </div>
        <Switch checked={discordSendArtifactsAsFile} onChange={setDiscordSendArtifactsAsFile} />
      </div>
    </div>
  )
}
