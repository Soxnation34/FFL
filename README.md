# FFL League Database

`ffl.db` is a SQLite database built from the Front Office Football 8 league-data
export (`leaguedata/football` in the game's AppData folder) in this folder. It covers
seasons **2004–2094**, currently in the **2095 FA Stage 4** window (staff draft done, as of the
Oct 8 2026 export; `draft_personal.csv` and `rookies.csv` hold the current 831-prospect class, `active_free_agency.csv` has 66 rows). The user GMs **Pittsburgh (Team 22)**, running a **4-3 Over** defense — the
same scheme as the CFL side of this project, so no scheme-fit logic differs between
the two.

This is the FFL twin of `../CFL` — same data pipeline, same table shapes, same
`build_db.js`. See `../CFL/README.md` for the fullest narrative description of the
schema; only FFL-specific differences are called out below.

Rebuild it any time with:

```
node scripts/build_db.js
```

(Requires Node 22+, uses the built-in `node:sqlite` module — no install needed.
It drops and recreates `ffl.db` from the CSVs in this folder.)

## The table you probably want: `player_year_summary`

Identical shape to CFL's — one row per player per year, combining position, team,
season stats, playoff stats, and end-of-season ratings. See `../CFL/README.md` for
the full column reference; the only difference here is `Team = 22` for Pittsburgh
instead of CFL's `Team = 7` for Philadelphia.

## Scripts included so far (`scripts/`)

Only the scripts that run purely off **career/current-roster data** (no current
draft class or active free-agency window needed) were ported over and adapted
(`cfl.db` → `ffl.db`, `Team != 7` (Philadelphia) → `Team != 22` (Pittsburgh)):

- `build_db.js` — rebuilds `ffl.db` from the CSVs in this folder
- `avoid_int_check.js` — QB Avoid Interception hidden sub-rating check
- `cb_pass_defense_drivers.js`, `de_pass_rush_synergy.js`, `dl_pass_rush_drivers.js`,
  `dl_pass_rush_drivers_no_overall.js`, `dt_tackle_drivers.js`, `ol_krb_bpct_drivers.js`,
  `rb_yards_avg_explosive_drivers.js`, `rating_correlations.js` — driver/correlation
  studies over the full historical player-season panel
- `position_aging_curves.js` — experience-based peak/decline curves by position
- `rank_coaching_candidates.js` — pre-staff-draft coaching board: top 7 per role from
  free agents, expiring contracts, and poachable (promotion) hires, scored on the user's
  coach rating tier list (`CoachTierList.txt`, S=5 … D=1 weights); OCs must be West Coast
  with playbook limit 65+, DCs must be 43 Over, 2 pts off per year past age 62; writes
  `coaching_candidates_top7.csv`
- `rank_edge_free_agents.js`, `rank_rb_free_agents.js`, `scout_ol_free_agents.js` —
  rank currently-unsigned free agents by predicted production (excludes Pittsburgh's
  own pending free agents, Team=22)

## Draft Board (`draft-board/`)

The FFL twin of `../CFL/draft-board` — a live replica of StelmackSoft DraftAnalyzer's
Rating/CombineSum computed from `ffl.db`'s current draft class (`rookies` +
`draft_personal`), with Pittsburgh's 4-3 Over used for the ideal-weight lookup. Same code,
same formula; only the database path, port, branding, and export filename differ. Run it with:

```
node draft-board/server.js
```

Then open **http://localhost:4700** (the CFL board uses 4600, so both can run at once). See
`draft-board/README.md` for the formula derivation. The Priority Draft List is stored in
`draft-board/priority-list.json` (created on first save) and exports as `DraftListPIT.csv`.
Live drafted-pick tracking reads the same `UtilitySuite/DraftOrder.csv` as the CFL board, so
re-export it from DraftAnalyzer while the FFL draft is live.

`scripts/qb_card_model.js` was ported alongside it (the board's QB Avoid-Interception estimate
depends on it). The remaining draft-prospect scripts from CFL (`scout_*_prospects.js`,
`*_card_model.js`, `predict_rookie_pressure.js`) are still unported; the same swap
(`cfl.db`→`ffl.db`, `Team 7`→`Team 22`) applies if they are wanted.

## Known limitations of the source data

Same caveats as CFL's export — see `../CFL/README.md`'s "Known limitations"
section (no franchise nicknames, position not tracked historically, no
play-by-play data, mid-season trades attribute a player to whichever team they
played the most games for that year, etc.). All of it applies here unchanged.
