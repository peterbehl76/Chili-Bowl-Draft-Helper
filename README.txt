KEEPER DRAFT HELPER
===================

What it is
----------
A local web page that suggests keeper value for the Sleeper league
"Super Chili Bowl". Pick a team from the dropdown - listed as the team name
followed by its manager, or "manager + co-manager" for teams that share one -
and it lists that team's current roster with, for each player:

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

The "Don't suggest negative value" checkbox on the "Suggested keepers" line keeps
overpays out of the suggestions: a player whose keeper round costs more than his
projected draft round is not worth keeping, so he is skipped even if he is the
best player on the roster. Break-even (value 0) still counts. If every player on
your roster is an overpay, the section says so instead of suggesting one anyway.

It starts unchecked on every visit, so the suggestions you see first are the raw
ranking with nothing filtered out - tick the box when you want the overpays
dropped. The choice is not remembered between visits.

Suggested keepers also carry the same "traded away R<n> pick" note as the table,
so a keeper whose cost moved because you do not own that pick is flagged in both
places.

Below the keeper helper, a "Top available players" table lists the best players
not on any roster (by Sleeper rank), with rookies marked by an "R" badge.

How to use it
-------------
Double-click index.html. It opens in your browser and works on its own - no
install, no sign-in, nothing hosted online. Keep index.html, app.js, and
styles.css together in the same folder.

The first open downloads the player list from Sleeper (~15 MB, one time) and
caches it in your browser for 24 hours. Later opens are fast. The "ADP updated"
label (next to the Refresh button) shows when that cache was last filled. League
rosters, the draft, and trades are loaded fresh every visit, so in-season roster
moves show up automatically.

The "Refresh" button pulls the latest ADP AND re-checks the league itself -
which season's league is in use, who the managers are, who has a co-manager, and
who owns which picks. That league lookup is otherwise cached for 24 hours, so if
a manager is dropped, added, or given a co-manager mid-day, click Refresh to see
it immediately instead of waiting out the cache.

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
accounts) to the most recent season's league. You normally never touch the seed.

Two different leagues can be in play at once, because they answer two different
questions:

  - Rosters, managers, co-managers, team count and draft length come from the
    NEWEST league. That is what makes dropped managers disappear and new or
    added managers show up as soon as the league is renewed.
  - Last year's draft rounds - the basis for every keeper cost - come from the
    most recent league whose draft actually FINISHED.

Before the new season drafts, those are two different leagues (e.g. 2026 rosters
with keeper costs from the 2025 draft), and the header line says which is which.
Once the new season's draft completes, they become the same league again and the
app rolls forward to planning the season after that.

Pick ownership is merged from both leagues, because a pick traded during last
season is recorded on last season's league while one traded after the renewal is
recorded on the new one. Neither source alone is complete. This is safe because
Sleeper keeps a roster's id stable across a renewal - the franchise keeps its id
even when its manager changes.

The seed is only a fallback. The forward-walk result is cached for 24 hours, so
this discovery runs at most once a day (or on demand via Refresh).

Notes
-----
- ADP / Est. round: the app uses Sleeper's OWN average draft position (the same
  ADP behind Sleeper mock drafts), matched to your league's scoring. It is read
  live from Sleeper's GraphQL endpoint, cached for 12h, and refreshable with the
  "Refresh" button. The estimated round = ADP / number of teams.
- Mid-season it uses TODAY'S ADP. Sleeper only publishes a season's ADP during
  that season's preseason, so once our draft is done and the app is looking ahead
  to next year's keepers, next year's ADP does not exist yet. Rather than fall
  back to the much rougher search ranking, it uses the most recent published ADP
  and says so in the footer ("Using 2026 ADP - 2027 ADP is not published until
  that preseason"). It picks up the new ADP automatically once Sleeper posts it.
- If Sleeper ADP cannot be reached at all, rank falls back to Sleeper's search
  ranking.
- Team names come from the manager, not the team: Sleeper stores no team name on
  the roster itself, so when a manager is replaced the team's label changes to
  whatever the new manager uses (their Sleeper name until they set a team name).
  Nothing is lost - the roster, its players and its picks all carry over, because
  the app tracks franchises by roster id, not by manager.
- Requires an internet connection (it calls the Sleeper API).
