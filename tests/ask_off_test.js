// "ask": { "enabled": false } in bridge/config.json turns the question-answering agent off. The bridge starts no run for a player's question
// (the check sits before an agent is chosen or launched), reminders still run, and the startup summary says so.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'bridge', 'bridge.js'), 'utf8');

test('the switch is read from the config and defaults to on', () => {
  assert.match(src, /const ASK_ON = !\(cfg\.ask && cfg\.ask\.enabled === false\);/);
});

test('a question is refused with a message before any agent is chosen, and reminders are not affected', () => {
  const run = src.indexOf('function runJob(job)');
  const guard = src.indexOf('if (!ASK_ON && !job.reminder)', run);
  const choose = src.indexOf('A.normalizeAgent(job.agent)', run);
  assert.ok(guard > run && guard < choose, 'the guard comes before the agent is chosen');
  const block = src.slice(guard, guard + 400);
  assert.match(block, /finish\(job, 'error'/);
  assert.match(block, /return;/);
});

test('the startup summary shows whether the agent is on', () => {
  assert.match(src, /agent    : \$\{ASK_ON \?/);
});
