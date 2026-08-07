# apps/web — Agent Guide

React 19 + Vite + TailwindCSS v4 + Ant Design (antd v6) frontend application. See the root [AGENTS.md](../../AGENTS.md) for global conventions.

## Directory Structure

```
src/
├── components/ui/   # UI components (antd wrappers + pure React)
├── hooks/           # TanStack Query hooks
├── lib/             # Utilities (api client, utils)
├── locales/         # i18n localization files
├── pages/           # Page components
├── styles/          # CSS/style files
├── app.tsx          # Route entry + antd ConfigProvider global theme
├── i18n.ts          # i18n configuration
└── main.tsx         # React entry point
```

## UI Component System

### Component Sources

| Component | Implementation | Notes |
|------|----------|------|
| Button | CVA + pure React | Supports `asChild`, built-in variant/size |
| Dialog | antd `Modal` wrapper | Composable API: `Dialog` + `DialogContent` + `DialogHeader`, etc. |
| AlertDialog | antd `Modal` wrapper | Same pattern as Dialog |
| Switch | antd `Switch` wrapper | Maps `onCheckedChange` → antd `onChange` |
| Popover | Pure React + `createPortal` | Custom positioning / click-outside / Escape handling |
| Command | Pure React + Context | Search filtering + Combobox pattern support |
| Tabs | Pure React + Context | Composable API: `Tabs` + `TabsList` + `TabsTrigger` + `TabsContent` |
| Badge, Card, Input, Label, Skeleton, Textarea | Pure Tailwind components | No external dependencies |

### antd Global Theme

The active `ThemeDefinition` comes from [`src/lib/themes.ts`](src/lib/themes.ts). `createAntdTheme()` in [`src/lib/tokens.ts`](src/lib/tokens.ts) derives an Ant Design config from that active theme; do not duplicate inline tokens in business code or pin a subtree to Wave Light.

In `app.tsx`:

```tsx
import { createAntdTheme } from './lib/tokens'

const antdTheme = useMemo(() => createAntdTheme(resolvedTheme), [resolvedTheme])

<ConfigProvider theme={antdTheme} locale={antdLocale}>
```

For details, see the root [docs/agent/design-tokens.md](../../docs/agent/design-tokens.md).

### Internationalization (i18n)

Uses **react-i18next**; copy lives in `src/locales/zh.json` and `en.json`, and **key sets must stay aligned**. Use `useTranslation().t(...)` inside components; the `ConfigProvider` `locale` switches with `i18n.language` (see `app.tsx`). When changing navigation or user-visible copy, update the E2E tests and `e2e/utils/test-constants.ts` accordingly.

Full conventions: [docs/agent/i18n.md](../../docs/agent/i18n.md).

### Forbidden Dependencies

- `@radix-ui/*` — fully removed and replaced
- `cmdk` — replaced by the pure React Command component
- `shadcn/ui` CLI — no longer used; all components are maintained manually

### Feedback APIs (message / notification / modal)

**Never `import { message } from 'antd'`.** Always use the bridge:

```tsx
import { message, modal, notification } from '@/lib/antd-static'
```

antd's *static* instances render outside the React tree, so they escape
`<StyleProvider layer>` and inject an **unlayered** antd reset. Unlayered CSS
always outranks layered CSS, so the global `a` reset repaints every sidebar
`<Link>` link-blue — a page-wide regression with no visible connection to the
call site, appearing only after the first toast fires. Enforced by arch gate R8.

This applies to static calls only. The `<Modal>` / `<Select>` **components**
render in-tree and are imported from `'antd'` as usual; `Modal.confirm(...)` is
the static form and must use `modal.confirm(...)` instead.

### Dropdown Selection

Use the antd **`Select`** component for all dropdown selection. A native `<select>` is
**forbidden** — it renders the OS-level dropdown, which ignores the design tokens and
looks foreign next to every other control:

```tsx
import { Select } from 'antd'

<Select
  className="w-full"
  value={value || undefined}
  onChange={onChange}
  placeholder={t('…')}
  options={options.map((opt) => ({ value: opt.id, label: opt.name }))}
/>
```

Use `placeholder` for the empty state; never model it as a sentinel `<option value="">`
row. Pass `undefined` (not `''`) as the empty value so the placeholder shows.

The **Combobox pattern** (`Popover` + `Command`) is reserved for the one case antd
`Select` handles poorly: a long option list needing search filtering with custom result
rendering. For a short, fixed set of options, use `Select`.

```tsx
<Popover>
  <PopoverTrigger asChild>
    <Button variant="outline" role="combobox" className="w-full justify-between font-normal">
      {selectedLabel || 'Select…'}
      <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
    </Button>
  </PopoverTrigger>
  <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
    <Command>
      <CommandInput placeholder="Search…" />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        <CommandGroup>
          {options.map((opt) => (
            <CommandItem key={opt.value} value={opt.label} onSelect={() => onChange(opt.value)}>
              <Check className={cn('mr-2 h-4 w-4', value === opt.value ? 'opacity-100' : 'opacity-0')} />
              {opt.label}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  </PopoverContent>
</Popover>
```

## Testing Conventions

Framework: **Vitest + @testing-library/react**; test files go in `src/**/__tests__/`.

| Command | Description |
|------|------|
| `pnpm test` | Run all unit tests (CI gate) |
| `pnpm test:watch` | Watch mode for development |

### Coverage Requirements

- `src/lib/` utility functions: 100% coverage
- Key page components (CRUD flows): covered by React Testing Library tests
- When adding a page, add route coverage in `e2e/tests/smoke/critical-paths.spec.ts`
- Run `pnpm test` locally before committing; zero failures required

## Documentation Sync

| Change Type | Update Required |
|----------|--------|
| New page route | Root `AGENTS.md` |
| New/changed core concept | Root `AGENTS.md` Core Concepts |
| Core business rule change | Root `PRODUCT.md` |
| Design tokens / theme colors aligned with antd | `docs/agent/design-tokens.md` (if a new convention is introduced) |
| Copy and i18n workflow | `docs/agent/i18n.md` (if a new convention is introduced) |
