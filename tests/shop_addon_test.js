// The addon side of shopping suggestions (addon/WoWAI/Shop.lua, docs/SHOP.md), in a Lua VM with a
// stub client: the list at the auction house, a click that types the item name into the search
// box, and a check that the addon never sends a search or buys anything itself.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fengari = require('fengari');
const { lua, lauxlib, lualib, to_luastring, to_jsstring } = fengari;
const P = require('../bridge/protocol');

const ADDON = path.join(__dirname, '..', 'addon', 'WoWAI');

const AH_STUB = `
STUB.queries = 0
function QueryAuctionItems() STUB.queries = STUB.queries + 1 end
function PlaceAuctionBid() STUB.queries = STUB.queries + 1 end
function StartAuction() STUB.queries = STUB.queries + 1 end
function SendChatMessage() STUB.queries = STUB.queries + 1 end
`;
const ERA_AH = `AuctionFrame = CreateFrame("Frame", "AuctionFrame"); BrowseName = CreateFrame("EditBox", "BrowseName", AuctionFrame)`;
const NEW_AH = `AuctionHouseFrame = CreateFrame("Frame", "AuctionHouseFrame"); AuctionHouseFrame.SearchBar = CreateFrame("Frame", nil, AuctionHouseFrame); AuctionHouseFrame.SearchBar.SearchBox = CreateFrame("EditBox", nil, AuctionHouseFrame.SearchBar)`;

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
  load(AH_STUB);
  for (const f of ['Codec.lua', 'Inbox.lua', 'WoWAI.lua', 'Map.lua', 'Feed.lua', 'Code.lua', 'Shop.lua']) load(fs.readFileSync(path.join(ADDON, f), 'utf8'), 'WoWAI');
  load('STUB.FireEvent("ADDON_LOADED", "WoWAI")');
  load('STUB.FireEvent("PLAYER_LOGIN")');
  const prints = () => { load('RESULT_P = table.concat(STUB.prints, "\\n")'); return evaluate('RESULT_P') || ''; };
  return { load, evaluate, prints, cmd: s => { load('SlashCmdList.WOWAI(...)', s); } };
}

const ITEMS = [
  { item: 'Heavy Linen Bandage', where: 'ah', why: 'First Aid 40/75 uses it', max: '60s', qty: 20 },
  { item: 'Refreshing Spring Water', where: 'vendor', vendor: 'Innkeeper Farley', zone: 'Goldshire', why: 'mana between pulls' },
  { item: 'Linen Cloth', where: 'ah' },
];
const luaList = items => '{' + items.map(i => '{' + Object.entries(i).map(([k, v]) => `${k} = ${typeof v === 'number' ? v : JSON.stringify(v)}`).join(', ') + '}').join(', ') + '}';
const offer = (vm, items = ITEMS) => vm.load(`WoWAIShop.Offer(${luaList(items)})`);
const rows = vm => vm.evaluate('#WoWAIShop.Rows()');

test('shop: suggestions are kept per character and listed by /wow-ai shop, the auction house ones numbered', () => {
  const vm = newVM();
  offer(vm);
  assert.match(vm.prints(), /3 shopping suggestions/);
  vm.cmd('shop');
  const out = vm.prints();
  assert.match(out, /1\. Auction house: Heavy Linen Bandage x20 \(up to 60s each\): First Aid 40\/75 uses it/);
  assert.match(out, /Vendor: Refreshing Spring Water from Innkeeper Farley in Goldshire: mana between pulls/);
  assert.match(out, /Auction house: Linen Cloth/);
  assert.equal(vm.evaluate('WoWAIDB.shopping["Testchar-Test Realm"].items[1].item'), 'Heavy Linen Bandage');
});

test('shop: opening the auction house shows only the auction house items beside it; closing hides them', () => {
  const vm = newVM();
  vm.load(ERA_AH);
  offer(vm);
  vm.load('STUB.FireEvent("AUCTION_HOUSE_SHOW")');
  assert.equal(vm.evaluate('WoWAIShop.Panel().shown'), 'true');
  assert.equal(rows(vm), '2', 'the vendor item is not listed at the auction house');
  assert.match(vm.evaluate('WoWAIShop.Rows()[1].text'), /Heavy Linen Bandage x20 \(up to 60s each\)/);
  assert.match(vm.evaluate('WoWAIShop.Rows()[2].text'), /Linen Cloth/);
  assert.match(vm.evaluate('WoWAIShop.Panel().footer'), /1 vendor item/);
  vm.load('STUB.FireEvent("AUCTION_HOUSE_CLOSED")');
  assert.equal(vm.evaluate('WoWAIShop.Panel().shown'), 'false');
});

test('shop: clicking a row types the name into the search box and nothing else; no search, bid or post is ever sent', () => {
  const vm = newVM();
  vm.load(ERA_AH);
  offer(vm);
  vm.load('STUB.FireEvent("AUCTION_HOUSE_SHOW")');
  vm.load('WoWAIShop.Rows()[1].button.scripts.OnClick(WoWAIShop.Rows()[1].button)');
  assert.equal(vm.evaluate('BrowseName:GetText()'), 'Heavy Linen Bandage');
  vm.load('WoWAIShop.Rows()[2].button.scripts.OnClick(WoWAIShop.Rows()[2].button)');
  assert.equal(vm.evaluate('BrowseName:GetText()'), 'Linen Cloth');
  vm.cmd('shop 1');
  assert.equal(vm.evaluate('BrowseName:GetText()'), 'Heavy Linen Bandage');
  assert.equal(vm.evaluate('STUB.queries'), '0', 'QueryAuctionItems, bids, auctions and chat were never called');
});

test('shop: the newer auction house window (SearchBar.SearchBox) works the same way', () => {
  const vm = newVM();
  vm.load(NEW_AH);
  offer(vm);
  vm.load('STUB.FireEvent("AUCTION_HOUSE_SHOW")');
  vm.load('WoWAIShop.Rows()[1].button.scripts.OnClick(WoWAIShop.Rows()[1].button)');
  assert.equal(vm.evaluate('AuctionHouseFrame.SearchBar.SearchBox:GetText()'), 'Heavy Linen Bandage');
  assert.equal(vm.evaluate('STUB.queries'), '0');
});

test('shop: with no auction house window the name is printed to chat instead, and nothing errors', () => {
  const vm = newVM();
  offer(vm);
  vm.load('STUB.FireEvent("AUCTION_HOUSE_SHOW")');
  vm.cmd('shop 1');
  assert.match(vm.prints(), /Search the auction house for: Heavy Linen Bandage/);
  vm.cmd('shop 9');
  assert.match(vm.prints(), /no suggestion number 9/);
  vm.cmd('shop 2');
  assert.match(vm.prints(), /is a vendor item/);
});

test('shop: a new list replaces the old one, refreshes an open panel, and /wow-ai shop clear empties it', () => {
  const vm = newVM();
  vm.load(ERA_AH);
  offer(vm);
  vm.load('STUB.FireEvent("AUCTION_HOUSE_SHOW")');
  offer(vm, [{ item: 'Silk Cloth', where: 'ah', max: '2g' }]);
  assert.equal(rows(vm), '1');
  assert.match(vm.evaluate('WoWAIShop.Rows()[1].text'), /Silk Cloth \(up to 2g each\)/);
  vm.cmd('shop clear');
  assert.equal(vm.evaluate('#WoWAIShop.Items()'), '0');
  assert.equal(rows(vm), '0');
  assert.match(vm.prints(), /shopping list cleared/);
});

test('shop: whatever arrives is cleaned and limited before it is stored or shown', () => {
  const vm = newVM();
  vm.load(ERA_AH);
  vm.load(`WoWAIShop.Offer({
    { item = "|cffff0000Red [Sword]|r\\0 \\n x", where = "mailbox", why = string.rep("w", 400) },
    { item = "" }, { item = 5 }, "junk", { where = "ah" }, { item = "ok name", qty = "many", max = "$$$" },
  })`);
  const items = vm.evaluate('#WoWAIShop.Items()');
  assert.equal(items, '2');
  assert.equal(vm.evaluate('WoWAIShop.Items()[1].item'), 'cffff0000Red Sword r x');
  assert.equal(vm.evaluate('WoWAIShop.Items()[1].where'), 'ah');
  assert.ok(Number(vm.evaluate('#WoWAIShop.Items()[1].why')) <= 100);
  assert.equal(vm.evaluate('WoWAIShop.Items()[2].qty'), null);
  assert.equal(vm.evaluate('WoWAIShop.Items()[2].max'), null);
  vm.load('WoWAIShop.Offer(nil); WoWAIShop.Offer("x"); WoWAIShop.Offer({})');
  assert.equal(vm.evaluate('#WoWAIShop.Items()'), '2', 'garbage does not wipe the list');
  vm.load('local big = {}; for i = 1, 40 do big[i] = { item = "Item number " .. i } end; WoWAIShop.Offer(big)');
  assert.equal(vm.evaluate('#WoWAIShop.Items()'), '12');
});

test('shop: the exact record the bridge writes is understood', () => {
  const items = P.extractShopBlocks('```wowshop\n{"item":"Heavy Linen Bandage","where":"ah","max":"60s","qty":20,"why":"First Aid"}\n```').items;
  const slot = P.luaTable('WoWAI_SlotData', [{ chat: 'c', id: 1, status: 'done', text: 'ok', shop: items }], {});
  const vm = newVM();
  vm.load(slot);
  vm.load('WoWAIShop.Offer(WoWAI_SlotData.replies[1].shop)');
  assert.equal(vm.evaluate('WoWAIShop.Items()[1].qty'), '20');
  assert.equal(vm.evaluate('WoWAIShop.Items()[1].max'), '60s');
});

test('shop: a message that merely starts with the word shop still goes to the agent', () => {
  const vm = newVM();
  offer(vm);
  vm.load('STUB.prints = {}');
  vm.cmd('shop for a better sword please');
  assert.ok(!/Auction house:|shopping list/.test(vm.prints()), 'it was not taken as a shop command');
});

test('shop: the addon never calls a function that searches, bids, posts or chats', () => {
  const src = fs.readFileSync(path.join(ADDON, 'Shop.lua'), 'utf8');
  for (const name of ['QueryAuctionItems', 'PlaceAuctionBid', 'StartAuction', 'SendChatMessage', 'BuyMerchantItem', 'CancelAuction', 'AuctionFrameBrowse_Search', 'RunScript', 'ChatEdit_SendText']) {
    assert.ok(!src.includes(name), `Shop.lua must not mention ${name}`);
  }
  assert.ok(!/:Click\(/.test(src), 'it never clicks a button for the player');
});
