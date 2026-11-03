-- WoWAI shopping suggestions: the agent proposes things to buy (a ```wowshop block in its reply,
-- checked by the bridge); this lists them when the auction house opens, and a click types the item
-- name into the search box (docs/SHOP.md).
--
-- It never searches, bids, posts or buys: it only sets the text of the search box, and the player
-- presses Search. Vendor items are listed with where to find the vendor; nothing is bought for you.

local M = {}
WoWAIShop = M

local MAX_ITEMS = 12
local ROW_H = 20
local PANEL_W = 280

local panel, rows = nil, {}
local state = { open = false, footer = "" }

local function Say(msg) print("|cff66ccff[WoW AI shop]|r " .. msg) end

local function Try(fn, ...)
	if type(fn) ~= "function" then return nil end
	local ok, a, b = pcall(fn, ...)
	if ok then return a, b end
end

-- Cut to n bytes without leaving half of a multi-byte character.
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

-- Plain text: no control characters, color escapes (|), link brackets or backticks.
local function CleanText(s, max)
	if type(s) ~= "string" then return "" end
	s = s:gsub("[%c|%[%]`]", " "):gsub("%s+", " "):gsub("^%s+", ""):gsub("%s+$", "")
	return Clip(s, max)
end

local function Key()
	return (Try(UnitName, "player") or "?") .. "-" .. (Try(GetRealmName) or "?")
end

local function Store()
	if not WoWAIDB then return nil end
	WoWAIDB.shopping = WoWAIDB.shopping or {}
	return WoWAIDB.shopping
end

function M.Items()
	local s = Store()
	local e = s and s[Key()]
	return e and e.items or {}
end

-- Only well-formed entries survive (the slot file is trusted, but not blindly).
function M.Clean(list)
	local out = {}
	if type(list) ~= "table" then return out end
	for _, e in ipairs(list) do
		if #out >= MAX_ITEMS then break end
		if type(e) == "table" then
			local item = CleanText(e.item, 50)
			if #item >= 2 then
				local it = { item = item, where = e.where == "vendor" and "vendor" or "ah" }
				local why = CleanText(e.why, 100)
				if why ~= "" then it.why = why end
				if type(e.max) == "string" and #e.max <= 16 and e.max:match("^[0-9gsc. ]+$") and e.max:match("%d") then it.max = e.max end
				if type(e.qty) == "number" and e.qty >= 1 and e.qty <= 9999 and e.qty == math.floor(e.qty) then it.qty = e.qty end
				if it.where == "vendor" then
					local v, z = CleanText(e.vendor, 40), CleanText(e.zone, 30)
					if v ~= "" then it.vendor = v end
					if z ~= "" then it.zone = z end
				end
				out[#out + 1] = it
			end
		end
	end
	return out
end

local function RowText(it)
	return it.item .. (it.qty and (" x" .. it.qty) or "") .. (it.max and (" (up to " .. it.max .. " each)") or "")
end

local function Line(it)
	if it.where == "vendor" then
		return "Vendor: " .. it.item .. (it.vendor and (" from " .. it.vendor .. (it.zone and (" in " .. it.zone) or "")) or "") .. (it.why and (": " .. it.why) or "")
	end
	return "Auction house: " .. RowText(it) .. (it.why and (": " .. it.why) or "")
end

---------------------------------------------------------------------------
-- The search box
---------------------------------------------------------------------------

-- The auction house's search box in either generation of the window, or nil.
local function SearchBox()
	local bar = AuctionHouseFrame and AuctionHouseFrame.SearchBar
	if bar and bar.SearchBox then return bar.SearchBox end
	if BrowseName then return BrowseName end
end

local function AuctionParent() return AuctionHouseFrame or AuctionFrame end

-- Type the name into the search box. The player presses Search.
function M.Fill(name)
	local box = SearchBox()
	if not (state.open and box) then return false end
	box:SetText(name)
	return true
end

function M.Pick(index)
	local it = M.Items()[index]
	if not it then Say("no suggestion number " .. tostring(index) .. ". /wow-ai shop lists them."); return end
	if it.where == "vendor" then
		Say(it.item .. " is a vendor item" .. (it.vendor and (": buy it from " .. it.vendor .. (it.zone and (" in " .. it.zone) or "")) or "") .. ".")
		return
	end
	if not M.Fill(it.item) then
		Say("Search the auction house for: " .. it.item .. (it.max and (" (up to " .. it.max .. " each)") or ""))
	end
end

---------------------------------------------------------------------------
-- The list beside the auction house
---------------------------------------------------------------------------

local function BuildPanel(parent)
	local f = CreateFrame("Frame", nil, UIParent)
	f:SetSize(PANEL_W, 40)
	f:SetPoint("TOPLEFT", parent, "TOPRIGHT", 4, 0)
	Try(f.SetFrameStrata, f, "HIGH")
	local bg = f:CreateTexture(nil, "BACKGROUND")
	bg:SetAllPoints()
	bg:SetColorTexture(0, 0, 0, 0.85)
	f.title = f:CreateFontString(nil, "OVERLAY", "GameFontNormal")
	f.title:SetPoint("TOPLEFT", f, "TOPLEFT", 8, -8)
	f.title:SetText("Your agent suggests")
	f.foot = f:CreateFontString(nil, "OVERLAY", "GameFontNormalSmall")
	return f
end

local function RowButton(i)
	local b = CreateFrame("Button", nil, panel)
	b:SetSize(PANEL_W - 16, ROW_H)
	b.label = b:CreateFontString(nil, "OVERLAY", "GameFontHighlightSmall")
	b.label:SetPoint("LEFT", b, "LEFT", 4, 0)
	b:SetScript("OnClick", function() M.Pick(b.index) end)
	b:SetScript("OnEnter", function()
		local it = b.item
		if not it or not GameTooltip then return end
		Try(GameTooltip.SetOwner, GameTooltip, b, "ANCHOR_RIGHT")
		Try(GameTooltip.AddLine, GameTooltip, it.item)
		if it.why then Try(GameTooltip.AddLine, GameTooltip, it.why, 1, 1, 1, true) end
		Try(GameTooltip.AddLine, GameTooltip, "Click to type the name into the search box", 0.6, 0.8, 1)
		Try(GameTooltip.Show, GameTooltip)
	end)
	b:SetScript("OnLeave", function() if GameTooltip then Try(GameTooltip.Hide, GameTooltip) end end)
	return b
end

function M.Refresh()
	if not panel or not state.open then return end
	local items = M.Items()
	local active, vendors = {}, 0
	for i, it in ipairs(items) do
		if it.where == "vendor" then vendors = vendors + 1 else active[#active + 1] = { index = i, item = it } end
	end
	for n, a in ipairs(active) do
		rows[n] = rows[n] or { button = RowButton(n) }
		local r = rows[n]
		r.button.index, r.button.item = a.index, a.item
		r.button:ClearAllPoints()
		r.button:SetPoint("TOPLEFT", panel, "TOPLEFT", 8, -28 - (n - 1) * ROW_H)
		r.text = RowText(a.item)
		r.item = a.item
		r.button.label:SetText(r.text)
		r.button:Show()
	end
	for n = #active + 1, #rows do rows[n].button:Hide(); rows[n].text = nil end
	state.footer = vendors > 0 and (vendors .. " vendor item" .. (vendors == 1 and "" or "s") .. ": /wow-ai shop") or ""
	panel.foot:SetText(state.footer)
	panel.foot:ClearAllPoints()
	panel.foot:SetPoint("TOPLEFT", panel, "TOPLEFT", 8, -32 - #active * ROW_H)
	panel:SetSize(PANEL_W, 40 + #active * ROW_H + (vendors > 0 and 16 or 0))
	if #active == 0 and vendors == 0 then panel:Hide() else panel:Show() end
end

function M.Rows()
	local out = {}
	for n = 1, #rows do
		if rows[n].text then out[#out + 1] = rows[n] end
	end
	return out
end

function M.Panel()
	return { shown = state.open and panel ~= nil and #M.Items() > 0, footer = state.footer }
end

local function OnOpen()
	state.open = true
	local parent = AuctionParent()
	if #M.Items() == 0 then return end
	if not parent then
		Say(#M.Items() .. " shopping suggestion(s) from your agent: /wow-ai shop")
		return
	end
	if not panel then panel = BuildPanel(parent) end
	M.Refresh()
end

local function OnClose()
	state.open = false
	if panel then panel:Hide() end
end

---------------------------------------------------------------------------
-- From the bridge, and the commands
---------------------------------------------------------------------------

-- A new list from the agent replaces the old one. Garbage never wipes what is there.
function M.Offer(list)
	local items = M.Clean(list)
	if #items == 0 then return end
	local s = Store()
	if not s then return end
	s[Key()] = { items = items, at = time() }
	Say(#items .. " shopping suggestion" .. (#items == 1 and "" or "s") .. " from your agent. Open the auction house to search for them, or /wow-ai shop")
	if panel and state.open then M.Refresh() end
end

function M.Clear()
	local s = Store()
	if s then s[Key()] = nil end
	if panel and state.open then M.Refresh() end
	Say("shopping list cleared")
end

function M.Command(rest)
	rest = tostring(rest or ""):lower()
	if rest == "clear" then M.Clear(); return end
	local n = tonumber(rest:match("^(%d+)$"))
	if n then M.Pick(n); return end
	local items = M.Items()
	if #items == 0 then Say("nothing to buy. Ask your agent what to get; /wow-ai shop lists its suggestions."); return end
	local s = Store()
	local at = s and s[Key()] and s[Key()].at
	Say("suggested by your agent" .. (at and (" at " .. date("%H:%M", at)) or "") .. " (/wow-ai shop <number> types a name into the auction house search box, /wow-ai shop clear):")
	for i, it in ipairs(items) do Say(i .. ". " .. Line(it)) end
end

local frame = CreateFrame("Frame")
for _, name in ipairs({ "AUCTION_HOUSE_SHOW", "AUCTION_HOUSE_CLOSED" }) do pcall(function() frame:RegisterEvent(name) end) end
frame:SetScript("OnEvent", function(_, event)
	local ok = pcall(function()
		if event == "AUCTION_HOUSE_SHOW" then OnOpen() elseif event == "AUCTION_HOUSE_CLOSED" then OnClose() end
	end)
	if not ok then state.errors = (state.errors or 0) + 1 end
end)
