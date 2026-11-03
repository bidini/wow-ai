-- WoWAI code loader: runs addon code the agent proposed and the bridge's checker accepted
-- (docs/CODE.md). Nothing here runs by itself. The code sits in a load-on-demand slot addon
-- (WoWAI_C01..) as data until the player types /wow-ai code load <slot>; it is gone again after
-- a /reload or logout and never loads at login.
--
-- The code runs in an environment that holds only the names the checker allows (a copy of the
-- list in bridge/lint.js; tests/code_test.js checks that the two agree). Whatever the code names
-- beyond them is nil, so SendChatMessage, _G, loadstring and the like are simply not there.
-- It only reads game state and draws; it cannot act for the player.

local M = {}
WoWAICode = M
local WoWAI = _G.WoWAI

local SLOTS = 20
local MAX_SOURCE = 16000
local unpack = unpack or table.unpack

-- The allowlist (keep in step with bridge/lint.js).
local GLOBALS = {
	"assert", "error", "ipairs", "next", "pairs", "pcall", "select", "tonumber", "tostring", "unpack", "type",
	"time", "date", "GetTime",
	"UnitName", "UnitLevel", "UnitClass", "UnitRace", "UnitHealth", "UnitHealthMax", "UnitPower", "UnitPowerMax",
	"UnitXP", "UnitXPMax", "UnitIsDead", "UnitIsDeadOrGhost", "UnitOnTaxi", "UnitExists",
	"GetZoneText", "GetSubZoneText", "GetRealZoneText", "GetMinimapZoneText", "GetUnitSpeed", "GetMoney",
	"GetFramerate", "GetNetStats", "IsMounted", "IsResting", "GetNumQuestLogEntries", "GetQuestLogTitle",
	"GetItemInfo", "GetSpellInfo", "GetCoinTextureString",
	"UIParent",
}
local NAMESPACES = {
	string = { "format", "sub", "find", "match", "gmatch", "gsub", "len", "lower", "upper", "byte", "char" },
	table = { "insert", "remove", "sort", "concat", "wipe", "getn" },
	math = { "abs", "ceil", "floor", "max", "min", "sqrt", "pi", "sin", "cos", "tan", "atan", "atan2", "exp", "log", "log10", "fmod", "modf", "huge", "random" },
	C_Timer = { "After", "NewTicker" },
	C_Map = { "GetBestMapForUnit", "GetPlayerMapPosition", "GetMapInfo", "GetMapRectOnMap", "GetMapWorldSize" },
	C_QuestLog = { "GetInfo", "GetNumQuestLogEntries", "IsComplete" },
}
local FRAME_TYPES = { Frame = true, Button = true, StatusBar = true }
local TEMPLATES = { BackdropTemplate = true }

function M.Allowed()
	return { globals = GLOBALS, namespaces = NAMESPACES, frameTypes = FRAME_TYPES, templates = TEMPLATES, slots = SLOTS }
end

local running = {}   -- name -> { name, slot, seq, hash, lines, frames, tickers, stopped }

local function Say(msg) print("|cff66ccff[WoW AI code]|r " .. msg) end

local function Off()
	return WoWAIDB and WoWAIDB.settings and WoWAIDB.settings.codeOff == true
end

-- Adler-32 of the source bytes, eight hex digits: the same number the bridge printed in its note.
local function Check(src)
	local a, b = 1, 0
	for i = 1, #src do
		a = (a + src:byte(i)) % 65521
		b = (b + a) % 65521
	end
	return string.format("%08x", b * 65536 + a)
end
M.Check = Check

local function Compile(src, name, env)
	if setfenv and loadstring then
		local fn, err = loadstring(src, "=" .. name)
		if not fn then return nil, err end
		setfenv(fn, env)
		return fn
	end
	return load(src, "=" .. name, "t", env)
end

local function BuildEnv(entry)
	local env = {}
	local real = _G
	for _, name in ipairs(GLOBALS) do env[name] = real[name] end
	env.unpack = unpack
	for ns, members in pairs(NAMESPACES) do
		local copy = {}
		local source = real[ns]
		if type(source) == "table" then
			for _, m in ipairs(members) do copy[m] = source[m] end
		end
		env[ns] = copy
	end
	env.print = function(...)
		local parts = {}
		for i = 1, select("#", ...) do parts[#parts + 1] = tostring((select(i, ...))) end
		print("|cff66ccff[" .. entry.name .. "]|r " .. table.concat(parts, " "))
	end
	-- Frames: plain types only, no secure templates. A name would create a global, so it is ignored.
	env.CreateFrame = function(frameType, _, parent, template)
		if not FRAME_TYPES[frameType] then error("CreateFrame: type not allowed", 2) end
		if template ~= nil and not TEMPLATES[template] then error("CreateFrame: template not allowed", 2) end
		local frame = real.CreateFrame(frameType, nil, parent or real.UIParent, template)
		entry.frames[#entry.frames + 1] = frame
		return frame
	end
	env.C_Timer.After = function(delay, fn)
		return real.C_Timer.After(delay, function() if not entry.stopped then fn() end end)
	end
	env.C_Timer.NewTicker = function(delay, fn, iterations)
		local ticker = real.C_Timer.NewTicker(delay, function() if not entry.stopped then fn() end end, iterations)
		entry.tickers[#entry.tickers + 1] = ticker
		return ticker
	end
	return setmetatable(env, {
		__newindex = function(_, key) error("global variables are not allowed (" .. tostring(key) .. "); use local", 2) end,
		__metatable = false,
	})
end

local function Stop(name)
	local entry = running[name]
	if not entry then return false end
	entry.stopped = true
	for _, t in ipairs(entry.tickers) do pcall(function() t:Cancel() end) end
	for _, f in ipairs(entry.frames) do
		-- Each step on its own: a frame that lacks one method must still get the others.
		pcall(function() f:UnregisterAllEvents() end)
		pcall(function() f:SetScript("OnEvent", nil) end)
		pcall(function() f:SetScript("OnUpdate", nil) end)
		pcall(function() f:Hide() end)
	end
	running[name] = nil
	return true
end

-- The slot addon's contents, once loaded, or nil and a reason.
local function ReadSlot(slot)
	local addon = string.format("WoWAI_C%02d", slot)
	WoWAI_CodeSlot = nil
	local ok, loaded, reason = pcall(C_AddOns.LoadAddOn, addon)
	if not ok or not loaded then
		if reason == "MISSING" or reason == "DISABLED" or not ok then
			return nil, "slot " .. slot .. " is not installed (run node setup.js in the wow-ai folder, then restart WoW)"
		end
		return nil, "could not load slot " .. slot .. " (" .. tostring(reason) .. ")"
	end
	local data = WoWAI_CodeSlot
	WoWAI_CodeSlot = nil
	if type(data) ~= "table" or data.source == nil then
		return nil, "slot " .. slot .. " has nothing in it, or it was already loaded this session (/reload makes slots readable again)"
	end
	return data
end

function M.Load(slotArg)
	if Off() then Say("code is switched off (/wow-ai code on)"); return end
	local slot = tonumber(slotArg)
	if not slot or slot ~= math.floor(slot) or slot < 1 or slot > SLOTS then
		Say("usage: /wow-ai code load <slot 1-" .. SLOTS .. "> (the number is in the note under the agent's code)")
		return
	end
	local data, why = ReadSlot(slot)
	if not data then Say(why); return end
	local name, src = data.name, data.source
	if type(name) ~= "string" or not name:match("^[a-z][a-z0-9_%-]*$") or #name > 24 then Say("slot " .. slot .. " has a bad name; not loaded"); return end
	if type(src) ~= "string" or #src == 0 or #src > MAX_SOURCE then Say("slot " .. slot .. " has code of a bad size; not loaded"); return end
	local check = Check(src)
	if check ~= data.hash then Say("slot " .. slot .. ": the check number does not match the code (" .. tostring(data.hash) .. " vs " .. check .. "); not loaded"); return end
	if running[name] then Stop(name) end
	local entry = { name = name, slot = slot, seq = data.seq, hash = check, lines = data.lines, frames = {}, tickers = {}, stopped = false }
	local fn, err = Compile(src, "wowai:" .. name, BuildEnv(entry))
	if not fn then Say(name .. ": " .. tostring(err)); return end
	running[name] = entry
	local ok, runErr = pcall(fn)
	if not ok then
		Say(name .. " stopped with an error: " .. tostring(runErr))
		Stop(name)
		return
	end
	Say(string.format("%s is running (slot %d, #%s, %s lines, check %s). Stop it with /wow-ai code stop %s", name, slot, tostring(data.seq), tostring(data.lines), check, name))
end

function M.StopAll()
	local names = {}
	for name in pairs(running) do names[#names + 1] = name end
	for _, name in ipairs(names) do Stop(name) end
	return #names
end

function M.Status()
	local list = {}
	for name, e in pairs(running) do list[#list + 1] = { name = name, slot = e.slot, seq = e.seq, hash = e.hash, frames = #e.frames } end
	table.sort(list, function(a, b) return a.name < b.name end)
	return { off = Off(), running = list }
end

function M.Command(rest)
	rest = tostring(rest or ""):lower()
	local verb, arg = rest:match("^(%a+)%s*(.-)%s*$")
	if verb == "load" then
		M.Load(arg)
	elseif verb == "stop" then
		if arg == "all" or arg == "" then
			Say(M.StopAll() .. " stopped")
		elseif Stop(arg) then
			Say(arg .. " stopped")
		else
			Say("nothing called " .. arg .. " is running")
		end
	elseif verb == "off" then
		local n = M.StopAll()
		if WoWAIDB and WoWAIDB.settings then WoWAIDB.settings.codeOff = true end
		Say("code is switched off (" .. n .. " stopped); /wow-ai code on turns loading back on")
	elseif verb == "on" then
		if WoWAIDB and WoWAIDB.settings then WoWAIDB.settings.codeOff = nil end
		Say("code loading is on; nothing runs until you load a slot")
	else
		local st = M.Status()
		if #st.running == 0 then
			Say("no code is running" .. (st.off and " (switched off)" or "") .. ". /wow-ai code load <slot>, stop <name|all>, on|off")
		else
			for _, e in ipairs(st.running) do
				Say(string.format("%s running: slot %d, #%s, check %s, %d frame(s)", e.name, e.slot, tostring(e.seq), e.hash, e.frames))
			end
			Say("/wow-ai code stop <name|all>")
		end
	end
end
