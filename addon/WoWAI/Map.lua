-- WoWAI map: layers the agent draws (routes, quest stops, marks), synced from the
-- bridge, plus herb and ore locations from the optional WoWAI_Nodes addon.
--
-- Layers arrive in slot files as { epoch, version, layers = { { name, title,
-- ordered, loop, points = { { uiMapID, x, y, label, kind }, ... } } } }; x/y are
-- map percent. The bridge owns them; a newer version (or another epoch) replaces
-- our copy wholesale. Everything here reads positions and draws; nothing moves,
-- targets or acts for the player.

local ADDON_NAME = ...
local M = {}
WoWAIMap = M

local NODE_SIZE, PIN_SIZE = 9, 16
local CIRCLE = "Interface\\CHARACTERFRAME\\TempPortraitAlphaMask"
local CONTINENT = (Enum and Enum.UIMapType and Enum.UIMapType.Continent) or 2

local KIND_COLOR = {
	ore = { 0.95, 0.6, 0.25 }, herb = { 0.35, 0.95, 0.35 }, quest = { 1, 0.85, 0 }, turnin = { 0.35, 0.8, 1 },
	kill = { 1, 0.3, 0.3 }, loot = { 1, 0.5, 0.85 }, object = { 0.8, 0.6, 1 }, explore = { 0.5, 1, 1 },
	npc = { 1, 1, 1 }, trainer = { 0.95, 0.95, 0.4 }, vendor = { 0.6, 0.95, 0.6 }, dungeon = { 1, 0.45, 0.1 },
	flight = { 0.55, 0.75, 1 }, poi = { 1, 1, 1 },
}

local mdb -- WoWAIMapDB: { map, hidden = { [layer] = true }, nodes = { ore, herb, filter } }

local function Try(fn, ...)
	if type(fn) ~= "function" then return nil end
	local ok, a, b, c, d = pcall(fn, ...)
	if ok then return a, b, c, d end
end

local function Print(msg)
	print("|cff66ccff[WoW AI map]|r " .. msg)
end

local function DB()
	if not mdb then
		WoWAIMapDB = WoWAIMapDB or {}
		mdb = WoWAIMapDB
		mdb.hidden = mdb.hidden or {}
		mdb.nodes = mdb.nodes or { ore = false, herb = false, filter = "skill" }
	end
	return mdb
end

local function Layers()
	local m = DB().map
	return m and m.layers or {}
end

local function FindLayer(name)
	for i, l in ipairs(Layers()) do
		if l.name == name then return l, i end
	end
end

---------------------------------------------------------------------------
-- Map geometry (C_Map only; results cached)
---------------------------------------------------------------------------

local continentOf = {}
local function ContinentOf(mapID)
	if continentOf[mapID] ~= nil then return continentOf[mapID] or nil end
	local id, guard = mapID, 0
	while id and id > 0 and guard < 10 do
		local info = Try(C_Map.GetMapInfo, id)
		if type(info) ~= "table" then break end
		if info.mapType == CONTINENT then continentOf[mapID] = id; return id end
		id, guard = info.parentMapID, guard + 1
	end
	continentOf[mapID] = false
end

-- Where mapID's (x, y) (0-1) falls on `target` (0-1), or nil if it doesn't.
local function Project(mapID, x, y, target)
	if mapID == target then return x, y end
	local minX, maxX, minY, maxY = Try(C_Map.GetMapRectOnMap, mapID, target)
	if type(minX) == "number" and maxX ~= minX and maxY ~= minY then
		return minX + (maxX - minX) * x, minY + (maxY - minY) * y
	end
	-- `target` sits inside mapID (a city map shown while the point is on its zone).
	minX, maxX, minY, maxY = Try(C_Map.GetMapRectOnMap, target, mapID)
	if type(minX) == "number" and maxX ~= minX and maxY ~= minY then
		return (x - minX) / (maxX - minX), (y - minY) / (maxY - minY)
	end
end

-- Continent-space size in yards, measured from the engine's own map->world transform.
local continentSize = {}
local function ContinentYards(cont)
	if continentSize[cont] then return continentSize[cont][1], continentSize[cont][2] end
	local w, h
	if C_Map.GetWorldPosFromMapPos and CreateVector2D then
		local _, a = Try(C_Map.GetWorldPosFromMapPos, cont, CreateVector2D(0, 0))
		local _, b = Try(C_Map.GetWorldPosFromMapPos, cont, CreateVector2D(1, 0))
		local _, c = Try(C_Map.GetWorldPosFromMapPos, cont, CreateVector2D(0, 1))
		if a and b and c then
			w = math.sqrt((b.x - a.x) ^ 2 + (b.y - a.y) ^ 2)
			h = math.sqrt((c.x - a.x) ^ 2 + (c.y - a.y) ^ 2)
		end
	end
	if not (w and h and w > 0 and h > 0) then
		local ww, hh = Try(C_Map.GetMapWorldSize, cont)
		w, h = ww, hh
	end
	if w and h and w > 0 and h > 0 then continentSize[cont] = { w, h } end
	return w, h
end

-- Used by Feed.lua to describe where each map lies on its continent (docs/DISTANCE.md).
M.ContinentOf, M.ContinentYards = ContinentOf, ContinentYards

local atan2 = math.atan2 or math.atan -- Lua 5.1 in game; 5.3 in the test VM

-- The player's position as (continent, cx, cy) in continent map space.
local function PlayerOnContinent()
	local mapID = Try(C_Map.GetBestMapForUnit, "player")
	if not mapID then return end
	local pos = Try(C_Map.GetPlayerMapPosition, mapID, "player")
	if not pos then return end
	local px, py = pos.x, pos.y
	if not px or (px == 0 and py == 0) then return end
	local cont = ContinentOf(mapID)
	if not cont then return end
	local cx, cy = Project(mapID, px, py, cont)
	if cx then return cont, cx, cy end
end

-- Yards and bearing (radians, counter-clockwise from north) from the player to a point (map id, x and y in map percent), or nil and the
-- reason as text. Used by the route arrow (Route.lua).
function M.Heading(m, x, y)
	local cont, px, py = PlayerOnContinent()
	if not cont then return nil, "no position here" end
	if ContinentOf(m) ~= cont then return nil, "on another continent" end
	local tx, ty = Project(m, x / 100, y / 100, cont)
	if not tx then return nil, "cannot place this point" end
	local w, h = ContinentYards(cont)
	local east, south = (tx - px) * (w or 1), (ty - py) * (h or 1)
	local dist = w and math.sqrt(east * east + south * south) or nil
	return dist, atan2(-east, -south)
end

---------------------------------------------------------------------------
-- World map drawing
---------------------------------------------------------------------------

local overlay
local pins, pinCount = {}, 0
local lines, lineCount = {}, 0
local nodePins, nodeCount = {}, 0
local routePins, routeCount = {}, 0
local ROUTE_SIZE = 14
local ROUTE_R, SPOT_R = 15, 20 -- px: half a marker with its edge; the clear space kept around a real spot, where the game draws its own icon
local ROUTE_LEAD = { 1, 1, 1 }
local ROUTE_COLOR = { quest = { 0.9, 0.3, 1 }, travel = { 0.2, 0.9, 1 } } -- violet diamonds for quest steps, cyan for travel: not the round yellow/blue game icons

local function ShowTip(self)
	if not self.info then return end
	GameTooltip:SetOwner(self, "ANCHOR_RIGHT")
	GameTooltip:AddLine(self.info.title or "Map", 0.4, 0.8, 1)
	GameTooltip:AddLine(self.info.label or "", 1, 1, 1, true)
	if self.info.hint then GameTooltip:AddLine(self.info.hint, 0.6, 0.6, 0.6) end
	GameTooltip:Show()
end

local function NewPin(size)
	local b = CreateFrame("Button", nil, overlay)
	b:SetSize(size, size)
	b.dot = b:CreateTexture(nil, "OVERLAY")
	b.dot:SetAllPoints()
	b.dot:SetTexture(CIRCLE)
	b.ring = b:CreateTexture(nil, "ARTWORK")
	b.ring:SetPoint("CENTER")
	b.ring:SetSize(size + 4, size + 4)
	b.ring:SetTexture(CIRCLE)
	b.ring:SetVertexColor(0, 0, 0, 0.85)
	b.num = b:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	b.num:SetPoint("CENTER", 0, 0)
	b.num:SetTextColor(0, 0, 0)
	b:SetScript("OnEnter", ShowTip)
	b:SetScript("OnLeave", function() GameTooltip:Hide() end)
	return b
end

-- A route step marker: a numbered diamond with a dark edge, unlike the round pins of the layers and the game's own quest icons.
local function NewRoutePin()
	local b = CreateFrame("Button", nil, overlay)
	b:SetSize(ROUTE_SIZE, ROUTE_SIZE)
	b.edge = b:CreateTexture(nil, "ARTWORK")
	b.edge:SetPoint("CENTER")
	b.edge:SetSize(ROUTE_SIZE + 5, ROUTE_SIZE + 5)
	b.edge:SetColorTexture(0, 0, 0, 0.9)
	b.edge:SetRotation(math.pi / 4)
	b.fill = b:CreateTexture(nil, "OVERLAY")
	b.fill:SetPoint("CENTER")
	b.fill:SetSize(ROUTE_SIZE, ROUTE_SIZE)
	b.fill:SetRotation(math.pi / 4)
	-- Bold numbers: the game's number font if it has one, with a thick outline.
	b.num = b:CreateFontString(nil, "OVERLAY", _G.NumberFontNormal and "NumberFontNormal" or "GameFontNormalSmall")
	b.num:SetPoint("CENTER", 0, 0)
	b.num:SetTextColor(1, 1, 1)
	local file, size = Try(b.num.GetFont, b.num)
	if type(file) == "string" then Try(b.num.SetFont, b.num, file, math.max(11, tonumber(size) or 12), "THICKOUTLINE") end
	if b.SetMouseClickEnabled then b:SetMouseClickEnabled(false) end -- hover shows the tooltip; clicks go to the map
	b:SetScript("OnEnter", ShowTip)
	b:SetScript("OnLeave", function() GameTooltip:Hide() end)
	b.info = {}
	return b
end

local function Place(frame, x, y, scale)
	local w, h = overlay:GetWidth(), overlay:GetHeight()
	frame:SetScale(scale)
	frame:ClearAllPoints()
	frame:SetPoint("CENTER", overlay, "TOPLEFT", x * w / scale, -y * h / scale)
	frame:Show()
end

local function CanvasScale()
	local s = WorldMapFrame and WorldMapFrame.GetCanvasScale and Try(WorldMapFrame.GetCanvasScale, WorldMapFrame)
	return (type(s) == "number" and s > 0) and s or 1
end

local function AddLine(x1, y1, x2, y2, color, thickness)
	lineCount = lineCount + 1
	local l = lines[lineCount]
	if not l then
		l = overlay:CreateLine(nil, "ARTWORK")
		lines[lineCount] = l
	end
	local w, h = overlay:GetWidth(), overlay:GetHeight()
	l:SetThickness(thickness)
	l:SetColorTexture(color[1], color[2], color[3], 0.75)
	l:SetStartPoint("TOPLEFT", overlay, x1 * w, -y1 * h)
	l:SetEndPoint("TOPLEFT", overlay, x2 * w, -y2 * h)
	l:Show()
end

-- Skill of a profession (Mining 186, Herbalism 182), or nil if not learned.
local SKILL_IDS = { mining = 186, herbalism = 182 }
local SKILL_NAMES = { mining = MINING or "Mining", herbalism = HERBALISM or "Herbalism" }
local function SkillRank(prof)
	local lines = WoWAI and WoWAI.SkillLines and WoWAI.SkillLines() or {}
	for _, sk in ipairs(lines) do
		if not sk.isHeader and (sk.skillID == SKILL_IDS[prof] or sk.name == SKILL_NAMES[prof]) then return sk.rank end
	end
end

local function NodeFilter()
	local f = DB().nodes
	local want = {}
	if f.ore then want.mining = SkillRank("mining") or false end
	if f.herb then want.herbalism = SkillRank("herbalism") or false end
	return want, f.filter
end

local function DrawNodes(mapID, scale)
	local data = WoWAINodes
	local want, filter = NodeFilter()
	if not data or not next(want) then return end
	local perMap = data.maps and data.maps[mapID]
	if not perMap then return end
	for i, packed in pairs(perMap) do
		local kind = data.kinds[i]
		local prof = kind and kind[2]
		local rank = prof and want[prof]
		local show = rank ~= nil and (filter == "all" or rank == false or kind[3] <= rank)
		if show then
			local color = prof == "mining" and KIND_COLOR.ore or KIND_COLOR.herb
			for j = 1, #packed - 5, 6 do
				local x = tonumber(packed:sub(j, j + 2)) / 1000
				local y = tonumber(packed:sub(j + 3, j + 5)) / 1000
				nodeCount = nodeCount + 1
				local b = nodePins[nodeCount]
				if not b then
					b = NewPin(NODE_SIZE)
					b.ring:SetSize(NODE_SIZE + 2, NODE_SIZE + 2)
					-- Hover shows the tooltip; clicks and drags go through to the map (pan, zoom).
					if b.SetMouseClickEnabled then b:SetMouseClickEnabled(false) end
					b.info = {}
					nodePins[nodeCount] = b
				end
				b.dot:SetVertexColor(color[1], color[2], color[3], 0.9)
				b.num:SetText("")
				local info = b.info
				info.title = kind[1]
				info.label = (prof == "mining" and "Mining " or "Herbalism ") .. kind[3]
				info.hint = rank == false and "You don't have this profession" or nil
				info.layer = nil
				Place(b, x, y, scale)
			end
		end
	end
end

-- The planner's route (Route.lua): the current step and the next ones, joined by a line. Steps at one place share a marker. A marker never
-- sits on the real spot (the game's own quest icon is there), on another marker, or on a layer's pin: it is moved to the nearest free place
-- around the spot and a thin line joins it to the spot. Sizes and distances are in screen pixels.
local function DrawRoute(mapID, occupied)
	local R = WoWAIRoute
	local steps = R and R.MapSteps and R.MapSteps() or {}
	if #steps == 0 then return end
	local cs = CanvasScale()
	local W, H = overlay:GetWidth(), overlay:GetHeight()
	local w, h = W * cs, H * cs
	-- 1. where the steps really are; steps within a marker's width of each other share it
	local groups, broken = {}, false
	for _, st in ipairs(steps) do
		local x, y = Project(st.m, st.x / 100, st.y / 100, mapID)
		if x and x >= 0 and x <= 1 and y >= 0 and y <= 1 then
			local g = groups[#groups]
			if g and not broken and math.abs(g.px - x * w) < ROUTE_R and math.abs(g.py - y * h) < ROUTE_R then
				g.steps[#g.steps + 1] = st
			else
				groups[#groups + 1] = { x = x, y = y, px = x * w, py = y * h, steps = { st }, gap = broken }
			end
			broken = false
		else
			broken = true
		end
	end
	-- 2. a free place for each marker
	local ANGLES = { 45, 135, -45, -135, 90, 0, 180, -90, 22, 68, 112, 158, -22, -68, -112, -158 }
	local prev
	for gi, g in ipairs(groups) do
		local first = g.steps[1]
		local big = first.current and 1.35 or 1
		local r = ROUTE_R * big
		local best
		for ring = 1, 4 do
			local d = SPOT_R + r + (ring - 1) * r * 1.5
			for _, a in ipairs(ANGLES) do
				local cx, cy = g.px + d * math.cos(math.rad(a)), g.py - d * math.sin(math.rad(a))
				local free = cx - r >= 0 and cy - r >= 0 and cx + r <= w and cy + r <= h
				for _, o in ipairs(occupied) do
					if free and (cx - o[1]) ^ 2 + (cy - o[2]) ^ 2 < (r + o[3] + 2) ^ 2 then free = false end
				end
				for gj, o in ipairs(groups) do -- nor on another step's real spot
					if free and gj ~= gi and (cx - o.px) ^ 2 + (cy - o.py) ^ 2 < (r + SPOT_R * 0.6) ^ 2 then free = false end
				end
				if free then best = { cx, cy }; break end
			end
			if best then break end
		end
		best = best or { g.px + (SPOT_R + r) * 0.7, g.py - (SPOT_R + r) * 0.7 }
		occupied[#occupied + 1] = { best[1], best[2], r }
		routeCount = routeCount + 1
		local b = routePins[routeCount]
		if not b then b = NewRoutePin(); routePins[routeCount] = b end
		local c = first.travel and ROUTE_COLOR.travel or ROUTE_COLOR.quest
		b.fill:SetColorTexture(c[1], c[2], c[3], 1)
		b.num:SetText(tostring(first.i))
		b:SetFrameLevel(overlay:GetFrameLevel() + 20)
		local lines, nums = {}, {}
		for _, st in ipairs(g.steps) do lines[#lines + 1] = st.i .. ". " .. st.t; nums[#nums + 1] = st.i end
		b.info.title = "Route step " .. table.concat(nums, ", ") .. (first.current and " (now)" or "")
		b.info.label = table.concat(lines, "\n")
		b.info.hint = nil
		g.mx, g.my = best[1], best[2]
		local fscale = big / cs
		b:SetScale(fscale)
		b:ClearAllPoints()
		b:SetPoint("CENTER", overlay, "TOPLEFT", g.mx / (cs * fscale), -g.my / (cs * fscale))
		b:Show()
		AddLine(g.px / w, g.py / h, g.mx / w, g.my / h, ROUTE_LEAD, 1.2 / cs) -- from the real spot to its marker
		if prev and not g.gap then AddLine(prev.mx / w, prev.my / h, g.mx / w, g.my / h, ROUTE_COLOR.quest, 1.5 / cs) end
		prev = g
	end
end

function M.Refresh()
	if not overlay or not WorldMapFrame:IsShown() then return end
	for i = 1, pinCount do pins[i]:Hide() end
	for i = 1, lineCount do lines[i]:Hide() end
	for i = 1, nodeCount do nodePins[i]:Hide() end
	for i = 1, routeCount do routePins[i]:Hide() end
	pinCount, lineCount, nodeCount, routeCount = 0, 0, 0, 0
	local mapID = WorldMapFrame:GetMapID()
	if not mapID then return end
	local scale = 1 / CanvasScale()
	overlay.drawnScale = CanvasScale()
	DrawNodes(mapID, scale)
	local occupied = {} -- screen-pixel circles { x, y, radius } the route markers keep clear of
	local cs, ow, oh = CanvasScale(), overlay:GetWidth(), overlay:GetHeight()
	for _, l in ipairs(Layers()) do
		if not mdb.hidden[l.name] then
			local prev, first
			for i, p in ipairs(l.points) do
				local x, y = Project(p[1], p[2] / 100, p[3] / 100, mapID)
				local inside = x and x >= 0 and x <= 1 and y >= 0 and y <= 1
				if inside then
					local color = KIND_COLOR[p[5]] or KIND_COLOR.poi
					if l.ordered and prev then AddLine(prev[1], prev[2], x, y, color, 2.5 * scale) end
					pinCount = pinCount + 1
					local b = pins[pinCount]
					if not b then b = NewPin(PIN_SIZE); pins[pinCount] = b end
					b.dot:SetVertexColor(color[1], color[2], color[3], 1)
					b.ring:SetVertexColor(0, 0, 0, 0.9)
					b.num:SetText(l.ordered and tostring(i) or "")
					b:SetFrameLevel(overlay:GetFrameLevel() + 10)
					b.info = { title = l.title, label = p[4] ~= "" and p[4] or l.name, }
					Place(b, x, y, scale)
					occupied[#occupied + 1] = { x * ow * cs, y * oh * cs, PIN_SIZE / 2 + 3 }
					prev = { x, y }
					first = first or { x, y, color }
				else
					prev = nil
				end
			end
			-- A loop closes back to its first stop.
			if l.loop and l.ordered and prev and first and #l.points > 2 then
				AddLine(prev[1], prev[2], first[1], first[2], first[3], 2.5 * scale)
			end
		end
	end
	DrawRoute(mapID, occupied)
end

local function SetupWorldMap()
	if overlay or not WorldMapFrame or not WorldMapFrame.GetCanvas then return end
	local canvas = WorldMapFrame:GetCanvas()
	overlay = CreateFrame("Frame", nil, canvas)
	overlay:SetAllPoints(canvas)
	overlay:SetFrameLevel(canvas:GetFrameLevel() + 2000)
	hooksecurefunc(WorldMapFrame, "OnMapChanged", M.Refresh)
	WorldMapFrame:HookScript("OnShow", M.Refresh)
	-- Keep pins the same size on screen while zooming.
	overlay:SetScript("OnUpdate", function(self, elapsed)
		self.t = (self.t or 0) + elapsed
		if self.t < 0.1 then return end
		self.t = 0
		if math.abs(CanvasScale() - (self.drawnScale or 0)) > 0.01 then M.Refresh() end
	end)
end

---------------------------------------------------------------------------
-- Sync from the bridge
---------------------------------------------------------------------------

local function LayerKey(l)
	local parts = { l.title or "", tostring(l.ordered), tostring(l.loop), #(l.points or {}) }
	for _, p in ipairs(l.points or {}) do parts[#parts + 1] = table.concat({ p[1], p[2], p[3], p[4] }, ",") end
	return table.concat(parts, ";")
end

function M.Sync(m)
	if type(m) ~= "table" or type(m.layers) ~= "table" then return end
	local cur = DB().map
	if cur and cur.epoch == m.epoch and (tonumber(m.version) or 0) <= (tonumber(cur.version) or 0) then return end
	local old = {}
	for _, l in ipairs(cur and cur.layers or {}) do old[l.name] = LayerKey(l) end
	local layers, changed = {}, {}
	for _, l in ipairs(m.layers) do
		if type(l) == "table" and type(l.name) == "string" and type(l.points) == "table" then
			layers[#layers + 1] = l
			if old[l.name] ~= LayerKey(l) then changed[#changed + 1] = l end
		end
	end
	mdb.map = { epoch = m.epoch, version = tonumber(m.version) or 0, layers = layers }
	for _, l in ipairs(changed) do
		mdb.hidden[l.name] = nil
		Print(string.format("%s: %d point(s)%s. Open the map (M) to see it.", l.title or l.name, #l.points, l.ordered and ", route" or ""))
	end
	M.Refresh()
end

---------------------------------------------------------------------------
-- /wow-ai map (and /aimap)
---------------------------------------------------------------------------

local function Status()
	local layers = Layers()
	if #layers == 0 then Print("no layers yet. Ask the agent for a route, e.g. /ai route me through copper veins in Loch Modan") end
	for _, l in ipairs(layers) do
		Print(string.format("%s%s|r  %s (%d point(s))", mdb.hidden[l.name] and "|cff888888" or "|cffffffff", l.name, l.title or "", #l.points))
	end
	local n = mdb.nodes
	Print(string.format("nodes: ore %s, herb %s, filter %s%s", n.ore and "on" or "off", n.herb and "on" or "off", n.filter, WoWAINodes and "" or "  (WoWAI_Nodes data addon not installed)"))
	Print("commands: /wow-ai map ore|herb [on|off], filter all|skill, show|hide <layer>  (/aimap is the same)")
end

function M.Command(msg)
	DB()
	local cmd, rest = (msg or ""):match("^%s*(%S*)%s*(.-)%s*$")
	cmd = (cmd or ""):lower()
	if cmd == "" then Status()
	elseif cmd == "ore" or cmd == "herb" then
		local v = rest:lower()
		mdb.nodes[cmd] = (v == "on") or (v ~= "off" and not mdb.nodes[cmd])
		Print(cmd .. " nodes " .. (mdb.nodes[cmd] and "shown" or "hidden") .. " on the world map")
		M.Refresh()
	elseif cmd == "filter" and (rest == "all" or rest == "skill") then
		mdb.nodes.filter = rest
		Print(rest == "all" and "showing every node" or "showing nodes your skill can gather")
		M.Refresh()
	elseif (cmd == "show" or cmd == "hide") and rest ~= "" then
		if not FindLayer(rest) then Print("no layer " .. rest); return end
		mdb.hidden[rest] = (cmd == "hide") or nil
		M.Refresh()
	else Status() end
end

SLASH_WOWAIMAP1 = "/aimap"
SlashCmdList["WOWAIMAP"] = M.Command

local ev = CreateFrame("Frame")
ev:RegisterEvent("ADDON_LOADED")
ev:RegisterEvent("PLAYER_LOGIN")
ev:RegisterEvent("SKILL_LINES_CHANGED")
ev:SetScript("OnEvent", function(_, event, arg1)
	if event == "ADDON_LOADED" and (arg1 == ADDON_NAME or arg1 == "Blizzard_WorldMap") then
		DB()
		SetupWorldMap()
	elseif event == "PLAYER_LOGIN" then
		DB()
		mdb.nav, mdb.navPos = nil, nil -- the arrow is gone; forget what an older version saved for it
		SetupWorldMap()
	elseif event == "SKILL_LINES_CHANGED" then
		M.Refresh()
	end
end)
