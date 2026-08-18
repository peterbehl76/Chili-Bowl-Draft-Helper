# Draft Helper - Build Plan

## Goal
Local, double-click HTML keeper-draft suggestion utility for the Sleeper league
"Super Chili Bowl" (league_id 1248017523933196288). User picks their team from a
dropdown; the app lists their current roster with, per player:
- Last year's (2025) draft round
- This year's (2026) keeper round with the 1-round penalty + carve-outs
  (call out when the relevant pick was traded away)
- Estimated 2026 draft round (from Sleeper search_rank / numTeams)
- Value = keeper round - estimated round (positive = good value)

## Locked rules
- Keeper round = lastYearRound - 1; round-1 players stay round 1.
- Cascade: if the roster does not own a pick in the keeper round, move up
  (round - 1) until an owned pick is found (stop at round 1). Driven by
  /traded_picks for the upcoming season.
- Undrafted players (not in last year's draft) -> keeper round = final round (16).
- No escalation.
- Estimated round = ceil(search_rank / numTeams); no rank -> "UD".

## Data sources (all Sleeper, public, CORS-friendly, no auth)
- GET /league/{id}                -> name, season, total_rosters, draft_id
- GET /league/{id}/users          -> user_id -> display_name, team_name
- GET /league/{id}/rosters        -> roster_id, owner_id, players[]
- GET /draft/{draft_id}           -> settings.rounds
- GET /draft/{draft_id}/picks     -> player_id -> round (last year)
- GET /league/{id}/traded_picks   -> pick ownership for NEXT_SEASON (2026)
- GET /players/nfl                -> names + search_rank (14.6 MB; trim + cache)

## Files
- index.html  - markup + team dropdown + results table
- app.js      - fetch, compute, render
- styles.css  - styling
- README.txt  - how to use + yearly league-id update note

## Build steps
- [x] Verify all Sleeper endpoints against the real league
- [x] index.html
- [x] styles.css
- [x] app.js (fetch + cache + keeper math + render)
- [x] README.txt
- [x] Sanity-check keeper math against a known roster
      (RJ Harvey R5 -> R4 not owned -> R3 cascade confirmed; round-1 + undrafted ok)
- [x] Team dropdown defaults to neutral placeholder (no hardcoded team)
- [x] UI: continuous value gradient (red->neutral->green by magnitude)
- [x] UI: blue fill on est rounds 1-5 (deepest R1 -> light R5), R6+ plain
- [x] UI: click-to-sort columns (name/last/keeper/est/value) with arrows;
      UD/unranked sort last; Top-keeper highlight stays tied to value
- [x] UI: replaced est-round blue fill with star rating (R1=3, -0.5/round)
- [x] Cap est round at numRounds; beyond -> UD (value uses numRounds+1)
- [x] Future-proof: walk previous_league_id chain FORWARD via member accounts
      to the latest draft-complete league; seed is fallback; 24h cache.
      Verified live: original 2023 id -> 2024 -> 2025 (current). Gate keeps it
      on last completed draft pre-renewal-draft so it always works.
- [x] UI: "Rankings updated <ago>" label + info bubble next to Refresh
- [x] Balanced keeper score: (1-w)*surplus + w*quality, non-linear pick-value
      curve (round1=100, decay 0.82); slider w in [0,1], default 0.5; drives
      Top-keeper picks + suggestion. Persist w in localStorage.
      Verified: balanced default favors stud (50) over bargain (34.5).
- [x] "Top 20 available players" section (unrostered, by rank) + est/stars.
      Filters: active + on an NFL team + draftable position (kills retired
      players like Brady/Gurley and IDP). Positions derived from roster_positions.
- [x] Rookie badge (years_exp===0) on available + roster rows; cache bumped v2.
- [x] Move team dropdown out of header to directly above the roster table;
      new "Keeper helper" + "Top available players" section headings.
- [x] BUGFIX empty available table: dropped unreliable `active` filter (Sleeper
      flags Brady active) - team + position filters already exclude retired/IDP.
      Bumped player cache to v3. Verified 511 match, 20 shown. Ranks are always
      current (the /players/nfl endpoint is live, not league-year tied).
- [x] Layout: two columns side by side (flex-wrap to stack); keeper legend
      moved to full-width bottom; zero-state (clipboard SVG) when no team picked.
- [x] Bigger, styled balance slider (24px thumb, gradient track).
- [x] Loading spinner overlay on slider change (debounced 160ms re-score).
- [x] Suggestion banner now shows value AND star rating per suggested keeper.
- [ ] Decide hosting for phone/league-wide access (Drive will NOT work)

## Round 2 updates (2026-08-18)

Three requested changes. Order: 1 -> 2 -> 3.

- [x] 1. Cascade/traded warning missing from the "Suggested keepers" banner. The table renders it (renderBody) but the banner (applyScoring) shows only the "Round #N" chip. Extract a shared `keeperNoteHtml(row)` used by both so they cannot drift again.
- [x] 2. "Don't suggest negative value" checkbox, inline with the "Suggested keepers" heading. Excludes `row.value < 0` from suggestion selection (break-even 0 stays eligible; `value` and `surplusPoints` always share a sign, so this is consistent with the ranking score). Show an explanatory line when the filter leaves nothing. NOTE: started as default-ON + persisted, then changed per user to default OFF on every load with NO persistence (localStorage key removed) - every visit starts on the raw unfiltered ranking. The `checked` attribute in index.html is the single source of truth for the starting state. Requires moving the banner heading into static markup + a new `#suggestionBody`, because applyScoring rewrites innerHTML on every slider drag and would clobber the checkbox.
- [x] 3. Managers were NOT hardcoded - the app was pinned to the 2025 league. Split the two roles the league object plays:
      - roster league (newest, 2026): users, rosters, co-managers, numTeams, upcoming numRounds, ADP field, roster_positions
      - draft league (latest draft-complete, 2025): last-year draft rounds (keeper cost basis)
      `resolveLatestLeague` stops advancing when the next season is pre_draft (the `draftDone` gate), which is right for keeper math but wrongly freezes the manager list too.
      - [x] 3a. `resolveLeagues()` walks forward to the NEWEST league always, remembering the newest draft-complete one along the way. Cache both ids (bump resolved cache keys to v2).
      - [x] 3b. Season semantics: `state.season` = roster league season, `state.draftSeason` = basis draft season, `state.nextSeason` = upcoming draft season = `draftDone(rosterLeague) ? season + 1 : season`. Verified this preserves old behavior pre-renewal (2025 complete -> nextSeason 2026) and is correct now (2026 pre_draft -> nextSeason 2026, basis 2025).
      - [x] 3c. traded_picks unioned across both leagues, deduped on season|round|roster_id, newer league wins. Safe because roster_id is confirmed stable across renewal.
      - [x] 3d. Dropdown shows `Team Name (manager + co-manager)` from `owner_id` + `co_owners`. Suppress the parenthetical when a single manager's name equals the team name (new managers have no team_name, so it would read "TeamSpicybrown (TeamSpicybrown)").
      - [x] 3e. Refresh button also re-resolves the league (bypassing the 24h cache) and re-fetches users/rosters/traded picks, then re-renders and restores the selected roster. Rename button "Refresh ADP" -> "Refresh" since it now does more.
- [x] Update README.txt for all three.
- [x] Sort order in the dropdown: leave alone (user does not care).
- [x] 4. Mid-season ADP. Found while answering "will this work after our official draft?": once the 2026 draft completes, nextSeason becomes 2027 and `loadAdp(2027)` returns nothing (Sleeper publishes a season's ADP only in that season's preseason - verified: the 2027 query returns 3112 rows with ZERO adp_ppr values, vs 3112/3112 for 2026). That silently dropped the whole season to the rougher search_rank fallback. Added `loadAdpLatest()` which walks back one season to the most recent PUBLISHED ADP, records it in `state.adpSeason`, and the footer says which season is in use. Verified against a real already-drafted 2026 league: usingAdp flipped false -> true, 1127 entries, rank labels went from "Sleeper rank #188" to "ADP 205.8".

### Verified live 2026-08-18 (Sleeper API)
- 2026 league EXISTS: 1386433334669742080, status `pre_draft`, prev = 2025 seed, 14 rosters, draft 1386433334686523392 (rounds=16, teams=14 even pre-draft).
- Membership diff 2025 -> 2026: dropped `BenGriffin` ("Waterloo IDK"); added `TeamSpicybrown` (roster 11) and `GoodNotGreat27` (co-manager on roster 9 with `zfuss721`). 15 users / 14 rosters.
- roster_id IS stable across renewal: all 14 kept their id; only roster 11 changed owner. Roster 11 kept all 17 players.
- NO roster-level team name exists in Sleeper - team name lives only on the user (`metadata.team_name`, falling back to `display_name`). So a manager change necessarily changes the franchise label; nothing in the API can anchor it.
- traded_picks for season 2026 are IDENTICAL in both leagues (6 entries) - Sleeper carried them forward. The union is a no-op today but keeps it robust.

## Key context to resume
- LEAGUE_ID = 1248017523933196288 (2025 season; bump to new id each year)
- numTeams = 14, numRounds = 16, NEXT_SEASON = leagueSeason + 1
- traded_picks: {round, season, roster_id=original owner, owner_id=current owner}
  -> ownership: each roster owns its own pick per round unless an entry moves it.
- Players cache: trimmed map in localStorage, 24h TTL, ~<1 MB.
