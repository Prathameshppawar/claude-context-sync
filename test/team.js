// Team repos: an owner ("pp", on two machines) and a teammate ("rahul") share one team
// repo. The owner also has a private repo. Needs git.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VERBOSE = process.argv.includes('--verbose');
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsync-team-'));
const g = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const step = name => console.log(`ok - ${name}`);

function bareRepo(name) {
  const seed = path.join(SB, `${name}-seed`);
  fs.mkdirSync(seed);
  for (const [from, to] of [['ccsync.js', 'ccsync.js'], ['README.md', 'README.md'], ['gitattributes', '.gitattributes'], ['gitignore', '.gitignore']]) {
    fs.copyFileSync(path.join(ROOT, 'engine', from), path.join(seed, to));
  }
  g(seed, 'init', '-q');
  g(seed, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  g(seed, 'add', '-A');
  g(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'tool');
  g(SB, 'clone', '-q', '--bare', seed, `${name}.git`);
  return path.join(SB, `${name}.git`);
}
const personalOrigin = bareRepo('personal');
const teamOrigin = bareRepo('team');

function machine(name) {
  const proj = path.join(SB, `proj-${name}`, 'App');
  fs.mkdirSync(proj, { recursive: true });
  const claude = path.join(SB, `claude-${name}`);
  const slug = path.join(claude, 'projects', path.resolve(proj).replace(/[^A-Za-z0-9]/g, '-'));
  fs.mkdirSync(slug, { recursive: true });
  return { name, proj, claude, slug };
}
function clone(origin, m, kind) {
  const dir = path.join(SB, `${kind}-${m.name}`);
  g(SB, 'clone', '-q', origin, dir);
  g(dir, 'config', 'user.name', m.name);
  g(dir, 'config', 'user.email', `${m.name}@test`);
  return dir;
}
function run(m, repo, args, { input = '', fail = false } = {}) {
  const r = spawnSync(process.execPath, [path.join(repo, 'ccsync.js'), ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, CLAUDE_CONFIG_DIR: m.claude, CLAUDE_CODE_SESSION_ID: '' },
  });
  const out = (r.stdout + r.stderr).trim();
  if (VERBOSE) console.log(`\n$ [${m.name}] ${path.basename(repo)} ${args.join(' ')}\n${out.replace(/^/gm, '  ')}`);
  if (fail) {
    if (r.status === 0) throw new Error(`expected failure: ${args.join(' ')}`);
    return out;
  }
  if (r.status !== 0) throw new Error(`[${m.name}] ${args.join(' ')} exited ${r.status}:\n${out}`);
  return out;
}
const read = f => fs.readFileSync(f, 'utf8');
const note = (name, body) => `---\nname: ${name}\n---\n${body}\n`;
const onMain = p => g(teamOrigin, 'show', `main:${p}`);
const review = (m, repo) => JSON.parse(run(m, repo, ['review', 'list', '--fetch', '--json']));

const win = machine('win');
const mac = machine('mac');
const rahul = machine('rahul');

try {
  // Owner, Windows: private repo first, then the team repo joins as team/.
  fs.mkdirSync(path.join(win.slug, 'memory'));
  fs.writeFileSync(path.join(win.slug, 'memory', 'MEMORY.md'), '- [QA login](qa-login.md) - private\n');
  fs.writeFileSync(path.join(win.slug, 'memory', 'qa-login.md'), note('qa-login', 'user: admin / pass: hunter2'));
  const pWin = clone(personalOrigin, win, 'personal');
  const tWin = clone(teamOrigin, win, 'team');
  run(win, pWin, ['setup', '--project', 'app', '--dir', win.proj, '--machine', 'win']);
  const out = run(win, tWin, ['setup', '--project', 'app', '--dir', win.proj, '--machine', 'win', '--person', 'pp', '--team']);
  assert.ok(out.includes('owner of a team repo owned by pp'), out);
  const privateMem = path.join(pWin, 'projects', 'app', 'memory');
  assert.ok(fs.lstatSync(path.join(privateMem, 'team')).isSymbolicLink(), 'team/ is a link inside private memory');
  const settings = JSON.parse(read(path.join(win.proj, '.claude', 'settings.local.json')));
  assert.ok(settings.autoMemoryDirectory.endsWith('personal-win/projects/app/memory'), 'memory still points at the private repo');
  assert.strictEqual(settings.hooks.SessionStart.length, 2, 'hooks for both repos');
  assert.strictEqual(JSON.parse(onMain('team.json')).owner, 'pp');
  assert.ok(read(path.join(privateMem, 'MEMORY.md')).includes('Team notes (shared with the app team; pp reviews changes)'));
  step('owner: team repo joins as team/ inside private memory, private memory setting kept');

  // Owner writes a team note through the private memory folder.
  fs.writeFileSync(path.join(privateMem, 'team', 'deploy.md'), note('deploy', 'QA deploys every 30 minutes.\nMigrations run on deploy.'));
  fs.writeFileSync(path.join(privateMem, 'team', 'MEMORY.md'), '- [Deploy](deploy.md) - how QA deploys\n');
  run(win, tWin, ['sync']);
  run(win, pWin, ['sync']);
  assert.ok(onMain('projects/app/memory/deploy.md').includes('30 minutes'), 'team note reached main');
  assert.ok(!g(pWin, 'ls-files').includes('memory/team/'), 'private repo never commits team notes');
  assert.ok(!g(teamOrigin, 'ls-tree', '-r', '--name-only', 'main').includes('qa-login'), 'private note never reaches the team repo');
  assert.ok(read(path.join(privateMem, 'MEMORY.md')).includes('[Deploy](team/deploy.md)'), 'team index copied into the private index');
  step('team notes go to the team repo, private notes stay private, Claude sees both');

  // Teammate without a private repo: the team repo is their memory; they write people/rahul.
  const tRahul = clone(teamOrigin, rahul, 'team');
  run(rahul, tRahul, ['setup', '--project', 'app', '--dir', rahul.proj, '--machine', 'rahul-pc', '--person', 'rahul']);
  assert.strictEqual(g(tRahul, 'rev-parse', '--abbrev-ref', 'HEAD'), 'people/rahul');
  const rMem = path.join(rahul.slug, 'memory');
  assert.ok(read(path.join(rMem, 'deploy.md')).includes('30 minutes'), 'teammate has the approved notes');
  fs.writeFileSync(path.join(rMem, 'deploy.md'), note('deploy', 'QA deploys every 15 minutes.\nMigrations do not run on deploy.'));
  fs.writeFileSync(path.join(rMem, 'tests.md'), note('tests', 'Run make test before pushing.'));
  run(rahul, tRahul, ['sync']);
  assert.ok(onMain('projects/app/memory/deploy.md').includes('30 minutes'), "main untouched by the teammate's push");
  assert.ok(g(teamOrigin, 'show', 'people/rahul:projects/app/memory/deploy.md').includes('15 minutes'));
  run(rahul, tRahul, ['review', 'accept', 'rahul', 'projects/app/memory/tests.md'], { fail: true });
  step("teammate's changes wait on people/rahul; a teammate can't accept");

  let r = review(win, tWin);
  assert.deepStrictEqual(r.pending.map(c => `${c.kind} ${path.basename(c.path)}`), ['modified deploy.md', 'added tests.md']);
  const hookOut = run(win, tWin, ['hook', 'start'], { input: JSON.stringify({ session_id: 'x', source: 'startup' }) });
  assert.ok(hookOut.includes('2 team note change(s) from rahul'), hookOut);
  step('owner sees 2 pending changes, also at session start');

  run(win, tWin, ['review', 'accept', 'rahul', 'projects/app/memory/tests.md']);
  const merged = path.join(SB, 'merged.md');
  fs.writeFileSync(merged, note('deploy', 'QA deploys every 30 minutes.\nMigrations run on deploy.\nDisputed (rahul): every 15 minutes.'));
  run(win, tWin, ['review', 'accept', 'rahul', 'projects/app/memory/deploy.md', '--content-file', merged]);
  assert.ok(onMain('projects/app/memory/tests.md').includes('make test'));
  assert.ok(onMain('projects/app/memory/deploy.md').includes('Disputed (rahul)'));
  assert.strictEqual(review(win, tWin).pending.length, 0);
  run(rahul, tRahul, ['sync']);
  assert.ok(read(path.join(rMem, 'deploy.md')).includes('Disputed (rahul)'), "teammate gets the owner's merged version");
  assert.strictEqual(review(rahul, tRahul).proposals.length, 0, 'nothing left pending for the teammate');
  step('accept and merge-with-content land on main, and the teammate takes the result');

  fs.writeFileSync(path.join(rMem, 'tests.md'), note('tests', 'Tests are optional.'));
  run(rahul, tRahul, ['sync']);
  assert.strictEqual(review(win, tWin).pending.length, 1);
  run(win, tWin, ['review', 'reject', 'rahul', 'projects/app/memory/tests.md']);
  run(rahul, tRahul, ['sync']);
  assert.ok(read(path.join(rMem, 'tests.md')).includes('make test'), "a rejected change goes back to main's version");
  assert.strictEqual(review(win, tWin).pending.length, 0);
  step("rejected changes disappear from the teammate's memory");

  fs.writeFileSync(path.join(privateMem, 'team', 'deploy.md'), note('deploy', 'QA deploys every 30 minutes.\nMigrations run on deploy.\nDeploy window: 10:00-18:00.'));
  run(win, tWin, ['sync']);
  run(rahul, tRahul, ['sync']);
  assert.ok(read(path.join(rMem, 'deploy.md')).includes('Deploy window'), "owner's own edits reach the teammate");
  step("owner's direct edits reach the teammate");

  // Both change the same line: the teammate keeps theirs as a proposal, no line soup.
  fs.writeFileSync(path.join(rMem, 'deploy.md'), note('deploy', 'QA deploys every 20 minutes.\nMigrations run on deploy.\nDeploy window: 10:00-18:00.'));
  run(rahul, tRahul, ['sync']);
  fs.writeFileSync(path.join(privateMem, 'team', 'deploy.md'), note('deploy', 'QA deploys every 45 minutes.\nMigrations run on deploy.\nDeploy window: 10:00-18:00.'));
  run(win, tWin, ['sync']);
  run(rahul, tRahul, ['sync']);
  const rd = read(path.join(rMem, 'deploy.md'));
  assert.ok(rd.includes('20 minutes') && !rd.includes('45 minutes'), `teammate keeps their line without duplicates:\n${rd}`);
  r = review(win, tWin);
  assert.deepStrictEqual(r.pending.map(c => c.kind + ' ' + path.basename(c.path)), ['modified deploy.md']);
  step('conflicting edits: teammate keeps theirs as a pending proposal, no duplicated lines');

  // Owner's second machine: same person, so it writes main too.
  const tMac = clone(teamOrigin, mac, 'team');
  run(mac, tMac, ['setup', '--project', 'app', '--dir', mac.proj, '--machine', 'mac', '--person', 'pp']);
  assert.strictEqual(g(tMac, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.ok(read(path.join(mac.slug, 'memory', 'deploy.md')).includes('45 minutes'));
  assert.strictEqual(review(mac, tMac).pending.length, 1, 'review visible from the second machine');
  run(mac, tMac, ['review', 'reject', 'rahul', 'projects/app/memory/deploy.md']);
  run(win, tWin, ['sync']);
  assert.strictEqual(review(win, tWin).pending.length, 0, 'decision made on mac counts on win');
  step("owner's second machine writes main and shares the review");

  // The owner shares one chat through the team repo; the teammate receives it, but cannot share.
  const chatId = '11111111-2222-4333-8444-555555555555';
  const turn = (role, text) => JSON.stringify({ type: role, sessionId: chatId, cwd: win.proj, uuid: require('crypto').randomUUID(), message: { role, content: text } });
  fs.writeFileSync(path.join(win.slug, `${chatId}.jsonl`), [turn('user', 'How is the app arranged?'), turn('assistant', `Read ${path.join(win.proj, 'README.md')} first.`)].join('\n') + '\n');
  run(win, tWin, ['add', chatId]);
  assert.ok(g(teamOrigin, 'ls-tree', '-r', '--name-only', 'main').includes(`projects/app/chats/${chatId}/meta.json`), 'shared chat on main');
  run(rahul, tRahul, ['sync']);
  const got = read(path.join(rahul.slug, `${chatId}.jsonl`));
  assert.ok(got.includes(`"cwd":${JSON.stringify(rahul.proj)}`), "teammate's copy runs in their own folder");
  fs.writeFileSync(path.join(rahul.slug, 'aaaaaaaa-2222-4333-8444-555555555555.jsonl'), turn('user', 'mine') + '\n');
  assert.ok(run(rahul, tRahul, ['add', 'aaaaaaaa-2222-4333-8444-555555555555'], { fail: true }).includes('only its owner'));
  step("the owner shares a chat with the team; a teammate can't");

  const before = fs.readFileSync(path.join(tWin, 'ccsync.js'), 'utf8');
  const newer = path.join(SB, 'newer.js');
  fs.writeFileSync(newer, before.replace(/const ENGINE_VERSION = (\d+)/, (m, v) => `const ENGINE_VERSION = ${Number(v) + 1}`));
  const up = JSON.parse(run(win, tWin, ['self-update', '--from', newer]));
  assert.ok(up.updated, 'self-update replaces an older engine');
  assert.ok(g(tWin, 'log', '-1', '--format=%s').startsWith('ccsync: update to engine'));
  step('an older engine updates itself');

  const state = JSON.parse(run(win, tWin, ['state']));
  assert.strictEqual(state.team.role, 'owner');
  assert.strictEqual(fs.realpathSync(state.projects[0].attach), fs.realpathSync(privateMem));
  assert.ok(state.projects[0].chats.some(c => c.id === chatId && c.synced), 'state lists the shared chat for the Team view');
  const rState = JSON.parse(run(rahul, tRahul, ['state']));
  assert.ok(rState.projects[0].chats.some(c => c.id === chatId && c.synced && c.local), "the teammate's state lists it too, already local");
  step('state view reports the team role');

  fs.rmSync(SB, { recursive: true, force: true });
  console.log('team: all checks passed');
} catch (e) {
  console.error(`\nFAILED: ${e.message}\nSandbox kept for a look: ${SB}`);
  process.exit(1);
}
