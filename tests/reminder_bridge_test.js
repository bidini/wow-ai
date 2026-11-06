// The real bridge.js in a scratch sandbox with a fake agent: three events in a batch start a reminder
// check, the agent's tip reaches the game files (a slot record and the reminder signal), NOTHING does not,
// and fewer events or `reminder.enabled: false` start nothing. No game, no network, no real agent.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'bridge');
const T0 = 1700000000;
const batch = (events, tag = '') => [
  'v\t1\tLeprince\tCamwow',
  `S\t${T0}\t4\t1420\t300\t709\t7.0\t7.0\tTirisfal Glades\tDeathknell${tag}\t0\t10\t100`,
  'Q\t363*',
  ...events,
].join('\n');
const THREE = [`E\t${T0}\tqdone\t376\tThe Damned`, `E\t${T0 + 1}\tsub\tBrill`, `E\t${T0 + 2}\tlevel\t5`];

const FAKE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
let stdin = '';
process.stdin.on('data', d => stdin += d);
process.stdin.on('end', () => {
  fs.appendFileSync(path.join(process.cwd(), 'calls.jsonl'), JSON.stringify({ args: process.argv.slice(2), stdin }) + '\\n');
  let text = 'NOTHING';
  try { text = fs.readFileSync(path.join(process.cwd(), 'reply.txt'), 'utf8'); } catch {}
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'fake-session' }));
});
`;

function sandbox(reminderCfg) {
  const S = fs.mkdtempSync(path.join(os.tmpdir(), 'reminder-bridge-'));
  for (const f of ['bridge.js', 'protocol.js', 'agents.js', 'feed.js', 'atlas.js', 'code.js', 'lint.js', 'reminder.js', 'install-slots.js']) fs.copyFileSync(path.join(SRC, f), path.join(S, f));
  fs.mkdirSync(path.join(S, 'addons', 'WoWAI'), { recursive: true });
  fs.writeFileSync(path.join(S, 'addons', 'WoWAI', 'WoWAI.toc'), '## Interface: 16001\n');
  fs.mkdirSync(path.join(S, 'proj'), { recursive: true });
  fs.writeFileSync(path.join(S, 'fake-claude'), FAKE, { mode: 0o755 });
  const cfg = JSON.parse(fs.readFileSync(path.join(SRC, 'config.example.json'), 'utf8'));
  cfg.addonDir = path.join(S, 'addons');
  cfg.inboxFile = path.join(S, 'addons', 'WoWAI', 'Inbox.lua');
  cfg.savedVariablesFile = path.join(S, 'nope.lua');
  cfg.defaultCwd = path.join(S, 'proj');
  cfg.slots = 3;
  cfg.agents.claude.path = path.join(S, 'fake-claude');
  cfg.reminder = reminderCfg === undefined ? { minSeconds: 0 } : reminderCfg;
  fs.writeFileSync(path.join(S, 'config.json'), JSON.stringify(cfg, null, 2));
  const r = spawnSync(process.execPath, ['install-slots.js'], { cwd: S, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return S;
}

function inject(S, text, id) {
  const file = path.join(S, `payload-${id}.txt`);
  fs.writeFileSync(file, text);
  const env = { ...process.env }; delete env.CLAUDECODE;
  const r = spawnSync(process.execPath, ['bridge.js', '--project', path.join(S, 'proj'), '--inject-feed', file, '--feed-id', String(id)], { cwd: S, encoding: 'utf8', env, timeout: 30000 });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  return r.stdout;
}
const calls = S => { try { return fs.readFileSync(path.join(S, 'proj', 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); } catch { return []; } };
const reply = (S, text) => fs.writeFileSync(path.join(S, 'proj', 'reply.txt'), text);
const inbox = S => { try { return fs.readFileSync(path.join(S, 'addons', 'WoWAI', 'Inbox.lua'), 'utf8'); } catch { return ''; } };
const signal = (S, k) => fs.statSync(path.join(S, 'addons', 'WoWAI', 'reminder', String(k).padStart(4, '0') + '.wav')).size;
const dayFiles = S => {
  const root = path.join(S, 'proj', 'state', 'characters', 'leprince-camwow', 'log');
  const day = fs.readdirSync(root)[0];
  return path.join(root, day);
};
const reminderLog = S => fs.readFileSync(path.join(dayFiles(S), 'reminder.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('three events start a check; the tip reaches the game files and the day log', () => {
  const S = sandbox();
  reply(S, '**Trainer:** your level 5 Paladin spells are waiting in Brill.\nYou hold 4 quests that end in Brill.');
  const out = inject(S, batch(THREE), 5);
  assert.match(out, /reminder #1: 3 new event\(s\), asking the agent/);
  assert.match(out, /reminder #1: tip/);

  const [call] = calls(S);
  assert.equal(calls(S).length, 1);
  assert.match(call.stdin, /^\[reminder check\] 3 new game events since the last check/);
  assert.doesNotMatch(call.stdin, /Damned|Brill|Leprince/, 'the question holds no game text');
  const system = call.args[call.args.indexOf('--append-system-prompt') + 1];
  assert.match(system, /automatic check, not a message from them/);
  assert.match(system, /Active character: Leprince of Camwow/, 'the live summary is in the system prompt');
  assert.match(system, /Quest log: 1 quest\(s\)/);

  const lua = inbox(S);
  assert.match(lua, /reminder = true,/);
  assert.match(lua, /Trainer: your level 5 Paladin spells are waiting in Brill\.\\n/);
  assert.doesNotMatch(lua, /\*\*/, 'no markdown reaches the game');
  assert.match(lua, /chat = "reminder",\n\t\t\tid = 1,/);
  assert.ok(signal(S, 1) > 0, 'the first reminder file is valid');
  assert.equal(signal(S, 2), 0, 'the next one waits');

  const [entry] = reminderLog(S);
  assert.equal(entry.id, 1);
  assert.equal(entry.events, 3);
  assert.match(entry.tip, /^Trainer:/);
  const state = JSON.parse(fs.readFileSync(path.join(S, 'state.json'), 'utf8'));
  assert.equal(state.reminder.counter, 1);
  assert.equal(state.reminder.tips.length, 1);
  assert.equal(state.reminderSig, 1);
  assert.deepEqual(Object.keys(state.sessions || {}).filter(k => /reminder/.test(k)), [], 'a check leaves no session behind');
});

test('the next check is told what was already said, and NOTHING shows nothing', () => {
  const S = sandbox();
  reply(S, 'Hand in the quests in Brill before you go on.');
  inject(S, batch(THREE), 5);
  reply(S, 'NOTHING');
  const out = inject(S, batch(THREE.map(l => l.replace('Brill', 'Sepulcher')), '2'), 6);
  assert.match(out, /reminder #2: nothing to say/);
  const second = calls(S)[1];
  assert.match(second.stdin, /already gave[^\n]*\n- Hand in the quests in Brill before you go on\.$/);
  assert.ok(signal(S, 1) > 0);
  assert.equal(signal(S, 2), 0, 'no tip, no signal');
  assert.doesNotMatch(inbox(S), /chat = "reminder",\n\t\t\tid = 2,/);
  assert.deepEqual(reminderLog(S).map(e => [e.id, e.tip === null]), [[1, false], [2, true]]);
});

test('fewer than three events do not start a check', () => {
  const S = sandbox();
  const out = inject(S, batch(THREE.slice(0, 2)), 5);
  assert.doesNotMatch(out, /reminder #/);
  assert.equal(calls(S).length, 0);
  assert.equal(signal(S, 1), 0);
});

test('a failed check changes nothing in the game', () => {
  const S = sandbox();
  fs.writeFileSync(path.join(S, 'fake-claude'), '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>{console.log(JSON.stringify({type:"result",is_error:true,result:"Claude is overloaded",session_id:"x"}));});\n', { mode: 0o755 });
  const r = spawnSync(process.execPath, ['bridge.js', '--project', path.join(S, 'proj'), '--inject-feed', (fs.writeFileSync(path.join(S, 'p.txt'), batch(THREE)), path.join(S, 'p.txt')), '--feed-id', '5'], { cwd: S, encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /reminder #1: check failed: Claude is overloaded/);
  assert.equal(signal(S, 1), 0);
  assert.doesNotMatch(inbox(S), /reminder = true/);
});

test('reminder.enabled false starts nothing, however many events come', () => {
  const S = sandbox({ enabled: false });
  const out = inject(S, batch(THREE), 5);
  assert.doesNotMatch(out, /reminder #/);
  assert.equal(calls(S).length, 0);
});

test('a batch shown twice starts one check, not two', () => {
  const S = sandbox();
  inject(S, batch(THREE), 5);
  inject(S, batch(THREE), 5);          // same id and text: the strip shown again
  assert.equal(calls(S).length, 1);
});

test('a state file from when this was called the coach is carried over', () => {
  const S = sandbox();
  fs.writeFileSync(path.join(S, 'state.json'), JSON.stringify({ coach: { counter: 7, tips: [] }, coachSig: 3 }));
  reply(S, 'Hand in the quests in Brill.');
  const out = inject(S, batch(THREE), 5);
  assert.match(out, /reminder #8: 3 new event\(s\)/);
  const state = JSON.parse(fs.readFileSync(path.join(S, 'state.json'), 'utf8'));
  assert.equal(state.reminder.counter, 8);
  assert.equal(state.reminderSig, 4);
  assert.ok(signal(S, 4) > 0);
});
