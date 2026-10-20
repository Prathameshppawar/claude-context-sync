# Changelog

## 1.1.0

- **Share chats with your team.** A team repo's owner can now share chats. In the Team
  view, **Shared chats** has a **+** button that picks chats and asks for confirmation
  first, because the whole transcript goes. Teammates get shared chats at their next
  sync and resume them with ▶. Only the owner shares; × stops sharing one, and copies
  teammates already have stay with them.
- **Sync tool, engine 5.** It updates itself in your repos as usual, and a team repo
  carries the owner's copy to every teammate. Teammates still on 1.0.0 receive shared
  chats too and can open them with `/resume` in Claude; the Shared chats list needs 1.1.0.

## 1.0.0

First release.

- **Memory sync:** Claude Code hooks pull at session start and push after each reply and
  at session end.
- **Chats:**
  - Tick a chat in the sidebar to sync it to every machine. ▶ resumes it in a Claude tab.
  - Chats are stored as content-addressed gzip pieces, with one manifest per machine.
    Project paths are rewritten for each machine.
- **Safe on collisions:** a chat open in a window is never replaced. A chat continued on
  two machines keeps both versions. Memory notes merge line by line.
- **Projects view:** sync one folder, or all of them.
- **Team repos:** one per shared project, with owner review.
  - Teammates write `people/<name>`; only the owner writes `main`.
  - Review in the Team view (Compare, Accept, Reject, Accept All) or as GitHub pull
    requests.
  - Private notes and chats never leave your personal repo. Team notes appear in your
    memory as `team/`.
- **Merge With Claude:** headless Claude Code on your own login merges a teammate's
  version with the approved one. It marks contradictions and drops secrets.
- **Home page:** what it does, how syncing works, live status, and setup or quick actions.
  It follows the editor theme.
- **Setup flows:** clone or create a personal repo, create or join a team repo, and create
  private GitHub repos through your VS Code sign-in.
- **The sync tool updates itself** in your repos. Syncs interrupted mid-way recover on
  their own.
