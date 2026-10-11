// Two simulated machines ("win" and "mac") with their own Claude folders and project
// paths, sharing a bare repo as GitHub. Uses generated chats only. Needs git.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const { normalizer } = require(path.join(ROOT, 'engine', 'ccsync.js'));
const VERBOSE = process.argv.includes('--verbose');
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsync-e2e-'));
const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// "GitHub": a bare repo that starts with just the tool, as a new context repo would.
const seed = path.join(SB, 'seed');
fs.mkdirSync(seed);
for (const [from, to] of [['ccsync.js', 'ccsync.js'], ['README.md', 'README.md'], ['gitattributes', '.gitattributes'], ['gitignore', '.gitignore']]) {
  fs.copyFileSync(path.join(ROOT, 'engine', from), path.join(seed, to));
}
g(seed, 'init', '-q');
g(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
g(seed, 'add', '-A');
g(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'tool');
g(SB, 'clone', '-q', '--bare', seed, 'origin.git');

const M = {};
for (const name of ['win', 'mac']) {
  const repo = path.join(SB, name);
  g(SB, 'clone', '-q', path.join(SB, 'origin.git'), name);
  g(repo, 'config', 'user.name', `Test ${name}`);
  g(repo, 'config', 'user.email', `${name}@test`);
  const proj = path.join(SB, `proj-${name}`, 'App');
  fs.mkdirSync(proj, { recursive: true });
  const claude = path.join(SB, `claude-${name}`);
  const slug = path.join(claude, 'projects', path.resolve(proj).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(slug, { recursive: true });
  M[name] = { name, repo, proj, claude, slug };
}

function run(m, args, input) {
  const r = spawnSync(process.execPath, [path.join(m.repo, 'ccsync.js'), ...args], {
    encoding: 'utf8',
    input: input === undefined ? '' : input,
    env: { ...process.env, CLAUDE_CONFIG_DIR: m.claude, CLAUDE_CODE_SESSION_ID: '' },
  });
  const out = (r.stdout + r.stderr).trim();
  if (VERBOSE) console.log(`\n$ [${m.name}] ccsync ${args.join(' ')}\n${out.replace(/^/gm, '  ')}`);
  if (r.status !== 0) throw new Error(`[${m.name}] ccsync ${args.join(' ')} exited ${r.status}:\n${out}`);
  return out;
}
const chatFile = (m, id) => path.join(m.slug, `${id}.jsonl`);
const read = (m, id) => fs.readFileSync(chatFile(m, id), 'utf8');
const age = f => fs.utimesSync(f, new Date(Date.now() - 600e3), new Date(Date.now() - 600e3));
const same = (a, b) => normalizer(a.proj)(read(a, A)) === normalizer(b.proj)(read(b, A));
const sleep = ms => spawnSync(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`]);
function waitForBackground(m) {
  const lock = path.join(m.repo, '.local', 'sync.lock');
  const t0 = Date.now();
  sleep(1500);
  while (fs.existsSync(lock) && Date.now() - t0 < 120e3) sleep(300);
}
function appendTurn(m, id, text) {
  fs.appendFileSync(chatFile(m, id), JSON.stringify({ type: 'user', sessionId: id, cwd: m.proj, uuid: crypto.randomUUID(), message: { role: 'user', content: text } }) + '\n');
  age(chatFile(m, id));
}
// A transcript like Claude's: one line per message, cwd on every line, an ai-title.
function makeChat(m, id, title, turns, pad) {
  const lines = [];
  let parent = null;
  for (let i = 0; i < turns; i++) {
    const uuid = crypto.randomUUID();
    const role = i % 2 ? 'assistant' : 'user';
    const cwd = i % 7 === 3 ? path.join(m.proj, 'backend') : m.proj;
    lines.push(JSON.stringify({ parentUuid: parent, type: role, sessionId: id, cwd, uuid, message: { role, content: i ? `${i} ${'x'.repeat(pad)}` : title } }));
    parent = uuid;
  }
  lines.push(JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: id }));
  fs.writeFileSync(chatFile(m, id), lines.join('\n') + '\n');
  age(chatFile(m, id));
}
const step = name => console.log(`ok - ${name}`);

const A = crypto.randomUUID();
const B = crypto.randomUUID();
try {
  makeChat(M.win, A, 'Fix the login redirect', 600, 4000); // ~2.4 MB: several pieces
  makeChat(M.win, B, 'Draft the release notes', 20, 200);
  fs.mkdirSync(path.join(M.win.slug, 'memory'));
  fs.writeFileSync(path.join(M.win.slug, 'memory', 'MEMORY.md'), '- [Stack](stack.md) - how the app runs locally\n');
  fs.writeFileSync(path.join(M.win.slug, 'memory', 'stack.md'), '---\nname: stack\n---\nnode 20, postgres 16\n');

  run(M.win, ['setup', '--project', 'app', '--dir', M.win.proj, '--machine', 'win']);
  assert.ok(fs.lstatSync(path.join(M.win.slug, 'memory')).isSymbolicLink(), 'memory folder became a link');
  assert.ok(fs.existsSync(path.join(M.win.repo, 'projects/app/memory/stack.md')), 'memory moved into the repo');
  assert.ok(fs.existsSync(path.join(M.win.slug, 'memory.before-ccsync', 'stack.md')), 'a backup is kept');
  const settings = JSON.parse(fs.readFileSync(path.join(M.win.proj, '.claude/settings.local.json'), 'utf8'));
  assert.ok(settings.autoMemoryDirectory.endsWith('projects/app/memory'));
  assert.ok(settings.hooks.SessionStart[0].hooks[0].command.endsWith('hook start'));
  assert.ok(fs.existsSync(path.join(M.win.proj, '.claude/skills/sync-chats/SKILL.md')));
  assert.ok(g(path.join(SB, 'origin.git'), 'ls-tree', '-r', '--name-only', 'main').includes('projects/app/memory/stack.md'));
  step('setup moves memory into the repo, adds hooks and pushes');

  assert.ok(run(M.win, ['list']).includes('Fix the login redirect'));
  run(M.win, ['add', A.slice(0, 8)]);
  step('a chat is picked by id prefix');

  run(M.mac, ['setup', '--project', 'app', '--dir', M.mac.proj, '--machine', 'mac']);
  assert.ok(fs.existsSync(path.join(M.mac.slug, 'memory', 'stack.md')), 'memory reached mac');
  assert.ok(fs.existsSync(chatFile(M.mac, A)), 'picked chat reached mac');
  assert.ok(!fs.existsSync(chatFile(M.mac, B)), 'unpicked chat stayed home');
  assert.ok(read(M.mac, A).includes('"cwd":"' + JSON.stringify(M.mac.proj).slice(1, -1)), 'cwd rewritten for mac');
  assert.ok(!read(M.mac, A).includes('"cwd":"' + JSON.stringify(M.win.proj).slice(1, -1)), 'no win folder left');
  assert.ok(same(M.mac, M.win), 'same chat on both');
  age(chatFile(M.mac, A));
  step('second machine gets memory and the picked chat, in its own folder');

  appendTurn(M.mac, A, 'continued on mac');
  run(M.mac, ['sync']);
  const start = run(M.win, ['hook', 'start'], JSON.stringify({ session_id: crypto.randomUUID(), source: 'startup' }));
  assert.ok(start.includes('Chats updated from the other machine'), 'session start reports it');
  waitForBackground(M.win);
  assert.ok(read(M.win, A).includes('continued on mac') && same(M.win, M.mac));
  age(chatFile(M.win, A));
  step('a chat continued on mac arrives on win at session start');

  appendTurn(M.win, A, 'then on win');
  run(M.win, ['hook', 'end'], JSON.stringify({ session_id: A }));
  waitForBackground(M.win);
  run(M.mac, ['sync']);
  assert.ok(read(M.mac, A).includes('then on win'));
  age(chatFile(M.mac, A));
  step('session end pushes in the background');

  fs.writeFileSync(path.join(M.win.slug, 'memory', 'deploy.md'), '---\nname: deploy\n---\nfrom win\n');
  fs.appendFileSync(path.join(M.win.slug, 'memory', 'MEMORY.md'), '- [Deploy](deploy.md) - added on win\n');
  fs.appendFileSync(path.join(M.mac.repo, 'projects/app/memory/MEMORY.md'), '- [Tests](tests.md) - added on mac\n');
  run(M.win, ['hook', 'stop'], JSON.stringify({ session_id: A }));
  waitForBackground(M.win);
  run(M.mac, ['sync']);
  run(M.win, ['sync']);
  for (const m of [M.win, M.mac]) {
    const index = fs.readFileSync(path.join(m.repo, 'projects/app/memory/MEMORY.md'), 'utf8');
    assert.ok(index.includes('added on win') && index.includes('added on mac'), `${m.name} kept both index lines`);
  }
  assert.ok(fs.existsSync(path.join(M.mac.repo, 'projects/app/memory/deploy.md')));
  step('memory edited on both machines merges line by line');

  appendTurn(M.mac, A, 'mac again');
  run(M.mac, ['sync']);
  fs.utimesSync(chatFile(M.win, A), new Date(), new Date()); // just written = open
  const before = read(M.win, A);
  const resumed = run(M.win, ['hook', 'start'], JSON.stringify({ session_id: A, source: 'resume' }));
  assert.ok(resumed.includes('it is open here'), 'user is told why');
  waitForBackground(M.win);
  assert.strictEqual(read(M.win, A), before, 'open chat untouched');
  age(chatFile(M.win, A));
  run(M.win, ['sync']);
  assert.ok(read(M.win, A).includes('mac again'), 'picked up once closed');
  age(chatFile(M.win, A));
  step('an open chat is never replaced, and updates once closed');

  appendTurn(M.win, A, 'win branch');
  appendTurn(M.mac, A, 'mac branch');
  run(M.win, ['sync']);
  run(M.mac, ['sync']);
  run(M.win, ['sync']);
  assert.ok(read(M.win, A).includes('win branch') && !read(M.win, A).includes('mac branch'), 'win keeps its own');
  const copies = fs.readdirSync(M.win.slug).filter(n => n.endsWith('.jsonl') && ![A, B].includes(n.slice(0, -6)));
  assert.strictEqual(copies.length, 1, 'win got one copy');
  const copy = fs.readFileSync(path.join(M.win.slug, copies[0]), 'utf8');
  assert.ok(copy.includes('mac branch') && copy.includes('(mac copy)') && !copy.includes(`"sessionId":"${A}"`), 'copy has its own id and title');
  assert.ok(fs.readdirSync(M.mac.slug).some(n => n.endsWith('.jsonl') && n.slice(0, -6) !== A), 'mac got a copy too');
  step('a chat continued on both machines keeps both versions');

  run(M.win, ['remove', A.slice(0, 8)]);
  run(M.mac, ['sync']);
  assert.ok(!fs.existsSync(path.join(M.mac.repo, 'projects/app/chats', A)), 'chat left the repo');
  assert.ok(fs.existsSync(chatFile(M.mac, A)), 'local copy stays');
  step('removing a chat stops syncing it and keeps local copies');

  const lock = path.join(M.win.repo, '.local', 'sync.lock');
  fs.writeFileSync(lock, '999999');
  fs.utimesSync(lock, new Date(Date.now() - 10e3), new Date(Date.now() - 10e3));
  run(M.win, ['sync']);
  assert.ok(!fs.existsSync(lock), 'lock cleared');
  assert.ok(fs.readFileSync(path.join(M.win.repo, '.local', 'sync.log'), 'utf8').includes('removed a lock left by process 999999'));
  step('a lock left by a dead process is cleared');

  const state = JSON.parse(run(M.mac, ['state']));
  assert.strictEqual(state.machine, 'mac');
  assert.ok(state.projects[0].chats.length >= 2);
  step('state view for the extension');

  fs.rmSync(SB, { recursive: true, force: true });
  console.log('e2e: all checks passed');
} catch (e) {
  console.error(`\nFAILED: ${e.message}\nSandbox kept for a look: ${SB}`);
  process.exit(1);
}
