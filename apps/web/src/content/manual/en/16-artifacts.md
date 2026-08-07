# Artifacts & Online Sharing

Files produced by each Agent run (web pages, reports, data files, whole directories…) are saved as **artifacts**. Beyond downloading, a2wave can turn an artifact into an **online share link in one click**: the other party opens the link and can preview the web page or read the report directly — no need to log in to a2wave, no need to download files.

This chapter covers how artifacts are shared, who can see them, and what they see. For where artifacts come from and how long they're retained, see [Runs](/wiki/runs).

## What an artifact is

- **Single file**: a web page (`.html`), Markdown (`.md`), or any other file.
- **Directory artifact**: a complete folder, common for web apps (containing `index.html` and its accompanying CSS / JS / images).
- Artifacts can be viewed, **downloaded**, and deleted in the artifact list under [Runs](/wiki/runs); a directory can be "downloaded as ZIP" as a whole.

**Who sees an artifact in that list** follows the same rule as runs (see [Runs → Who can see which runs](/wiki/runs)): administrators see everything; an Agent's owner and its [collaborators](/wiki/members) see all of that Agent's artifacts, whoever triggered them and through whichever channel; everyone else sees only artifacts from runs they triggered. **Deleting is stricter than viewing**: a viewer may only delete artifacts they produced themselves; deleting someone else's requires owner or editor permission on the Agent.

> [!NOTE]
> To have an Agent produce shareable web pages specifically, choose the **Web App Generator** template. It defaults to authenticated auto-sharing for seven days; you can adjust this later in Artifact settings.

## Enabling auto-sharing

Configure it on the **Agent detail page → Artifacts** tab. Once enabled, whenever a run produces html / md / directory-type artifacts, a **share link is created automatically** and attached to the run message and Feishu notification.

| Setting | Description |
|--------|------|
| **Auto-share** | Master switch. When off, artifacts can only be downloaded and no online link is generated. |
| **Access permission** | The default access level for auto-created links: **login required** or **public** (see below). |
| **Share validity** | The link's validity in days, **1–365 days**, default **7 days**. The link expires afterward. |

Click **Save** when done.

> [!IMPORTANT]
> **Access permission is frozen onto the link "at publish time".** This setting only affects **subsequently created** shares; changing it does **not** alter the access permission of artifacts already published out. To tighten or loosen a link already sent out, you need to rerun to generate a new share.

## Two access levels

- **Login required** (recommended default): visitors must first pass enterprise SSO authentication to view. Suitable for internal, not-yet-finalized content.
- **Public**: anyone with the link can view directly, without any verification. Suitable for confirmed, externally facing content.

We suggest keeping "login required" first, and only changing to "public" for scenarios that need external distribution after you confirm the content is correct.

## What visitors see

When a visitor opens the share link (of the form `…/s/…`):

- **Login-required link**: it first redirects to the login page for enterprise SSO authentication, and after passing, returns automatically to the shared content. The same browser needs no repeat login for a while.
- **Public link**: content is shown directly.

Content presentation:

- **Web page (HTML)**: rendered as-is in a secure sandbox; it feels to the other party like visiting an ordinary web page.
- **Markdown**: rendered into a nicely formatted page, with the source viewable.
- **Directory artifact**: if it contains `index.html`, it opens directly as a web app; otherwise a file listing page is shown for browsing item by item.
- **Other files**: offered as a download.

## Distributing artifacts via Feishu

After publishing an Agent to Feishu (see [Trigger Methods](/wiki/triggers)), the publish configuration offers a **Send artifacts as files** option:

- **On**: the artifact is sent directly into the Feishu chat as a **file**, convenient for the other party to save.
- Even when sent as a file, as long as the artifact has auto-share enabled, the reply **still includes an "Online preview" link** — the other party can click to view first without downloading.
- **Off**: the artifact appears as a **download link** in the reply text (if auto-share is on, an online preview link is likewise attached).

## Artifact-accessible address (admin)

The domain/address in download links and share links is taken from **Settings → Run Artifacts → User-accessible address**:

- Fill in the base address visitors can actually reach, e.g. `https://a2wave.example.com`. When left blank, it falls back to the request header or `localhost`.
- Local debugging uses port **3501**; production runs use port **3502**.

> [!WARNING]
> If you fill in `localhost` or an intranet address here, external parties (including the Feishu counterpart) won't be able to open the link. Before sharing externally, confirm the filled-in address is reachable by the other party.

## Troubleshooting approach

1. **Link won't open / errors** → most likely "user-accessible address" was set to a local address the other party can't reach; change it to an externally reachable base address.
2. **Link invalid (not found)** → the share has expired, was deleted, or the artifact was reclaimed with worktree cleanup; rerun to generate a new share. See the artifact retention policy in [Runs](/wiki/runs).
3. **Changed access permission but the other party still can't open / can still see** → permission is frozen at publish time and old links are unaffected; just regenerate the share.
4. **Only received a file in Feishu, no preview link** → confirm the Agent has "auto-share" enabled.

## Related

- [Runs](/wiki/runs) (artifact list, download, retention policy) · [Agent Management](/wiki/agents) · [Trigger Methods](/wiki/triggers) (Feishu publishing)
