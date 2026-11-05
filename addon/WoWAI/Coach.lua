-- WoWAI coach: tips the bridge asked the agent for on its own, after every few game events (docs/COACH.md).
-- The bridge flips a coach signal file and publishes the tip in the slot data; WoWAI.lua reads the slot
-- and hands the record to Offer. The tip is printed in the chat frame and kept for /wow-ai coach.
--
-- It only reads and prints. Nothing here acts for the player.

local M = {}
WoWAICoach = M

local KEPT = 20
local STALE_SECONDS = 900 -- a tip still sitting in the slot data from long ago is not news

local function Say(msg) print("|cffffd100[WoW AI coach]|r " .. msg) end

local function Saved()
	if type(WoWAIDB) ~= "table" then return nil end
	WoWAIDB.coachTips = WoWAIDB.coachTips or {}
	return WoWAIDB
end

-- A tip is new when it is later than the last one shown (the bridge's clock, then its own id), so a
-- restarted bridge that numbers from 1 again is still heard, and a tip is never shown twice.
local function IsNew(db, r)
	local at, id = tonumber(r.at) or 0, tonumber(r.id) or 0
	if at > 0 and time() - at > STALE_SECONDS then return false end
	local lastAt, lastId = db.coachLastAt or 0, db.coachLastId or 0
	return at > lastAt or (at == lastAt and id > lastId)
end

-- r: { coach = true, id, at, text }. Returns true when the tip was shown.
function M.Offer(r)
	local db = Saved()
	if not db or type(r) ~= "table" or not r.coach or type(r.text) ~= "string" or r.text == "" then return false end
	if not IsNew(db, r) then return false end
	db.coachLastAt, db.coachLastId = tonumber(r.at) or 0, tonumber(r.id) or 0
	table.insert(db.coachTips, { at = tonumber(r.at) or time(), text = r.text })
	while #db.coachTips > KEPT do table.remove(db.coachTips, 1) end
	for line in r.text:gmatch("[^\n]+") do Say(line) end
	return true
end

function M.Tips()
	local db = Saved()
	return db and db.coachTips or {}
end

local function Age(at)
	local s = math.max(0, time() - (tonumber(at) or 0))
	if s < 90 then return s .. " s" end
	if s < 5400 then return math.floor(s / 60 + 0.5) .. " min" end
	return string.format("%.1f h", s / 3600)
end

function M.Command(rest)
	local db = Saved()
	if not db then return end
	if rest == "clear" then
		db.coachTips = {}
		Say("cleared")
		return
	end
	local tips = db.coachTips
	if #tips == 0 then
		Say("no tips yet. The bridge asks the agent every few game events and only speaks up when there is something worth saying.")
		return
	end
	Say(#tips .. " tip(s), newest last:")
	for _, t in ipairs(tips) do
		local first = true
		for line in t.text:gmatch("[^\n]+") do
			print((first and ("  |cff999999" .. Age(t.at) .. " ago|r  ") or "      ") .. line)
			first = false
		end
	end
end
