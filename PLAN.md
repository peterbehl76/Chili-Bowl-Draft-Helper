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

## Key context to resume
- LEAGUE_ID = 1248017523933196288 (2025 season; bump to new id each year)
- numTeams = 14, numRounds = 16, NEXT_SEASON = leagueSeason + 1
- traded_picks: {round, season, roster_id=original owner, owner_id=current owner}
  -> ownership: each roster owns its own pick per round unless an entry moves it.
- Players cache: trimmed map in localStorage, 24h TTL, ~<1 MB.
