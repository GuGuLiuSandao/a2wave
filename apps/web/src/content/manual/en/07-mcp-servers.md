# MCP Server (Tool Extension)

An MCP Server provides tool capabilities to an Agent via the [Model Context Protocol](https://modelcontextprotocol.io). Once mounted onto an Agent, the Agent can call these tools at runtime — this is the key to "extend through composition": **when you need to call an external system/tool, use MCP rather than hardcoding the logic into the platform**.

## Three Transport Types

An MCP Server connects (transports) in one of three ways:

| Type | Key Fields | Description |
|------|---------|------|
| **stdio** | `command`, `args`, `cwd`, `env` | A local MCP Server launched as a subprocess (must be available on the execution machine) |
| **sse** | `url`, `headers` | Remote Server, Server-Sent Events |
| **http** | `url`, `headers` | Remote Server, Streamable HTTP |

> [!NOTE]
> **A Group is not a transport type — it is a higher-level "aggregation" concept** that composes several existing MCP Servers into one proxy. It therefore has its **own entry point** on the "MCP" page; see "Group (multi-backend aggregation)" below.

## Creating and Mounting

The top-right of the "MCP" page has two entry points, both opening as a modal — fill it in and it is created immediately, with no separate page navigation:

1. **Add MCP** — create a single MCP Server: pick a transport type (stdio / SSE / HTTP) and fill in the connection config (for stdio, the command/args/working directory; for sse/http, the URL and headers).
2. **Add Group** — create an aggregation proxy (see below).

After saving, mount the MCP Server in an Agent's configuration. Click any card in the list to reopen the modal for editing; the card's "more" menu clones or deletes it.

## Probing the Tool List

- When creating/editing, use **probe-tools** to make a temporary connection and preview the tools it exposes, confirming they are correct before saving.
- The **tool list** on the MCP Server detail page shows all currently available tools.

## Private-network MCP endpoints

Platform-originated remote MCP connections validate every redirect and DNS answer and pin the
connection to the validated address. Public endpoints work without extra configuration. To use a
controlled enterprise-private endpoint, configure its exact DNS hostname in
`TRUSTED_MCP_HOSTS` (comma-separated) and restart the API. Schemes, ports, paths, wildcards, and IP
literals are not accepted. Loopback and reserved ranges remain blocked; cloud metadata endpoints
(`169.254.169.254`, `100.100.100.200`, `fd00:ec2::254`, and mapped forms) are hard-blocked even for
an exact trusted hostname.

After upgrading from a version that allowed a private IP or private DNS target, assign that service
a stable DNS hostname and add only that exact hostname to `TRUSTED_MCP_HOSTS`. Tool probing and
inline HTTP/SSE backends in Groups use this protected transport. A remote MCP exported directly to
an underlying third-party Agent CLI is ultimately connected by that CLI; a2wave cannot enforce its
network policy inside an external executable, so apply egress controls to the Agent runtime as well.

Group backend credentials are resolved separately for each actual execution attempt. a2wave creates
one unpredictable private carrier per Group only immediately before the worker starts; the Group
proxy removes it after loading, and the worker performs idempotent cleanup on success, failure,
cancellation, timeout, or startup failure. Diagnostics and configuration previews do not create
these files, and concurrent admin/non-admin runs never share one carrier.

## Group (multi-backend aggregation)

Created via the **Add Group** entry point on the "MCP" page. A Group aggregates multiple backend MCP Servers together and does **progressive disclosure** via a proxy: when enumerating tools, it returns only concise information, and expands a backend's full tool definitions only when the Agent actually needs it, thereby reducing context overhead and improving usability with large tool sets.

Inside a Group, backends are organized as "group key → backend list", where each backend is one of two options:

- **inline**: define a stdio/sse/http backend directly in the modal (with a name and connection fields).
- **ref**: pick an existing MCP Server to reuse from the dropdown selector.

Constraints: group keys and inline backend `name`s may only contain letters/digits/`-`/`_` (**cannot contain `:`**, because tool names use the `backendName:toolName` format); 1–20 backends per group, and inline names are unique within a group.

## Usage Scope (who can mount it)

Every MCP Server has a **usage scope** deciding who may mount it on their own agents:

| Scope | Meaning |
|------|------|
| **Only me** | Only the owner's agents can mount it (default for a user's own sse/http) |
| **Admins only** | Only administrators' agents can mount it (forced for stdio) |
| **All users** | Explicitly shared with everyone; any signed-in user can mount it (**only an admin can set this**) |

Rules:

- **stdio type (and groups with an inline stdio backend) run local commands on the execution machine** — equivalent to host command execution — so they can **only be created by an administrator and are forced to "Admins only" (cannot be widened)**.
- **sse / http (URL-only remote) default to "Only me"** — their URL, headers and environment variables are your private credentials and are never shared implicitly; you can always mount your own.
- **Sharing is an admin action**: only an administrator can set a non-stdio server to "All users" so everyone can mount it (via the "Usage Scope" dropdown on the MCP edit page, visible to admins only). The shared state is persisted and does not change if the owner is later promoted/demoted.

At runtime, ordinary stdio and other admin-only MCP servers are **authorized capabilities of an administrator-owned Agent**. While the Agent owner remains an active administrator, mounted capabilities are available through Web chat debugging, direct Runs, evaluations, Gateway API, OAuth, A2A, native Feishu/Slack/Discord channels, and scheduled invocations. Inline and referenced Group backends follow the same rule. The owner's status is rechecked whenever execution actually starts, so demoting, disabling, or deleting the owner revokes the capability immediately.

The system-provided `a2wave-platform-admin` is the exception. It is a backend control-plane capability available only when the current backend requester is still an active administrator using Web chat debugging, a direct Run, or an evaluation. Gateway API, OAuth, A2A, native chat channels, Chat Page, and scheduled invocations never receive this capability, even when an administrator owns the Agent.

> [!NOTE]
> You can only mount MCP Servers you **own**, or ones an admin has set to "All users". Someone else's "Only me" server (even sse/http) won't appear in your selector and can't be bound; and even for a shared server, the credential fields you see in the list/detail are **masked** (mounting and running are resolved server-side by id, so you never need the raw values).

The platform also has built-in MCPs hidden from ordinary users (e.g. internal routing); the list and selectors filter these out automatically.

## Troubleshooting

| Symptom | Possible Cause | Fix |
|------|---------|------|
| Can't probe tools | Wrong command/URL, missing dependencies | Check command/args or remote reachability |
| stdio fails to start | The execution machine lacks the corresponding command | Install dependencies on the execution machine, or switch to http/sse |
| Tool name conflict | Duplicate inline names within a group, or names contain `:` | Rename, ensuring uniqueness within the group and no `:` |
| Ordinary user can't see / mount a certain MCP | Scoped "Admins only", someone else's "Only me", or a built-in hidden item | Ask an admin to set it to "All users" to share it, or use your own sse/http server |
| Want to share your own MCP with teammates | "All users" can only be set by an admin | Ask an admin to change it to "All users" on the MCP edit page |

## Choosing Between MCP and Skill

- Need to **call an external system/tool** → MCP Server (this chapter).
- Need to **package a reusable workflow or knowledge** → [Skill](/wiki/skills).

## Related

- [Skills](/wiki/skills) · [Agent Management](/wiki/agents) · [Core Concepts & Architecture](/wiki/concepts)
