#!/usr/bin/env node
'use strict';
// WoW AI bridge: the half of WoWAI that lives outside the game.
//
//   OUT  capture.ps1 screen-captures the addon's pixel strip -> one or more
//        {session, chat, id, cwd, flags, text} records per frame
//        (fallback: the game's SavedVariables file, written on /reload)
//   RUN  the chat's agent (Claude Code, Codex or Grok; see agents.js) headless
//        in the chat's folder, streaming progress. Each chat is its own agent
//        session; up to maxParallel run at once.
//   IN   we write the latest reply/status of every chat into every
//        WoWAI_S### slot addon (the game loads a fresh one from a timer),
//        flip a signal .wav per message, and also write Inbox.lua for the
//        reload path.
//
// Zero npm dependencies. Run with npm start or `node bridge.js`.
//   --once            handle one pending SavedVariables prompt and exit
//   --inject "text"   pretend the strip said this and exit when done
//   --agent <id>      agent for --inject (default: "agent" in config.json)
//   --project <dir>   default folder for chats that haven't picked one
//
// Like the agent CLIs themselves, the bridge works in the folder it was started
// from: `cd my-project && wow-ai` makes my-project the default for every chat
// that hasn't chosen its own with /wow-ai cd. Started from inside this repo (npm
// start), it falls back to defaultCwd in config.json.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const P = require('./protocol'); // the pure protocol code, unit-tested in tests/bridge_test.js
const A = require('./agents');   // how each agent is launched and read, unit-tested in tests/agents_test.js
const Code = require('./code');  // agent-proposed addon code: checked, put in a slot for the player to load (docs/CODE.md)
const Lint = require('./lint');
const Reminder = require('./reminder'); // when to ask the agent for a tip, and what counts as one (docs/REMINDER.md)
const Router = require('./router');     // when to ask the agent for a route, and what is taken from the answer (docs/ROUTER.md)
const Feed = require('./feed');  // the event feed: files and a prompt summary built from what the addon reports (docs/EVENTS.md)

const HERE = __dirname;
const CONFIG_FILE = path.join(HERE, 'config.json');
const STATE_FILE = path.join(HERE, 'state.json');
const LOG_FILE = path.join(HERE, 'bridge.log');
const TMP_DIR = path.join(HERE, 'tmp'); // prompt files for agents that read the prompt from disk

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('wow-ai [--project <dir>] [--once] [--inject "text" [--agent <id>]] [--inject-feed <file> [--feed-id <n>]]\n\n' +
    '--inject-feed feeds a saved event-feed payload (docs/EVENTS.md) through the bridge as if the game had sent it, then exits.\n' +
    'Runs the WoW AI bridge. Chats without a folder of their own work in <dir>,\n' +
    'or in the folder you started it from, or in defaultCwd from bridge/config.json.\n' +
    `Agents: ${A.agentIds().join(', ')} (the default is "agent" in config.json; chats pick with /wow-ai agent).`);
  process.exit(0);
}
let cfg;
try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
catch (e) {
  console.error(`Cannot read ${CONFIG_FILE} (${e.message}).\nRun "node setup.js" in the wow-ai folder first.`);
  process.exit(2); // the supervisor doesn't restart on 2
}
const once = argv.includes('--once');
const injectIdx = argv.indexOf('--inject');
const inject = injectIdx >= 0 ? argv[injectIdx + 1] : null;
const agentIdx = argv.indexOf('--agent');
const injectAgent = agentIdx >= 0 ? argv[agentIdx + 1] : '';
let exitWhenIdle = once || inject !== null;
const injectFeedIdx = argv.indexOf('--inject-feed');
const injectFeed = injectFeedIdx >= 0 ? argv[injectFeedIdx + 1] : null;
const feedIdIdx = argv.indexOf('--feed-id');
const injectFeedId = feedIdIdx >= 0 ? Number(argv[feedIdIdx + 1]) : Date.now() % 1000000000;

// The agent chats use unless they pick their own (/wow-ai agent, "agent=" flag).
const DEFAULT_AGENT = A.normalizeAgent(cfg.agent || A.DEFAULT_AGENT);
if (!DEFAULT_AGENT) {
  console.error(`"agent": "${cfg.agent}" in ${CONFIG_FILE} is not one of ${A.agentIds().join(', ')}.`);
  process.exit(2);
}

// Default folder: --project, else the folder we were started from (unless that is
// this repo, i.e. npm start), else the configured one.
const REPO = path.dirname(HERE);
function insideRepo(dir) {
  const rel = path.relative(REPO, dir);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
const projectIdx = argv.indexOf('--project');
const DEFAULT_CWD = path.resolve(
  projectIdx >= 0 && argv[projectIdx + 1] ? argv[projectIdx + 1]
    : process.env.WOW_AI_PROJECT ? process.env.WOW_AI_PROJECT
    : !insideRepo(process.cwd()) ? process.cwd()
    : cfg.defaultCwd || process.cwd());
const DEFAULT_CWD_SOURCE = projectIdx >= 0 ? '--project' : process.env.WOW_AI_PROJECT ? 'WOW_AI_PROJECT'
  : !insideRepo(process.cwd()) ? 'started here' : 'config.json';

const resolveCwd = raw => P.resolveCwd(raw, DEFAULT_CWD);
const { sameFolder } = P;
// Subfolders of the default folder, for the "folder not found" hint.
function siblingFolders() {
  try {
    return fs.readdirSync(DEFAULT_CWD, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .map(d => d.name).sort().slice(0, 30);
  } catch { return []; }
}

const SLOTS = cfg.slots || 200;
const MAX_PARALLEL = cfg.maxParallel || 3;
const cap = Object.assign({ enabled: true, processName: 'WowB', cellPx: 4, cellsPerRow: 200, maxRows: 48, intervalMs: 250 }, cfg.capture || {});
// The game-side files. A config.json written for the addon's old name
// (WoWClaude) still works: the paths are derived from addonDir instead.
const INBOX_FILE = cfg.inboxFile && !/WoWClaude/.test(cfg.inboxFile) ? cfg.inboxFile : path.join(cfg.addonDir || '', 'WoWAI', 'Inbox.lua');
const SAVED_VARS = String(cfg.savedVariablesFile || '').replace(/WoWClaude\.lua$/, 'WoWAI.lua');

let state = readJson(STATE_FILE, { lastId: 0, sessions: {}, handled: {} });
if (!state.handled) state.handled = {};
if (!state.sessions) state.sessions = {};
if (!state.feed) state.feed = {};
if (!state.code) state.code = {};
// Older versions stored handled[session] as "highest id so far"; expand to a map.
for (const [k, v] of Object.entries(state.handled)) {
  if (typeof v === 'number') {
    const m = {};
    for (let i = 1; i <= v; i++) m[i] = 1;
    state.handled[k] = m;
  }
}

// The event feed (docs/EVENTS.md): files in <default folder>/state that the agent can Read,
// plus a short summary in its system prompt. "feed": { "enabled": false } turns it off;
// "dir" moves the files. Events never start an agent run.
const FEED_CFG = Object.assign({ enabled: true, dir: '', maxFileBytes: 2000000, transportFile: '', dailyLog: true }, cfg.feed || {});
const FEED_DIR = path.resolve(FEED_CFG.dir || path.join(DEFAULT_CWD, 'state'));
const feed = FEED_CFG.enabled === false ? null
  : Feed.createFeedHub({ dir: FEED_DIR, store: state.feed, log: (...a) => log(...a), maxFileBytes: FEED_CFG.maxFileBytes, dailyLog: FEED_CFG.dailyLog !== false,
      transportFile: path.resolve(FEED_CFG.transportFile || path.join(__dirname, '..', 'data', 'transport.json')) });

// Agent-proposed addon code (docs/CODE.md). Off unless "code": { "enabled": true } is set: the agent
// is not told about it and wowcode blocks in replies are left alone. Even when on, the bridge only writes
// checked code into an unloaded slot addon; the player loads it in the game, by hand, each session.
const CODE_CFG = Object.assign({ enabled: false, slots: 20, maxBytes: Lint.LIMITS.maxBytes }, cfg.code || {});
const codePool = CODE_CFG.enabled === true
  ? Code.createPool({ addonDir: cfg.addonDir, auditDir: path.join(FEED_DIR, 'code'), store: state.code, slots: CODE_CFG.slots, maxBytes: CODE_CFG.maxBytes, log: (...a) => log(...a) })
  : null;
const CODE_HINT = codePool ? P.codeHint(Lint.describe()) : '';

// The reminder (docs/REMINDER.md): every few game events the bridge asks the agent, on its own, whether the
// player forgot something or could do better. "reminder": { "enabled": false } turns it off. The ids and the
// last tips live in state.json.
if (!state.reminder) state.reminder = state.coach || {};   // 'coach' was the first name
if (state.reminderSig === undefined && state.coachSig) state.reminderSig = state.coachSig;
const reminder = feed ? Reminder.createReminder(cfg.reminder || {}, { store: state.reminder }) : null;
const REMINDER_JOB_BASE = 2000000000;   // never an addon message id

// The router (docs/ROUTER.md): every couple of game events the bridge asks the agent, on its own, for the
// next route; it is drawn as the "route" layer of the map and nothing is written to the chat.
// "router": { "enabled": false } turns it off.
if (!state.router) state.router = {};
const router = feed ? Router.createRouter(cfg.router || {}, { store: state.router }) : null;
const ROUTER_JOB_BASE = 1900000000;     // never an addon message id, nor a reminder's

// Bridge-side transcripts. The beta client sometimes wipes addon saved data; since
// every prompt and reply passes through here, this copy lets the addon recover.
const TRANSCRIPT_FILE = path.join(HERE, 'transcripts.json');
let transcripts = readJson(TRANSCRIPT_FILE, { chats: {}, tokens: {} });
if (!transcripts.chats) transcripts.chats = {};
if (!transcripts.tokens) transcripts.tokens = {};
if (P.pruneStale(state, transcripts)) { saveState(); saveTranscripts(); }
let pendingRestore = null;

function saveTranscripts() {
  try { atomicWrite(TRANSCRIPT_FILE, JSON.stringify(transcripts)); } catch (e) { log('could not save transcripts:', e.message); }
}

// Chats the player deleted in game while a run for them was still going: the
// run's late progress and reply must not recreate the transcript.
const forgotten = new Set();

function noteMessage(job, role, text) {
  if (!job.chat) return;
  if (role === 'user') forgotten.delete(job.chat);
  else if (forgotten.has(job.chat)) return;
  const c = transcripts.chats[job.chat] = transcripts.chats[job.chat] || { id: job.chat, name: '', cwd: job.cwd, messages: [] };
  if (job.name) c.name = job.name;
  if (job.cwd) c.cwd = job.cwd;
  const m = { role, text: String(text ?? '').slice(0, 4000), id: job.id, t: Math.floor(Date.now() / 1000) };
  if (role === 'assistant' && job.agent) m.agent = job.agent;
  c.messages.push(m);
  while (c.messages.length > 200) c.messages.shift();
  c.updated = Date.now();
  saveTranscripts();
}

// First message from an addon session token we haven't seen: its saved data is
// fresh (or reset), so offer everything we know once, in the next publish.
function maybeOfferRestore(job) {
  if (!job.session || transcripts.tokens[job.session]) return;
  transcripts.tokens[job.session] = Date.now();
  const chats = Object.values(transcripts.chats)
    .filter(c => c.id !== job.chat && c.messages.length)
    .sort((a, b) => (b.updated || 0) - (a.updated || 0))
    .slice(0, 16)
    .map(c => ({ id: c.id, name: c.name, cwd: c.cwd, messages: c.messages.slice(-40).map(m => ({ ...m, text: m.text.slice(0, 2000) })) }));
  saveTranscripts();
  if (chats.length) {
    pendingRestore = { token: job.session, chats };
    log(`new addon session ${job.session}: offering ${chats.length} chat(s) to restore`);
  }
}

// The player deleted a chat in game. Drop everything we keep for it, so the next
// restore doesn't bring it back and its id can't resume the old agent session.
function forgetChat(job) {
  if (!job.chat) return;
  const had = !!transcripts.chats[job.chat];
  delete transcripts.chats[job.chat];
  forgotten.add(job.chat);
  delete state.sessions[sessKey(job)];
  delete state.sessions[chatKey(job)];
  if (state.sessionCwd) delete state.sessionCwd[sessKey(job)];
  if (state.sessionAgent) delete state.sessionAgent[sessKey(job)];
  if (pendingRestore) pendingRestore.chats = pendingRestore.chats.filter(c => c.id !== job.chat);
  saveTranscripts();
  log(`#${job.id}${job.session ? '@' + job.session : ''} forgot chat ${job.chat}${had ? '' : ' (nothing stored)'}`);
}

let lastMtime = 0;
const running = new Map(); // chatKey -> { job, child }
const queued = new Map();  // chatKey -> job waiting for that chat (or for a free parallel slot)
const live = new Map();    // chatKey -> latest record shown to the game
let lastPublish = 0;
let publishTimer = null;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function saveState() {
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2));
}

function log(...parts) {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch {}
}

const { pad3, chatKey, sessKey, SILENT_WAV, jobsFromStrip } = P;
const slotNumber = id => P.slotNumber(id, SLOTS);
const alreadyHandled = job => P.alreadyHandled(state, job);
const markHandled = job => P.markHandled(state, job);

function atomicWrite(file, content) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

// Stop a run and whatever it spawned (an npm launcher runs the real binary as a
// child of its own; on Windows a plain kill would leave that one going).
function killTree(child) {
  if (process.platform === 'win32') {
    try {
      const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      k.on('error', () => { try { child.kill(); } catch {} });
      return;
    } catch {}
  }
  try { child.kill(); } catch {}
}

// ---------------------------------------------------------------------------
// What the game reads
// ---------------------------------------------------------------------------

// Map layers the agent drew (see protocol.js, "Map layers"). The bridge is the source of
// truth; slot files carry the whole set while the game may not have it yet: for a
// while after it changes, and after every hello (a fresh or wiped client).
if (!state.map) state.map = P.newMap();
const MAP_DIR = path.join(HERE, 'mapjobs');
// Every publish rewrites all slot files, so the map rides along only for a short
// while, and on progress publishes only while it is small.
const MAP_SHARE_MS = 3 * 60 * 1000;
const MAP_PROGRESS_MAX = 20000;
let mapShareUntil = Object.keys(state.map.layers).length ? Date.now() + MAP_SHARE_MS : 0;
let mapLuaCache = { version: -1, epoch: '', text: '' };
function mapLuaSize() {
  if (mapLuaCache.version !== state.map.version || mapLuaCache.epoch !== state.map.epoch) {
    mapLuaCache = { version: state.map.version, epoch: state.map.epoch, text: P.luaMap(state.map) };
  }
  return mapLuaCache.text.length;
}

function mapFileFor(job) {
  return path.join(MAP_DIR, `${String(job.chat || 'default').replace(/[^\w-]/g, '_')}-${job.id}.jsonl`);
}

// Collect what the run asked for (its map file, then ```wowmap blocks in its
// reply), apply it, and return the reply text without the blocks plus a note
// for the reply, if anything was asked.
function takeMapCommands(job, text) {
  const file = mapFileFor(job);
  let cmds = [], errors = [];
  try {
    const r = P.parseMapFile(fs.readFileSync(file, 'utf8'));
    cmds = r.cmds; errors = r.errors;
  } catch {}
  try { fs.unlinkSync(file); } catch {}
  const blocks = P.extractMapBlocks(text);
  cmds.push(...blocks.cmds);
  errors.push(...blocks.errors);
  if (!cmds.length && !errors.length) return { text: blocks.text, note: '' };
  const { changed, notes } = P.applyMapCommands(state.map, cmds);
  if (changed) { saveState(); mapShareUntil = Date.now() + MAP_SHARE_MS; }
  const all = [...notes, ...errors];
  log(`#${job.id} map: ${all.join('; ') || 'no change'} (version ${state.map.version})`);
  return { text: blocks.text, note: all.length ? `map: ${all.join('; ')}` : '' };
}

// Slot file / Inbox.lua body: see protocol.luaTable.
function slotFile(globalName, records, urgent = true) {
  const map = Date.now() < mapShareUntil && (urgent || mapLuaSize() <= MAP_PROGRESS_MAX) ? state.map : null;
  return P.luaTable(globalName, records, { cwd: DEFAULT_CWD, restore: pendingRestore, agent: DEFAULT_AGENT, agents: A.agentIds(), map });
}

function addonInstalled() {
  return fs.existsSync(path.join(cfg.addonDir, 'WoWAI', 'WoWAI.toc'));
}

function slotsInstalled() {
  return fs.existsSync(path.join(cfg.addonDir, 'WoWAI_S001', 'Inbox.lua'));
}

// The game will load *some* unused slot next, so every slot gets the full picture.
// A missing addon folder (not installed yet, or the game folder moved) must not
// take the bridge down: capture and agent runs keep working, and the game just
// won't see replies until `node setup.js` has run and WoW was restarted.
let warnedNoAddon = false;
function publishNow(urgent = true) {
  lastPublish = Date.now();
  const records = [...live.values()].slice(-30);
  try {
    atomicWrite(INBOX_FILE, slotFile('WoWAI_Inbox', records, urgent));
  } catch (e) {
    if (!warnedNoAddon) {
      warnedNoAddon = true;
      log(`publish: cannot write ${INBOX_FILE} (${e.code || e.message}); addon not installed? run: node setup.js, then restart WoW`);
    }
    return;
  }
  if (!slotsInstalled()) return;
  const body = slotFile('WoWAI_SlotData', records, urgent);
  for (let i = 1; i <= SLOTS; i++) {
    try { atomicWrite(path.join(cfg.addonDir, 'WoWAI_S' + pad3(i), 'Inbox.lua'), body); } catch {}
  }
  // The restore bundle is large; it rides along once and is then dropped.
  // (The game keeps loading fresh slots until it has read one carrying it.)
  if (pendingRestore) { pendingRestore.published = (pendingRestore.published || 0) + 1; if (pendingRestore.published >= 3) pendingRestore = null; }
}

// Final results publish immediately; progress is throttled. `key` is the chat
// (record.session is the agent's session id, a different thing).
function publish(key, record, urgent) {
  live.set(key, record);
  if (urgent) { if (publishTimer) { clearTimeout(publishTimer); publishTimer = null; } publishNow(); return; }
  const wait = (cfg.progressWriteMs || 3000) - (Date.now() - lastPublish);
  if (wait <= 0) publishNow(false);
  else if (!publishTimer) publishTimer = setTimeout(() => { publishTimer = null; publishNow(false); }, wait);
}

function signal(kind, id, on) {
  const file = path.join(cfg.addonDir, 'WoWAI', kind, pad3(slotNumber(id)) + '.wav');
  try { atomicWrite(file, on ? SILENT_WAV : Buffer.alloc(0)); } catch {}
}

// Heartbeat: act/NNN/kk.wav flips valid for the k-th action of message NNN. The
// game polls the next one for free, so it can show "12 actions, last one 5 s ago"
// without spending a reply slot.
const ACT_MAX = cfg.actMax || 60;
function actFile(id, k) {
  return path.join(cfg.addonDir, 'WoWAI', 'act', pad3(slotNumber(id)), String(k).padStart(2, '0') + '.wav');
}
function resetBeats(id) {
  for (let k = 1; k <= ACT_MAX; k++) { try { atomicWrite(actFile(id, k), Buffer.alloc(0)); } catch {} }
}
function beat(job) {
  job.beats = (job.beats || 0) + 1;
  if (job.beats > ACT_MAX) return;
  try { atomicWrite(actFile(job.id, job.beats), SILENT_WAV); } catch {}
}

// Presence: every 30 s flip the next presence/NNNN.wav valid so the game can tell
// the bridge is alive without spending a slot. The counter persists across
// restarts so a filename is never reused while the game is still running; the
// files just ahead of the counter are kept empty so the game can't run ahead.
const PRESENCE_MAX = cfg.presenceMax || 2000;
function presenceFile(k) {
  return path.join(cfg.addonDir, 'WoWAI', 'presence', String(k).padStart(4, '0') + '.wav');
}
function presenceBeat() {
  if (!fs.existsSync(path.join(cfg.addonDir, 'WoWAI', 'presence'))) return;
  state.presence = ((state.presence || 0) % PRESENCE_MAX) + 1;
  const k = state.presence;
  try { atomicWrite(presenceFile(k), SILENT_WAV); } catch {}
  for (let j = 1; j <= 50; j++) {
    const n = ((k - 1 + j) % PRESENCE_MAX) + 1;
    try { atomicWrite(presenceFile(n), Buffer.alloc(0)); } catch {}
  }
  saveState();
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

// The reload path: the addon writes its outbox into SavedVariables on /reload.
function readOutbox() {
  let src;
  try { src = fs.readFileSync(SAVED_VARS, 'utf8'); } catch { return null; }
  return P.parseOutbox(src);
}

// The addon sends the player's in-game context (character, location, ...) with
// its hello and again whenever it changes; an empty one means "context off".
// It is kept in state.json so a restarted bridge still has it, and goes into
// the agent's system prompt on every run (see protocol.systemPrompt).
function setContext(job) {
  const text = String(job.ctx || '').replace(/\r/g, '').trim().slice(0, 2000);
  const prev = (state.context && state.context.text) || '';
  if (text === prev) return;
  state.context = text ? { text, at: Date.now(), session: job.session || '' } : null;
  saveState();
  const who = (text.split('\n').find(l => /^Character:/i.test(l)) || text.split('\n')[0] || '').slice(0, 100);
  log(`#${job.id}${job.session ? '@' + job.session : ''} game context ${text ? 'updated: ' + who : 'cleared'}`);
}

function gameContext() {
  if (cfg.gameContext === false) return '';
  return (state.context && state.context.text) || '';
}

// The addon/macro primer that goes into the system prompt with the context.
// Read on every run so edits count without a restart; "" in the config turns
// it off. Relative paths are taken from the repo (docs/WOW-ADDON-PRIMER.md).
const PRIMER_FILE = cfg.primerFile === undefined ? 'docs/WOW-ADDON-PRIMER.md' : cfg.primerFile;
let warnedNoPrimer = false;
function primer() {
  if (!PRIMER_FILE) return '';
  const file = path.resolve(REPO, PRIMER_FILE);
  try { return fs.readFileSync(file, 'utf8'); } catch (e) {
    if (!warnedNoPrimer) { warnedNoPrimer = true; log(`primer: cannot read ${file} (${e.code || e.message}); running without it`); }
    return '';
  }
}

// Persist newly allowed rules for an agent so they stick across bridge restarts.
// They go under agents.<id>.allowedTools; a config.json from before agents
// existed keeps Claude's list at the top level, which moves down on first write.
function allowRules(agentId, rules) {
  const current = new Set(A.agentConfig(cfg, agentId).allowedTools || []);
  const added = rules.filter(r => r && !current.has(r));
  if (!added.length) return [];
  const list = [...current, ...added];
  cfg.agents = cfg.agents || {};
  cfg.agents[agentId] = { ...(cfg.agents[agentId] || {}), allowedTools: list };
  try {
    const onDisk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    onDisk.agents = onDisk.agents || {};
    onDisk.agents[agentId] = { ...(onDisk.agents[agentId] || {}), allowedTools: list };
    if (agentId === 'claude') delete onDisk.allowedTools;
    atomicWrite(CONFIG_FILE, JSON.stringify(onDisk, null, 2) + '\n');
  } catch (e) { log('could not save config.json:', e.message); }
  return added;
}

// ---------------------------------------------------------------------------
// Running an agent
// ---------------------------------------------------------------------------

function submit(job) {
  if (job.event) {
    // Event-feed record: write the files, no ack signal (it has none) and no agent run.
    if (!feed) return;
    try {
      const r = feed.ingest(job);
      if (!r.dup) {
        saveState();
        if (reminder && reminder.note(r.key, r.types)) maybeReminder();
        if (router && router.note(r.key, r.types)) maybeRoute();
      }
    } catch (e) { log(`feed: could not store #${job.id}: ${e.message}`); }
    return;
  }
  if (alreadyHandled(job)) return;
  if (job.ctx !== undefined) setContext(job);
  if (job.forget) {
    // A deleted chat: forget it and ack. No agent run.
    markHandled(job);
    forgetChat(job);
    saveState();
    signal('ack', job.id, true);
    return;
  }
  if (job.hello) {
    // The addon announcing itself: ack, offer a restore if its data is fresh,
    // and refresh the slots so it can read our clock. No agent run.
    markHandled(job);
    saveState();
    signal('ack', job.id, true);
    maybeOfferRestore(job);
    // Even an empty set: a client holding layers from a reset bridge must drop them.
    mapShareUntil = Date.now() + MAP_SHARE_MS;
    publishNow();
    log(`hello from session ${job.session}${pendingRestore ? ' (restore offered)' : ''}`);
    return;
  }
  const key = chatKey(job);
  const cur = running.get(key);
  if (cur && cur.job.id === job.id) return;
  const q = queued.get(key);
  if (q && q.id === job.id) return;
  if (cur || running.size >= MAX_PARALLEL) {
    queued.set(key, job);
    log(`#${job.id}${job.session ? '@' + job.session : ''} queued (${cur ? 'chat busy' : running.size + ' running'})`);
    return;
  }
  runJob(job);
}

function drainQueue() {
  for (const [key, job] of queued) {
    if (running.size >= MAX_PARALLEL) break;
    if (running.has(key)) continue;
    queued.delete(key);
    runJob(job);
  }
}

// A run the bridge starts on its own (a reminder check, a route update): silent, no chat, no session kept.
const automatic = job => !!(job.reminder || job.router);

function runJob(job) {
  const key = chatKey(job);
  const cwd = resolveCwd(job.cwd);
  job.cwd = cwd;
  const tag = `#${job.id}${job.session ? '@' + job.session : ''}`;
  if (!automatic(job)) {
    signal('sig', job.id, false);
    resetBeats(job.id);
    signal('ack', job.id, true);
  }
  if (!fs.existsSync(cwd)) {
    log(`${tag} cwd does not exist: ${cwd}`);
    const sibs = siblingFolders();
    finish(job, 'error', `Folder does not exist: ${cwd}\n` +
      `Paths are relative to ${DEFAULT_CWD}.` +
      (sibs.length ? `\nFolders there: ${sibs.join(', ')}` : '') +
      `\nUse /wow-ai cd <folder> to pick one, or /wow-ai cd alone for the default.`);
    return;
  }
  // Which agent: the chat's own (an "agent=" flag), else the bridge's default.
  const agentId = job.agent ? A.normalizeAgent(job.agent) : DEFAULT_AGENT;
  if (!agentId) {
    log(`${tag} unknown agent "${job.agent}"`);
    finish(job, 'error', `Unknown agent "${job.agent}". This bridge knows: ${A.agentIds().join(', ')}.\n` +
      `Use /wow-ai agent <name> to pick one, or /wow-ai agent alone for the default (${DEFAULT_AGENT}).`);
    return;
  }
  job.agent = agentId;
  const agent = A.AGENTS[agentId];
  const acfg = A.agentConfig(cfg, agentId);
  const cmd = A.resolveCommand(agentId, acfg);
  if (!cmd.found) {
    log(`${tag} ${agentId} not found: ${cmd.note}`);
    finish(job, 'error', `${agent.name} is not installed on the bridge PC: ${cmd.note}.`);
    return;
  }
  const skey = sessKey(job);
  if (job.newSession) { delete state.sessions[skey]; delete state.sessions[key]; }
  // Agents keep sessions per project folder, and a session belongs to the agent
  // that made it, so a chat that changes either starts fresh.
  const prevCwd = state.sessionCwd && state.sessionCwd[skey];
  if (prevCwd && !sameFolder(prevCwd, cwd) && state.sessions[skey]) {
    log(`${tag} folder changed (${prevCwd} -> ${cwd}): new session`);
    delete state.sessions[skey]; delete state.sessions[key];
  }
  const prevAgent = (state.sessionAgent && state.sessionAgent[skey]) || 'claude';
  if (prevAgent !== agentId && state.sessions[skey]) {
    log(`${tag} agent changed (${prevAgent} -> ${agentId}): new session`);
    delete state.sessions[skey]; delete state.sessions[key];
  }
  if (Array.isArray(job.allow) && job.allow.length) {
    const added = allowRules(agentId, job.allow);
    log(`${tag} allowed for ${agentId}: ${job.allow.join(', ')}${added.length ? '' : ' (already allowed)'}`);
  }
  if (!automatic(job)) {
    maybeOfferRestore(job);
    noteMessage(job, 'user', job.text);
  }
  const resume = state.sessions[skey] || state.sessions[key];

  const ctx = gameContext();
  const liveFeed = feed ? feed.block() : '';
  const own = job.router ? Router.systemPrompt(liveFeed) : job.reminder ? Reminder.systemPrompt(liveFeed) : '';
  const system = own || P.systemPrompt(ctx, primer(), liveFeed, CODE_HINT);
  const systemShort = own || P.systemPrompt(ctx, '', liveFeed, CODE_HINT);
  const promptFile = path.join(TMP_DIR, `prompt-${job.id}-${Date.now().toString(36)}.txt`);
  const input = agent.input({ prompt: job.text, system, systemShort, resume, cfg: acfg });
  if (input.promptFile !== undefined) {
    try { fs.mkdirSync(TMP_DIR, { recursive: true }); fs.writeFileSync(promptFile, input.promptFile); }
    catch (e) { finish(job, 'error', `Could not write the prompt file ${promptFile}: ${e.message}`); return; }
  }
  const args = [...cmd.args, ...agent.args({
    cfg: acfg, resume, cwd, system, systemShort, promptFile,
    prompt: job.text, timeoutMs: job.timeoutMs || cfg.timeoutMs,
  })];
  const env = agent.env({ ...process.env });
  // Where this run's tools append map commands (docs/MAP.md); any agent can use it.
  if (!automatic(job)) {
    try {
      fs.mkdirSync(MAP_DIR, { recursive: true });
      fs.rmSync(mapFileFor(job), { force: true });
      env.WOW_AI_MAP_FILE = mapFileFor(job);
    } catch (e) { log(`${tag} map file unavailable: ${e.message}`); }
  }

  log(`${tag} (${job.via}) ${agent.name} starting in ${cwd}${resume ? ' (resume ' + resume.slice(0, 8) + ')' : ' (new session)'}${ctx ? ' [game context]' : ''}${running.size ? ' [' + (running.size + 1) + ' running]' : ''}`);
  const child = spawn(cmd.file, args, { cwd, env, windowsHide: true, stdio: [input.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
  running.set(key, { job, child });
  if (!automatic(job)) publish(key, { chat: job.chat, id: job.id, status: 'working', text: resume ? 'thinking...' : 'starting a new session...', cwd, session: resume, agent: agentId }, true);
  if (input.stdin !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input.stdin); }

  const parser = agent.parser();
  const progress = [];
  let sessionId = resume || '';
  let result = null;       // { text, error } once the agent has produced its reply
  const denied = new Set(); // allowlist rules the run was refused (Claude syntax)
  const notes = [];        // bridge remarks appended to the reply
  let stderr = '';
  let buffer = '';
  let stdoutText = '';
  let parserError = false;

  const pushProgress = (line) => {
    progress.push(line);
    while (progress.length > 10) progress.shift();
    if (automatic(job)) return;   // a check or an update runs silently; only a tip or a route shows
    beat(job);
    publish(key, { chat: job.chat, id: job.id, status: 'working', text: progress.join('\n'), cwd, session: sessionId, agent: agentId }, false);
  };
  if (agent.stream === 'text') pushProgress(`${agent.name} is working (no live progress)`);
  if (input.note) notes.push(input.note);
  // Long thinking stretches produce no tool events; keep the heartbeat alive anyway.
  const keepalive = setInterval(() => beat(job), 45000);

  const handleLine = (line) => {
    if (parserError) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (!ev || typeof ev !== 'object') return;
    let r;
    try {
      r = parser.feed(ev);
      if (!r || !Array.isArray(r.progress) || !Array.isArray(r.denied) || !Array.isArray(r.notes)) {
        throw new Error('agent parser returned an invalid event result');
      }
    } catch (err) {
      parserError = true;
      const detail = err instanceof Error ? err.message : String(err);
      result = { text: `${agent.name} returned an unreadable event.`, error: true };
      notes.push(`${agent.name} event parser failed: ${detail}`);
      log(`${tag} parser error: ${err && err.stack ? err.stack : detail}`);
      return;
    }
    if (r.session) sessionId = r.session;
    for (const p of r.progress) pushProgress(p);
    for (const d of r.denied) denied.add(d);
    notes.push(...r.notes);
    if (r.done) result = r.done;
  };

  child.stdout.on('data', (chunk) => {
    if (agent.stream === 'text') {
      stdoutText += chunk.toString('utf8');
      return;
    }
    buffer += chunk.toString('utf8');
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) handleLine(line);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  const timer = setTimeout(() => {
    log(`${tag} timed out after ${job.timeoutMs || cfg.timeoutMs} ms, killing`);
    killTree(child);
  }, job.timeoutMs || cfg.timeoutMs || 1800000);

  const cleanup = () => {
    clearTimeout(timer);
    clearInterval(keepalive);
    if (input.promptFile !== undefined) { try { fs.unlinkSync(promptFile); } catch {} }
  };

  child.on('error', (err) => {
    cleanup();
    finish(job, 'error', `Could not start ${agent.name} (${cmd.file}): ${err.message}\nSet agents.${agentId}.path in config.json.`);
  });

  child.on('close', (code) => {
    cleanup();
    if (agent.stream === 'text') {
      try {
        const r = parser.finish({ stdout: stdoutText, stderr, code });
        if (r && r.session) sessionId = r.session;
        if (r && r.done) result = r.done;
        if (r && Array.isArray(r.notes)) notes.push(...r.notes);
      } catch (err) {
        result = { text: `${agent.name} output parser failed: ${err.message}`, error: true };
      }
    }
    if (buffer.trim()) handleLine(buffer.trim());
    if (sessionId && !automatic(job)) {
      state.sessions[skey] = sessionId;
      (state.sessionCwd = state.sessionCwd || {})[skey] = cwd;
      (state.sessionAgent = state.sessionAgent || {})[skey] = agentId;
    }
    // Map marks count whatever the outcome: the tools already reported them.
    const mapped = job.router ? { text: result ? result.text : '', note: '' } : takeMapCommands(job, result ? result.text : '');   // the router's route is taken in finishRoute
    if (result) result.text = mapped.text;
    if (mapped.note) notes.push(mapped.note);
    const extra = notes.length ? `\n\n[bridge] ${notes.join('\n\n[bridge] ')}` : '';
    if (result && !result.error) {
      const body = String(result.text || '').trim() || (notes.length ? '' : `(${agent.name} finished without a reply)`);
      finish(job, 'done', (body + extra).trim(), sessionId, [...denied]);
    } else if (result) {
      finish(job, 'error', (String(result.text || '') + extra).trim(), sessionId, [...denied]);
    } else {
      finish(job, 'error', `${agent.name} exited with code ${code} and no result.\n${stderr.trim().slice(-1500)}`, sessionId);
    }
  });
}

function finish(job, status, text, session, denied) {
  if (job.finished) return; // spawn failures fire both 'error' and 'close'
  job.finished = true;
  if (job.reminder) { finishReminder(job, status, text); return; }
  if (job.router) { finishRoute(job, status, text); return; }
  running.delete(chatKey(job));
  markHandled(job);
  saveState();
  // A finished reply ends with the "TL;DR:" block the system prompt asks for:
  // that part is what the game chat prints; the window gets the whole reply.
  let summary = '';
  let macros = [];
  let shop = [];
  if (status === 'done') {
    ({ text, summary } = P.splitSummary(text));
    // After the split: a macro block the agent put after "TL;DR:" must not end up
    // in the game-chat summary.
    const m = P.extractMacros(text);
    text = m.text + (m.notes.length ? `\n\n[bridge] ${m.notes.join('; ')}` : '');
    macros = m.macros;
    summary = P.stripMacroBlocks(summary);
    const sh = P.extractShopBlocks(text);
    text = sh.text + (sh.notes.length ? `\n\n[bridge] ${sh.notes.join('; ')}` : '');
    shop = sh.items;
    summary = P.stripShopBlocks(summary);
    if (codePool) {
      const c = codePool.process(text);
      text = c.text + (c.notes.length ? `\n\n[bridge] ${c.notes.join('\n\n[bridge] ')}` : '');
      if (c.results.some(r => r.ok)) saveState();
    }
  }
  noteMessage(job, status === 'done' ? 'assistant' : 'system', status === 'done' ? text : 'Bridge error: ' + text);
  publish(chatKey(job), { chat: job.chat, id: job.id, status, text, summary, cwd: job.cwd, session, denied, macros, shop, agent: job.agent || '' }, true);
  signal('sig', job.id, true);
  log(`#${job.id}${job.session ? '@' + job.session : ''} ${status} (${text.length} chars${summary ? ', summary ' + summary.length : ', no summary'})`);
  drainQueue();
  if (exitWhenIdle && running.size === 0) process.exit(status === 'done' ? 0 : 1);
}

// ---------------------------------------------------------------------------
// The reminder
// ---------------------------------------------------------------------------

// Starts a check when enough events have come in and nothing blocks it; called when a batch arrives and
// every 15 s (a check that was held back for the minimum distance starts as soon as it may).
function maybeReminder() {
  if (!reminder || reminder.blocked() || running.size >= MAX_PARALLEL) return;
  const run = reminder.begin();
  if (!run) return;
  log(`reminder #${run.id}: ${run.events} new event(s), asking the agent`);
  runJob({ id: REMINDER_JOB_BASE + run.id, chat: 'reminder', session: 'reminder', text: run.prompt, cwd: '', newSession: true, via: 'reminder', reminder: true, reminderRun: run, timeoutMs: reminder.config.timeoutMs, agent: '' });
}

// The game watches reminder/NNNN.wav the way it watches presence: the next file turning valid means a tip is waiting.
const REMINDER_MAX = cfg.reminderMax || 400;
function reminderFile(k) { return path.join(cfg.addonDir, 'WoWAI', 'reminder', String(k).padStart(4, '0') + '.wav'); }
function reminderBeat() {
  if (!fs.existsSync(path.join(cfg.addonDir, 'WoWAI', 'reminder'))) return;
  state.reminderSig = ((state.reminderSig || 0) % REMINDER_MAX) + 1;
  const k = state.reminderSig;
  try { atomicWrite(reminderFile(k), SILENT_WAV); } catch {}
  // The valid files form a prefix: what lies ahead stays empty (all of it after a wrap).
  const ahead = k === 1 ? REMINDER_MAX - 1 : 50;
  for (let j = 1; j <= ahead; j++) {
    try { atomicWrite(reminderFile(((k - 1 + j) % REMINDER_MAX) + 1), Buffer.alloc(0)); } catch {}
  }
}

function finishReminder(job, status, text) {
  const run = job.reminderRun;
  running.delete(chatKey(job));
  reminder.end();
  const at = Date.now();
  if (status === 'done') {
    const tip = reminder.accept(run.key, run.id, text, at);
    saveState();
    if (feed) feed.logLine(run.key, 'reminder.jsonl', at, { t: at, id: run.id, events: run.events, tip: tip ? tip.text : null });
    if (tip) {
      publish('reminder:tip', { chat: 'reminder', id: tip.id, status: 'done', text: tip.text, reminder: true, at: tip.t, cwd: '', session: '', agent: '' }, true);
      reminderBeat();
      saveState();
      log(`reminder #${run.id}: tip (${tip.text.length} chars): ${tip.text.split('\n')[0].slice(0, 90)}`);
    } else {
      log(`reminder #${run.id}: nothing to say`);
    }
  } else {
    log(`reminder #${run.id}: check failed: ${String(text).split('\n')[0].slice(0, 160)}`);
  }
  drainQueue();
  if (exitWhenIdle && running.size === 0) process.exit(status === 'done' ? 0 : 1);
}

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

const routeStops = () => ((state.map.layers[Router.ROUTE_LAYER] || {}).points || []).map(p => p.label);

// Starts an update when enough events have come in and nothing blocks it; same cadence rules as maybeReminder.
function maybeRoute() {
  if (!router || router.blocked() || running.size >= MAX_PARALLEL) return;
  const run = router.begin(Date.now(), routeStops());
  if (!run) return;
  log(`route #${run.id}: ${run.events} new event(s), asking the agent`);
  runJob({ id: ROUTER_JOB_BASE + run.id, chat: 'route', session: 'route', text: run.prompt, cwd: '', newSession: true, via: 'route', router: true, routerRun: run, timeoutMs: router.config.timeoutMs, agent: '' });
}

function finishRoute(job, status, text) {
  const run = job.routerRun;
  running.delete(chatKey(job));
  router.end();
  const at = Date.now();
  if (status === 'done') {
    const cmd = Router.routeCommand(text);
    const valid = cmd && P.validateMapCommand(cmd);
    if (!valid) {
      log(`route #${run.id}: no route in the reply, keeping the old one`);
    } else {
      const before = JSON.stringify((state.map.layers[Router.ROUTE_LAYER] || {}).points || []);
      if (feed) feed.logLine(run.key, 'route.jsonl', at, { t: at, id: run.id, events: run.events, stops: valid.points.length, route: valid.points.map(p => p.label) });
      if (JSON.stringify(valid.points) === before) {
        log(`route #${run.id}: route unchanged`);
      } else {
        P.applyMapCommands(state.map, [valid]);
        saveState();
        mapShareUntil = Date.now() + MAP_SHARE_MS;
        // No text for the player: a record with nothing in it carries the new map to the game, and the
        // reminder signal tells the game to look.
        publish('route:update', { chat: 'route', id: run.id, status: 'done', text: '', route: true, at, cwd: '', session: '', agent: '' }, true);
        reminderBeat();
        saveState();
        log(`route #${run.id}: ${valid.points.length} stop(s): ${valid.points.slice(0, 3).map(p => p.label).join(' > ').slice(0, 160)}`);
      }
    }
  } else {
    log(`route #${run.id}: update failed: ${String(text).split('\n')[0].slice(0, 160)}`);
  }
  drainQueue();
  if (exitWhenIdle && running.size === 0) process.exit(status === 'done' ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Input loops
// ---------------------------------------------------------------------------

function pollSavedVariables() {
  let st;
  try { st = fs.statSync(SAVED_VARS); } catch { return; }
  if (st.mtimeMs === lastMtime) return;
  lastMtime = st.mtimeMs;
  const job = readOutbox();
  if (job) submit(job);
}

// Windows: capture.ps1 (GDI). macOS: capture_mac.py (native screencapture). Elsewhere: capture_x11.py (Wine/X11).
function captureCommand() {
  if (process.platform === 'win32') {
    return ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'capture.ps1'),
      '-Cell', String(cap.cellPx), '-Cells', String(cap.cellsPerRow), '-MaxRows', String(cap.maxRows),
      '-IntervalMs', String(cap.intervalMs), '-ProcessName', cap.processName]];
  }
  if (process.platform === 'darwin') {
    const args = [path.join(HERE, 'capture_mac.py'),
      '--cell', String(cap.cellPx), '--cells', String(cap.cellsPerRow), '--max-rows', String(cap.maxRows),
      '--interval-ms', String(cap.intervalMs), '--process-name', cap.processName];
    if (cap.windowName) args.push('--window-name', cap.windowName);
    return [cap.python || 'python3', args];
  }
  const args = [path.join(HERE, 'capture_x11.py'),
    '--cell', String(cap.cellPx), '--cells', String(cap.cellsPerRow), '--max-rows', String(cap.maxRows),
    '--interval-ms', String(cap.intervalMs), '--process-name', cap.processName];
  if (cap.windowName) args.push('--window-name', cap.windowName);
  if (cap.keepComposited) args.push('--keep-composited');
  return [cap.python || 'python3', args];
}

function startCapture() {
  const [cmd, args] = captureCommand();
  const ps = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const rl = readline.createInterface({ input: ps.stdout });
  rl.on('line', (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.info) { log('capture:', ev.info); return; }
    if (ev.warn) { log('capture:', ev.warn); return; }
    if (ev.error) { log('capture error:', ev.error); return; }
    if (typeof ev.id === 'number') {
      const jobs = jobsFromStrip(ev.id, ev.text);
      log(`strip #${ev.id}: ${jobs.length} message(s)`);
      for (const job of jobs) submit(job);
    }
  });
  ps.stderr.on('data', (d) => log('capture stderr:', String(d).trim().slice(0, 300)));
  ps.on('error', (err) => log(`capture could not start (${cmd}): ${err.message}`));
  ps.on('close', (code) => {
    log(`capture exited (${code}); restarting in 5 s`);
    setTimeout(startCapture, 5000);
  });
}

function agentLine(id) {
  const acfg = A.agentConfig(cfg, id);
  const cmd = A.resolveCommand(id, acfg);
  if (!cmd.found) return `not found - ${cmd.note}`;
  const where = cmd.args.length ? `${cmd.file} ${cmd.args.join(' ')}` : cmd.file;
  const rules = Array.isArray(acfg.allowedTools) ? acfg.allowedTools.length : 0;
  return `${where}  [${acfg.permissionMode || 'acceptEdits'}${id === 'codex' ? '' : ', ' + rules + ' allowed tool rules'}${acfg.model ? ', model ' + acfg.model : ''}]`;
}

function banner() {
  console.log('WoW AI bridge');
  console.log(`  folder   : ${DEFAULT_CWD}  (${DEFAULT_CWD_SOURCE}; chats can override with /wow-ai cd)`);
  console.log(`  addons   : ${cfg.addonDir}`);
  console.log(`  addon    : ${addonInstalled() ? 'installed' : 'NOT INSTALLED - run: node setup.js, then restart WoW'}`);
  console.log(`  slots    : ${slotsInstalled() ? SLOTS + ' installed' : 'NOT INSTALLED - run: node setup.js (or node bridge/install-slots.js), then restart WoW'}`);
  console.log(`  capture  : ${cap.enabled ? 'on (' + cap.processName + ', ' + cap.cellsPerRow + 'x' + cap.maxRows + ' cells of ' + cap.cellPx + 'px)' : 'off'}`);
  console.log(`  parallel : up to ${MAX_PARALLEL} chats at once`);
  console.log(`  fallback : ${SAVED_VARS}`);
  console.log(`  agent    : ${DEFAULT_AGENT} (default; chats pick their own with /wow-ai agent)`);
  for (const id of A.agentIds()) console.log(`  ${id.padEnd(9)}: ${agentLine(id)}`);
  console.log(`  sessions : ${Object.keys(state.sessions).length} saved`);
  const ctx = gameContext();
  console.log(`  context  : ${cfg.gameContext === false ? 'off (gameContext in config.json)' : ctx ? (ctx.split('\n').find(l => /^Character:/i.test(l)) || ctx.split('\n')[0]).slice(0, 100) : 'none yet (the addon sends it with its hello; /wow-ai context in game)'}`);
  console.log(`  feed     : ${feed ? FEED_DIR + (feed.state.lastRx ? ' (last update ' + Feed.ago(Date.now() - feed.state.lastRx) + ' ago)' : ' (nothing received yet)') : 'off (feed.enabled in config.json)'}`);
  console.log(`  reminder : ${reminder ? (reminder.config.enabled ? 'on: a check every ' + reminder.config.everyEvents + ' events (at most one a ' + reminder.config.minSeconds + ' s and ' + reminder.config.maxPerHour + ' an hour)' : 'off (reminder.enabled in config.json)') : 'off (needs the feed)'}`);
  console.log(`  route    : ${router ? (router.config.enabled ? 'on: a route update every ' + router.config.everyEvents + ' events (at most one a ' + router.config.minSeconds + ' s and ' + router.config.maxPerHour + ' an hour)' : 'off (router.enabled in config.json)') : 'off (needs the feed)'}`);
  console.log(`  code     : ${codePool ? 'on, ' + CODE_CFG.slots + ' slots (the player loads each piece by hand; audit trail in ' + path.join(FEED_DIR, 'code') + ')' : 'off (code.enabled in config.json)'}`);
  console.log(`  primer   : ${!PRIMER_FILE ? 'off (primerFile in config.json)' : primer() ? path.resolve(REPO, PRIMER_FILE) + ' (' + primer().length + ' chars, with the context)' : 'NOT FOUND: ' + path.resolve(REPO, PRIMER_FILE)}`);
  console.log('Leave this window open while you play. Ctrl+C to stop.\n');
}

banner();
if (injectFeed !== null) {
  let payload;
  try { payload = fs.readFileSync(injectFeed, 'utf8'); } catch (e) { console.error(`cannot read ${injectFeed}: ${e.message}`); process.exit(1); }
  submit({ session: 'inject', chat: '', id: injectFeedId, cwd: '', event: true, name: '', text: payload, via: 'inject' });
  if (running.size === 0) process.exit(0);
  exitWhenIdle = true;   // a reminder check started by this payload: wait for it
} else if (inject !== null) {
  submit({ id: state.lastId + 1, session: '', chat: '', text: inject, cwd: '', newSession: false, via: 'inject', agent: injectAgent || '' });
} else {
  pollSavedVariables();
  if (once) {
    if (running.size === 0) { console.log('nothing pending'); process.exit(0); }
  } else {
    setInterval(pollSavedVariables, cfg.pollMs || 750);
    presenceBeat();
    setInterval(presenceBeat, cfg.presenceIntervalMs || 30000);
    setInterval(maybeReminder, 15000);
    setInterval(maybeRoute, 15000);
    if (cap.enabled) startCapture();
  }
}
