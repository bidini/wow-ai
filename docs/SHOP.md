# Shopping suggestions

The agent can propose things to buy. At the auction house they appear as a short list beside the window, and a click **types the item's name into the search box**. You press Search and you buy. The addon never searches, bids, posts or buys by itself: it only sets the text of the search box, the same as if you had typed it.

```
 reply with ```wowshop ──▶ bridge/protocol.js ──▶ "shop" on the reply ──▶ Shop.lua ──▶ list beside the auction house
 (JSON, one item a line)   validates, cleans        (slot file)             stores it     click = name typed in the box
```

## What the agent writes

```
```wowshop
{"item":"Heavy Linen Bandage","where":"ah","why":"First Aid 40/75 uses it","max":"60s","qty":20}
{"item":"Refreshing Spring Water","where":"vendor","vendor":"Innkeeper Farley","zone":"Goldshire","why":"mana between pulls"}
```
```

Only `item` is required. `where` is `ah` (default) or `vendor`; `max` is the most to pay for **one** item, like `60s` or `1g 20s`; `qty` is 1 to 9999; `vendor` and `zone` are for vendor items. Up to 12 items a reply. The bridge removes the block from the reply, shows it as plain lines instead, and drops entries it cannot use (and says how many). Names and notes are cleaned: no control characters, color codes, link brackets or backticks, 50 characters for a name and 100 for a reason.

## In the game

- **Auction house open:** a panel beside the window lists the auction house items, with the quantity and price ceiling. Hover for the reason. Click a row and the name is typed into the search box (the Browse tab's box in the older window, the search bar in the newer one). Vendor items are not listed there; a line says how many there are.
- `/wow-ai shop` lists everything the agent suggested, numbered, with vendor names and zones. `/wow-ai shop 2` does the same as clicking item 2 (or says where to find the vendor). `/wow-ai shop clear` empties the list.
- A new list from the agent replaces the old one, per character. Anything malformed is ignored and never wipes the list.

## Limits

- The agent does not know auction prices (Wowhead has none), so `max` is only a ceiling it can justify; it should say so rather than invent a price.
- If the auction house window is not one of the two shapes above, the name is printed to chat instead.
- Whether typing into the search box starts a search by itself depends on Blizzard's own box. If it does, that is Blizzard's code reacting to the text, not a call from this addon. Not checked against a live client yet.

## Testing without the game

`tests/shop_test.js` (block parsing, cleaning, limits, the record in the slot file, the prompt hint) and `tests/shop_addon_test.js` (the list, the click, both window shapes, cleaning, and a check that `Shop.lua` contains no search, bid, post or chat call).
