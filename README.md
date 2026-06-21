# Resource Allocation UX

A quality-of-life mod for the Civilization VII **Commerce → Resources** screen,
aimed at empires with lots of settlements and a large resource pool. Created
with help from [Claude Code](https://claude.com/claude-code).

## Features

1. **Hide ineligible settlements** — when you select a resource from the pool,
   settlements that can't take it are removed from the list entirely (instead of
   greyed out), so you only see valid targets. Settlements that are the right
   type but currently full stay visible. Right-click anywhere (or slot the
   resource) to restore the full list.

2. **Sort direction toggle** — a small arrow button next to the SORT dropdown
   flips any sort between ascending and descending, so you can bring your
   worst-happiness / lowest-yield settlements to the top.

3. **Middle-click to unassign** — middle-click an assigned resource to instantly
   return it to the pool, no need to click it and drag it back to the left
   panel. (Only fires when you aren't mid-interaction with another resource.)

4. **Filter hides non-matching resources** — when you filter the pool by a yield
   type, the left panel hides resources that don't provide it (the settlement
   list on the right still greys them as normal).

5. **Settlement-assignment mode** — left-click a settlement to enter a mode where
   it's highlighted (the rest dim) and a banner appears. Click resources one
   after another to fill its slots without clicking back and forth. The mode ends
   when the settlement is full, when you right-click, or when you re-click it.

6. **Hide ineligible resources in settlement mode** — while assigning to a
   settlement, the pool hides resources it can't accept (wrong trade network,
   factory/city resources for towns, etc.) so you only scroll through valid ones.

## Install

Copy the `resource-allocation-ux` folder into your Civilization VII `Mods`
directory and enable it from the in-game Mods menu.

## Notes

- Works in all three ages (Antiquity, Exploration, Modern).
- Mouse / keyboard focused. Controller play uses the base-game flows.
