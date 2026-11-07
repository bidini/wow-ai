# Route step list

A leveling route, planned outside the game, is listed on the left of the screen: the current step is marked with `>`, with where to go and how to get there under it, and the steps are ticked off from the game's own quest state. There is no agent in the loop and no arrow; the addon only reads and draws.

```
 planner (wow-route/plan.mjs)  ──writes──▶  Interface/AddOns/WoWAI/RouteData.lua  ──/reload──▶  Route.lua draws the list
```

## What you see

```
Route 17/102  (to level 22)
   16. Turn in: Rot Hide Origins (Bethor Iceshard)
 > 17. Collect 6: Lake Skulker Moss from Lake Skulker for A Recipe For Death
       Silverpine Forest 71.5, 36.0  |  walk 1,923 yd
   18. Collect 6: Lake Creeper Moss ...
```

Twelve lines at most, starting from the step before the current one. Drag the frame to move it; it starts right of the Dock margin on a Mac.

## How steps are ticked

- **Accept** is done once the quest is in your log (or already handed in).
- **Kill, collect, use** are done once the quest is ready (or handed in).
- **Turn in** is done once the quest is handed in.
- A step with no quest (finding a flight point, setting the hearthstone) is ticked by hand: right-click it, or `/wow-ai route skip`.
- A quest finished out of order ticks all its steps. The current step is always the first one not done.

## Commands

| Command | Does |
|---|---|
| `/wow-ai route` | Show the current step and where it is |
| `/wow-ai route skip [n]` | Tick step `n` (the current one when no number) |
| `/wow-ai route undo <n>` | Untick step `n` |
| `/wow-ai route reset` | Clear the hand-made ticks |
| `/wow-ai route on` / `off` | Show or hide the list |

## Installing a route

`node plan.mjs 22 350` (or `./run.sh`) writes `out/RouteData.lua` next to the route report; `INSTALL=1` also copies it into the game folder. `/reload` in game reads it. A new route (a new `stamp` in the file) forgets the hand-made ticks of the old one. `setup.js` never overwrites `RouteData.lua` once it exists. Adding `Route.lua` and `RouteData.lua` to the addon needs one full relaunch of the game; after that a `/reload` is enough.
