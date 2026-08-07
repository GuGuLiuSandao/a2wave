# Skill

A Skill is a reusable capability package described primarily by a `SKILL.md`. It packages an operational workflow, domain knowledge, or prompt template so it can be reused once mounted onto an Agent — it is the key vehicle for "extend through composition".

## SKILL.md Format

Each Skill uses a `SKILL.md` as its entry point, starting with YAML frontmatter:

```markdown
---
name: my-skill
description: One sentence explaining what this skill does and when to use it (decides when the Agent invokes it)
---

# Skill body (Markdown)

Write steps, conventions, examples here…
```

The `description` is important: it is what the Agent uses to judge "whether to use this skill", so state the **applicable scenario** clearly.

## Creating or Installing a Skill

Three ways:

- **Create online**: on the "Skills" page click "New Skill" and fill in the name, description, visibility, and `SKILL.md` instructions in the dialog. After saving, reopen the Skill to get "Content / Files" tabs, and add accompanying files on the "Files" tab (files can only be uploaded once the Skill exists).
- **Upload**:
  - upload a single `SKILL.md` file;
  - upload a **ZIP package** containing `SKILL.md` + accompanying files such as `scripts/`, `templates/`, `references/`; or
  - directly select the **entire skill folder** (the browser reads the directory and its subdirectories, and writes it to disk with the directory containing the shallowest `SKILL.md` as the root).
  - after selecting a file or folder, confirm its visibility in the upload dialog. The default is **Only me**; only administrators can choose **All users**.
- **Install from URL**: open the Upload menu, choose "Install from URL", paste a supported public URL, preview the discovered Skills, select up to 20, and install them into an optional Skill Group.

Every newly created, uploaded, or remotely installed Skill is **visible only to its creator** by default. Administrators can change visibility to **All users** during online creation, upload confirmation, remote installation, or later editing. Regular users can view and bind these shared Skills, but cannot modify their content, files, or remote source. Regular users cannot publish their own Skills to the entire organization.

Changing a shared Skill back to **Only me** immediately blocks new cross-user bindings. Even if another user's Agent retains its old reference, that Agent stops loading the Skill on its next run. Those retained references become effective again only if the Skill is shared with all users later.

Supported remote URL forms:

```text
https://skills.sh/<owner>/<repo>/<skill>
https://github.com/<owner>/<repo>
https://github.com/<owner>/<repo>/tree/<ref>/<skill-path>
```

Remote installation supports public GitHub-backed sources only. a2wave resolves the source to a full Git commit SHA and installs that immutable snapshot; it does not execute repository setup scripts or package-manager commands. A repository URL may discover multiple Skills, while a skills.sh URL selects the named Skill.

You can also use the CLI:

```bash
a2wave skills install https://skills.sh/owner/repo/skill
a2wave skills install https://github.com/owner/repo --skill path/to/my-skill
a2wave skills install https://github.com/owner/repo --all --group team-tools
a2wave skills install https://github.com/owner/repo --all --visibility all-users
a2wave skills create --url https://skills.sh/owner/repo/skill
```

  A successful upload opens the Skill's edit dialog directly.

Typical directory structure:

```
my-skill/
├── SKILL.md          # Entry point and description
├── scripts/          # Executable scripts
├── templates/        # Templates
└── references/       # Reference material
```

## Managing Skill Files

- **Append upload**: continue uploading files to an existing Skill.
- **Re-upload (replace)**: fully replace an existing Skill's name, description, content, and files with a new `SKILL.md` / ZIP package / **entire folder** (the old content is cleared first, then written to disk).
- **File list / read**: view and read a specific file inside the Skill online.
- **Remote provenance**: remotely installed Skills retain their repository, path, commit SHA, and content digest. Editing the Skill or replacing/appending files marks it as locally modified; it does not update the remote repository.

## Checking and Applying Remote Updates

Remote Skills are never updated automatically. Open the Skill detail page and choose **Check for updates** to compare:

1. the immutable commit originally installed;
2. the files currently stored in a2wave, including local edits; and
3. the latest commit on the saved branch or tag.

The dialog lists added, modified, and deleted files on both sides. Non-conflicting local and upstream changes are merged automatically. A conflict is reported only when the same file changed differently both locally and upstream. For conflicts, choose:

- **Keep local versions** to retain the current local content for conflicting files while applying other upstream changes; or
- **Use upstream versions** to replace conflicting local files with upstream content.

The update is applied only if the revision and digest still match the check result. If upstream changes between checking and applying, check again. CLI users can run:

```bash
a2wave skills check-update <skill-id-or-name>
a2wave skills update-remote <skill-id-or-name> --strategy preserve-local
```

## Skill Groups

When you have many Skills, organize them with **Skill Groups**. For regular users, a group manages only Skills you created; a Skill shared by someone else must be mounted directly as an individual Skill. Administrators may manage any Skill in a group:

1. Create a group on the "Skills" page; at creation time you can directly select several Skills to move into it.
2. Groups support a name, description, and icon.
3. When a group is deleted, the membership of its Skills is cleared (the Skills themselves are not deleted), and Agent references to that group are cleaned up automatically.

When mounted onto an Agent, Skills and Skill groups are merged and deduplicated.

An administrator-shared Skill may still belong to the administrator's private group. Regular users see that Skill in the ungrouped section and can mount it directly as an individual Skill, but cannot move it into their own group; administrators may move it between groups as needed. If an administrator places a shared Skill in a regular user's group, the group owner cannot move or release that Skill and must ask an administrator to move it before deleting the group. A group containing another user's private Skill is not offered in the Agent Skill picker because the Agent owner cannot run every member; ask an administrator to move that private Skill out of the group.

## Built-in Skill: a2wave-memory

The platform ships with the built-in `a2wave-memory` skill, which is **mounted automatically** when an Agent enables [Long-term Memory](/wiki/memory), giving the Agent the ability to search cross-session work logs and long-term memory. No manual addition is needed.

Platform built-in Skills such as `a2wave-memory` are available to every signed-in user. They can be bound to Agents and are preserved when an authenticated user clones or exports an Agent. When an authenticated export is imported into another instance, a2wave reuses matching built-ins already seeded there; every other packaged Skill is still created as a private copy owned by the importer. If a packaged `a2wave-memory` cannot be verified against the target instance, its contents are preserved as an unbound private copy while the target instance's built-in Skill is bound, keeping the Long-term Memory switch authoritative. Public share exports still omit all Skill content, but a memory-enabled public import automatically binds the target instance's built-in memory Skill. If that target built-in is unavailable, Long-term Memory is disabled on the imported Agent.

## Troubleshooting

| Symptom | Possible Cause | Fix |
|------|---------|------|
| Upload fails | Missing `SKILL.md` or malformed frontmatter | Confirm the ZIP root has `SKILL.md` and the frontmatter is valid |
| Remote preview finds no Skill | The URL path is wrong, the repository is private, or `name` does not match the Skill directory | Use a public repository and verify the URL, `SKILL.md` frontmatter, and directory name |
| Remote request returns a GitHub error | GitHub is unavailable or the unauthenticated public API rate limit was reached | Wait and retry; remote installation never falls back to executing a third-party installer |
| Remote update reports conflicts | The same file changed locally and upstream | Review the file list, then keep local versions or use upstream versions explicitly |
| Remote changed after checking | The saved branch moved before the update was applied | Run **Check for updates** again and review the new revision |
| A Skill created by someone else is missing | The Skill is still set to "Only me" | Ask an administrator to confirm it is suitable for organization-wide use, then change visibility to "All users" |
| A mounted shared Skill no longer runs | The Skill was changed back to "Only me" | Ask the Skill owner or an administrator whether it should be shared again |
| Agent doesn't use a certain skill | The `description` doesn't clearly state the scenario | State "when to use" clearly |
| A skill change didn't take effect | The mounted Agent has cached it | Trigger a Run again |

> While a Skill is available to all users, modifying it affects every Agent that is still authorized to reference it. Only the Skill owner or an administrator can edit it, so confirm that its content is suitable as a shared capability before publishing it.

## Related

- [MCP Server](/wiki/mcp-servers) · [Long-term Memory](/wiki/memory) · [Agent Management](/wiki/agents)
