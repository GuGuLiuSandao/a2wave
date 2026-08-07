# 🚀 a2wave: Next-Generation Natural-Language-Driven Agent Engine (Agent Workflow)

**a2wave** is an "Agent workflow platform" that goes beyond traditional low-code workflows (such as Dify). Built on the **A2A (Agent-to-Agent)** protocol and **heterogeneous execution capabilities**, it aims to turn complex business logic into natural collaboration between agents.

---

## 1. Core Product Positioning
Unlike "drag-and-drop" pipeline tools, **a2wave** is an **ocean of agents**.
* **From Flow to Wave:** Tasks are no longer rigid linear flows, but the ripple and resonance of intent across the Agent network.
* **From plugins to roles:** Nodes are no longer a single API interface, but **digital workers** with a "brain, hands and feet, and a toolbox".

> **Foundational assumption — a trusted internal team.** a2wave is an Agent
> platform for **internal enterprise teams**. It assumes that **both Agent authors
> and Agent users are trusted colleagues, working in good faith to raise their
> productivity**. This is why the platform gives Agents genuine execution power and
> composes capability freely, rather than sandboxing authors against one another:
> its guardrails (auth, per-Agent permissions, audit, rate limiting) enforce
> accountability and least privilege among cooperating teammates, not defense
> against a malicious insider. Exposing a2wave to untrusted users is outside the
> current design and requires an added isolation layer.

---

## 2. Three Core Pillars

### 🌊 A2A Protocol Bus (Agent-to-Agent Protocol)
* **Intent alignment:** Nodes communicate via the Google A2A standard, achieving a semantic-level "handshake" without manual variable mapping.
* **Dynamic orchestration:** The system automatically finds and triggers Agents with the corresponding capabilities based on task intent, enabling "wireless" collaboration.
* **Enterprise-network first:** Remote A2A routes support ordinary private-network targets by default. Operators may explicitly select public-only routing, while every mode retains protocol validation, per-hop DNS pinning, redirect checks, and hard blocks for metadata and other forbidden address ranges.

### 💻 Heterogeneous Execution Kernel (Hybrid Agent Engine)
* **Execution power:** Deeply integrates the **Cursor Agent CLI** philosophy, supporting Agents capable of local filesystem read/write, Shell execution, and code self-repair.
* **Multi-engine adaptation:** Uniformly wraps `LLM+MCP`, `Cursor CLI`, `Claude Code`, `OpenAI Codex CLI`, `OpenCode CLI`, `Qoder CLI`, `Trae CLI`, `Kimi Code CLI`, `Pi CLI`, and `Custom Scripts`, enabling Agents of different schools to collaborate within the same sandbox environment.

### 🎨 Natural Language Incubator (NL Incubator)
* **Guided creation:** Define an Agent's "personality", tool permissions, and execution boundaries through conversation.
* **One-click publishing (Broadcasting):** Once created, an Agent can be published as a standard service, seamlessly callable by platform-wide workflows via the A2A protocol.

---

## 3. Typical Use Cases (User Stories)

### Success Stories

> a2wave has successfully proven its core value in the following scenarios, serving as a **natural-language-driven alternative** to traditional CI tools like Jenkins and greatly reducing configuration complexity.

#### Code Q&A
- **Combination**: SCM Source + Cursor Agent
- **Flow**: An external system submits a code question via the Gateway API → the Agent analyzes the code in the SCM working directory → returns the answer synchronously
- **Value**: Simplifies what was once a complex pipeline script into a single Agent's prompt configuration.

#### Code Review
- **Combination**: SCM Source + Cursor Agent + MCP Server
- **Flow**: The CI system triggers a review via the Gateway API → the Agent analyzes the changes → completes the comments via MCP tools (such as Feishu/GitLab) → returns the result synchronously.
- **Value**: Natural-language-driven review logic, with no need to write lengthy pipeline code.

### 🛠️ Future Exploration

#### Scenario A: Code-Level Troubleshooting
> **Story:** Anomalies detected in SLS logs -> automatically pull the code -> use the Cursor engine to compare and analyze -> output a fix patch.

#### Scenario B: Intelligent Loop over Bitable
> **Story:** Read Bitable data -> automatically write a Python script for analysis -> write the results back to the table.

---

## 4. a2wave vs Traditional Workflows

| Dimension | Traditional Workflow (e.g. Dify) | a2wave (next-generation) |
| :--- | :--- | :--- |
| **Logic construction** | Manually configure connections and variable mapping | **Natural-language guided connections** |
| **Execution engine** | Static API or code blocks | **Autonomous Agent (Cursor-like execution power)** |
| **Error handling** | Errors out and interrupts the flow | **Agent self-reflection and code-level self-healing** |
| **Data flow** | Strict variable passing | **Contextual resonance in a shared environment** |
| **Extensibility** | Relies on platform preset plugins | **Publishing heterogeneous Agents that follow the A2A protocol** |

---

## 5. Roadmap

### Phase 0 — Foundation Validation (Completed ✅)
> **Goal:** Get a single-Agent end-to-end loop working, validating Cursor Agent as an execution kernel.

* **Agent runtime**: Based on Cursor Agent, implements file read/write, Shell execution, and code self-repair.
* **Skills management**: Supports a SKILL.md-format skill library, with ZIP upload and automatic mounting. Skills are creator-private by default; only administrators may publish a reviewed common Skill to all signed-in users.
* **SCM Source**: Supports P4 and Git, with automatic code sync and Agent working-directory binding.
* **MCP Servers**: Supports stdio, SSE, streamable HTTP, and progressive-disclosure Groups. Generic stdio and other administrator-bound MCP capabilities remain usable through every approved publish channel while the Agent owner is still an active administrator; the system `a2wave-platform-admin` builtin stays restricted to explicitly authenticated backend-administrator control-plane execution.
* **Gateway & A2A**: Initial implementation of the API Gateway and A2A protocol integration.

### Phase 1 — Multi-Agent Collaboration (In Progress 🚧)
> **Goal:** Enable intent communication and dynamic orchestration between Agents.

* **A2A protocol bus rollout**: Refine the Agent Card publishing and discovery mechanism.
* **Orchestration engine**: A Router Agent dispatches tasks automatically based on intent.
* **Shared sandbox environment**: Multiple Agents collaborate in the same sandbox.
* **Evaluation ✅**: Curated multi-turn conversation sets replayed against an Agent's current config, each run freezing a provider/model/prompt snapshot so users can tell which configuration performs best. Verdicts are manual today; automatic LLM-judged scoring is deferred until the dimensions worth scoring are grounded in real usage.

### Phase 2 — Platformization (Future)
> **Goal:** Open up Agent creation and a Skills marketplace to form an ecosystem.

* **Natural Language Incubator launch**: Conversational, interactive Agent creation.
* **Skills marketplace**: The community can contribute and install Skills.
* **Multi-engine adaptation**: Integrate more execution engines such as `LLM+MCP` and `Custom Scripts`.

### Phase 3 — Agent Network (Vision)
> **Goal:** Move from tools to a true "ocean of agents".

* **Intent ripple propagation**: Tasks propagate and respond autonomously across the Agent network in the form of "waves".
* **Self-evolution**: Agents autonomously optimize tool selection and learn new Skills.

---

## 6. Native Chat Apps and Long Connections (Must Be Strictly Followed)

The following rules are **hard implementation constraints** of the **a2wave orchestration layer** on native Feishu, Slack, and Discord bot connections, consistent with the production implementation; **they must not be violated when planning features, writing requirements, or doing reviews**. Native Slack and Discord support was approved by the maintainers in a product-boundary review.

| Principle | Description |
| :--- | :--- |
| **One process, one App, one active connection** | Within a single API process, the same Feishu App ID, Slack App ID, or Discord Application ID may have only **one** active connection for its respective platform. |
| **No connection sharing** | Each successfully connected Agent uses its **own** provider client (`WSClient`, Slack Socket Mode client, or Discord Gateway client). **It is forbidden** to promise, as an external product capability, merging multiple Agents into "one physical connection with in-platform multiplexing" — the product semantics at this stage are **slot mutual exclusion**, not connection multiplexing. |
| **First come, first served; later starters must not preempt** | If multiple published Agents are configured with the **same App ID**, the Agent that **connects first** occupies the slot; the remaining Agents **must not connect** (visible via error/diagnosis), and **later starters must not kick out the incumbent**. Only after the incumbent **unpublishes or is stopped to release** the slot can another Agent occupy that App's slot. |
| **One bot per orchestration Agent (recommended)** | When multiple Agents must connect independently to the same chat platform, configure a **separate provider app** and credentials for each Agent. Multiple Agents sharing one provider app and receiving messages online simultaneously is not a supported scenario. |
| **Multi-replica deployment** | Each API instance maintains the above mutual exclusion independently; the same provider app may still have one connection in each Pod. Cross-replica connection ownership falls under infrastructure and provider-side delivery policy, and the product does not guarantee a single connection across replicas. |

**Agent Diagnosis**: The console's "Agent Diagnosis" aggregates checks such as the **execution engine (Provider), Agent-side credential configuration, and native chat publishing connections**. A connection's online state only reflects the **current API process instance**; in multi-replica deployments this must be understood per instance.

**Inbound files**: Feishu files, Slack Files, and Discord Attachments can be downloaded by the orchestration layer and handed to the underlying Agent via the Run's local attachment context. Provider URLs are validated against platform allowlists, the platform attachment policy enforces file limits and allowed extensions, and temporary files are cleaned up after message processing.

**Requirements that violate the above principles** (for example, requiring multiple Agents to share the same provider app long-term and receive messages simultaneously, or requiring a later-started Agent to preempt the connection) **will not be included in the product plan**, and must be reworked into separate apps or an adjusted Agent lifecycle before being reassessed.

---

## 6.1 Publish Channels (Extensible, Subject to the Authentication Contract)

Publish channels were previously a **closed list** requiring maintainer sign-off
per channel. That gate has been **removed**: adding a channel is ordinary work.

What replaced it is the constraint the rule actually existed to protect —
**no unauthenticated entry points**. Every channel, existing or new, must:

| Requirement | Meaning |
| :--- | :--- |
| **Attributable caller** | Every invocation resolves to an identity: a signed-in user, a bound SSO identity, an Agent API key, or the Agent owner for platform-initiated triggers. A channel that cannot attribute its caller does not ship. |
| **Own `trigger_source`** | Every run is recorded in `runs` under its own trigger source, so channel traffic stays separable in history, statistics and audit. |
| **No ad-hoc credential store** | Credentials live in the channel's own masked config column, or in an external CLI's keyring — never in a new bespoke store. |

Current channels: API / OAuth / A2A / Feishu / Slack / Discord / scheduled /
chat page / **GitLab repository trigger (`glab`)** / **GitHub repository trigger (`gh`)**.

**Recorded decisions.** The earlier per-channel sign-off notes are preserved
here rather than lost with the closed list they belonged to:

| Channel | Decision |
| :--- | :--- |
| Slack, Discord | Approved by the maintainers in a product-boundary review as native chat channels. |
| Chat page (`chat_app`) | Approved in a product-boundary review: a first-party, session-authenticated surface with no anonymous access, every turn written to `runs` with `trigger_source = 'chat_app'`. |
| GitLab / GitHub triggers | Approved together with the removal of the closed list. They are inbound triggers rather than chat adapters: nothing is exposed to the internet, no new credential is stored (forge auth stays in the CLI's keyring or environment), and every fired Run is attributed to the Agent owner and audited via `agent.git_trigger`. |

The two git repository triggers poll a repository through the vendor CLI and
start a Run only when a watched merge/pull request actually moves. The
distinction from the scheduled channel is the point: a schedule fires the Agent
unconditionally and spends tokens on every tick even when nothing changed, while
here the comparison happens *outside* the Agent, so an idle repository costs
nothing. They store no credentials — forge authentication stays in the CLI's own
keyring or environment — and every fired Run is attributed to the Agent owner
and audited via `agent.git_trigger`.

---

## 7. Developer Slogan
> **"Let every intent create a precise ripple in the ocean of Agents."**

---
