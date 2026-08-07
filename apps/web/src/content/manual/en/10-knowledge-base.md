# Knowledge Base

A Knowledge Base is a collection of documents for an Agent to retrieve. After you consolidate enterprise internal materials, standards, FAQs, etc. into Knowledge Base documents and mount them onto an Agent, the Agent can retrieve this content at runtime to assist its answers.

## Three Document Sources

| Source | Description | Key Fields |
|------|------|---------|
| **upload** | Upload local files | Original filename, type, storage path |
| **feishu** | Pull from Feishu cloud documents | Document token, type (**docx / wiki**), URL, Feishu App ID/Secret |
| **notion** | Pull from a Notion page (converted to Markdown) | Page URL, Notion Integration Token |

The Feishu / Notion sources let you directly connect materials already maintained on an external platform, avoiding duplicate maintenance.

### Connecting a Notion Page

1. Go to [Notion Integrations](https://www.notion.so/my-integrations) and create an **Internal Integration**, then copy its Token.
2. Open the Notion page you want to sync, and add the Integration under "•••" → "Connections" in the top-right corner.
3. In "Knowledge Base", create a new document, choose "Notion page" as the source, and fill in the page URL and Token.

> [!NOTE]
> Only the page's own content is synced (subpages are not included and are marked with a placeholder); database links are not supported yet. Notion-hosted images and files are rendered as stable placeholders rather than keeping temporary download links that expire. The converted Markdown of a remote document must not exceed 10MB; if it does, the sync fails and the last successful content is kept.

## Managing Documents

1. Go to the "Knowledge Base" page to view existing documents; clicking any document card opens the edit dialog.
2. Create new documents: click "Add Document", pick a source in the dialog, and add several at once:
   - **Feishu / Notion**: paste **one URL per line**. The whole batch shares one set of credentials (Feishu App ID/Secret, Notion Integration Token) and one description.
   - **Local files**: the upload area accepts a **multi-select**.
3. Documents support **auto-sync** (on by default, interval default 60 minutes), with sync statuses `idle / syncing / synced / error`; failures record the reason. You can also click "Sync now" in the document dialog to pull manually.

### Adding Several at Once

Every URL and every file becomes its **own** knowledge base document — synced separately, with its own status, and mountable onto different Agents.

**You don't enter a name**: remote documents take the remote title, uploaded files take the filename. Once added, open any document card to rename it.

> [!NOTE]
> At most 10 at a time. Each remote document is fetched individually, so a large batch means a long wait in front of the dialog; past 10 the submit is blocked — split it into batches.

**A partial failure does not affect the rest**: documents are processed one at a time with live progress. Successes are stored immediately; failures are listed with the actual reason (for example "the app has no permission for this document"). Failed **URLs** stay in the box so you can fix them and resubmit; failed **files** need to be picked again.

### Updating Notion Connection Info

1. Open a Notion-source document's edit dialog and find "Notion Config".
2. To switch pages, edit the "Notion page URL"; to rotate the credential, enter a new Integration Token. The Token field is always empty — leaving it blank on save keeps the current Token.
3. Click "Save", then click "Sync now" to verify the new page or Token works.

## Mounting and Retrieval

After mounting Knowledge Base documents in an Agent's configuration, the platform injects relevant content into the context **when a Run starts**, and the Agent answers based on it. The Knowledge Base takes effect as documents are updated, making it suitable for materials that "change and need to be referenced".

## Difference from Skill / Memory

- [Knowledge Base](/wiki/knowledge-base): leans toward **retrievable factual material** (standards, manuals, FAQs).
- [Skill](/wiki/skills): leans toward **capabilities and workflows**.
- [Long-term Memory](/wiki/memory): leans toward **cross-session preferences and history** (maintained automatically by the platform).

## Troubleshooting

| Symptom | Possible Cause | Fix |
|------|---------|------|
| Feishu document sync fails | Insufficient App credentials/permissions or unsupported document type | Confirm the App ID/Secret and that the document is docx/wiki |
| Notion sync reports an invalid Token | Integration Token is wrong or has been revoked | Copy a valid Token from the Notion Integrations page, then replace it in the document dialog via "Updating Notion Connection Info" and sync now |
| Notion sync reports the page does not exist | The page is not shared with the Integration, or the link is a database | Add the Integration under "•••" → "Connections" on the page; database links are not supported yet |
| Agent doesn't use the material | Not mounted or content irrelevant | Mount the corresponding document in the Agent's configuration |
| Content is stale | Auto-sync not enabled | Enable autoSync or sync manually |

## Related

- [Skills](/wiki/skills) · [Long-term Memory](/wiki/memory) · [Agent Management](/wiki/agents)
