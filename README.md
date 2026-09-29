# FFL League Database

`ffl.db` is a SQLite database built from the Front Office Football 8 league-data
export (`leaguedata/football` in the game's AppData folder) in this folder. It covers
seasons **2004–2094**, currently mid-**2094** (Reg. Season Week 10 as of the last
export). The user GMs **Pittsburgh (Team 22)**, running a **4-3 Over** defense — the
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
- `rank_edge_free_agents.js`, `rank_rb_free_agents.js`, `scout_ol_free_agents.js` —
  rank currently-unsigned free agents by predicted production (excludes Pittsburgh's
  own pending free agents, Team=22)

## Not yet ported: draft-prospect scripts and the Draft Board

FOF8 only exports `draft_personal.csv`, `rookies.csv`, and `active_free_agency.csv`
during the draft-prep / active-free-agency windows of the season. The FFL league
was exported mid-regular-season (Week 10, 2094), so **none of those three files
exist yet** — there is no current draft class or active FA pool to scout.

Held back until a re-export happens during those windows:
- `scout_qb_sleepers.js`, `qb_card_model.js`, `db_card_model.js`, `dl_card_model.js`,
  `ol_card_model.js`, `rb_card_model.js`, `scout_rb_prospects.js`,
  `scout_dt_prospects.js`, `scout_edge_rushers.js`, `scout_ol_prospects.js`,
  `predict_rookie_pressure.js` — all read `rookies`/`draft_personal`
- `build_draft_order_phi.js`, `export_draft_order_phi.js` — tied to the CFL
  Draft Board's live-draft CSV workflow, PHI-specific
- The **Draft Board** web tool (`../CFL/draft-board`) — an FFL tab was intentionally
  **not** wired up yet, since its prospect board would just be empty

**To unlock these**: inside FOF8, advance the FFL league to its rookie draft (or
active free agency) window and re-run the league-data export to
`leaguedata/football`, then re-copy the new CSVs into this folder and re-run
`node scripts/build_db.js`. At that point the same porting approach used here
(copy from `../CFL/scripts`, swap `cfl.db`→`ffl.db` and `Team 7`→`Team 22`) applies
directly — ask to have the rest of the suite (and the Draft Board's FFL tab) wired
up at that time.

## Not yet ported: the game-log / Play Call Lab pipeline

CFL also has a play-call analysis pipeline that does not touch `cfl.db` at all. It parses
saved FOF8 game-log HTML pages (`Game Logs/<Team>-<Year>-W<n>.html`) into a separate
`game_logs.db` and matches the user's offensive snaps to named plays in their playbook:
`game_log_parser.js`, `play_attribution.js`, `build_game_logs_db.js`, `add_week.js`,
`export_play_success_report.js`, `build_play_success_xlsx.ps1`, `build_fgo.js`, and the
`play_call_lab_artifact/` viewer.

FFL has neither input yet: no `Game Logs/` folder of Pittsburgh game logs and no
`Playbooks/` folder with a parsed Pittsburgh playbook (CFL's is `WestCoastRun_parsed.json`).
The scripts also hardcode `Philadelphia` and `WestCoastRun`. **To unlock**: save Pittsburgh's
weekly game logs into `Game Logs/` and add Pittsburgh's `.fbk` playbook (parsed) under
`Playbooks/`, then port with `Philadelphia`→`Pittsburgh` and the playbook name swapped.

## Known limitations of the source data

Same caveats as CFL's export — see `../CFL/README.md`'s "Known limitations"
section (no franchise nicknames, position not tracked historically, no
play-by-play data, mid-season trades attribute a player to whichever team they
played the most games for that year, etc.). All of it applies here unchanged.
