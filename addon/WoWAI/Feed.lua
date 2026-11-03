-- WoWAI event feed: tells the bridge what happens in the game (quests, zones, level-ups,
-- deaths, where you are walking), so the agent can see your recent history without you
-- typing it. Batches ride the same pixel strip as your messages (flag "e", see
-- docs/EVENTS.md); the bridge writes them to files and never starts an agent for them.
--
-- Everything here only reads game state. Nothing moves, targets, casts or acts for you.
--
-- Batch lines (tab separated, newline between lines):
--   v 1 name realm                        payload version, and which character is playing
--   S t level map x10 y10 cur run zone sub dead xp xpmax   state snapshot (every batch)
--   Q id[*] id[*] ...                     whole quest log, * = ready to turn in
--   E t type args...                      an event
--   P t map x10 y10                       a position sample (x10 = tenths of a percent)
--   D n                                   n lines were dropped to fit
--   H race class faction                  the character (sent when it changes)
--   I slot=itemID ...                     equipped items (sent when they change; an empty line = nothing)
--   R skill=rank/max[/p|/s] ...           skills; /p primary profession, /s secondary (sent when they change)
--   A gen i n spell=rank ...              chunk i of n of the spells learned (a set, sent when it changes)
--   E t taxi secs fromMap fx10 fy10 toMap tx10 ty10   a flight, timed take-off to landing
--   K cont w h                            continent size in yards (docs/DISTANCE.md)
--   W map cont minX maxX minY maxY name   where a map lies on its continent, in ten-thousandths
-- No ack files are used: a batch is shown for HOLD seconds, SHOWS times, and the bridge
-- ignores repeats. Every batch carries a full snapshot, so a missed one costs history
-- only, never the current state.

local M = {}
WoWAIFeed = M
local WoWAI = _G.WoWAI

local unpack = unpack or table.unpack

local HOLD_DEFAULT = 2.0   -- seconds one show of a batch stays on the strip
local SHOWS_DEFAULT = 2    -- how many times a batch is shown
local GAP = 3.0            -- seconds between the shows
local SAMPLE_SECONDS = 10  -- position sample interval while moving
local FLUSH_SAMPLES = 6    -- send a batch when this many samples wait (about a minute)
local DEBOUNCE = 1.5       -- wait this long after an event so a burst goes out as one batch
local HEARTBEAT = 300      -- a batch at least this often, so the bridge knows the feed is alive
local MAX_BYTES = 1200     -- payload size cap; the strip holds about 3200 for everything
local MAX_PENDING = 120    -- event lines kept while waiting
local MAX_SAMPLES = 60
local STALE_OUT = 120      -- give up on a batch the bridge never got a chance to see
local QUEST_DELAY = 1.5
local MOVE_EPS = 0.0004    -- map fraction; smaller moves are not new samples
local ATLAS_PER_BATCH = 8   -- maps described per batch
local ATLAS_BYTES = 760     -- atlas lines only fill what the other head lines leave under this
local ATLAS_QUEUE = 120
local ATLAS_SCALE = 10000
local INFO_FIRST = 1         -- read the character this long after entering the world
local INFO_DEBOUNCE = 3      -- wait this long after gear, skills or spells change
local INFO_HEAD_BYTES = 900 -- character lines only fill what the other head lines leave under this
local SPELLS_PER_CHUNK = 12
local CHUNKS_PER_BATCH = 2
local MAX_SPELLS = 360
local MAX_SKILLS = 24
local TAXI_MIN = 10        -- a flight shorter than this is not reported
local TAXI_LAND_WAIT = 5   -- wait this long for a position after landing
local ZONE = (Enum and Enum.UIMapType and Enum.UIMapType.Zone) or 3
local US = "\31"

local F = {
	pending = {}, samples = {}, turned = {}, atlasQueue = {}, atlasSent = {}, atlasKnown = {}, infoSent = {}, infoPending = {}, spellQueue = {},
	stats = { built = 0, sent = 0, dropped = 0, errors = 0 },
}

---------------------------------------------------------------------------
-- Helpers
---------------------------------------------------------------------------

local function Try(fn, ...)
	if type(fn) ~= "function" then return nil end
	local r = { pcall(fn, ...) }
	if not r[1] then return nil end
	return unpack(r, 2)
end

local function Settings() return WoWAIDB and WoWAIDB.settings end

local function Enabled()
	local s = Settings()
	return s ~= nil and s.feed ~= false and s.mode == "pixel"
end

local function Hold()
	local h = Settings() and Settings().feedHold
	if type(h) == "number" then return math.max(0.5, math.min(10, h)) end
	return HOLD_DEFAULT
end

local function Shows()
	local n = Settings() and Settings().feedShows
	if type(n) == "number" then return math.max(1, math.min(4, math.floor(n))) end
	return SHOWS_DEFAULT
end

-- Cut a string to n bytes without leaving half of a multi-byte character.
local function Clip(s, n)
	if #s <= n then return s end
	s = s:sub(1, n)
	local i = #s
	while i > 0 do
		local b = s:byte(i)
		if b < 0x80 then return s end
		if b >= 0xC0 then
			local need = (b >= 0xF0 and 4) or (b >= 0xE0 and 3) or 2
			if i + need - 1 > #s then return s:sub(1, i - 1) end
			return s
		end
		i = i - 1
	end
	return s
end

local function Clean(s, max)
	s = tostring(s == nil and "" or s)
	s = s:gsub("[%c\30\31`]", " "):gsub("%s+", " ")
	s = s:gsub("^%s+", ""):gsub("%s+$", "")
	return Clip(s, max or 60)
end

local function Now() return time() end

local function Tenths(v) return math.floor(v * 1000 + 0.5) end

local function Speed(v)
	if type(v) == "number" then return string.format("%.1f", v) end
	return ""
end

local function Wire(s) return (tostring(s or ""):gsub("[\30\31]", " ")) end

-- The player's map, x and y (fractions of the map), or nothing (loading, instances).
local function Pos()
	local m = Try(C_Map and C_Map.GetBestMapForUnit, "player")
	if type(m) ~= "number" then return nil end
	local p = Try(C_Map.GetPlayerMapPosition, m, "player")
	if type(p) == "table" and type(p.x) == "number" and type(p.y) == "number" and (p.x > 0 or p.y > 0) then
		return m, p.x, p.y
	end
	return nil
end

local function SortedIds(t)
	local ids = {}
	for id in pairs(t) do ids[#ids + 1] = id end
	table.sort(ids)
	return ids
end

---------------------------------------------------------------------------
-- Collecting
---------------------------------------------------------------------------

local function Event(kind, ...)
	local parts = { "E", tostring(Now()), kind }
	for i = 1, select("#", ...) do parts[#parts + 1] = Clean((select(i, ...))) end
	F.pending[#F.pending + 1] = table.concat(parts, "\t")
	while #F.pending > MAX_PENDING do
		table.remove(F.pending, 1)
		F.stats.dropped = F.stats.dropped + 1
	end
	local at = GetTime() + DEBOUNCE
	if not F.flushAt or at < F.flushAt then F.flushAt = at end
end

local function Sample()
	local m, x, y = Pos()
	if not m then return end
	local l = F.last
	if l and l.m == m and math.abs(l.x - x) < MOVE_EPS and math.abs(l.y - y) < MOVE_EPS then return end
	F.last = { m = m, x = x, y = y }
	F.samples[#F.samples + 1] = table.concat({ "P", Now(), m, Tenths(x), Tenths(y) }, "\t")
	while #F.samples > MAX_SAMPLES do
		table.remove(F.samples, 1)
		F.stats.dropped = F.stats.dropped + 1
	end
end

-- The quest log as { [id] = { title, ready } }.
local function ReadQuests()
	local out = {}
	local n = Try(C_QuestLog and C_QuestLog.GetNumQuestLogEntries) or Try(GetNumQuestLogEntries)
	if type(n) ~= "number" then return out end
	for i = 1, math.min(n, 60) do
		local id, header, complete, title
		local info = Try(C_QuestLog and C_QuestLog.GetInfo, i)
		if type(info) == "table" then
			id, header, title = info.questID, info.isHeader, info.title
			complete = Try(C_QuestLog.IsComplete, id)
		else
			local t, _, _, isHeader, _, isComplete, _, qid = Try(GetQuestLogTitle, i)
			title, header, complete, id = t, isHeader, isComplete == 1 or isComplete == true, qid
		end
		if not header and type(id) == "number" and id > 0 then
			out[id] = { title = Clean(title, 60), ready = complete and true or false }
		end
	end
	return out
end

-- Compare the quest log with the last look and report what changed. The first look
-- only sets the baseline (the whole log goes out in a Q line).
local function CheckQuests()
	local new = ReadQuests()
	local old = F.quests
	F.quests = new
	if not old then F.qline = true; return end
	local changed = false
	for _, id in ipairs(SortedIds(new)) do
		local q, o = new[id], old[id]
		if not o then Event("qaccept", id, q.title); changed = true
		elseif q.ready and not o.ready then Event("qready", id, q.title); changed = true end
	end
	local now = GetTime()
	for _, id in ipairs(SortedIds(old)) do
		if not new[id] then
			changed = true
			local t = F.turned[id]
			if not (t and now - t < 30) then Event("qdrop", id, old[id].title) end
		end
	end
	if changed then F.qline = true end
end

local function Snapshot()
	local m, x, y = Pos()
	local cur, run = Try(GetUnitSpeed, "player")
	return table.concat({
		"S", Now(), Try(UnitLevel, "player") or 0, m or 0,
		x and Tenths(x) or "", y and Tenths(y) or "",
		Speed(cur), Speed(run),
		Clean(Try(GetZoneText), 40), Clean(Try(GetSubZoneText), 40),
		F.dead and 1 or 0, Try(UnitXP, "player") or 0, Try(UnitXPMax, "player") or 0,
		Try(GetMoney) or "",
	}, "\t")
end

local function QLine()
	local parts = { "Q" }
	local q = F.quests or {}
	for _, id in ipairs(SortedIds(q)) do parts[#parts + 1] = id .. (q[id].ready and "*" or "") end
	return table.concat(parts, "\t")
end

---------------------------------------------------------------------------
-- Atlas: where each map lies on its continent (docs/DISTANCE.md)
---------------------------------------------------------------------------

local function AtlasAdd(mapID, cont)
	if type(mapID) ~= "number" or F.atlasSent[mapID] or F.atlasKnown[mapID] then return end
	if #F.atlasQueue >= ATLAS_QUEUE then return end
	F.atlasKnown[mapID] = true
	F.atlasQueue[#F.atlasQueue + 1] = { map = mapID, cont = cont }
end

-- Queue the current map and every zone map of its continent that has not been sent this session.
local function QueueAtlas()
	local m = Try(C_Map and C_Map.GetBestMapForUnit, "player")
	local Map = WoWAIMap
	if type(m) ~= "number" or not Map or not Map.ContinentOf then return end
	local cont = Try(Map.ContinentOf, m)
	if type(cont) ~= "number" then return end
	AtlasAdd(m, cont)
	local kids = Try(C_Map.GetMapChildrenInfo, cont, ZONE, true)
	if type(kids) == "table" then
		for _, info in ipairs(kids) do
			if type(info) == "table" then AtlasAdd(info.mapID, cont) end
		end
	end
	if #F.atlasQueue > 0 then
		local at = GetTime() + DEBOUNCE
		if not F.flushAt or at < F.flushAt then F.flushAt = at end
	end
end

-- The K / W lines for one queued map, or nothing when the client cannot place it.
local function AtlasLines(item)
	local lines = {}
	if not F.atlasSent["k" .. item.cont] then
		local w, h = Try(WoWAIMap.ContinentYards, item.cont)
		if type(w) ~= "number" or type(h) ~= "number" or w < 1 or h < 1 then return nil end
		lines[#lines + 1] = table.concat({ "K", item.cont, math.floor(w + 0.5), math.floor(h + 0.5) }, "\t")
	end
	local minX, maxX, minY, maxY = Try(C_Map.GetMapRectOnMap, item.map, item.cont)
	if type(minX) ~= "number" or type(maxX) ~= "number" or type(minY) ~= "number" or type(maxY) ~= "number"
		or maxX <= minX or maxY <= minY then return nil end
	local info = Try(C_Map.GetMapInfo, item.map)
	local name = type(info) == "table" and info.name or ""
	local function T(v) return math.max(0, math.min(ATLAS_SCALE, math.floor(v * ATLAS_SCALE + 0.5))) end
	lines[#lines + 1] = table.concat({ "W", item.map, item.cont, T(minX), T(maxX), T(minY), T(maxY), Clean(name, 30) }, "\t")
	return lines
end

-- Take queued maps while there is room; returns the lines and marks them sent.
local function DrainAtlas(headSize)
	local out, count = {}, 0
	local size = headSize
	while #F.atlasQueue > 0 and count < ATLAS_PER_BATCH do
		local item = table.remove(F.atlasQueue, 1)
		F.atlasKnown[item.map] = nil
		local lines = AtlasLines(item)
		if lines then
			local add = 0
			for _, l in ipairs(lines) do add = add + #l + 1 end
			if size + add > ATLAS_BYTES and count > 0 then
				table.insert(F.atlasQueue, 1, item)      -- no room now; next batch
				F.atlasKnown[item.map] = true
				break
			end
			if size + add > ATLAS_BYTES and count == 0 and size > ATLAS_BYTES - 80 then
				table.insert(F.atlasQueue, 1, item)      -- the other lines took the room; wait
				F.atlasKnown[item.map] = true
				break
			end
			for _, l in ipairs(lines) do out[#out + 1] = l end
			size = size + add
			count = count + 1
			F.atlasSent[item.map] = true
			F.atlasSent["k" .. item.cont] = true
		end
	end
	return out
end

---------------------------------------------------------------------------
-- The character: race and class, equipped items, skills, spells learned (docs/EVENTS.md).
-- Each part is read when something may have changed and sent only if it differs from what
-- was sent before in this session.
---------------------------------------------------------------------------

local function ReadHero()
	local race = Try(UnitRace, "player")
	local class = Try(UnitClass, "player")
	local faction = Try(UnitFactionGroup, "player")
	if type(race) ~= "string" and type(class) ~= "string" then return nil end
	return table.concat({ "H", Clean(race, 30), Clean(class, 30), Clean(faction, 20) }, "\t")
end

local function ReadGear()
	if type(GetInventoryItemID) ~= "function" then return nil end
	local parts = { "I" }
	for slot = 1, 19 do
		local id = Try(GetInventoryItemID, "player", slot)
		if type(id) == "number" and id > 0 then parts[#parts + 1] = slot .. "=" .. id end
	end
	return table.concat(parts, "\t")
end

local function ReadSkills()
	local n = Try(GetNumSkillLines)
	if type(n) ~= "number" then return nil end
	local parts = { "R" }
	local section
	for i = 1, math.min(n, 80) do
		local name, header, _, rank, _, _, max = Try(GetSkillLineInfo, i)
		if type(name) == "string" and header then
			section = name                                  -- "Professions", "Secondary Skills", "Weapon Skills", ...
		elseif type(name) == "string" and type(rank) == "number" and type(max) == "number" and #parts <= MAX_SKILLS then
			-- /p primary profession, /s secondary profession: from the section the line sits under
			local mark = ""
			if section and section == TRADE_SKILLS then mark = "/p" elseif section and section == SECONDARY_SKILLS then mark = "/s" end
			parts[#parts + 1] = (Clean(name, 30):gsub("[=\t]", " ")) .. "=" .. math.floor(rank) .. "/" .. math.floor(max) .. mark
		end
	end
	return table.concat(parts, "\t")
end

-- The spellbook as "name=rank" entries, the highest rank of each spell once. nil if this client
-- has no spellbook functions.
local function ReadSpells()
	local tabs = Try(GetNumSpellTabs)
	if type(tabs) ~= "number" or (type(GetSpellBookItemName) ~= "function" and type(GetSpellName) ~= "function") then return nil end
	local best, order = {}, {}
	for t = 1, tabs do
		local _, _, offset, count = Try(GetSpellTabInfo, t)
		if type(offset) == "number" and type(count) == "number" then
			for i = offset + 1, offset + count do
				local kind = Try(GetSpellBookItemInfo, i, "spell")
				if kind ~= "FUTURESPELL" and kind ~= "FLYOUT" then
					local name, sub = Try(GetSpellBookItemName, i, "spell")
					if type(name) ~= "string" then name, sub = Try(GetSpellName, i, "spell") end
					if type(name) == "string" and name ~= "" and #order < MAX_SPELLS then
						name = (Clean(name, 40):gsub("[=\t]", " "))
						local rank = tonumber(tostring(sub or ""):match("(%d+)")) or 0
						if best[name] == nil then order[#order + 1] = name; best[name] = rank
						elseif rank > best[name] then best[name] = rank end
					end
				end
			end
		end
	end
	local out = {}
	for _, name in ipairs(order) do out[#out + 1] = best[name] > 0 and (name .. "=" .. best[name]) or name end
	return out
end

local function ArmFlush()
	local at = GetTime() + DEBOUNCE
	if not F.flushAt or at < F.flushAt then F.flushAt = at end
end

local function CheckInfo()
	local sent = F.infoSent
	local function Put(key, line)
		if line and sent[key] ~= line then sent[key] = line; F.infoPending[key] = line end
	end
	Put("H", ReadHero()); Put("I", ReadGear()); Put("R", ReadSkills())
	local spells = ReadSpells()
	if spells then
		local sig = table.concat(spells, "\t")
		if sent.A ~= sig then
			sent.A = sig
			F.spellGen = math.max(Now(), (F.spellGen or 0) + 1)
			F.spellQueue = {}                                     -- a set not yet sent is out of date
			local n = math.max(1, math.ceil(#spells / SPELLS_PER_CHUNK))
			for i = 1, n do
				local part = {}
				for k = (i - 1) * SPELLS_PER_CHUNK + 1, math.min(i * SPELLS_PER_CHUNK, #spells) do part[#part + 1] = spells[k] end
				F.spellQueue[#F.spellQueue + 1] = "A\t" .. F.spellGen .. "\t" .. i .. "\t" .. n .. "\t" .. table.concat(part, "\t")
			end
		end
	end
	if next(F.infoPending) or #F.spellQueue > 0 then ArmFlush() end
end

---------------------------------------------------------------------------
-- Flights (docs/DISTANCE.md): UnitOnTaxi is true from take-off to landing. A ride is
-- reported once, from the spot you stood on just before take-off to the first spot
-- after landing, so the bridge can learn how long that route takes.
---------------------------------------------------------------------------

local function CheckTaxi(now)
	local on = Try(UnitOnTaxi, "player")
	if on == nil then return end
	if on then
		if not F.flying then
			F.flying = true
			local g = F.ground
			F.ride = (g and now - g.t <= 5) and { at = now, from = g } or nil   -- no known start: not reported
		end
		return
	end
	if F.flying then
		F.flying = false
		if F.ride then F.ride.landedAt = now; F.landing = F.ride end
		F.ride = nil
	end
	local m, x, y = Pos()
	local r = F.landing
	if r then
		if m then
			F.landing = nil
			local secs = math.floor(r.landedAt - r.at + 0.5)
			if secs >= TAXI_MIN then
				Event("taxi", secs, r.from.m, Tenths(r.from.x), Tenths(r.from.y), m, Tenths(x), Tenths(y))
			end
		elseif now - r.landedAt > TAXI_LAND_WAIT then
			F.landing = nil
		end
	end
	if m then F.ground = { m = m, x = x, y = y, t = now } end
end

---------------------------------------------------------------------------
-- Sending
---------------------------------------------------------------------------

-- Turn what has been collected into one batch, waiting to be shown.
local function Build()
	local db = WoWAIDB
	local now = GetTime()
	-- Who is playing, so the bridge keeps each character's files apart (docs/EVENTS.md).
	local who = Clean(Try(UnitName, "player"), 40)
	local realm = Clean(Try(GetRealmName), 40)
	local head = { who ~= "" and ("v\t1\t" .. who .. "\t" .. realm) or "v\t1", Snapshot() }
	if F.qline and F.quests then
		head[#head + 1] = QLine()
		F.qline = false
	end
	do
		local headSize = 0
		for _, l in ipairs(head) do headSize = headSize + #l + 1 end
		local function Take(line)
			if headSize + #line + 1 > INFO_HEAD_BYTES then return false end
			head[#head + 1] = line
			headSize = headSize + #line + 1
			return true
		end
		for _, key in ipairs({ "H", "I", "R" }) do
			local line = F.infoPending[key]
			if line and Take(line) then F.infoPending[key] = nil end
		end
		for _ = 1, CHUNKS_PER_BATCH do
			if #F.spellQueue > 0 and Take(F.spellQueue[1]) then table.remove(F.spellQueue, 1) end
		end
		for _, l in ipairs(DrainAtlas(headSize)) do head[#head + 1] = l end
		if #F.atlasQueue > 0 or next(F.infoPending) or #F.spellQueue > 0 then ArmFlush() end
	end
	local ev, sm = F.pending, F.samples
	local function size()
		local n = 12
		for _, l in ipairs(head) do n = n + #l + 1 end
		for _, l in ipairs(ev) do n = n + #l + 1 end
		for _, l in ipairs(sm) do n = n + #l + 1 end
		return n
	end
	local dropped = 0
	while size() > MAX_BYTES and (#sm > 0 or #ev > 0) do
		if #sm > 0 then table.remove(sm, 1) else table.remove(ev, 1) end
		dropped = dropped + 1
	end
	local lines = {}
	for _, l in ipairs(head) do lines[#lines + 1] = l end
	if dropped > 0 then
		lines[#lines + 1] = "D\t" .. dropped
		F.stats.dropped = F.stats.dropped + dropped
	end
	for _, l in ipairs(ev) do lines[#lines + 1] = l end
	for _, l in ipairs(sm) do lines[#lines + 1] = l end
	local payload = table.concat(lines, "\n")
	db.feedSeq = (db.feedSeq or 0) + 1
	-- session, chat, id, cwd, flags, name, text: the strip record layout (WoWAI.lua RecordFor)
	local wire = table.concat({ Wire(db.session), "", tostring(db.feedSeq), "", "e", "", payload }, US)
	F.out = { seq = db.feedSeq, wire = wire, shows = 0, nextAt = now, createdAt = now, bytes = #payload }
	F.pending, F.samples, F.flushAt = {}, {}, nil
	if #F.atlasQueue > 0 or next(F.infoPending) or #F.spellQueue > 0 then F.flushAt = now + DEBOUNCE end
	F.lastBuild = now
	F.stats.built = F.stats.built + 1
end

-- Called by WoWAI.RefreshStrip: the record to draw right now, if a batch is on show.
function WoWAI.FeedRecord()
	local o = F.out
	if o and o.showing then return { id = o.seq, text = o.wire } end
	return nil
end

function M.Tick()
	if not Enabled() then return end
	local now = GetTime()
	local o = F.out
	if o and o.showing and now >= o.hideAt then
		o.showing = false
		o.shows = o.shows + 1
		if o.shows >= Shows() then
			F.out = nil
			F.stats.sent = F.stats.sent + 1
		else
			o.nextAt = now + GAP
		end
		WoWAI.RefreshStrip()
	end
	if F.questCheckAt and now >= F.questCheckAt then
		F.questCheckAt = nil
		CheckQuests()
	end
	CheckTaxi(now)
	if F.infoAt and now >= F.infoAt then
		F.infoAt = nil
		CheckInfo()
	end
	if now >= (F.nextSample or 0) then
		F.nextSample = now + SAMPLE_SECONDS
		Sample()
	end
	o = F.out
	if o and not o.showing and now - o.createdAt > STALE_OUT then
		F.out = nil
		F.stats.dropped = F.stats.dropped + 1
	end
	if not F.out then
		if now - (F.lastBuild or now) >= HEARTBEAT and #F.pending == 0 then Event("tick") end
		local due = (F.flushAt and now >= F.flushAt) or #F.samples >= FLUSH_SAMPLES
		if due and (#F.pending > 0 or #F.samples > 0 or #F.atlasQueue > 0 or next(F.infoPending) or #F.spellQueue > 0) then Build() end
	end
	o = F.out
	if o and not o.showing and o.shows < Shows() and now >= o.nextAt and WoWAI.IsConnected() then
		o.showing = true
		o.hideAt = now + Hold()
		WoWAI.RefreshStrip()
	end
end

---------------------------------------------------------------------------
-- Game events
---------------------------------------------------------------------------

function M.OnEvent(event, a1, a2)
	if not WoWAIDB or not Enabled() then return end
	if event == "PLAYER_ENTERING_WORLD" then
		if not F.started then
			F.started = true
			F.lastBuild = GetTime()
			F.infoSent = {}                                    -- a new session sends the character again
			C_Timer.NewTicker(1, function()
				local ok, err = pcall(M.Tick)
				if not ok then F.stats.errors = F.stats.errors + 1; F.lastError = tostring(err) end
			end)
		end
		if a1 or a2 then Event("login", a1 and "initial" or "reload") end
		F.questCheckAt = GetTime() + 3
		F.flying, F.ride, F.landing, F.ground = false, nil, nil, nil
		F.infoAt = F.infoAt or (GetTime() + INFO_FIRST)   -- soon enough to ride in the login batch
		F.zone, F.sub = Try(GetZoneText), Try(GetSubZoneText)
		QueueAtlas()
	elseif event == "ZONE_CHANGED_NEW_AREA" then
		local zone = Try(GetZoneText) or ""
		local m = Try(C_Map and C_Map.GetBestMapForUnit, "player")
		if zone ~= F.zone then Event("zone", m or "", zone) end
		F.zone = zone
		F.sub = Try(GetSubZoneText)
		QueueAtlas()
	elseif event == "ZONE_CHANGED" or event == "ZONE_CHANGED_INDOORS" then
		local sub = Try(GetSubZoneText) or ""
		if sub ~= "" and sub ~= F.sub then Event("sub", sub) end
		F.sub = sub
	elseif event == "PLAYER_LEVEL_UP" then
		Event("level", a1 or Try(UnitLevel, "player") or "")
		F.infoAt = F.infoAt or (GetTime() + INFO_DEBOUNCE)
	elseif event == "PLAYER_EQUIPMENT_CHANGED" or event == "SPELLS_CHANGED" or event == "LEARNED_SPELL_IN_TAB" or event == "SKILL_LINES_CHANGED" then
		F.infoAt = F.infoAt or (GetTime() + INFO_DEBOUNCE)
	elseif event == "PLAYER_DEAD" then
		F.dead = true
		Event("dead")
	elseif event == "PLAYER_ALIVE" or event == "PLAYER_UNGHOST" then
		if F.dead and not Try(UnitIsDeadOrGhost, "player") then
			F.dead = false
			Event("alive")
		end
	elseif event == "QUEST_LOG_UPDATE" then
		if not F.questCheckAt then F.questCheckAt = GetTime() + QUEST_DELAY end
	elseif event == "QUEST_TURNED_IN" then
		if type(a1) == "number" then
			F.turned[a1] = GetTime()
			Event("qdone", a1, F.quests and F.quests[a1] and F.quests[a1].title or "")
			F.qline = true
			if not F.questCheckAt then F.questCheckAt = GetTime() + QUEST_DELAY end
		end
	end
end

local GAME_EVENTS = {
	"PLAYER_ENTERING_WORLD", "ZONE_CHANGED_NEW_AREA", "ZONE_CHANGED", "ZONE_CHANGED_INDOORS",
	"PLAYER_LEVEL_UP", "PLAYER_DEAD", "PLAYER_ALIVE", "PLAYER_UNGHOST", "QUEST_LOG_UPDATE", "QUEST_TURNED_IN",
	"PLAYER_EQUIPMENT_CHANGED", "SPELLS_CHANGED", "LEARNED_SPELL_IN_TAB", "SKILL_LINES_CHANGED",
}

local frame = CreateFrame("Frame")
-- An event name the client doesn't know raises an error; skip it instead of breaking the addon.
for _, name in ipairs(GAME_EVENTS) do pcall(function() frame:RegisterEvent(name) end) end
frame:SetScript("OnEvent", function(_, event, a1, a2)
	local ok, err = pcall(M.OnEvent, event, a1, a2)
	if not ok then F.stats.errors = F.stats.errors + 1; F.lastError = tostring(err) end
end)

---------------------------------------------------------------------------
-- /wow-ai feed
---------------------------------------------------------------------------

function M.Status()
	local s = Settings() or {}
	return {
		enabled = Enabled(), built = F.stats.built, sent = F.stats.sent, dropped = F.stats.dropped, errors = F.stats.errors,
		pending = #F.pending, samples = #F.samples, seq = WoWAIDB and WoWAIDB.feedSeq or 0, lastError = F.lastError,
		hold = Hold(), shows = Shows(), showing = F.out ~= nil and F.out.showing or false, waiting = F.out ~= nil,
		atlasQueued = #F.atlasQueue, infoQueued = #F.spellQueue + (next(F.infoPending) and 1 or 0),
	}
end

function M.Command(rest)
	local s = Settings()
	if not s then return end
	rest = tostring(rest or ""):lower()
	local say = function(msg) print("|cff66ccff[WoW AI]|r " .. msg) end
	local arg, val = rest:match("^(%a+)%s+([%d%.]+)$")
	if rest == "on" or rest == "off" then
		s.feed = rest == "on"
		say("event feed " .. rest)
	elseif rest == "info" then
		F.infoSent = {}
		F.infoAt = GetTime()
		say("character, gear, skills and spells will be sent again")
	elseif rest == "atlas" then
		F.atlasSent, F.atlasKnown, F.atlasQueue = {}, {}, {}
		QueueAtlas()
		say(string.format("map atlas: %d map(s) queued for the bridge", #F.atlasQueue))
	elseif arg == "hold" and tonumber(val) then
		s.feedHold = tonumber(val)
		say("each batch stays on the strip " .. Hold() .. " s per show")
	elseif arg == "shows" and tonumber(val) then
		s.feedShows = tonumber(val)
		say("each batch is shown " .. Shows() .. " time(s)")
	else
		local st = M.Status()
		say(string.format("event feed %s: %d batch(es) built, %d fully shown, %d line(s) dropped, %d waiting (%d position samples), last number %d%s",
			st.enabled and "ON" or "OFF", st.built, st.sent, st.dropped, st.pending, st.samples, st.seq,
			st.errors > 0 and (", " .. st.errors .. " error(s): " .. tostring(st.lastError)) or ""))
		say(string.format("shows: %d x %.1f s. /wow-ai feed on|off|atlas|info, /wow-ai feed hold <seconds>, /wow-ai feed shows <n>", st.shows, st.hold))
	end
end
