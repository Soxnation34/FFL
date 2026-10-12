# FFL Draft Board

A modern, live, faithful replica of StelmackSoft DraftAnalyzer's Rating/CombineSum — the same
formula, the same per-position weights (read from the user's actual `DraftAnalyzer.weights`
config, byte-verified against it), computed fresh from `ffl.db` for the *current* draft class
instead of DraftAnalyzer's own desktop UI. No custom scoring model — this intentionally does not
use the regression-based "Expected Overall" composites built earlier in this project
(`../Draft_Methodology.md`); it reproduces DraftAnalyzer's own 10+-years-trusted math instead.

## Run it

```
node server.js
```

Then open **http://localhost:4700**. No `npm install` needed — built-in `node:sqlite` and `http`
only, same convention as the rest of this project. Requires Node 22+.

## Where the formula came from

Reverse-engineered from DraftAnalyzer's actual C# source (found at `C:\Users\soxna\OneDrive\FOF8
Utilities\FOFUtilities-master`) — `DataReader/DraftWeights.cs`, `DataReader/FOFData.cs`,
`DraftAnalyzer/DraftAnalyzerForm.cs` — not guessed from the binary `.weights` file alone. The full
derivation, with source line references, is documented in [`lib/draftAnalyzer.js`](lib/draftAnalyzer.js)'s
header comment. Summary:

- **CombineScore**: z-score each of {Dash, Solecismic, Bench, Agility, BroadJump, PositionDrill}
  against *fixed, hardcoded* per-position-group averages/std-devs baked into the tool (not
  recomputed from the live class), weighted by the position's own combine weights — or a flat
  **-100 penalty** if a value crosses that group's minimum/maximum bar. Prospects missing any
  combine number use a degraded "no-combine" formula (Solecismic + PositionDrill only) rather than
  being excluded.
- **SizeScore**: height/weight fit vs. each candidate position's ideal — set to **4-3 Over**, the
  user's actual defense (`lib/pools.js`'s `ACTIVE_SCHEME`), overriding the True-34 value saved in
  the `.weights` file's header (which only reflects whatever the desktop UI last had selected, not
  necessarily the live scheme).
- **AttributeScore**: weighted sum of the position's ~10-15 relevant scout Low/High sub-ratings.
- **DevelopmentScore**: bonus/penalty vs. the prospect's development percentage.
- **RatedPosition**: every DE/DT/OLB/ILB/CB/S prospect is cross-rated against all 13 of those
  positions (and WR against FL/SE, OL against the other line spots) — whichever position scores
  highest wins, and *that* score becomes CombineSum/Rating. This can meaningfully reclassify a
  prospect — under 4-3 Over specifically, a native NT/SILB/WILB is often rated best elsewhere
  (LDT/RDT for NT, SLB/WLB for SILB/WILB), since a 4-3 front has no true nose tackle or true
  inside-linebacker ideal weight defined, so those natives eat a large SizeScore penalty at their
  own listed position — a real quirk of the tool, not a bug, visible in each prospect's detail
  drawer.
- **ChemistryScore is omitted** — it needs per-prospect Interview/Conflicts/Affinities text that
  isn't present in ffl.db's rookies/draft_personal export. Small relative to the other terms.
- **Grade is NOT part of Rating.** DraftAnalyzer's "Grade" is a free-text/manual scouting field the
  GM enters by hand in the desktop app — unrelated to `rookies.Grade` in ffl.db (a different,
  game-internal scout composite) and not shown here since we have no equivalent user-entered value.

Every position's weight table was checked against the user's actual `DraftAnalyzer.weights` file
byte-for-byte and matches exactly — the file uses the tool's stock defaults, unmodified.

## Live drafted-pick tracking

Cross-references the DraftAnalyzer's own `DraftOrder.csv` export (in `UtilitySuite/`) on every
request, matched to `ffl.db` prospects by Name+Birthdate. **As of 2026-08-09 that file is a stale
export from an earlier draft cycle** (0 of 809 current prospects match it) — the sidebar banner
reports this live. Re-export `DraftOrder.csv` from DraftAnalyzer during the actual live draft and
picks will start showing up automatically, no restart needed.

## Draft Results page (added 2026-10-12)

**Draft Results** (second item under Tools) lists every drafted prospect in pick order with the team
that took him, built from whatever was last loaded with **Upload Drafted**. A **team dropdown** in
the toolbar filters to one team's picks (each team shows its pick count); search, the ★ Favorites
only toggle, column sorting, and the prospect card all work here too. The team comes from the
upload itself, so use a file that names it: FOF8 recap lines (`Pick #4 - Pittsburgh - Last, First,
Pos, College`) or a CSV with a `Team` column. A plain name list has no teams, so the page still
lists the players but the dropdown stays empty. Source: `GET /api/drafted` in `server.js`; the team is
stored per pick in `drafted-players.json` by `lib/draftedUpload.js`.

## Favorites / star marks (added 2026-10-11)

Click the **☆** next to any prospect's name — on the Priority Draft List, any position board, or in
the prospect card header — to mark them as a favorite. A starred player shows a gold **★**, and on
the Priority Draft List (and every board) the row gets a gold tint and left edge so favorites stand
out at a glance. The **★ Favorites only** toggle in the toolbar narrows the current view to starred
players. Stars are saved server-side in `favorites.json` (via `lib/favorites.js` and
`POST /api/favorites`), so they persist across reloads and restarts, and they are independent of
the list order: starring does not move a player, and removing a player from the list does not
unstar them. The exported `DraftListPIT.csv` keeps its `Name,Position,BirthDate` shape so
DraftAnalyzer can still import it, so stars are not part of the export.

## Drag-to-reorder the Priority Draft List (added 2026-10-11)

On the Priority Draft List tab, grab any row (the `⋮⋮` grip on the left, or anywhere on the row)
and drag it up or down. A blue line shows where it will land: drop on the top half of a row to
insert above it, the bottom half to insert below. The table auto-scrolls when you drag near its top
or bottom edge. The new order saves immediately, same as the arrow buttons, and drag works while
"Hide drafted", search, or the position filter are active (the player is placed next to the row
you dropped on, in the full list). The ↑ ↓ × buttons still work.

## Developed % and Volatility (added 2026-10-10)

Each prospect card has a **Developed %** / **Volatility** strip under the measurables, and the
board table has a **Vol** column next to **Dev%**. Developed % comes from `rookies.Developed`
(already feeding DraftAnalyzer's DevelopmentScore). Volatility is the game's 0-100
"likelihood of a sudden, drastic jump or drop in ability" rating, joined in from
`player_record.Volatility` (present for every prospect). It is display-only and does not change
the Rating. Bands shown on the card are descriptive: 0-33 Low, 34-66 Moderate, 67+ High (boom/bust);
the game publishes no official cutoffs.

## Uploading drafted players (added 2026-10-10)

The **⇧ Upload Drafted** button in the toolbar takes a file listing the players drafted so far and
marks them **Drafted** everywhere: a red chip on every board, struck-through rows (hidden by
default via the "Hide drafted" toggle), and exclusion from the Priority Draft List export — so a
fresh `DraftListPIT.csv` can be exported after every round. Upload again at any point to replace
the list; **✕ Clear Drafted** forgets it and falls back to the UtilitySuite `DraftOrder.csv`.

Accepted formats (comma or tab separated, header optional):

- DraftAnalyzer's `DraftOrder.csv` (`Name`, `Birthdate`, `Drafted`, `DraftedOrder`) — only rows
  with `Drafted = True` count
- This app's own export (`Name,Position,BirthDate`) trimmed to the drafted players
- A plain list, one player per line, optionally prefixed with the pick number (`12, First Last`)

Rows are matched to current prospects by Name+Birthdate when a birthdate column is present,
otherwise by full name (case-insensitive). Names that match nothing, or that two prospects share,
are reported in the sidebar banner and the post-upload summary instead of being guessed. The
matched list persists in `drafted-players.json` (git-ignored territory; delete it to reset) and
is served by `lib/draftedUpload.js` / `POST /api/drafted/upload` / `POST /api/drafted/clear`.

## Files

- `server.js` — http server, no framework
- `lib/draftAnalyzer.js` — the formula itself (all weight/combine-stat tables + scoring functions)
- `lib/pools.js` — pulls each prospect's raw numbers out of `ffl.db` and hands them to
  `draftAnalyzer.js`; owns no scoring logic of its own
- `lib/draftStatus.js` — live CSV parsing + Name+Birthdate matching
- `public/` — the frontend (vanilla HTML/CSS/JS, no build step)

## Note on the earlier version

An earlier iteration of this app used custom regression-fit "Expected Overall" scouting models
(RB/Edge/DT/OL/CB Expected Overall, veteran-ceiling stat projections) documented in
`../Draft_Methodology.md` and implemented in `../scripts/*_card_model.js`. Those scripts are
untouched and still usable standalone — this app just no longer calls them, per a 2026-08-09
decision to trust DraftAnalyzer's own long-validated math instead while confidence in the custom
models is still being built up. Two small, additive bugfixes made to those scripts along the way
remain in place: `dl_card_model.js`/`db_card_model.js` now expose `dash` in `computeCard()`'s
return, and `ol_card_model.js` now flags `untested` prospects and exposes KRB/BPct projections.
