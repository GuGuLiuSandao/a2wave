import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { useUpdateAgent } from '@/hooks/use-agents'
import { formatApiError } from '@/lib/api-error'
import type { ArtifactPolicy } from '@a2wave/shared'
import { App, Select } from 'antd'
import { Globe, Timer } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'

interface ArtifactsTabProps {
  agentId: string | undefined
  artifactPolicy?: ArtifactPolicy | null
}

export function ArtifactsTab({ agentId, artifactPolicy }: ArtifactsTabProps) {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const updateAgent = useUpdateAgent()

  const [autoShare, setAutoShare] = useState(artifactPolicy?.autoShare === 'on')
  const [shareAccessLevel, setShareAccessLevel] = useState<'authenticated' | 'public'>(
    artifactPolicy?.shareAccessLevel ?? 'authenticated',
  )
  const [shareExpiryDays, setShareExpiryDays] = useState(artifactPolicy?.shareExpiryDays ?? 7)

  useEffect(() => {
    setAutoShare(artifactPolicy?.autoShare === 'on')
    setShareAccessLevel(artifactPolicy?.shareAccessLevel ?? 'authenticated')
    setShareExpiryDays(artifactPolicy?.shareExpiryDays ?? 7)
  }, [artifactPolicy])

  const handleSave = () => {
    if (!agentId) return
    const policy: ArtifactPolicy = {
      autoShare: autoShare ? 'on' : 'off',
      shareAccessLevel,
      shareExpiryDays,
    }
    updateAgent.mutate(
      { id: agentId, artifactPolicy: policy },
      {
        onSuccess: () => message.success(t('agentDetail.artifactsSaveSuccess')),
        onError: (error) => message.error(formatApiError(error, t)),
      },
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('agentDetail.tabArtifacts')}</CardTitle>
        <CardDescription>{t('agentDetail.artifactsAutoShareDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <div className="divide-y divide-border/50">
          {/* Auto-share toggle */}
          <div className="flex items-center justify-between gap-8 px-6 py-5">
            <div className="space-y-1 min-w-0 flex-1">
              <Label className="flex items-center gap-1.5 text-sm font-medium">
                <Globe className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                {t('agentDetail.artifactsAutoShare')}
              </Label>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t('agentDetail.artifactsAutoShareDesc')}
              </p>
            </div>
            <Switch checked={autoShare} onCheckedChange={setAutoShare} />
          </div>

          {/* Access level */}
          <div className="flex items-start justify-between gap-8 px-6 py-5">
            <div className="space-y-1 min-w-0 flex-1">
              <Label
                htmlFor="artifactShareAccessLevel"
                className="flex items-center gap-1.5 text-sm font-medium"
              >
                {t('agentDetail.artifactsShareAccessLevel')}
              </Label>
              <p className="text-xs text-muted-foreground leading-relaxed">
                <Trans
                  i18nKey="agentDetail.artifactsShareAccessLevelDesc"
                  components={{
                    strong: <strong className="font-medium text-foreground" />,
                    br: <br />,
                  }}
                />
              </p>
            </div>
            <Select<'authenticated' | 'public'>
              id="artifactShareAccessLevel"
              disabled={!autoShare}
              value={shareAccessLevel}
              onChange={(value) => setShareAccessLevel(value)}
              className="w-44 shrink-0 [&_.ant-select-selector]:!min-h-9"
              popupMatchSelectWidth
              getPopupContainer={(trigger) => trigger.parentElement || document.body}
              options={[
                { value: 'authenticated', label: t('artifacts.share.accessAuthenticated') },
                { value: 'public', label: t('artifacts.share.accessPublic') },
              ]}
            />
          </div>

          {/* Expiry days */}
          <div className="flex items-start justify-between gap-8 px-6 py-5">
            <div className="space-y-1 min-w-0 flex-1">
              <Label
                htmlFor="artifactShareExpiryDays"
                className="flex items-center gap-1.5 text-sm font-medium"
              >
                <Timer className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                {t('agentDetail.artifactsShareExpiryDays')}
              </Label>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {t('agentDetail.artifactsShareExpiryDaysDesc')}
              </p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <Input
                id="artifactShareExpiryDays"
                type="number"
                min={1}
                max={365}
                disabled={!autoShare}
                className="w-24 disabled:opacity-50"
                value={shareExpiryDays}
                onChange={(e) => {
                  const v = Number(e.target.value)
                  if (v >= 1 && v <= 365) setShareExpiryDays(v)
                }}
              />
              <span className="text-sm text-muted-foreground">{t('common.days')}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end px-6 py-4 border-t border-border/50">
          <Button
            type="button"
            size="sm"
            disabled={updateAgent.isPending || !agentId}
            onClick={handleSave}
          >
            {t('common.save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
