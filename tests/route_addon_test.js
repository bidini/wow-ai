// The route step list (addon/WoWAI/Route.lua): a route written by the planner as WoWAIRouteData is listed on the left of the screen, the
// current step marked, and each step ticked off from the game's own quest state. No agent, no arrow. The addon only reads and draws.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const ADDON = path.join(__dirname, '..', 'addon', 'WoWAI');

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
  load(`
    STUB.log, STUB.done = {}, {}
    C_QuestLog = C_QuestLog or {}
    C_QuestLog.IsOnQuest = function(id) return STUB.log[id] ~= nil end
    C_QuestLog.IsComplete = function(id) return STUB.log[id] ~= nil and STUB.log[id].ready == true end
    C_QuestLog.IsQuestFlaggedCompleted = function(id) return STUB.done[id] == true end
  `);
  return { load, evaluate };
}

const STEPS = [
  { k: 'accept', q: 100, t: 'Accept: The Damned (Magistrate Sevren, Brill)', z: 'Tirisfal Glades 61.3, 50.8', w: 'walk 120 yd' },
  { k: 'kill', q: 100, t: 'Kill 8: Rot Hide Brute for The Damned', z: 'Silverpine Forest 66.2, 24.8', w: 'walk 900 yd' },
  { k: 'turnin', q: 100, t: 'Turn in: The Damned (Magistrate Sevren, Brill)', z: 'Tirisfal Glades 61.3, 50.8', w: 'fly Undercity to The Sepulcher' },
  { k: 'discover', t: 'Find the flight point: Tarren Mill, Hillsbrad', z: 'Hillsbrad Foothills 60.2, 18.6', w: 'walk 203 yd' },
  { k: 'accept', q: 200, t: 'Accept: Time To Strike (Deathstalker Lesh)', z: 'Hillsbrad Foothills 20.8, 47.4', w: 'walk 873 yd' },
];
const luaData = (steps, stamp = 'run1') => `WoWAIRouteData = { stamp = ${JSON.stringify(stamp)}, character = "Leprince", level = 16, target = 22, steps = {\n` +
  steps.map((s, i) => `\t{ i = ${i + 1}, k = ${JSON.stringify(s.k)}, ${s.q ? `q = ${s.q}, ` : ''}t = ${JSON.stringify(s.t)}, z = ${JSON.stringify(s.z)}, w = ${JSON.stringify(s.w)} },`).join('\n') + '\n} }';

function routeVM(steps = STEPS, extra = '') {
  const vm = newVM();
  vm.load(luaData(steps));
  vm.load(extra);
  vm.load(fs.readFileSync(path.join(ADDON, 'Route.lua'), 'utf8'), 'WoWAI');
  vm.load('STUB.FireEvent("ADDON_LOADED", "WoWAI"); STUB.FireEvent("PLAYER_LOGIN")');
  return vm;
}
const strip = s => s.replace(/\|c%x%x%x%x%x%x%x%x/g, '');
const rows = vm => {
  vm.load('RES = {}; for _, r in ipairs(WoWAIRouteList.rows) do if r.shown then RES[#RES + 1] = (r.text or ""):gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "") end end; RESULT = table.concat(RES, "\\n")');
  return (vm.evaluate('RESULT') || '').split('\n').filter(Boolean);
};
const refresh = vm => vm.load('WoWAIRoute.Refresh()');

test('the first step is current, with where to go and how; the steps after it follow', () => {
  const vm = routeVM();
  const r = rows(vm);
  assert.match(r[0], /^> 1\. Accept: The Damned \(Magistrate Sevren, Brill\)$/);
  assert.match(r[1], /Tirisfal Glades 61\.3, 50\.8.*walk 120 yd/, 'the current step says where and how');
  assert.match(r[2], /^ +2\. Kill 8: Rot Hide Brute for The Damned$/);
  assert.match(vm.evaluate('WoWAIRouteList.title.text'), /Route 1\/5/);
  assert.equal(vm.evaluate('WoWAIRoute.State().current'), '1');
});

test('steps are ticked off from the game state: accepted, ready, handed in', () => {
  const vm = routeVM();
  vm.load('STUB.log[100] = { ready = false }'); refresh(vm);
  assert.equal(vm.evaluate('WoWAIRoute.State().current'), '2', 'accepted: the accept step is done');
  vm.load('STUB.log[100].ready = true'); refresh(vm);
  assert.equal(vm.evaluate('WoWAIRoute.State().current'), '3', 'ready: the objective steps are done');
  vm.load('STUB.log[100] = nil; STUB.done[100] = true'); refresh(vm);
  assert.equal(vm.evaluate('WoWAIRoute.State().current'), '4', 'handed in: the turn-in is done');
  const r = rows(vm);
  assert.match(r[0], /^ +3\. Turn in: The Damned/, 'the step before the current one stays visible');
  assert.match(r[1], /^> 4\. Find the flight point/);
});

test('a quest finished out of order ticks its later steps too, and quest events refresh the list', () => {
  const vm = routeVM();
  vm.load('STUB.done[100] = true; STUB.FireEvent("QUEST_TURNED_IN", 100, 100, 50)');
  assert.equal(vm.evaluate('WoWAIRoute.State().current'), '4');
  vm.load('STUB.FireEvent("QUEST_LOG_UPDATE")');
  assert.match(strip(vm.evaluate('WoWAIRouteList.title.text')), /Route 4\/5/);
});

test('a step with no quest (a flight point, an inn) is ticked by hand: /wow-ai route skip, undo, reset', () => {
  const vm = routeVM(STEPS, 'STUB.done[100] = true');
  assert.equal(vm.evaluate('WoWAIRoute.State().current'), '4');
  vm.load('WoWAIRoute.Command("skip")');
  assert.equal(vm.evaluate('WoWAIRoute.State().current'), '5');
  vm.load('WoWAIRoute.Command("undo 4")');
  assert.equal(vm.evaluate('WoWAIRoute.State().current'), '4');
  vm.load('WoWAIRoute.Command("skip 5"); WoWAIRoute.Command("skip 4")');
  assert.equal(vm.evaluate('WoWAIRoute.State().current'), '6', 'past the last step: nothing left');
  vm.load('WoWAIRoute.Command("reset")');
  assert.equal(vm.evaluate('WoWAIRoute.State().current'), '4');
});

test('right-clicking a row skips that step', () => {
  const vm = routeVM();
  vm.load('local row = WoWAIRouteList.rows[1]; row.scripts.OnMouseUp(row, "RightButton")');
  assert.equal(vm.evaluate('WoWAIRoute.State().current'), '2');
});

test('a new route from the planner clears the hand-made skips of the old one', () => {
  const vm = routeVM();
  vm.load('WoWAIRoute.Command("skip")');
  assert.equal(vm.evaluate('WoWAIRoute.State().current'), '2');
  vm.load(luaData(STEPS, 'run2'));
  vm.load('WoWAIRoute.Reload()');
  assert.equal(vm.evaluate('WoWAIRoute.State().current'), '1');
});

test('a long route shows twelve lines at most, from the step before the current one', () => {
  const steps = Array.from({ length: 40 }, (_, i) => ({ k: 'kill', q: 1000 + i, t: `Kill: Mob ${i + 1}`, z: 'Zone 1, 1', w: 'walk 10 yd' }));
  const vm = routeVM(steps, 'for i = 1, 13 do STUB.done[1000 + i - 1] = true end');
  const r = rows(vm);
  assert.equal(r.length, 12);
  assert.match(r[0], /^ +13\. Kill: Mob 13$/);
  assert.match(r[1], /^> 14\. Kill: Mob 14$/);
});

test('/wow-ai route off hides the list and on shows it; no route installed means no list and no error', () => {
  const vm = routeVM();
  vm.load('WoWAIRoute.Command("off")');
  assert.equal(vm.evaluate('WoWAIRouteList.shown'), 'false');
  vm.load('WoWAIRoute.Command("on")');
  assert.equal(vm.evaluate('WoWAIRouteList.shown'), 'true');
  const none = newVM();
  none.load(fs.readFileSync(path.join(ADDON, 'Route.lua'), 'utf8'), 'WoWAI');
  none.load('STUB.FireEvent("ADDON_LOADED", "WoWAI"); STUB.FireEvent("PLAYER_LOGIN"); WoWAIRoute.Command("")');
  assert.equal(none.evaluate('WoWAIRouteList'), null);
});

test('the list starts right of the Dock margin on a Mac, and a client without the quest calls raises no error', () => {
  const mac = routeVM(STEPS, 'IsMacClient = function() return true end');
  mac.load('WoWAIRoute.Reload()');
  assert.ok(Number(mac.evaluate('WoWAIRouteList.x')) >= 96);
  const bare = newVM();
  bare.load('C_QuestLog = nil');
  bare.load(luaData(STEPS));
  bare.load(fs.readFileSync(path.join(ADDON, 'Route.lua'), 'utf8'), 'WoWAI');
  bare.load('STUB.FireEvent("ADDON_LOADED", "WoWAI"); STUB.FireEvent("PLAYER_LOGIN"); WoWAIRoute.Refresh()');
  assert.equal(bare.evaluate('WoWAIRoute.State().current'), '1');
});

test('the route module only reads and draws: it calls nothing that acts', () => {
  const src = fs.readFileSync(path.join(ADDON, 'Route.lua'), 'utf8').replace(/--[^\n]*/g, '');
  for (const banned of ['SendChatMessage', 'RunScript', 'CastSpellByName', 'UseAction', 'TargetUnit', 'AcceptQuest', 'CompleteQuest', 'AbandonQuest', 'QueryAuctionItems', 'BuyMerchantItem', 'ChatEdit_SendText', ':Click(', 'SecureCmdOptionParse', 'loadstring']) {
    assert.ok(!src.includes(banned), `Route.lua must not use ${banned}`);
  }
});
