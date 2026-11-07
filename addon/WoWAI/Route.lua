-- WoWAI route: the step list. A leveling route written by the planner (RouteData.lua) is listed on the left of the screen with the
-- current step marked and where to go, and steps are ticked off from the game's own quest state: a quest in the log means its accept
-- step is done, a ready quest means its kill / collect steps are done, a quest handed in means the rest. Steps with no quest (a flight
-- point, an inn) are ticked by hand. No agent and no arrow; it only reads and draws. Nothing here acts for the player.

local M = {}
WoWAIRoute = M

local LIST_ROWS = 12
local LIST_WIDTH = 360
local MARGIN_MAC = 96 -- the Dock covers the left edge of a Mac screen (the same margin as the pixel strip)
local localDB = { skips = {} }
local list, data

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
function M.State()
	local state = { current = 1, done = {} }
	local steps = data and data.steps or {}
	local found = false
	for i, s in ipairs(steps) do
		local d = StepDone(s)
		state.done[i] = d
		if not d and not found then state.current = i; found = true end
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
		return
	end
	if not list then BuildList() end
	if DB().off then list:Hide(); return end
	list:Show()
	local steps = data.steps
	local state = M.State()
	local cur = state.current
	list.title:SetText(string.format("Route %d/%d", math.min(cur, #steps), #steps) .. (data.target and ("  (to level " .. data.target .. ")") or ""))
	-- Lines: one per step from the step before the current one, and under the current step where to go and how.
	local lines = {}
	for i = math.max(1, cur - 1), #steps do
		local s = steps[i]
		local color = state.done[i] and "ff808080" or (i == cur and "ffffd100" or "ffffffff")
		lines[#lines + 1] = { text = string.format("%s|c%s%d. %s|r", i == cur and "> " or "   ", color, i, s.t), step = i }
		if i == cur then
			lines[#lines + 1] = { text = string.format("      |cff9aa0a6%s  |  %s|r", s.z or "", s.w or ""), step = i }
		end
		if #lines >= LIST_ROWS then break end
	end
	for r = 1, LIST_ROWS do
		local row, line = list.rows[r], lines[r]
		if line then SetRow(row, line.text, line.step) else row.text, row.step = nil, nil; row:Hide() end
	end
end

-- Reads the route again (after the planner wrote a new RouteData.lua and the game was reloaded, or on login); a new route forgets the
-- hand-made ticks of the old one.
function M.Reload()
	data = type(WoWAIRouteData) == "table" and WoWAIRouteData or nil
	local db = DB()
	if data and db.stamp ~= data.stamp then db.stamp = data.stamp; db.skips = {} end
	M.Refresh()
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
