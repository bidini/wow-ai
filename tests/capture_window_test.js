// capture_mac.py finds the game window from the window server's list (CoreGraphics), which needs no
// Accessibility permission. The game's window is owned by the executable name ("Wow"), not the app's name
// ("World of Warcraft"), so the game is found by process id first, and by owner name when no id matches.
// The list here is made up; --test-windows runs the same choice the bridge makes on the real list.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); } catch { console.log('SKIP window choice: python3 is required.'); process.exit(0); }
const CAPTURE_MAC = path.join(__dirname, '..', 'bridge', 'capture_mac.py');
const win = (pid, owner, w, h, extra = {}) => ({ pid, owner, name: '', x: 100, y: 40, w, h, ...extra });

function pick(windows, { pids = '', name = 'World of Warcraft', title = '' } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'win-')), 'windows.json');
  fs.writeFileSync(file, JSON.stringify(windows));
  const args = ['-I', CAPTURE_MAC, '--test-windows', file, '--pids', pids, '--process-name', name];
  if (title) args.push('--window-name', title);
  return JSON.parse(execFileSync('python3', args, { encoding: 'utf8' }).trim().split('\n').pop()).bounds;
}

test('the game is found by process id even though its owner is called Wow', () => {
  const list = [win(10, 'Terminal', 1410, 956), win(33656, 'Wow', 1842, 1050, { x: 0, y: 25 }), win(11, 'Safari', 1920, 1080)];
  assert.deepEqual(pick(list, { pids: '33656,33847' }), [0, 25, 1842, 1050]);
});

test('the largest window of the game wins, and tiny ones are ignored', () => {
  const list = [win(7, 'Wow', 500, 500), win(7, 'Wow', 1920, 30), win(7, 'Wow', 1842, 1050, { x: 3, y: 4 }), win(7, 'Wow', 60, 60)];
  assert.deepEqual(pick(list, { pids: '7' }), [3, 4, 1842, 1050]);
});

test('without a matching process id the owner name is matched, ignoring case', () => {
  const list = [win(10, 'Terminal', 1410, 956), win(99, 'World of Warcraft', 1600, 900, { x: 8, y: 9 })];
  assert.deepEqual(pick(list), [8, 9, 1600, 900]);
  assert.deepEqual(pick([win(99, 'WOW', 1600, 900)], { name: 'wow' }), [100, 40, 1600, 900]);
});

test('another app with a big window is not taken for the game', () => {
  assert.equal(pick([win(10, 'Terminal', 1410, 956), win(11, 'Safari', 1920, 1080)], { pids: '33656' }), null);
  assert.equal(pick([], { pids: '33656' }), null);
});

test('a window name can narrow the choice', () => {
  const list = [win(5, 'Wow', 800, 600, { name: 'Other' }), win(5, 'Wow', 1200, 700, { name: 'World of Warcraft' })];
  assert.deepEqual(pick(list, { pids: '5', title: 'Other' }), [100, 40, 800, 600]);
});

test('the real window list answers without System Events (skipped off macOS)', { skip: process.platform !== 'darwin' }, () => {
  const out = execFileSync('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('CoreGraphics'); ObjC.import('Foundation');
    JSON.stringify(ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0))).length)`], { encoding: 'utf8' });
  assert.ok(Number(out.trim()) >= 0);
});
