# History Search and Advanced Memory Maintenance

Read this reference only when fast recall returns no match or incomplete knowledge, or when the user explicitly asks to update or forget existing memory. Do not open it after a no-match result when the user limited the answer to saved topics and required no guessing or an explicit absence response.

## Memory Layers

| Layer | Content | Disclosure rule |
|------|------|------|
| `MEMORY.md` | Compact Agent Summary, topic catalog, and disclosure guide | Injected at startup; never treat it as the detailed store |
| `memory/topics/*.md` | Bounded reusable knowledge grouped by stable scope | Read one exact topic at a time |
| `memory/topics/archive/*.md` | Inactive retained topics | Do not read by default |
| `memory/YYYY-MM-DD.md`, `memory/weekly/*.md` | Run history and consolidated timelines | Search only for missing knowledge or exact evidence |

## Inspect Topic Metadata or an Exact Dependency

```bash
<memory-topics-command>
<memory-read-topic-command> <topic-id>
```

The topic list contains metadata, never bodies. Exact topic reads consume the Run disclosure budget. Stop when the budget is exhausted.

## Search History

```bash
<memory-search-command> "query keywords"
<memory-search-command> "query keywords" --mode keyword --limit 10
<memory-search-command> --read memory/2026-05-11.md --grep "login issue" -C 8
```

Search active topics before archived topics, weekly summaries, daily logs, and the main catalog. Use `--read` only on a returned file path and prefer `--grep` snippets over whole-file reads.

## Update or Forget Existing Topic Content

1. Read the exact topic once.
2. Produce a complete replacement body beginning with the unchanged `# <title>`.
3. Preserve unrelated sections and server-owned metadata.
4. Replace by stable ID:

```bash
printf '%s' '<complete updated topic body>' | <memory-write-command> --replace <topic-id>
```

Do not reread after a successful response. For a forget request, remove only the requested block. If the same fact is also present in the injected Agent Summary, update `MEMORY.md` separately and report partial failure accurately.

## Legacy Single-File Compatibility

Only when a write reports `LEGACY_SINGLE_FILE`:

1. Read `MEMORY.md`.
2. Add, update, forget, and deduplicate only the explicitly requested content.
3. Write the complete merged file with `<memory-write-command> MEMORY.md`.

Never convert legacy memory implicitly. If any write fails, state that memory was not saved.
