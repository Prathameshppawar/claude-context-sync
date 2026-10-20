// Context Sync for Claude Code: a sidebar over ccsync.js, the sync tool that lives in every
// context repo (engine/ccsync.js here is the newest copy; older copies are updated
// from it). A machine can use several repos: a personal one, and a team repo per
// shared project. Git work happens in ccsync; the extension only clones, creates and
// updates repos.
'use strict';

const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { homeHtml } = require('./home');

const { TreeItem, ThemeIcon, MarkdownString } = vscode;
const Collapse = vscode.TreeItemCollapsibleState;
const Check = vscode.TreeItemCheckboxState;

const BIG_CHAT_BYTES = 50 * 1024 * 1024;
const GITHUB_AUTH = /authentication|could not read username|403|401|repository not found|terminal prompts disabled/i;
const REVIEW_SCHEME = 'ccontext-review';

let extCtx;
let out;
let statusItem;
let chatTree;
let projectTree;
let teamTree;
let repos = []; // [{ path, state }] every context repo this machine uses
let projects = []; // every folder Claude has worked in on this machine
let busy = 0;
let pullTimer;
let watchers = [];
let watchKey = '';
let homePanel = null;
let homeShownThisSession = false;
let bundledVersion = 0;
const engineUpdated = new Set();
const pendingMerges = new Map(); // merged file (normPath) -> { repo, person, path, file }

// ---------- helpers ----------

const settings = () => vscode.workspace.getConfiguration('claudeContext');
const expandHome = p => p.replace(/^~(?=$|[\\/])/, os.homedir());
const defaultRepoPath = () => path.resolve(expandHome(settings().get('repoPath') || '~/claude-context'));
const teamsRoot = () => path.join(os.homedir(), 'claude-context-teams');
const bundledEngine = () => path.join(extCtx.extensionPath, 'engine', 'ccsync.js');
const normPath = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const samePath = (a, b) => !!a && !!b && normPath(a) === normPath(b);
const fmtBytes = n => (n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.max(1, Math.round((n || 0) / 1024)) + ' KB');
const cleanName = s => String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

const configured = () => repos.filter(r => r.state && r.state.configured);
const personalRepos = () => configured().filter(r => !r.state.team);
const teamRepos = () => configured().filter(r => r.state.team);
const chatProjects = () => personalRepos().flatMap(r => r.state.projects.map(p => ({ ...p, repo: r.path, machine: r.state.machine })));
const thisMachine = () => (configured()[0] || {}).state?.machine || null;
const thisPerson = () => configured().map(r => r.state.person).find(Boolean) || null;

function ago(ms) {
  if (!ms) return 'never';
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

function debounce(fn, ms) {
  let t;
  return () => {
    clearTimeout(t);
    t = setTimeout(fn, ms);
  };
}

// Runs a ccsync.js with VS Code's own runtime unless a Node path is configured.
function runEngine(file, args, json = true) {
  const custom = settings().get('nodePath');
  const bin = custom || process.execPath;
  const env = custom ? process.env : { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  return new Promise((resolve, reject) => {
    cp.execFile(bin, [file, ...args], { cwd: path.dirname(file), env, maxBuffer: 256 << 20, windowsHide: true, timeout: 15 * 60e3 }, (err, stdout, stderr) => {
      if (stderr && stderr.trim()) out.appendLine(stderr.trim());
      if (err) return reject(new Error((stderr || stdout || err.message).trim().split('\n').slice(-3).join(' ')));
      if (!json) return resolve(stdout);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Unexpected output from ccsync: ${stdout.slice(0, 200)}`));
      }
    });
  });
}
const engineIn = (repo, args, json = true) => runEngine(path.join(repo, 'ccsync.js'), args, json);

function git(args, cwd) {
  return new Promise((resolve, reject) =>
    cp.execFile('git', args, { cwd, windowsHide: true, maxBuffer: 16 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim()),
    ),
  );
}

function githubWeb(remote) {
  const m = String(remote || '').match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? `https://github.com/${m[1]}/${m[2]}` : null;
}

// ---------- GitHub (only for cloning or creating repos) ----------

async function githubSession(silent) {
  try {
    return await vscode.authentication.getSession('github', ['repo'], silent ? { silent: true } : { createIfNone: true });
  } catch {
    return null;
  }
}

async function githubToken() {
  const s = await githubSession(false);
  if (!s) throw new Error('GitHub sign-in was cancelled.');
  return s.accessToken;
}

const authArgs = token => ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`];

function githubApi(method, apiPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = https.request(
      {
        hostname: 'api.github.com',
        path: apiPath,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'claude-context-vscode',
          Accept: 'application/vnd.github+json',
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      res => {
        let s = '';
        res.on('data', d => (s += d));
        res.on('end', () => {
          let j = {};
          try {
            j = JSON.parse(s || '{}');
          } catch {}
          if (res.statusCode < 300) resolve(j);
          else reject(new Error(`GitHub: ${j.message || res.statusCode}${j.errors ? ` (${j.errors.map(e => e.message || e.code).join(', ')})` : ''}`));
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

// The Claude hooks run git in the background, so git itself must be able to sign in.
async function offerGitCredential(token) {
  const yes = 'Use my VS Code sign-in';
  const pick = await vscode.window.showWarningMessage(
    "Git on this machine could not sign in to GitHub. Background syncs need it. Let git use your VS Code GitHub sign-in? (Stored in your system's git credential helper.)",
    { modal: true },
    yes,
  );
  if (pick !== yes) return false;
  const login = (await githubApi('GET', '/user', token)).login || 'x-access-token';
  await new Promise((resolve, reject) => {
    const p = cp.spawn('git', ['credential', 'approve'], { windowsHide: true });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error('git credential approve failed'))));
    p.stdin.end(`protocol=https\nhost=github.com\nusername=${login}\npassword=${token}\n\n`);
  });
  return true;
}

// ---------- tree: chats ----------

const ICONS = { local: 'comment-discussion', synced: 'cloud', unsent: 'cloud-upload', incoming: 'cloud-download', 'remote-only': 'cloud-download', empty: 'circle-slash' };
const STATUS_TEXT = {
  local: 'Only on this machine. Tick it to sync it.',
  synced: 'Synced. Your other machines get it automatically.',
  unsent: 'Synced. New messages go up after a reply (at most every 20 minutes), when the session ends, or on Sync Now.',
  incoming: 'Another machine has newer messages. They were held back because the chat looked open here. Close it, then Pull.',
  'remote-only': 'Synced from another machine but not on this one yet. Pull to get it.',
  empty: 'Picked for syncing; nothing uploaded yet.',
};

const otherMachines = (p, c) => [...new Set(c.copies.map(x => x.machine).filter(m => m !== p.machine))].join(', ') || 'another machine';

function describe(p, c) {
  const meta = `${fmtBytes(c.size)} · ${ago(c.mtimeMs)}`;
  if (c.status === 'unsent') return `unsent changes · ${meta}`;
  if (c.status === 'incoming') return `newer on ${otherMachines(p, c)} · ${meta}`;
  if (c.status === 'remote-only') return `on ${otherMachines(p, c)} · ${meta}`;
  if (c.status === 'empty') return 'nothing uploaded yet';
  return meta;
}

function chatTooltip(c) {
  const md = new MarkdownString();
  md.appendMarkdown('**');
  md.appendText(c.title);
  md.appendMarkdown(`**\n\n${STATUS_TEXT[c.status] || ''}\n\n`);
  if (c.local) md.appendMarkdown(`This machine: ${fmtBytes(c.size)}, last used ${new Date(c.mtimeMs).toLocaleString()}\n\n`);
  for (const x of c.copies) {
    md.appendMarkdown('Copy from **');
    md.appendText(x.machine);
    md.appendMarkdown(`**: ${fmtBytes(x.bytes)}, sent ${new Date(x.updated).toLocaleString()}\n\n`);
  }
  md.appendMarkdown(`\`${c.id}\``);
  return md;
}

function chatNode(p, c) {
  const item = new TreeItem(c.title, Collapse.None);
  item.id = `c:${p.repo}:${p.name}:${c.id}`;
  item.description = describe(p, c);
  item.tooltip = chatTooltip(c);
  item.iconPath = new ThemeIcon(ICONS[c.status] || 'comment-discussion');
  item.checkboxState = c.synced ? Check.Checked : Check.Unchecked;
  item.contextValue = `chat ${c.local ? 'local' : 'remote'} ${c.status}`;
  return { kind: 'chat', project: p, chat: c, item };
}

function groupNodes(p) {
  const group = (key, label, list, hint) => {
    const item = new TreeItem(label, list.length ? Collapse.Expanded : Collapse.None);
    item.id = `g:${p.repo}:${p.name}:${key}`;
    item.description = String(list.length);
    item.tooltip = hint;
    return { kind: 'group', item, children: list.map(c => chatNode(p, c)) };
  };
  return [
    group('synced', 'Synced', p.chats.filter(c => c.synced), 'On every machine that uses this context repo'),
    group('local', 'Only on this machine', p.chats.filter(c => !c.synced), 'Tick a chat to sync it'),
  ];
}

function projectGroupNode(p, showRepo) {
  const item = new TreeItem(path.basename(p.dir) || p.name, Collapse.Expanded);
  item.id = `p:${p.repo}:${p.name}`;
  item.description = `${p.memory.files} memory notes${showRepo ? ` · ${path.basename(p.repo)}` : ''}${p.memory.linked ? '' : ' · memory not linked'}`;
  item.tooltip = `${p.dir}\nRepo: ${p.repo}`;
  item.iconPath = new ThemeIcon('root-folder');
  return { kind: 'project', item, children: groupNodes(p) };
}

class Tree {
  constructor(roots) {
    this.roots = roots;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
  }
  refresh() {
    this.emitter.fire(undefined);
  }
  getTreeItem(node) {
    return node.item;
  }
  getChildren(node) {
    return node ? node.children || [] : this.roots();
  }
}

function chatRoots() {
  const ps = chatProjects();
  if (ps.length === 1) return groupNodes(ps[0]);
  const showRepo = personalRepos().length > 1;
  return ps.map(p => projectGroupNode(p, showRepo));
}

// ---------- tree: projects ----------

function repoRoles(p) {
  return (p.repos || [])
    .map(rp => repos.find(x => samePath(x.path, rp)))
    .filter(r => r && r.state && r.state.configured)
    .map(r => (r.state.team ? { kind: 'team', role: r.state.team.role, repo: r } : { kind: 'personal', repo: r }));
}

function projectNode(p) {
  const roles = repoRoles(p);
  const personal = roles.some(r => r.kind === 'personal');
  const team = roles.find(r => r.kind === 'team');
  const item = new TreeItem(p.dir ? path.basename(p.dir) : p.slug, Collapse.None);
  item.id = `proj:${p.slug}`;
  const parts = [personal && 'personal', team && `team (${team.role})`].filter(Boolean);
  item.description = parts.length ? `${parts.join(' + ')} · ${p.chats} chats` : p.exists ? `${p.chats} chats · not synced` : 'folder not found';
  item.tooltip = [p.dir || p.slug, ...roles.map(r => `${r.kind === 'team' ? `Team repo (${r.role})` : 'Personal repo'}: ${r.repo.path}`)].join('\n');
  item.iconPath = new ThemeIcon(team ? 'organization' : personal ? 'cloud' : p.exists ? 'folder' : 'warning');
  item.contextValue = `project ${personal ? 'personal' : 'nopersonal'} ${team ? 'team' : 'noteam'} ${p.exists ? 'exists' : 'missing'}`;
  return { kind: 'proj', proj: p, item };
}

// ---------- tree: team ----------

const KIND_ICON = { added: 'diff-added', modified: 'diff-modified', deleted: 'diff-removed' };
const KIND_TEXT = { added: 'new note', modified: 'changed', deleted: 'deleted' };

function changeNode(r, c) {
  const role = r.state.team.role;
  const item = new TreeItem(path.basename(c.path), Collapse.None);
  item.id = `ch:${r.path}:${c.person}:${c.path}`;
  item.description = KIND_TEXT[c.kind];
  item.iconPath = new ThemeIcon(KIND_ICON[c.kind]);
  item.tooltip = `${c.path}\n${role === 'owner' ? `${c.person} proposes this. Click to compare with main.` : `Waiting for ${r.state.team.owner}. Click to compare with the approved copy.`}`;
  item.contextValue = `change ${role} ${c.kind}`;
  const node = { kind: 'change', repo: r, change: c, item };
  item.command = { command: 'claudeContext.reviewDiff', title: 'Compare', arguments: [node] };
  return node;
}

// Chats the owner shares go to main; every teammate's sync brings them in.
function sharedChatsNode(r, proj) {
  const t = r.state.team;
  const owner = t.role === 'owner';
  const shared = proj ? proj.chats.filter(c => c.synced) : [];
  const item = new TreeItem('Shared chats', shared.length ? Collapse.Expanded : Collapse.None);
  item.id = `sharedchats:${r.path}`;
  item.iconPath = new ThemeIcon('comment-discussion');
  item.description = shared.length ? String(shared.length) : owner ? 'none yet · + to share one' : 'none yet';
  item.tooltip = owner
    ? 'Chats you share here reach everyone on the team at their next sync, whole transcript included. Teammates can resume them.'
    : `Chats ${t.owner} shared with the team. They arrive when you sync; resume one to continue it on your own.`;
  item.contextValue = `sharedchats ${t.role}`;
  const children = shared.map(c => {
    const ci = new TreeItem(c.title, Collapse.None);
    ci.id = `teamchat:${r.path}:${c.id}`;
    ci.description = `${c.local ? '' : 'not here yet · '}${fmtBytes(c.size)} · ${ago(c.mtimeMs)}`;
    ci.tooltip = chatTooltip(c);
    ci.iconPath = new ThemeIcon(c.local ? 'comment-discussion' : 'cloud-download');
    ci.contextValue = `teamchat ${t.role} ${c.local ? 'local' : 'remote'}`;
    const node = { kind: 'teamchat', repo: r, project: proj, chat: c, item: ci };
    if (c.local) ci.command = { command: 'claudeContext.resumeChat', title: 'Resume in Claude', arguments: [node] };
    return node;
  });
  return { kind: 'sharedchats', repo: r, project: proj, item, children };
}

function teamRepoNode(r) {
  const t = r.state.team;
  const proj = r.state.projects[0];
  const item = new TreeItem(`${proj ? path.basename(proj.dir) : path.basename(r.path)} team`, Collapse.Expanded);
  item.id = `team:${r.path}`;
  item.iconPath = new ThemeIcon('organization');
  item.contextValue = `teamrepo ${t.role}`;
  if (t.role === 'owner') {
    item.description = t.pending.length ? `${t.pending.length} to review` : 'you own it · nothing to review';
    item.tooltip = `You own this team repo (${r.path}). Teammates' changes wait on their branches until you accept them.`;
    const people = [...t.people].sort((a, b) => b.pending - a.pending || a.person.localeCompare(b.person));
    const children = people.map(pp => {
      const pi = new TreeItem(pp.person, pp.pending ? Collapse.Expanded : Collapse.None);
      pi.id = `person:${r.path}:${pp.person}`;
      pi.description = `${pp.pending ? `${pp.pending} change${pp.pending > 1 ? 's' : ''}` : 'all reviewed'}${pp.lastActivity ? ` · ${ago(Date.parse(pp.lastActivity))}` : ''}`;
      pi.iconPath = new ThemeIcon('account');
      pi.contextValue = `teammate${pp.pending ? ' pending' : ''}`;
      return { kind: 'person', repo: r, person: pp.person, item: pi, children: t.pending.filter(c => c.person === pp.person).map(c => changeNode(r, c)) };
    });
    return { kind: 'team', repo: r, item, children: [sharedChatsNode(r, proj), ...children] };
  }
  item.description = t.proposals.length ? `${t.proposals.length} waiting for ${t.owner}` : `owned by ${t.owner} · all accepted`;
  item.tooltip = `Team repo owned by ${t.owner} (${r.path}). Your team notes go to ${t.branch} and reach everyone once ${t.owner} accepts them.`;
  return { kind: 'team', repo: r, item, children: [sharedChatsNode(r, proj), ...t.proposals.map(c => changeNode(r, c))] };
}

async function shareChatWithTeam(node) {
  const r = node && node.repo;
  const proj = node && node.project;
  if (!r || !proj || r.state.team.role !== 'owner') return;
  const candidates = proj.chats.filter(c => c.local && !c.synced).sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!candidates.length) return vscode.window.showInformationMessage(`No unshared chats in ${path.basename(proj.dir)} on this machine.`);
  const picks = await vscode.window.showQuickPick(
    candidates.map(c => ({ label: c.title, description: `${fmtBytes(c.size)} · ${ago(c.mtimeMs)}`, detail: c.id, chat: c })),
    { title: `Share chats with the ${path.basename(proj.dir)} team`, canPickMany: true, matchOnDetail: true, ignoreFocusOut: true },
  );
  if (!picks || !picks.length) return;
  const yes = 'Share';
  const what = picks.length > 1 ? `${picks.length} chats` : `"${picks[0].label}"`;
  const answer = await vscode.window.showWarningMessage(
    `Share ${what} with everyone on this team repo?`,
    { modal: true, detail: 'The whole transcript goes, including file contents, command output and anything pasted into it. Teammates can read and resume it. Check it holds nothing private first.' },
    yes,
  );
  if (answer !== yes) return;
  await act('sharing with the team', r.path, ['add', ...picks.map(p => p.chat.id)], vscode.ProgressLocation.Notification);
}

async function unshareChatFromTeam(node) {
  if (!node || !node.chat || node.repo.state.team.role !== 'owner') return;
  const yes = 'Stop sharing';
  const answer = await vscode.window.showWarningMessage(
    `Stop sharing "${node.chat.title}" with the team?`,
    { modal: true, detail: 'It leaves the team repo. Copies teammates already have stay on their machines.' },
    yes,
  );
  if (answer !== yes) return;
  await act('removing a shared chat', node.repo.path, ['remove', node.chat.id]);
}

// ---------- refresh, status bar, watchers ----------

function knownRepoPaths() {
  const found = new Map();
  const add = p => {
    if (p && fs.existsSync(path.join(p, 'ccsync.js'))) found.set(normPath(p), path.resolve(p));
  };
  add(defaultRepoPath());
  for (const p of extCtx.globalState.get('repos', [])) add(p);
  for (const p of projects) for (const r of p.repos || []) add(r);
  return [...found.values()];
}

async function updateEngines() {
  for (const r of repos) {
    const v = (r.state && r.state.engine) || 0;
    if (v >= bundledVersion || engineUpdated.has(normPath(r.path))) continue;
    engineUpdated.add(normPath(r.path));
    try {
      fs.copyFileSync(bundledEngine(), path.join(r.path, 'ccsync.js'));
      await git(['add', 'ccsync.js'], r.path);
      await git(['commit', '-q', '-m', `ccsync: update to engine ${bundledVersion}`], r.path);
      out.appendLine(`Updated the sync tool in ${r.path} to engine ${bundledVersion}.`);
      r.state = await engineIn(r.path, ['state']);
    } catch (e) {
      out.appendLine(`Could not update the sync tool in ${r.path}: ${e.message}`);
    }
  }
}

let refreshing = null;
let refreshAgain = false;

function refresh() {
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    try {
      projects = await runEngine(bundledEngine(), ['projects']);
    } catch (e) {
      out.appendLine(`projects: ${e.message}`);
    }
    const next = [];
    for (const p of knownRepoPaths()) {
      try {
        next.push({ path: p, state: await engineIn(p, ['state']) });
      } catch (e) {
        out.appendLine(`state of ${p}: ${e.message}`);
        next.push({ path: p, state: null });
      }
    }
    repos = next;
    extCtx.globalState.update('repos', repos.map(r => r.path));
    await updateEngines();
    await setContexts();
    chatTree.refresh();
    projectTree.refresh();
    teamTree.refresh();
    renderStatus();
    rewatch();
  })().finally(() => {
    refreshing = null;
    if (refreshAgain) {
      refreshAgain = false;
      refresh();
    }
  });
  return refreshing;
}

const refreshSoon = debounce(() => refresh(), 3000);

async function setContexts() {
  await vscode.commands.executeCommand('setContext', 'claudeContext.repoReady', repos.length > 0);
  await vscode.commands.executeCommand('setContext', 'claudeContext.configured', configured().length > 0);
  await vscode.commands.executeCommand('setContext', 'claudeContext.hasPersonal', personalRepos().length > 0);
  await vscode.commands.executeCommand('setContext', 'claudeContext.hasTeams', teamRepos().length > 0);
}

function summary() {
  const conf = configured();
  const lastAt = conf.map(r => (r.state.lastSync ? Date.parse(r.state.lastSync.at) : 0)).reduce((a, b) => Math.max(a, b), 0);
  return {
    lastSync: lastAt || null,
    offline: conf.some(r => r.state.lastSync && r.state.lastSync.offline),
    notices: [...new Set(conf.flatMap(r => r.state.notices || []))],
    unpushed: conf.reduce((a, r) => a + (r.state.unpushed || 0), 0),
    toReview: teamRepos().reduce((a, r) => a + (r.state.team.role === 'owner' ? r.state.team.pending.length : 0), 0),
    waiting: teamRepos().reduce((a, r) => a + (r.state.team.role === 'member' ? r.state.team.proposals.length : 0), 0),
    synced: chatProjects().reduce((a, p) => a + p.chats.filter(c => c.synced).length, 0),
  };
}

function renderStatus() {
  const s = statusItem;
  s.command = 'claudeContext.syncNow';
  const sum = summary();
  if (busy) {
    s.text = '$(sync~spin) Context';
    s.tooltip = 'Context Sync: syncing…';
  } else if (!repos.length && !configured().length) {
    s.text = '$(cloud) Context: set up';
    s.tooltip = 'Sync Claude memory and chats between your machines';
    s.command = 'claudeContext.openHome';
  } else if (sum.notices.length) {
    s.text = '$(warning) Context';
    s.tooltip = sum.notices.join('\n');
    s.command = 'claudeContext.showNotices';
  } else if (sum.toReview) {
    s.text = `$(cloud) Context · ${sum.toReview} to review`;
    s.tooltip = `${sum.toReview} team note change${sum.toReview > 1 ? 's' : ''} wait for your review. Click to open the Team view.`;
    s.command = 'claudeContext.team.focus';
  } else if (sum.offline) {
    s.text = '$(cloud-offline) Context';
    s.tooltip = 'Could not reach GitHub at the last sync. Changes are saved and go up next time. Click to retry.';
  } else {
    const waiting = sum.unpushed ? ` · ${sum.unpushed} change(s) waiting to upload` : '';
    s.text = '$(cloud) Context';
    s.tooltip = `Context Sync · last sync ${ago(sum.lastSync)} · ${sum.synced} chat${sum.synced === 1 ? '' : 's'} synced · this machine: ${thisMachine() || '?'}${waiting}\nClick to sync now`;
  }
  s.show();
  postHomeState();
}

function rewatch() {
  const want = [];
  for (const r of repos) want.push([path.join(r.path, '.local'), 'state.json']);
  for (const p of chatProjects()) want.push([p.claudeDir, '*.jsonl']);
  const key = JSON.stringify(want);
  if (key === watchKey) return;
  watchKey = key;
  watchers.forEach(w => w.dispose());
  watchers = [];
  for (const [dir, glob] of want) {
    if (!fs.existsSync(dir)) continue;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dir), glob));
    w.onDidChange(refreshSoon);
    w.onDidCreate(refreshSoon);
    w.onDidDelete(refreshSoon);
    watchers.push(w);
  }
}

// ---------- actions ----------

function announce(r, quiet) {
  if (!r) return;
  const lines = [];
  if (r.busy) lines.push('Another sync is running; try again in a minute.');
  if (typeof r.review === 'string') lines.push(r.review);
  for (const t of r.imported || []) lines.push(`Updated from your other machine: ${t}.`);
  for (const t of r.forked || []) lines.push(`Continued on both machines, so the other version was added as its own chat: ${t}.`);
  for (const n of r.notices || []) lines.push(n);
  if (r.offline) lines.push("Couldn't reach GitHub. Your changes are saved and go up next time.");
  if (lines.length) vscode.window.showInformationMessage(lines.join(' '));
  else if (!quiet) vscode.window.setStatusBarMessage('$(check) Context synced', 4000);
}

async function act(title, repo, args, location = vscode.ProgressLocation.Window) {
  busy++;
  renderStatus();
  try {
    const r = await vscode.window.withProgress({ location, title: `Context Sync: ${title}` }, () => engineIn(repo, [...args, '--json']));
    announce(r, false);
    return r || {};
  } catch (e) {
    out.appendLine(`${title}: ${e.message}`);
    vscode.window.showErrorMessage(`Context Sync: ${e.message}`, 'Show log').then(b => b && out.show());
    return null;
  } finally {
    busy--;
    renderStatus();
    refresh();
  }
}

async function syncAll(quiet) {
  const list = configured();
  if (!list.length) return quiet ? null : openHome();
  busy++;
  renderStatus();
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Context Sync: syncing' }, async () => {
      for (const r of list) {
        try {
          announce(await engineIn(r.path, ['sync', '--chats', quiet ? 'due' : 'all', '--json']), true);
        } catch (e) {
          out.appendLine(`sync ${r.path}: ${e.message}`);
          if (!quiet) vscode.window.showErrorMessage(`Context Sync (${path.basename(r.path)}): ${e.message}`);
        }
      }
    });
    if (!quiet) vscode.window.setStatusBarMessage('$(check) Context synced', 4000);
  } finally {
    busy--;
    refresh();
  }
}

const backgroundPull = () => {
  if (!busy && configured().length) syncAll(true);
};

function schedulePull() {
  clearInterval(pullTimer);
  const mins = settings().get('pullIntervalMinutes');
  if (mins > 0) pullTimer = setInterval(backgroundPull, mins * 60e3);
}

async function confirmBig(chats) {
  const big = chats.filter(c => c.size > BIG_CHAT_BYTES);
  if (!big.length) return true;
  const total = big.reduce((a, c) => a + c.size, 0);
  const ok = 'Sync anyway';
  const pick = await vscode.window.showWarningMessage(
    `${big.length === 1 ? `"${big[0].title}" is` : `${big.length} of these chats are`} large (${fmtBytes(total)}). Screenshots in a chat don't compress, so this can add up to that much to the repo.`,
    { modal: true },
    ok,
  );
  return pick === ok;
}

// Picked or unpicked chats, grouped by the repo they live in.
async function applySelection(on, off) {
  const byRepo = new Map();
  const put = (c, key) => {
    if (!byRepo.has(c.repo)) byRepo.set(c.repo, { on: [], off: [] });
    byRepo.get(c.repo)[key].push(c);
  };
  on.forEach(c => put(c, 'on'));
  off.forEach(c => put(c, 'off'));
  if (on.length && !(await confirmBig(on))) {
    refresh(); // put the boxes back
    for (const v of byRepo.values()) v.on = [];
  }
  for (const [repo, v] of byRepo) {
    if (v.on.length) await act(v.on.length === 1 ? `syncing "${v.on[0].title}"` : `syncing ${v.on.length} chats`, repo, ['add', ...v.on.map(c => c.id)]);
    if (v.off.length) await act(`stopping sync for ${v.off.length} chat${v.off.length > 1 ? 's' : ''}`, repo, ['remove', ...v.off.map(c => c.id)]);
  }
}

let toggles = new Map();
const applyTogglesSoon = debounce(async () => {
  const picked = [...toggles.values()];
  toggles = new Map();
  await applySelection(picked.filter(t => t.on && !t.chat.synced).map(t => t.chat), picked.filter(t => !t.on && t.chat.synced).map(t => t.chat));
}, 700);

async function pickChats() {
  const ps = chatProjects();
  if (!ps.length) return openHome();
  const items = [];
  for (const p of ps) {
    if (ps.length > 1) items.push({ label: path.basename(p.dir), kind: vscode.QuickPickItemKind.Separator });
    for (const c of p.chats) {
      items.push({ label: c.title, description: `${fmtBytes(c.size)} · ${ago(c.mtimeMs)}${c.local ? '' : ' · not on this machine'}`, picked: c.synced, chat: { ...c, repo: p.repo } });
    }
  }
  const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, title: 'Chats to sync (ticked = synced on all your machines)', matchOnDescription: true });
  if (!chosen) return;
  const want = new Set(chosen.map(i => i.chat.id));
  const all = items.filter(i => i.chat).map(i => i.chat);
  await applySelection(all.filter(c => !c.synced && want.has(c.id)), all.filter(c => c.synced && !want.has(c.id)));
}

function workspaceProject() {
  const folders = (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
  return chatProjects().find(p => folders.some(f => samePath(f, p.dir)));
}

async function syncCurrentChat() {
  if (!chatProjects().length) return openHome();
  const p = workspaceProject();
  if (!p) {
    const b = await vscode.window.showInformationMessage('Sync is not on for this folder yet.', 'Turn on sync');
    if (b) await enableProject();
    return;
  }
  const c = p.chats.filter(x => x.local).sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  if (!c) return vscode.window.showInformationMessage('There are no Claude chats in this folder yet.');
  if (c.synced) return vscode.window.showInformationMessage(`"${c.title}" is already synced.`);
  if (!(await confirmBig([c]))) return;
  const r = await act(`syncing "${c.title}"`, p.repo, ['add', c.id]);
  if (r) vscode.window.showInformationMessage(`"${c.title}" is synced. It appears on your other machines at their next sync.`);
}

async function resumeChat(node) {
  const c = node && node.chat;
  if (!c) return;
  if (!(vscode.workspace.workspaceFolders || []).some(f => samePath(f.uri.fsPath, node.project.dir))) {
    const b = await vscode.window.showInformationMessage(`"${c.title}" belongs to ${node.project.dir}. Open that folder to resume it.`, 'Open folder');
    if (b) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(node.project.dir), { forceNewWindow: true });
    return;
  }
  try {
    await vscode.commands.executeCommand('claude-vscode.editor.open', c.id);
  } catch (e) {
    out.appendLine(`claude-vscode.editor.open: ${e.message}`);
    const ok = await vscode.env.openExternal(vscode.Uri.parse(`${vscode.env.uriScheme}://anthropic.claude-code/open?session=${encodeURIComponent(c.id)}`));
    if (!ok) vscode.window.showWarningMessage('Could not open the chat. Is the Claude Code extension installed?');
  }
}

// ---------- names ----------

async function machineName() {
  if (thisMachine()) return thisMachine();
  const guess = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform] || 'pc';
  return vscode.window.showInputBox({
    title: 'Name this machine',
    prompt: 'Shown on chats that come from here, for example "mac" or "office-pc".',
    value: guess,
    ignoreFocusOut: true,
    validateInput: v => (/^[a-z0-9][a-z0-9-]*$/.test(v) ? null : 'Use lowercase letters, digits and dashes.'),
  });
}

async function personName() {
  if (thisPerson()) return thisPerson();
  const s = await githubSession(true);
  const guess = cleanName((s && s.account && s.account.label) || os.userInfo().username);
  return vscode.window.showInputBox({
    title: 'Your name in team repos',
    prompt: 'Teammates see it on your changes, and your branch is people/<name>. Use the same name on all your machines.',
    value: guess,
    ignoreFocusOut: true,
    validateInput: v => (/^[a-z0-9][a-z0-9-]*$/.test(v) ? null : 'Use lowercase letters, digits and dashes.'),
  });
}

// The same project on two machines must share one name in a repo, so offer the
// repo's existing projects before making up a new one.
async function projectName(repoDir, dir, preferred) {
  const r = repos.find(x => samePath(x.path, repoDir));
  const confProjects = (r && r.state && r.state.configured && r.state.projects) || [];
  const hit = confProjects.find(p => samePath(p.dir, dir));
  if (hit) return hit.name;
  const taken = new Set(confProjects.map(p => p.name));
  let inRepo = [];
  try {
    inRepo = fs.readdirSync(path.join(repoDir, 'projects')).filter(n => !taken.has(n));
  } catch {}
  const base = preferred || cleanName(path.basename(dir)) || 'project';
  let fresh = base;
  for (let i = 2; taken.has(fresh) || inRepo.includes(fresh); i++) fresh = `${base}-${i}`;
  if (!inRepo.length) return fresh;
  if (inRepo.length === 1 && inRepo[0] === base) return base;
  const items = [
    ...inRepo.map(n => ({ label: n, description: n === base ? 'same name as this folder' : 'already in the repo', detail: 'Share memory with this project from your other machines or teammates', name: n })),
    { label: `New project "${fresh}"`, detail: 'Start separate memory for this folder', name: fresh },
  ];
  items.sort((a, b) => (b.name === base) - (a.name === base));
  const pick = await vscode.window.showQuickPick(items, { title: `Which project is ${path.basename(dir)}?`, ignoreFocusOut: true });
  return pick && pick.name;
}

async function pickFolder(node, placeHolder) {
  if (node && node.proj && node.proj.dir) return node.proj.dir;
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) {
    vscode.window.showWarningMessage('Open a project folder first.');
    return null;
  }
  const f = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder });
  return f && f.uri.fsPath;
}

function rememberRepo(dir) {
  const list = extCtx.globalState.get('repos', []);
  if (!list.some(p => samePath(p, dir))) extCtx.globalState.update('repos', [...list, dir]);
}

// ---------- personal sync ----------

async function enableProject(node) {
  const personal = personalRepos();
  let repo = personal.length ? personal[0].path : fs.existsSync(path.join(defaultRepoPath(), 'ccsync.js')) ? defaultRepoPath() : null;
  if (!repo) return setup();
  if (personal.length > 1) {
    const pick = await vscode.window.showQuickPick(personal.map(r => ({ label: path.basename(r.path), description: r.path, repo: r.path })), { title: 'Sync this folder through which personal repo?' });
    if (!pick) return;
    repo = pick.repo;
  }
  const dir = await pickFolder(node, 'Turn on sync for which folder?');
  if (!dir) return;
  const machine = await machineName();
  if (!machine) return;
  const name = await projectName(repo, dir);
  if (!name) return;
  const r = await act(`turning on sync for ${path.basename(dir)}`, repo, ['setup', '--project', name, '--dir', dir, '--machine', machine], vscode.ProgressLocation.Notification);
  if (r) {
    vscode.window.showInformationMessage(
      `Sync is on for ${path.basename(dir)}. Its memory now lives in your context repo, and you can tick chats to sync them. Claude sessions already open there pick this up after a restart.`,
    );
  }
}

async function enableAllProjects() {
  const todo = projects.filter(p => p.exists && !repoRoles(p).some(r => r.kind === 'personal'));
  if (!todo.length) return vscode.window.showInformationMessage('Every project folder on this machine is already synced.');
  const ok = 'Turn on';
  const pick = await vscode.window.showWarningMessage(
    `Turn on sync for ${todo.length} more project${todo.length > 1 ? 's' : ''}? Each project's memory moves into your personal context repo. Chats sync only once you tick them.`,
    { modal: true, detail: todo.map(p => p.dir).join('\n') },
    ok,
  );
  if (pick !== ok) return;
  for (const p of todo) await enableProject({ proj: p });
}

// ---------- creating and cloning repos ----------

const TEMPLATE = { 'ccsync.js': 'ccsync.js', 'README.md': 'README.md', gitattributes: '.gitattributes', gitignore: '.gitignore' };

async function ensureEmpty(target) {
  if (fs.existsSync(target) && fs.readdirSync(target).length) {
    vscode.window.showErrorMessage(`${target} already exists and isn't empty.`);
    return false;
  }
  return true;
}

async function createLocalRepo(target) {
  fs.mkdirSync(target, { recursive: true });
  for (const [from, to] of Object.entries(TEMPLATE)) fs.copyFileSync(path.join(extCtx.extensionPath, 'engine', from), path.join(target, to));
  await git(['init'], target);
  await git(['symbolic-ref', 'HEAD', 'refs/heads/main'], target);
  if (!(await git(['config', 'user.email'], target).catch(() => ''))) {
    const name = await vscode.window.showInputBox({ title: 'Your name for commits in this repo', ignoreFocusOut: true });
    const email = await vscode.window.showInputBox({ title: 'Your email for commits in this repo', ignoreFocusOut: true });
    if (!name || !email) return false;
    await git(['config', 'user.name', name], target);
    await git(['config', 'user.email', email], target);
  }
  await git(['add', '-A'], target);
  await git(['commit', '-q', '-m', 'Start Claude context repo'], target);
  return true;
}

async function publishToGitHub(target, description) {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Context Sync: creating the GitHub repo…' }, async () => {
    const token = await githubToken();
    const repo = await githubApi('POST', '/user/repos', token, { name: path.basename(target), private: true, description });
    await git(['remote', 'add', 'origin', repo.clone_url], target);
    try {
      await git(['push', '-q', '-u', 'origin', 'main'], target);
    } catch (e) {
      if (!GITHUB_AUTH.test(e.message)) throw e;
      await git([...authArgs(token), 'push', '-q', '-u', 'origin', 'main'], target);
      await offerGitCredential(token);
    }
    return repo.html_url;
  });
}

async function cloneInto(url, target) {
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Context Sync: cloning…' }, async () => {
    try {
      await git(['clone', url, target]);
    } catch (e) {
      if (!/github\.com/i.test(url) || !GITHUB_AUTH.test(e.message)) throw e;
      const token = await githubToken();
      fs.rmSync(target, { recursive: true, force: true });
      await git([...authArgs(token), 'clone', url, target]);
      await offerGitCredential(token);
    }
  });
}

async function useRepoFolder(folder) {
  const def = path.resolve(expandHome('~/claude-context'));
  await settings().update('repoPath', samePath(folder, def) ? '' : folder, vscode.ConfigurationTarget.Global);
  rememberRepo(folder);
}

async function setup() {
  if (personalRepos().length) {
    return vscode.window.showInformationMessage(`Context Sync is set up (${personalRepos().map(r => r.path).join(', ')}).`);
  }
  if (fs.existsSync(path.join(defaultRepoPath(), 'ccsync.js'))) return enableProject();
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(cloud-download) Clone my context repo', detail: 'It already exists on GitHub, set up from another machine.', id: 'clone' },
      { label: '$(new-folder) Create a new context repo', detail: 'Start fresh, with an optional private GitHub repo.', id: 'create' },
      { label: '$(folder-opened) Use a folder on this machine', detail: 'A context repo that is already cloned here.', id: 'folder' },
    ],
    { title: 'Set up your personal context repo', ignoreFocusOut: true },
  );
  if (!pick) return;
  try {
    if (pick.id === 'clone') {
      const url = await vscode.window.showInputBox({ title: 'Your context repo URL', placeHolder: 'https://github.com/<you>/claude-context.git', ignoreFocusOut: true });
      if (!url) return;
      const target = await vscode.window.showInputBox({ title: 'Clone it into', value: defaultRepoPath(), ignoreFocusOut: true });
      if (!target || !(await ensureEmpty(target))) return;
      await cloneInto(url, target);
      await useRepoFolder(target);
    } else if (pick.id === 'create') {
      const target = await vscode.window.showInputBox({ title: 'Create the context repo in', value: defaultRepoPath(), ignoreFocusOut: true });
      if (!target || !(await ensureEmpty(target)) || !(await createLocalRepo(target))) return;
      await useRepoFolder(target);
      const yes = 'Create private GitHub repo';
      if ((await vscode.window.showInformationMessage('Context repo created. Put it on GitHub so your other machines can reach it?', yes, 'Not now')) === yes) {
        const url = await publishToGitHub(target, 'Claude Code memory and chosen chats, synced between my machines');
        vscode.window.showInformationMessage(`Private repo created: ${url}`);
      }
    } else {
      const f = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title: 'Your context repo folder' });
      if (!f || !f[0]) return;
      if (!fs.existsSync(path.join(f[0].fsPath, 'ccsync.js'))) return vscode.window.showErrorMessage('That folder has no ccsync.js, so it is not a context repo.');
      await useRepoFolder(f[0].fsPath);
    }
    await refresh();
    if ((vscode.workspace.workspaceFolders || []).length) await enableProject();
  } catch (e) {
    out.appendLine(`setup: ${e.stack || e.message}`);
    vscode.window.showErrorMessage(`Context Sync setup failed: ${e.message}`, 'Show log').then(b => b && out.show());
  }
}

// ---------- teams: create and join ----------

async function teamSetup(target, dir, extra) {
  const person = await personName();
  if (!person) return null;
  const machine = await machineName();
  if (!machine) return null;
  const personalName = (chatProjects().find(p => samePath(p.dir, dir)) || {}).name;
  rememberRepo(target);
  await refresh();
  const name = await projectName(target, dir, personalName);
  if (!name) return null;
  return act(`connecting ${path.basename(dir)} to the team repo`, target, ['setup', '--project', name, '--dir', dir, '--machine', machine, '--person', person, ...extra], vscode.ProgressLocation.Notification);
}

async function createTeam(node) {
  const dir = await pickFolder(node, 'Share which folder with a team?');
  if (!dir) return;
  const target = await vscode.window.showInputBox({
    title: 'Create the team repo in',
    prompt: 'Only this project\'s team notes go here. Your private notes and chats stay in your personal repo.',
    value: path.join(teamsRoot(), `${cleanName(path.basename(dir)) || 'project'}-claude-team`),
    ignoreFocusOut: true,
  });
  if (!target || !(await ensureEmpty(target))) return;
  try {
    if (!(await createLocalRepo(target))) return;
    const url = await publishToGitHub(target, `Shared Claude Code memory for ${path.basename(dir)}`);
    const r = await teamSetup(target, dir, ['--team']);
    if (!r) return;
    const add = 'Add teammates on GitHub';
    const pick = await vscode.window.showInformationMessage(
      `Team repo ready: ${url}. Add teammates with write access; they use "Join a team repo". Their changes wait on their own branches until you accept them here or on GitHub.`,
      add,
    );
    if (pick === add) vscode.env.openExternal(vscode.Uri.parse(`${url}/settings/access`));
  } catch (e) {
    out.appendLine(`create team: ${e.stack || e.message}`);
    vscode.window.showErrorMessage(`Creating the team repo failed: ${e.message}`, 'Show log').then(b => b && out.show());
  }
}

async function joinTeam(node) {
  const dir = await pickFolder(node, 'Which folder is the team project?');
  if (!dir) return;
  const url = await vscode.window.showInputBox({ title: 'Team repo URL', placeHolder: 'https://github.com/<owner>/<project>-claude-team.git', ignoreFocusOut: true });
  if (!url) return;
  const name = (url.match(/([^/:]+?)(?:\.git)?\/?$/) || [])[1] || 'team';
  const target = await vscode.window.showInputBox({ title: 'Clone it into', value: path.join(teamsRoot(), name), ignoreFocusOut: true });
  if (!target || !(await ensureEmpty(target))) return;
  try {
    await cloneInto(url, target);
    const r = await teamSetup(target, dir, []);
    if (!r) return;
    const state = repos.find(x => samePath(x.path, target));
    const t = state && state.state && state.state.team;
    vscode.window.showInformationMessage(
      t && t.role === 'member'
        ? `Joined. The team's approved notes are in your memory under team/. What you add there goes to people/${t.person} and reaches the team once ${t.owner} accepts it.`
        : 'Joined as the owner. Teammates\' changes will show in the Team view.',
    );
  } catch (e) {
    out.appendLine(`join team: ${e.stack || e.message}`);
    vscode.window.showErrorMessage(`Joining the team repo failed: ${e.message}`, 'Show log').then(b => b && out.show());
  }
}

async function shareWithTeam(node) {
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(new-folder) Create a team repo', detail: 'You own it and review what teammates add.', id: 'create' },
      { label: '$(cloud-download) Join a team repo', detail: 'Someone already shared this project with you.', id: 'join' },
    ],
    { title: 'Share this project with a team' },
  );
  if (pick) await (pick.id === 'create' ? createTeam(node) : joinTeam(node));
}

// ---------- teams: review ----------

class ReviewContent {
  provideTextDocumentContent(uri) {
    const q = new URLSearchParams(uri.query);
    return engineIn(q.get('repo'), ['review', 'show', q.get('person'), q.get('path'), '--side', q.get('side')], false).catch(e => `(could not load: ${e.message})`);
  }
}

const reviewUri = (r, c, side) =>
  vscode.Uri.from({ scheme: REVIEW_SCHEME, path: `/${side}/${path.basename(c.path)}`, query: new URLSearchParams({ repo: r.path, person: c.person, path: c.path, side }).toString() });

function reviewDiff(node) {
  if (!node || !node.change) return;
  const { repo: r, change: c } = node;
  const owner = r.state.team.role === 'owner';
  const title = `${path.basename(c.path)}: ${owner ? `main ↔ ${c.person}` : 'approved ↔ yours'}`;
  return vscode.commands.executeCommand('vscode.diff', reviewUri(r, c, 'main'), reviewUri(r, c, 'theirs'), title, { preview: true });
}

async function reviewDecide(node, accept) {
  if (!node || !node.change) return;
  const { repo: r, change: c } = node;
  await act(`${accept ? 'accepting' : 'rejecting'} ${c.person}'s ${path.basename(c.path)}`, r.path, ['review', accept ? 'accept' : 'reject', c.person, c.path]);
}

async function reviewAcceptAll(node) {
  if (!node || !node.person) return;
  const ok = 'Accept all';
  const n = node.children.length;
  if ((await vscode.window.showWarningMessage(`Accept all ${n} change${n > 1 ? 's' : ''} from ${node.person} as they are?`, { modal: true }, ok)) !== ok) return;
  await act(`accepting everything from ${node.person}`, node.repo.path, ['review', 'accept-all', node.person]);
}

function openOnGitHub(node) {
  const r = node && node.repo;
  const web = r && githubWeb(r.state.remote);
  if (!web) return vscode.window.showWarningMessage('This team repo is not on GitHub.');
  const t = r.state.team;
  const url = node.kind === 'person' ? `${web}/compare/main...people/${node.person}` : t.role === 'owner' ? `${web}/pulls` : `${web}/compare/main...${t.branch}?expand=1`;
  vscode.env.openExternal(vscode.Uri.parse(url));
}

function claudeBinary() {
  const custom = settings().get('claudePath');
  if (custom) return custom;
  const ext = vscode.extensions.getExtension('anthropic.claude-code');
  if (ext) {
    const p = path.join(ext.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
    if (fs.existsSync(p)) return p;
  }
  return 'claude';
}

// Runs Claude Code headless with no tools, in an empty folder, on the user's own login.
function askClaude(prompt) {
  return new Promise((resolve, reject) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ccontext-merge-'));
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^CLAUDECODE$|^CLAUDE_CODE_/.test(k)) delete env[k];
    const args = ['-p', '--tools', '', '--no-session-persistence', '--model', settings().get('mergeModel') || 'sonnet'];
    const child = cp.spawn(claudeBinary(), args, { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 180e3);
    child.stdout.on('data', d => (stdout += d));
    child.stderr.on('data', d => (stderr += d));
    child.on('error', e => {
      clearTimeout(timer);
      reject(new Error(`Could not start Claude (${e.message}). Install the Claude Code extension or set claudeContext.claudePath.`));
    });
    child.on('close', code => {
      clearTimeout(timer);
      fs.rmSync(cwd, { recursive: true, force: true });
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || `Claude exited with ${code}`).trim().split('\n').slice(-3).join(' ')));
    });
    child.stdin.end(prompt);
  });
}

function mergePrompt(person, project, file, main, theirs) {
  return `You merge two versions of one memory note that Claude Code keeps for a software team (project "${project}", file ${file}).

MAIN is the approved version, kept by the project owner. PROPOSED comes from teammate "${person}".

Rules:
- Keep everything in MAIN unless PROPOSED clearly corrects or extends it.
- Add new facts from PROPOSED in the same style.
- Where they contradict and it is unclear who is right, keep MAIN's statement and add a line starting "Disputed (${person}):" with the proposed claim.
- Keep the frontmatter block (between --- lines) and its format.
- Never include passwords, tokens or keys; drop them.
- Be concise.

Reply with the merged note between <note> and </note>, then one to three short bullet points between <summary> and </summary> saying what changed.

<main>
${main || '(this note does not exist on main yet)'}
</main>

<proposed>
${theirs}
</proposed>
`;
}

async function reviewMerge(node) {
  if (!node || !node.change) return;
  const { repo: r, change: c } = node;
  if (c.kind === 'deleted') return vscode.window.showInformationMessage(`${c.person} deleted this note. Accept or reject the deletion; there is nothing to merge.`);
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Claude is merging ${c.person}'s ${path.basename(c.path)}…` },
      async () => {
        const [main, theirs] = await Promise.all([
          engineIn(r.path, ['review', 'show', c.person, c.path, '--side', 'main'], false),
          engineIn(r.path, ['review', 'show', c.person, c.path, '--side', 'theirs'], false),
        ]);
        const project = (r.state.projects[0] || {}).name || 'project';
        return askClaude(mergePrompt(c.person, project, path.basename(c.path), main, theirs));
      },
    );
    const note = (result.match(/<note>\s*([\s\S]*?)\s*<\/note>/) || [])[1];
    const said = (result.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/) || [])[1] || '';
    if (!note) throw new Error(`Claude's reply had no merged note:\n${result.slice(0, 300)}`);
    const file = path.join(r.path, '.local', 'review', c.person, path.basename(c.path));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${note}\n`);
    pendingMerges.set(normPath(file), { repo: r.path, person: c.person, path: c.path, file });
    await vscode.commands.executeCommand('vscode.diff', reviewUri(r, c, 'main'), vscode.Uri.file(file), `${path.basename(c.path)}: main ↔ merged by Claude (edit, then Accept)`);
    const accept = 'Accept merged version';
    const pick = await vscode.window.showInformationMessage(
      `Claude merged ${c.person}'s change. ${said.replace(/\s*\n\s*/g, ' ')} Edit the right side if needed, then accept (also in the editor's title bar).`,
      accept,
      'Discard',
    );
    if (pick === accept) await acceptMerged(file);
    else if (pick === 'Discard') await discardMerged(file);
  } catch (e) {
    out.appendLine(`merge with Claude: ${e.stack || e.message}`);
    vscode.window.showErrorMessage(`Merging with Claude failed: ${e.message}`, 'Show log').then(b => b && out.show());
  }
}

function activeMergeFile() {
  const doc = vscode.window.activeTextEditor && vscode.window.activeTextEditor.document;
  return doc && doc.uri.scheme === 'file' && pendingMerges.has(normPath(doc.uri.fsPath)) ? doc.uri.fsPath : null;
}

async function closeMergeEditors(file) {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      const uri = input && (input.modified || input.uri);
      if (uri && uri.scheme === 'file' && samePath(uri.fsPath, file)) await vscode.window.tabGroups.close(tab);
    }
  }
}

async function acceptMerged(fileArg) {
  const file = typeof fileArg === 'string' ? fileArg : activeMergeFile();
  const m = file && pendingMerges.get(normPath(file));
  if (!m) return;
  const doc = vscode.workspace.textDocuments.find(d => d.uri.scheme === 'file' && samePath(d.uri.fsPath, file));
  if (doc && doc.isDirty) await doc.save();
  const r = await act(`merging ${m.person}'s ${path.basename(m.path)}`, m.repo, ['review', 'accept', m.person, m.path, '--content-file', m.file]);
  if (r) {
    pendingMerges.delete(normPath(file));
    await closeMergeEditors(file);
    fs.rmSync(file, { force: true });
  }
}

async function discardMerged(fileArg) {
  const file = typeof fileArg === 'string' ? fileArg : activeMergeFile();
  if (!file) return;
  pendingMerges.delete(normPath(file));
  await closeMergeEditors(file);
  fs.rmSync(file, { force: true });
}

// ---------- Home page ----------

const HOME_COMMANDS = {
  setup: ['claudeContext.setup'],
  enable: ['claudeContext.enableProject'],
  sync: ['claudeContext.syncNow'],
  pick: ['claudeContext.pickChats'],
  current: ['claudeContext.syncCurrentChat'],
  repo: ['claudeContext.openRepo'],
  log: ['claudeContext.showLog'],
  problems: ['claudeContext.showNotices'],
  sidebar: ['workbench.view.extension.claudeContext'],
  team: ['claudeContext.team.focus'],
  createTeam: ['claudeContext.createTeam'],
  joinTeam: ['claudeContext.joinTeam'],
  settings: ['workbench.action.openSettings', 'claudeContext'],
};

function homeState() {
  const personal = personalRepos();
  const ps = chatProjects();
  const folders = vscode.workspace.workspaceFolders || [];
  const sum = summary();
  const first = personal[0];
  const remote = first && first.state.remote && /^https?:\/\//.test(first.state.remote) ? first.state.remote.replace(/\/\/[^@/]+@/, '//').replace(/\.git$/, '') : null;
  return {
    phase: !repos.length ? 'no-repo' : !personal.length ? 'not-configured' : 'ready',
    busy: busy > 0,
    machine: thisMachine(),
    remote,
    lastSync: sum.lastSync,
    offline: sum.offline,
    notices: sum.notices.length,
    projects: ps.length,
    notes: ps.reduce((a, p) => a + p.memory.files, 0),
    synced: sum.synced,
    chats: ps.reduce((a, p) => a + p.chats.length, 0),
    folder: folders.length ? path.basename(folders[0].uri.fsPath) : null,
    folderEnabled: !!workspaceProject(),
    teams: teamRepos().length,
    toReview: sum.toReview,
    waiting: sum.waiting,
  };
}

function postHomeState() {
  if (homePanel) homePanel.webview.postMessage(homeState());
}

function openHome() {
  homeShownThisSession = true;
  if (homePanel) return homePanel.reveal();
  homePanel = vscode.window.createWebviewPanel('claudeContext.home', 'Context Sync', vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [] });
  homePanel.iconPath = {
    light: vscode.Uri.file(path.join(extCtx.extensionPath, 'media', 'icon-light.svg')),
    dark: vscode.Uri.file(path.join(extCtx.extensionPath, 'media', 'icon.svg')),
  };
  homePanel.webview.html = homeHtml(crypto.randomBytes(16).toString('base64'));
  homePanel.webview.onDidReceiveMessage(msg => {
    if (msg && msg.cmd === 'ready') return postHomeState();
    const target = msg && HOME_COMMANDS[msg.cmd];
    if (target) vscode.commands.executeCommand(...target);
  });
  homePanel.onDidDispose(() => (homePanel = null));
}

// ---------- misc commands ----------

async function showNotices() {
  const notes = summary().notices;
  if (!notes.length) return vscode.window.showInformationMessage('No sync problems.');
  const pick = await vscode.window.showWarningMessage(notes.join('\n'), { modal: true }, 'Dismiss', 'Open log');
  if (pick === 'Dismiss') {
    for (const r of configured()) await engineIn(r.path, ['notices', '--clear'], false).catch(() => {});
    refresh();
  } else if (pick === 'Open log') {
    showLog();
  }
}

async function pickRepo(title) {
  const list = configured();
  if (list.length <= 1) return list[0];
  const pick = await vscode.window.showQuickPick(
    list.map(r => ({ label: path.basename(r.path), description: r.state.team ? `team (${r.state.team.role})` : 'personal', detail: r.path, r })),
    { title },
  );
  return pick && pick.r;
}

async function showLog() {
  const r = await pickRepo('Open the sync log of which repo?');
  const log = r && path.join(r.path, '.local', 'sync.log');
  if (!log || !fs.existsSync(log)) return vscode.window.showInformationMessage('No sync log yet.');
  vscode.window.showTextDocument(vscode.Uri.file(log), { preview: true });
}

async function openRepo() {
  const r = await pickRepo('Open which context repo?');
  if (!r) return;
  const web = githubWeb(r.state.remote);
  if (web) return vscode.env.openExternal(vscode.Uri.parse(web));
  vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(r.path));
}

// ---------- activation ----------

function activate(ctx) {
  extCtx = ctx;
  out = vscode.window.createOutputChannel('Context Sync');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  try {
    bundledVersion = Number((fs.readFileSync(bundledEngine(), 'utf8').match(/const ENGINE_VERSION = (\d+)/) || [])[1]) || 0;
  } catch {}
  chatTree = new Tree(chatRoots);
  projectTree = new Tree(() => projects.map(projectNode));
  teamTree = new Tree(() => teamRepos().map(teamRepoNode));
  const chatView = vscode.window.createTreeView('claudeContext.chats', { treeDataProvider: chatTree, manageCheckboxStateManually: true, showCollapseAll: true });
  const projectView = vscode.window.createTreeView('claudeContext.projects', { treeDataProvider: projectTree });
  const teamView = vscode.window.createTreeView('claudeContext.team', { treeDataProvider: teamTree, showCollapseAll: true });

  chatView.onDidChangeCheckboxState(e => {
    for (const [node, state] of e.items) {
      if (node.kind === 'chat') toggles.set(`${node.project.repo}|${node.chat.id}`, { on: state === Check.Checked, chat: { ...node.chat, repo: node.project.repo } });
    }
    applyTogglesSoon();
  });
  // Opening the sidebar before anything is set up shows Home, which explains what to do.
  chatView.onDidChangeVisibility(e => {
    if (e.visible && !homeShownThisSession && !configured().length) openHome();
  });

  const cmd = (id, fn) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  cmd('claudeContext.syncNow', () => syncAll(false));
  cmd('claudeContext.pullChat', () => syncAll(false));
  cmd('claudeContext.syncCurrentChat', syncCurrentChat);
  cmd('claudeContext.pickChats', pickChats);
  cmd('claudeContext.resumeChat', resumeChat);
  cmd('claudeContext.copyChatId', node => node && vscode.env.clipboard.writeText(node.chat.id));
  cmd('claudeContext.revealChat', node => node && vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(node.project.claudeDir, `${node.chat.id}.jsonl`))));
  cmd('claudeContext.enableProject', enableProject);
  cmd('claudeContext.enableAllProjects', enableAllProjects);
  cmd('claudeContext.setup', setup);
  cmd('claudeContext.createTeam', createTeam);
  cmd('claudeContext.joinTeam', joinTeam);
  cmd('claudeContext.shareWithTeam', shareWithTeam);
  cmd('claudeContext.reviewDiff', reviewDiff);
  cmd('claudeContext.reviewAccept', node => reviewDecide(node, true));
  cmd('claudeContext.reviewReject', node => reviewDecide(node, false));
  cmd('claudeContext.reviewMerge', reviewMerge);
  cmd('claudeContext.reviewAcceptAll', reviewAcceptAll);
  cmd('claudeContext.openTeamOnGitHub', openOnGitHub);
  cmd('claudeContext.shareChatWithTeam', shareChatWithTeam);
  cmd('claudeContext.unshareChatFromTeam', unshareChatFromTeam);
  cmd('claudeContext.acceptMerged', () => acceptMerged());
  cmd('claudeContext.discardMerged', () => discardMerged());
  cmd('claudeContext.showNotices', showNotices);
  cmd('claudeContext.showLog', showLog);
  cmd('claudeContext.openRepo', openRepo);
  cmd('claudeContext.refresh', () => refresh());
  cmd('claudeContext.openHome', openHome);

  ctx.subscriptions.push(
    out,
    statusItem,
    chatView,
    projectView,
    teamView,
    vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, new ReviewContent()),
    vscode.window.onDidChangeActiveTextEditor(() => vscode.commands.executeCommand('setContext', 'claudeContext.mergeActive', !!activeMergeFile())),
    { dispose: () => clearInterval(pullTimer) },
    { dispose: () => watchers.forEach(w => w.dispose()) },
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claudeContext.pullIntervalMinutes')) schedulePull();
      if (e.affectsConfiguration('claudeContext.repoPath') || e.affectsConfiguration('claudeContext.nodePath')) {
        watchKey = '';
        refresh();
      }
    }),
  );

  setContexts();
  renderStatus();
  refresh().then(() => setTimeout(backgroundPull, 4000));
  schedulePull();

  // Show Home after a first install or an update.
  const version = ctx.extension.packageJSON.version;
  if (ctx.globalState.get('homeShownForVersion') !== version) {
    ctx.globalState.update('homeShownForVersion', version);
    openHome();
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
