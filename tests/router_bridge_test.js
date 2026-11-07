// The real bridge.js in a scratch sandbox with a fake agent: two events in a batch start a route update,
// the route in the agent's reply becomes the "route" layer of the map (quietly: no chat text, no
// reply), the game is told through the signal file, an unchanged route changes nothing, and
// `router.enabled: false` starts nothing. No game, no network, no real agent.
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
  'Q\t363*=The Damned',
  ...events,
].join('\n');
const TWO = [`E\t${T0}\tqdone\t376\tThe Damned`, `E\t${T0 + 1}\tsub\tBrill`];
const THREE = [...TWO, `E\t${T0 + 2}\tlevel\t5`];

const ROUTE = 'Here is your route, enjoy!\n```wowmap\n{"op":"set","layer":"anything","title":"ignored","points":[' +
  '{"m":1420,"x":61.5,"y":52.2,"label":"Turn in: The Damned (Brill)","kind":"turnin","q":900},' +
  '{"m":1420,"x":60,"y":50,"label":"Train: Paladin spells (Brill)","kind":"trainer"},' +
  '{"m":1420,"x":40.1,"y":55.3,"label":"Kill: Scarlet Initiates","kind":"kill"}]}\n```';

const FAKE = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
let stdin = '';
process.stdin.on('data', d => stdin += d);
process.stdin.on('end', () => {
  fs.appendFileSync(path.join(process.cwd(), 'calls.jsonl'), JSON.stringify({ args: process.argv.slice(2), stdin }) + '\\n');
  const file = /^\\[route (update|build)\\]/.test(stdin) ? 'route-reply.txt' : 'reply.txt';
  let text = file === 'reply.txt' ? 'NOTHING' : 'no route';
  try { text = fs.readFileSync(path.join(process.cwd(), file), 'utf8'); } catch {}
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'fake-session' }));
});
`;

function sandbox(routerCfg) {
  const S = fs.mkdtempSync(path.join(os.tmpdir(), 'router-bridge-'));
  for (const f of ['bridge.js', 'protocol.js', 'agents.js', 'feed.js', 'atlas.js', 'code.js', 'lint.js', 'reminder.js', 'router.js', 'install-slots.js']) fs.copyFileSync(path.join(SRC, f), path.join(S, f));
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
  cfg.reminder = { minSeconds: 0 };
  cfg.router = routerCfg === undefined ? { minSeconds: 0, minStops: 2 } : routerCfg;
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
const routeCalls = S => calls(S).filter(c => /^\[route (update|build)\]/.test(c.stdin));
const routeReply = (S, text) => fs.writeFileSync(path.join(S, 'proj', 'route-reply.txt'), text);
const inbox = S => { try { return fs.readFileSync(path.join(S, 'addons', 'WoWAI', 'Inbox.lua'), 'utf8'); } catch { return ''; } };
const state = S => JSON.parse(fs.readFileSync(path.join(S, 'state.json'), 'utf8'));
const signal = (S, k) => fs.statSync(path.join(S, 'addons', 'WoWAI', 'reminder', String(k).padStart(4, '0') + '.wav')).size;
const dayDir = S => {
  const root = path.join(S, 'proj', 'state', 'characters', 'leprince-camwow', 'log');
  return path.join(root, fs.readdirSync(root)[0]);
};

test('the first update builds the whole route; it becomes a quiet layer and nothing is said', () => {
  const S = sandbox();
  routeReply(S, ROUTE);
  const out = inject(S, batch(TWO), 5);
  assert.match(out, /route #1: 2 new event\(s\), asking the agent \(build\)/);
  assert.match(out, /route #1: 3 stop\(s\)/);

  const [call] = routeCalls(S);
  assert.equal(routeCalls(S).length, 1);
  assert.match(call.stdin, /^\[route build\] 2 new game events/);
  const system = call.args[call.args.indexOf('--append-system-prompt') + 1];
  assert.match(system, /automatic route update/);
  assert.match(system, /COMPLETE route/, 'a build asks for the whole route');
  assert.match(system, /Quest log: 1 quest\(s\): The Damned \(363\)/, 'the live summary is in the system prompt');

  const layer = state(S).map.layers.route;
  assert.equal(layer.points.length, 3);
  assert.equal(layer.ordered, true);
  assert.equal(layer.quiet, true);
  assert.equal(layer.points[0].label, 'Turn in: The Damned (Brill)');
  assert.equal(layer.points[1].kind, 'trainer');
  assert.equal(layer.points[0].q, 900);
  assert.deepEqual(layer.points.map(p => p.id), ['s1', 's2', 's3'], 'the bridge numbers the stops');
  assert.doesNotMatch(inbox(S), /s1/, 'the ids stay on the bridge');

  const lua = inbox(S);
  assert.match(lua, /name = "route"/);
  assert.match(lua, /quiet = true/);
  assert.doesNotMatch(lua, /Here is your route/, 'the text around the route never reaches the game');
  assert.ok(signal(S, 1) > 0, 'the game is told to look');

  const [entry] = fs.readFileSync(path.join(dayDir(S), 'route.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(entry.id, 1);
  assert.equal(entry.events, 2);
  assert.equal(entry.stops, 3);
  assert.equal(entry.mode, 'build');
  assert.deepEqual(Object.keys(state(S).sessions || {}).filter(k => /route/.test(k)), [], 'an update leaves no session behind');
});

test('a route that did not change changes nothing in the game', () => {
  const S = sandbox();
  routeReply(S, ROUTE);
  inject(S, batch(TWO), 5);
  const version = state(S).map.version;
  const sig = state(S).reminderSig;
  const out = inject(S, batch(TWO.map(l => l.replace('Brill', 'Sepulcher')), '2'), 6);
  assert.match(out, /route #2: .*\(revise\)/);
  assert.match(out, /route #2: route unchanged/);
  assert.equal(state(S).map.version, version);
  assert.equal(state(S).reminderSig, sig, 'no new signal');
});

test('a reply without a route keeps the old one; a build that gets none says so', () => {
  const S = sandbox();
  routeReply(S, ROUTE);
  inject(S, batch(TWO), 5);
  routeReply(S, 'NOTHING');
  const out = inject(S, batch(TWO.map(l => l.replace('Brill', 'Sepulcher')), '2'), 6);
  assert.match(out, /route #2: no change/);
  assert.equal(state(S).map.layers.route.points.length, 3);
  const T = sandbox();
  routeReply(T, 'I could not work out a route.');
  assert.match(inject(T, batch(TWO), 5), /route #1: no route in the reply, keeping the old one/);
  assert.equal(state(T).map.layers.route, undefined);
});

test('a revision is a patch: stops go and come by id, and the game is told', () => {
  const S = sandbox();
  routeReply(S, ROUTE);
  inject(S, batch(TWO), 5);
  const sig = state(S).reminderSig;
  routeReply(S, '```wowmap\n{"op":"patch","remove":["s1"],"add":[{"after":"s3","m":1420,"x":55,"y":44,"label":"Buy: Linen Bandage (Apothecary Johaan, Brill)","kind":"vendor"}]}\n```');
  const out = inject(S, batch(TWO.map(l => l.replace('Brill', 'Sepulcher')), '2'), 6);
  assert.match(out, /route #2: 3 stop\(s\)/);
  const pts = state(S).map.layers.route.points;
  assert.deepEqual(pts.map(p => p.label), ['Train: Paladin spells (Brill)', 'Kill: Scarlet Initiates', 'Buy: Linen Bandage (Apothecary Johaan, Brill)']);
  assert.deepEqual(pts.map(p => p.id), ['s2', 's3', 's4']);
  assert.equal(state(S).reminderSig, sig + 1);
  const second = routeCalls(S)[1];
  assert.match(second.stdin, /^\[route update\] 2 new game events/);
  assert.match(second.stdin, /\[s1\] Turn in: The Damned \(Brill\) \| map 1420 61\.5, 52\.2 \| quest 900\n\[s2\]/);
  const system = second.args[second.args.indexOf('--append-system-prompt') + 1];
  assert.match(system, /"op":"patch"/);
  assert.doesNotMatch(system, /COMPLETE route/, 'a revision does not rebuild');
});

test('finished stops are removed at once, without waiting for the agent', () => {
  const S = sandbox();
  routeReply(S, ROUTE.replace('"kind":"turnin","q":900', '"kind":"turnin","q":376'));
  inject(S, batch(TWO), 5);
  assert.equal(state(S).map.layers.route.points.length, 3);
  routeReply(S, 'NOTHING');
  const out = inject(S, batch([`E\t${T0 + 5}\tqdone\t376\tThe Damned`]), 6);
  assert.match(out, /route: 1 finished stop\(s\) removed, 2 left/);
  assert.deepEqual(state(S).map.layers.route.points.map(p => p.id), ['s2', 's3']);
  assert.doesNotMatch(routeCalls(S)[1].stdin, /The Damned/, 'the revision never sees the finished stop');
  assert.match(inbox(S), /Train: Paladin spells/);
  assert.doesNotMatch(inbox(S), /Turn in: The Damned/);
});

test('the next update is told the stops of the current route', () => {
  const S = sandbox();
  routeReply(S, ROUTE);
  inject(S, batch(TWO), 5);
  inject(S, batch(TWO.map(l => l.replace('Brill', 'Sepulcher')), '2'), 6);
  const second = routeCalls(S)[1];
  assert.match(second.stdin, /Current route[^\n]*\n\[s1\] Turn in: The Damned \(Brill\)[^\n]*\n\[s2\] Train: Paladin spells \(Brill\)[^\n]*\n\[s3\] Kill: Scarlet Initiates/);
});

test('three events start both a route update and a reminder check, each with its own question', () => {
  const S = sandbox();
  routeReply(S, ROUTE);
  inject(S, batch(THREE), 5);
  assert.equal(calls(S).length, 2);
  assert.equal(routeCalls(S).length, 1);
  assert.equal(calls(S).filter(c => /^\[reminder check\]/.test(c.stdin)).length, 1);
});

test('a failed update changes nothing in the game', () => {
  const S = sandbox();
  fs.writeFileSync(path.join(S, 'fake-claude'), '#!/usr/bin/env node\nprocess.stdin.resume();process.stdin.on("end",()=>{console.log(JSON.stringify({type:"result",is_error:true,result:"Claude is overloaded",session_id:"x"}));});\n', { mode: 0o755 });
  const file = path.join(S, 'p.txt');
  fs.writeFileSync(file, batch(TWO));
  const r = spawnSync(process.execPath, ['bridge.js', '--project', path.join(S, 'proj'), '--inject-feed', file, '--feed-id', '5'], { cwd: S, encoding: 'utf8', timeout: 30000 });
  assert.match(r.stdout, /route #1: update failed: Claude is overloaded/);
  assert.equal(signal(S, 1), 0);
  assert.doesNotMatch(inbox(S), /name = "route"/);
});

test('router.enabled false starts nothing, and a heartbeat alone is not an event', () => {
  const off = sandbox({ enabled: false });
  assert.doesNotMatch(inject(off, batch(TWO), 5), /route #/);
  assert.equal(routeCalls(off).length, 0);
  const quiet = sandbox();
  assert.doesNotMatch(inject(quiet, batch([`E\t${T0}\ttick`]), 5), /route #/);
  assert.equal(routeCalls(quiet).length, 0);
  const one = sandbox();
  routeReply(one, ROUTE);
  assert.match(inject(one, batch(TWO.slice(0, 1)), 5), /route #1: 1 new event\(s\), asking the agent/);
});

test('a batch shown twice starts one update, not two', () => {
  const S = sandbox();
  routeReply(S, ROUTE);
  inject(S, batch(TWO), 5);
  inject(S, batch(TWO), 5);
  assert.equal(routeCalls(S).length, 1);
});
