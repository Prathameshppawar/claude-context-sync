#!/usr/bin/env node
// ccsync: keeps Claude Code memory and chosen chats in this git repo so another
// machine can pick them up. Node 18+ and git only, no packages. See README.md.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const readline = require('readline');
const { spawn, spawnSync } = require('child_process');

const REPO = __dirname;
const LOCAL = path.join(REPO, '.local'); // per-machine, git-ignored
const CFG_FILE = path.join(LOCAL, 'config.json');
const STATE_FILE = path.join(LOCAL, 'state.json');
const LOG_FILE = path.join(LOCAL, 'sync.log');
const NOTICE_FILE = path.join(LOCAL, 'notices.txt');
const LOCK_FILE = path.join(LOCAL, 'sync.lock');
const ENGINE_VERSION = 3; // bump when other copies of this file should update themselves
const TEAM_FILE = path.join(REPO, 'team.json'); // present = a team repo: { owner, created }
const REVIEW_FILE = path.join(REPO, 'review.json'); // the owner's decisions on teammates' changes
const TEAM_BLOCK_START = '<!-- claude-context: team notes, copied from team/MEMORY.md. Do not edit here. -->';
const TEAM_BLOCK_END = '<!-- /claude-context: team notes -->';
const CHUNK_BYTES = 1 << 20; // chats are stored in ~1 MiB gzip pieces
const CHAT_EVERY_MS = 20 * 60 * 1000; // after a reply, chats push at most this often
const BUSY_MS = 90 * 1000; // a chat written this recently is treated as open
const PH = '{{CCSYNC_PROJECT}}';
const IS_WIN = process.platform === 'win32';
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// ---------- small helpers ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
const fwd = p => p.replace(/\\/g, '/');
const normPath = p => (IS_WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
const samePath = (a, b) => normPath(a) === normPath(b);
const totalBytes = chunks => chunks.reduce((n, c) => n + c.bytes, 0);
const fmtBytes = n => (n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

function when(ms) {
  const d = new Date(ms);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function log(msg) {
  try {
    fs.mkdirSync(LOCAL, { recursive: true });
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 512 * 1024) {
      fs.writeFileSync(LOG_FILE, fs.readFileSync(LOG_FILE, 'utf8').slice(-256 * 1024));
    }
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${msg}\n`);
  } catch {}
}

function notice(msg) {
  log('NOTICE ' + msg);
  try {
    fs.mkdirSync(LOCAL, { recursive: true });
    fs.appendFileSync(NOTICE_FILE, msg + '\n');
  } catch {}
}

function dropNotices(containing) {
  try {
    const keep = fs.readFileSync(NOTICE_FILE, 'utf8').split('\n').filter(l => l && !l.includes(containing));
    if (keep.length) fs.writeFileSync(NOTICE_FILE, keep.join('\n') + '\n');
    else fs.unlinkSync(NOTICE_FILE);
  } catch {}
}

function takeNotices() {
  try {
    const lines = [...new Set(fs.readFileSync(NOTICE_FILE, 'utf8').split('\n').filter(Boolean))];
    fs.unlinkSync(NOTICE_FILE);
    return lines;
  } catch {
    return [];
  }
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

// ---------- config, state, paths ----------

function loadConfig(required = true) {
  const cfg = readJson(CFG_FILE, null);
  if (!cfg && required) {
    die('This machine is not set up yet. Run: node ccsync.js setup --project <name> --dir <project folder>');
  }
  return cfg;
}

function loadState() {
  const st = readJson(STATE_FILE, {});
  st.chats = st.chats || {};
  st.forks = st.forks || {};
  st.titles = st.titles || {};
  return st;
}

const saveState = st => writeJson(STATE_FILE, st);

// Claude keeps a project's chats and memory under ~/.claude/projects/<folder path with
// every non-alphanumeric character turned into '-'>.
function claudeProjectDir(dir) {
  const slug = path.resolve(dir).replace(/[^A-Za-z0-9]/g, '-');
  const root = path.join(CLAUDE_DIR, 'projects');
  try {
    const names = fs.readdirSync(root);
    const hit = names.find(n => n === slug) || (IS_WIN && names.find(n => n.toLowerCase() === slug.toLowerCase()));
    if (hit) return path.join(root, hit);
  } catch {}
  return path.join(root, slug);
}

const repoProject = proj => path.join(REPO, 'projects', proj);
const repoMemory = proj => path.join(repoProject(proj), 'memory');
const repoChats = proj => path.join(repoProject(proj), 'chats');
const repoChat = (proj, id) => path.join(repoChats(proj), id);
const transcript = (cfg, proj, id) => path.join(claudeProjectDir(cfg.projects[proj].dir), id + '.jsonl');

function selectedIds(proj) {
  try {
    return fs.readdirSync(repoChats(proj)).filter(id => fs.existsSync(path.join(repoChat(proj, id), 'meta.json')));
  } catch {
    return [];
  }
}

// ---------- transcript text ----------

const jsonEsc = s => JSON.stringify(s).slice(1, -1);
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function rootOf(dir, win) {
  const P = win ? path.win32 : path.posix;
  return jsonEsc(P.resolve(dir).replace(/[\\/]+$/, ''));
}

// Every transcript line records the working folder ("cwd"). Stored copies swap the
// project folder for a placeholder, so one chat is byte-identical on every machine.
function normalizer(dir, win = IS_WIN) {
  const re = new RegExp('"cwd":"' + reEsc(rootOf(dir, win)) + '((?:\\\\\\\\|/)[^"]*)?"', win ? 'gi' : 'g');
  return text => text.replace(re, (m, rest) => '"cwd":"' + PH + (rest || '').replace(/\\\\/g, '/') + '"');
}

function denormalizer(dir, win = IS_WIN) {
  const root = rootOf(dir, win);
  const sep = win ? '\\\\' : '/';
  const re = new RegExp('"cwd":"' + reEsc(PH) + '([^"]*)"', 'g');
  return text => text.replace(re, (m, rest) => '"cwd":"' + root + rest.replace(/\//g, sep) + '"');
}

// Pieces end on line boundaries and close once they pass CHUNK_BYTES, so a longer
// version of the same chat shares every piece but the last with a shorter one.
function splitChunks(buf) {
  const out = [];
  for (let start = 0; start < buf.length; ) {
    let stop = start;
    while (stop < buf.length && stop - start < CHUNK_BYTES) {
      const nl = buf.indexOf(10, stop);
      stop = nl < 0 ? buf.length : nl + 1;
    }
    const data = buf.subarray(start, stop);
    out.push({ sha: sha(data), bytes: data.length, data });
    start = stop;
  }
  return out;
}

function readChat(cfg, proj, file) {
  const text = fs.readFileSync(file, 'utf8');
  const complete = text.slice(0, text.lastIndexOf('\n') + 1); // a half-written last line waits
  return splitChunks(Buffer.from(normalizer(cfg.projects[proj].dir)(complete), 'utf8'));
}

const chunkData = c => c.data || (c.data = zlib.gunzipSync(fs.readFileSync(c.file)));

function manifests(proj, id) {
  const dir = repoChat(proj, id);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter(n => /^manifest\..+\.json$/.test(n))
    .map(n => {
      const m = readJson(path.join(dir, n), null);
      if (!m || !Array.isArray(m.chunks)) return null;
      for (const c of m.chunks) c.file = path.join(dir, 'chunks', c.sha + '.gz');
      return m;
    })
    .filter(Boolean);
}

// How copy b relates to copy a: 'same', 'a-behind' (b continues a), 'a-ahead'
// (a continues b) or 'diverged'.
function relation(a, b) {
  const ab = totalBytes(a);
  const bb = totalBytes(b);
  if (ab === bb && a.length === b.length && a.every((c, i) => c.sha === b[i].sha)) return 'same';
  const aShort = ab <= bb;
  const [s, l] = aShort ? [a, b] : [b, a];
  const k = s.length - 1;
  if (k >= 0) {
    for (let i = 0; i < k; i++) if (!l[i] || s[i].sha !== l[i].sha) return 'diverged';
    if (!l[k]) return 'diverged';
    if (s[k].sha !== l[k].sha) {
      const x = chunkData(s[k]);
      const y = chunkData(l[k]);
      if (y.length < x.length || !y.subarray(0, x.length).equals(x)) return 'diverged';
    }
  }
  if (ab === bb) return 'diverged';
  return aShort ? 'a-behind' : 'a-ahead';
}

function safeRelation(a, b) {
  try {
    return relation(a, b);
  } catch (e) {
    log(`compare failed: ${e.message}`);
    return 'unknown';
  }
}

function lastLine(text, needle) {
  const i = text.lastIndexOf(needle);
  if (i < 0) return null;
  const s = text.lastIndexOf('\n', i) + 1;
  let e = text.indexOf('\n', i);
  if (e < 0) e = text.length;
  try {
    return JSON.parse(text.slice(s, e));
  } catch {
    return null;
  }
}

function firstPrompt(text) {
  let pos = 0;
  for (let n = 0; n < 500 && pos < text.length; n++) {
    let e = text.indexOf('\n', pos);
    if (e < 0) e = text.length;
    const line = text.slice(pos, e);
    pos = e + 1;
    if (!line.includes('"type":"user"')) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type !== 'user' || o.isMeta || !o.message) continue;
    const c = o.message.content;
    const parts = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter(p => p.type === 'text').map(p => p.text) : [];
    const t = parts.find(p => p && !p.trimStart().startsWith('<'));
    if (t) return t;
  }
  return '';
}

let titlesDirty = false;

function titleOf(st, file) {
  const s = fs.statSync(file);
  const id = path.basename(file, '.jsonl');
  const hit = st.titles[id];
  if (hit && hit.size === s.size && hit.mtimeMs === s.mtimeMs) return hit.title;
  titlesDirty = true;
  const text = fs.readFileSync(file, 'utf8');
  const custom = lastLine(text, '{"type":"custom-title"');
  const ai = lastLine(text, '{"type":"ai-title"');
  const title = ((custom && custom.customTitle) || (ai && ai.aiTitle) || firstPrompt(text) || '(empty chat)')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
  st.titles[id] = { size: s.size, mtimeMs: s.mtimeMs, title };
  return title;
}

function localChats(cfg, st) {
  const out = [];
  for (const proj of Object.keys(cfg.projects)) {
    const dir = claudeProjectDir(cfg.projects[proj].dir);
    const selected = new Set(selectedIds(proj));
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {}
    for (const n of names) {
      if (!/^[0-9a-f-]{36}\.jsonl$/.test(n)) continue;
      const file = path.join(dir, n);
      const s = fs.statSync(file);
      if (!s.size) continue;
      const id = n.slice(0, -6);
      out.push({ proj, id, file, size: s.size, mtimeMs: s.mtimeMs, synced: selected.has(id) });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  out.forEach((c, i) => {
    c.n = i + 1;
    c.title = titleOf(st, c.file);
  });
  return out;
}

// ---------- export / import ----------

function exportChat(cfg, st, proj, id, force) {
  const file = transcript(cfg, proj, id);
  if (!fs.existsSync(file)) return false;
  const s = fs.statSync(file);
  const prev = st.chats[id] || {};
  if (!force && prev.size === s.size && prev.mtimeMs === s.mtimeMs) return false;

  const local = readChat(cfg, proj, file);
  const all = manifests(proj, id);
  const mine = all.find(m => m.machine === cfg.machine);
  const others = all.filter(m => m.machine !== cfg.machine);
  // An older state of another machine's copy: leave it for import to refresh.
  if (others.some(m => safeRelation(local, m.chunks) === 'a-behind')) return false;

  const record = () => {
    st.chats[id] = { ...prev, size: s.size, mtimeMs: s.mtimeMs };
  };
  if (mine && mine.chunks.length === local.length && mine.chunks.every((c, i) => c.sha === local[i].sha)) {
    record();
    return false;
  }
  const chunkDir = path.join(repoChat(proj, id), 'chunks');
  fs.mkdirSync(chunkDir, { recursive: true });
  for (const c of local) {
    const f = path.join(chunkDir, c.sha + '.gz');
    if (!fs.existsSync(f)) fs.writeFileSync(f, zlib.gzipSync(c.data));
  }
  writeJson(path.join(repoChat(proj, id), `manifest.${cfg.machine}.json`), {
    session: id,
    project: proj,
    machine: cfg.machine,
    updated: new Date().toISOString(),
    bytes: totalBytes(local),
    chunks: local.map(c => ({ sha: c.sha, bytes: c.bytes })),
  });
  // Drop pieces that no machine's manifest needs any more.
  const keep = new Set(local.map(c => c.sha));
  for (const m of others) for (const c of m.chunks) keep.add(c.sha);
  for (const f of fs.readdirSync(chunkDir)) {
    if (!keep.has(f.replace(/\.gz$/, ''))) fs.unlinkSync(path.join(chunkDir, f));
  }
  record();
  return true;
}

function forkId(id, machine) {
  const h = crypto.createHash('sha256').update(`${id}|${machine}`).digest('hex');
  const v = (8 | (parseInt(h[16], 16) & 3)).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${v}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function writeChat(cfg, proj, file, chunks, fork) {
  let text = denormalizer(cfg.projects[proj].dir)(Buffer.concat(chunks.map(chunkData)).toString('utf8'));
  if (fork) {
    text = text.split(`"sessionId":"${fork.from}"`).join(`"sessionId":"${fork.to}"`);
    text += JSON.stringify({ type: 'custom-title', sessionId: fork.to, customTitle: fork.title }) + '\n';
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

const isBusy = (file, id, activeId) =>
  id === activeId || (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < BUSY_MS);

function importChat(cfg, st, proj, id, activeId, report) {
  const others = manifests(proj, id).filter(m => m.machine !== cfg.machine);
  if (!others.length) return;
  const sig = sha(others.map(m => m.machine + ':' + m.chunks.map(c => c.sha).join(',')).sort().join('|'));
  const file = transcript(cfg, proj, id);
  const exists = fs.existsSync(file);
  const s = exists ? fs.statSync(file) : null;
  const prev = st.chats[id] || {};
  if (exists && prev.remoteSig === sig && prev.size === s.size && prev.mtimeMs === s.mtimeMs) return;

  const local = exists ? readChat(cfg, proj, file) : [];
  let best = null;
  const forks = [];
  for (const m of others) {
    const rel = safeRelation(local, m.chunks);
    if (rel === 'a-behind') {
      if (!best || m.bytes > best.bytes) best = m;
    } else if (rel === 'diverged') {
      forks.push(m);
    }
  }
  const title = exists ? titleOf(st, file) : readJson(path.join(repoChat(proj, id), 'meta.json'), {}).title || id;

  if (best) {
    if (isBusy(file, id, activeId)) {
      notice(`"${title}" has newer messages from ${best.machine}, but it is open here, so it was not replaced. Start a new chat, then /resume it.`);
      return; // sig not recorded: try again next sync
    }
    writeChat(cfg, proj, file, best.chunks);
    dropNotices(`"${title}" has newer messages`);
    report.imported.push(`${title} (from ${best.machine})`);
  }
  // Continued on two machines: show the other machine's version as its own chat.
  for (const m of forks) {
    const fid = forkId(id, m.machine);
    const ffile = transcript(cfg, proj, fid);
    const was = st.forks[fid];
    if (fs.existsSync(ffile)) {
      const fs2 = fs.statSync(ffile);
      if (!was || was.size !== fs2.size || was.mtimeMs !== fs2.mtimeMs) continue; // continued here: leave it
      if (was.sig === sig) continue;
    }
    if (isBusy(ffile, fid, activeId)) continue;
    const ftitle = `${title} (${m.machine} copy)`;
    writeChat(cfg, proj, ffile, m.chunks, { from: id, to: fid, title: ftitle });
    const fs3 = fs.statSync(ffile);
    st.forks[fid] = { size: fs3.size, mtimeMs: fs3.mtimeMs, sig };
    report.forked.push(ftitle);
  }
  const now = fs.existsSync(file) ? fs.statSync(file) : null;
  st.chats[id] = { ...prev, remoteSig: sig, size: now && now.size, mtimeMs: now && now.mtimeMs };
}

// ---------- git ----------

const GIT_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_HTTP_LOW_SPEED_LIMIT: '1000',
  GIT_HTTP_LOW_SPEED_TIME: '20',
};

function git(args, timeout = 60000) {
  const r = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    env: { ...process.env, ...GIT_ENV },
  });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  if (r.status !== 0) log(`git ${args.join(' ')} -> ${r.status ?? r.error}: ${out.slice(0, 500)}`);
  return { ok: r.status === 0, out };
}

// File contents from git, byte for byte (git() trims its output).
function gitBlob(spec) {
  const r = spawnSync('git', ['show', spec], { cwd: REPO, windowsHide: true, maxBuffer: 256 << 20, env: { ...process.env, ...GIT_ENV } });
  return r.status === 0 ? r.stdout : null;
}

const inRebase = () => ['rebase-merge', 'rebase-apply'].some(d => fs.existsSync(path.join(REPO, '.git', d)));
const inMerge = () => fs.existsSync(path.join(REPO, '.git', 'MERGE_HEAD'));
const refExists = ref => git(['rev-parse', '--verify', '-q', ref]).ok;
const blobAt = spec => {
  const r = git(['rev-parse', '-q', '--verify', spec]);
  return r.ok ? r.out : null;
};
const conflicted = () => git(['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);

function unpushed(branch) {
  if (!refExists(`origin/${branch}`)) return refExists('HEAD') ? 1 : 0;
  const r = git(['rev-list', '--count', `origin/${branch}..HEAD`]);
  return r.ok ? Number(r.out) || 0 : 0;
}

// ---------- teams ----------
//
// A team repo has team.json naming its owner. The owner's machines write `main`. A
// teammate's machines write only `people/<name>` and take `main` in, so a teammate's
// notes reach anyone else only once the owner accepts them.

const cleanName = s => String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
const defaultPerson = () => cleanName(os.userInfo().username) || 'me';
const teamInfo = () => readJson(TEAM_FILE, null);

function whoAmI(cfg) {
  const team = teamInfo();
  if (!team) return { team: null, role: 'solo', person: cfg.person || null, branch: 'main' };
  if (cfg.person && cfg.person === team.owner) return { team, role: 'owner', person: cfg.person, branch: 'main' };
  return { team, role: 'member', person: cfg.person, branch: `people/${cfg.person}` };
}

function ensureBranch(who) {
  if (who.role === 'member') {
    // Teammates merge `main` in as a normal 3-way merge that keeps their own side,
    // not the line-union the owner's machines use between themselves.
    const attrs = path.join(REPO, '.git', 'info', 'attributes');
    fs.mkdirSync(path.dirname(attrs), { recursive: true });
    if (!fs.existsSync(attrs) || !fs.readFileSync(attrs, 'utf8').includes('projects/*/memory/** merge')) {
      fs.appendFileSync(attrs, 'projects/*/memory/** merge\n');
    }
  }
  if (git(['rev-parse', '--abbrev-ref', 'HEAD']).out === who.branch) return;
  if (refExists(`refs/heads/${who.branch}`)) git(['checkout', '-q', who.branch]);
  else if (refExists(`origin/${who.branch}`)) git(['checkout', '-q', '-b', who.branch, `origin/${who.branch}`]);
  else git(['checkout', '-q', '-b', who.branch]);
}

function readReview(ref) {
  if (!ref) return readJson(REVIEW_FILE, {});
  const raw = gitBlob(`${ref}:review.json`);
  try {
    return raw ? JSON.parse(raw.toString('utf8')) : {};
  } catch {
    return {};
  }
}

// Memory files in a commit: path -> blob id.
function memoryBlobs(ref) {
  const out = new Map();
  const r = git(['ls-tree', '-r', ref, '--', 'projects']);
  if (!r.ok) return out;
  for (const line of r.out.split('\n')) {
    const m = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
    if (m && /^projects\/[^/]+\/memory\//.test(m[2])) out.set(m[2], m[1]);
  }
  return out;
}

// What `theirs` changed in memory since it last took in `main`, minus what the owner
// has already decided on.
function pendingChanges(person, theirs, main, review) {
  if (!refExists(theirs) || !refExists(main)) return [];
  const base = git(['merge-base', main, theirs]);
  const B = base.ok ? memoryBlobs(base.out) : new Map();
  const M = memoryBlobs(main);
  const T = memoryBlobs(theirs);
  const decided = (review || {})[person] || {};
  const out = [];
  for (const p of new Set([...B.keys(), ...M.keys(), ...T.keys()])) {
    const b = B.get(p) || null;
    const m = M.get(p) || null;
    const t = T.get(p) || null;
    if (t === b || t === m) continue;
    if (decided[p] && decided[p].sha === t) continue;
    out.push({ person, path: p, kind: !t ? 'deleted' : !m ? 'added' : 'modified', theirs: t, main: m, base: b });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function peopleBranches() {
  const r = git(['for-each-ref', '--format=%(refname:strip=4)', 'refs/remotes/origin/people']);
  return r.ok ? r.out.split('\n').filter(Boolean) : [];
}

// A teammate's machine drops what the owner rejected or rewrote: a file still exactly
// as it was when reviewed goes back to main's version.
function applyReviews(who) {
  const mine = readReview('origin/main')[who.person] || {};
  let changed = 0;
  for (const [p, rec] of Object.entries(mine)) {
    const cur = blobAt(`HEAD:${p}`);
    if (cur !== rec.sha) continue;
    const onMain = blobAt(`origin/main:${p}`);
    if (onMain === cur) continue;
    if (onMain) git(['checkout', 'origin/main', '--', p]);
    else if (cur) git(['rm', '-q', '--', p]);
    else continue;
    changed++;
  }
  if (changed) git(['commit', '-q', '-m', `${who.person}: apply the owner's review (${changed} note${changed > 1 ? 's' : ''})`]);
}

// Teammates merge (their branch carries merge commits); this machine's side wins.
function mergeIn(ref, label) {
  if (!refExists(ref) || git(['merge-base', '--is-ancestor', ref, 'HEAD']).ok) return true;
  const r = git(['-c', 'core.editor=true', 'merge', '-q', '--no-edit', '-X', 'ours', '-m', `merge ${label}`, ref]);
  if (r.ok) return true;
  const files = conflicted();
  for (const f of files) {
    if (git(['checkout', '--ours', '--', f]).ok) git(['add', '--', f]);
    else git(['rm', '-q', '--', f]);
  }
  if (files.length) notice(`Sync conflict in ${files.join(', ')}: kept your version; the other is in git history.`);
  git(['-c', 'core.editor=true', 'commit', '-q', '--no-edit']);
  if (!inMerge()) return true;
  git(['merge', '--abort']);
  notice(`Sync could not merge ${label}. Run: node ccsync.js status`);
  return false;
}

// The team notes appear in the private index too, so Claude sees them every session.
function refreshTeamIndex(cfg) {
  const team = teamInfo();
  if (!team) return;
  for (const [proj, p] of Object.entries(cfg.projects)) {
    if (!p.attach) continue;
    let lines = [];
    try {
      lines = fs.readFileSync(path.join(repoMemory(proj), 'MEMORY.md'), 'utf8').split(/\r?\n/).filter(l => /^\s*[-*] /.test(l));
    } catch {}
    lines = lines.map(l => l.replace(/\]\((?!https?:|team\/)([^)]+)\)/g, '](team/$1)'));
    const block = [
      TEAM_BLOCK_START,
      `## Team notes (shared with the ${proj} team; ${team.owner} reviews changes)`,
      'Notes in team/ are shared with everyone on the project. Put a note there only if the whole team should have it, and never with passwords, tokens or keys. Its index line goes in team/MEMORY.md, not here.',
      ...(lines.length ? lines : ['- (no team notes yet)']),
      TEAM_BLOCK_END,
    ];
    const file = path.join(p.attach, 'MEMORY.md');
    let text = '';
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {}
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const s = text.indexOf(TEAM_BLOCK_START);
    const e = text.indexOf(TEAM_BLOCK_END);
    const body = block.join(eol);
    const next = s >= 0 && e > s ? text.slice(0, s) + body + text.slice(e + TEAM_BLOCK_END.length) : `${text.replace(/\s*$/, '')}${text.trim() ? eol + eol : ''}${body}${eol}`;
    if (next !== text) fs.writeFileSync(file, next);
  }
}

function commit(cfg) {
  git(['add', '-A', '--', 'projects']);
  const names = git(['diff', '--cached', '--name-only']).out.split('\n').filter(Boolean);
  if (!names.length) return 0;
  const mem = names.filter(n => n.includes('/memory/')).length;
  const chats = new Set(names.map(n => (n.match(/\/chats\/([^/]+)\//) || [])[1]).filter(Boolean)).size;
  const parts = [mem && `${mem} memory file${mem > 1 ? 's' : ''}`, chats && `${chats} chat${chats > 1 ? 's' : ''}`];
  git(['commit', '-q', '-m', `${cfg.machine}: ${parts.filter(Boolean).join(', ') || 'sync'}`]);
  return names.length;
}

function pull(report, who) {
  if (!git(['fetch', '-q', '--prune', 'origin'], 45000).ok) {
    report.offline = true;
    return false;
  }
  if (who.role !== 'member') return rebaseOnto(`origin/${who.branch}`);
  // A teammate: their own other machines first, then the owner's decisions, then main.
  if (!mergeIn(`origin/${who.branch}`, `${who.person}'s other machines`)) return false;
  applyReviews(who);
  return mergeIn('origin/main', 'the approved context from main');
}

function rebaseOnto(ref) {
  if (!refExists(ref)) return true;
  if (git(['merge-base', '--is-ancestor', ref, 'HEAD']).ok) return true;
  let r = git(['rebase', '-q', ref]);
  // Memory notes merge line by line (union, see .gitattributes). Anything still in
  // conflict keeps this machine's side; the other side stays in git history.
  for (let i = 0; !r.ok && inRebase() && i < 200; i++) {
    const files = git(['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean);
    if (!files.length) {
      r = git(['rebase', '--skip']);
      continue;
    }
    for (const f of files) {
      // During a rebase "theirs" is the commit being replayed, i.e. this machine's.
      if (git(['checkout', '--theirs', '--', f]).ok) git(['add', '--', f]);
      else git(['rm', '-q', '--', f]);
    }
    notice(`Sync conflict in ${files.join(', ')}: kept this machine's version; the other is in git history.`);
    r = git(['-c', 'core.editor=true', 'rebase', '--continue']);
  }
  if (inRebase()) {
    git(['rebase', '--abort']);
    notice('Sync could not merge with the other machine. Run: node ccsync.js status');
    return false;
  }
  return r.ok;
}

function push(report, who) {
  for (let i = 0; i < 3; i++) {
    if (!unpushed(who.branch)) return true;
    const r = git(['push', '-q', 'origin', `HEAD:${who.branch}`], 120000);
    if (r.ok) return true;
    if (!/rejected|non-fast-forward|fetch first/i.test(r.out)) {
      report.offline = true;
      return false;
    }
    if (!pull(report, who)) return false;
  }
  return false;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

let lockHeld = false;
process.on('exit', () => {
  if (lockHeld) {
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {}
  }
});

function withLock(waitMs, fn) {
  fs.mkdirSync(LOCAL, { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
      lockHeld = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age;
      let owner;
      try {
        age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs;
        owner = Number(fs.readFileSync(LOCK_FILE, 'utf8'));
      } catch {
        continue;
      }
      // A sync killed mid-way (window closed, parent exited) never releases its lock.
      if (age > 10 * 60 * 1000 || (owner && age > 2000 && !pidAlive(owner))) {
        log(`removed a lock left by process ${owner || '?'}`);
        try {
          fs.unlinkSync(LOCK_FILE);
        } catch {}
        continue;
      }
      if (Date.now() - t0 >= waitMs) return null;
      sleep(300);
    }
  }
  try {
    return fn();
  } finally {
    lockHeld = false;
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {}
  }
}

// ---------- sync ----------

// opts.chats: 'none' | 'due' | 'all'; opts.lazy: skip the network unless something
// changed here; opts.push; opts.activeId: the chat open in this session.
function sync(opts) {
  const report = syncLocked(opts);
  if (report === null) log(`sync skipped, another one is running (chats: ${opts.chats}${opts.lazy ? ', lazy' : ''})`);
  return report;
}

// Undo what an interrupted sync can leave behind in git.
function recoverGit() {
  const index = path.join(REPO, '.git', 'index.lock');
  try {
    if (Date.now() - fs.statSync(index).mtimeMs > 120e3) {
      fs.unlinkSync(index);
      log('removed a stale .git/index.lock');
    }
  } catch {}
  if (inRebase()) {
    git(['rebase', '--abort']);
    log('aborted a rebase left by an interrupted sync');
  }
  if (inMerge()) {
    git(['merge', '--abort']);
    log('aborted a merge left by an interrupted sync');
  }
}

function syncLocked(opts) {
  const cfg = loadConfig();
  return withLock(opts.wait ?? 60000, () => {
    recoverGit();
    const who = whoAmI(cfg);
    ensureBranch(who);
    const st = loadState();
    const report = { exported: [], imported: [], forked: [], offline: false, pushed: false, pulled: false };
    const projects = Object.keys(cfg.projects);
    const chatsDue = opts.chats === 'all' || (opts.chats === 'due' && Date.now() - (st.lastChatExport || 0) >= CHAT_EVERY_MS);
    if (chatsDue) {
      for (const p of projects) {
        for (const id of selectedIds(p)) {
          try {
            if (exportChat(cfg, st, p, id, false)) report.exported.push(id);
          } catch (e) {
            log(`export ${id}: ${e.stack || e}`);
          }
        }
      }
      st.lastChatExport = Date.now();
    }
    const committed = commit(cfg);
    if (!opts.lazy || committed || unpushed(who.branch)) {
      report.pulled = pull(report, who);
      if (who.team) refreshTeamIndex(cfg);
      if (report.pulled) {
        for (const p of projects) {
          for (const id of selectedIds(p)) {
            try {
              importChat(cfg, st, p, id, opts.activeId, report);
            } catch (e) {
              log(`import ${id}: ${e.stack || e}`);
              notice(`Could not update chat ${id} from the other machine: ${e.message}`);
            }
          }
        }
        if (opts.push) report.pushed = push(report, who);
      }
      st.lastSync = { at: new Date().toISOString(), pulled: report.pulled, pushed: report.pushed, offline: report.offline };
    }
    saveState(st);
    log(`sync ${JSON.stringify({ chats: opts.chats, lazy: !!opts.lazy, committed, ...report })}`);
    return report;
  });
}

function printReport(r, json) {
  if (json) return console.log(JSON.stringify({ ...(r || {}), busy: !r, notices: takeNotices() }));
  if (!r) return console.log('Another sync is running; try again in a minute.');
  const lines = [];
  if (r.exported.length) lines.push(`Sent ${r.exported.length} chat${r.exported.length > 1 ? 's' : ''}.`);
  for (const t of r.imported) lines.push(`Updated: ${t}`);
  for (const t of r.forked) lines.push(`Added the other machine's version: ${t}`);
  if (r.offline) lines.push('Could not reach GitHub; changes are saved locally and will go next time.');
  else lines.push(r.pushed ? 'Synced with GitHub.' : 'Pulled from GitHub; nothing pushed.');
  for (const n of takeNotices()) lines.push(n);
  console.log(lines.join('\n'));
}

// ---------- hooks ----------

function readHookInput() {
  if (process.stdin.isTTY) return {};
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  } catch {
    return {};
  }
}

function background(args) {
  const child = spawn(process.execPath, [__filename, ...args], { cwd: REPO, detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

function hook(kind) {
  const input = readHookInput();
  if (!loadConfig(false)) return;
  const active = input.session_id ? ['--active', input.session_id] : [];
  if (kind === 'start') {
    if (input.source === 'clear' || input.source === 'compact') return;
    // Pull now so /resume lists the other machine's chats; send ours afterwards.
    const r = sync({ chats: 'none', push: false, activeId: input.session_id, wait: 20000 });
    background(['sync', '--chats', 'all', '--quiet', ...active]);
    const lines = [];
    if (r && r.imported.length) lines.push('Chats updated from the other machine: ' + r.imported.join('; '));
    if (r && r.forked.length) lines.push('Continued on both machines, so the other version was added as its own chat: ' + r.forked.join('; '));
    if (r && r.offline) lines.push('Offline: memory and chats were not pulled this time.');
    const team = teamModel(loadConfig());
    if (team && team.role === 'owner' && team.pending.length) {
      const people = [...new Set(team.pending.map(c => c.person))].join(', ');
      lines.push(`${team.pending.length} team note change(s) from ${people} wait for the owner's review (Claude Context sidebar → Team, or GitHub).`);
    }
    lines.push(...takeNotices());
    if (lines.length) console.log('[claude-context sync]\n' + lines.join('\n'));
  } else if (kind === 'stop') {
    background(['sync', '--chats', 'due', '--lazy', '--quiet', ...active]);
  } else if (kind === 'end') {
    background(['sync', '--chats', 'all', '--quiet', ...active]);
  }
}

// ---------- setup ----------

function defaultMachine() {
  const os_ = { win32: 'windows', darwin: 'mac', linux: 'linux' }[process.platform] || process.platform;
  return `${os_}-${os.hostname()}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
}

function linkMemory(machine, proj, dir) {
  const target = repoMemory(proj);
  fs.mkdirSync(target, { recursive: true });
  const link = path.join(claudeProjectDir(dir), 'memory');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  let st = null;
  try {
    st = fs.lstatSync(link);
  } catch {}
  if (st && st.isSymbolicLink()) {
    if (samePath(fs.realpathSync(link), target)) return 'already linked';
    fs.unlinkSync(link); // pointed elsewhere; that folder itself is left alone
  } else if (st && st.isDirectory()) {
    // Fold this machine's notes into the repo; a note that differs is kept beside it.
    let clashes = 0;
    for (const name of fs.readdirSync(link)) {
      const from = path.join(link, name);
      const to = path.join(target, name);
      if (!fs.statSync(from).isFile()) continue;
      if (!fs.existsSync(to)) fs.copyFileSync(from, to);
      else if (!fs.readFileSync(from).equals(fs.readFileSync(to))) {
        fs.copyFileSync(from, path.join(target, `${name.replace(/\.md$/, '')}.from-${machine}.md`));
        clashes++;
      }
    }
    if (clashes) notice(`${clashes} memory note(s) from ${machine} differed from the repo; kept as *.from-${machine}.md to merge by hand.`);
    fs.renameSync(link, `${link}.before-ccsync`);
  }
  fs.symlinkSync(target, link, IS_WIN ? 'junction' : 'dir');
  return `linked ${link}`;
}

// Hooks need a real Node. When setup runs inside VS Code, process.execPath is the
// editor's own binary, so look Node up on PATH instead.
function nodeForHooks(flags) {
  if (typeof flags.node === 'string') return flags.node;
  if (!process.versions.electron) return process.execPath;
  const r = spawnSync(IS_WIN ? 'where' : 'which', ['node'], { encoding: 'utf8', windowsHide: true });
  const hit = r.status === 0 && r.stdout.split(/\r?\n/).find(Boolean);
  if (!hit) die('Node.js was not found on PATH. Install Node 18+ (the Claude hooks run with it) and try again.');
  return hit.trim();
}

function hookCommand(kind, nodeBin) {
  const q = s => (/\s/.test(s) ? `"${s}"` : s);
  return `${q(fwd(nodeBin))} ${q(fwd(__filename))} hook ${kind}`;
}

const settingsFile = dir => path.join(dir, '.claude', 'settings.local.json');

function readSettings(dir) {
  const file = settingsFile(dir);
  if (!fs.existsSync(file)) return {};
  const s = readJson(file, null);
  if (!s) die(`${file} is not valid JSON; fix it and run setup again.`);
  return s;
}

// Context repos a project folder syncs with, read from its hook commands.
function reposFromSettings(dir) {
  const s = readJson(settingsFile(dir), null);
  const out = new Set();
  for (const groups of Object.values((s && s.hooks) || {})) {
    for (const g of groups || []) {
      for (const h of g.hooks || []) {
        const m = String(h.command || '').match(/"([^"]*ccsync\.js)"|(\S*ccsync\.js)/);
        if (m) out.add(path.resolve(path.dirname(m[1] || m[2])));
      }
    }
  }
  return [...out];
}

// A team repo joins a folder whose memory already lives in a personal context repo
// as a team/ folder inside that memory, so private notes stay private.
function personalMemoryOf(dir) {
  const mem = readJson(settingsFile(dir), {}).autoMemoryDirectory;
  if (!mem) return null;
  const abs = path.resolve(mem.replace(/^~(?=$|[\\/])/, os.homedir()));
  const insideThisRepo = normPath(abs) === normPath(REPO) || normPath(abs).startsWith(normPath(REPO) + path.sep);
  return insideThisRepo ? null : abs;
}

function gitRootOf(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (path.dirname(d) === d) return null;
  }
}

function attachTeam(proj, personalMem) {
  const link = path.join(personalMem, 'team');
  const root = gitRootOf(personalMem);
  if (root) {
    // Keep the personal repo from ever committing the team notes.
    const exclude = path.join(root, '.git', 'info', 'exclude');
    const line = `/${fwd(path.relative(root, link))}/`;
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    const cur = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : '';
    if (!cur.split(/\r?\n/).includes(line)) fs.appendFileSync(exclude, `${cur && !cur.endsWith('\n') ? '\n' : ''}${line}\n`);
  }
  const target = repoMemory(proj);
  fs.mkdirSync(target, { recursive: true });
  let st = null;
  try {
    st = fs.lstatSync(link);
  } catch {}
  if (st && st.isSymbolicLink()) {
    if (samePath(fs.realpathSync(link), target)) return `already linked ${link}`;
    fs.unlinkSync(link);
  } else if (st) {
    die(`${link} already exists and is not a link; move it away and run setup again.`);
  }
  fs.symlinkSync(target, link, IS_WIN ? 'junction' : 'dir');
  return `linked ${link}`;
}

function writeProjectSettings(proj, dir, nodeBin, setMemory) {
  const file = settingsFile(dir);
  const s = readSettings(dir);
  if (setMemory) s.autoMemoryDirectory = fwd(repoMemory(proj));
  s.hooks = s.hooks || {};
  const mine = normPath(__filename);
  const isMine = h => {
    const m = String(h.command || '').match(/"([^"]*ccsync\.js)"|(\S*ccsync\.js)/);
    return m && normPath(m[1] || m[2]) === mine;
  };
  const want = { SessionStart: ['start', 60], Stop: ['stop', 15], SessionEnd: ['end', 15] };
  for (const [event, [kind, timeout]] of Object.entries(want)) {
    const groups = (s.hooks[event] || [])
      .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isMine(h)) }))
      .filter(g => g.hooks.length);
    groups.push({ hooks: [{ type: 'command', command: hookCommand(kind, nodeBin), timeout }] });
    s.hooks[event] = groups;
  }
  writeJson(file, s);
  return file;
}

function writeSkill(dir) {
  const tool = `node "${fwd(__filename)}"`;
  const file = path.join(dir, '.claude', 'skills', 'sync-chats', 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `---
name: sync-chats
description: Choose which Claude Code chats in this project sync to the user's other machines through their private claude-context repo, sync now, or show sync status. Use for /sync-chats, "sync this chat", "share this chat with my Mac", "which chats are synced", or continuing a chat on another device.
---

Memory syncs on its own through hooks. Chats sync only once picked. The tool is
\`${tool}\`. Never edit the claude-context repo by hand.

- **This chat:** \`${tool} add current\`
- **Pick chats:** run \`${tool} list\` and show its table: number, [x] = synced, last
  used, size, title. Ask which to switch on or off, then run
  \`${tool} add <numbers or ids>\` or \`${tool} remove <numbers or ids>\`. Numbers refer
  to the latest list; use the ids if new chats may have appeared since.
- \`add\` and \`remove\` sync right away. To push everything now, for example before
  moving to the other machine: \`${tool} sync\`
- **Status and problems:** \`${tool} status\`

On the other machine, a synced chat appears once a new Claude session starts in the
project (the start hook pulls); then use /resume. If the same chat was continued on
both machines, the other version shows up as its own chat, "(<machine> copy)".
Nothing is overwritten.
`,
  );
  return file;
}

function setup(flags) {
  const proj = flags.project;
  const dir = flags.dir && path.resolve(String(flags.dir));
  if (!proj || proj === true || !dir) {
    die('Usage: node ccsync.js setup --project <name> --dir <project folder> [--machine <name>] [--person <name>] [--team]');
  }
  if (!fs.existsSync(dir)) die(`No such folder: ${dir}`);
  const nodeBin = nodeForHooks(flags);
  const say = flags.json ? () => {} : msg => console.log(msg);
  const cfg = loadConfig(false) || {};
  cfg.machine = (typeof flags.machine === 'string' && flags.machine) || cfg.machine || defaultMachine();
  cfg.person = cleanName(typeof flags.person === 'string' ? flags.person : '') || cfg.person || defaultPerson();
  git(['config', 'core.autocrlf', 'false']);
  git(['config', 'rebase.autoStash', 'true']);
  if (!git(['config', 'user.email']).ok) {
    say('Note: git has no user.name/user.email here. Set them in this repo with git config, or commits will fail.');
  }
  // --team turns this into a team repo owned by this person.
  if (flags.team && !teamInfo()) {
    writeJson(TEAM_FILE, { owner: cfg.person, created: new Date().toISOString() });
    git(['add', '--', 'team.json']);
    git(['commit', '-q', '-m', `team: ${cfg.person} owns this context repo`]);
  }
  const who = whoAmI(cfg);
  if (who.role === 'member' && !who.person) die('A teammate needs a name: pass --person <name>.');
  const personal = who.team ? personalMemoryOf(dir) : null;
  cfg.projects = { ...(cfg.projects || {}), [proj]: personal ? { dir, attach: personal } : { dir } };
  writeJson(CFG_FILE, cfg);
  ensureBranch(who);

  say(`Machine: ${cfg.machine}${who.team ? ` · ${who.person} (${who.role} of a team repo owned by ${who.team.owner}, writes ${who.branch})` : ''}`);
  if (personal) {
    say(`Team notes: ${attachTeam(proj, personal)} -> ${repoMemory(proj)}`);
    refreshTeamIndex(cfg);
  } else {
    say(`Memory: ${linkMemory(cfg.machine, proj, dir)} -> ${repoMemory(proj)}`);
  }
  say(`Hooks${personal ? '' : ' + memory setting'}: ${writeProjectSettings(proj, dir, nodeBin, !personal)}`);
  if (!who.team) say(`/sync-chats skill: ${writeSkill(dir)}`);
  printReport(sync({ chats: 'all', push: true }), flags.json);
}

// ---------- chat picking ----------

function resolveRefs(refs, list, cfg) {
  const out = [];
  for (const r of refs) {
    if (r === 'current' || r === 'this') {
      const id = process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID;
      const c = id ? list.find(x => x.id === id) : list[0];
      if (!c) die(`Can't find the current chat${id ? ` (${id})` : ''}.`);
      out.push(c);
    } else if (/^\d+$/.test(r)) {
      const c = list[Number(r) - 1];
      if (!c) die(`There is no chat number ${r}.`);
      out.push(c);
    } else {
      let m = list.filter(x => x.id.startsWith(r));
      if (!m.length) {
        // synced but not on this machine
        for (const proj of Object.keys(cfg.projects)) {
          for (const id of selectedIds(proj)) if (id.startsWith(r)) m.push({ proj, id, synced: true, title: id });
        }
      }
      if (m.length !== 1) die(`"${r}" matches ${m.length} chats.`);
      out.push(m[0]);
    }
  }
  return out;
}

function select(cfg, st, c) {
  writeJson(path.join(repoChat(c.proj, c.id), 'meta.json'), { title: c.title, added: new Date().toISOString(), by: cfg.machine });
  exportChat(cfg, st, c.proj, c.id, true);
}

function unselect(st, c) {
  fs.rmSync(repoChat(c.proj, c.id), { recursive: true, force: true });
  delete st.chats[c.id];
}

function printList(list) {
  if (!list.length) return console.log('No chats in this project yet.');
  console.log(' #  sync  last used         size     id        title');
  for (const c of list) {
    console.log(`${String(c.n).padStart(2)}  ${c.synced ? '[x]' : '[ ]'}   ${when(c.mtimeMs)}  ${fmtBytes(c.size).padStart(7)}  ${c.id.slice(0, 8)}  ${c.title}`);
  }
}

function changeSelection(refs, on, json) {
  const cfg = loadConfig();
  if (teamInfo()) die('This is a team repo: it holds shared memory only. Chats sync through your personal context repo.');
  const st0 = loadState();
  const picked = resolveRefs(refs, localChats(cfg, st0), cfg);
  const done = withLock(60000, () => {
    const st = loadState();
    st.titles = { ...st.titles, ...st0.titles };
    for (const c of picked) {
      if (on && !c.synced) select(cfg, st, c);
      if (!on && c.synced) unselect(st, c);
      if (!json) console.log(`${on ? 'Syncing' : 'Stopped syncing'}: ${c.title}`);
    }
    saveState(st);
    return true;
  });
  if (!done) die('Another sync is running; try again in a minute.');
  printReport(sync({ chats: 'all', push: true }), json);
}

// Title lookups are cached in state. Save only new ones (the extension watches the
// state file), and skip if a sync holds the lock.
function saveTitlesIfFree(st) {
  if (!titlesDirty) return;
  withLock(0, () => {
    const cur = loadState();
    cur.titles = { ...cur.titles, ...st.titles };
    saveState(cur);
  });
}

// ---------- machine-readable views for the VS Code extension ----------

function chatStatus(cfg, st, proj, id, localStat) {
  const all = manifests(proj, id);
  const others = all.filter(m => m.machine !== cfg.machine);
  const copies = all.map(m => ({ machine: m.machine, bytes: m.bytes, updated: m.updated }));
  if (!localStat) return { status: others.length ? 'remote-only' : 'empty', copies };
  const rec = st.chats[id];
  const sig = others.length ? sha(others.map(m => m.machine + ':' + m.chunks.map(c => c.sha).join(',')).sort().join('|')) : null;
  // Import records the other machines' state once applied; a mismatch means it was held back.
  if (sig && (!rec || rec.remoteSig !== sig)) return { status: 'incoming', copies };
  if (!rec || rec.size !== localStat.size || rec.mtimeMs !== localStat.mtimeMs) return { status: 'unsent', copies };
  return { status: 'synced', copies };
}

function teamModel(cfg) {
  const who = whoAmI(cfg);
  if (!who.team) return null;
  const out = { owner: who.team.owner, role: who.role, person: who.person, branch: who.branch, people: [], pending: [], proposals: [] };
  if (who.role === 'owner') {
    const review = readReview();
    for (const person of peopleBranches()) {
      const changes = pendingChanges(person, `origin/people/${person}`, 'HEAD', review);
      const last = git(['log', '-1', '--format=%cI', `origin/people/${person}`]).out || null;
      out.people.push({ person, pending: changes.length, lastActivity: last });
      out.pending.push(...changes);
    }
  } else {
    out.proposals = pendingChanges(who.person, 'HEAD', 'origin/main', readReview('origin/main'));
  }
  return out;
}

function stateModel() {
  const cfg = loadConfig(false);
  if (!cfg) return { configured: false, repo: REPO, engine: ENGINE_VERSION, team: teamInfo() ? { owner: teamInfo().owner } : null };
  const st = loadState();
  const team = teamModel(cfg);
  const projects = [];
  for (const proj of Object.keys(cfg.projects)) {
    const dir = cfg.projects[proj].dir;
    const attach = cfg.projects[proj].attach || null;
    const claudeDir = claudeProjectDir(dir);
    let linked = false;
    try {
      linked = samePath(fs.realpathSync(attach ? path.join(attach, 'team') : path.join(claudeDir, 'memory')), repoMemory(proj));
    } catch {}
    const memFiles = fs.existsSync(repoMemory(proj)) ? fs.readdirSync(repoMemory(proj)).filter(n => n.endsWith('.md')).length : 0;
    const selected = new Set(selectedIds(proj));
    const chats = [];
    let names = [];
    try {
      names = fs.readdirSync(claudeDir);
    } catch {}
    for (const n of names) {
      if (!/^[0-9a-f-]{36}\.jsonl$/.test(n)) continue;
      const file = path.join(claudeDir, n);
      const s = fs.statSync(file);
      if (!s.size) continue;
      const id = n.slice(0, -6);
      const synced = selected.has(id);
      const extra = synced ? chatStatus(cfg, st, proj, id, s) : { status: 'local', copies: [] };
      chats.push({ id, title: titleOf(st, file), local: true, size: s.size, mtimeMs: s.mtimeMs, synced, ...extra });
    }
    for (const id of selected) {
      if (chats.some(c => c.id === id)) continue;
      const meta = readJson(path.join(repoChat(proj, id), 'meta.json'), {});
      const extra = chatStatus(cfg, st, proj, id, null);
      const newest = extra.copies.reduce((a, c) => (!a || c.updated > a.updated ? c : a), null);
      chats.push({ id, title: meta.title || id, local: false, size: newest ? newest.bytes : 0, mtimeMs: newest ? Date.parse(newest.updated) : 0, synced: true, ...extra });
    }
    chats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    projects.push({ name: proj, dir, claudeDir, attach, memory: { files: memFiles, linked }, chats: team ? [] : chats });
  }
  saveTitlesIfFree(st);
  let notices = [];
  try {
    notices = fs.readFileSync(NOTICE_FILE, 'utf8').split('\n').filter(Boolean);
  } catch {}
  return {
    configured: true,
    repo: REPO,
    engine: ENGINE_VERSION,
    machine: cfg.machine,
    person: cfg.person || null,
    remote: git(['remote', 'get-url', 'origin']).out || null,
    lastSync: st.lastSync || null,
    unpushed: unpushed(whoAmI(cfg).branch),
    notices: [...new Set(notices)],
    team,
    projects,
  };
}

// ---------- review (the owner of a team repo) ----------

function recordReview(person, p, sha, decision) {
  const review = readReview();
  review[person] = review[person] || {};
  review[person][p] = { sha, decision, at: new Date().toISOString() };
  writeJson(REVIEW_FILE, review);
}

// Runs `fn` on an up-to-date main, then commits and pushes what it changed.
function asOwner(message, fn) {
  const cfg = loadConfig();
  const who = whoAmI(cfg);
  if (who.role !== 'owner') die(`Only the owner of this team repo (${who.team ? who.team.owner : 'none'}) can review changes.`);
  const report = { exported: [], imported: [], forked: [], offline: false, pushed: false, pulled: false };
  const done = withLock(60000, () => {
    recoverGit();
    ensureBranch(who);
    commit(cfg);
    report.pulled = pull(report, who);
    const summary = fn();
    git(['add', '-A', '--', 'projects', 'review.json']);
    if (git(['diff', '--cached', '--name-only']).out) git(['commit', '-q', '-m', `${who.person}: ${message}`]);
    refreshTeamIndex(cfg);
    report.pushed = push(report, who);
    return summary;
  });
  if (done === null) die('Another sync is running; try again in a minute.');
  return { ...report, review: done };
}

function findChange(person, p) {
  const review = readReview();
  return pendingChanges(person, `origin/people/${person}`, 'HEAD', review).find(c => c.path === p);
}

function reviewCommand(pos, flags) {
  const [action, person, p] = pos;
  const json = !!flags.json;
  const show = r => (json ? console.log(JSON.stringify(r)) : console.log(r.review || r));
  if (action === 'list') {
    if (flags.fetch) git(['fetch', '-q', '--prune', 'origin'], 45000);
    const t = teamModel(loadConfig());
    if (!t) die('This is not a team repo.');
    if (json) return console.log(JSON.stringify(t));
    if (t.role !== 'owner') return console.log(`Your changes waiting for ${t.owner}: ${t.proposals.length}\n${t.proposals.map(c => `  ${c.kind.padEnd(8)} ${c.path}`).join('\n')}`);
    if (!t.pending.length) return console.log('Nothing waiting for review.');
    for (const c of t.pending) console.log(`${c.person.padEnd(14)} ${c.kind.padEnd(8)} ${c.path}`);
    return;
  }
  if (action === 'show') {
    // --side theirs | main | base. For the owner, "theirs" is the teammate's branch; for a
    // teammate, it is their own work and "main" is the approved copy.
    const owner = whoAmI(loadConfig()).role === 'owner';
    const mainRef = owner ? 'HEAD' : 'origin/main';
    const theirsRef = owner ? `origin/people/${person}` : 'HEAD';
    const side = typeof flags.side === 'string' ? flags.side : 'theirs';
    const ref = side === 'main' ? mainRef : side === 'base' ? git(['merge-base', mainRef, theirsRef]).out : theirsRef;
    const blob = gitBlob(`${ref}:${p}`);
    if (blob) process.stdout.write(blob);
    return;
  }
  if (!person) die('Usage: node ccsync.js review accept|reject|accept-all <person> [<path>] [--content-file <file>]');
  if (action === 'accept-all') {
    return show(
      asOwner(`accept everything from ${person}`, () => {
        const changes = pendingChanges(person, `origin/people/${person}`, 'HEAD', readReview());
        for (const c of changes) applyChange(c, null);
        return `Accepted ${changes.length} change${changes.length === 1 ? '' : 's'} from ${person}.`;
      }),
    );
  }
  if (!p) die(`Usage: node ccsync.js review ${action} <person> <path>`);
  const file = typeof flags['content-file'] === 'string' ? path.resolve(flags['content-file']) : null;
  if (action === 'accept') {
    return show(
      asOwner(`${file ? 'integrate' : 'accept'} ${person}'s ${p}`, () => {
        const c = findChange(person, p);
        if (!c) return `Nothing waiting from ${person} for ${p}.`;
        applyChange(c, file);
        return `${file ? 'Merged' : 'Accepted'} ${person}'s change to ${path.basename(p)}.`;
      }),
    );
  }
  if (action === 'reject') {
    return show(
      asOwner(`reject ${person}'s ${p}`, () => {
        const c = findChange(person, p);
        if (!c) return `Nothing waiting from ${person} for ${p}.`;
        recordReview(person, p, c.theirs, 'rejected');
        return `Rejected ${person}'s change to ${path.basename(p)}. Their machines go back to main's version.`;
      }),
    );
  }
  die(`Unknown review action: ${action}`);
}

// Accept a change as proposed, or with merged content from a file.
function applyChange(c, contentFile) {
  const abs = path.join(REPO, c.path);
  if (contentFile) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(contentFile, abs);
  } else if (c.theirs) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, gitBlob(c.theirs));
  } else {
    fs.rmSync(abs, { force: true });
  }
  recordReview(c.person, c.path, c.theirs, contentFile ? 'integrated' : 'accepted');
}

// Replace this copy of ccsync.js with a newer one (the extension carries the latest).
function selfUpdate(from) {
  const src = fs.readFileSync(from, 'utf8');
  const m = src.match(/const ENGINE_VERSION = (\d+)/);
  const theirs = m ? Number(m[1]) : 0;
  if (theirs <= ENGINE_VERSION) return console.log(JSON.stringify({ updated: false, version: ENGINE_VERSION }));
  fs.writeFileSync(__filename, src);
  git(['add', '--', path.basename(__filename)]);
  git(['commit', '-q', '-m', `ccsync: update to engine ${theirs}`]);
  console.log(JSON.stringify({ updated: true, from: ENGINE_VERSION, version: theirs }));
}

// The folder a ~/.claude/projects entry belongs to, read from its transcripts' "cwd".
function guessProjectDir(full, slug, files) {
  for (const f of files.slice(0, 5)) {
    let fd;
    try {
      fd = fs.openSync(path.join(full, f.name), 'r');
      const buf = Buffer.alloc(256 * 1024);
      const text = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
      const re = /"cwd":"((?:[^"\\]|\\.)*)"/g;
      for (let m; (m = re.exec(text)); ) {
        let cwd;
        try {
          cwd = JSON.parse(`"${m[1]}"`);
        } catch {
          continue;
        }
        const s2 = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
        if (s2 === slug || (IS_WIN && s2.toLowerCase() === slug.toLowerCase())) return cwd;
      }
    } catch {
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  return null;
}

function projectsModel() {
  const cfg = loadConfig(false);
  const enabled = cfg ? Object.entries(cfg.projects).map(([name, p]) => ({ name, dir: p.dir, claudeDir: claudeProjectDir(p.dir) })) : [];
  const root = path.join(CLAUDE_DIR, 'projects');
  const countMd = d => {
    try {
      return fs.readdirSync(d).filter(n => n.endsWith('.md')).length;
    } catch {
      return 0;
    }
  };
  const out = [];
  let slugs = [];
  try {
    slugs = fs.readdirSync(root);
  } catch {}
  for (const slug of slugs) {
    const full = path.join(root, slug);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    const files = fs.readdirSync(full).filter(n => n.endsWith('.jsonl'))
      .map(name => ({ name, mtimeMs: fs.statSync(path.join(full, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const en = enabled.find(e => samePath(e.claudeDir, full));
    const dir = en ? en.dir : guessProjectDir(full, slug, files);
    const exists = !!dir && fs.existsSync(dir);
    out.push({
      slug, dir, exists, enabled: !!en, name: en ? en.name : null,
      chats: files.length, lastUsed: files.length ? files[0].mtimeMs : null, memory: countMd(path.join(full, 'memory')),
      repos: exists ? reposFromSettings(dir) : [],
    });
  }
  for (const e of enabled) {
    if (out.some(o => o.enabled && o.name === e.name)) continue;
    const exists = fs.existsSync(e.dir);
    out.push({
      slug: path.basename(e.claudeDir), dir: e.dir, exists, enabled: true, name: e.name, chats: 0, lastUsed: null,
      memory: countMd(repoMemory(e.name)), repos: exists ? reposFromSettings(e.dir) : [],
    });
  }
  return out.sort((a, b) => b.enabled - a.enabled || (b.lastUsed || 0) - (a.lastUsed || 0));
}

async function pickInteractively() {
  const cfg = loadConfig();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(res => rl.question(q, res));
  let changed = false;
  for (;;) {
    const st = loadState();
    const list = localChats(cfg, st);
    saveState(st);
    printList(list);
    const ans = (await ask('\nNumbers to switch sync on/off (e.g. 1 4 7), Enter when done: ')).trim();
    if (!ans) break;
    const picked = resolveRefs(ans.split(/[\s,]+/).filter(Boolean), list, cfg);
    withLock(60000, () => {
      const st2 = loadState();
      for (const c of picked) {
        if (c.synced) unselect(st2, c);
        else select(cfg, st2, c);
      }
      saveState(st2);
    });
    changed = true;
    console.log('');
  }
  rl.close();
  if (changed) printReport(sync({ chats: 'all', push: true }));
}

function status() {
  const cfg = loadConfig();
  const st = loadState();
  console.log(`Machine: ${cfg.machine}`);
  console.log(`Repo: ${REPO} -> ${git(['remote', 'get-url', 'origin']).out || '(no remote)'}`);
  const last = st.lastSync;
  const who = whoAmI(cfg);
  console.log(`Last sync: ${last ? `${last.at}${last.offline ? ' (offline)' : ''}` : 'never'}; unpushed commits: ${unpushed(who.branch)}`);
  if (who.team) {
    const t = teamModel(cfg);
    console.log(`Team repo owned by ${t.owner}; you are ${t.person} (${t.role}), writing ${t.branch}.`);
    console.log(t.role === 'owner' ? `Waiting for your review: ${t.pending.length}` : `Your changes waiting for ${t.owner}: ${t.proposals.length}`);
  }
  for (const proj of Object.keys(cfg.projects)) {
    const attach = cfg.projects[proj].attach;
    const link = attach ? path.join(attach, 'team') : path.join(claudeProjectDir(cfg.projects[proj].dir), 'memory');
    let mem = 'NOT linked';
    try {
      if (samePath(fs.realpathSync(link), repoMemory(proj))) mem = 'linked';
    } catch {}
    const notes = fs.existsSync(repoMemory(proj)) ? fs.readdirSync(repoMemory(proj)).length : 0;
    console.log(`\n[${proj}] ${cfg.projects[proj].dir}\n  memory: ${notes} files, ${mem}`);
    const ids = selectedIds(proj);
    console.log(`  synced chats: ${ids.length}`);
    for (const id of ids) {
      const meta = readJson(path.join(repoChat(proj, id), 'meta.json'), {});
      const copies = manifests(proj, id).map(m => `${m.machine} ${fmtBytes(m.bytes)} @ ${m.updated.slice(0, 16)}`);
      const local = fs.existsSync(transcript(cfg, proj, id)) ? 'here' : 'not here yet';
      console.log(`  - ${id.slice(0, 8)} ${meta.title || ''}\n      ${local}; ${copies.join('; ') || 'not sent yet'}`);
    }
  }
  try {
    const pending = fs.readFileSync(NOTICE_FILE, 'utf8').trim();
    if (pending) console.log(`\nNotices:\n${pending}`);
  } catch {}
}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[a.slice(2)] = next;
        i++;
      } else flags[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const USAGE = `ccsync: sync Claude Code memory and chosen chats through this repo

  setup --project <name> --dir <folder> [--machine <name>] [--person <name>] [--team]
                              set this machine up (safe to re-run); --team makes this a
                              team repo owned by --person
  chats                       pick chats to sync, interactively
  list                        show this machine's chats ([x] = synced)
  add <n|id|current>...       start syncing chats
  remove <n|id>...            stop syncing chats (local copies stay)
  sync                        push and pull everything now
  status                      what is synced, last sync, problems
  hook start|stop|end         used by Claude Code hooks
  state | projects            JSON for the VS Code extension
  notices [--clear]           pending problems / dismiss them
  review list [--fetch]       team repo: what teammates changed (owner) or what you proposed
  review show <person> <path> [--side theirs|main|base]
  review accept <person> <path> [--content-file <merged.md>]
  review reject <person> <path>
  review accept-all <person>
  version | self-update --from <ccsync.js>
  --json                      machine-readable output for setup, sync, add, remove, review`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, flags } = parseArgs(rest);
  switch (cmd) {
    case 'setup':
      return setup(flags);
    case 'sync': {
      const r = sync({
        chats: typeof flags.chats === 'string' ? flags.chats : 'all',
        lazy: !!flags.lazy,
        push: !flags['no-push'],
        activeId: typeof flags.active === 'string' ? flags.active : undefined,
        wait: flags.lazy ? 0 : 60000,
      });
      if (!flags.quiet) printReport(r, flags.json);
      return;
    }
    case 'state':
      return console.log(JSON.stringify(stateModel()));
    case 'projects':
      return console.log(JSON.stringify(projectsModel()));
    case 'notices':
      if (flags.clear) return void takeNotices();
      return console.log(fs.existsSync(NOTICE_FILE) ? fs.readFileSync(NOTICE_FILE, 'utf8').trim() : '');
    case 'hook':
      try {
        hook(pos[0]);
      } catch (e) {
        log(`hook ${pos[0]}: ${e.stack || e}`);
      }
      return;
    case 'list': {
      const cfg = loadConfig();
      const st = loadState();
      const list = localChats(cfg, st);
      saveTitlesIfFree(st);
      return flags.json ? console.log(JSON.stringify(list.map(({ file, ...c }) => c), null, 2)) : printList(list);
    }
    case 'chats':
      return pickInteractively();
    case 'add':
    case 'remove':
      if (!pos.length) die(`Usage: node ccsync.js ${cmd} <number|id|current>...`);
      return changeSelection(pos, cmd === 'add', !!flags.json);
    case 'status':
      return status();
    case 'review':
      return reviewCommand(pos, flags);
    case 'version':
      return console.log(ENGINE_VERSION);
    case 'self-update':
      if (typeof flags.from !== 'string') die('Usage: node ccsync.js self-update --from <ccsync.js>');
      return selfUpdate(path.resolve(flags.from));
    default:
      console.log(USAGE);
  }
}

if (require.main === module) {
  main().catch(e => {
    log(`fatal: ${e.stack || e}`);
    die(String(e.stack || e));
  });
}

module.exports = { normalizer, denormalizer, splitChunks, relation, forkId };
