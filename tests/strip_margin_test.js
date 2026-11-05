// On a Mac client the addon starts the strip a little right of the window's corner (the Dock often covers
// the edge); elsewhere it stays in the corner. Real WoWAI.lua in a Lua VM with a stub client.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;

const ADDON = path.join(__dirname, '..', 'addon', 'WoWAI');

function stripX(isMac) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const load = (code, arg) => {
    if (lauxlib.luaL_loadstring(L, to_luastring(code)) !== lua.LUA_OK) throw new Error('Lua load: ' + to_jsstring(lua.lua_tostring(L, -1)));
    let n = 0;
    if (arg !== undefined) { lua.lua_pushstring(L, to_luastring(arg)); n = 1; }
    if (lua.lua_pcall(L, n, 0, 0) !== lua.LUA_OK) throw new Error('Lua error: ' + to_jsstring(lua.lua_tostring(L, -1)));
  };
  load(fs.readFileSync(path.join(__dirname, 'wow_stub.lua'), 'utf8'));
  if (isMac !== null) load(`IsMacClient = function() return ${isMac} end`);
  for (const f of ['Codec.lua', 'Inbox.lua', 'WoWAI.lua', 'Map.lua', 'Feed.lua', 'Code.lua', 'Shop.lua', 'Coach.lua']) load(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'WoWAI');
  load('STUB.FireEvent("ADDON_LOADED", "WoWAI")');
  load('STUB.FireEvent("PLAYER_LOGIN")');
  load('SlashCmdList.WOWAI("hello strip")');
  load('local ok = pcall(function() WoWAI.Send("strip please") end)');
  load('RESULT = tostring(WoWAIStrip and WoWAIStrip.x)');
  lua.lua_getglobal(L, to_luastring('RESULT'));
  return to_jsstring(lua.lua_tostring(L, -1));
}

test('on a Mac client the strip starts 96 units right of the corner', () => {
  assert.equal(stripX(true), '96');
});

test('on other clients it stays in the corner', () => {
  assert.equal(stripX(false), '0');
  assert.equal(stripX(null), '0', 'a client without IsMacClient');
});
