-- WoWAI route: the step list. A leveling route written by the planner (RouteData.lua) is listed on the left of the screen with the
-- current step marked and where to go, and steps are ticked off from the game's own quest state: a quest in the log means its accept
-- step is done, a ready quest means its kill / collect steps are done, a quest handed in means the rest. Steps with no quest (a flight, the
-- hearthstone, a zeppelin, a flight point, an inn) are shown in their own colour and are over once a later quest step is, or ticked by hand.
-- It only reads and draws. Nothing here acts for the player.

local M = {}
WoWAIRoute = M

local LIST_ROWS = 12
local LIST_WIDTH = 360
local MARGIN_MAC = 96 -- the Dock covers the left edge of a Mac screen (the same margin as the pixel strip)
local localDB = { skips = {} }
local list, data, arrow
local ARROW = "Interface\\Minimap\\MinimapArrow"
local TRAVEL = { fly = true, hearth = true, zeppelin = true, discover = true, bind = true } -- steps the game cannot confirm: shown in their own colour

local function Try(f, ...)
	if type(f) ~= "function" then return nil end
	local ok, a, b = pcall(f, ...)
	if ok then return a, b end
	return nil
end

local function DB()
	if type(WoWAIDB) ~= "table" then return localDB end
	WoWAIDB.route = WoWAIDB.route or { skips = {} }
	WoWAIDB.route.skips = WoWAIDB.route.skips or {}
	return WoWAIDB.route
end

local function Say(msg) print("|cff66ccff[WoW AI route]|r " .. msg) end

local function OnQuest(q)
	return C_QuestLog and Try(C_QuestLog.IsOnQuest, q) == true
end
local function Completed(q)
	local f = (C_QuestLog and C_QuestLog.IsQuestFlaggedCompleted) or IsQuestFlaggedCompleted
	return Try(f, q) == true
end
local function Ready(q)
	return C_QuestLog and Try(C_QuestLog.IsComplete, q) == true
end

local function StepDone(s)
	if DB().skips[s.i] then return true end
	local q = s.q
	if not q then return false end
	if s.k == "accept" then return OnQuest(q) or Completed(q) end
	if s.k == "turnin" then return Completed(q) end
	return Completed(q) or (OnQuest(q) and Ready(q)) -- kill, collect, use: the quest is ready or finished
end

-- { current = first step not done (past the end when all are), done = { [i] = true } }
-- The steps to draw on the world map: from the current step on, the ones with a position (Map.lua draws them).
function M.MapSteps(limit)
	if DB().mapOff or not data or type(data.steps) ~= "table" or DB().off then return {} end
	local cur = M.State().current
	local out = {}
	for i = cur, #data.steps do
		local s = data.steps[i]
		if type(s.m) == "number" and type(s.x) == "number" and type(s.y) == "number" then
			out[#out + 1] = { i = i, k = s.k, t = s.t, m = s.m, x = s.x, y = s.y, current = (i == cur), travel = TRAVEL[s.k] == true }
		end
		if #out >= (limit or 14) then break end
	end
	return out
end

function M.State()
	local state = { current = 1, done = {} }
	local steps = data and data.steps or {}
	local found = false
	for i, s in ipairs(steps) do
		local d = StepDone(s)
		state.done[i] = d
	end
	-- A step with no quest of its own (a flight, the hearthstone, a zeppelin, a flight point, an inn) cannot be read from the game, but it is
	-- over once a later quest step is: the player is already past it. Those before the last finished quest step are ticked.
	local last = 0
	for i, s in ipairs(steps) do
		if s.q and StepDone({ i = 0, k = s.k, q = s.q }) then last = i end
	end
	for i, s in ipairs(steps) do
		if not s.q and i < last then state.done[i] = true end
		if not state.done[i] and not found then state.current = i; found = true end
	end
	if not found then state.current = #steps + 1 end
	return state
end

local function BuildList()
	list = CreateFrame("Frame", "WoWAIRouteList", UIParent, "BackdropTemplate")
	list:SetSize(LIST_WIDTH, 26 + LIST_ROWS * 14)
	list:SetBackdrop({ bgFile = "Interface\\Tooltips\\UI-Tooltip-Background", edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border", tile = true, tileSize = 16, edgeSize = 12, insets = { left = 3, right = 3, top = 3, bottom = 3 } })
	list:SetBackdropColor(0, 0, 0, 0.6)
	local p = DB().pos
	if p then list:SetPoint(p[1], UIParent, p[1], p[2], p[3])
	else list:SetPoint("TOPLEFT", UIParent, "TOPLEFT", (IsMacClient and IsMacClient()) and MARGIN_MAC or 12, -150) end
	list:SetMovable(true)
	list:EnableMouse(true)
	list:RegisterForDrag("LeftButton")
	list:SetScript("OnDragStart", list.StartMoving)
	list:SetScript("OnDragStop", function(self)
		self:StopMovingOrSizing()
		local point, _, _, x, y = self:GetPoint()
		DB().pos = { point, x, y }
	end)
	list.title = list:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	list.title:SetPoint("TOPLEFT", 10, -8)
	list.title:SetJustifyH("LEFT")
	list.rows = {}
	for r = 1, LIST_ROWS do
		local row = CreateFrame("Button", nil, list)
		row:SetSize(LIST_WIDTH - 20, 14)
		row:SetPoint("TOPLEFT", 10, -10 - r * 14)
		row.fs = row:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
		row.fs:SetPoint("LEFT")
		row.fs:SetWidth(LIST_WIDTH - 20)
		row.fs:SetJustifyH("LEFT")
		row.fs:SetWordWrap(false)
		row:EnableMouse(true)
		row:SetScript("OnMouseUp", function(self, button)
			if button == "RightButton" and self.step then M.Toggle(self.step) end
		end)
		list.rows[r] = row
	end
	list:Hide()
end

local function SetRow(row, text, step)
	row.text, row.step = text, step
	row.fs:SetText(text)
	row:Show()
end

function M.Refresh()
	if not data or type(data.steps) ~= "table" or #data.steps == 0 then
		if list then list:Hide() end
		if arrow then arrow:Hide() end
		return
	end
	if not list then BuildList() end
	if DB().off then list:Hide(); return end
	list:Show()
	M.UpdateArrow()
	local steps = data.steps
	local state = M.State()
	local cur = state.current
	list.title:SetText(string.format("Route %d/%d", math.min(cur, #steps), #steps) .. (data.target and ("  (to level " .. data.target .. ")") or ""))
	-- Lines: one per step from the step before the current one, and under the current step where to go and how.
	local lines = {}
	for i = math.max(1, cur - 1), #steps do
		local s = steps[i]
		local travel = TRAVEL[s.k]
		local optional = type(s.o) == "string" and s.o ~= ""
		local color = state.done[i] and "ff808080" or (i == cur and "ffffd100" or (optional and "ffe0a050" or (travel and "ff4fd1ff" or "ffffffff")))
		lines[#lines + 1] = { text = string.format("%s|c%s%d. %s%s|r", i == cur and "> " or "   ", color, i, optional and "[optional] " or "", s.t), step = i }
		if i == cur then
			lines[#lines + 1] = { text = string.format("      |cff9aa0a6%s  |  %s|r", s.z or "", s.w or ""), step = i }
			if optional then lines[#lines + 1] = { text = string.format("      |cffe0a050optional: %s. Right-click to skip.|r", s.o), step = i } end
		end
		if #lines >= LIST_ROWS then break end
	end
	for r = 1, LIST_ROWS do
		local row, line = list.rows[r], lines[r]
		if line then SetRow(row, line.text, line.step) else row.text, row.step = nil, nil; row:Hide() end
	end
	if WoWAIMap and WoWAIMap.Refresh then WoWAIMap.Refresh() end -- the route markers on the world map follow the current step
end

-- Reads the route again (after the planner wrote a new RouteData.lua and the game was reloaded, or on login); a new route forgets the
-- hand-made ticks of the old one.
function M.Reload()
	data = type(WoWAIRouteData) == "table" and WoWAIRouteData or nil
	local db = DB()
	if data and db.stamp ~= data.stamp then db.stamp = data.stamp; db.skips = {} end
	M.Refresh()
end

-- ---- the arrow: the way to the current step -------------------------------------------------------------------------------------------
local function BuildArrow()
	arrow = CreateFrame("Frame", "WoWAIRouteArrow", UIParent, "BackdropTemplate")
	arrow:SetSize(260, 44)
	arrow:SetBackdrop({ bgFile = "Interface\\Tooltips\\UI-Tooltip-Background", edgeFile = "Interface\\Tooltips\\UI-Tooltip-Border", tile = true, tileSize = 16, edgeSize = 12, insets = { left = 3, right = 3, top = 3, bottom = 3 } })
	arrow:SetBackdropColor(0, 0, 0, 0.7)
	local p = DB().arrowPos
	if p then arrow:SetPoint(p[1], UIParent, p[1], p[2], p[3]) else arrow:SetPoint("TOP", UIParent, "TOP", 0, -120) end
	arrow:SetMovable(true)
	arrow:EnableMouse(true)
	arrow:RegisterForDrag("LeftButton")
	arrow:SetScript("OnDragStart", arrow.StartMoving)
	arrow:SetScript("OnDragStop", function(self)
		self:StopMovingOrSizing()
		local point, _, _, x, y = self:GetPoint()
		DB().arrowPos = { point, x, y }
	end)
	arrow:SetScript("OnMouseUp", function(_, button)
		if button == "RightButton" then M.Command("skip") end
	end)
	arrow.arrow = arrow:CreateTexture(nil, "ARTWORK")
	arrow.arrow:SetSize(34, 34)
	arrow.arrow:SetPoint("LEFT", 6, 0)
	arrow.arrow:SetTexture(ARROW)
	arrow.title = arrow:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	arrow.title:SetPoint("TOPLEFT", 46, -7)
	arrow.title:SetPoint("RIGHT", -8, 0)
	arrow.title:SetJustifyH("LEFT")
	arrow.title:SetWordWrap(false)
	arrow.text = arrow:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	arrow.text:SetPoint("BOTTOMLEFT", 46, 8)
	arrow.text:SetPoint("RIGHT", -8, 0)
	arrow.text:SetJustifyH("LEFT")
	arrow.text:SetWordWrap(false)
	local since = 0
	arrow:SetScript("OnUpdate", function(_, elapsed)
		since = since + (elapsed or 0)
		if since < 0.1 then return end
		since = 0
		M.UpdateArrow()
	end)
	arrow:Hide()
end

-- The step's stop, or the waypoint on the way to it (a flight master, a zeppelin tower) while the player is nearer to that than to the stop.
local function Target(s)
	local WM = WoWAIMap
	if not WM or not WM.Heading then return nil, "no map module" end
	local d1, b1 = nil, nil
	if type(s.m) == "number" then d1, b1 = WM.Heading(s.m, s.x, s.y) end
	if type(s.am) == "number" then
		local d2, b2 = WM.Heading(s.am, s.ax, s.ay)
		if d2 and (not d1 or d2 < d1) then return d2, b2, s.al end
	end
	return d1, b1, nil
end

function M.UpdateArrow()
	local steps = data and data.steps
	local s = steps and steps[M.State().current]
	if not s or type(s.m) ~= "number" or DB().arrowOff then
		if arrow then arrow:Hide() end
		return
	end
	if not arrow then BuildArrow() end
	arrow:Show()
	arrow.title:SetText(s.t or "")
	local dist, bearing, label = Target(s)
	if not dist and type(bearing) == "string" then
		arrow.arrow:Hide()
		arrow.text:SetText(bearing)
		return
	end
	arrow.arrow:Show()
	local facing = Try(GetPlayerFacing)
	if facing and bearing then arrow.arrow:SetRotation(bearing - facing) else arrow.arrow:SetRotation(0) end
	arrow.text:SetText(dist and string.format("%d yd  |cff9aa0a6%s|r", math.floor(dist + 0.5), label or s.z or "") or (label or s.z or ""))
end

function M.Toggle(i)
	local skips = DB().skips
	skips[i] = (not skips[i]) or nil
	M.Refresh()
end

function M.Command(msg)
	local cmd, rest = (msg or ""):match("^%s*(%S*)%s*(.-)%s*$")
	cmd = (cmd or ""):lower()
	local db = DB()
	if cmd == "off" then db.off = true; M.Refresh(); Say("step list off")
	elseif cmd == "on" then db.off = nil; M.Refresh(); Say("step list on")
	elseif cmd == "arrow" then
		if rest == "off" then db.arrowOff = true elseif rest == "on" then db.arrowOff = nil else Say("/wow-ai route arrow on|off") return end
		M.UpdateArrow()
		Say("arrow " .. rest)
	elseif cmd == "map" then
		if rest == "off" then db.mapOff = true elseif rest == "on" then db.mapOff = nil else Say("/wow-ai route map on|off") return end
		if WoWAIMap and WoWAIMap.Refresh then WoWAIMap.Refresh() end
		Say("route markers on the world map " .. rest)
	elseif cmd == "reset" then db.skips = {}; M.Refresh(); Say("hand-made ticks cleared")
	elseif cmd == "skip" or cmd == "undo" then
		local n = tonumber(rest) or (cmd == "skip" and M.State().current) or nil
		if not n or not data or not data.steps[n] then Say("no such step") return end
		db.skips[n] = (cmd == "skip") or nil
		M.Refresh()
	else
		if not data or not data.steps or #data.steps == 0 then Say("no route installed (the planner writes RouteData.lua; then /reload)") return end
		local state = M.State()
		local s = data.steps[state.current]
		Say(s and string.format("step %d/%d: %s (%s). /wow-ai route skip | undo <n> | reset | on | off; right-click a step to tick it", state.current, #data.steps, s.t, s.z or "?") or "every step is done")
	end
end

local ev = CreateFrame("Frame")
for _, name in ipairs({ "PLAYER_LOGIN", "PLAYER_ENTERING_WORLD", "QUEST_LOG_UPDATE", "QUEST_TURNED_IN", "QUEST_ACCEPTED", "QUEST_REMOVED" }) do
	pcall(function() ev:RegisterEvent(name) end)
end
ev:SetScript("OnEvent", function(_, event)
	if event == "PLAYER_LOGIN" then M.Reload() else M.Refresh() end
end)
