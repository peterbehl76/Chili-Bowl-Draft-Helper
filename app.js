/**
 * Keeper Draft Helper - Sleeper league keeper value suggestion utility.
 *
 * Runs fully client-side from a double-clicked index.html (no server, no auth).
 * Pick a team from the dropdown to see that roster with each player's last-year
 * draft round, this-year keeper round (penalty + carve-outs), estimated draft
 * round, and the resulting keeper value.
 *
 * NOTE: Sleeper creates a NEW league_id every season (linked only backward via
 * previous_league_id). SEED_LEAGUE_ID below is just a starting point: on load
 * the app walks the chain FORWARD to the most recent season's league and uses
 * that automatically (see resolveLeagues). You normally never need to touch the
 * seed; it is only the fallback if forward discovery finds nothing newer (e.g.
 * before next season's league has been created).
 *
 * Two leagues are in play once a season is renewed but not yet drafted: the
 * NEWEST league supplies managers, co-managers and rosters (so manager changes
 * show up), while the last DRAFT-COMPLETE league supplies the draft rounds that
 * keeper costs are calculated from.
 */

/** Seed Sleeper league id; the app auto-advances to the latest season from here. */
const SEED_LEAGUE_ID = "1248017523933196288";

/** Sleeper public API base. */
const SLEEPER = "https://api.sleeper.app/v1";

/** localStorage keys + TTL for the trimmed player map (full file is ~15 MB). */
const PLAYERS_CACHE_KEY = "khelper_players_v3";
const PLAYERS_CACHE_TS = "khelper_players_ts_v3";
const PLAYERS_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * localStorage keys + TTL for the resolved league pair (refreshed daily). v2
 * stores both ids, because the roster league and the draft league can differ.
 */
const RESOLVED_KEY = "khelper_resolved_v2";
const RESOLVED_SEED_KEY = "khelper_resolved_seed_v2";
const RESOLVED_TS_KEY = "khelper_resolved_ts_v2";
const RESOLVED_TTL_MS = 24 * 60 * 60 * 1000;

/** localStorage key for the value-vs-quality balance slider (0..1). */
const QUALITY_W_KEY = "khelper_quality_w_v1";

/** How many best-available players to show in the available table. */
const AVAILABLE_COUNT = 20;

/**
 * Sleeper's own ADP, read from season projections via their GraphQL endpoint.
 * That endpoint is CORS-open, so the browser calls it directly (no proxy), it
 * covers all players keyed by id, needs no key, and refreshes live.
 */
const SLEEPER_GQL = "https://sleeper.com/graphql";
const ADP_CACHE_KEY = "khelper_adp_v2";
const ADP_TS_KEY = "khelper_adp_ts_v2";
const ADP_TTL_MS = 12 * 60 * 60 * 1000;

/** In-memory state assembled on load. */
const state = {
  leagueName: "",
  season: 0, // season of the roster league (newest)
  draftSeason: 0, // season of the draft the keeper costs are based on
  nextSeason: 0, // the upcoming draft season that keepers are being set for
  numTeams: 0,
  numRounds: 0,
  players: {}, // pid -> { name, pos, team, rank }
  teams: [], // { rosterId, ownerId, teamName, managers: [name], players: [pid] }
  lastYearRound: {}, // pid -> round drafted in the basis draft
  picksOwned: {}, // rosterId -> { round -> count } for nextSeason
  currentRows: [], // analyzed rows for the selected roster
  currentRosterId: null, // the selected roster id (for pick-ownership checks)
  currentTopPids: new Set(), // pids of the suggested keepers (top 2 by value)
  sortState: { key: "value", dir: "desc" }, // active table sort
  leagueId: "", // resolved newest league id (rosters, managers, pick ownership)
  draftLeagueId: "", // league whose completed draft sets keeper costs
  advanced: false, // true if forward discovery moved past the seed league
  playersUpdatedAt: 0, // epoch ms the player rankings were last fetched
  qualityWeight: 0.5, // 0 = rank by surplus value, 1 = rank by player quality
  hideNegative: false, // when on, skip negative-value (overpay) players
  draftablePositions: new Set(), // positions this league actually rosters
  tradedPicksNext: [], // next-season traded pick entries (for who-traded-what)
  adpById: {}, // player_id -> Sleeper ADP (overall pick number)
  usingAdp: false, // true when Sleeper ADP loaded; false falls back to search_rank
  adpField: "adp_ppr", // which Sleeper ADP field matches this league
  adpSeason: 0, // season the loaded ADP came from (may trail nextSeason)
  adpUpdatedAt: 0, // epoch ms ADP was last fetched
};

/** Flex roster slots expanded to the real positions they can hold. */
const FLEX_SLOTS = {
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
  IDP_FLEX: ["DL", "LB", "DB"],
};

/** Roster slots that are not real on-field positions. */
const NON_POSITION_SLOTS = new Set(["BN", "IR", "TAXI"]);

/**
 * Derive the set of positions a league actually drafts from its roster slots,
 * expanding flex slots to the positions they can hold.
 *
 * @param {string[]} rosterPositions - the league's roster_positions array.
 * @returns {Set<string>} draftable positions.
 */
function derivePositions(rosterPositions) {
  const set = new Set();
  for (const slot of rosterPositions || []) {
    if (NON_POSITION_SLOTS.has(slot)) continue;
    if (FLEX_SLOTS[slot]) FLEX_SLOTS[slot].forEach((pos) => set.add(pos));
    else set.add(slot);
  }
  return set;
}

/**
 * Fetch JSON from a URL, throwing a readable error on failure.
 *
 * @param {string} url - the endpoint to fetch.
 * @returns {Promise<any>} parsed JSON body.
 */
async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error("Request failed (" + res.status + "): " + url);
    }
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Load the player map (pid -> name/pos/team/rank), using the trimmed
 * localStorage cache when it is fresh and re-downloading otherwise.
 *
 * @param {boolean} force - skip the cache and re-download.
 * @returns {Promise<Object>} the trimmed player map.
 */
async function loadPlayers(force) {
  if (!force) {
    try {
      const ts = Number(localStorage.getItem(PLAYERS_CACHE_TS) || 0);
      const cached = localStorage.getItem(PLAYERS_CACHE_KEY);
      if (cached && Date.now() - ts < PLAYERS_TTL_MS) {
        state.playersUpdatedAt = ts;
        return JSON.parse(cached);
      }
    } catch (err) {
      // Corrupt or oversized cache - fall through to a fresh download.
    }
  }

  setStatus("Downloading player rankings from Sleeper (one-time, ~15 MB)...");
  const raw = await fetchJson(SLEEPER + "/players/nfl");
  const downloadedAt = Date.now();

  // Trim to the few fields we need so it fits in localStorage.
  const trimmed = {};
  for (const pid in raw) {
    const player = raw[pid];
    const rank =
      typeof player.search_rank === "number" && player.search_rank < 9999990
        ? player.search_rank
        : null;
    trimmed[pid] = {
      name: player.full_name || (player.first_name + " " + player.last_name).trim() || pid,
      pos: player.position || "",
      team: player.team || "FA",
      rank: rank,
      rookie: player.years_exp === 0,
      active: player.active === true,
    };
  }

  state.playersUpdatedAt = downloadedAt;
  try {
    localStorage.setItem(PLAYERS_CACHE_KEY, JSON.stringify(trimmed));
    localStorage.setItem(PLAYERS_CACHE_TS, String(downloadedAt));
  } catch (err) {
    // Storage full or unavailable - keep using the in-memory copy this session.
  }
  return trimmed;
}

/**
 * POST a GraphQL query to Sleeper and return its data (with a timeout).
 *
 * @param {string} query - the GraphQL query string.
 * @param {number} timeoutMs - abort after this many ms.
 * @returns {Promise<Object>} the data object.
 */
async function fetchGraphQL(query, timeoutMs) {
  const controller = new AbortController();
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const res = await fetch(SLEEPER_GQL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error("GraphQL " + res.status);
    const json = await res.json();
    if (json.errors) throw new Error("GraphQL error");
    return json.data;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Pick the Sleeper ADP field that matches this league's format.
 *
 * @param {Object} league - the Sleeper league object.
 * @returns {string} an adp_* field name.
 */
function adpFieldFor(league) {
  const positions = league.roster_positions || [];
  const qbSlots = positions.filter((slot) => slot === "QB").length;
  if (positions.indexOf("SUPER_FLEX") !== -1 || qbSlots >= 2) return "adp_2qb";
  const rec = (league.scoring_settings && league.scoring_settings.rec) || 0;
  if (rec >= 1) return "adp_ppr";
  if (rec >= 0.5) return "adp_half_ppr";
  return "adp_std";
}

/**
 * Load Sleeper's ADP (player_id -> ADP) from season projections. Never rejects:
 * on any failure it returns an empty result so callers fall back to search_rank.
 *
 * @param {number} season - the draft season.
 * @param {string} adpField - the adp_* field to read.
 * @param {boolean} force - skip the cache.
 * @returns {Promise<{byId: Object, count: number}>} ADP data.
 */
async function loadAdp(season, adpField, force) {
  const cacheKey = ADP_CACHE_KEY + "_" + adpField + "_" + season;
  if (!force) {
    try {
      const ts = Number(localStorage.getItem(ADP_TS_KEY) || 0);
      const cached = localStorage.getItem(cacheKey);
      if (cached && Date.now() - ts < ADP_TTL_MS) {
        state.adpUpdatedAt = ts;
        return JSON.parse(cached);
      }
    } catch (err) {
      // Ignore cache issues and fetch fresh.
    }
  }

  try {
    const query =
      '{ season_stats(sport:"nfl", season:"' + season +
      '", season_type:"regular", category:"proj", order_by:"' + adpField +
      '", positions:["QB","RB","WR","TE","K","DEF"]){ player_id stats } }';
    const data = await fetchGraphQL(query, 12000);
    const rows = (data && data.season_stats) || [];
    const byId = {};
    for (const row of rows) {
      const adp = row.stats && row.stats[adpField];
      // Exclude the 999 "not really drafted" sentinel Sleeper uses for K/DEF etc.
      if (typeof adp === "number" && adp > 0 && adp < 900) byId[row.player_id] = adp;
    }
    const result = { byId: byId, count: Object.keys(byId).length };
    const now = Date.now();
    state.adpUpdatedAt = now;
    try {
      localStorage.setItem(cacheKey, JSON.stringify(result));
      localStorage.setItem(ADP_TS_KEY, String(now));
    } catch (err) {
      // Non-fatal cache write failure.
    }
    return result;
  } catch (err) {
    return { byId: {}, count: 0 };
  }
}

/**
 * Load ADP for the upcoming draft, falling back to the most recent season that
 * actually has ADP published.
 *
 * Sleeper only publishes a season's ADP during that season's preseason. Once our
 * draft is done the app looks ahead to NEXT year's keepers, and next year's ADP
 * does not exist yet - so asking only for the target season would find nothing
 * all season long and drop to the much rougher search_rank. Today's published
 * ADP is a real draft-value curve and a far better estimate, so use it.
 *
 * @param {number} targetSeason - the upcoming draft season.
 * @param {string} adpField - the adp_* field to read.
 * @param {boolean} force - skip the cache.
 * @returns {Promise<{byId: Object, count: number, season: number}>} ADP data
 *   plus the season it actually came from.
 */
async function loadAdpLatest(targetSeason, adpField, force) {
  // One year back is enough: the current season's ADP is always published.
  for (let season = targetSeason; season >= targetSeason - 1; season--) {
    const result = await loadAdp(season, adpField, force);
    if (result.count > 0) {
      return { byId: result.byId, count: result.count, season: season };
    }
  }
  return { byId: {}, count: 0, season: targetSeason };
}

/**
 * Attach loaded ADP onto the in-memory player objects (by id).
 */
function applyAdpToPlayers() {
  for (const pid in state.adpById) {
    if (state.players[pid]) state.players[pid].adp = state.adpById[pid];
  }
}

/**
 * The draft-value number for a player: Sleeper ADP when available, else
 * search_rank.
 *
 * @param {Object} player - a player object.
 * @returns {number|null} the value, or null if unknown.
 */
function rankValueOf(player) {
  if (state.usingAdp) return typeof player.adp === "number" ? player.adp : null;
  return typeof player.rank === "number" ? player.rank : null;
}

/**
 * Human-readable rank label for a player.
 *
 * @param {Object} player - a player object.
 * @returns {string} a label like "ADP 62.1" or "Sleeper rank #9".
 */
function rankLabelOf(player) {
  if (state.usingAdp) {
    return typeof player.adp === "number" ? "ADP " + player.adp.toFixed(1) : "no ADP";
  }
  return typeof player.rank === "number" ? "Sleeper rank #" + player.rank : "unranked";
}

/**
 * Short rank token for the available table's leading column.
 *
 * @param {Object} player - a player object.
 * @returns {string} e.g. "62.1" (ADP) or "#9" (rank), or "-".
 */
function rankShortOf(player) {
  if (state.usingAdp) {
    return typeof player.adp === "number" ? player.adp.toFixed(1) : "-";
  }
  return typeof player.rank === "number" ? "#" + player.rank : "-";
}

/**
 * Whether a league's draft has already happened (so it can serve as the base
 * for keeper math). Pre-draft and drafting leagues are not yet usable.
 *
 * @param {Object} league - a Sleeper league object.
 * @returns {boolean} true if the draft is complete.
 */
function draftDone(league) {
  return !!league && league.status !== "pre_draft" && league.status !== "drafting";
}

/**
 * Find the next-season league that chains back to a known league, by asking
 * each stable league member which of their leagues that season has the given
 * previous_league_id. Returns the matching league object, or null.
 *
 * @param {string[]} memberIds - stable user ids from the known league.
 * @param {number} season - the season to look in.
 * @param {string} prevId - the league id the next league should point back to.
 * @returns {Promise<Object|null>} the next league object, or null.
 */
async function findNextLeague(memberIds, season, prevId) {
  for (const uid of memberIds) {
    try {
      const leagues = await fetchJson(
        SLEEPER + "/user/" + uid + "/leagues/nfl/" + season
      );
      const match = leagues.find((lg) => lg.previous_league_id === prevId);
      if (match) return match;
    } catch (err) {
      // Skip this member (private/unavailable) and try the next one.
    }
  }
  return null;
}

/**
 * Walk forward from a seed league to the most recent season's league, and also
 * report the most recent league whose draft is complete. Sleeper only links
 * seasons backward, so we discover newer leagues via member accounts.
 *
 * The two can differ, and that difference matters: managers, co-managers and
 * rosters must come from the NEWEST league (so dropped/added managers show up),
 * while keeper costs must come from the last COMPLETED draft. Before the new
 * season drafts, those are two different leagues.
 *
 * @param {string} seedId - the seed league id.
 * @returns {Promise<{rosterLeague: Object, draftLeague: Object}>} the pair.
 */
async function resolveLeagues(seedId) {
  let league = await fetchJson(SLEEPER + "/league/" + seedId);
  let draftLeague = draftDone(league) ? league : null;

  let memberIds = [];
  try {
    const users = await fetchJson(SLEEPER + "/league/" + seedId + "/users");
    memberIds = users.map((usr) => usr.user_id);
  } catch (err) {
    return { rosterLeague: league, draftLeague: draftLeague || league };
  }

  const maxSeason = new Date().getFullYear() + 1; // allow next-year offseason
  let guard = 0;
  while (Number(league.season) < maxSeason && guard < 12) {
    guard++;
    const next = await findNextLeague(
      memberIds,
      Number(league.season) + 1,
      league.league_id
    );
    if (!next) break;
    // Always advance to the newer league so the manager list stays current;
    // remember the newest completed draft separately for keeper costs.
    league = next;
    if (draftDone(next)) draftLeague = next;
    try {
      const u2 = await fetchJson(SLEEPER + "/league/" + league.league_id + "/users");
      if (u2.length) memberIds = u2.map((usr) => usr.user_id);
    } catch (err) {
      // Keep the previous member list if the new one cannot be fetched.
    }
  }
  // No completed draft anywhere in the chain: fall back to the newest league so
  // the app still renders (every player simply reads as undrafted).
  return { rosterLeague: league, draftLeague: draftLeague || league };
}

/**
 * Resolve the league pair, using a 24h cache so forward discovery runs at most
 * once a day. The cache is keyed by seed so changing the seed re-resolves.
 *
 * @param {boolean} force - skip the cache and re-run forward discovery.
 * @returns {Promise<{rosterLeague: Object, draftLeague: Object}>} the pair.
 */
async function getLeagues(force) {
  if (!force) {
    try {
      const ts = Number(localStorage.getItem(RESOLVED_TS_KEY) || 0);
      const seed = localStorage.getItem(RESOLVED_SEED_KEY);
      const raw = localStorage.getItem(RESOLVED_KEY);
      if (raw && seed === SEED_LEAGUE_ID && Date.now() - ts < RESOLVED_TTL_MS) {
        const ids = JSON.parse(raw);
        if (ids && ids.rosterLeagueId && ids.draftLeagueId) {
          const [rosterLeague, draftLeague] = await Promise.all([
            fetchJson(SLEEPER + "/league/" + ids.rosterLeagueId),
            ids.draftLeagueId === ids.rosterLeagueId
              ? null
              : fetchJson(SLEEPER + "/league/" + ids.draftLeagueId),
          ]);
          if (rosterLeague && rosterLeague.league_id) {
            return { rosterLeague, draftLeague: draftLeague || rosterLeague };
          }
        }
      }
    } catch (err) {
      // Fall through to a fresh resolve on any cache/parse problem.
    }
  }

  const resolved = await resolveLeagues(SEED_LEAGUE_ID);
  try {
    localStorage.setItem(
      RESOLVED_KEY,
      JSON.stringify({
        rosterLeagueId: resolved.rosterLeague.league_id,
        draftLeagueId: resolved.draftLeague.league_id,
      })
    );
    localStorage.setItem(RESOLVED_SEED_KEY, SEED_LEAGUE_ID);
    localStorage.setItem(RESOLVED_TS_KEY, String(Date.now()));
  } catch (err) {
    // Non-fatal: we just will not have a cached pair next time.
  }
  return resolved;
}

/**
 * Load traded picks from both the roster league and the draft league and merge
 * them. A pick traded during last season is recorded on last season's league,
 * while one traded after the renewal lands on the new league, so neither source
 * alone is complete. A pick is identified by season + round + originating
 * roster; when both leagues know about one, the newer league wins because it
 * reflects any later re-trade. Safe to merge because roster ids are stable
 * across a renewal (the franchise keeps its id even if the manager changes).
 *
 * @param {string} rosterLeagueId - the newest league id.
 * @param {string} draftLeagueId - the last draft-complete league id.
 * @returns {Promise<Object[]>} merged traded-pick entries (all seasons).
 */
async function loadTradedPicks(rosterLeagueId, draftLeagueId) {
  const urls = [SLEEPER + "/league/" + rosterLeagueId + "/traded_picks"];
  if (draftLeagueId !== rosterLeagueId) {
    urls.push(SLEEPER + "/league/" + draftLeagueId + "/traded_picks");
  }

  const results = await Promise.all(
    urls.map((url) => fetchJson(url).catch(() => []))
  );

  // Insert oldest-league entries first so the newest league overwrites them.
  const merged = new Map();
  for (const list of results.slice().reverse()) {
    for (const tp of list || []) {
      merged.set(tp.season + "|" + tp.round + "|" + tp.roster_id, tp);
    }
  }
  return Array.from(merged.values());
}

/**
 * Fetch and assemble all league data into `state`.
 *
 * @param {boolean} force - re-resolve the league pair and re-fetch ADP, instead
 *   of using the 24h/12h caches. Used by the Refresh button so manager changes
 *   are picked up on demand.
 */
async function loadLeague(force) {
  setStatus("Loading league...");

  const { rosterLeague, draftLeague } = await getLeagues(force);
  const leagueId = rosterLeague.league_id;
  const draftLeagueId = draftLeague.league_id;

  state.leagueId = leagueId;
  state.draftLeagueId = draftLeagueId;
  state.advanced = leagueId !== SEED_LEAGUE_ID;
  state.leagueName = rosterLeague.name;
  state.season = Number(rosterLeague.season);
  state.draftSeason = Number(draftLeague.season);
  // The upcoming draft: this season's if it has not happened yet, else next.
  state.nextSeason = draftDone(rosterLeague) ? state.season + 1 : state.season;
  state.numTeams = rosterLeague.total_rosters;
  state.adpField = adpFieldFor(rosterLeague);

  // Rounds come from the UPCOMING draft (populated even while pre-draft);
  // last year's rounds come from the last COMPLETED draft.
  const upcomingDraftId = rosterLeague.draft_id;
  const basisDraftId = draftLeague.draft_id;

  // Sleeper endpoints, the cached player file, and Sleeper ADP load in parallel.
  const [players, users, rosters, draft, picks, tradedPicks, adp] = await Promise.all([
    loadPlayers(false),
    fetchJson(SLEEPER + "/league/" + leagueId + "/users"),
    fetchJson(SLEEPER + "/league/" + leagueId + "/rosters"),
    fetchJson(SLEEPER + "/draft/" + upcomingDraftId),
    fetchJson(SLEEPER + "/draft/" + basisDraftId + "/picks"),
    loadTradedPicks(leagueId, draftLeagueId),
    loadAdpLatest(state.nextSeason, state.adpField, force),
  ]);

  state.players = players;
  state.adpById = adp.byId;
  state.usingAdp = adp.count > 0;
  state.adpSeason = adp.season;
  applyAdpToPlayers();
  state.numRounds = (draft.settings && draft.settings.rounds) || 16;
  state.draftablePositions = derivePositions(rosterLeague.roster_positions);

  // Map owner -> display info.
  const userById = {};
  for (const usr of users) {
    const meta = usr.metadata || {};
    userById[usr.user_id] = {
      teamName: meta.team_name || usr.display_name || "Team",
      ownerName: usr.display_name || "",
    };
  }

  // Teams, sorted by team name for a stable dropdown. Sleeper has no
  // roster-level team name, so the label comes from the primary manager; the
  // roster_id is what actually identifies the franchise across seasons.
  state.teams = rosters
    .map((ros) => {
      const info = userById[ros.owner_id] || {
        teamName: "Roster " + ros.roster_id,
        ownerName: "",
      };
      // Primary manager first, then any co-managers.
      const managers = [];
      if (info.ownerName) managers.push(info.ownerName);
      for (const coId of ros.co_owners || []) {
        const co = userById[coId];
        if (co && co.ownerName && coId !== ros.owner_id) managers.push(co.ownerName);
      }
      return {
        rosterId: ros.roster_id,
        ownerId: ros.owner_id,
        teamName: info.teamName,
        managers: managers,
        players: ros.players || [],
      };
    })
    .sort((aTeam, bTeam) => aTeam.teamName.localeCompare(bTeam.teamName));

  // Last year's drafted round per player.
  state.lastYearRound = {};
  for (const pick of picks) {
    if (pick.player_id) {
      state.lastYearRound[pick.player_id] = pick.round;
    }
  }

  // Pick ownership for next season: every roster owns its own pick in each
  // round, then traded picks move that ownership to the acquiring roster.
  state.picksOwned = {};
  for (const ros of rosters) {
    const byRound = {};
    for (let rnd = 1; rnd <= state.numRounds; rnd++) {
      byRound[rnd] = 1;
    }
    state.picksOwned[ros.roster_id] = byRound;
  }
  const nextSeasonStr = String(state.nextSeason);
  state.tradedPicksNext = tradedPicks.filter((tp) => tp.season === nextSeasonStr);
  for (const tp of state.tradedPicksNext) {
    const orig = state.picksOwned[tp.roster_id];
    const dest = state.picksOwned[tp.owner_id];
    if (orig && orig[tp.round] != null) orig[tp.round] -= 1;
    if (dest && dest[tp.round] != null) dest[tp.round] += 1;
  }
}

/**
 * Display name for a roster id.
 *
 * @param {number} rosterId - the roster id.
 * @returns {string} the team name, or a fallback.
 */
function teamName(rosterId) {
  const team = state.teams.find((tm) => tm.rosterId === rosterId);
  return team ? team.teamName : "Roster " + rosterId;
}

/**
 * Whether a roster holds at least one pick in the given round next season.
 *
 * @param {number} rosterId - the roster to check.
 * @param {number} round - the draft round.
 * @returns {boolean} true if the roster owns a pick in that round.
 */
function ownsPick(rosterId, round) {
  const byRound = state.picksOwned[rosterId];
  return !!byRound && byRound[round] > 0;
}

/**
 * Estimated draft round from a draft-value number (Sleeper ADP, or search_rank
 * fallback), capped at the final round. Beyond it (or no value) is undrafted.
 *
 * @param {number|null} rank - ADP/rank number, or null.
 * @returns {number|null} estimated round, or null for undrafted.
 */
function estRoundFromRank(rank) {
  if (!rank) return null;
  const round = Math.ceil(rank / state.numTeams);
  return round > state.numRounds ? null : round;
}

/**
 * Non-linear draft-pick value in points: early rounds are worth
 * disproportionately more than later ones (a first-round talent far outweighs
 * a sixth-round one). Geometric decay with round 1 = 100. Used to balance
 * surplus value against player quality in the keeper score.
 *
 * @param {number} round - a draft round (1..numRounds, or numRounds+1 for UD).
 * @returns {number} the pick value in points.
 */
function pickValue(round) {
  const DECAY = 0.82;
  return 100 * Math.pow(DECAY, Math.max(1, round) - 1);
}

/**
 * Composite keeper score blending surplus value and player quality, weighted
 * by the balance slider (0 = pure surplus value, 1 = pure player quality).
 *
 * @param {Object} row - an analyzed player row.
 * @param {number} weight - quality weight from 0 to 1.
 * @returns {number} the keeper score.
 */
function keeperScore(row, weight) {
  return (1 - weight) * row.surplusPoints + weight * row.talentPoints;
}

/**
 * Compute the keeper analysis for one player on one roster.
 *
 * @param {number} rosterId - the keeping roster.
 * @param {string} pid - the Sleeper player id.
 * @returns {Object} keeper details for rendering.
 */
function analyzePlayer(rosterId, pid) {
  const player = state.players[pid] || { name: pid, pos: "", team: "", rank: null };
  const lastRound = state.lastYearRound[pid]; // undefined if undrafted last year
  const undrafted = lastRound === undefined;

  // Natural keeper round before the no-pick cascade.
  let natural;
  if (undrafted) {
    natural = state.numRounds; // undrafted -> final round
  } else if (lastRound <= 1) {
    natural = 1; // round-1 players stay round 1, no penalty
  } else {
    natural = lastRound - 1; // standard 1-round penalty
  }

  // Cascade upward (earlier rounds) while the roster lacks a pick there.
  let keeperRound = natural;
  const cascadedFrom = [];
  while (keeperRound > 1 && !ownsPick(rosterId, keeperRound)) {
    cascadedFrom.push(keeperRound);
    keeperRound -= 1;
  }
  const noRound1Pick = keeperRound === 1 && !ownsPick(rosterId, 1);

  // Estimated draft round this year from Sleeper rank, capped at the final round.
  const rankValue = rankValueOf(player);
  const estRound = estRoundFromRank(rankValue);
  const estForValue = estRound !== null ? estRound : state.numRounds + 1;
  const value = keeperRound - estForValue;

  // Points for the balanced keeper score (non-linear pick value).
  const talentPoints = pickValue(estForValue);
  const surplusPoints = talentPoints - pickValue(keeperRound);

  return {
    pid: pid,
    name: player.name,
    pos: player.pos,
    team: player.team,
    rank: player.rank,
    rankLabel: rankLabelOf(player),
    rookie: !!player.rookie,
    lastRound: lastRound,
    undrafted: undrafted,
    keeperRound: keeperRound,
    naturalRound: natural,
    cascadedFrom: cascadedFrom,
    noRound1Pick: noRound1Pick,
    estRound: estRound,
    value: value,
    talentPoints: talentPoints,
    surplusPoints: surplusPoints,
  };
}

/**
 * Continuous diverging color for a keeper value: green for good (positive),
 * red for overpay (negative), neutral near zero. Intensity scales with the
 * magnitude so the best and worst values read as the most vivid.
 *
 * @param {number} value - keeper value (keeper round - estimated round).
 * @returns {{color: string, bg: string}} text and background colors.
 */
function valueStyle(value) {
  const MAX = 8; // value magnitude treated as "fully saturated"
  if (Math.abs(value) < 0.5) {
    return { color: "var(--muted)", bg: "transparent" };
  }
  const mag = Math.min(1, Math.abs(value) / MAX);
  const hue = value > 0 ? 140 : 2; // green vs red
  const sat = Math.round(45 + mag * 45);
  const light = Math.round(72 - mag * 12); // stay bright enough to read on dark
  const alpha = (0.1 + mag * 0.26).toFixed(2);
  return {
    color: "hsl(" + hue + ", " + sat + "%, " + light + "%)",
    bg: "hsla(" + hue + ", " + sat + "%, " + light + "%, " + alpha + ")",
  };
}

/**
 * Star rating for an estimated round, flagging elite players independent of
 * any particular draft slot: round 1 = 3 stars, dropping half a star per
 * round (R2 = 2.5, R3 = 2, ... R6 = 0.5). Rounds 7+ and unranked earn none.
 *
 * @param {number|null} estRound - estimated draft round, or null if unranked.
 * @returns {number} rating from 0 to 3 in half-star steps.
 */
function starRating(estRound) {
  if (estRound === null) return 0;
  const rating = 3.5 - 0.5 * estRound;
  return rating > 0 ? rating : 0;
}

/**
 * Build the HTML for a 0-3 star widget with half-star fills.
 *
 * @param {number} rating - rating from 0 to 3 in half-star steps.
 * @returns {string} star widget markup.
 */
function renderStars(rating) {
  let html = '<span class="stars" title="' + rating + ' / 3">';
  for (let pos = 1; pos <= 3; pos++) {
    let fill = 0;
    if (rating >= pos) fill = 100;
    else if (rating >= pos - 0.5) fill = 50;
    html +=
      '<span class="star">★<span class="fg" style="width:' + fill + '%">★</span></span>';
  }
  return html + "</span>";
}

/** Render the team dropdown from loaded state. */
function renderTeamOptions() {
  const sel = document.getElementById("teamSelect");
  sel.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select your team...";
  sel.appendChild(placeholder);

  for (const team of state.teams) {
    const opt = document.createElement("option");
    opt.value = String(team.rosterId);
    const managers = team.managers || [];
    // A manager with no team name set would otherwise read "Name (Name)".
    const redundant = managers.length === 1 && managers[0] === team.teamName;
    const suffix = managers.length && !redundant ? " (" + managers.join(" + ") + ")" : "";
    opt.textContent = team.teamName + suffix;
    sel.appendChild(opt);
  }
  sel.disabled = false;
}

/**
 * Default sort direction for a column key (numeric-good columns descend).
 *
 * @param {string} key - the column sort key.
 * @returns {string} "asc" or "desc".
 */
function defaultSortDir(key) {
  return key === "value" ? "desc" : "asc";
}

/**
 * Compare two analyzed rows on a sort key (ascending). Undrafted/unranked
 * values sort to the end.
 *
 * @param {Object} aRow - first row.
 * @param {Object} bRow - second row.
 * @param {string} key - the column sort key.
 * @returns {number} comparison result.
 */
function compareRows(aRow, bRow, key) {
  switch (key) {
    case "name":
      return aRow.name.localeCompare(bRow.name);
    case "last":
      return (aRow.lastRound == null ? Infinity : aRow.lastRound) -
        (bRow.lastRound == null ? Infinity : bRow.lastRound);
    case "keeper":
      return aRow.keeperRound - bRow.keeperRound;
    case "est":
      return (aRow.estRound == null ? Infinity : aRow.estRound) -
        (bRow.estRound == null ? Infinity : bRow.estRound);
    case "value":
      return aRow.value - bRow.value;
    default:
      return 0;
  }
}

/**
 * Compute and render the roster table + keeper suggestion for a roster.
 * Stores the analyzed rows so re-sorting does not recompute the keeper math.
 *
 * @param {number} rosterId - the selected roster id.
 */
function renderRoster(rosterId) {
  const team = state.teams.find((tm) => tm.rosterId === rosterId);
  const section = document.getElementById("resultsSection");

  if (!team) {
    section.classList.add("hidden");
    return;
  }

  state.currentRosterId = rosterId;
  state.currentRows = team.players.map((pid) => analyzePlayer(rosterId, pid));
  section.classList.remove("hidden");
  applyScoring();
  renderDraftPicks(rosterId);
}

/**
 * Render the selected team's next-season draft picks as a grid, highlighting
 * rounds that were traded away (none) or accumulated (extra picks).
 *
 * @param {number} rosterId - the selected roster id.
 */
function renderDraftPicks(rosterId) {
  const section = document.getElementById("draftPicksSection");
  const grid = document.getElementById("draftPicksGrid");
  const note = document.getElementById("picksNote");
  const owned = state.picksOwned[rosterId];
  if (!section || !grid || !owned) {
    if (section) section.classList.add("hidden");
    return;
  }

  document.getElementById("picksTitle").textContent = "Your " + state.nextSeason + " draft picks";

  // Per-round trade detail: where your picks went, and whose picks you hold.
  const away = [];
  const acquired = [];
  const awayByRound = {};
  const acqByRound = {};
  for (const tp of state.tradedPicksNext) {
    if (tp.roster_id === rosterId && tp.owner_id !== rosterId) {
      const nm = teamName(tp.owner_id);
      away.push({ round: tp.round, team: nm });
      awayByRound[tp.round] = nm;
    }
    if (tp.owner_id === rosterId && tp.roster_id !== rosterId) {
      const nm = teamName(tp.roster_id);
      acquired.push({ round: tp.round, team: nm });
      (acqByRound[tp.round] = acqByRound[tp.round] || []).push(nm);
    }
  }
  away.sort((aPick, bPick) => aPick.round - bPick.round);
  acquired.sort((aPick, bPick) => aPick.round - bPick.round);

  grid.innerHTML = "";
  for (let rnd = 1; rnd <= state.numRounds; rnd++) {
    const count = owned[rnd] || 0;
    let cls = "pick-normal";
    let title = "Round " + rnd + ": 1 pick";
    if (count === 0) {
      cls = "pick-none";
      title = "Round " + rnd + ": traded to " + (awayByRound[rnd] || "another team");
    } else if (count > 1) {
      cls = "pick-extra";
      title =
        "Round " + rnd + ": " + count + " picks" +
        (acqByRound[rnd] ? " (incl. from " + acqByRound[rnd].join(", ") + ")" : "");
    }
    const badge = count !== 1 ? '<span class="pick-count">' + count + "</span>" : "";
    const cell = document.createElement("span");
    cell.className = "pick-cell " + cls;
    cell.title = title;
    cell.innerHTML = '<span class="pick-round">R' + rnd + "</span>" + badge;
    grid.appendChild(cell);
  }

  if (!away.length && !acquired.length) {
    note.innerHTML = "One pick in every round - nothing unusual.";
  } else {
    const lines = [];
    for (const pick of away) {
      lines.push(
        '<span class="pick-note-line"><span class="pick-out">Round ' + pick.round +
        "</span> traded to " + escapeHtml(pick.team) + "</span>"
      );
    }
    for (const pick of acquired) {
      lines.push(
        '<span class="pick-note-line"><span class="pick-in">Round ' + pick.round +
        "</span> acquired from " + escapeHtml(pick.team) + "</span>"
      );
    }
    note.innerHTML = lines.join("");
  }

  section.classList.remove("hidden");
}

/**
 * Pick the suggested keepers (top two by balanced keeper score), update the
 * suggestion banner, and render the table. Re-run when the balance slider
 * changes - it does not recompute the per-player keeper math.
 */
function applyScoring() {
  const suggestion = document.getElementById("suggestionBody");
  const rows = state.currentRows;
  const weight = state.qualityWeight;

  // Overpays (negative value) are normally not worth suggesting at all, so the
  // toggle filters them out of the candidate pool before ranking. Break-even
  // (value 0) still counts as a legitimate keep.
  const eligible = state.hideNegative ? rows.filter((row) => row.value >= 0) : rows;

  const byScore = eligible
    .slice()
    .sort((aRow, bRow) => keeperScore(bRow, weight) - keeperScore(aRow, weight));
  const topCount = Math.min(2, byScore.length);
  state.currentTopPids = new Set(byScore.slice(0, topCount).map((row) => row.pid));

  const top = byScore.slice(0, topCount);
  if (top.length) {
    const items = top.map((row) => {
      const sign = row.value > 0 ? "+" : "";
      const stars = renderStars(starRating(row.estRound));
      const vStyle = valueStyle(row.value);
      // Give the even-value case a visible grey pill instead of a lonely "0".
      const valueBg = vStyle.bg === "transparent" ? "rgba(138, 148, 163, 0.18)" : vStyle.bg;
      const rankTxt = row.rankLabel;
      return (
        '<span class="suggest-item">' +
        '<span class="suggest-info">' +
        '<span class="suggest-title"><span class="suggest-name">' +
        escapeHtml(row.name) + "</span>" + rookieBadge(row.rookie) + "</span>" +
        '<span class="player-meta">' + escapeHtml(row.pos) + " - " +
        escapeHtml(row.team) + " - " + rankTxt + "</span>" +
        "</span>" +
        '<span class="suggest-tags">' +
        '<span class="keeper-cluster">' +
        '<span class="keeper-chip">Round #' + row.keeperRound + "</span>" +
        keeperNoteHtml(row) +
        "</span>" +
        '<span class="value-cluster">' +
        '<span class="value-badge suggest-value" style="color:' + vStyle.color +
        ";background:" + valueBg + '">Value ' + sign + row.value + "</span>" +
        stars +
        "</span>" +
        "</span>" +
        "</span>"
      );
    });
    let html = items.join("");
    // Only warn about a same-round collision if you do not actually own enough
    // picks in that round (extra picks from trades make two keepers possible).
    if (top.length === 2 && top[0].keeperRound === top[1].keeperRound) {
      const round = top[0].keeperRound;
      const owned = (state.picksOwned[state.currentRosterId] || {})[round] || 0;
      if (owned < 2) {
        html +=
          '<span class="warn">Heads up: both land on round ' + round +
          " and you only have one pick there - you can keep just one of them at that round.</span>";
      } else {
        html +=
          '<span class="ok-note">Both land on round ' + round + ", and you have " +
          owned + " picks there - so you can keep both.</span>";
      }
    }
    suggestion.innerHTML = html;
  } else if (state.hideNegative && rows.length) {
    // Everyone on the roster costs more than they project to be drafted for.
    suggestion.innerHTML =
      '<span class="warn">No keeper is worth its cost - every player here ' +
      "projects to go later than his keeper round. Uncheck " +
      '"Don\'t suggest negative value" to see the closest calls anyway.</span>';
  } else {
    suggestion.textContent = "";
  }

  sortAndRenderBody();
}

/**
 * Sort the stored rows by the active sort state and render the table body.
 */
function sortAndRenderBody() {
  const rows = state.currentRows
    .slice()
    .sort((aRow, bRow) => compareRows(aRow, bRow, state.sortState.key));
  if (state.sortState.dir === "desc") rows.reverse();
  renderBody(rows, state.currentTopPids);
  updateSortIndicators();
}

/**
 * Render the table body rows.
 *
 * @param {Object[]} rows - rows in display order.
 * @param {Set<string>} topPids - pids to flag as suggested keepers.
 */
function renderBody(rows, topPids) {
  const body = document.getElementById("rosterBody");
  body.innerHTML = "";

  rows.forEach((row, idx) => {
    const tr = document.createElement("tr");
    if (topPids.has(row.pid)) tr.classList.add("is-top");

    const lastTxt = row.undrafted ? "UD" : "R" + row.lastRound;
    const estTxt = row.estRound !== null ? "R" + row.estRound : "UD";
    const rankTxt = row.rankLabel;
    const sign = row.value > 0 ? "+" : "";

    const vStyle = valueStyle(row.value);
    const rating = starRating(row.estRound);
    const starsHtml = rating > 0 ? "<br />" + renderStars(rating) : "";

    const keeperCell = "R" + row.keeperRound + keeperNoteHtml(row);

    const topBadge = topPids.has(row.pid) ? '<span class="top-badge">Top keeper</span>' : "";

    tr.innerHTML =
      '<td class="col-rank">' + (idx + 1) + "</td>" +
      "<td>" +
      '<span class="player-name">' + escapeHtml(row.name) + "</span>" + rookieBadge(row.rookie) + topBadge +
      '<br /><span class="player-meta">' + escapeHtml(row.pos) + " - " + escapeHtml(row.team) + " - " + rankTxt + "</span>" +
      "</td>" +
      '<td class="col-num">' + lastTxt + "</td>" +
      '<td class="col-num">' + keeperCell + "</td>" +
      '<td class="col-num">' + estTxt + starsHtml + "</td>" +
      '<td class="col-num"><span class="value-badge" style="color:' + vStyle.color +
      ";background:" + vStyle.bg + '">' + sign + row.value + "</span></td>";

    body.appendChild(tr);
  });
}

/**
 * Warning note for a keeper round that had to move because the roster does not
 * own the pick it would naturally cost. Shared by the roster table and the
 * suggestion banner so the two cannot drift apart.
 *
 * @param {Object} row - an analyzed player row.
 * @returns {string} note HTML, or an empty string when no note applies.
 */
function keeperNoteHtml(row) {
  if (row.cascadedFrom.length) {
    return '<span class="traded-note">traded away R' + row.cascadedFrom[0] + " pick</span>";
  }
  if (row.noRound1Pick) {
    return '<span class="traded-note">no R1 pick owned</span>';
  }
  return "";
}

/**
 * Rookie badge markup, or empty string for non-rookies.
 *
 * @param {boolean} isRookie - whether the player is a rookie.
 * @returns {string} badge HTML.
 */
function rookieBadge(isRookie) {
  return isRookie ? '<span class="rookie-badge" title="Rookie">R</span>' : "";
}

/**
 * Render the "Top available players" table: best unrostered players by Sleeper
 * rank, with estimated round, stars, and a rookie badge.
 */
function renderAvailable() {
  const body = document.getElementById("availableBody");
  if (!body) return;
  body.innerHTML = "";

  const rostered = new Set();
  for (const team of state.teams) {
    for (const pid of team.players) rostered.add(pid);
  }

  const avail = Object.keys(state.players)
    .map((pid) => Object.assign({ pid: pid }, state.players[pid]))
    .map((plr) => Object.assign(plr, { rankValue: rankValueOf(plr) }))
    .filter(
      (plr) =>
        plr.rankValue != null &&
        plr.team &&
        plr.team !== "FA" &&
        state.draftablePositions.has(plr.pos) &&
        !rostered.has(plr.pid)
    )
    .sort((aP, bP) => aP.rankValue - bP.rankValue)
    .slice(0, AVAILABLE_COUNT);

  avail.forEach((plr) => {
    const estRound = estRoundFromRank(plr.rankValue);
    const estTxt = estRound !== null ? "R" + estRound : "UD";
    const rating = starRating(estRound);
    const starsHtml = rating > 0 ? "<br />" + renderStars(rating) : "";
    const tr = document.createElement("tr");
    tr.innerHTML =
      '<td class="col-rank col-rank-wide">' + rankShortOf(plr) + "</td>" +
      "<td>" +
      '<span class="player-name">' + escapeHtml(plr.name) + "</span>" + rookieBadge(plr.rookie) +
      '<br /><span class="player-meta">' + escapeHtml(plr.pos) + " - " + escapeHtml(plr.team) + "</span>" +
      "</td>" +
      '<td class="col-num">' + estTxt + starsHtml + "</td>";
    body.appendChild(tr);
  });

  const header = document.getElementById("availableRankHeader");
  if (header) header.textContent = state.usingAdp ? "ADP" : "Rank";
  const sub = document.getElementById("availableSub");
  if (sub) {
    sub.textContent = state.usingAdp
      ? "Players not on any roster, by Sleeper ADP."
      : "Players not on any roster, by Sleeper rank (ADP unavailable).";
  }

  document.getElementById("availableSection").classList.remove("hidden");
}

/**
 * Reflect the active sort key/direction on the table headers.
 */
function updateSortIndicators() {
  const headers = document.querySelectorAll("th.sortable");
  headers.forEach((th) => {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === state.sortState.key) {
      th.classList.add(state.sortState.dir === "asc" ? "sort-asc" : "sort-desc");
    }
  });
}

/**
 * Wire click-to-sort onto the sortable column headers (once, at startup).
 */
function setupSortHandlers() {
  const headers = document.querySelectorAll("th.sortable");
  headers.forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (state.sortState.key === key) {
        state.sortState.dir = state.sortState.dir === "asc" ? "desc" : "asc";
      } else {
        state.sortState.key = key;
        state.sortState.dir = defaultSortDir(key);
      }
      if (state.currentRows.length) sortAndRenderBody();
    });
  });
}

/**
 * Escape a string for safe insertion into innerHTML.
 *
 * @param {string} str - raw text.
 * @returns {string} HTML-escaped text.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Show a status / error message in the main area.
 *
 * @param {string} msg - the message text.
 * @param {boolean} isError - render in the error style.
 */
function setStatus(msg, isError) {
  const el = document.getElementById("status");
  el.textContent = msg || "";
  el.classList.toggle("error", !!isError);
}

/**
 * Short human-friendly "time ago" for an epoch ms value.
 *
 * @param {number} ms - epoch milliseconds.
 * @returns {string} a relative time like "3h ago".
 */
function timeAgo(ms) {
  if (!ms) return "unknown";
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return mins + "m ago";
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h ago";
  return Math.floor(hrs / 24) + "d ago";
}

/**
 * Update the ADP-source label next to the refresh button.
 */
function updateRefreshInfo() {
  const el = document.getElementById("refreshInfo");
  if (!el) return;
  const ms = state.adpUpdatedAt;
  if (!state.usingAdp || !ms) {
    el.textContent = state.usingAdp ? "" : "ADP unavailable";
    el.removeAttribute("title");
    return;
  }
  el.textContent = "ADP updated " + timeAgo(ms);
  el.title = "Sleeper ADP, last fetched " + new Date(ms).toLocaleString();
}

/** Pending debounce timer for slider-driven re-scoring. */
let balanceTimer = null;

/**
 * Toggle the "updating" overlay over the roster table so the user gets
 * feedback (and cannot click mid-update) while suggestions recompute.
 *
 * @param {boolean} on - whether to show the updating state.
 */
function setUpdating(on) {
  const overlay = document.getElementById("updateOverlay");
  const results = document.getElementById("resultsSection");
  if (overlay) overlay.classList.toggle("hidden", !on);
  if (results) results.classList.toggle("is-updating", on);
}

/**
 * Load the saved balance weight and wire up the slider. Dragging shows a brief
 * loading overlay and debounces the (cheap) re-scoring so rapid drags do not
 * thrash the table.
 */
function setupBalanceSlider() {
  const slider = document.getElementById("balanceSlider");
  if (!slider) return;

  let saved = 0.5;
  try {
    const raw = parseFloat(localStorage.getItem(QUALITY_W_KEY));
    if (raw >= 0 && raw <= 1) saved = raw;
  } catch (err) {
    // Ignore unreadable storage and keep the balanced default.
  }
  state.qualityWeight = saved;
  slider.value = String(Math.round(saved * 100));

  slider.addEventListener("input", () => {
    state.qualityWeight = Number(slider.value) / 100;
    try {
      localStorage.setItem(QUALITY_W_KEY, String(state.qualityWeight));
    } catch (err) {
      // Non-fatal: preference just will not persist.
    }
    if (!state.currentRows.length) return;

    setUpdating(true);
    if (balanceTimer) clearTimeout(balanceTimer);
    balanceTimer = setTimeout(() => {
      applyScoring();
      setUpdating(false);
    }, 160);
  });
}

/**
 * Wire up the "don't suggest negative value" checkbox. Deliberately NOT
 * persisted: every page load starts unfiltered so the suggestions show the raw
 * ranking, and hiding overpays is an explicit per-visit choice. Re-scoring is
 * cheap, so it applies immediately with no debounce.
 */
function setupNegativeToggle() {
  const box = document.getElementById("hideNegative");
  if (!box) return;

  // The markup is the single source of truth for the starting state.
  state.hideNegative = box.checked;

  box.addEventListener("change", () => {
    state.hideNegative = box.checked;
    if (state.currentRows.length) applyScoring();
  });
}

/**
 * Render the page title, the season summary line, and the data-source footnote.
 * Called on load and again after a refresh, since a refresh can advance the
 * league to a new season or change the manager list.
 */
function renderHeader() {
  const pageTitle = state.leagueName + " - Draft Helper";
  document.getElementById("leagueName").textContent = pageTitle;
  document.title = pageTitle;

  // The roster season and the basis-draft season differ before a new draft.
  const basis =
    state.draftSeason === state.season
      ? "the " + state.season + " draft"
      : "the " + state.draftSeason + " draft";
  document.getElementById("seasonNote").textContent =
    "Keeper suggestions for " + state.nextSeason + " - based on current " +
    state.season + " rosters (including trades) and " + basis + " - " +
    state.numTeams + " teams, " + state.numRounds + " rounds" +
    (state.advanced ? " - auto-advanced to the latest season" : "");

  // Mid-season the target season's ADP does not exist yet, so we show today's.
  const adpAge =
    state.adpSeason === state.nextSeason
      ? ""
      : " Using " + state.adpSeason + " ADP - " + state.nextSeason +
        " ADP is not published until that preseason.";
  document.getElementById("dataNote").textContent = state.usingAdp
    ? "Rosters/draft/trades from the Sleeper API. Draft value uses Sleeper's " +
      "own ADP (" + state.adpField.replace("adp_", "").toUpperCase() +
      "), fetched live and cached for 12h." + adpAge
    : "Data from the Sleeper API. Sleeper ADP was unavailable, so rank falls " +
      "back to Sleeper's search ranking.";
}

/** Wire up the page and load the league. */
async function init() {
  setupSortHandlers();
  setupBalanceSlider();
  setupNegativeToggle();

  document.getElementById("teamSelect").addEventListener("change", (evt) => {
    const val = evt.target.value;
    const zero = document.getElementById("zeroState");
    if (val === "") {
      document.getElementById("resultsSection").classList.add("hidden");
      document.getElementById("draftPicksSection").classList.add("hidden");
      if (zero) zero.classList.remove("hidden");
      return;
    }
    if (zero) zero.classList.add("hidden");
    renderRoster(Number(val));
  });

  document.getElementById("refreshBtn").addEventListener("click", async () => {
    const btn = document.getElementById("refreshBtn");
    const sel = document.getElementById("teamSelect");
    const previous = sel.value;
    btn.disabled = true;
    try {
      setStatus("Refreshing league and ADP from Sleeper...");
      // Re-resolve the league too: managers can be dropped, added, or given a
      // co-manager between visits, and the resolved league is cached for 24h.
      await loadLeague(true);
      renderHeader();
      renderTeamOptions();
      renderAvailable();
      updateRefreshInfo();

      // Keep the user on the same franchise if it still exists.
      const stillThere = state.teams.some((tm) => String(tm.rosterId) === previous);
      if (previous !== "" && stillThere) {
        sel.value = previous;
        renderRoster(Number(previous));
      } else {
        sel.value = "";
        document.getElementById("resultsSection").classList.add("hidden");
        document.getElementById("draftPicksSection").classList.add("hidden");
        const zero = document.getElementById("zeroState");
        if (zero) zero.classList.remove("hidden");
      }
      setStatus(
        state.usingAdp ? "League and ADP refreshed." : "League refreshed, but ADP was unavailable.",
        !state.usingAdp
      );
    } catch (err) {
      setStatus("Could not refresh: " + err.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  try {
    await loadLeague(false);
    renderHeader();
    renderTeamOptions();
    renderAvailable();
    document.getElementById("rosterSection").classList.remove("hidden");
    document.getElementById("legend").classList.remove("hidden");
    updateRefreshInfo();
    setStatus("");
  } catch (err) {
    setStatus(
      "Could not load league data: " + err.message +
        " - check your internet connection and that the league id is correct.",
      true
    );
  }
}

document.addEventListener("DOMContentLoaded", init);
