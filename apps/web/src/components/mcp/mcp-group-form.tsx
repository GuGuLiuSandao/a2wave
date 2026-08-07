import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { useCurrentUser } from '@/hooks/use-auth'
import {
  useCreateMcpServer,
  useMcpServer,
  useMcpServerTools,
  useMcpServers,
  useProbeTools,
  useUpdateMcpServer,
} from '@/hooks/use-mcp-servers'
import { cn } from '@/lib/utils'
import type { GroupBackend, GroupConfig } from '@a2wave/shared'
import { ADMIN_MCP_NAMES, INTERNAL_MCP_NAMES } from '@a2wave/shared'
import { zodResolver } from '@hookform/resolvers/zod'
import { Segmented, Select, Tooltip } from 'antd'
import {
  AlertTriangle,
  Check,
  ChevronsUpDown,
  Loader2,
  Minus,
  Plus,
  RefreshCw,
  Save,
  X,
  Zap,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { useTranslation } from 'react-i18next'
import {
  type McpFormData,
  ProbeResultDisplay,
  createMcpServerFormSchema,
  introducesStdio,
} from './mcp-form-shared'

interface Props {
  /** undefined = create mode; a value = edit mode */
  serverId?: string
  /** Called after a successful create or update. */
  onSaved: () => void
}

/** Create/edit form for an MCP Group (a proxy over multiple backend servers). */
export function McpGroupForm({ serverId, onSaved }: Props) {
  const { t, i18n: i18nInstance } = useTranslation()
  const language = i18nInstance.language
  const formSchema = useMemo(() => createMcpServerFormSchema(language), [language])
  const isCreateMode = !serverId
  const { data: server } = useMcpServer(serverId ?? '')
  const createServer = useCreateMcpServer()
  const updateServer = useUpdateMcpServer()
  const isSaving = isCreateMode ? createServer.isPending : updateServer.isPending

  const { data: allServersResult } = useMcpServers({ pageSize: 100 })
  const { data: currentUser } = useCurrentUser()
  const isAdmin = currentUser?.role === 'admin'
  const refCandidates = useMemo(() => {
    // The server already scopes the list to what this caller may reference (own
    // rows + shared 'all-users' + builtins), so we do NOT re-filter by usageScope
    // here. Just drop groups, internal, and self.
    return (
      allServersResult?.data?.filter(
        (s) =>
          s.type !== 'group' &&
          !INTERNAL_MCP_NAMES.has(s.name) &&
          (!ADMIN_MCP_NAMES.has(s.name) || isAdmin) &&
          s.id !== serverId,
      ) ?? []
    )
  }, [allServersResult, isAdmin, serverId])
  const [newGroupKey, setNewGroupKey] = useState('')
  const [activeGroupTab, setActiveGroupTab] = useState<string>('')
  const probeTools = useProbeTools()
  const [probeTargetIdx, setProbeTargetIdx] = useState<number | null>(null)
  const [probeResults, setProbeResults] = useState<
    Map<number, { tools?: { name: string; description?: string }[]; error?: string }>
  >(new Map())

  const {
    handleSubmit,
    reset,
    register,
    setValue,
    watch,
    formState: { isDirty, errors },
  } = useForm<McpFormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      description: '',
      type: 'group',
      command: '',
      args: [],
      cwd: '',
      url: '',
      headers: {},
      env: {},
      groupConfig: { backends: {} },
      isEnabled: false,
      usageScope: 'private',
    },
  })

  useEffect(() => {
    if (server) {
      const gc = (server as Record<string, unknown>).groupConfig as GroupConfig | null
      reset({
        name: server.name,
        description: server.description ?? '',
        type: 'group',
        command: '',
        args: [],
        cwd: '',
        url: '',
        headers: {},
        env: {},
        groupConfig: gc ?? { backends: {} },
        isEnabled: server.isEnabled,
        usageScope: server.usageScope ?? 'private',
      })
      if (gc && Object.keys(gc.backends).length > 0) {
        setActiveGroupTab(Object.keys(gc.backends)[0])
      }
    }
  }, [server, reset])

  const groupConfig = watch('groupConfig')

  // New-group-key validation: surface WHY the "+" is disabled instead of a
  // silent no-op. Empty is not an error (nothing typed yet); an invalid pattern
  // (e.g. Chinese chars) or a duplicate key gets an inline message.
  const groupKeyTrimmed = newGroupKey.trim()
  const groupKeyError = !groupKeyTrimmed
    ? null
    : !/^[a-zA-Z0-9_-]+$/.test(groupKeyTrimmed)
      ? t('mcpServerDetail.groupKeyPattern')
      : groupConfig?.backends?.[groupKeyTrimmed]
        ? t('mcpServerDetail.groupKeyDuplicate')
        : null
  const canAddGroupKey = !!groupKeyTrimmed && !groupKeyError

  const addGroupKey = () => {
    if (!canAddGroupKey) return
    const next = { ...groupConfig?.backends, [groupKeyTrimmed]: [] }
    setValue('groupConfig', { backends: next }, { shouldDirty: true })
    setActiveGroupTab(groupKeyTrimmed)
    setNewGroupKey('')
  }

  // Group meta-tools are static (no outbound call), so any viewer may see them.
  const toolsEnabled = !isCreateMode
  const {
    data: tools,
    isLoading: toolsLoading,
    error: toolsError,
    refetch: refetchTools,
    isFetching: toolsFetching,
  } = useMcpServerTools(serverId ?? '', toolsEnabled)

  const onSubmit = async (data: McpFormData) => {
    if (isCreateMode) {
      try {
        await createServer.mutateAsync({
          name: data.name,
          type: 'group',
          description: data.description || undefined,
          groupConfig: data.groupConfig,
          usageScope: isAdmin ? data.usageScope : undefined,
        } as never)
        onSaved()
      } catch (error) {
        console.error('Failed to create MCP group:', error)
      }
      return
    }
    if (!serverId) return
    try {
      await updateServer.mutateAsync({
        id: serverId,
        name: data.name,
        description: data.description || null,
        type: 'group',
        command: null,
        args: [],
        cwd: null,
        url: null,
        headers: null,
        env: null,
        groupConfig: data.groupConfig,
        usageScope: isAdmin ? data.usageScope : undefined,
      } as never)
      onSaved()
    } catch (error) {
      console.error('Failed to update MCP group:', error)
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex max-h-[70vh] flex-col">
      {/* Scroll region — only the body scrolls; the save bar stays pinned. -mr-5
          pr-5 keeps the scrollbar at the modal's edge; min-h keeps a stable height. */}
      <div className="min-h-0 flex-1 overflow-y-auto -mr-5 pr-5">
        <div className="min-h-[24rem] space-y-6">
          {/* Basic Information */}
          <section className="space-y-4">
            <h3 className="text-base font-semibold text-foreground">
              {t('mcpServerDetail.basicInfo')}
            </h3>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="group-name" className="text-sm" required>
                  {t('mcpServerDetail.name')}
                </Label>
                <Input
                  id="group-name"
                  {...register('name')}
                  placeholder={t('mcpServerDetail.namePlaceholder')}
                  aria-invalid={!!errors.name}
                />
                {errors.name && <p className="text-xs text-destructive">{errors.name.message}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="group-description" className="text-sm">
                  {t('mcpServerDetail.description')}
                </Label>
                <Textarea
                  id="group-description"
                  {...register('description')}
                  placeholder={t('mcpServerDetail.descriptionPlaceholder')}
                  rows={2}
                />
              </div>
              {/* Usage scope — admin-only control. A group with any inline stdio backend
              introduces host execution and is therefore locked to admin-only. */}
              {isAdmin &&
                (() => {
                  const isStdioType = introducesStdio('group', watch('groupConfig') ?? null)
                  const currentScope = watch('usageScope')
                  const options = isStdioType
                    ? [{ value: 'admin-only', label: t('mcpServerDetail.usageScopeAdminOnly') }]
                    : [
                        { value: 'private', label: t('mcpServerDetail.usageScopePrivate') },
                        { value: 'all-users', label: t('mcpServerDetail.usageScopeAllUsers') },
                        ...(currentScope === 'admin-only'
                          ? [
                              {
                                value: 'admin-only',
                                label: t('mcpServerDetail.usageScopeAdminOnly'),
                              },
                            ]
                          : []),
                      ]
                  return (
                    <div className="space-y-1.5">
                      <Label className="text-sm">{t('mcpServerDetail.usageScope')}</Label>
                      <Select
                        className="w-full"
                        value={isStdioType ? 'admin-only' : currentScope}
                        disabled={isStdioType}
                        onChange={(v) =>
                          setValue('usageScope', v as 'private' | 'admin-only' | 'all-users', {
                            shouldDirty: true,
                          })
                        }
                        options={options}
                      />
                      <p className="text-xs text-muted-foreground">
                        {isStdioType
                          ? t('mcpServerDetail.usageScopeStdioHint')
                          : t('mcpServerDetail.usageScopeHint')}
                      </p>
                    </div>
                  )
                })()}
            </div>
          </section>

          {/* Group Configuration */}
          <section className="space-y-4">
            <div className="space-y-1">
              <h3 className="text-base font-semibold text-foreground">
                {t('mcpServerDetail.groupConfig')}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t('mcpServerDetail.groupConfigDesc')}
              </p>
              {errors.groupConfig && (
                <p className="mt-2 text-xs text-destructive">{errors.groupConfig.message}</p>
              )}
            </div>
            <div className="space-y-4">
              {/* Group Key tabs */}
              <div className="flex items-center gap-2 flex-wrap">
                {Object.keys(groupConfig?.backends ?? {}).map((gk) => (
                  <button
                    key={gk}
                    type="button"
                    className={cn(
                      'px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
                      activeGroupTab === gk
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground hover:text-foreground',
                    )}
                    onClick={() => setActiveGroupTab(gk)}
                  >
                    {gk}
                    <span
                      // biome-ignore lint/a11y/useSemanticElements: this remove affordance sits
                      // inside the group-key tab <button>, and nesting a button inside a button
                      // is invalid HTML — hence a span with role="button" and its own key handler.
                      role="button"
                      tabIndex={0}
                      className="ml-1.5 hover:text-destructive inline-flex"
                      onClick={(e) => {
                        e.stopPropagation()
                        const next = { ...groupConfig?.backends }
                        delete next[gk]
                        setValue('groupConfig', { backends: next }, { shouldDirty: true })
                        const keys = Object.keys(next)
                        if (activeGroupTab === gk) setActiveGroupTab(keys[0] ?? '')
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          e.stopPropagation()
                          const next = { ...groupConfig?.backends }
                          delete next[gk]
                          setValue('groupConfig', { backends: next }, { shouldDirty: true })
                          const keys = Object.keys(next)
                          if (activeGroupTab === gk) setActiveGroupTab(keys[0] ?? '')
                        }
                      }}
                      aria-label={t('mcpServerDetail.removeGroupKeyAria', { key: gk })}
                    >
                      <X className="h-3 w-3" />
                    </span>
                  </button>
                ))}
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-1">
                    <Input
                      value={newGroupKey}
                      onChange={(e) => setNewGroupKey(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          if (canAddGroupKey) addGroupKey()
                        }
                      }}
                      placeholder={t('mcpServerDetail.addGroupKey')}
                      aria-invalid={!!groupKeyError}
                      className="w-32 h-8 text-sm"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="size-8"
                      disabled={!canAddGroupKey}
                      onClick={addGroupKey}
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {groupKeyError && <p className="text-xs text-destructive">{groupKeyError}</p>}
                </div>
              </div>

              {/* Backend list for active group key */}
              {activeGroupTab && groupConfig?.backends?.[activeGroupTab] !== undefined && (
                <div className="space-y-3 border-t border-border pt-3">
                  <div className="flex items-center justify-between">
                    <Label className="text-sm font-medium">{t('mcpServerDetail.backends')}</Label>
                    <div className="flex items-center gap-1">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => {
                          const backends = [...(groupConfig.backends[activeGroupTab] ?? [])]
                          backends.push({
                            mode: 'inline',
                            name: '',
                            type: 'stdio',
                          } as GroupBackend)
                          setValue(
                            'groupConfig',
                            {
                              backends: { ...groupConfig.backends, [activeGroupTab]: backends },
                            },
                            { shouldDirty: true },
                          )
                        }}
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        {t('mcpServerDetail.addInline')}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => {
                          const backends = [...(groupConfig.backends[activeGroupTab] ?? [])]
                          backends.push({
                            mode: 'ref',
                            mcpServerId: '',
                          } as GroupBackend)
                          setValue(
                            'groupConfig',
                            {
                              backends: { ...groupConfig.backends, [activeGroupTab]: backends },
                            },
                            { shouldDirty: true },
                          )
                        }}
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        {t('mcpServerDetail.addRef')}
                      </Button>
                    </div>
                  </div>

                  {(groupConfig.backends[activeGroupTab] ?? []).length === 0 && (
                    <p className="rounded-md border border-dashed border-border/50 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                      {t('mcpServerDetail.noBackends')}
                    </p>
                  )}

                  {(groupConfig.backends[activeGroupTab] ?? []).map((backend, idx) => (
                    <div
                      key={`${idx}-${backend.mode === 'inline' ? (backend.name ?? '') : (backend.mcpServerId ?? '')}`}
                      className="rounded-lg border border-border p-3 space-y-3"
                    >
                      <div className="flex items-center justify-between">
                        <Badge variant="outline" className="text-xs">
                          {backend.mode === 'inline'
                            ? t('mcpServerDetail.backendModeInline')
                            : t('mcpServerDetail.backendModeRef')}
                        </Badge>
                        <button
                          type="button"
                          className="flex size-6 items-center justify-center rounded-md hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                          onClick={() => {
                            const backends = [...(groupConfig.backends[activeGroupTab] ?? [])]
                            backends.splice(idx, 1)
                            setValue(
                              'groupConfig',
                              {
                                backends: { ...groupConfig.backends, [activeGroupTab]: backends },
                              },
                              { shouldDirty: true },
                            )
                            setProbeResults(new Map())
                          }}
                          aria-label={t('mcpServerDetail.removeBackendAria')}
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </button>
                      </div>

                      {backend.mode === 'inline' && (
                        <div className="space-y-2">
                          <div className="grid gap-2 grid-cols-2">
                            <div className="space-y-1">
                              <Label className="text-xs" required>
                                {t('mcpServerDetail.backendName')}
                              </Label>
                              <Input
                                value={((backend as Record<string, unknown>).name as string) ?? ''}
                                onChange={(e) => {
                                  const backends = [...(groupConfig.backends[activeGroupTab] ?? [])]
                                  backends[idx] = {
                                    ...backend,
                                    name: e.target.value,
                                  } as GroupBackend
                                  setValue(
                                    'groupConfig',
                                    {
                                      backends: {
                                        ...groupConfig.backends,
                                        [activeGroupTab]: backends,
                                      },
                                    },
                                    { shouldDirty: true },
                                  )
                                }}
                                placeholder={t('mcpServerDetail.backendNamePlaceholder')}
                                className="text-sm h-8"
                              />
                            </div>
                            <div className="space-y-1">
                              <Label className="text-xs">{t('mcpServerDetail.backendType')}</Label>
                              <Segmented
                                block
                                size="small"
                                value={(backend as Record<string, unknown>).type as string}
                                onChange={(bt) => {
                                  const backends = [...(groupConfig.backends[activeGroupTab] ?? [])]
                                  backends[idx] = { ...backend, type: bt } as GroupBackend
                                  setValue(
                                    'groupConfig',
                                    {
                                      backends: {
                                        ...groupConfig.backends,
                                        [activeGroupTab]: backends,
                                      },
                                    },
                                    { shouldDirty: true },
                                  )
                                }}
                                options={['stdio', 'sse', 'http']}
                              />
                            </div>
                          </div>
                          {(backend as Record<string, unknown>).type === 'stdio' && (
                            <div className="grid gap-2 grid-cols-2">
                              <div className="space-y-1">
                                <Label className="text-xs" required>
                                  {t('mcpServerDetail.command')}
                                </Label>
                                <Input
                                  value={
                                    ((backend as Record<string, unknown>).command as string) ?? ''
                                  }
                                  onChange={(e) => {
                                    const backends = [
                                      ...(groupConfig.backends[activeGroupTab] ?? []),
                                    ]
                                    backends[idx] = {
                                      ...backend,
                                      command: e.target.value,
                                    } as GroupBackend
                                    setValue(
                                      'groupConfig',
                                      {
                                        backends: {
                                          ...groupConfig.backends,
                                          [activeGroupTab]: backends,
                                        },
                                      },
                                      { shouldDirty: true },
                                    )
                                  }}
                                  placeholder={t('mcpServerDetail.commandPlaceholder')}
                                  className="font-mono text-xs h-8"
                                />
                              </div>
                              <div className="space-y-1">
                                <Label className="text-xs">{t('mcpServerDetail.arguments')}</Label>
                                <Input
                                  value={(
                                    ((backend as Record<string, unknown>).args as string[]) ?? []
                                  ).join(' ')}
                                  onChange={(e) => {
                                    const backends = [
                                      ...(groupConfig.backends[activeGroupTab] ?? []),
                                    ]
                                    backends[idx] = {
                                      ...backend,
                                      args: e.target.value.split(/\s+/).filter(Boolean),
                                    } as GroupBackend
                                    setValue(
                                      'groupConfig',
                                      {
                                        backends: {
                                          ...groupConfig.backends,
                                          [activeGroupTab]: backends,
                                        },
                                      },
                                      { shouldDirty: true },
                                    )
                                  }}
                                  placeholder={t('mcpServerDetail.argPlaceholder')}
                                  className="font-mono text-xs h-8"
                                />
                              </div>
                            </div>
                          )}
                          {((backend as Record<string, unknown>).type === 'sse' ||
                            (backend as Record<string, unknown>).type === 'http') && (
                            <>
                              <div className="space-y-1">
                                <Label className="text-xs" required>
                                  {t('mcpServerDetail.serverUrl')}
                                </Label>
                                <Input
                                  value={((backend as Record<string, unknown>).url as string) ?? ''}
                                  onChange={(e) => {
                                    const backends = [
                                      ...(groupConfig.backends[activeGroupTab] ?? []),
                                    ]
                                    backends[idx] = {
                                      ...backend,
                                      url: e.target.value,
                                    } as GroupBackend
                                    setValue(
                                      'groupConfig',
                                      {
                                        backends: {
                                          ...groupConfig.backends,
                                          [activeGroupTab]: backends,
                                        },
                                      },
                                      { shouldDirty: true },
                                    )
                                  }}
                                  placeholder={t('mcpServerDetail.urlPlaceholder')}
                                  className="font-mono text-xs h-8"
                                />
                              </div>
                              <div className="space-y-1">
                                <Label className="text-xs">{t('mcpServerDetail.headers')}</Label>
                                <Input
                                  value={(() => {
                                    const h = (backend as Record<string, unknown>).headers as
                                      | Record<string, string>
                                      | null
                                      | undefined
                                    return h && Object.keys(h).length > 0 ? JSON.stringify(h) : ''
                                  })()}
                                  onChange={(e) => {
                                    const backends = [
                                      ...(groupConfig.backends[activeGroupTab] ?? []),
                                    ]
                                    let parsed: Record<string, string> | null = null
                                    try {
                                      parsed = e.target.value.trim()
                                        ? JSON.parse(e.target.value)
                                        : null
                                    } catch {
                                      /* keep typing */
                                    }
                                    backends[idx] = { ...backend, headers: parsed } as GroupBackend
                                    setValue(
                                      'groupConfig',
                                      {
                                        backends: {
                                          ...groupConfig.backends,
                                          [activeGroupTab]: backends,
                                        },
                                      },
                                      { shouldDirty: true },
                                    )
                                  }}
                                  placeholder='{"Authorization": "Bearer ..."}'
                                  className="font-mono text-xs h-8"
                                />
                              </div>
                            </>
                          )}
                          {/* Probe tools button */}
                          <div className="flex items-center gap-2 pt-1">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              disabled={probeTools.isPending && probeTargetIdx === idx}
                              onClick={() => {
                                const b = backend as Record<string, unknown>
                                const bType = (b.type as string) ?? 'stdio'
                                setProbeTargetIdx(idx)
                                probeTools.mutate(
                                  {
                                    type: bType as 'stdio' | 'sse' | 'http',
                                    command: (b.command as string) ?? undefined,
                                    args: (b.args as string[]) ?? undefined,
                                    url: (b.url as string) ?? undefined,
                                    headers: (b.headers as Record<string, string>) ?? undefined,
                                    env: (b.env as Record<string, string>) ?? undefined,
                                  },
                                  {
                                    onSuccess: (res) => {
                                      setProbeResults((prev) =>
                                        new Map(prev).set(idx, { tools: res.data.tools }),
                                      )
                                      setProbeTargetIdx(null)
                                    },
                                    onError: (err) => {
                                      setProbeResults((prev) =>
                                        new Map(prev).set(idx, { error: err.message }),
                                      )
                                      setProbeTargetIdx(null)
                                    },
                                  },
                                )
                              }}
                            >
                              {probeTools.isPending && probeTargetIdx === idx ? (
                                <Loader2 className="h-3 w-3 animate-spin mr-1" />
                              ) : (
                                <Zap className="h-3 w-3 mr-1" />
                              )}
                              {t('mcpServerDetail.probeTools')}
                            </Button>
                            {probeResults.get(idx)?.tools && (
                              <span className="text-xs text-muted-foreground">
                                {t('mcpServerDetail.toolsCount', {
                                  count: probeResults.get(idx)?.tools?.length ?? 0,
                                })}
                              </span>
                            )}
                          </div>
                          <ProbeResultDisplay result={probeResults.get(idx) ?? null} />
                        </div>
                      )}

                      {backend.mode === 'ref' && (
                        <div className="space-y-1">
                          <Label className="text-xs" required>
                            {t('mcpServerDetail.refServer')}
                          </Label>
                          <Popover>
                            <PopoverTrigger asChild>
                              <Button
                                variant="outline"
                                // biome-ignore lint/a11y/useSemanticElements: the searchable
                                // Combobox pattern (Popover + Command) needs a button trigger with
                                // custom result rendering; a native <select> cannot provide it.
                                role="combobox"
                                className="w-full justify-between font-normal"
                              >
                                {(() => {
                                  const selectedId = (backend as Record<string, unknown>)
                                    .mcpServerId as string
                                  const selected = refCandidates.find((s) => s.id === selectedId)
                                  return selected
                                    ? `${selected.name} (${selected.type})`
                                    : t('mcpServerDetail.refServerPlaceholder')
                                })()}
                                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                              </Button>
                            </PopoverTrigger>
                            <PopoverContent
                              className="w-[--radix-popover-trigger-width] p-0"
                              align="start"
                              contentZIndex={1100}
                            >
                              <Command>
                                <CommandInput
                                  placeholder={t('mcpServerDetail.searchServersPlaceholder')}
                                  className="h-8"
                                />
                                <CommandList>
                                  <CommandEmpty>{t('mcpServerDetail.noServersFound')}</CommandEmpty>
                                  <CommandGroup>
                                    {refCandidates.map((s) => (
                                      <CommandItem
                                        key={s.id}
                                        value={`${s.name} (${s.type})`}
                                        onSelect={() => {
                                          const backends = [
                                            ...(groupConfig.backends[activeGroupTab] ?? []),
                                          ]
                                          backends[idx] = {
                                            mode: 'ref',
                                            mcpServerId: s.id,
                                          } as GroupBackend
                                          setValue(
                                            'groupConfig',
                                            {
                                              backends: {
                                                ...groupConfig.backends,
                                                [activeGroupTab]: backends,
                                              },
                                            },
                                            { shouldDirty: true },
                                          )
                                        }}
                                      >
                                        <Check
                                          className={cn(
                                            'mr-2 h-4 w-4',
                                            (backend as Record<string, unknown>).mcpServerId ===
                                              s.id
                                              ? 'opacity-100'
                                              : 'opacity-0',
                                          )}
                                        />
                                        {s.name} ({s.type})
                                      </CommandItem>
                                    ))}
                                  </CommandGroup>
                                </CommandList>
                              </Command>
                            </PopoverContent>
                          </Popover>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Available Tools */}
          {toolsEnabled && (
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <h3 className="text-base font-semibold text-foreground">
                    {t('mcpServerDetail.tools')}
                  </h3>
                  <p className="text-sm text-muted-foreground">{t('mcpServerDetail.toolsDesc')}</p>
                </div>
                <div className="flex items-center gap-2">
                  {tools && tools.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {t('mcpServerDetail.toolsCount', { count: tools.length })}
                    </span>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8"
                    onClick={() => refetchTools()}
                    disabled={toolsFetching}
                    aria-label={t('mcpServerDetail.toolsRefresh')}
                  >
                    <RefreshCw className={cn('h-3.5 w-3.5', toolsFetching && 'animate-spin')} />
                  </Button>
                </div>
              </div>
              <div>
                {(toolsLoading || toolsFetching) && !tools && (
                  <div className="flex items-center gap-2 info-panel px-3 py-2.5 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                    {t('mcpServerDetail.toolsLoading')}
                  </div>
                )}
                {toolsError && !toolsFetching && (
                  <div className="flex items-center gap-2 info-panel px-3 py-2.5 text-sm text-destructive">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    <span>
                      {t('mcpServerDetail.toolsError')}
                      {toolsError.message && !toolsError.message.startsWith('HTTP_')
                        ? `: ${toolsError.message}`
                        : ''}
                    </span>
                  </div>
                )}
                {tools && tools.length === 0 && (
                  <p className="rounded-md border border-dashed border-border/50 bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
                    {t('mcpServerDetail.toolsEmpty')}
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
            </section>
          )}
        </div>
      </div>

      {/* Pinned save bar */}
      <div className="mt-3 flex shrink-0 items-center justify-end border-t border-border/60 pt-3">
        <Button type="submit" disabled={isCreateMode ? isSaving : !isDirty || isSaving}>
          {isSaving ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              {isCreateMode ? t('mcpServerDetail.creating') : t('mcpServerDetail.saving')}
            </>
          ) : (
            <>
              <Save className="h-4 w-4" aria-hidden="true" />
              {isCreateMode ? t('mcpServerDetail.createGroup') : t('mcpServerDetail.saveChanges')}
            </>
          )}
        </Button>
      </div>
    </form>
  )
}
