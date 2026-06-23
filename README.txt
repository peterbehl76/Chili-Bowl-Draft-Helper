KEEPER DRAFT HELPER
===================

What it is
----------
A local web page that suggests keeper value for the Sleeper league
"Super Chili Bowl". Pick a team from the dropdown and it lists that team's
current roster with, for each player:

  - Last yr round : the round the player was drafted last season (UD = undrafted)
  - Keeper round  : what it costs to keep them this season (rules below)
  - Est. round    : estimated draft round this year (from Sleeper's live rank),
                    capped at the final round; anything beyond is "UD". Top-tier
                    players also earn stars (round 1 = 3 stars, -0.5 per round).
  - Value         : keeper round - estimated round (higher = better value)

The top two players are flagged "Top keeper" (the league allows up to two
keepers). They are chosen by a balanced "keeper score" that blends surplus value
with player quality - use the "Suggestion balance" slider to lean toward pure
value (the biggest bargains) or pure player quality (keep your best players).
This is a suggestion tool only - it does not set keepers; league members still
declare their actual keepers in Sleeper. Click any column header to sort by it.

Below the keeper helper, a "Top available players" table lists the best players
not on any roster (by Sleeper rank), with rookies marked by an "R" badge.

How to use it
-------------
Double-click index.html. It opens in your browser and works on its own - no
install, no sign-in, nothing hosted online. Keep index.html, app.js, and
styles.css together in the same folder.

The first open downloads the player list from Sleeper (~15 MB, one time) and
caches it in your browser for 24 hours. Later opens are fast. The "Rankings
updated" label (next to the Refresh button) shows when that cache was last
filled; click "Refresh rankings" to pull the latest ranks on demand. League
rosters, the draft, and trades are loaded fresh every visit, so in-season
roster moves show up automatically.

Keeper rules implemented
------------------------
  - Standard penalty : a player drafted in round N costs round N-1 to keep.
  - Round 1 carve-out: round-1 players stay in round 1 (no penalty).
  - No-pick cascade  : if you do not own a pick in the keeper round (e.g. you
                       traded it away), the cost moves up a round at a time
                       until it lands on a round where you do own a pick. A
                       "traded away" note is shown when this happens.
  - Undrafted players: kept in the final round.
  - No escalation    : the cost is always based only on last year's round.

Value uses a green-to-red gradient: deep green for big bargains, through neutral
near zero, to deep red for overpays (the stronger the color, the bigger the gap).

New seasons (no yearly edit needed)
-----------------------------------
Sleeper creates a NEW league id every season and only links them backwards, so
app.js keeps a starting "seed" id near the top:

  const SEED_LEAGUE_ID = "1248017523933196288";

On load the app walks the chain FORWARD from that seed (via league members'
accounts) to the most recent season whose draft is complete, and uses it
automatically. You normally never touch the seed. Specifically:

  - Before the new season's draft happens (e.g. right after you renew the
    league), it stays on the last completed draft - so it keeps working for
    planning the upcoming keepers.
  - Once the new season's draft is done, it advances to that season and uses
    the live rosters (including in-season trades) to look ahead to the next
    year's keepers.

The seed is only a fallback. The forward-walk result is cached for 24 hours, so
this discovery runs at most once a day.

Notes
-----
- ADP / Est. round: the app uses Sleeper's OWN average draft position (the same
  ADP behind Sleeper mock drafts), matched to your league's scoring. It is read
  live from Sleeper's GraphQL endpoint, cached for 12h, and refreshable with the
  "Refresh ADP" button. The estimated round = ADP / number of teams.
- If Sleeper ADP cannot be reached, rank falls back to Sleeper's search ranking.
- Requires an internet connection (it calls the Sleeper API).
