import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EntityFormGate } from '@/components/ui/entity-form-gate'
import { useMcpServer } from '@/hooks/use-mcp-servers'
import { useTranslation } from 'react-i18next'
import { McpEnableToggle } from './mcp-enable-toggle'
import { McpServerForm } from './mcp-server-form'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** undefined = create mode; a value = edit mode */
  serverId?: string
}

/** Modal shell hosting the plain MCP server (stdio | SSE | HTTP) create/edit form. */
export function McpServerFormModal({ open, onOpenChange, serverId }: Props) {
  const { t } = useTranslation()
  // Only fetch the title source while open, so a closed modal doesn't keep a
  // stale request tied to its last serverId (empty id disables the query).
  const { data: server, isPending, error } = useMcpServer(open ? (serverId ?? '') : '')
  const title = serverId
    ? (server?.name ?? t('mcpServerDetail.newServer'))
    : t('mcpServerDetail.newServer')

  return (
    <Dialog open={open} onOpenChange={onOpenChange} width={760} scrollBody>
      <DialogContent>
        <DialogHeader>
          {/* Title and enable toggle share one row. The toggle used to sit on
              its own right-aligned row inside the form, leaving a wide empty
              band between the title and the first section. */}
          <div className="flex items-center justify-between gap-4 pr-8">
            <DialogTitle className="truncate">{title}</DialogTitle>
            {server && <McpEnableToggle server={server} />}
          </div>
        </DialogHeader>
        {/* The form owns its own layout: the save bar stays pinned while only the
            body scrolls. We just bound the height here (70vh). */}
        <div className="mt-4 max-h-[70vh]">
          {/* In edit mode the form must not mount until the server has loaded — a
              blank form is submittable and would wipe transport config and env. */}
          <EntityFormGate
            isEditMode={!!serverId}
            isOpen={open}
            isLoading={isPending}
            error={error}
            entity={server}
          >
            {/* Remount the form per target so create/edit state never leaks between opens */}
            <McpServerForm
              key={serverId ?? 'new'}
              serverId={serverId}
              onSaved={() => onOpenChange(false)}
            />
          </EntityFormGate>
        </div>
      </DialogContent>
    </Dialog>
  )
}
