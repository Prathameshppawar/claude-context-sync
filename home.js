// The Home page: what the extension does, how syncing works, and live status.
// Static HTML; the page script fills in the status from the state the extension posts.
'use strict';

const LOGO = `<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="halo-g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8b5cf6"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><rect width="64" height="64" rx="14.7" fill="#0b1020"/><g transform="translate(6.4 6.4) scale(.8)"><path fill="url(#halo-g)" d="M52.49 42.447A23 23 0 1 0 42.447 52.49A10.5 10.5 0 0 1 32.757 46.981A15 15 0 1 1 46.981 32.757A10.5 10.5 0 0 1 52.49 42.447Z"/><path fill="#f8fafc" d="M35 42a7 7 0 1 0 14 0a7 7 0 1 0-14 0Z"/></g></svg>`;

const icon = d => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  memory: icon('<path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h11"/><path d="M9 8h6"/>'),
  pick: icon('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8.5 12 2.5 2.5 4.5-5"/>'),
  resume: icon('<circle cx="12" cy="12" r="8.5"/><path d="M10.5 9v6l4.5-3z" fill="currentColor"/>'),
  projects: icon('<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'),
  safe: icon('<path d="M12 3.5 5 6v5.5c0 4.2 3 7.6 7 9 4-1.4 7-4.8 7-9V6z"/><path d="m9 12 2 2 4-4"/>'),
  private: icon('<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'),
};

const feature = (key, title, text) => `<article class="feature"><span class="ficon">${ICONS[key]}</span><h3>${title}</h3><p>${text}</p></article>`;

// The same picture stacked vertically, for narrow panels.
const DIAGRAM_TALL = `<svg class="tall" viewBox="0 0 320 400" role="img" aria-label="This machine and your other machine each push to and pull from your private repo on GitHub">
  <defs><marker id="arrow-tall" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" class="arrowhead"/></marker></defs>
  <g transform="translate(20 0)">
    <rect class="node" width="280" height="96" rx="10"/>
    <rect class="glyph" x="22" y="30" width="40" height="27" rx="3"/><path class="glyph" d="M14 64h56"/>
    <text class="title" x="88" y="46">This machine</text>
    <text class="small" x="88" y="70">memory notes, chats you ticked</text>
  </g>
  <path class="flow" d="M130 104v38" marker-end="url(#arrow-tall)"/><text class="flowlabel" x="120" y="128" text-anchor="end">push</text>
  <path class="flow" d="M190 142v-38" marker-end="url(#arrow-tall)"/><text class="flowlabel" x="200" y="128">pull</text>
  <g transform="translate(20 150)">
    <rect class="hub" width="280" height="100" rx="12"/>
    <g transform="translate(-42 16)"><path class="glyph hub-glyph" d="M84 46h24a9 9 0 0 0 1.5-17.9A13 13 0 0 0 84.6 31 9.5 9.5 0 0 0 84 46z"/></g>
    <text class="title" x="88" y="50">Your private repo</text>
    <text class="small" x="88" y="72">on GitHub</text>
  </g>
  <path class="flow" d="M130 258v38" marker-end="url(#arrow-tall)"/><text class="flowlabel" x="120" y="282" text-anchor="end">pull</text>
  <path class="flow" d="M190 296v-38" marker-end="url(#arrow-tall)"/><text class="flowlabel" x="200" y="282">push</text>
  <g transform="translate(20 304)">
    <rect class="node" width="280" height="96" rx="10"/>
    <rect class="glyph" x="22" y="30" width="40" height="27" rx="3"/><path class="glyph" d="M14 64h56"/>
    <text class="title" x="88" y="46">Your other machine</text>
    <text class="small" x="88" y="70">same memory, same chats</text>
  </g>
</svg>`;

const DIAGRAM = `<svg class="wide" viewBox="0 0 720 220" role="img" aria-label="This machine and your other machine each push to and pull from your private repo on GitHub">
  <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" class="arrowhead"/></marker></defs>
  <g transform="translate(8 34)">
    <rect class="node" width="194" height="152" rx="10"/>
    <rect class="glyph" x="77" y="20" width="40" height="27" rx="3"/><path class="glyph" d="M69 54h56"/>
    <text class="title" x="97" y="84" text-anchor="middle">This machine</text>
    <text class="small" x="97" y="110" text-anchor="middle">memory notes</text>
    <text class="small" x="97" y="130" text-anchor="middle">chats you ticked</text>
  </g>
  <g transform="translate(263 50)">
    <rect class="hub" width="194" height="120" rx="12"/>
    <path class="glyph hub-glyph" d="M84 46h24a9 9 0 0 0 1.5-17.9A13 13 0 0 0 84.6 31 9.5 9.5 0 0 0 84 46z"/>
    <text class="title" x="97" y="80" text-anchor="middle">Your private repo</text>
    <text class="small" x="97" y="100" text-anchor="middle">on GitHub</text>
  </g>
  <g transform="translate(518 34)">
    <rect class="node" width="194" height="152" rx="10"/>
    <rect class="glyph" x="77" y="20" width="40" height="27" rx="3"/><path class="glyph" d="M69 54h56"/>
    <text class="title" x="97" y="84" text-anchor="middle">Your other machine</text>
    <text class="small" x="97" y="110" text-anchor="middle">same memory</text>
    <text class="small" x="97" y="130" text-anchor="middle">same chats, ready to resume</text>
  </g>
  <path class="flow" d="M206 92h52" marker-end="url(#arrow)"/><text class="flowlabel" x="232" y="83" text-anchor="middle">push</text>
  <path class="flow" d="M258 128h-52" marker-end="url(#arrow)"/><text class="flowlabel" x="232" y="146" text-anchor="middle">pull</text>
  <path class="flow" d="M514 92h-52" marker-end="url(#arrow)"/><text class="flowlabel" x="488" y="83" text-anchor="middle">push</text>
  <path class="flow" d="M462 128h52" marker-end="url(#arrow)"/><text class="flowlabel" x="488" y="146" text-anchor="middle">pull</text>
</svg>`;

const CSS = `
:root {
  --fg: var(--vscode-foreground);
  --muted: var(--vscode-descriptionForeground);
  --bg: var(--vscode-editor-background);
  --card: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
  --border: var(--vscode-widget-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.35)));
  --accent: var(--vscode-textLink-foreground);
  --ok: var(--vscode-testing-iconPassed, #3fb950);
  --warn: var(--vscode-editorWarning-foreground, #d29922);
  --tint: color-mix(in srgb, var(--accent) 14%, transparent);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body { background: var(--bg); color: var(--fg); font-family: var(--vscode-font-family, system-ui, sans-serif); font-size: 14px; line-height: 1.55; }
main { max-width: 960px; margin: 0 auto; padding: 32px 16px 48px; }
h1 { font-size: 26px; line-height: 1.2; margin: 0 0 4px; font-weight: 600; letter-spacing: -0.01em; }
h2 { font-size: 17px; line-height: 1.3; margin: 0 0 12px; font-weight: 600; }
h3 { font-size: 14px; margin: 0 0 4px; font-weight: 600; }
p { margin: 0 0 8px; }
section { margin-top: 36px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
button:focus-visible, a:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
[hidden] { display: none !important; }
.muted, .sub, .feature p, .how p, .lede { color: var(--muted); }

.hero { display: flex; flex-wrap: wrap; gap: 16px 24px; align-items: center; justify-content: space-between; padding-bottom: 24px; border-bottom: 1px solid var(--border); }
.brand { display: flex; gap: 14px; align-items: center; min-width: 0; }
.logo { width: 56px; height: 56px; flex: none; }
.logo svg { width: 100%; height: 100%; display: block; }
.lede { margin: 0; font-size: 14.5px; }
h1 .for { font-weight: 400; color: var(--muted); }
.hero-status { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
.pill { display: inline-flex; align-items: center; gap: 8px; border: 1px solid var(--border); background: var(--card); color: var(--fg); border-radius: 999px; padding: 6px 12px; font: inherit; font-size: 13px; cursor: pointer; }
.pill .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.pill[data-tone="ok"] .dot { background: var(--ok); }
.pill[data-tone="warn"] .dot { background: var(--warn); }
.pill[data-tone="busy"] .dot { background: var(--accent); animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: 0.3; } }
.hero-meta { color: var(--muted); font-size: 12.5px; display: flex; gap: 10px; flex-wrap: wrap; justify-content: flex-end; }

.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 18px 20px; }
.start { margin-top: 24px; border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); }
.steps { margin: 4px 0 4px; padding-left: 20px; }
.steps li { margin: 6px 0; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
.btn { font: inherit; font-size: 13px; padding: 7px 14px; border-radius: 4px; border: 1px solid transparent; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
.btn:hover { background: var(--vscode-button-secondaryHoverBackground); }
.btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.btn.primary:hover { background: var(--vscode-button-hoverBackground); }
.btn.ghost { background: transparent; color: var(--accent); }
.btn.small { padding: 4px 10px; }
.banner { margin-top: 20px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; justify-content: space-between; padding: 10px 14px; border-radius: 8px; background: var(--vscode-inputValidation-infoBackground, var(--card)); border: 1px solid var(--vscode-inputValidation-infoBorder, var(--border)); }

.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-top: 24px; }
.stat { text-align: left; font: inherit; color: inherit; background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 14px 16px; display: flex; flex-direction: column; gap: 2px; }
button.stat { cursor: pointer; }
button.stat:hover { border-color: var(--accent); }
.num { font-size: 26px; font-weight: 600; line-height: 1.15; font-variant-numeric: tabular-nums; }
.num.text { font-size: 18px; line-height: 1.6; }
.label { color: var(--muted); font-size: 12.5px; }

.features { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
.feature { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
.feature p { margin: 0; }
.ficon { display: inline-grid; place-items: center; width: 32px; height: 32px; border-radius: 8px; background: var(--tint); color: var(--accent); margin-bottom: 10px; }
.ficon svg { width: 18px; height: 18px; }

.diagram { margin: 16px 0; padding: 12px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; }
.diagram svg { width: 100%; height: auto; display: block; }
.diagram .tall { display: none; max-width: 340px; margin: 0 auto; }
.diagram .node { fill: var(--bg); stroke: var(--border); stroke-width: 1.5; }
.diagram .hub { fill: color-mix(in srgb, var(--accent) 12%, var(--bg)); stroke: var(--accent); stroke-width: 1.5; }
.diagram .glyph { fill: none; stroke: var(--fg); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.diagram .hub-glyph { stroke: var(--accent); }
.diagram .title { fill: var(--fg); font-size: 15px; font-weight: 600; }
.diagram .small { fill: var(--muted); font-size: 12.5px; }
.diagram .flow { stroke: var(--accent); stroke-width: 1.8; fill: none; }
.diagram .arrowhead { fill: var(--accent); }
.diagram .flowlabel { fill: var(--muted); font-size: 12px; }
.how { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
.how p { margin: 0; }

.timeline { list-style: none; margin: 0; padding: 0 0 0 4px; }
.timeline li { position: relative; padding: 0 0 16px 22px; display: grid; gap: 2px; border-left: 2px solid var(--border); }
.timeline li:last-child { border-left-color: transparent; padding-bottom: 0; }
.timeline li::before { content: ''; position: absolute; left: -7px; top: 5px; width: 12px; height: 12px; border-radius: 50%; background: var(--bg); border: 2px solid var(--accent); }
.timeline .when { font-weight: 600; }
.timeline .what { color: var(--muted); }

.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
ul.check, ul.cross, ul.plain { margin: 8px 0 0; padding: 0; list-style: none; }
ul.check li, ul.cross li { padding-left: 24px; position: relative; margin: 6px 0; }
ul.check li::before { content: '✓'; position: absolute; left: 2px; color: var(--ok); font-weight: 700; }
ul.cross li::before { content: '–'; position: absolute; left: 4px; color: var(--muted); font-weight: 700; }
ul.plain li { margin: 8px 0; }

footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--border); font-size: 12.5px; }
footer p { margin: 0 0 4px; }
@media (max-width: 560px) {
  .hero-status { align-items: flex-start; }
  .hero-meta { justify-content: flex-start; }
  h1 { font-size: 22px; }
  .diagram .wide { display: none; }
  .diagram .tall { display: block; }
}`;

const BODY = `<main>
<header class="hero">
  <div class="brand">
    <span class="logo">${LOGO}</span>
    <div>
      <h1>Context Sync <span class="for">for Claude Code</span></h1>
      <p class="lede">Carry Claude Code's memory, and the chats you choose, between your machines.</p>
    </div>
  </div>
  <div class="hero-status">
    <button id="pill" class="pill" data-tone="off" data-cmd="setup"><span class="dot"></span><span id="pill-text">Loading…</span></button>
    <div class="hero-meta"><span id="meta"></span><a href="#" id="repo" data-cmd="repo" hidden></a></div>
  </div>
</header>

<section class="card start" data-when="no-repo" hidden>
  <h2>Get started</h2>
  <ol class="steps">
    <li><b>Set up a context repo.</b> Create a new private one on GitHub, or clone the one you made on another machine.</li>
    <li><b>Turn on sync for this folder.</b> Claude's memory for it moves into the repo.</li>
    <li><b>Tick the chats</b> you want on your other machines.</li>
  </ol>
  <div class="actions"><button class="btn primary" data-cmd="setup">Set up</button><button class="btn" data-cmd="sidebar">Open the sidebar</button></div>
</section>

<section class="card start" data-when="not-configured" hidden>
  <h2>Turn on sync for <span class="folder-name">this folder</span></h2>
  <p class="muted">Your context repo is on this machine. Turn sync on and Claude's memory for this folder moves into it. Then tick the chats you want to share.</p>
  <div class="actions"><button class="btn primary" data-cmd="enable">Turn on sync</button></div>
</section>

<div class="banner" id="banner-folder" hidden>
  <span><b class="folder-name">This folder</b> isn't synced yet.</span>
  <button class="btn primary small" data-cmd="enable">Turn on sync</button>
</div>

<div class="banner" id="banner-review" hidden>
  <span><b id="review-count">0</b> team note change(s) wait for your review.</span>
  <button class="btn primary small" data-cmd="team">Review</button>
</div>

<section data-when="ready" hidden>
  <div class="stats">
    <button class="stat" data-cmd="sidebar"><span class="num" id="st-projects">0</span><span class="label">projects syncing</span></button>
    <div class="stat"><span class="num" id="st-notes">0</span><span class="label">memory notes</span></div>
    <button class="stat" data-cmd="pick"><span class="num" id="st-chats">0</span><span class="label" id="st-chats-label">chats synced</span></button>
    <button class="stat" data-cmd="sync"><span class="num text" id="st-last">never</span><span class="label">last sync</span></button>
  </div>
  <div class="actions">
    <button class="btn primary" data-cmd="sync">Sync now</button>
    <button class="btn" data-cmd="pick">Pick chats…</button>
    <button class="btn" data-cmd="current">Sync current chat</button>
    <button class="btn" data-cmd="sidebar">Open sidebar</button>
    <button class="btn ghost" data-cmd="log">Sync log</button>
  </div>
</section>

<section>
  <h2>What it does</h2>
  <div class="features">
    ${feature('memory', 'Memory follows you', "Claude's notes about your project live in your repo, so every machine reads the same memory.")}
    ${feature('pick', 'Pick the chats that matter', 'Tick a chat in the sidebar and it appears on your other machines.')}
    ${feature('resume', 'Carry on where you left off', 'Press ▶ on a synced chat to reopen it in a Claude tab, with the whole conversation.')}
    ${feature('projects', 'One project or all of them', 'Turn sync on for one folder, or for every folder Claude has worked in.')}
    ${feature('safe', 'Never overwrites', 'A chat open here is not replaced. A chat continued on two machines arrives as a separate copy.')}
    ${feature('private', 'Private, and yours', 'Plain git and a private repo you own. No extra service and no account beyond GitHub.')}
  </div>
</section>

<section>
  <h2>How it works</h2>
  <p class="sub">There is no service in the middle. Each machine keeps a copy of a private git repo you own, and the copies meet on GitHub.</p>
  <figure class="diagram">${DIAGRAM}${DIAGRAM_TALL}</figure>
  <div class="how">
    <div><h3>Memory</h3><p>Claude reads and writes its notes inside the repo, so nothing has to be copied.</p></div>
    <div><h3>Chats</h3><p>A ticked chat is stored in small pieces, and each upload adds only what is new. The other machine puts it back where Claude keeps chats, so ▶ or /resume opens it.</p></div>
    <div><h3>Different folders</h3><p>Each machine can keep the project somewhere else. Paths inside a chat are rewritten for the machine that opens it.</p></div>
  </div>
</section>

<section>
  <h2>When it syncs</h2>
  <ol class="timeline">
    <li><span class="when">A Claude session starts</span><span class="what">Pulls first, so chats from your other machines are ready to resume.</span></li>
    <li><span class="when">Claude finishes a reply</span><span class="what">New memory goes up in the background. Ticked chats go at most every 20 minutes.</span></li>
    <li><span class="when">The session ends</span><span class="what">Everything goes up.</span></li>
    <li><span class="when">While VS Code is open</span><span class="what">Pulls every 10 minutes. Sync now does it straight away.</span></li>
  </ol>
</section>

<section class="two">
  <div class="card"><h3>What travels</h3><ul class="check"><li>Memory notes for the projects you turned on</li><li>The chats you ticked</li></ul></div>
  <div class="card"><h3>What stays on this machine</h3><ul class="cross"><li>Chats you didn't tick</li><li>Your Claude login and settings</li><li>Your code, which has its own repos</li></ul></div>
</section>

<section>
  <h2>If both machines change something</h2>
  <ul class="plain">
    <li><b>A chat that's open here</b> isn't replaced. It updates once you close it.</li>
    <li><b>A chat continued on both machines</b> arrives as a separate "(machine copy)" chat, so nothing is lost.</li>
    <li><b>A memory note edited on both</b> keeps both sets of lines.</li>
    <li><b>No internet?</b> Changes are saved and go up at the next sync.</li>
  </ul>
</section>

<section>
  <h2>Working with a team</h2>
  <p class="sub">Share one project's memory with the people on it, without exposing your other projects or your private notes.</p>
  <div class="how">
    <div><h3>One team repo per project</h3><p>Only that project's team notes go in it. Teammates never see your other repos, your private notes or your chats. In your memory the team notes appear under team/.</p></div>
    <div><h3>You approve what reaches everyone</h3><p>Each teammate's changes go to their own branch. Nothing reaches the team until you accept it, here in the Team view or as a pull request on GitHub.</p></div>
    <div><h3>Claude helps you merge</h3><p>Merge With Claude combines a teammate's version with the approved one, flags contradictions and drops secrets. You can edit the result before accepting it.</p></div>
  </div>
  <div class="actions"><button class="btn" data-cmd="createTeam">Create a team repo</button><button class="btn" data-cmd="joinTeam">Join a team repo</button><button class="btn ghost" data-cmd="team" id="team-open" hidden>Open the Team view</button></div>
</section>

<footer>
  <p>Keep the repo private: memory can include anything you told Claude, and chats include full tool output.</p>
  <p class="muted">An independent project, not affiliated with Anthropic. <a href="#" data-cmd="settings">Settings</a></p>
</footer>
</main>`;

// Runs inside the webview (serialized with toString), so it can't use anything from this module.
function pageScript() {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  let last = null;

  document.addEventListener('click', e => {
    const el = e.target.closest('[data-cmd]');
    if (!el) return;
    e.preventDefault();
    vscode.postMessage({ cmd: el.dataset.cmd });
  });

  function ago(ms) {
    if (!ms) return 'never';
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(ms).toLocaleDateString();
  }

  function render(s) {
    last = s;
    document.querySelectorAll('[data-when]').forEach(el => (el.hidden = el.dataset.when !== s.phase));
    let tone = 'off';
    let text = 'Not set up';
    let cmd = 'setup';
    if (s.phase === 'not-configured') {
      text = 'Not on for this folder yet';
      cmd = 'enable';
    } else if (s.phase === 'ready') {
      cmd = 'sync';
      if (s.busy) {
        tone = 'busy';
        text = 'Syncing…';
      } else if (s.notices) {
        tone = 'warn';
        text = `${s.notices} problem${s.notices > 1 ? 's' : ''} to look at`;
        cmd = 'problems';
      } else if (s.offline) {
        tone = 'warn';
        text = 'Offline, will retry';
      } else {
        tone = 'ok';
        text = `Synced ${ago(s.lastSync)}`;
      }
    }
    const pill = $('pill');
    pill.dataset.tone = tone;
    pill.dataset.cmd = cmd;
    $('pill-text').textContent = text;
    $('meta').textContent = s.machine ? `This machine: ${s.machine}` : '';
    const repo = $('repo');
    repo.hidden = !s.remote;
    if (s.remote) repo.textContent = s.remote.replace(/^https?:\/\/(www\.)?github\.com\//, '');
    document.querySelectorAll('.folder-name').forEach(el => (el.textContent = s.folder || 'this folder'));
    $('banner-folder').hidden = !(s.phase === 'ready' && s.folder && !s.folderEnabled);
    $('banner-review').hidden = !(s.toReview > 0);
    $('review-count').textContent = s.toReview || 0;
    $('team-open').hidden = !s.teams;
    if (s.waiting) $('meta').textContent += ` · ${s.waiting} of your team change${s.waiting > 1 ? 's' : ''} awaiting review`;
    $('st-projects').textContent = s.projects;
    $('st-notes').textContent = s.notes;
    $('st-chats').textContent = s.synced;
    $('st-chats-label').textContent = `chats synced, of ${s.chats}`;
    $('st-last').textContent = ago(s.lastSync);
  }

  window.addEventListener('message', e => render(e.data));
  setInterval(() => last && render(last), 30000);
  vscode.postMessage({ cmd: 'ready' });
}

function homeHtml(nonce, headExtra = '') {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Context Sync</title>
<style>${CSS}</style>
${headExtra}
</head>
<body>
${BODY}
<script nonce="${nonce}">(${pageScript.toString()})();</script>
</body>
</html>`;
}

module.exports = { homeHtml };
