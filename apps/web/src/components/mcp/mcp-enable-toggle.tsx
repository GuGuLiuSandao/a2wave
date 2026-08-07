import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useUpdateMcpServer } from '@/hooks/use-mcp-servers'
import type { McpServer } from '@a2wave/shared'
import { Tooltip } from 'antd'
import { Cable, Loader2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

type GroupBackends = { backends: Record<string, unknown[]> }

/**
 * A group is enablable once every declared tool set has at least one backend to
 * dispatch to; an empty set would resolve to nothing at call time.
 */
export function canToggleGroup(server: McpServer): boolean {
  if (!server.name?.trim()) return false
  const gc = (server as Record<string, unknown>).groupConfig as GroupBackends | null
  if (!gc || Object.keys(gc.backends).length === 0) return false
  return Object.values(gc.backends).every((backends) => backends.length > 0)
}

interface Props {
  server: McpServer
  /**
   * Whether the saved server has enough config to be enabled. Supplied by the
   * caller because the rule differs by shape: a plain server needs its
   * transport field (command / url), a group needs at least one backend.
   * Defaults to the plain-server rule.
   */
  canToggle?: boolean
}

/**
 * Enable/disable control for a saved MCP server, with its confirmation dialog.
 *
 * Lives outside McpServerForm because it does not touch form state — it acts on
 * the *saved* row and writes immediately, independent of the draft being edited.
 * That lets the modal render it on the title row instead of giving it a row of
 * its own, which left a wide empty band under the title.
 */
export function McpEnableToggle({ server, canToggle: canToggleProp }: Props) {
  const { t } = useTranslation()
  const updateServer = useUpdateMcpServer()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null)

  // A half-configured server would fail on first connect, so it cannot be
  // enabled until the transport it declares actually has its required field.
  const canToggleDefault = useMemo(() => {
    if (!server.name?.trim()) return false
    if (server.type === 'stdio' && !server.command?.trim()) return false
    if ((server.type === 'sse' || server.type === 'http') && !server.url?.trim()) return false
    return true
  }, [server])
  const canToggle = canToggleProp ?? canToggleDefault

  const handleConfirm = async () => {
    if (pendingEnabled === null) return
    try {
      await updateServer.mutateAsync({ id: server.id, isEnabled: pendingEnabled })
      setDialogOpen(false)
      setPendingEnabled(null)
    } catch (error) {
      console.error('Failed to toggle MCP server:', error)
    }
  }

  const control = (
    <div className="flex items-center gap-2">
      <Switch
        checked={server.isEnabled ?? false}
        onCheckedChange={(checked) => {
          setPendingEnabled(checked)
          setDialogOpen(true)
        }}
        disabled={!canToggle}
        aria-label={t('mcpServerDetail.enableSwitchAria')}
      />
      <Badge variant={server.isEnabled ? 'success' : 'outline'}>
        {server.isEnabled ? t('mcpServerDetail.enabled') : t('mcpServerDetail.disabled')}
      </Badge>
    </div>
  )

  return (
    <>
      {/* The "finish configuring first" hint was a line of body text beside the
          switch; as a tooltip on the disabled control it explains the same thing
          without occupying the header row. */}
      {canToggle ? (
        control
      ) : (
        <Tooltip title={t('mcpServerDetail.fillAndSave')} placement="left">
          {control}
        </Tooltip>
      )}

      <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <AlertDialogContent>
          <AlertDialogTitle className="flex items-center gap-2">
            <Cable className="h-5 w-5 text-foreground" aria-hidden="true" />
            {pendingEnabled ? t('mcpServerDetail.enableTitle') : t('mcpServerDetail.disableTitle')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {pendingEnabled ? t('mcpServerDetail.enableDesc') : t('mcpServerDetail.disableDesc')}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t('mcpServerDetail.cancel')}
            </Button>
            <Button onClick={handleConfirm} disabled={updateServer.isPending}>
              {updateServer.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  {t('mcpServerDetail.saving')}
                </>
              ) : (
                t('mcpServerDetail.confirm')
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
