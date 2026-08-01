const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT || 3000);
const BUZZ_WINDOW_MS = 300;
const BUZZ_OPEN_MS = 10000;
const FINAL_ANSWER_MS = 30000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'jeopardy.db');
const PUBLIC_URL = String(process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const GAME_PASSWORD = process.env.GAME_PASSWORD || '';
const AUTH_SECRET = process.env.AUTH_SECRET || GAME_PASSWORD;
const AUTH_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const JUDGE_RECONNECT_GRACE_MS = 10000;
const HOST_NOTICE_MS = 60000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const now = () => new Date().toISOString();
const roomCode = () => String(Math.floor(1000 + Math.random() * 9000));
const shuffle = (items) => items.map((value) => ({ value, sort: Math.random() })).sort((a, b) => a.sort - b.sort).map((item) => item.value);
const money = (value) => Number(value || 0);
const loginAttempts = new Map();
const tokenHash = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex');
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

function signAccessToken() {
  const payload = Buffer.from(JSON.stringify({ expiresAt: Date.now() + AUTH_MAX_AGE_MS })).toString('base64url');
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function validAccessToken(token) {
  if (!AUTH_SECRET || !token) return false;
  const [payload, signature] = String(token).split('.');
  if (!payload || !signature) return false;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).expiresAt > Date.now();
  } catch {
    return false;
  }
}

let runtime = {
  buzz: null,
  lockedOut: new Set(),
  lastError: '',
  allowRepeatOffer: false,
  finalAnswerEndsAt: null,
  finalTimer: null,
  finalRevealStep: 0,
  answerTimerEndsAt: null,
  answerTimer: null,
  answerTimedOut: false,
  dailyDoubleWagers: new Map()
};

let judgeLease = {
  tokenHash: null,
  socketId: null,
  releaseTimer: null,
  notice: null
};

const JUDGE_EVENTS = new Set([
  'game:create',
  'game:new',
  'game:start',
  'clue:select',
  'round:introNext',
  'round:continueFromSummary',
  'clue:showDailyDouble',
  'buzz:open',
  'buzz:close',
  'buzz:overrideWinner',
  'answer:startTimer',
  'answer:correct',
  'answer:incorrect',
  'clue:close',
  'score:adjust',
  'round:advance',
  'final:revealClue',
  'final:startTimer',
  'final:addTime',
  'final:judgeResponse',
  'final:nextReveal',
  'game:end'
]);
const PLAYER_JOIN_STATUSES = new Set([
  'lobby',
  'J_categories',
  'J',
  'J_complete',
  'DJ_categories',
  'DJ',
  'DJ_complete',
  'final_pity_vote',
  'final_wager',
  'final_clue',
  'final_answering',
  'final_judging'
]);

function currentHostNotice() {
  if (!judgeLease.notice || judgeLease.notice.endsAt <= Date.now()) {
    judgeLease.notice = null;
    return null;
  }
  return judgeLease.notice;
}

function sessionAcceptsPlayers(session) {
  return PLAYER_JOIN_STATUSES.has(session.status);
}

function setHostNotice(message) {
  judgeLease.notice = { message, endsAt: Date.now() + HOST_NOTICE_MS };
}

function resetRuntime() {
  clearBuzzTimers();
  if (runtime.finalTimer) clearTimeout(runtime.finalTimer);
  if (runtime.answerTimer) clearTimeout(runtime.answerTimer);
  runtime = {
    buzz: null,
    lockedOut: new Set(),
    lastError: '',
    allowRepeatOffer: false,
    finalAnswerEndsAt: null,
    finalTimer: null,
    finalRevealStep: 0,
    answerTimerEndsAt: null,
    answerTimer: null,
    answerTimedOut: false,
    dailyDoubleWagers: new Map()
  };
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS player_profile (
      profile_id INTEGER PRIMARY KEY AUTOINCREMENT,
      token_hash TEXT NOT NULL UNIQUE,
      current_display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS game_session (
      session_id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_code TEXT NOT NULL,
      status TEXT NOT NULL,
      current_round TEXT,
      active_player_id INTEGER,
      allow_repeated_categories INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS game_session_category (
      session_category_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES game_session(session_id),
      category_id INTEGER NOT NULL REFERENCES category(category_id),
      round TEXT NOT NULL CHECK (round IN ('J','DJ','FJ')),
      board_col INTEGER NOT NULL,
      category_name TEXT NOT NULL,
      source_air_date TEXT,
      UNIQUE(session_id, round, board_col)
    );
    CREATE TABLE IF NOT EXISTS game_session_clue (
      session_clue_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES game_session(session_id),
      clue_id INTEGER NOT NULL REFERENCES clue(clue_id),
      session_category_id INTEGER NOT NULL REFERENCES game_session_category(session_category_id),
      round TEXT NOT NULL CHECK (round IN ('J','DJ','FJ')),
      board_col INTEGER NOT NULL,
      row_in_category INTEGER NOT NULL,
      display_value INTEGER,
      is_daily_double INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'hidden',
      selected_by_player_id INTEGER,
      answered_by_player_id INTEGER,
      created_at TEXT NOT NULL,
      revealed_at TEXT,
      completed_at TEXT,
      UNIQUE(session_id, round, board_col, row_in_category)
    );
    CREATE TABLE IF NOT EXISTS player (
      player_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES game_session(session_id),
      display_name TEXT NOT NULL,
      score INTEGER NOT NULL DEFAULT 0,
      is_connected INTEGER NOT NULL DEFAULT 1,
      joined_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS buzz_event (
      buzz_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES game_session(session_id),
      session_clue_id INTEGER NOT NULL REFERENCES game_session_clue(session_clue_id),
      player_id INTEGER NOT NULL REFERENCES player(player_id),
      buzz_group_id TEXT NOT NULL,
      received_at TEXT NOT NULL,
      selected INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS score_event (
      score_event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES game_session(session_id),
      player_id INTEGER NOT NULL REFERENCES player(player_id),
      session_clue_id INTEGER,
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS final_response (
      final_response_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES game_session(session_id),
      player_id INTEGER NOT NULL REFERENCES player(player_id),
      wager INTEGER NOT NULL,
      response_text TEXT,
      is_correct INTEGER,
      submitted_at TEXT,
      judged_at TEXT,
      UNIQUE(session_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS pity_vote (
      pity_vote_id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES game_session(session_id),
      target_player_id INTEGER NOT NULL REFERENCES player(player_id),
      voter_player_id INTEGER NOT NULL REFERENCES player(player_id),
      vote TEXT NOT NULL CHECK (vote IN ('yes','no')),
      created_at TEXT NOT NULL,
      UNIQUE(session_id, target_player_id, voter_player_id)
    );
  `);
  const finalColumns = db.prepare("PRAGMA table_info(final_response)").all().map((column) => column.name);
  if (!finalColumns.includes('draft_text')) {
    db.exec('ALTER TABLE final_response ADD COLUMN draft_text TEXT');
  }
  const playerColumns = db.prepare("PRAGMA table_info(player)").all().map((column) => column.name);
  if (!playerColumns.includes('profile_id')) {
    db.exec('ALTER TABLE player ADD COLUMN profile_id INTEGER REFERENCES player_profile(profile_id)');
  }
  const legacyPlayers = db.prepare('SELECT player_id, display_name, joined_at FROM player WHERE profile_id IS NULL').all();
  const createLegacyProfile = db.prepare(`
    INSERT INTO player_profile (token_hash, current_display_name, created_at, last_seen_at)
    VALUES (?, ?, ?, ?)
  `);
  const attachLegacyProfile = db.prepare('UPDATE player SET profile_id = ? WHERE player_id = ?');
  for (const player of legacyPlayers) {
    const token = crypto.randomBytes(32).toString('hex');
    const profile = createLegacyProfile.run(tokenHash(token), player.display_name, player.joined_at, now());
    attachLegacyProfile.run(profile.lastInsertRowid, player.player_id);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_player_session_profile ON player(session_id, profile_id)');
}

function activeSession() {
  let session = db.prepare('SELECT * FROM game_session ORDER BY session_id DESC LIMIT 1').get();
  if (!session) {
    const info = db.prepare("INSERT INTO game_session (room_code, status, created_at) VALUES (?, 'lobby', ?)").run(roomCode(), now());
    session = db.prepare('SELECT * FROM game_session WHERE session_id = ?').get(info.lastInsertRowid);
  }
  return session;
}

function currentSession() {
  return activeSession();
}

function getLeaderboard(room = null) {
  return db.prepare(`
    WITH completed_players AS (
      SELECT p.profile_id, p.display_name, p.score, p.session_id,
             DENSE_RANK() OVER (PARTITION BY p.session_id ORDER BY p.score DESC) AS place
      FROM player p
      JOIN game_session gs ON gs.session_id = p.session_id
      WHERE gs.status = 'complete'
        AND gs.started_at IS NOT NULL
        AND p.profile_id IS NOT NULL
        AND (? IS NULL OR gs.room_code = ?)
    )
    SELECT pp.profile_id,
           pp.current_display_name AS display_name,
           COUNT(cp.session_id) AS games_played,
           COALESCE(SUM(CASE WHEN cp.place = 1 THEN 1 ELSE 0 END), 0) AS wins,
           COALESCE(SUM(CASE WHEN cp.place = 1 THEN cp.score ELSE 0 END), 0) AS cash_winnings,
           COALESCE(MAX(CASE WHEN cp.place = 1 THEN cp.score END), 0) AS best_win
    FROM player_profile pp
    JOIN completed_players cp ON cp.profile_id = pp.profile_id
    GROUP BY pp.profile_id
    ORDER BY wins DESC, cash_winnings DESC, pp.current_display_name
  `).all(room, room);
}

function freshRoomCode() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = roomCode();
    if (!db.prepare('SELECT 1 FROM game_session WHERE room_code = ? LIMIT 1').get(candidate)) return candidate;
  }
  throw new Error('Could not generate a new room code. Try again.');
}

function profileFromToken(profileToken) {
  if (!profileToken) return null;
  return db.prepare('SELECT * FROM player_profile WHERE token_hash = ?').get(tokenHash(profileToken)) || null;
}

function joinProfileToSession(profile, session, displayName) {
  const cleanName = String(displayName || profile.current_display_name || '').trim().slice(0, 24);
  if (!cleanName) throw new Error('Enter a display name.');
  db.prepare('UPDATE player_profile SET current_display_name = ?, last_seen_at = ? WHERE profile_id = ?')
    .run(cleanName, now(), profile.profile_id);
  let player = db.prepare('SELECT * FROM player WHERE session_id = ? AND profile_id = ?').get(session.session_id, profile.profile_id);
  if (!player) {
    const info = db.prepare(`
      INSERT INTO player (session_id, profile_id, display_name, joined_at)
      VALUES (?, ?, ?, ?)
    `).run(session.session_id, profile.profile_id, cleanName, now());
    player = db.prepare('SELECT * FROM player WHERE player_id = ?').get(info.lastInsertRowid);
  } else {
    db.prepare('UPDATE player SET display_name = ?, is_connected = 1 WHERE player_id = ?').run(cleanName, player.player_id);
    player = { ...player, display_name: cleanName, is_connected: 1 };
  }
  return player;
}

function socketPlayer(socket, sessionId = currentSession().session_id) {
  if (!socket.data.profileId) return null;
  return db.prepare('SELECT * FROM player WHERE session_id = ? AND profile_id = ?')
    .get(sessionId, socket.data.profileId) || null;
}

function restorePlayer(socket) {
  if (socket.data.requestedRole !== 'player') return null;
  const profileToken = String(socket.handshake.auth?.profileToken || '');
  const profile = profileFromToken(profileToken);
  if (!profile) return null;
  const session = currentSession();
  const existingPlayer = db.prepare('SELECT * FROM player WHERE session_id = ? AND profile_id = ?')
    .get(session.session_id, profile.profile_id);
  const playedInRoom = db.prepare(`
    SELECT 1
    FROM player p
    JOIN game_session gs ON gs.session_id = p.session_id
    WHERE p.profile_id = ? AND gs.room_code = ?
    LIMIT 1
  `).get(profile.profile_id, session.room_code);
  if (!existingPlayer && (!playedInRoom || !sessionAcceptsPlayers(session))) return null;
  if (!existingPlayer && getPlayers(session.session_id).length >= 8) return null;
  const player = joinProfileToSession(profile, session, profile.current_display_name);
  socket.data.profileId = profile.profile_id;
  socket.emit('player:rejoined', {
    playerId: player.player_id,
    displayName: player.display_name,
    sessionId: session.session_id
  });
  return player;
}

function getPlayers(sessionId) {
  return db.prepare('SELECT * FROM player WHERE session_id = ? ORDER BY joined_at, player_id').all(sessionId);
}

function getCategories(sessionId, round) {
  return db.prepare('SELECT * FROM game_session_category WHERE session_id = ? AND round = ? ORDER BY board_col').all(sessionId, round);
}

function getClues(sessionId, round) {
  return db.prepare(`
    SELECT gsc.*, c.clue_text, c.correct_response
    FROM game_session_clue gsc
    JOIN clue c ON c.clue_id = gsc.clue_id
    WHERE gsc.session_id = ? AND gsc.round = ?
    ORDER BY gsc.board_col, gsc.row_in_category
  `).all(sessionId, round);
}

function getFinal(sessionId) {
  const category = db.prepare('SELECT * FROM game_session_category WHERE session_id = ? AND round = ? LIMIT 1').get(sessionId, 'FJ');
  const clue = db.prepare(`
    SELECT gsc.*, c.clue_text, c.correct_response
    FROM game_session_clue gsc JOIN clue c ON c.clue_id = gsc.clue_id
    WHERE gsc.session_id = ? AND gsc.round = 'FJ' LIMIT 1
  `).get(sessionId);
  const responses = db.prepare('SELECT * FROM final_response WHERE session_id = ?').all(sessionId);
  return { category, clue, responses };
}

function getFinalRevealRows(sessionId) {
  const players = getPlayers(sessionId);
  const responses = db.prepare('SELECT * FROM final_response WHERE session_id = ?').all(sessionId);
  const responseMap = new Map(responses.map((response) => [response.player_id, response]));
  return players.map((player) => {
    const response = responseMap.get(player.player_id);
    const finalDelta = response && response.is_correct !== null ? response.wager * (response.is_correct ? 1 : -1) : 0;
    const appliedDelta = db.prepare(`
      SELECT COALESCE(SUM(delta), 0) AS delta
      FROM score_event
      WHERE session_id = ?
        AND player_id = ?
        AND reason IN ('final_correct', 'final_incorrect')
    `).get(sessionId, player.player_id).delta;
    const preFinalScore = player.score - appliedDelta;
    return {
      player,
      response,
      preFinalScore,
      finalScore: preFinalScore + finalDelta,
      finalDelta
    };
  }).sort((a, b) => a.preFinalScore - b.preFinalScore || a.player.display_name.localeCompare(b.player.display_name));
}

function finalScoreAlreadyApplied(sessionId, playerId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM score_event
    WHERE session_id = ?
      AND player_id = ?
      AND reason IN ('final_correct', 'final_incorrect')
  `).get(sessionId, playerId);
  return row.count > 0;
}

function applyFinalScoreForReveal(sessionId, row) {
  if (!row?.response || row.response.is_correct === null || row.response.is_correct === undefined) return;
  if (finalScoreAlreadyApplied(sessionId, row.player.player_id)) return;
  const reason = row.response.is_correct ? 'final_correct' : 'final_incorrect';
  scorePlayer(sessionId, row.player.player_id, null, row.finalDelta, reason);
}

function completeSession(session) {
  if (session.status === 'final_results') {
    for (const row of getFinalRevealRows(session.session_id)) {
      applyFinalScoreForReveal(session.session_id, row);
    }
  }
  db.prepare("UPDATE game_session SET status = 'complete', completed_at = COALESCE(completed_at, ?) WHERE session_id = ?")
    .run(now(), session.session_id);
}

function lowestScorePlayer(sessionId) {
  return db.prepare('SELECT * FROM player WHERE session_id = ? ORDER BY score ASC, joined_at ASC, player_id ASC LIMIT 1').get(sessionId);
}

function clueDatabaseReady() {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_schema
    WHERE type = 'table' AND name = 'clue'
  `).get());
}

function bootstrapState(session, role) {
  return {
    session,
    databaseReady: false,
    isJudge: role === 'judge',
    judgeStatus: { occupied: Boolean(judgeLease.tokenHash) },
    hostNotice: currentHostNotice(),
    joinUrl: `${PUBLIC_URL}/?room=${session.room_code}`,
    qrUrl: `/api/qr?room=${session.room_code}`,
    players: getPlayers(session.session_id),
    leaderboard: getLeaderboard(),
    roomLeaderboard: getLeaderboard(session.room_code),
    categories: [],
    clues: [],
    activeClue: null,
    activePlayer: null,
    buzz: null,
    finalAnswerEndsAt: null,
    finalRevealStep: 0,
    finalRevealRows: [],
    answerTimerEndsAt: null,
    answerTimedOut: false,
    dailyDoubleWager: null,
    lockedOut: [],
    final: { category: null, clue: null, responses: [] },
    pity: { candidates: [], voters: [] },
    lastError: 'The clue database has not been installed yet.',
    allowRepeatOffer: false
  };
}

function publicState(role = 'player', profileId = null) {
  const session = currentSession();
  if (!clueDatabaseReady()) return bootstrapState(session, role);
  const round = session.current_round || 'J';
  const activeClue = db.prepare(`
    SELECT gsc.*, c.clue_text, c.correct_response
    FROM game_session_clue gsc JOIN clue c ON c.clue_id = gsc.clue_id
    WHERE gsc.session_id = ? AND gsc.status IN ('revealed','buzzing','daily_double','final')
    ORDER BY gsc.revealed_at DESC LIMIT 1
  `).get(session.session_id);
  const pityCandidates = getPlayers(session.session_id).filter((p) => p.score <= 0);
  const voters = getPlayers(session.session_id).filter((p) => p.score > 0);
  const judge = role === 'judge';
  const screen = role === 'screen';
  const revealFinalResponses = ['final_results', 'complete'].includes(session.status);
  const redactClue = (clue) => clue ? {
    ...clue,
    ...(judge ? {} : { correct_response: undefined })
  } : clue;
  const final = getFinal(session.session_id);
  if (!judge) {
    final.clue = redactClue(final.clue);
    final.responses = final.responses.map((response) => {
      const belongsToPlayer = profileId && getPlayers(session.session_id)
        .some((player) => player.profile_id === profileId && player.player_id === response.player_id);
      if (screen && revealFinalResponses) return response;
      if (belongsToPlayer) return { ...response, is_correct: revealFinalResponses ? response.is_correct : undefined };
      return {
        player_id: response.player_id,
        submitted_at: response.submitted_at,
        response_text: revealFinalResponses ? response.response_text : undefined,
        wager: revealFinalResponses ? response.wager : undefined,
        is_correct: revealFinalResponses ? response.is_correct : undefined
      };
    });
  }
  const revealRows = getFinalRevealRows(session.session_id).map((row) => {
    if (judge || screen && session.status === 'final_results') return row;
    return { player: row.player, preFinalScore: row.preFinalScore, finalScore: row.finalScore };
  });
  return {
    session,
    databaseReady: true,
    isJudge: judge,
    judgeStatus: { occupied: Boolean(judgeLease.tokenHash) },
    hostNotice: currentHostNotice(),
    joinUrl: `${PUBLIC_URL}/?room=${session.room_code}`,
    qrUrl: `/api/qr?room=${session.room_code}`,
    players: getPlayers(session.session_id),
    leaderboard: getLeaderboard(),
    roomLeaderboard: getLeaderboard(session.room_code),
    categories: getCategories(session.session_id, round),
    clues: getClues(session.session_id, round).map(redactClue),
    activeClue: redactClue(activeClue),
    activePlayer: session.active_player_id ? db.prepare('SELECT * FROM player WHERE player_id = ?').get(session.active_player_id) : null,
    buzz: runtime.buzz ? {
      open: runtime.buzz.open,
      groupId: runtime.buzz.groupId,
      selectedPlayerId: runtime.buzz.selectedPlayerId,
      group: runtime.buzz.group,
      closesAt: runtime.buzz.closesAt
    } : null,
    finalAnswerEndsAt: runtime.finalAnswerEndsAt,
    finalRevealStep: runtime.finalRevealStep,
    finalRevealRows: revealRows,
    answerTimerEndsAt: runtime.answerTimerEndsAt,
    answerTimedOut: runtime.answerTimedOut,
    dailyDoubleWager: activeClue ? runtime.dailyDoubleWagers.get(activeClue.session_clue_id) || null : null,
    lockedOut: [...runtime.lockedOut],
    final,
    pity: { candidates: pityCandidates, voters },
    lastError: runtime.lastError,
    allowRepeatOffer: runtime.allowRepeatOffer
  };
}

function emitState() {
  for (const socket of io.sockets.sockets.values()) {
    if (!socket.data.authenticated) continue;
    socket.emit('state:update', publicState(socket.data.role, socket.data.profileId));
  }
}

function selectCompleteCategories(round, count, allowRepeats) {
  return db.prepare(`
    SELECT c.category_id
    FROM category c
    JOIN clue cl ON cl.category_id = c.category_id
    WHERE c.round = ?
      AND (? = 1 OR c.category_id NOT IN (SELECT category_id FROM used_category))
      AND TRIM(c.name) <> ''
    GROUP BY c.category_id
    HAVING COUNT(cl.clue_id) = ?
       AND SUM(CASE WHEN TRIM(cl.clue_text) = '' THEN 1 ELSE 0 END) = 0
       AND SUM(CASE WHEN TRIM(cl.correct_response) = '' THEN 1 ELSE 0 END) = 0
    ORDER BY RANDOM()
    LIMIT ?;
  `).all(round, allowRepeats ? 1 : 0, round === 'FJ' ? 1 : 5, count);
}

function dailyDoubleKeys(round) {
  const count = round === 'J' ? 1 : 2;
  const columns = shuffle([1, 2, 3, 4, 5, 6]).slice(0, count);
  return new Set(columns.map((col) => `${col}:${shuffle([2, 3, 4])[0]}`));
}

function createBoard(sessionId, allowRepeats) {
  const j = selectCompleteCategories('J', 6, allowRepeats);
  const dj = selectCompleteCategories('DJ', 6, allowRepeats);
  const fj = selectCompleteCategories('FJ', 1, allowRepeats);
  if (j.length < 6 || dj.length < 6 || fj.length < 1) {
    throw new Error('Not enough unused complete categories remain.');
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM final_response WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM pity_vote WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM buzz_event WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM game_session_clue WHERE session_id = ?').run(sessionId);
    db.prepare('DELETE FROM game_session_category WHERE session_id = ?').run(sessionId);

    const categoryRows = [
      ...j.map((row, i) => ({ ...row, round: 'J', board_col: i + 1 })),
      ...dj.map((row, i) => ({ ...row, round: 'DJ', board_col: i + 1 })),
      { ...fj[0], round: 'FJ', board_col: 1 }
    ];
    const insertCat = db.prepare(`
      INSERT INTO game_session_category (session_id, category_id, round, board_col, category_name, source_air_date)
      SELECT ?, c.category_id, ?, ?, c.name, e.air_date
      FROM category c JOIN episode e ON e.game_id = c.game_id
      WHERE c.category_id = ?
    `);
    const insertClue = db.prepare(`
      INSERT INTO game_session_clue
        (session_id, clue_id, session_category_id, round, board_col, row_in_category, display_value, is_daily_double, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const markUsed = db.prepare('INSERT OR IGNORE INTO used_category (category_id, used_at) VALUES (?, ?)');
    const clueRows = db.prepare('SELECT * FROM clue WHERE category_id = ? ORDER BY row_in_category');
    const jDds = dailyDoubleKeys('J');
    const djDds = dailyDoubleKeys('DJ');

    for (const cat of categoryRows) {
      const info = insertCat.run(sessionId, cat.round, cat.board_col, cat.category_id);
      markUsed.run(cat.category_id, now());
      for (const clue of clueRows.all(cat.category_id)) {
        const value = cat.round === 'J' ? clue.row_in_category * 200 : cat.round === 'DJ' ? clue.row_in_category * 400 : null;
        const ddSet = cat.round === 'J' ? jDds : djDds;
        insertClue.run(
          sessionId,
          clue.clue_id,
          info.lastInsertRowid,
          cat.round,
          cat.board_col,
          clue.row_in_category,
          value,
          ddSet.has(`${cat.board_col}:${clue.row_in_category}`) ? 1 : 0,
          now()
        );
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function scorePlayer(sessionId, playerId, clueId, delta, reason) {
  db.prepare('UPDATE player SET score = score + ? WHERE player_id = ? AND session_id = ?').run(delta, playerId, sessionId);
  db.prepare('INSERT INTO score_event (session_id, player_id, session_clue_id, delta, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(sessionId, playerId, clueId || null, delta, reason, now());
}

function dailyDoubleScoreValue(activeClue, wager) {
  const storedWager = runtime.dailyDoubleWagers.get(activeClue.session_clue_id);
  const submittedWager = Number(wager);
  const value = storedWager || (Number.isFinite(submittedWager) && submittedWager > 0 ? submittedWager : null);
  return money(value || activeClue.display_value);
}

function dailyDoubleMaxWager(activeClue, player) {
  const roundMaximum = activeClue.round === 'DJ' ? 2000 : 1000;
  return Math.max(roundMaximum, money(player?.score));
}

function clearBuzzTimers(buzz = runtime.buzz) {
  if (buzz?.selectionTimer) clearTimeout(buzz.selectionTimer);
  if (buzz?.closeTimer) clearTimeout(buzz.closeTimer);
}

function openBuzzing(activeClue) {
  clearBuzzTimers();
  runtime.buzz = {
    open: true,
    groupId: crypto.randomUUID(),
    group: [],
    selectedPlayerId: null,
    selectionTimer: null,
    closeTimer: null,
    closesAt: Date.now() + BUZZ_OPEN_MS
  };
  runtime.buzz.closeTimer = setTimeout(() => {
    if (!runtime.buzz?.open) return;
    runtime.buzz.open = false;
    runtime.buzz.closeTimer = null;
    runtime.buzz.closesAt = null;
    emitState();
  }, BUZZ_OPEN_MS);
  runtime.answerTimedOut = false;
  db.prepare("UPDATE game_session_clue SET status = 'buzzing' WHERE session_clue_id = ?")
    .run(activeClue.session_clue_id);
}

function scheduleFinalAnswerLock(sessionId) {
  if (runtime.finalTimer) clearTimeout(runtime.finalTimer);
  const remainingMs = Math.max(0, runtime.finalAnswerEndsAt - Date.now());
  runtime.finalTimer = setTimeout(() => lockFinalAnswers(sessionId), remainingMs);
}

function allRoundCluesComplete(sessionId, round) {
  const row = db.prepare("SELECT COUNT(*) AS remaining FROM game_session_clue WHERE session_id = ? AND round = ? AND status <> 'completed'").get(sessionId, round);
  return row.remaining === 0;
}

function closeActiveClue() {
  const active = publicState().activeClue;
  if (!active) return;
  db.prepare("UPDATE game_session_clue SET status = 'completed', completed_at = ? WHERE session_clue_id = ?").run(now(), active.session_clue_id);
  clearBuzzTimers();
  runtime.buzz = null;
  runtime.lockedOut = new Set();
  runtime.answerTimerEndsAt = null;
  runtime.answerTimedOut = false;
  if (runtime.answerTimer) clearTimeout(runtime.answerTimer);
  runtime.answerTimer = null;
}

function finalEligiblePlayers(sessionId) {
  return getPlayers(sessionId).filter((p) => p.score > 0);
}

function finalAllJudged(sessionId) {
  const eligible = finalEligiblePlayers(sessionId);
  if (!eligible.length) return false;
  const judged = db.prepare('SELECT COUNT(*) AS count FROM final_response WHERE session_id = ? AND is_correct IS NOT NULL').get(sessionId).count;
  return judged >= eligible.length;
}

function lockFinalAnswers(sessionId) {
  const session = db.prepare('SELECT * FROM game_session WHERE session_id = ?').get(sessionId);
  if (!session || session.status !== 'final_answering') return;
  db.prepare(`
    UPDATE final_response
    SET response_text = COALESCE(NULLIF(response_text, ''), draft_text, ''),
        submitted_at = COALESCE(submitted_at, ?)
    WHERE session_id = ?
  `).run(now(), sessionId);
  db.prepare("UPDATE game_session SET status = 'final_judging' WHERE session_id = ?").run(sessionId);
  runtime.finalAnswerEndsAt = null;
  runtime.finalTimer = null;
  emitState();
}

function processPityIfReady(sessionId) {
  const players = getPlayers(sessionId);
  const voters = players.filter((p) => p.score > 0);
  const candidates = players.filter((p) => p.score <= 0);
  if (!voters.length) {
    db.prepare("UPDATE game_session SET status = 'complete', completed_at = ? WHERE session_id = ?").run(now(), sessionId);
    return;
  }
  for (const candidate of candidates) {
    const votes = db.prepare('SELECT vote, COUNT(*) AS count FROM pity_vote WHERE session_id = ? AND target_player_id = ? GROUP BY vote').all(sessionId, candidate.player_id);
    const total = votes.reduce((sum, v) => sum + v.count, 0);
    if (total < voters.length) return;
    const yes = votes.find((v) => v.vote === 'yes')?.count || 0;
    if (yes > voters.length / 2) scorePlayer(sessionId, candidate.player_id, null, 1 - candidate.score, 'pity_reset');
  }
  db.prepare("UPDATE game_session SET status = 'final_wager', current_round = 'FJ' WHERE session_id = ?").run(sessionId);
}

function advanceAfterRound(sessionId) {
  const session = currentSession();
  if (session.current_round === 'J' && allRoundCluesComplete(sessionId, 'J')) {
    db.prepare("UPDATE game_session SET status = 'J_complete' WHERE session_id = ?").run(sessionId);
  } else if (session.current_round === 'DJ' && allRoundCluesComplete(sessionId, 'DJ')) {
    db.prepare("UPDATE game_session SET status = 'DJ_complete' WHERE session_id = ?").run(sessionId);
  }
}

function continueFromRoundSummary(sessionId) {
  const session = currentSession();
  if (session.status === 'J_complete') {
    const lastPlace = lowestScorePlayer(sessionId);
    db.prepare("UPDATE game_session SET status = 'DJ_categories', current_round = 'DJ', active_player_id = ? WHERE session_id = ?").run(lastPlace?.player_id || null, sessionId);
    return;
  }
  if (session.status === 'DJ_complete') {
    const players = getPlayers(sessionId);
    const positives = players.filter((p) => p.score > 0);
    if (!positives.length) {
      runtime.lastError = 'At least one player needs a positive score to play Final GREGPARDY.';
      return;
    }
    runtime.lastError = '';
    db.prepare("UPDATE game_session SET status = 'final_wager', current_round = 'FJ' WHERE session_id = ?").run(sessionId);
  }
}

migrate();
activeSession();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/api/qr', async (req, res) => {
  const session = currentSession();
  const requestedRoom = String(req.query.room || '');
  if (requestedRoom !== session.room_code) return res.status(404).send('Room not found');
  try {
    const svg = await QRCode.toString(`${PUBLIC_URL}/?room=${session.room_code}`, {
      type: 'svg',
      margin: 1,
      color: { dark: '#101114', light: '#ffffff' }
    });
    res.type('image/svg+xml').send(svg);
  } catch {
    res.status(500).send('Could not generate QR code');
  }
});
app.get('/screen', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'screen.html')));
app.get('/player', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));
app.get('/judge', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'judge.html')));

function assignJudge(socket, judgeToken, { takeover = false } = {}) {
  const presentedHash = tokenHash(judgeToken);
  const existingSocket = judgeLease.socketId ? io.sockets.sockets.get(judgeLease.socketId) : null;
  const reclaiming = Boolean(judgeToken && judgeLease.tokenHash && safeEqual(presentedHash, judgeLease.tokenHash));

  if (judgeLease.tokenHash && !reclaiming && !takeover) {
    socket.emit('judge:claimDenied');
    return false;
  }

  if (existingSocket && existingSocket.id !== socket.id) {
    existingSocket.data.role = 'spectator';
    existingSocket.emit('judge:revoked', 'Another device has taken over as host/judge.');
  }

  if (judgeLease.releaseTimer) clearTimeout(judgeLease.releaseTimer);
  const issuedToken = reclaiming ? judgeToken : crypto.randomBytes(32).toString('base64url');
  judgeLease.tokenHash = tokenHash(issuedToken);
  judgeLease.socketId = socket.id;
  judgeLease.releaseTimer = null;
  socket.data.role = 'judge';
  socket.emit('judge:claimed', { judgeToken: issuedToken });

  if (takeover && !reclaiming) {
    setHostNotice('THE JUDGE/HOST HAS CHANGED!');
  }
  emitState();
  return true;
}

function restoreJudge(socket) {
  if (socket.data.requestedRole !== 'judge') return false;
  const judgeToken = String(socket.handshake.auth?.judgeToken || '');
  if (!judgeToken || !judgeLease.tokenHash || !safeEqual(tokenHash(judgeToken), judgeLease.tokenHash)) return false;
  return assignJudge(socket, judgeToken);
}

io.on('connection', (socket) => {
  const requestedRole = String(socket.handshake.auth?.role || 'player');
  socket.data.requestedRole = ['screen', 'judge', 'player'].includes(requestedRole) ? requestedRole : 'player';
  socket.data.role = socket.data.requestedRole === 'judge' ? 'spectator' : socket.data.requestedRole;
  socket.data.authenticated = validAccessToken(socket.handshake.auth?.accessToken);
  socket.data.profileId = null;

  socket.use(([event], next) => {
    if (event === 'auth:login') return next();
    if (!socket.data.authenticated) {
      socket.emit('auth:required');
      return next(new Error('Authentication required'));
    }
    if (JUDGE_EVENTS.has(event) && socket.data.role !== 'judge') {
      socket.emit('error:message', 'Only the active host/judge can do that.');
      return next(new Error('Judge authorization required'));
    }
    return next();
  });

  socket.on('auth:login', ({ password } = {}) => {
    const address = socket.handshake.address || 'unknown';
    const recentAttempts = (loginAttempts.get(address) || []).filter((attemptedAt) => Date.now() - attemptedAt < LOGIN_WINDOW_MS);
    if (recentAttempts.length >= LOGIN_MAX_ATTEMPTS) {
      loginAttempts.set(address, recentAttempts);
      return socket.emit('auth:error', 'Too many password attempts. Try again in a few minutes.');
    }
    if (!GAME_PASSWORD || !safeEqual(password, GAME_PASSWORD)) {
      recentAttempts.push(Date.now());
      loginAttempts.set(address, recentAttempts);
      return socket.emit('auth:error', 'That password is not correct.');
    }
    loginAttempts.delete(address);
    socket.data.authenticated = true;
    const accessToken = signAccessToken();
    socket.emit('auth:authenticated', { accessToken });
    restoreJudge(socket);
    restorePlayer(socket);
    socket.emit('state:update', publicState(socket.data.role, socket.data.profileId));
  });

  if (socket.data.authenticated) {
    restoreJudge(socket);
    restorePlayer(socket);
    socket.emit('state:update', publicState(socket.data.role, socket.data.profileId));
  } else {
    socket.emit('auth:required');
  }

  socket.on('judge:claim', ({ judgeToken, takeover = false } = {}) => {
    if (socket.data.requestedRole !== 'judge') return;
    assignJudge(socket, String(judgeToken || ''), { takeover: Boolean(takeover) });
  });

  socket.on('game:create', ({ roomCode: requestedCode } = {}) => {
    const cleanCode = String(requestedCode || '').trim();
    if (cleanCode && !/^\d{4}$/.test(cleanCode)) {
      return socket.emit('error:message', 'Room codes must contain exactly four digits.');
    }
    const previous = currentSession();
    if (previous.status !== 'complete') completeSession(previous);
    const nextRoomCode = cleanCode || freshRoomCode();
    const info = db.prepare("INSERT INTO game_session (room_code, status, created_at) VALUES (?, 'lobby', ?)")
      .run(nextRoomCode, now());
    resetRuntime();
    db.prepare("UPDATE player SET is_connected = 0 WHERE session_id <> ?").run(info.lastInsertRowid);
    emitState();
  });

  socket.on('game:new', () => {
    const previous = currentSession();
    if (previous.status !== 'complete') completeSession(previous);
    db.prepare("INSERT INTO game_session (room_code, status, created_at) VALUES (?, 'lobby', ?)")
      .run(previous.room_code, now());
    resetRuntime();
    emitState();
  });

  socket.on('player:join', ({ roomCode: enteredCode, displayName, profileToken }) => {
    const session = currentSession();
    if (String(enteredCode || '').trim() !== session.room_code) return socket.emit('error:message', 'That room code is not active.');
    if (!sessionAcceptsPlayers(session)) return socket.emit('error:message', 'This game is not accepting players.');
    const cleanName = String(displayName || '').trim().slice(0, 24);
    if (!cleanName) return socket.emit('error:message', 'Enter a display name.');
    let profile = profileFromToken(profileToken);
    let issuedProfileToken = null;
    if (!profile) {
      if (getPlayers(session.session_id).length >= 8) return socket.emit('error:message', 'This room already has 8 players.');
      issuedProfileToken = crypto.randomBytes(32).toString('base64url');
      const info = db.prepare(`
        INSERT INTO player_profile (token_hash, current_display_name, created_at, last_seen_at)
        VALUES (?, ?, ?, ?)
      `).run(tokenHash(issuedProfileToken), cleanName, now(), now());
      profile = db.prepare('SELECT * FROM player_profile WHERE profile_id = ?').get(info.lastInsertRowid);
    } else if (!db.prepare('SELECT 1 FROM player WHERE session_id = ? AND profile_id = ?').get(session.session_id, profile.profile_id)
      && getPlayers(session.session_id).length >= 8) {
      return socket.emit('error:message', 'This room already has 8 players.');
    }
    const player = joinProfileToSession(profile, session, cleanName);
    socket.data.profileId = profile.profile_id;
    socket.emit('player:joined', {
      playerId: player.player_id,
      profileToken: issuedProfileToken || profileToken,
      displayName: cleanName,
      sessionId: session.session_id
    });
    emitState();
  });

  socket.on('player:rejoin', ({ profileToken }) => {
    const session = currentSession();
    const profile = profileFromToken(profileToken);
    if (!profile) return socket.emit('player:rejoinFailed');
    if (!db.prepare('SELECT 1 FROM player WHERE session_id = ? AND profile_id = ?').get(session.session_id, profile.profile_id)
      && getPlayers(session.session_id).length >= 8) {
      return socket.emit('error:message', 'This room already has 8 players.');
    }
    const player = joinProfileToSession(profile, session, profile.current_display_name);
    socket.data.profileId = profile.profile_id;
    socket.emit('player:rejoined', {
      playerId: player.player_id,
      displayName: player.display_name,
      sessionId: session.session_id
    });
    emitState();
  });

  socket.on('disconnect', () => {
    const player = socketPlayer(socket);
    if (player) db.prepare('UPDATE player SET is_connected = 0 WHERE player_id = ?').run(player.player_id);
    if (judgeLease.socketId === socket.id) {
      judgeLease.socketId = null;
      if (judgeLease.releaseTimer) clearTimeout(judgeLease.releaseTimer);
      judgeLease.releaseTimer = setTimeout(() => {
        if (judgeLease.socketId) return;
        judgeLease.tokenHash = null;
        judgeLease.releaseTimer = null;
        setHostNotice('THE HOST/JUDGE HAS DISCONNECTED');
        emitState();
      }, JUDGE_RECONNECT_GRACE_MS);
      emitState();
    }
  });

  socket.on('game:start', ({ allowRepeats = false } = {}) => {
    const session = currentSession();
    if (getPlayers(session.session_id).length < 2) return socket.emit('error:message', 'GREGPARDY! needs at least 2 players.');
    try {
      createBoard(session.session_id, !!allowRepeats);
      const first = shuffle(getPlayers(session.session_id))[0];
      db.prepare("UPDATE game_session SET status = 'J_categories', current_round = 'J', active_player_id = ?, allow_repeated_categories = ?, started_at = ? WHERE session_id = ?")
        .run(first.player_id, allowRepeats ? 1 : 0, now(), session.session_id);
      runtime.lastError = '';
      runtime.allowRepeatOffer = false;
      emitState();
    } catch (error) {
      runtime.lastError = error.message;
      runtime.allowRepeatOffer = true;
      socket.emit('error:message', error.message);
      emitState();
    }
  });

  socket.on('clue:select', ({ sessionClueId }) => {
    const session = currentSession();
    const clue = db.prepare('SELECT * FROM game_session_clue WHERE session_id = ? AND session_clue_id = ?').get(session.session_id, Number(sessionClueId));
    if (!clue || clue.status === 'completed') return;
    const status = clue.is_daily_double ? 'daily_double' : 'revealed';
    db.prepare('UPDATE game_session_clue SET status = ?, selected_by_player_id = ?, revealed_at = ? WHERE session_clue_id = ?')
      .run(status, session.active_player_id, now(), clue.session_clue_id);
    clearBuzzTimers();
    runtime.buzz = null;
    runtime.lockedOut = new Set();
    emitState();
  });

  socket.on('round:introNext', () => {
    const session = currentSession();
    if (session.status === 'J_categories') db.prepare("UPDATE game_session SET status = 'J' WHERE session_id = ?").run(session.session_id);
    if (session.status === 'DJ_categories') db.prepare("UPDATE game_session SET status = 'DJ' WHERE session_id = ?").run(session.session_id);
    emitState();
  });

  socket.on('round:continueFromSummary', () => {
    const session = currentSession();
    continueFromRoundSummary(session.session_id);
    emitState();
  });

  socket.on('clue:showDailyDouble', ({ wager } = {}) => {
    const state = publicState();
    if (!state.activeClue?.is_daily_double || state.activeClue.status !== 'daily_double') return;
    const maxWager = dailyDoubleMaxWager(state.activeClue, state.activePlayer);
    const value = Math.max(5, Math.min(money(wager || state.activeClue.display_value), maxWager));
    runtime.dailyDoubleWagers.set(state.activeClue.session_clue_id, value);
    db.prepare("UPDATE game_session_clue SET status = 'revealed' WHERE session_clue_id = ?").run(state.activeClue.session_clue_id);
    emitState();
  });

  socket.on('buzz:open', () => {
    const state = publicState();
    if (!state.activeClue) return;
    openBuzzing(state.activeClue);
    emitState();
  });

  socket.on('buzz:close', () => {
    clearBuzzTimers();
    if (runtime.buzz) {
      runtime.buzz.open = false;
      runtime.buzz.selectionTimer = null;
      runtime.buzz.closeTimer = null;
      runtime.buzz.closesAt = null;
    }
    emitState();
  });

  socket.on('buzz:submit', ({ playerId }) => {
    const state = publicState();
    const authenticatedPlayer = socketPlayer(socket, state.session.session_id);
    const id = authenticatedPlayer?.player_id;
    if (!id || Number(playerId) !== id) {
      return socket.emit('buzz:rejected', { reason: 'Your player connection needs to be restored.' });
    }
    if (!state.activeClue) return socket.emit('buzz:rejected', { reason: 'There is no active clue.' });
    if (!runtime.buzz?.open) return socket.emit('buzz:rejected', { reason: 'Buzzing is closed or that buzz arrived too late.' });
    if (runtime.lockedOut.has(id)) return socket.emit('buzz:rejected', { reason: 'You are locked out for this clue.' });
    if (!state.players.some((p) => p.player_id === id)) {
      return socket.emit('buzz:rejected', { reason: 'You are not joined to this game.' });
    }
    if (runtime.buzz.group.some((p) => p.playerId === id)) {
      return socket.emit('buzz:rejected', { reason: 'Your buzz was already received.' });
    }
    runtime.buzz.group.push({ playerId: id, receivedAt: now() });
    socket.emit('buzz:received');
    if (!runtime.buzz.selectionTimer) {
      runtime.buzz.selectionTimer = setTimeout(() => {
        const picked = shuffle(runtime.buzz.group)[0];
        if (runtime.buzz.closeTimer) clearTimeout(runtime.buzz.closeTimer);
        runtime.buzz.open = false;
        runtime.buzz.selectedPlayerId = picked.playerId;
        runtime.buzz.selectionTimer = null;
        runtime.buzz.closeTimer = null;
        runtime.buzz.closesAt = null;
        const insert = db.prepare('INSERT INTO buzz_event (session_id, session_clue_id, player_id, buzz_group_id, received_at, selected) VALUES (?, ?, ?, ?, ?, ?)');
        for (const buzz of runtime.buzz.group) {
          insert.run(state.session.session_id, state.activeClue.session_clue_id, buzz.playerId, runtime.buzz.groupId, buzz.receivedAt, buzz.playerId === picked.playerId ? 1 : 0);
        }
        io.emit('buzz:winner', { playerId: picked.playerId });
        emitState();
      }, BUZZ_WINDOW_MS);
    }
    emitState();
  });

  socket.on('buzz:overrideWinner', ({ playerId }) => {
    if (!runtime.buzz) return;
    clearBuzzTimers();
    runtime.buzz.open = false;
    runtime.buzz.selectedPlayerId = Number(playerId);
    runtime.buzz.selectionTimer = null;
    runtime.buzz.closeTimer = null;
    runtime.buzz.closesAt = null;
    emitState();
  });

  socket.on('answer:startTimer', () => {
    const state = publicState();
    if (!state.activeClue || !runtime.buzz?.selectedPlayerId) return;
    if (runtime.answerTimer) clearTimeout(runtime.answerTimer);
    runtime.answerTimerEndsAt = Date.now() + 5000;
    runtime.answerTimer = setTimeout(() => {
      runtime.answerTimerEndsAt = null;
      runtime.answerTimer = null;
      runtime.answerTimedOut = true;
      io.emit('answer:timerDone');
      emitState();
    }, 5000);
    emitState();
  });

  socket.on('answer:correct', ({ playerId, wager }) => {
    const state = publicState();
    if (!state.activeClue) return;
    const id = Number(playerId || runtime.buzz?.selectedPlayerId || state.session.active_player_id);
    const delta = state.activeClue.is_daily_double ? dailyDoubleScoreValue(state.activeClue, wager) : money(state.activeClue.display_value);
    if (runtime.answerTimer) clearTimeout(runtime.answerTimer);
    runtime.answerTimer = null;
    runtime.answerTimerEndsAt = null;
    runtime.answerTimedOut = false;
    scorePlayer(state.session.session_id, id, state.activeClue.session_clue_id, delta, state.activeClue.is_daily_double ? 'daily_double_correct' : 'clue_correct');
    db.prepare("UPDATE game_session SET active_player_id = ? WHERE session_id = ?").run(id, state.session.session_id);
    closeActiveClue(state.session.session_id);
    advanceAfterRound(state.session.session_id);
    emitState();
  });

  socket.on('answer:incorrect', ({ playerId, wager }) => {
    const state = publicState();
    if (!state.activeClue) return;
    const id = Number(playerId || runtime.buzz?.selectedPlayerId || state.session.active_player_id);
    const delta = -(state.activeClue.is_daily_double ? dailyDoubleScoreValue(state.activeClue, wager) : money(state.activeClue.display_value));
    if (runtime.answerTimer) clearTimeout(runtime.answerTimer);
    runtime.answerTimer = null;
    runtime.answerTimerEndsAt = null;
    runtime.answerTimedOut = false;
    scorePlayer(state.session.session_id, id, state.activeClue.session_clue_id, delta, state.activeClue.is_daily_double ? 'daily_double_incorrect' : 'clue_incorrect');
    db.prepare('UPDATE game_session_clue SET answered_by_player_id = ? WHERE session_clue_id = ?').run(id, state.activeClue.session_clue_id);
    runtime.lockedOut.add(id);
    if (state.activeClue.is_daily_double) {
      closeActiveClue(state.session.session_id);
      advanceAfterRound(state.session.session_id);
    } else if (state.players.some((player) => !runtime.lockedOut.has(player.player_id))) {
      openBuzzing(state.activeClue);
    } else if (runtime.buzz) {
      clearBuzzTimers();
      runtime.buzz = {
        ...runtime.buzz,
        open: false,
        selectedPlayerId: null,
        selectionTimer: null,
        closeTimer: null,
        closesAt: null
      };
    }
    emitState();
  });

  socket.on('clue:close', () => {
    const state = publicState();
    closeActiveClue(state.session.session_id);
    advanceAfterRound(state.session.session_id);
    emitState();
  });

  socket.on('score:adjust', ({ playerId, delta }) => {
    const session = currentSession();
    scorePlayer(session.session_id, Number(playerId), null, Number(delta), 'manual_adjustment');
    emitState();
  });

  socket.on('round:advance', () => {
    const session = currentSession();
    if (session.status === 'J') db.prepare("UPDATE game_session SET status = 'J_complete' WHERE session_id = ?").run(session.session_id);
    else if (session.status === 'J_complete') continueFromRoundSummary(session.session_id);
    else if (session.status === 'DJ') db.prepare("UPDATE game_session SET status = 'DJ_complete' WHERE session_id = ?").run(session.session_id);
    else if (session.status === 'DJ_complete') continueFromRoundSummary(session.session_id);
    emitState();
  });

  socket.on('pity:submitVote', ({ voterPlayerId, targetPlayerId, vote }) => {
    const session = currentSession();
    const authenticatedPlayer = socketPlayer(socket, session.session_id);
    if (!authenticatedPlayer || authenticatedPlayer.player_id !== Number(voterPlayerId)) return;
    const cleanVote = vote === 'yes' ? 'yes' : 'no';
    db.prepare('INSERT OR REPLACE INTO pity_vote (session_id, target_player_id, voter_player_id, vote, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(session.session_id, Number(targetPlayerId), Number(voterPlayerId), cleanVote, now());
    processPityIfReady(session.session_id);
    emitState();
  });

  socket.on('final:submitWager', ({ playerId, wager }) => {
    const session = currentSession();
    const player = socketPlayer(socket, session.session_id);
    if (!player || player.player_id !== Number(playerId)) return;
    if (!player || player.score <= 0) return;
    const cleanWager = Math.max(0, Math.min(Number(wager), player.score));
    db.prepare('INSERT OR REPLACE INTO final_response (session_id, player_id, wager, submitted_at) VALUES (?, ?, ?, ?)')
      .run(session.session_id, player.player_id, cleanWager, now());
    emitState();
  });

  socket.on('final:saveDraft', ({ playerId, responseText }) => {
    const session = currentSession();
    if (session.status !== 'final_answering') return;
    const player = socketPlayer(socket, session.session_id);
    if (!player || player.player_id !== Number(playerId)) return;
    db.prepare('UPDATE final_response SET draft_text = ? WHERE session_id = ? AND player_id = ?')
      .run(String(responseText || '').trim().slice(0, 300), session.session_id, Number(playerId));
  });

  socket.on('final:revealClue', () => {
    const session = currentSession();
    if (runtime.finalTimer) clearTimeout(runtime.finalTimer);
    runtime.finalAnswerEndsAt = null;
    runtime.finalRevealStep = 0;
    db.prepare("UPDATE game_session SET status = 'final_clue' WHERE session_id = ?").run(session.session_id);
    db.prepare("UPDATE game_session_clue SET status = 'final', revealed_at = ? WHERE session_id = ? AND round = 'FJ'").run(now(), session.session_id);
    emitState();
  });

  socket.on('final:startTimer', () => {
    const session = currentSession();
    if (session.status !== 'final_clue') return;
    runtime.finalAnswerEndsAt = Date.now() + FINAL_ANSWER_MS;
    db.prepare("UPDATE game_session SET status = 'final_answering' WHERE session_id = ?").run(session.session_id);
    scheduleFinalAnswerLock(session.session_id);
    emitState();
  });

  socket.on('final:addTime', () => {
    const session = currentSession();
    if (session.status !== 'final_answering' || !runtime.finalAnswerEndsAt) return;
    runtime.finalAnswerEndsAt = Math.max(Date.now(), runtime.finalAnswerEndsAt) + 10000;
    scheduleFinalAnswerLock(session.session_id);
    emitState();
  });

  socket.on('final:submitResponse', ({ playerId, responseText }) => {
    const session = currentSession();
    const player = socketPlayer(socket, session.session_id);
    if (!player || player.player_id !== Number(playerId)) return;
    if (session.status !== 'final_answering') return socket.emit('error:message', 'Final answers are locked.');
    if (runtime.finalAnswerEndsAt && Date.now() > runtime.finalAnswerEndsAt) {
      lockFinalAnswers(session.session_id);
      return socket.emit('error:message', 'Final answers are locked.');
    }
    db.prepare('UPDATE final_response SET response_text = ?, submitted_at = COALESCE(submitted_at, ?) WHERE session_id = ? AND player_id = ?')
      .run(String(responseText || '').trim().slice(0, 300), now(), session.session_id, Number(playerId));
    emitState();
  });

  socket.on('final:judgeResponse', ({ playerId, isCorrect }) => {
    const session = currentSession();
    const response = db.prepare('SELECT * FROM final_response WHERE session_id = ? AND player_id = ?').get(session.session_id, Number(playerId));
    if (!response || response.is_correct !== null) return;
    db.prepare('UPDATE final_response SET is_correct = ?, judged_at = ? WHERE final_response_id = ?').run(isCorrect ? 1 : 0, now(), response.final_response_id);
    if (finalAllJudged(session.session_id)) {
      runtime.finalRevealStep = 0;
      db.prepare("UPDATE game_session SET status = 'final_results' WHERE session_id = ?").run(session.session_id);
    }
    emitState();
  });

  socket.on('final:nextReveal', () => {
    const session = currentSession();
    const rows = getFinalRevealRows(session.session_id);
    const nextStep = Math.min(runtime.finalRevealStep + 1, rows.length * 5 + 1);
    const index = Math.floor((nextStep - 1) / 5);
    const phase = (nextStep - 1) % 5;
    if (nextStep > 0 && index < rows.length && phase === 4) {
      applyFinalScoreForReveal(session.session_id, rows[index]);
    }
    runtime.finalRevealStep = nextStep;
    emitState();
  });

  socket.on('game:end', () => {
    const session = currentSession();
    if (runtime.finalTimer) clearTimeout(runtime.finalTimer);
    runtime.finalAnswerEndsAt = null;
    completeSession(session);
    emitState();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`GREGPARDY! running at http://localhost:${PORT}`);
  console.log(`Public join URL: ${PUBLIC_URL}`);
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
