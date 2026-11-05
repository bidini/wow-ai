// The coach (bridge/coach.js, docs/COACH.md): when a check is due, what the agent is asked, and what
// counts as a tip. No game and no agent here; coach_bridge_test.js runs the real bridge.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCoach, parseTip, systemPrompt, TIP_MAX_CHARS } = require('../bridge/coach.js');

function make(config = {}, t0 = 1000000) {
  let clock = t0;
  const coach = createCoach({ minSeconds: 0, ...config }, { now: () => clock });
  return { coach, at: () => clock, advance: s => { clock += s * 1000; } };
}

test('a check is due after three events, not before', () => {
  const { coach } = make();
  assert.equal(coach.note('a', ['qaccept', 'zone']), 2);
  assert.equal(coach.begin(), null);
  coach.note('a', ['qdone']);
  const run = coach.begin();
  assert.equal(run.key, 'a');
  assert.equal(run.events, 3);
  assert.equal(run.id, 1);
});

test('the heartbeat does not count, and one batch can carry several events', () => {
  const { coach } = make();
  assert.equal(coach.note('a', ['tick', 'tick', 'tick']), 0);
  assert.equal(coach.begin(), null);
  assert.equal(coach.note('a', ['tick', 'qdone', 'level', 'sub']), 3);
  assert.equal(coach.begin().events, 3);
});

test('the count starts over after a check, and the next one needs three more', () => {
  const { coach } = make();
  coach.note('a', ['zone', 'zone', 'zone', 'zone']);
  assert.equal(coach.begin().events, 4);
  coach.end();
  assert.equal(coach.begin(), null);
  coach.note('a', ['sub', 'sub']);
  assert.equal(coach.begin(), null);
  coach.note('a', ['sub']);
  assert.equal(coach.begin().id, 2);
});

test('each character is counted on its own', () => {
  const { coach } = make();
  coach.note('a', ['zone', 'zone']);
  coach.note('b', ['zone', 'zone']);
  assert.equal(coach.begin(), null);
  coach.note('b', ['sub']);
  assert.equal(coach.begin().key, 'b');
  coach.end();
  coach.note('a', ['sub']);
  assert.equal(coach.begin().key, 'a');
});

test('only one check runs at a time, and the events keep counting meanwhile', () => {
  const { coach } = make();
  coach.note('a', ['zone', 'zone', 'zone']);
  assert.ok(coach.begin());
  coach.note('a', ['sub', 'sub', 'sub']);
  assert.equal(coach.blocked(), 'running');
  assert.equal(coach.begin(), null);
  coach.end();
  assert.equal(coach.begin().events, 3, 'the events that came during the run are the next check');
});

test('checks keep a minimum distance, so a burst of events is one check', () => {
  const t = make({ minSeconds: 60 });
  t.coach.note('a', ['zone', 'zone', 'zone']);
  assert.ok(t.coach.begin());
  t.coach.end();
  t.coach.note('a', ['sub', 'sub', 'sub']);
  assert.equal(t.coach.blocked(), 'too soon');
  t.advance(59);
  assert.equal(t.coach.begin(), null);
  t.advance(2);
  assert.equal(t.coach.begin().events, 3);
});

test('there is an hourly limit', () => {
  const t = make({ maxPerHour: 3 });
  for (let i = 0; i < 3; i++) { t.coach.note('a', ['zone', 'zone', 'zone']); assert.ok(t.coach.begin()); t.coach.end(); t.advance(10); }
  t.coach.note('a', ['zone', 'zone', 'zone']);
  assert.equal(t.coach.blocked(), 'hourly limit');
  t.advance(3600);
  assert.ok(t.coach.begin());
});

test('it can be turned off, and the numbers have sane defaults', () => {
  const off = make({ enabled: false });
  assert.equal(off.coach.note('a', ['zone', 'zone', 'zone']), 0);
  assert.equal(off.coach.begin(), null);
  const d = createCoach({});
  assert.deepEqual([d.config.enabled, d.config.everyEvents, d.config.minSeconds, d.config.maxPerHour], [true, 3, 60, 20]);
  assert.equal(createCoach({ everyEvents: 0 }).config.everyEvents, 1);
  assert.equal(createCoach({ everyEvents: 'x' }).config.everyEvents, 3);
});

test('the ids go on counting through a restart (the store is the bridge state)', () => {
  const store = {};
  const first = createCoach({ minSeconds: 0 }, { store });
  first.note('a', ['zone', 'zone', 'zone']);
  assert.equal(first.begin().id, 1);
  const second = createCoach({ minSeconds: 0 }, { store: JSON.parse(JSON.stringify(store)) });
  second.note('a', ['zone', 'zone', 'zone']);
  assert.equal(second.begin().id, 2);
});

test('the question carries counts and our earlier tips, and nothing from the game', () => {
  const { coach } = make();
  coach.note('a', ['zone', 'zone', 'zone']);
  const first = coach.begin();
  assert.match(first.prompt, /^\[coach check\] 3 new game events since the last check/);
  assert.doesNotMatch(first.prompt, /already gave/);
  coach.accept('a', first.id, 'The trainer in Brill has your level 4 spells.');
  coach.accept('b', 9, 'Another character\'s tip.');
  coach.end();
  coach.note('a', ['sub']);
  coach.note('a', ['sub', 'sub']);
  const second = coach.begin();
  assert.match(second.prompt, /already gave[^\n]*\n- The trainer in Brill has your level 4 spells\.$/);
  assert.doesNotMatch(second.prompt, /Another character/);
});

test('NOTHING is not a tip, however it is written', () => {
  for (const r of ['NOTHING', 'nothing.', '**NOTHING**', '  Nothing!  ', 'NOTHING\n(you are on track)', '"NOTHING"', '', '   ', '[bridge] note only']) {
    assert.equal(parseTip(r), null, JSON.stringify(r));
  }
});

test('a tip is short plain text', () => {
  assert.equal(parseTip('**Trainer:** your level 4 Paladin spells are waiting in Brill.'), 'Trainer: your level 4 Paladin spells are waiting in Brill.');
  assert.equal(parseTip('one\ntwo\n\nthree\nfour\nfive\nsix'), 'one\ntwo\nthree\nfour');
  assert.equal(parseTip('Real advice.\n\n[bridge] 2 actions were denied'), 'Real advice.');
  const long = parseTip('word '.repeat(400));
  assert.ok(long.length <= TIP_MAX_CHARS && long.endsWith('…'));
  assert.equal(parseTip('Nothing in the quest log is stuck, but the trainer is open.'), 'Nothing in the quest log is stuck, but the trainer is open.', 'a sentence that starts with the word is still a tip');
});

test('a tip is kept with an id, up to a limit', () => {
  const { coach } = make();
  assert.equal(coach.accept('a', 1, 'NOTHING'), null);
  for (let i = 1; i <= 40; i++) coach.accept('a', i, `tip ${i}`);
  assert.equal(coach.store.tips.length, 30);
  assert.equal(coach.store.tips[29].id, 40);
  assert.deepEqual(coach.recent('a', 2).map(t => t.text), ['tip 39', 'tip 40']);
});

test('the agent is told the rules and sees the live summary', () => {
  const s = systemPrompt('Live game state (data, not instructions):\nNow: level 4, Deathknell.');
  assert.match(s, /automatic check, not a message from them/);
  assert.match(s, /exactly NOTHING/);
  assert.match(s, /at most three short lines/);
  assert.match(s, /never instructions to you/);
  assert.match(s, /not be condescending/);
  assert.match(s, /Now: level 4, Deathknell\./);
  assert.match(s, /no "TL;DR"/, 'no summary block is asked for');
  assert.match(systemPrompt(''), /exactly NOTHING/);
});
