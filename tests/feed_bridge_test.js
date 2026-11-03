// The real bridge.js in a scratch sandbox, fed event-feed payloads with --inject-feed
// (no game, no agent, no network): the files appear where the agent will look, a repeat
// is ignored across restarts, the setting can turn the feed off, and the system prompt
// the bridge would give an agent carries the summary.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'bridge');
const T0 = 1700000000;
const payload = (extra = []) => [
  'v\t1',
  `S\t${T0}\t9\t1429\t421\t659\t7.0\t7.0\tElwynn Forest\tGoldshire\t0\t10\t100`,
  'Q\t176*',
  `E\t${T0}\tlevel\t9`,
  `P\t${T0}\t1429\t421\t659`,
  ...extra,
].join('\n');

function sandbox(feedCfg) {
  const S = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-bridge-'));
  for (const f of ['bridge.js', 'protocol.js', 'agents.js', 'feed.js', 'atlas.js']) fs.copyFileSync(path.join(SRC, f), path.join(S, f));
  fs.mkdirSync(path.join(S, 'addons', 'WoWAI'), { recursive: true });
  fs.mkdirSync(path.join(S, 'proj'), { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(SRC, 'config.example.json'), 'utf8'));
  cfg.addonDir = path.join(S, 'addons');
  cfg.inboxFile = path.join(S, 'addons', 'WoWAI', 'Inbox.lua');
  cfg.savedVariablesFile = path.join(S, 'nope.lua');
  cfg.defaultCwd = path.join(S, 'proj');
  if (feedCfg) cfg.feed = feedCfg;
  fs.writeFileSync(path.join(S, 'config.json'), JSON.stringify(cfg, null, 2));
  return S;
}

function inject(S, text, id) {
  const file = path.join(S, `payload-${id}.txt`);
  fs.writeFileSync(file, text);
  const env = { ...process.env }; delete env.CLAUDECODE;
  const r = spawnSync(process.execPath, ['bridge.js', '--project', path.join(S, 'proj'), '--inject-feed', file, '--feed-id', String(id)], { cwd: S, encoding: 'utf8', env, timeout: 30000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}
const eventLines = S => {
  try { return fs.readFileSync(path.join(S, 'proj', 'state', 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean); } catch { return []; }
};

test('an injected payload becomes the files the agent reads, in the default folder', () => {
  const S = sandbox();
  const out = inject(S, payload(), 5);
  assert.match(out, /feed #5: snapshot, 1 event\(s\), 1 position\(s\)/);
  const dir = path.join(S, 'proj', 'state');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['events.jsonl', 'snapshot.json', 'summary.txt', 'trajectory.jsonl']);
  assert.match(fs.readFileSync(path.join(dir, 'summary.txt'), 'utf8'), /Now: level 9, Elwynn Forest - Goldshire at 42\.1, 65\.9/);
  assert.equal(eventLines(S).length, 1);
  assert.equal(fs.statSync(path.join(dir, 'summary.txt')).mode & 0o777, 0o644);
});

test('a repeated frame is ignored, even by a restarted bridge; new content is stored', () => {
  const S = sandbox();
  inject(S, payload(), 5);
  inject(S, payload(), 5); // the same frame again, in a fresh process
  assert.equal(eventLines(S).length, 1);
  const state = JSON.parse(fs.readFileSync(path.join(S, 'state.json'), 'utf8'));
  assert.ok(state.feed.inject.keys.length === 1, 'the dedupe memory is saved in state.json');
  inject(S, payload([`E\t${T0 + 5}\tdead`]), 6);
  assert.equal(eventLines(S).length, 3);
});

test('the bridge banner reports the feed folder and how fresh it is', () => {
  const S = sandbox();
  assert.match(inject(S, payload(), 1), /feed\s+: .*state/);
});

test('"feed": { "enabled": false } writes nothing', () => {
  const S = sandbox({ enabled: false });
  const out = inject(S, payload(), 5);
  assert.match(out, /feed\s+: off/);
  assert.ok(!fs.existsSync(path.join(S, 'proj', 'state')));
});

test('"feed": { "dir": ... } moves the files', () => {
  const S = sandbox();
  const elsewhere = path.join(S, 'elsewhere');
  const cfg = JSON.parse(fs.readFileSync(path.join(S, 'config.json'), 'utf8'));
  cfg.feed = { dir: elsewhere };
  fs.writeFileSync(path.join(S, 'config.json'), JSON.stringify(cfg));
  inject(S, payload(), 5);
  assert.ok(fs.existsSync(path.join(elsewhere, 'events.jsonl')));
  assert.ok(!fs.existsSync(path.join(S, 'proj', 'state')));
});
