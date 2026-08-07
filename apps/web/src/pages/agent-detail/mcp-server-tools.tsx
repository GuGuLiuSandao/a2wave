import { useMcpServerTools } from '@/hooks/use-mcp-servers'
import { Tooltip } from 'antd'
import { AlertTriangle, Layers, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'

interface McpServerToolsProps {
  server: { id: string; name: string; type: string }
}

/**
 * Whether `<McpServerTools>` renders anything for this server type. stdio
 * servers expose no tool list, so callers must use this to decide whether to
 * draw a surrounding container — otherwise the container's border shows up as
 * a stray rule with nothing under it.
 */
export function mcpServerHasToolPreview(type: string) {
  return type === 'sse' || type === 'http' || type === 'group'
}

export function McpServerTools({ server }: McpServerToolsProps) {
  const { t } = useTranslation()
  const isRemote = server.type === 'sse' || server.type === 'http'
  const isGroup = server.type === 'group'
  const { data: tools, isLoading, isError } = useMcpServerTools(server.id, isRemote)

  if (!mcpServerHasToolPreview(server.type)) return null

  if (isGroup) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-2">
          <Layers className="h-3 w-3 text-muted-foreground" />
          <span className="text-xs font-medium text-muted-foreground">{server.name}</span>
          <span className="text-2xs text-muted-foreground tabular-nums">
            4 {t('mcpServerDetail.metaTools')}
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {['list_groups', 'list_tools', 'get_tool_schema', 'call_tool'].map((name) => (
            <span
              key={name}
              className="inline-flex items-center rounded-md border border-border bg-muted/30 px-2 py-0.5 font-mono text-xs cursor-default"
            >
              {name}
            </span>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">{server.name}</span>
        {tools && tools.length > 0 && (
          <span className="text-2xs text-muted-foreground tabular-nums">
            {t('agentDetail.mcpToolsCount', { count: tools.length })}
          </span>
        )}
      </div>

      {isLoading && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          {t('agentDetail.mcpToolsLoading')}
        </div>
      )}

      {isError && !isLoading && (
        <div className="flex items-center gap-1.5 text-xs text-destructive">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          {t('agentDetail.mcpToolsError')}
        </div>
      )}

      {tools && tools.length === 0 && (
        <p className="rounded-md border border-dashed border-border/50 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {t('agentDetail.mcpToolsEmpty')}
        </p>
      )}

      {tools && tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tools.map((tool) => (
            <Tooltip key={tool.name} title={tool.description} placement="top">
              <span className="inline-flex items-center rounded-md border border-border bg-muted/30 px-2 py-0.5 font-mono text-xs cursor-default hover:bg-surface-hover transition-colors">
                {tool.name}
              </span>
            </Tooltip>
          ))}
        </div>
      )}
    </div>
  )
}
