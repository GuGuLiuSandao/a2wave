# Long-Term Memory (Memory)

Long-term memory lets an Agent reuse stable knowledge across sessions without loading its entire history into every Run. Memory belongs to the **Agent**, not to an individual requester: callers who can use the same Agent may benefit from the same memory.

> [!WARNING]
> Do not store requester-private secrets or treat Agent memory as a personal profile. Use an Agent with an appropriate sharing boundary for sensitive knowledge.

## Progressive disclosure

Memory is organized into three layers:

1. **Startup summary and catalog — `MEMORY.md`**: a compact Agent Summary, a deterministic catalog of active topics, and fixed disclosure instructions. When context injection is enabled, only this compact file is added at Run startup.
2. **Bounded topics — `memory/topics/*.md`**: detailed, reusable knowledge grouped by stable scope, such as a repository workflow or an integration contract. The Agent issues one focused recall request, and the server selects and returns only the closest active topic. It reads further only when there is no match or a concrete cross-topic dependency. Inactive topics move to `memory/topics/archive/`.
3. **History — daily and weekly logs**: `memory/YYYY-MM-DD.md` contains Run summaries; older logs may be consolidated into `memory/weekly/*.md`. The Agent searches history when no topic matches, a topic is incomplete, or exact timeline evidence is needed.

The built-in `a2wave-memory` Skill guides the Agent through startup catalog → one-call topic recall → history only when needed. Runtime topic reads are hard-bounded, so the Agent cannot bulk-load every topic into one Run step. When a user restricts the answer to saved topics and says not to guess, a no-match result stops the lookup instead of falling through to history.

## Automatic maintenance

- **At Run startup**: the server validates and deterministically rebuilds the `MEMORY.md` catalog before injection. Topic bodies are never copied into the startup file.
- **After a Run completes**: the platform writes a daily worklog and extracts structured, durable insights in the background without blocking the reply; the Memory tab performs bounded follow-up refreshes during the background completion window. Each queued job freezes only the completed chat turn, so an earlier opt-out does not suppress a later turn and a later message cannot leak into an earlier summary. Matching insights update an existing stable topic; even one reusable item may extend an existing topic when it has one unique, multi-signal match. One shared entity term or a coarse entity-only scope such as a product or repository name still never merges distinct reuse scopes. A new automatic topic requires more than one reusable item; weak or ambiguous candidates remain in Run or worklog history. Before appending, the server conservatively collapses both incoming and pre-existing duplicate facts that differ only in presentation or a small set of equivalent policy modifiers; facts with different objects, values, conditions, or ordering remain separate. Existing custom insight prompts continue to control what qualifies, while the platform appends the Topic V2 structured-output contract; non-conforming output is retained in history instead of being guessed into a topic. If the user says the current turn is temporary or must not be saved to long-term memory, both background outputs are skipped while the Run and audit trail remain available.
- **On an explicit remember request**: adding one memory sends a single scoped remember request. The server atomically selects the topic, deduplicates, writes, and updates the catalog; a successful response is the persistence confirmation, so the Agent does not reread the topic. Only update or forget operations read an exact topic before a replace request. "Explicit" means an imperative request for the memory system to remember, save, add to a memory topic, update, or forget. Merely calling a fact long-term, stable, or fixed, or asking for acknowledgement only, does not authorize a direct conversational write; ordinary durable statements remain eligible for post-Run extraction. Saying not to save the Run disables both direct and background memory persistence. An explicit interactive mutation also bypasses post-Run worklog and insight generation, so its synchronous response is the only persistence outcome. Runtime write capability is scoped from the original user request. The server owns topic IDs, paths, frontmatter, and the main catalog.
- **Daily-to-weekly consolidation** remains available and is independent from topic maintenance.

## Topic limits and reorganization

| Object | Boundary | Behavior at the boundary |
|------|------|------|
| Agent Summary | 500 estimated tokens | Reject the new summary item; never model-compress the whole file |
| Topic catalog | 700 estimated tokens | Archive the least-recently-updated unprotected topic when possible |
| Complete `MEMORY.md` | 1,400 estimated tokens | Reject a non-deterministic or oversized rebuild |
| One topic soft limit | 1,500 estimated tokens | Mark **Reorganization recommended** |
| One topic hard limit | 2,000 estimated tokens | Do not promote the candidate; retain its source in Run/worklog history |
| Active topics | 16 topics and 64 KiB total | Archive an older unprotected topic before adding another |
| Total memory per Agent | 10 MB | Reject the write |
| Daily logs | 200 files | Remove the oldest daily log beyond the cap |

V1 deliberately has **no automatic semantic compression of topic files**. Reaching the soft limit produces a visible warning; reaching the hard limit stops promotion. This avoids silently deleting or rewriting durable knowledge. Editors can archive, reactivate, merge topics, or use the advanced API to split a topic with complete verbatim block coverage. Automatic semantic topic compaction is a separate future capability and requires its own design and approval.

## Legacy `MEMORY.md` migration

An existing Agent whose main file has no managed topic catalog remains in `legacy_single_file` mode. It is never converted implicitly.

Editors migrate it in two steps from the Memory tab:

1. **Preview Topicization** asks the memory model to group source blocks by stable reuse scope. Every source block must be copied verbatim to exactly one proposed topic; coverage is checked before a preview is shown.
2. **Commit Topicization** rechecks that the source file has not changed, saves a rollback backup outside the Agent's indexed memory directory, writes the topic files and deterministic catalog, and rebuilds the index. A failure restores the original file.

Legacy mode retains the previous single-file compatibility behavior until this explicit migration completes, including its old main-file compression path. Topic V2 does not use that compression path.

## Memory tab configuration

| Config | Values | Default | Description |
|------|------|------|------|
| `memoryEnabled` | on/off | off | Master switch; mounts the built-in Skill when enabled |
| `memoryContextMode` | `off` / `memory` | `memory` | Inject the compact startup summary and catalog |
| `memoryRecallLevel` | `weak` / `medium` / `strong` | `medium` | How proactively the Agent starts progressive recall |
| `memoryWorklogEnabled` | on/off | on | Write a daily summary after a Run |
| `memoryAutoInsight` | on/off | on | Route durable post-Run insights into bounded topics |
| `memoryConsolidationEnabled` | on/off | on | Consolidate older daily logs into weekly history |
| `memoryModel` | model name | inherits Agent | Model for worklogs, insight routing, legacy previews, and consolidation |

The Topic Memory area shows metadata in a card grid above without preloading bodies. Selecting one active topic performs an exact read and renders its Markdown in the full-width reader below. Editors can archive or reactivate topics and can preview legacy migration. The raw file browser remains available for inspection and compatible administration, but managed topic metadata and the main catalog are server-owned.

## Search and embeddings

Keyword search works by default. Configure `embeddingEnabled`, `embeddingBaseUrl`, and an Embedding API Key to enable semantic search. Results rank active topics first, followed by archived topics, weekly summaries, daily logs, and the main startup catalog; duplicate snippets are collapsed.

## Deployment reminder

Memory files and indexes are stored under local `./data`. A container deployment must mount it as a persistent volume:

```yaml
volumes:
  - a2wave-data:/app/data   # a2wave.db + memory files + search index
```

## Troubleshooting

| Symptom | Possible cause | Solution |
|------|---------|------|
| The Agent does not remember | `memoryEnabled` is off | Enable Memory on the Agent |
| A topic was not created | The automatic candidate had only one item or hit the hard limit | Check Run/worklog history; use an explicit remember request for one high-value item, or reorganize the topic |
| A topic shows a warning | It passed the 1,500-token soft limit | Reorganize, merge selectively, or archive stale knowledge before it reaches 2,000 tokens |
| Memory disappeared after restart | `./data` is not persistent | Mount the persistent volume |
| Semantic search is unavailable | Embedding settings are incomplete | Configure enabled + Base URL + API Key |
| Legacy topicization is unavailable | The caller has viewer permission or memory is already Topic V2 | Use an owner/editor account, or manage existing topics directly |

## Related

- [Skills](/wiki/skills) (built-in a2wave-memory) · [Knowledge Base](/wiki/knowledge-base) · [Agent Management](/wiki/agents) · [Runs](/wiki/runs)
