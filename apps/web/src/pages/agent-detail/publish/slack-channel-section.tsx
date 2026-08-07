/**
 * Publish tab → Slack channel section.
 *
 * Extracted from publish-tab.tsx to keep that file under the 3000-line gate;
 * fully controlled, with all state owned by the parent so `handlePublish` can
 * still assemble one atomic publish payload.
 */
import { Label } from '@/components/ui/label'
import { Checkbox, Radio, Switch } from 'antd'
import { useTranslation } from 'react-i18next'

export type SlackGroupReplyMode = 'thread' | 'new' | 'none'
export type SlackP2pReplyMode = 'new' | 'none'

export interface SlackChannelSectionProps {
  appId: string
  onAppIdChange: (value: string) => void
  appToken: string
  onAppTokenChange: (value: string) => void
  botToken: string
  onBotTokenChange: (value: string) => void
  groupTriggerOnAt: boolean
  onGroupTriggerOnAtChange: (value: boolean) => void
  groupTriggerOnNewMessage: boolean
  onGroupTriggerOnNewMessageChange: (value: boolean) => void
  groupReplyMode: SlackGroupReplyMode
  onGroupReplyModeChange: (value: SlackGroupReplyMode) => void
  p2pReplyMode: SlackP2pReplyMode
  onP2pReplyModeChange: (value: SlackP2pReplyMode) => void
  sendArtifactsAsFile: boolean
  onSendArtifactsAsFileChange: (value: boolean) => void
}

export function SlackChannelSection({
  appId: slackAppId,
  onAppIdChange: setSlackAppId,
  appToken: slackAppToken,
  onAppTokenChange: setSlackAppToken,
  botToken: slackBotToken,
  onBotTokenChange: setSlackBotToken,
  groupTriggerOnAt: slackGroupTriggerOnAt,
  onGroupTriggerOnAtChange: setSlackGroupTriggerOnAt,
  groupTriggerOnNewMessage: slackGroupTriggerOnNewMessage,
  onGroupTriggerOnNewMessageChange: setSlackGroupTriggerOnNewMessage,
  groupReplyMode: slackGroupReplyMode,
  onGroupReplyModeChange: setSlackGroupReplyMode,
  p2pReplyMode: slackP2pReplyMode,
  onP2pReplyModeChange: setSlackP2pReplyMode,
  sendArtifactsAsFile: slackSendArtifactsAsFile,
  onSendArtifactsAsFileChange: setSlackSendArtifactsAsFile,
}: SlackChannelSectionProps) {
  const { t } = useTranslation()

  return (
    <div className="space-y-5">
      <div className="info-panel space-y-3 px-3 py-3 text-sm text-muted-foreground">
        <div className="space-y-1">
          <p className="font-medium text-foreground">{t('agentPublish.slackSetupTitle')}</p>
          <p>{t('agentPublish.slackSetupIntro')}</p>
        </div>

        <div className="space-y-2">
          <div className="rounded-md border border-border/70 bg-background/70 p-3">
            <p className="font-medium text-foreground">{t('agentPublish.slackStepSocketTitle')}</p>
            <p className="mt-1">{t('agentPublish.slackStepSocketDesc')}</p>
          </div>

          <div className="rounded-md border border-border/70 bg-background/70 p-3">
            <p className="font-medium text-foreground">{t('agentPublish.slackStepOauthTitle')}</p>
            <p className="mt-1">{t('agentPublish.slackStepOauthDesc')}</p>
            <div className="mt-2 space-y-1.5 text-xs">
              <p>{t('agentPublish.slackBaseScopes')}</p>
              <div className="flex flex-wrap gap-1.5">
                {['app_mentions:read', 'chat:write', 'im:history', 'files:read', 'files:write'].map(
                  (scope) => (
                    <code key={scope} className="rounded bg-muted px-1.5 py-0.5 text-foreground">
                      {scope}
                    </code>
                  ),
                )}
              </div>
              <p className="pt-1">{t('agentPublish.slackAllMessageScopes')}</p>
              <div className="flex flex-wrap gap-1.5">
                {['channels:history', 'groups:history'].map((scope) => (
                  <code key={scope} className="rounded bg-muted px-1.5 py-0.5 text-foreground">
                    {scope}
                  </code>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-md border border-border/70 bg-background/70 p-3">
            <p className="font-medium text-foreground">{t('agentPublish.slackStepEventsTitle')}</p>
            <p className="mt-1 font-medium text-foreground">
              {t('agentPublish.slackEventsEnable')}
            </p>
            <p className="mt-1">{t('agentPublish.slackEventsRequired')}</p>
            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              {['app_mention', 'message.im'].map((event) => (
                <code
                  key={event}
                  className="rounded bg-primary/10 px-1.5 py-0.5 text-interactive-foreground"
                >
                  {event}
                </code>
              ))}
            </div>
            <p className="mt-2 text-xs">{t('agentPublish.slackEventsOptional')}</p>
            <div className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
              {['message.channels', 'message.groups'].map((event) => (
                <code key={event} className="rounded bg-muted px-1.5 py-0.5 text-foreground">
                  {event}
                </code>
              ))}
            </div>
            <p className="mt-2 text-xs font-medium text-foreground">
              {t('agentPublish.slackEventWarning')}
            </p>
          </div>
        </div>
      </div>

      <Label className="font-semibold">{t('agentPublish.slackCredentialsTitle')}</Label>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label required>{t('agentPublish.slackAppId')}</Label>
          <input
            value={slackAppId}
            onChange={(event) => setSlackAppId(event.target.value)}
            placeholder="A0123456789"
            className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label required>{t('agentPublish.slackAppToken')}</Label>
          <input
            type="password"
            value={slackAppToken}
            onChange={(event) => setSlackAppToken(event.target.value)}
            placeholder="xapp-..."
            className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label required>{t('agentPublish.slackBotToken')}</Label>
        <input
          type="password"
          value={slackBotToken}
          onChange={(event) => setSlackBotToken(event.target.value)}
          placeholder="xoxb-..."
          className="rounded-md border border-border bg-background px-3 py-2 font-mono text-sm outline-none focus:border-primary"
        />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3 rounded-lg bg-muted/40 px-4 py-3">
          <Label className="font-semibold">{t('agentPublish.slackChannelSection')}</Label>
          <div className="flex flex-col gap-1.5">
            <Checkbox
              checked={slackGroupTriggerOnAt}
              onChange={(event) => setSlackGroupTriggerOnAt(event.target.checked)}
            >
              {t('agentPublish.slackTriggerOnMention')}
            </Checkbox>
            <div>
              <Checkbox
                checked={slackGroupTriggerOnNewMessage}
                onChange={(event) => setSlackGroupTriggerOnNewMessage(event.target.checked)}
              >
                {t('agentPublish.slackTriggerOnNewMessage')}
              </Checkbox>
              <p className="mt-1 pl-6 text-xs text-muted-foreground">
                {t('agentPublish.slackTriggerOnNewMessageHint')}
              </p>
            </div>
          </div>
          <Radio.Group
            value={slackGroupReplyMode}
            onChange={(event) => setSlackGroupReplyMode(event.target.value)}
            className="flex flex-col gap-1.5"
          >
            <Radio value="thread">{t('agentPublish.slackReplyThread')}</Radio>
            <Radio value="new">{t('agentPublish.nativeReplyNew')}</Radio>
            <Radio value="none">{t('agentPublish.nativeReplyNone')}</Radio>
          </Radio.Group>
        </div>
        <div className="space-y-3 rounded-lg bg-muted/40 px-4 py-3">
          <Label className="font-semibold">{t('agentPublish.slackDmSection')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('agentPublish.nativeDmAlwaysTriggers')}
          </p>
          <Radio.Group
            value={slackP2pReplyMode}
            onChange={(event) => setSlackP2pReplyMode(event.target.value)}
            className="flex flex-col gap-1.5"
          >
            <Radio value="new">{t('agentPublish.nativeReplyNew')}</Radio>
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
            {t('agentPublish.slackSendArtifactsAsFileHelp')}
          </p>
        </div>
        <Switch checked={slackSendArtifactsAsFile} onChange={setSlackSendArtifactsAsFile} />
      </div>

      <div className="info-panel px-3 py-2.5 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">{t('agentPublish.slackTestTitle')}</p>
        <p className="mt-1">{t('agentPublish.slackTestHelp')}</p>
      </div>
    </div>
  )
}
