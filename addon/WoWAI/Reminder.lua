-- WoWAI reminder: tips the bridge asked the agent for on its own, after every few game events (docs/REMINDER.md).
-- The bridge flips a reminder signal file and publishes the tip in the slot data; WoWAI.lua reads the slot
-- and hands the record to Offer. The tip is printed in the chat frame and kept for /wow-ai reminder.
--
-- It only reads and prints. Nothing here acts for the player.

local M = {}
WoWAIReminder = M

local KEPT = 20
local STALE_SECONDS = 900 -- a tip still sitting in the slot data from long ago is not news

local function Saved()
	if type(WoWAIDB) ~= "table" then return nil end
	WoWAIDB.reminderTips = WoWAIDB.reminderTips or {}
	return WoWAIDB
end

-- The chat tab number for a name (any case) or a number, nil when there is no such tab.
local function WindowIndex(w)
	local max = NUM_CHAT_WINDOWS or 1
	local n = tonumber(w)
	if n then return (n >= 1 and n <= max and n == math.floor(n)) and n or nil end
	if type(w) ~= "string" or w == "" or not GetChatWindowInfo then return nil end
	for i = 1, max do
		local name = GetChatWindowInfo(i)
		if type(name) == "string" and name:lower() == w:lower() then return i end
	end
	return nil
end

-- Where the reminders are written: the chosen chat tab, else the main window (what print() uses).
local function Out(text)
	local db = Saved()
	local i = db and db.reminderWindow ~= nil and WindowIndex(db.reminderWindow)
	local frame = i and _G["ChatFrame" .. i]
	if frame and frame.AddMessage then frame:AddMessage(text) else print(text) end
end

local function Say(msg) Out("|cffffd100[WoW AI reminder]|r " .. msg) end

-- A tip is new when it is later than the last one shown (the bridge's clock, then its own id), so a
-- restarted bridge that numbers from 1 again is still heard, and a tip is never shown twice.
local function IsNew(db, r)
	local at, id = tonumber(r.at) or 0, tonumber(r.id) or 0
	if at > 0 and time() - at > STALE_SECONDS then return false end
	local lastAt, lastId = db.reminderLastAt or 0, db.reminderLastId or 0
	return at > lastAt or (at == lastAt and id > lastId)
end

-- r: { reminder = true, id, at, text }. Returns true when the tip was shown.
function M.Offer(r)
	local db = Saved()
	if not db or type(r) ~= "table" or not r.reminder or type(r.text) ~= "string" or r.text == "" then return false end
	if not IsNew(db, r) then return false end
	db.reminderLastAt, db.reminderLastId = tonumber(r.at) or 0, tonumber(r.id) or 0
	table.insert(db.reminderTips, { at = tonumber(r.at) or time(), text = r.text })
	while #db.reminderTips > KEPT do table.remove(db.reminderTips, 1) end
	for line in r.text:gmatch("[^\n]+") do Say(line) end
	return true
end

function M.Tips()
	local db = Saved()
	return db and db.reminderTips or {}
end

local function Age(at)
	local s = math.max(0, time() - (tonumber(at) or 0))
	if s < 90 then return s .. " s" end
	if s < 5400 then return math.floor(s / 60 + 0.5) .. " min" end
	return string.format("%.1f h", s / 3600)
end

-- The chat tabs, "1 General, 2 Reminders", for the window command.
local function Windows()
	local list = {}
	for i = 1, NUM_CHAT_WINDOWS or 1 do
		local name = GetChatWindowInfo and GetChatWindowInfo(i)
		if type(name) == "string" and name ~= "" then table.insert(list, i .. " " .. name) end
	end
	return table.concat(list, ", ")
end

local function WindowCommand(db, arg)
	if arg == "default" then
		db.reminderWindow = nil
		print("|cffffd100[WoW AI reminder]|r reminders go to the main chat window")
	elseif arg == "" then
		local i = db.reminderWindow ~= nil and WindowIndex(db.reminderWindow)
		print("|cffffd100[WoW AI reminder]|r " .. (i and ("reminders go to \"" .. tostring(GetChatWindowInfo and GetChatWindowInfo(i) or i) .. "\"") or "reminders go to the main chat window")
			.. ". Tabs: " .. Windows() .. ". Change with /wow-ai reminder window <number|name|default>")
	else
		local i = WindowIndex(arg)
		if not i then
			print("|cffffd100[WoW AI reminder]|r no chat window called \"" .. arg .. "\". Tabs: " .. Windows() .. ". Make one by right-clicking a chat tab and choosing New Window")
			return
		end
		local name = GetChatWindowInfo and GetChatWindowInfo(i)
		db.reminderWindow = (type(name) == "string" and name ~= "") and name or i
		Out("|cffffd100[WoW AI reminder]|r reminders now go to the chat window \"" .. tostring(name or i) .. "\"")
		if i ~= 1 then print("|cffffd100[WoW AI reminder]|r reminders now go to the chat window \"" .. tostring(name or i) .. "\"") end
	end
end

function M.Command(rest)
	local db = Saved()
	if not db then return end
	local window = rest:match("^window%s*(.-)%s*$")
	if window then WindowCommand(db, window) return end
	if rest == "clear" then
		db.reminderTips = {}
		Say("cleared")
		return
	end
	local tips = db.reminderTips
	if #tips == 0 then
		Say("no tips yet. The bridge asks the agent every few game events and only speaks up when there is something worth saying.")
		return
	end
	Say(#tips .. " tip(s), newest last:")
	for _, t in ipairs(tips) do
		local first = true
		for line in t.text:gmatch("[^\n]+") do
			Out((first and ("  |cff999999" .. Age(t.at) .. " ago|r  ") or "      ") .. line)
			first = false
		end
	end
end
