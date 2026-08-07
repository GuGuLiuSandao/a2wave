import {
  type CompletionContext,
  type CompletionResult,
  autocompletion,
} from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { Compartment, EditorState, RangeSetBuilder, StateField } from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  placeholder as phPlugin,
} from '@codemirror/view'
import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'

interface PromptEditorProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  envKeys: string[]
  /**
   * Minimum editor height. Defaults to the system-prompt size, which is the
   * whole page there; a prompt sitting inside a scrolling dialog alongside
   * other fields needs to be shorter or it pushes everything else out of view.
   */
  minHeightClassName?: string
}

const BUILTIN_VARS = ['message', 'context', 'model', 'agent_provider']
const VAR_PATTERN = /\{\{\s*(\w+)\s*\}\}/g

// ── Decoration marks ──

const definedVarMark = Decoration.mark({ class: 'cm-template-var-defined' })
const undefinedVarMark = Decoration.mark({ class: 'cm-template-var-undefined' })

function computeDecorations(state: EditorState, definedSet: Set<string>): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const doc = state.doc.toString()

  const regex = new RegExp(VAR_PATTERN.source, 'g')
  let match: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
  while ((match = regex.exec(doc)) !== null) {
    const name = match[1]
    const from = match.index
    const to = from + match[0].length
    const mark = definedSet.has(name) ? definedVarMark : undefinedVarMark
    builder.add(from, to, mark)
  }

  return builder.finish()
}

function createHighlightField(definedSet: Set<string>) {
  return StateField.define<DecorationSet>({
    create(state) {
      return computeDecorations(state, definedSet)
    },
    update(_, tr) {
      return computeDecorations(tr.state, definedSet)
    },
    provide: (f) => EditorView.decorations.from(f),
  })
}

// ── Autocomplete ──

function createCompletionSource(envKeys: string[], t: (key: string) => string) {
  return (ctx: CompletionContext): CompletionResult | null => {
    const word = ctx.matchBefore(/\{\{\s*\w*/)
    if (!word) return null

    const builtinLabel = t('agentDetail.templateVarBuiltin')
    const envLabel = t('agentDetail.templateVarEnv')

    const options = [
      ...BUILTIN_VARS.map((v) => ({
        label: v,
        detail: builtinLabel,
        apply: `{{${v}}}`,
        type: 'variable' as const,
        boost: 10,
      })),
      ...envKeys.map((k) => ({
        label: k,
        detail: envLabel,
        apply: `{{${k}}}`,
        type: 'variable' as const,
        boost: 5,
      })),
    ]

    return { from: word.from, options, filter: true }
  }
}

// ── Theme ──

const editorTheme = EditorView.theme({
  '&': {
    fontSize: '13px',
    fontFamily:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    // 上限高度，超出即由 .cm-scroller 纵向滚动（CM 惯用做法，与容器 max-h 双保险）。
    maxHeight: '480px',
    backgroundColor: 'var(--color-code-background)',
    color: 'var(--color-code-foreground)',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  '.cm-content': {
    padding: '8px 0',
    caretColor: 'var(--color-foreground)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--color-code-background)',
    color: 'var(--color-muted-foreground)',
    borderRightColor: 'var(--color-code-border)',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'var(--color-surface-hover)',
  },
  /**
   * Selection.
   *
   * The `color` is as load-bearing as the background. The global `::selection`
   * rule in globals.css pairs `--color-primary` with `--color-primary-foreground`
   * (white); overriding only the background here left white text sitting on a
   * pale tint at 1.26:1 — legible as neither text nor selection, which is what
   * made a selected prompt look washed out rather than highlighted. Pinning the
   * code foreground alongside it restores ~7.8:1.
   */
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--color-code-selection) !important',
    color: 'var(--color-code-foreground) !important',
  },
  '.cm-line': {
    padding: '0 12px',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--color-foreground)',
  },
  '.cm-template-var-defined': {
    backgroundColor: 'var(--color-primary-subtle)',
    color: 'var(--color-code-variable)',
    borderRadius: '3px',
    padding: '1px 0',
  },
  '.cm-template-var-undefined': {
    backgroundColor: 'var(--color-warning-subtle)',
    color: 'var(--color-warning)',
    borderRadius: '3px',
    padding: '1px 0',
  },
})

export function PromptEditor({
  value,
  onChange,
  placeholder,
  envKeys,
  minHeightClassName = '[&_.cm-editor]:min-h-[240px]',
}: PromptEditorProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // Track whether the change came from inside the editor (user typing)
  const internalChangeRef = useRef(false)

  // Compartment for dynamic extensions (envKeys-dependent)
  const compartmentRef = useRef(new Compartment())

  const definedSet = useMemo(() => new Set([...BUILTIN_VARS, ...envKeys]), [envKeys])

  // Build the dynamic extensions that depend on envKeys
  const dynamicExtensions = useMemo(
    () => [
      createHighlightField(definedSet),
      autocompletion({
        override: [createCompletionSource(envKeys, t)],
        activateOnTyping: true,
      }),
    ],
    [definedSet, envKeys, t],
  )

  // Create editor once on mount
  // biome-ignore lint/correctness/useExhaustiveDependencies: editor is created once; later changes to value/placeholder/dynamicExtensions are pushed via separate effects below
  useEffect(() => {
    if (!containerRef.current) return

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        internalChangeRef.current = true
        onChangeRef.current(update.state.doc.toString())
      }
    })

    const state = EditorState.create({
      doc: value,
      extensions: [
        editorTheme,
        compartmentRef.current.of(dynamicExtensions),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        history(),
        EditorView.lineWrapping,
        updateListener,
        ...(placeholder ? [phPlugin(placeholder)] : []),
      ],
    })

    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Sync external value changes (e.g. form reset) WITHOUT double-dispatch
  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    // Skip if this value update was triggered by the editor itself
    if (internalChangeRef.current) {
      internalChangeRef.current = false
      return
    }

    const currentDoc = view.state.doc.toString()
    if (value !== currentDoc) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: value },
      })
    }
  }, [value])

  // Reconfigure dynamic extensions when envKeys changes
  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    view.dispatch({
      effects: compartmentRef.current.reconfigure(dynamicExtensions),
    })
  }, [dynamicExtensions])

  return (
    <div
      ref={containerRef}
      // 至少 240px 保证可编辑感；上限 480px 由 editorTheme 的 maxHeight 控制，超出后 .cm-scroller
      // 内部滚动，避免长提示词把表单无限撑高。overflow-hidden 让圆角裁剪滚动内容。
      className={`rounded-md border border-input overflow-hidden ${minHeightClassName}`}
    />
  )
}
