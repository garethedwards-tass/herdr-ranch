# Writing Herdr mods: what bit us

Notes from building these two lists, for anyone writing a mod of their own.

## Renders

- **Herdr stops a render that runs too long** and shows "This view could not be re-rendered; showing the last version that worked / interrupted". The limit is roughly 50 to 100 ms of script time, `herdr-app check` doesn't enforce it, and Herdr re-renders a mod on any live change (agent status, focus). Keep renders small: slim data at load, cache derived lists, cap long lists, and cap Markdown length.
- **Split a big view into retained child views.** `cx.new(Class, props)` (in `init`, a handler or a task, never in `render`) gives a child that renders only on its own `cx.notify(child)` or `child.set_props(...)`. The open page is one: a live change redraws the list, and a page that loads redraws only the page. Never call `cx.notify` or `set_props` from inside a render.
- **Building rows in blocks of retained views didn't help:** it spread the work over frames but made the list feel slower. A plain list capped at 300 rows was better.
- **`v_virtual_list` makes hovering lag:** it calls its row builder in script for every frame drawn, and a hover redraws. A plain list built once per render, with hover as a style (`.hover(...)`), runs no script between renders.
- **Do conversions once, at load:** Markdown from Jira's format, sorted conversations, row data. A render runs on every live change.
- **Width-dependent layouts jump while a panel opens:** the panel reports every width on the way. Start from the last width seen in the same place and accept a new width once it held for 200 ms.
- **A hidden `resizable_panel` reopens shrunk** (about 370px instead of its `size(560)`). Workaround: give the `v_resizable` a fresh id on every open and keep the height from `on_resize`.
- `Date.now()` inside a render can jump by seconds (the app is throttled while its window isn't drawing), so it is not a reliable profiler.

## Data

- **`fetch(...).json()` is slow to read:** its result stays in the app, and every property read crosses over. Walking one Jira issue page took 2.2 s that way and 80 ms after `JSON.parse(await r.text())`. Herdr's own `spaces()`, `panes()` and `shared()` are plain script objects and cheap (about 0.2 ms a call).
- **A mod tab is a copy of its own,** with its own timers. A list in a tab gets `props.space` from the mod-buttons layout and does nothing while its space isn't shown, so many spaces with open tabs don't all reload on a space switch.

## Files and reloads

- **`svg()` can't read a linked mod folder:** it resolves against the app's home and doesn't follow the symlink. Write icons to `data/<your-mod>/` at start (`writeTextFile`) and point `svg()` there; they take the text color.
- **A mod can't import outside its folder,** so code two mods share is copied. Here `shared/` holds the sources and `install.sh` warns about a stale copy.
- **A dialog doesn't need a mod of its own:** a mod can open itself as an overlay with a prop (`openOverlay({ mod: "herdr-ranch-prs", props: { dialog: "link" } })`) and render only the dialog for it, the way the settings popup works.
- **Panel mods don't hot-reload.** A layout switch away and back (`layout.switch`) loads new code. Pointing a mod's symlink elsewhere doesn't reload either: the watcher keeps the old target.
- **Every reload keeps the old mod copy in memory** ([herdrdev/herdr-app#88](https://github.com/herdrdev/herdr-app/issues/88)). After a few dozen reloads the whole app slows down; restart Herdr before judging how fast something is.
