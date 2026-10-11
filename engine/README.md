# Claude context

Claude Code's memory for my projects and the chats I choose to keep, synced between my
machines. **Keep this repo private:** memory notes can hold passwords and chats hold
full tool output. Add other people only on purpose.

## What's in here

| Path | What |
|---|---|
| `projects/<name>/memory/` | Claude's memory notes. Claude reads and writes them here directly. |
| `projects/<name>/chats/<id>/` | Chats picked for syncing: ~1 MB gzip pieces, one `manifest.<machine>.json` per machine, `meta.json` (title, picked when and where). |
| `ccsync.js` | The sync tool (Node 18+ and git; no packages). |
| `.local/` | This machine's settings, sync state and log. Not committed. |

The **Context Sync for Claude Code** VS Code extension is a sidebar over `ccsync.js`:

- Tick chats to sync them.
- ▶ resumes a chat in a Claude tab.
- Turn sync on per project.
- On a new machine, **Set up** clones this repo.

## How it syncs (nothing to do by hand)

Turning a project on (the extension, or `ccsync.js setup`) adds three Claude hooks to
that project's `.claude/settings.local.json`:

- **Session start:** pulls, so `/resume` lists chats continued on the other machine, then
  pushes this machine's changes in the background.
- **After each reply:** memory changes are pushed in the background. Picked chats go at
  most every 20 minutes.
- **Session end:** pushes everything.

It also points the project's `autoMemoryDirectory` at `projects/<name>/memory`, and it
replaces Claude's old memory folder for the project with a link to that folder.

## Without the extension

1. Install git and Node 18+. Sign in to GitHub with an account that can see this repo.
2. `git clone <this repo's URL> ~/claude-context`
3. `node ~/claude-context/ccsync.js setup --project <name> --dir "<project folder>" --machine <mac|windows|…>`

Use the same `--project` name on every machine for the same project. Re-running `setup` is
safe.

| Command | Does |
|---|---|
| `setup --project <name> --dir <folder> [--machine <name>]` | Turn sync on for a project on this machine |
| `chats` | Pick chats to sync, interactively |
| `list` | This machine's chats; `[x]` = synced |
| `add <number\|id\|current>...` / `remove ...` | Start or stop syncing chats (local copies stay) |
| `sync` | Push and pull everything now |
| `status` | What's synced, last sync, problems |

In Claude itself, `/sync-chats` or "sync this chat" does the same.

## If this is a team repo

If `team.json` exists, this repo shares one project's memory with a team:

- **Who writes what:** the owner it names writes `main`. Everyone else's machines write
  `people/<name>` and take `main` in.
- **How changes reach everyone:** the owner accepts, merges or rejects each change, in the
  extension's Team view or as a GitHub pull request. Only accepted changes reach the
  team.
- **What it never holds:** chats, or anyone's private notes. Those stay in personal repos.

## When things collide

- **A chat continued on both machines** before they synced: each machine keeps its own
  version. The other appears as a separate chat titled "… (<machine> copy)".
- **A chat open in a window** when newer messages arrive is not replaced. Start a new
  chat, then `/resume` it.
- **A memory note edited on both machines** merges line by line. Any other conflict keeps
  this machine's side, and the other side stays in git history.

The full log is `.local/sync.log`.
