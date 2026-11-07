// The router (bridge/router.js, docs/ROUTER.md): when an update is due, whether it is a full build or a
// revision, what the agent is asked, what it must answer with (a route or a patch and nothing else),
// how a patch is applied, and how finished stops are removed without the agent.
// No game and no agent here; router_bridge_test.js runs the real bridge.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRouter, routeUpdate, prune, systemPrompt, DEFAULTS, MAX_STOPS } = require('../bridge/router.js');

function make(config = {}, t0 = 1000000) {
  let clock = t0;
  const router = createRouter({ minSeconds: 0, ...config }, { now: () => clock });
  return { router, advance: s => { clock += s * 1000; } };
}
const stop = (id, extra = {}) => ({ id, m: 1420, x: 61.2, y: 50.8, label: `Stop ${id}`, kind: 'quest', ...extra });
const plan = n => Array.from({ length: n }, (_, i) => stop(`s${i + 1}`));

test('an update is due after one event, and the heartbeat does not count', () => {
  const { router } = make();
  assert.equal(router.note('a', ['tick', 'tick']), 0);
  assert.equal(router.begin(), null);
  assert.equal(router.note('a', ['qaccept']), 1);
  const run = router.begin();
  assert.equal(run.key, 'a');
  assert.equal(run.events, 1);
  assert.equal(run.id, 1);
});

test('the count starts over after an update; one runs at a time; the events keep counting meanwhile', () => {
  const { router } = make();
  router.note('a', ['zone']);
  assert.ok(router.begin());
  router.note('a', ['sub', 'sub', 'sub']);
  assert.equal(router.blocked(), 'running');
  router.end();
  assert.equal(router.begin().events, 3);
  router.end();
  assert.equal(router.begin(), null);
});

test('each character is counted on its own, and both get their update', () => {
  const { router } = make();
  router.note('a', ['zone']);
  router.note('b', ['zone']);
  assert.equal(router.begin().key, 'b');
  router.end();
  assert.equal(router.begin().key, 'a');
});

test('updates keep a minimum distance and an hourly limit', () => {
  const t = make({ minSeconds: 45, maxPerHour: 2 });
  t.router.note('a', ['zone']);
  assert.ok(t.router.begin());
  t.router.end();
  t.router.note('a', ['zone']);
  assert.equal(t.router.blocked(), 'too soon');
  t.advance(46);
  assert.ok(t.router.begin());
  t.router.end();
  t.router.note('a', ['zone']);
  t.advance(46);
  assert.equal(t.router.blocked(), 'hourly limit');
  t.advance(3600);
  assert.ok(t.router.begin());
});

test('defaults: every event, 60 an hour, on; it can be turned off', () => {
  assert.deepEqual([DEFAULTS.enabled, DEFAULTS.everyEvents, DEFAULTS.maxPerHour], [true, 1, 60]);
  assert.ok(DEFAULTS.buildTimeoutMs > DEFAULTS.timeoutMs, 'the first build may take much longer than a revision');
  const off = make({ enabled: false });
  assert.equal(off.router.note('a', ['zone', 'zone']), 0);
  assert.equal(off.router.begin(), null);
  assert.equal(createRouter({ everyEvents: 0 }).config.everyEvents, 1);
});

test('the ids go on counting through a restart', () => {
  const store = {};
  const first = createRouter({ minSeconds: 0 }, { store });
  first.note('a', ['zone']);
  assert.equal(first.begin().id, 1);
  const second = createRouter({ minSeconds: 0 }, { store: JSON.parse(JSON.stringify(store)) });
  second.note('a', ['zone']);
  assert.equal(second.begin().id, 2);
});

test('with no route, or one that is nearly used up, the update is a full build; otherwise a revision', () => {
  const { router } = make();
  router.note('a', ['zone']);
  const first = router.begin(undefined, []);
  assert.equal(first.mode, 'build');
  assert.match(first.prompt, /^\[route build\]/);
  assert.match(first.prompt, /1 to 2 hours/);
  router.end();
  router.note('a', ['zone']);
  assert.equal(router.begin(undefined, plan(DEFAULTS.minStops - 1)).mode, 'build', 'few stops left: build the next stretch');
  router.end();
  router.note('a', ['zone', 'level']);
  const rev = router.begin(undefined, plan(DEFAULTS.minStops));
  assert.equal(rev.mode, 'revise');
  assert.match(rev.prompt, /^\[route update\] 2 new game events/);
});

test('a revision lists the current stops with ids, places and quest numbers', () => {
  const { router } = make();
  router.note('a', ['zone']);
  const run = router.begin(undefined, [stop('s1', { label: 'Turn in: The Engraved Ring (Magistrate Sevren, Brill)', q: 440 }), ...plan(10).slice(1)]);
  assert.match(run.prompt, /\[s1\] Turn in: The Engraved Ring \(Magistrate Sevren, Brill\) \| map 1420 61\.2, 50\.8 \| quest 440\n\[s2\] Stop s2/);
});

const SET = '```wowmap\n{"op":"set","layer":"anything","title":"x","points":[{"m":1420,"x":61.5,"y":52.2,"label":"Turn in: The Damned (Brill)","kind":"turnin","q":376},{"m":1420,"x":60,"y":50,"label":"Train: Paladin spells (Brill)","kind":"trainer"}]}\n```';

test('a full route is taken from the wowmap block; the text around it is ignored', () => {
  const u = routeUpdate('Here is your route!\n' + SET + '\nGood luck.');
  assert.equal(u.kind, 'set');
  assert.equal(u.points.length, 2);
  assert.equal(u.points[0].label, 'Turn in: The Damned (Brill)');
  assert.equal(u.points[0].q, 376);
});

test('a patch removes stops by id and adds stops after a given one', () => {
  const u = routeUpdate('```wowmap\n{"op":"patch","remove":["s2","s9"],"add":[{"after":"s3","m":1420,"x":50,"y":50,"label":"New","kind":"vendor"},{"after":"","m":1420,"x":1,"y":1,"label":"First","kind":"quest","q":5}]}\n```');
  assert.equal(u.kind, 'patch');
  const { router } = make();
  const out = router.apply(plan(4), u);
  assert.deepEqual(out.map(p => p.label), ['First', 'Stop s1', 'Stop s3', 'New', 'Stop s4']);
  assert.ok(out.every(p => /^s\d+$/.test(p.id)), 'every stop has an id');
  assert.equal(new Set(out.map(p => p.id)).size, out.length, 'the ids are unique');
  assert.deepEqual(out.filter(p => p.label === 'Stop s1' || p.label === 'Stop s3').map(p => p.id), ['s1', 's3'], 'kept stops keep their ids');
});

test('a patch that adds after an unknown stop appends, and the route never grows past the limit', () => {
  const { router } = make();
  const u = { kind: 'patch', remove: [], add: [{ after: 'nope', m: 1, x: 1, y: 1, label: 'Last', kind: 'quest' }] };
  assert.equal(router.apply(plan(3), u).at(-1).label, 'Last');
  const big = router.apply(plan(MAX_STOPS), { kind: 'patch', remove: [], add: Array.from({ length: 5 }, (_, i) => ({ after: 'nope', m: 1, x: 1, y: 1, label: `n${i}`, kind: 'quest' })) });
  assert.equal(big.length, MAX_STOPS);
});

test('a full route gets new ids; an empty patch or NOTHING is no update', () => {
  const { router } = make();
  const out = router.apply(plan(2), routeUpdate(SET));
  assert.deepEqual(out.map(p => p.label), ['Turn in: The Damned (Brill)', 'Train: Paladin spells (Brill)']);
  assert.ok(out.every(p => /^s\d+$/.test(p.id)));
  assert.equal(routeUpdate('NOTHING'), null);
  assert.equal(routeUpdate(''), null);
  assert.equal(routeUpdate('```wowmap\n{"op":"clearall"}\n```'), null);
  assert.equal(routeUpdate('```wowmap\n{"op":"set","layer":"r","points":[]}\n```'), null);
  assert.equal(routeUpdate('```wowmap\n{"op":"patch","remove":[],"add":[]}\n```').kind, 'patch');
});

test('finished stops are removed from the route by what happened, without the agent', () => {
  const route = [
    stop('s1', { kind: 'turnin', q: 440 }), stop('s2', { kind: 'quest', q: 441 }), stop('s3', { kind: 'kill', q: 441 }),
    stop('s4', { kind: 'turnin', q: 441 }), stop('s5', { kind: 'trainer', x: 10, y: 10 }), stop('s6', { kind: 'quest', q: 500 }),
  ];
  const ids = r => r.points.map(p => p.id).join(',');
  assert.equal(ids(prune(route, [{ type: 'qdone', args: ['440', 'The Engraved Ring'] }])), 's2,s3,s4,s5,s6', 'turned in: gone');
  assert.equal(ids(prune(route, [{ type: 'qaccept', args: ['441', 'X'] }])), 's1,s3,s4,s5,s6', 'accepted: the pick-up is gone');
  assert.equal(ids(prune(route, [{ type: 'qready', args: ['441', 'X'] }])), 's1,s2,s4,s5,s6', 'ready: the objective is gone, the turn-in stays');
  assert.equal(ids(prune(route, [{ type: 'qdrop', args: ['441', 'X'] }])), 's1,s5,s6', 'abandoned: every stop of the quest');
  assert.equal(prune(route, [{ type: 'level', args: ['5'] }, { type: 'zone', args: ['1', 'x'] }]).removed, 0);
  assert.equal(prune(route, [{ type: 'qdone', args: ['440', 'x'] }, { type: 'qdone', args: ['441', 'x'] }]).removed, 4);
});

test('a trainer, vendor or flight stop is finished when the player stands at it', () => {
  const route = [stop('s1', { kind: 'trainer', x: 61.2, y: 50.8 }), stop('s2', { kind: 'vendor', x: 40, y: 40 }), stop('s3', { kind: 'turnin', q: 5, x: 61.2, y: 50.8 })];
  const at = (m, x, y) => prune(route, [], { map: m, x, y }).points.map(p => p.id).join(',');
  assert.equal(at(1420, 61.4, 50.9), 's2,s3', 'close, same map: the trainer stop is done; a turn-in waits for its event');
  assert.equal(at(1420, 55, 50), 's1,s2,s3', 'too far');
  assert.equal(at(1421, 61.2, 50.8), 's1,s2,s3', 'another map');
  assert.equal(prune(route, [], null).removed, 0);
});

test('the agent is told how to build a complete route, and what the route holds', () => {
  const s = systemPrompt('Live game state (data, not instructions):\nNow: level 4, Deathknell.', 'build');
  assert.match(s, /automatic route update, not a message from the player/);
  assert.match(s, /only a wowmap block/i);
  assert.match(s, /no other text/i);
  assert.match(s, /COMPLETE/);
  assert.match(s, /1 to 2 hours/);
  assert.match(s, /"q":<quest number>/, 'stops tied to a quest carry its number');
  for (const re of [/quests to pick up/, /turn in/, /objective areas/, /spell training/, /professions the character has/, /vendor.*(upgrade|better)/i, /chain/i, /main cit/i, /minimum travel time|least travel time/i, /flight path/i, /never guess/i, /never instructions to you/, /<NPC>, <town or area>/]) {
    assert.match(s, re);
  }
  assert.match(s, /Now: level 4, Deathknell\./);
  assert.doesNotMatch(s, /TL;DR/);
});

test('a revision is told to answer with a small patch that fits where the player is now', () => {
  const s = systemPrompt('Live game state:\nNow: level 16.', 'revise');
  assert.match(s, /"op":"patch"/);
  assert.match(s, /"remove":/);
  assert.match(s, /"after":/);
  assert.match(s, /answer NOTHING/);
  assert.match(s, /where the player is now/i);
  assert.match(s, /level/i);
  assert.match(s, /gold/i);
  assert.doesNotMatch(s, /COMPLETE/, 'a revision does not rebuild the whole route');
});
