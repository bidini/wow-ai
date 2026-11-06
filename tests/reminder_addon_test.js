// The addon side of the reminder (addon/WoWAI/Reminder.lua and the signal polling in WoWAI.lua), in a Lua VM
// with a stub client: a valid reminder file makes the addon read a slot, the tip in it is printed once,
// old or repeated tips are not, and /wow-ai reminder lists them. The addon only reads and prints.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const ADDON = path.join(__dirname, '..', 'addon', 'WoWAI');
const REMINDER = k => `Interface\\AddOns\\WoWAI\\reminder\\${String(k).padStart(4, '0')}.wav`;

function newVM() {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const load = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    let n = 0;
    if (arg !== undefined) { lua.lua_pushstring(L, to_luastring(arg)); n = 1; }
    if (lua.lua_pcall(L, n, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  const evaluate = expr => {
    load(`local v = (${expr}); if v == nil then RESULT = nil else RESULT = tostring(v) end`);
    lua.lua_getglobal(L, to_luastring('RESULT'));
    const isNil = lua.lua_isnil(L, -1);
    const s = isNil ? null : to_jsstring(lua.lua_tolstring(L, -1));
    lua.lua_pop(L, 1);
    return s;
  };
  load(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  for (const f of ['Codec.lua', 'Inbox.lua', 'WoWAI.lua', 'Map.lua', 'Feed.lua', 'Code.lua', 'Shop.lua', 'Reminder.lua']) load(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'WoWAI');
  load('STUB.sounds["Interface\\\\AddOns\\\\WoWAI\\\\ctl\\\\valid.wav"] = true'); // the login self-test: the sound channel works
  load('STUB.FireEvent("ADDON_LOADED", "WoWAI")');
  load('STUB.FireEvent("PLAYER_LOGIN")');
  load('STUB.Tick(); STUB.Tick()'); // the login hello and the first signal checks happen here, before any tip
  const prints = () => { load('RESULT_P = table.concat(STUB.prints, "\\n")'); return evaluate('RESULT_P') || ''; };
  return { load, evaluate, prints, cmd: s => { load('SlashCmdList.WOWAI(...)', s); } };
}

// What the bridge writes into the next slot: tips with the bridge's clock in `at`.
// `at` is a fixed number, as the bridge writes it (its clock when the tip was made).
const luaTip = (vm, { id, text, ageSeconds = 5 }) =>
  `{ chat = "reminder", id = ${id}, status = "done", text = ${JSON.stringify(text)}, reminder = true, at = ${Number(vm.evaluate('time()')) - ageSeconds} }`;
const slot = (vm, ...tips) => vm.load(`STUB.onLoadAddOn = function() WoWAI_SlotData = { now = time(), replies = { ${tips.join(', ')} } } end`);
const tick = vm => vm.load('STUB.Tick()');
const tipLines = vm => vm.prints().split('\n').filter(l => /WoW AI reminder/.test(l));

test('a valid reminder file makes the addon read a slot and print the tip', () => {
  const vm = newVM();
  slot(vm, luaTip(vm, { id: 1, text: 'Trainer: your level 5 spells are waiting in Brill.\nFour quests end there.' }));
  vm.load(`STUB.sounds["${REMINDER(1).replace(/\\/g, '\\\\')}"] = true`);
  tick(vm);
  const lines = tipLines(vm);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /Trainer: your level 5 spells are waiting in Brill\./);
  assert.match(lines[1], /Four quests end there\./);
});

test('nothing is read while no reminder file is valid', () => {
  const vm = newVM();
  vm.load('STUB.loads = 0; STUB.onLoadAddOn = function() STUB.loads = STUB.loads + 1 end');
  tick(vm); tick(vm); tick(vm);
  assert.equal(vm.evaluate('STUB.loads'), '0', 'waiting for tips costs no slot');
  assert.equal(tipLines(vm).length, 0);
});

test('the same tip is not shown twice, and a later one is', () => {
  const vm = newVM();
  const tip1 = luaTip(vm, { id: 1, text: 'First tip.', ageSeconds: 20 });
  slot(vm, tip1);
  vm.load(`STUB.sounds["${REMINDER(1).replace(/\\/g, '\\\\')}"] = true`);
  tick(vm);
  vm.load('STUB.now = STUB.now + 30; STUB.epoch = STUB.epoch');
  slot(vm, tip1);                                   // the next slot still carries it
  vm.load(`STUB.sounds["${REMINDER(2).replace(/\\/g, '\\\\')}"] = true`);
  tick(vm);
  assert.equal(tipLines(vm).length, 1, 'shown once');
  vm.load('STUB.now = STUB.now + 30');
  slot(vm, luaTip(vm, { id: 2, text: 'Second tip.', ageSeconds: 1 }));
  vm.load(`STUB.sounds["${REMINDER(3).replace(/\\/g, '\\\\')}"] = true`);
  tick(vm);
  assert.deepEqual(tipLines(vm).map(l => l.replace(/^.*\]\|r /, '')), ['First tip.', 'Second tip.']);
});

test('a tip left over in the slot data from long ago is not news', () => {
  const vm = newVM();
  assert.equal(vm.evaluate(`WoWAIReminder.Offer(${luaTip(vm, { id: 9, text: 'Old news.', ageSeconds: 3600 })})`), 'false');
  assert.equal(tipLines(vm).length, 0);
});

test('a restarted bridge that numbers from 1 again is still heard', () => {
  const vm = newVM();
  assert.equal(vm.evaluate(`WoWAIReminder.Offer(${luaTip(vm, { id: 40, text: 'Before the restart.', ageSeconds: 600 })})`), 'true');
  assert.equal(vm.evaluate(`WoWAIReminder.Offer(${luaTip(vm, { id: 1, text: 'After the restart.', ageSeconds: 2 })})`), 'true');
  assert.equal(vm.evaluate(`WoWAIReminder.Offer(${luaTip(vm, { id: 1, text: 'After the restart.', ageSeconds: 2 })})`), 'false');
});

test('records that are not reminder tips, or have no text, are ignored', () => {
  const vm = newVM();
  assert.equal(vm.evaluate('WoWAIReminder.Offer({ id = 1, text = "x", at = time() })'), 'false', 'no reminder flag');
  assert.equal(vm.evaluate('WoWAIReminder.Offer({ reminder = true, id = 1, text = "", at = time() })'), 'false');
  assert.equal(vm.evaluate('WoWAIReminder.Offer("tip")'), 'false');
});

test('/wow-ai reminder lists the tips and clear forgets them', () => {
  const vm = newVM();
  vm.cmd('reminder');
  assert.match(vm.prints(), /no tips yet/);
  vm.load(`WoWAIReminder.Offer(${luaTip(vm, { id: 1, text: 'Line one.\nLine two.', ageSeconds: 120 })})`);
  vm.load('STUB.prints = {}');
  vm.cmd('reminder');
  const out = vm.prints();
  assert.match(out, /1 tip\(s\), newest last/);
  assert.match(out, /2 min ago\|r  Line one\./);
  assert.match(out, /Line two\./);
  vm.cmd('reminder clear');
  assert.equal(vm.evaluate('#WoWAIReminder.Tips()'), '0');
});

test('the tips survive in the saved variables, at most twenty', () => {
  const vm = newVM();
  for (let i = 1; i <= 25; i++) vm.load(`WoWAIReminder.Offer({ reminder = true, id = ${i}, at = time() - ${100 - i}, text = "tip ${i}" })`);
  assert.equal(vm.evaluate('#WoWAIDB.reminderTips'), '20');
  assert.equal(vm.evaluate('WoWAIDB.reminderTips[20].text'), 'tip 25');
});

test('the reminder module only reads and prints: it calls nothing that acts', () => {
  const src = fs.readFileSync(path.join(ADDON, 'Reminder.lua'), 'utf8').replace(/--[^\n]*/g, '');
  for (const banned of ['SendChatMessage', 'RunScript', 'CastSpellByName', 'UseAction', 'TargetUnit', 'QueryAuctionItems', 'PlaceAuctionBid', 'BuyMerchantItem', 'ChatEdit_SendText', ':Click(', 'SecureCmdOptionParse', 'loadstring']) {
    assert.ok(!src.includes(banned), `Reminder.lua must not use ${banned}`);
  }
});
