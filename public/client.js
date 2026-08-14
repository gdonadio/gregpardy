const pageRole = document.body.dataset.page === 'screen' ? 'screen'
  : document.body.dataset.page === 'judge' ? 'judge' : 'player';
const socket = io({
  auth: {
    accessToken: localStorage.getItem('gregpardyAccessToken') || '',
    role: pageRole,
    judgeToken: localStorage.getItem('gregpardyJudgeToken') || '',
    profileToken: localStorage.getItem('gregpardyProfileToken') || ''
  }
});
const $ = (selector) => document.querySelector(selector);
const money = (value) => `$${Number(value || 0).toLocaleString()}`;
const emit = (event, payload = {}) => socket.emit(event, payload);

let state = null;
let myPlayerId = Number(localStorage.getItem('gregpardyPlayerId') || 0);
let profileToken = localStorage.getItem('gregpardyProfileToken') || '';
let authenticated = false;
let playerReadySessionId = 0;
let rejoinRequestedSessionId = 0;
let buzzSubmissionState = '';
let currentBuzzGroupId = '';
let timerInterval = null;
let answerTimerInterval = null;
let buzzTimerInterval = null;
let finalAutoSubmitted = false;
let finalDraftText = '';
let finalDraftSessionId = 0;
let lastBuzzSubmitAt = 0;
let judgeRevoked = false;
let hostNoticeTimer = null;

function joinedRoomCodes() {
  let rooms;
  try {
    rooms = JSON.parse(localStorage.getItem('gregpardyProfileRooms') || '[]');
  } catch {
    rooms = [];
  }
  const legacyRoom = localStorage.getItem('gregpardyProfileRoomCode');
  if (legacyRoom && !rooms.includes(legacyRoom)) rooms.push(legacyRoom);
  return rooms.filter((room) => /^\d{4}$/.test(String(room)));
}

function rememberRoom(roomCode) {
  const cleanCode = String(roomCode || '');
  if (!/^\d{4}$/.test(cleanCode)) return;
  const rooms = joinedRoomCodes();
  if (!rooms.includes(cleanCode)) rooms.push(cleanCode);
  localStorage.setItem('gregpardyProfileRooms', JSON.stringify(rooms));
  localStorage.setItem('gregpardyProfileRoomCode', cleanCode);
}

socket.on('state:update', (nextState) => {
  authenticated = true;
  const activeDraft = $('#responseText');
  if (activeDraft) finalDraftText = activeDraft.value;
  state = nextState;
  if (finalDraftSessionId !== state.session.session_id) {
    finalDraftSessionId = state.session.session_id;
    finalDraftText = '';
  }
  const nextBuzzGroupId = String(state.buzz?.groupId || '');
  if (nextBuzzGroupId !== currentBuzzGroupId) {
    currentBuzzGroupId = nextBuzzGroupId;
    buzzSubmissionState = '';
  }
  if (playerReadySessionId !== state.session.session_id) playerReadySessionId = 0;
  if (profileToken && joinedRoomCodes().includes(state.session.room_code)
    && pageRole === 'player' && !playerReadySessionId
    && rejoinRequestedSessionId !== state.session.session_id) {
    rejoinRequestedSessionId = state.session.session_id;
    emit('player:rejoin', { profileToken });
  }
  render();
  if (hostNoticeTimer) clearTimeout(hostNoticeTimer);
  if (state.hostNotice?.endsAt > Date.now()) {
    hostNoticeTimer = setTimeout(() => {
      document.querySelectorAll('.host-notice').forEach((notice) => notice.remove());
    }, state.hostNotice.endsAt - Date.now());
  }
});

socket.on('connect', () => {
  playerReadySessionId = 0;
  rejoinRequestedSessionId = 0;
  buzzSubmissionState = '';
});

socket.on('disconnect', () => {
  playerReadySessionId = 0;
  rejoinRequestedSessionId = 0;
  buzzSubmissionState = '';
  if (state && pageRole === 'player') render();
});

socket.on('auth:required', () => {
  authenticated = false;
  state = null;
  renderAuth();
});

socket.on('auth:error', (message) => {
  const error = $('#authError');
  if (error) error.textContent = message;
});

socket.on('auth:authenticated', ({ accessToken }) => {
  localStorage.setItem('gregpardyAccessToken', accessToken);
  authenticated = true;
});

socket.on('player:joined', ({ playerId, profileToken: nextProfileToken, displayName, sessionId }) => {
  myPlayerId = Number(playerId);
  profileToken = nextProfileToken;
  playerReadySessionId = Number(sessionId || state?.session?.session_id || 0);
  rejoinRequestedSessionId = 0;
  localStorage.setItem('gregpardyPlayerId', String(myPlayerId));
  localStorage.setItem('gregpardyProfileToken', profileToken);
  socket.auth.profileToken = profileToken;
  localStorage.setItem('gregpardyDisplayName', displayName || '');
  if (state?.session?.room_code) rememberRoom(state.session.room_code);
  location.href = '/player';
});

socket.on('player:rejoined', ({ playerId, displayName, sessionId }) => {
  myPlayerId = Number(playerId);
  playerReadySessionId = Number(sessionId || state?.session?.session_id || 0);
  rejoinRequestedSessionId = 0;
  localStorage.setItem('gregpardyPlayerId', String(myPlayerId));
  localStorage.setItem('gregpardyDisplayName', displayName || '');
  if (state?.session?.room_code) rememberRoom(state.session.room_code);
});

socket.on('player:rejoinFailed', () => {
  profileToken = '';
  myPlayerId = 0;
  playerReadySessionId = 0;
  rejoinRequestedSessionId = 0;
  socket.auth.profileToken = '';
  localStorage.removeItem('gregpardyProfileToken');
  localStorage.removeItem('gregpardyPlayerId');
});

socket.on('buzz:received', () => {
  buzzSubmissionState = 'received';
  render();
});

socket.on('buzz:rejected', ({ reason } = {}) => {
  buzzSubmissionState = reason || 'That buzz was not accepted.';
  if (/connection needs to be restored/i.test(buzzSubmissionState)) {
    playerReadySessionId = 0;
    rejoinRequestedSessionId = 0;
    if (profileToken) emit('player:rejoin', { profileToken });
  }
  render();
});

socket.on('judge:claimed', ({ judgeToken }) => {
  localStorage.setItem('gregpardyJudgeToken', judgeToken);
  socket.auth.judgeToken = judgeToken;
  judgeRevoked = false;
});

socket.on('judge:claimDenied', () => {
  const error = $('#judgeClaimError');
  if (error) error.textContent = 'Another device is currently the host/judge.';
});

socket.on('judge:revoked', (message) => {
  localStorage.removeItem('gregpardyJudgeToken');
  socket.auth.judgeToken = '';
  judgeRevoked = true;
  window.alert(message || 'Another device has taken over as host/judge.');
  render();
});

socket.on('error:message', (message) => {
  const error = $('#error');
  if (error) error.textContent = message;
});

socket.on('answer:timerDone', () => {
  if (document.body.dataset.page === 'screen') {
    playBuzzBuzz();
    render();
  }
});

function playerName(playerId) {
  return state?.players.find((p) => p.player_id === Number(playerId))?.display_name || 'Nobody';
}

function myPlayer() {
  return state?.players.find((p) => p.player_id === myPlayerId);
}

function scoresHtml() {
  return `<div class="scores">${state.players.map((p) => `
    <div class="score-row ${state.session.active_player_id === p.player_id ? 'active' : ''} ${p.is_host ? 'host-player' : ''}">
      <strong>${escapeHtml(p.display_name)}</strong>
      <span class="score">${p.is_host ? 'Host/Judge' : money(p.score)}</span>
    </div>
  `).join('')}</div>`;
}

function stageScoresHtml() {
  return `<div class="stage-scores">${state.players.map((player) => `
    <div class="stage-score ${state.session.active_player_id === player.player_id ? 'active' : ''} ${player.is_host ? 'host-player' : ''}">
      <strong>${escapeHtml(player.display_name)}</strong>
      <span>${player.is_host ? 'Host/Judge' : money(player.score)}</span>
    </div>
  `).join('')}</div>`;
}

function finalResponseFor(playerId) {
  return state.final.responses.find((response) => response.player_id === Number(playerId));
}

function activeCategoryName() {
  if (!state.activeClue) return '';
  return state.categories.find((category) => category.board_col === state.activeClue.board_col)?.category_name || '';
}

function boardHtml({ judge = false } = {}) {
  if (!state.categories.length) return '<div class="panel"><h2>Lobby</h2><p class="muted">The judge can start the game when 2-8 players have joined.</p></div>';
  const clueMap = new Map(state.clues.map((clue) => [`${clue.board_col}:${clue.row_in_category}`, clue]));
  const header = state.categories.map((category) => `<div class="cell category">${escapeHtml(category.category_name)}</div>`).join('');
  const rows = [1, 2, 3, 4, 5].map((row) => state.categories.map((category) => {
    const clue = clueMap.get(`${category.board_col}:${row}`);
    if (!clue) return '<div class="cell used"></div>';
    const used = clue.status === 'completed';
    const locked = judge && !used && !!state.activeClue;
    const onclick = judge && !used && !locked ? `onclick="emit('clue:select',{sessionClueId:${clue.session_clue_id}})"` : '';
    const dd = judge && clue.is_daily_double ? ' dd' : '';
    return `<button class="cell ${used ? 'used' : ''}${locked ? ' locked' : ''}${dd}" ${onclick} ${used || locked ? 'disabled' : ''}>${used ? '' : money(clue.display_value)}</button>`;
  }).join('')).join('');
  return `<div class="board ${judge ? 'judge-board' : ''}" style="--category-count:${state.categories.length}">${header}${rows}</div>`;
}

function finalSummaryHtml() {
  const sorted = state.players.filter((player) => !player.is_host).sort((a, b) => b.score - a.score);
  const winningScore = sorted[0]?.score;
  let lastScore = null;
  let position = 0;
  const rows = sorted.map((player, index) => {
    if (player.score !== lastScore) position = index + 1;
    lastScore = player.score;
    return { player, position };
  });
  return `<div class="clue-stage"><div>
    <div class="clue-text">Final Standings</div>
    <div style="height:20px"></div>
    <div class="final-board">${rows.map(({ player, position: place }) => `
      <div class="final-row ${player.score === winningScore ? 'winner' : ''}"><strong>${place}. ${escapeHtml(player.display_name)}</strong><span>${money(player.score)}</span></div>
    `).join('')}</div>
  </div></div>`;
}

function hostNoticeHtml() {
  if (!state?.hostNotice || state.hostNotice.endsAt <= Date.now()) return '';
  return `<div class="host-notice">${escapeHtml(state.hostNotice.message)}</div>`;
}

function leaderboardHtml(rows, title, emptyMessage) {
  if (!rows?.length) {
    return `<div class="panel leaderboard"><h2>${escapeHtml(title)}</h2><p class="muted">${escapeHtml(emptyMessage)}</p></div>`;
  }
  return `<div class="panel leaderboard">
    <h2>${escapeHtml(title)}</h2>
    <div class="leaderboard-head"><span>Player</span><span>Wins</span><span>Winnings</span></div>
    ${rows.map((row) => `<div class="leaderboard-row">
      <strong>${escapeHtml(row.display_name)}</strong>
      <span>${Number(row.wins)}</span>
      <span>${money(row.cash_winnings)}</span>
    </div>`).join('')}
  </div>`;
}

function lobbyHtml() {
  const waitingPlayers = state.players.filter((player) => !player.is_host);
  return `<div class="lobby-grid">
    <div class="panel lobby-join">
      ${state.databaseReady === false ? '<div class="setup-notice">Setup mode: the clue database still needs to be uploaded.</div>' : ''}
      <div class="badge">ROOM ${escapeHtml(state.session.room_code)}</div>
      <h2>Scan to Join</h2>
      <img class="qr-code" src="${escapeHtml(state.qrUrl)}" alt="QR code to join room ${escapeHtml(state.session.room_code)}">
      <p class="join-url">${escapeHtml(state.joinUrl)}</p>
      <p>${waitingPlayers.length} player${waitingPlayers.length === 1 ? '' : 's'} waiting</p>
      <div class="lobby-player-list">${waitingPlayers.map((player) => `<span class="badge">${escapeHtml(player.display_name)}</span>`).join('')}</div>
    </div>
    <div class="stack">
      ${leaderboardHtml(state.leaderboard, 'All-Time Leaders', 'Leaderboard results will appear after the first completed game.')}
      ${state.roomLeaderboard?.length
        ? leaderboardHtml(state.roomLeaderboard, `Room ${state.session.room_code} Leaders`, 'This room has no completed games yet.')
        : ''}
    </div>
  </div>`;
}

function renderScreen() {
  const root = $('#app');
  if (!state) return;
  if (state.session.status === 'complete') {
    root.innerHTML = topbarHtml() + finalSummaryHtml();
    setupFinalTimer();
    setupBuzzTimerBar();
    return;
  }
  if (state.session.status === 'lobby') {
    root.innerHTML = topbarHtml() + lobbyHtml();
    setupBuzzTimerBar();
    return;
  }
  const active = state.activeClue;
  const isFinal = state.session.status.startsWith('final');
  const center = categoryIntroHtml()
    || roundCompleteHtml()
    || finalResultsRevealHtml()
    || (isFinal
      ? finalScreenHtml()
      : active && active.status !== 'completed'
        ? activeClueScreenHtml(active)
        : boardHtml());
  root.innerHTML = `${topbarHtml()}<div class="layout"><main>${center}</main><aside class="panel"><h2>Scores</h2>${scoresHtml()}</aside></div>`;
  setupFinalTimer();
  setupAnswerTimer();
  setupBuzzTimerBar();
}

function roundCompleteHtml() {
  if (!['J_complete', 'DJ_complete'].includes(state.session.status)) return '';
  return `<div class="clue-stage"><div>
    <div class="badge">${state.session.status === 'DJ_complete' ? 'DOUBLE GREGPARDY COMPLETE' : 'ROUND COMPLETE'}</div>
    <div class="clue-text">Scores</div>
    ${stageScoresHtml()}
    ${state.session.status === 'DJ_complete' ? `<p class="round-note">You must have a positive score to play Final GREGPARDY! You may ask the host for pity points.</p>` : ''}
  </div></div>`;
}

function categoryIntroHtml() {
  if (!['J_categories', 'DJ_categories'].includes(state.session.status)) return '';
  return `<div class="clue-stage"><div>
    <div class="badge">${state.session.current_round === 'DJ' ? 'DOUBLE GREGPARDY' : 'GREGPARDY'}</div>
    <div class="clue-text">The Categories Are</div>
    <div class="category-list">${state.categories.map((category) => `<div>${escapeHtml(category.category_name)}</div>`).join('')}</div>
  </div></div>`;
}

function activeClueScreenHtml(active) {
  if (active.is_daily_double && active.status === 'daily_double') {
    return `<div class="clue-stage daily-double-stage"><div>
      <div class="badge">DAILY DOUBLE — ${escapeHtml(activeCategoryName())}</div>
      <div class="clue-text">${escapeHtml(activeCategoryName())}</div>
      ${stageScoresHtml()}
    </div></div>`;
  }
  return `<div class="clue-stage"><div>
    <div class="badge">${active.is_daily_double ? `DAILY DOUBLE — ${escapeHtml(activeCategoryName())}` : state.session.status === 'final_clue' ? 'FINAL GREGPARDY' : escapeHtml(activeCategoryName())}</div>
    <div class="clue-text">${escapeHtml(active.clue_text)}</div>
    ${state.buzz?.open && state.buzz.closesAt ? '<div class="buzz-countdown" aria-label="Buzzing time remaining"><div id="buzzTimerBar" class="buzz-countdown-bar"></div></div>' : ''}
    ${state.buzz?.selectedPlayerId ? `<div class="selected-buzzer">${escapeHtml(playerName(state.buzz.selectedPlayerId))}${timesUpHtml()}</div>` : ''}
    ${state.answerTimerEndsAt ? '<div id="answerTimer" class="timer"></div>' : ''}
  </div></div>`;
}

function timesUpHtml() {
  if (!state.answerTimedOut) return '';
  return `<div class="times-up">TIME'S UP!</div>`;
}

function finalScreenHtml() {
  const submitted = new Set(state.final.responses.filter((response) => response.submitted_at).map((response) => response.player_id));
  const showingCategory = state.session.status === 'final_wager';
  const showingClue = state.session.status === 'final_clue' || state.session.status === 'final_answering';
  return `<div class="clue-stage"><div>
    <div class="badge">FINAL GREGPARDY</div>
    <div class="clue-text">${showingClue ? escapeHtml(state.final.clue?.clue_text || '') : escapeHtml(state.final.category?.category_name || 'Final category')}</div>
    ${showingCategory ? stageScoresHtml() : ''}
    ${state.session.status === 'final_clue' ? '<h2>Get ready. Timer has not started.</h2>' : ''}
    ${state.session.status === 'final_answering' ? '<div id="finalTimer" class="timer"></div>' : ''}
    ${state.session.status === 'final_judging' ? '<h2>Answers locked. Judge is scoring.</h2>' : ''}
    ${state.session.status === 'final_answering' ? `<div class="submission-grid">${state.players.filter((p) => !p.is_host && p.score > 0).map((player) => `
      <div class="submission-pill ${submitted.has(player.player_id) ? 'submitted' : ''}">${escapeHtml(player.display_name)} ${submitted.has(player.player_id) ? 'SUBMITTED' : '...'}</div>
    `).join('')}</div>` : ''}
  </div></div>`;
}

function finalResultsRevealHtml() {
  if (state.session.status !== 'final_results') return '';
  const rows = state.finalRevealRows || [];
  const step = Number(state.finalRevealStep || 0);
  if (step > rows.length * 5) return finalSummaryHtml();
  if (step === 0) {
    const scoreboard = [...rows].sort((a, b) => b.preFinalScore - a.preFinalScore || a.player.display_name.localeCompare(b.player.display_name));
    return `<div class="clue-stage"><div>
      <div class="badge">BEFORE FINAL GREGPARDY</div>
      <div class="clue-text">Scores Before Final</div>
      <div class="final-board">${scoreboard.map((row) => `
        <div class="final-row"><strong>${escapeHtml(row.player.display_name)}</strong><span>${money(row.preFinalScore)}</span></div>
      `).join('')}</div>
    </div></div>`;
  }
  const index = Math.floor((step - 1) / 5);
  const phase = (step - 1) % 5;
  const row = rows[index];
  const response = row.response || {};
  const responseClass = phase >= 2 ? (response.is_correct ? ' reveal-correct' : ' reveal-incorrect') : '';
  const lines = [`<div><span>Score</span><strong>${money(row.preFinalScore)}</strong></div>`];
  if (phase >= 1) lines.push(`<div class="${responseClass}"><span>${phase >= 2 ? (response.is_correct ? 'Correct' : 'Incorrect') : 'Response'}</span><strong>${escapeHtml(response.response_text || 'No response')}</strong></div>`);
  if (phase >= 3) lines.push(`<div><span>Wager</span><strong>${money(response.wager || 0)}</strong></div>`);
  if (phase >= 4) lines.push(`<div><span>Final Score</span><strong>${money(row.finalScore)}</strong></div>`);
  return `<div class="clue-stage"><div>
    <div class="badge">FINAL RESULTS</div>
    <h2>${escapeHtml(row.player.display_name)}</h2>
    <div class="reveal-lines">${lines.join('')}</div>
  </div></div>`;
}

function topbarHtml() {
  return `<header class="topbar">
    <h1 class="brand">GREGPARDY!</h1>
    <div class="room">
      <span class="badge">Room ${state.session.room_code}</span>
      <span class="badge">${state.joinUrl}</span>
      <span class="badge">${state.session.status}</span>
    </div>
  </header>${hostNoticeHtml()}`;
}

function renderJoin() {
  const root = $('#app');
  const params = new URLSearchParams(location.search);
  const room = params.get('room') || state?.session?.room_code || '';
  const savedName = localStorage.getItem('gregpardyDisplayName') || '';
  root.innerHTML = `<form class="join-box panel" onsubmit="joinGame(event)">
    <h1 class="brand">GREGPARDY!</h1>
    <label>Room code<input id="roomCode" inputmode="numeric" value="${escapeHtml(room)}"></label>
    <label>Display name<input id="displayName" maxlength="24" autocomplete="name" value="${escapeHtml(savedName)}"></label>
    <button>Join Game</button>
    <p id="error" class="error"></p>
  </form>`;
}

function joinGame(event) {
  event.preventDefault();
  emit('player:join', {
    roomCode: $('#roomCode').value,
    displayName: $('#displayName').value,
    profileToken
  });
}

function renderAuth() {
  const root = $('#app');
  if (!root) return;
  root.innerHTML = `<form class="join-box panel" onsubmit="submitPassword(event)">
    <h1 class="brand">GREGPARDY!</h1>
    <h2>Enter the game password</h2>
    <label>Password
      <span class="password-field">
        <input id="gamePassword" type="password" autocomplete="current-password" autofocus>
        <button type="button" class="password-toggle" onclick="togglePasswordVisibility()" aria-label="Show password" aria-pressed="false">&#128065;</button>
      </span>
    </label>
    <button>Continue</button>
    <p id="authError" class="error"></p>
  </form>`;
}

function togglePasswordVisibility() {
  const input = $('#gamePassword');
  const button = document.querySelector('.password-toggle');
  if (!input || !button) return;
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  button.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  button.setAttribute('aria-pressed', String(!showing));
  input.focus();
}

function submitPassword(event) {
  event.preventDefault();
  emit('auth:login', { password: $('#gamePassword').value });
}

function renderPlayer() {
  const root = $('#app');
  const me = myPlayer();
  if (!me) {
    root.innerHTML = `<div class="phone stack panel"><h1 class="brand">GREGPARDY!</h1><p class="muted">Join the game first.</p><a href="/"><button>Join</button></a></div>`;
    return;
  }
  const active = state.activeClue;
  const locked = state.lockedOut.includes(me.player_id);
  const eligibleFinal = me.score > 0 && !me.is_host;
  const finalResponse = finalResponseFor(me.player_id);
  const playerReady = socket.connected && playerReadySessionId === state.session.session_id;
  let body = `<div class="panel stack">
    <div class="player-heading"><h2>${escapeHtml(me.display_name)}</h2><span class="connection-status ${playerReady ? 'connected' : 'reconnecting'}">${playerReady ? 'Connected' : 'Reconnecting…'}</span></div>
    <div class="score">${money(me.score)}</div><p class="muted">Room ${state.session.room_code}</p>
  </div>`;
  if (!playerReady) {
    body += '<div class="panel reconnecting-card"><h2>Reconnecting…</h2><p class="muted">Game controls will return as soon as your player connection is restored.</p></div>';
  } else if (state.session.status === 'lobby') {
    body += `<div class="panel"><h2>Waiting for the judge</h2><p class="muted">${state.players.length} player(s) joined.</p></div>`;
  } else if (state.session.status === 'final_pity_vote') {
    body += pityVoteHtml(me);
  } else if (state.session.status === 'final_wager' && eligibleFinal) {
    if (finalResponse) body += submittedPanelHtml('Wager submitted');
    else body += `<form class="panel stack" onsubmit="submitWager(event)"><h2>Final Wager</h2><input id="wager" type="text" inputmode="numeric" pattern="[0-9]*" value="0" oninput="normalizeWagerInput(this)"><button>Submit Wager</button></form>`;
  } else if (state.session.status === 'final_clue' && eligibleFinal) {
    body += `<div class="panel"><h2>Final clue revealed</h2><p class="muted">Wait for the judge to start the timer.</p></div>`;
  } else if (state.session.status === 'final_answering' && eligibleFinal) {
    if (finalResponse?.submitted_at) body += submittedPanelHtml('Answer submitted');
    else {
      const savedDraft = finalDraftText || finalResponse?.draft_text || '';
      finalDraftText = savedDraft;
      body += `<form class="panel stack" onsubmit="submitFinalResponse(event)"><h2>Final Response</h2><p class="muted">Anything in this text box at the end of the countdown will be submitted.</p><div id="finalTimer" class="phone-timer"></div><textarea id="responseText" oninput="saveFinalDraft()">${escapeHtml(savedDraft)}</textarea><button>Submit Response</button></form>`;
    }
  } else if (state.session.status === 'final_judging' && eligibleFinal) {
    body += `<div class="panel"><h2>Answers locked</h2><p class="muted">${finalResponse?.response_text ? 'Your answer was submitted.' : 'No answer was submitted before time expired.'}</p></div>`;
  } else if (state.session.status === 'final_results') {
    body += `<div class="panel"><h2>Final results</h2><p class="muted">Watch the main screen.</p></div>`;
  } else if (active?.is_daily_double && state.session.active_player_id === me.player_id) {
    body += `<div class="panel"><h2>Daily Double</h2><p class="muted">${active.status === 'daily_double' ? 'Tell the judge your wager out loud.' : 'Answer out loud when the judge reads the clue.'}</p></div>`;
  } else if (state.buzz?.open && active && !locked && !me.is_host) {
    const submitted = ['sending', 'received'].includes(buzzSubmissionState);
    const label = buzzSubmissionState === 'received' ? 'BUZZ RECEIVED' : buzzSubmissionState === 'sending' ? 'SENDING…' : 'BUZZ';
    body += `<button type="button" class="big-button ${buzzSubmissionState === 'received' ? 'good' : 'danger'}" onpointerdown="submitBuzz(event, ${me.player_id})" onclick="submitBuzz(event, ${me.player_id})" ${submitted ? 'disabled' : ''}>${label}</button>`;
    if (buzzSubmissionState && !submitted) body += `<div class="panel error">${escapeHtml(buzzSubmissionState)}</div>`;
  } else if (locked) {
    body += `<div class="panel"><h2>Locked out</h2><p class="muted">Wait for the next clue.</p></div>`;
  } else if (active) {
    body += `<div class="panel"><h2>Clue is live</h2><p class="muted">Listen to the judge. Your buzz button appears when buzzing opens.</p></div>`;
  } else if (['J_categories', 'DJ_categories'].includes(state.session.status)) {
    body += `<div class="panel"><h2>The categories are...</h2><p class="muted">Watch the main screen.</p></div>`;
  } else if (state.session.status === 'J' || state.session.status === 'DJ') {
    body += `<div class="panel"><h2>Waiting for clue selection</h2><p class="muted">The judge chooses clues in this version. Watch the main screen.</p></div>`;
  } else {
    body += `<div class="panel"><h2>Stand by</h2><p class="muted">The judge is running the next step.</p></div>`;
  }
  root.innerHTML = `<main class="phone stack">${hostNoticeHtml()}${body}<p id="error" class="error"></p></main>`;
  setupFinalTimer();
  setupAnswerTimer();
}

function submitBuzz(event, playerId) {
  event.preventDefault();
  if (buzzSubmissionState === 'sending' || buzzSubmissionState === 'received') return;
  const nowMs = Date.now();
  if (nowMs - lastBuzzSubmitAt < 500) return;
  lastBuzzSubmitAt = nowMs;
  buzzSubmissionState = 'sending';
  emit('buzz:submit', { playerId });
  render();
}

function submittedPanelHtml(label) {
  return `<div class="panel submitted-card"><h2>SUBMITTED</h2><p class="muted">${escapeHtml(label)}</p></div>`;
}

function pityVoteHtml(me) {
  if (me.score <= 0) return `<div class="panel"><h2>Pity Vote</h2><p class="muted">Positive-score players are voting.</p></div>`;
  const candidates = state.pity.candidates;
  if (!candidates.length) return '<div class="panel"><h2>Final is next</h2></div>';
  return `<div class="panel stack"><h2>Pity Vote</h2>${candidates.map((candidate) => `
    <div class="stack">
      <strong>Let ${escapeHtml(candidate.display_name)} play Final with $1?</strong>
      <div class="actions">
        <button class="good" onclick="emit('pity:submitVote',{voterPlayerId:${me.player_id},targetPlayerId:${candidate.player_id},vote:'yes'})">Yes</button>
        <button class="danger" onclick="emit('pity:submitVote',{voterPlayerId:${me.player_id},targetPlayerId:${candidate.player_id},vote:'no'})">No</button>
      </div>
    </div>
  `).join('')}</div>`;
}

function submitWager(event) {
  event.preventDefault();
  if (!window.confirm('Submit this Final Jeopardy wager? This is your final decision.')) return;
  emit('final:submitWager', { playerId: myPlayerId, wager: $('#wager').value });
  event.currentTarget.innerHTML = submittedPanelHtml('Wager submitted');
}

function normalizeWagerInput(input) {
  const digits = input.value.replace(/\D/g, '');
  input.value = digits.replace(/^0+(?=\d)/, '') || '0';
}

function submitFinalResponse(event) {
  event.preventDefault();
  if (!window.confirm('Submit this Final Jeopardy answer? This is your final decision.')) return;
  emit('final:submitResponse', { playerId: myPlayerId, responseText: $('#responseText').value });
  event.currentTarget.innerHTML = submittedPanelHtml('Answer submitted');
}

function saveFinalDraft() {
  finalDraftText = $('#responseText')?.value || '';
  emit('final:saveDraft', { playerId: myPlayerId, responseText: finalDraftText });
}

function autoSubmitFinalResponse() {
  if (finalAutoSubmitted) return;
  const input = $('#responseText');
  if (!input || state?.session?.status !== 'final_answering') return;
  finalAutoSubmitted = true;
  input.disabled = true;
  emit('final:saveDraft', { playerId: myPlayerId, responseText: input.value });
  const form = input.closest('form');
  if (form) form.innerHTML = submittedPanelHtml('Answer submitted at time');
}

function renderJudge() {
  const root = $('#app');
  if (!state) return;
  if (!state.isJudge || judgeRevoked) {
    const occupied = state.judgeStatus?.occupied;
    root.innerHTML = `<main class="judge-claim panel stack">
      <h1 class="brand">GREGPARDY!</h1>
      <h2>${occupied ? 'Another host is running the game.' : 'GREGPARDY! needs a host.'}</h2>
      <button onclick="claimJudge(${occupied ? 'true' : 'false'})">${occupied ? 'Take Over as Host/Judge' : 'Be the Host/Judge'}</button>
      <p id="judgeClaimError" class="error"></p>
    </main>`;
    return;
  }
  if (state.session.status === 'lobby') {
    root.innerHTML = `${topbarHtml()}
      <div class="judge-layout">
        <main>${lobbyHtml()}</main>
        <aside class="stack">
          <div class="panel"><h2>Players</h2>${scoresHtml()}</div>
          ${judgeAdminOptionsHtml()}
        </aside>
      </div>`;
    return;
  }
  const active = state.activeClue;
  root.innerHTML = `${topbarHtml()}
    <div class="judge-layout">
      <main class="stack">
        ${judgeFinalTopHtml()}
        ${judgeRoundIntroControlsHtml()}
        ${judgeRoundSummaryControlsHtml()}
        ${state.session.status.startsWith('final') ? '' : active ? judgeClueHtml(active) : '<div class="panel"><h2>Current Clue</h2><p class="muted">Tap a clue on the board.</p></div>'}
        ${state.session.status.startsWith('final') ? '' : `<div class="panel"><h2>${state.session.current_round || 'Lobby'} Board</h2>${boardHtml({ judge: true })}</div>`}
      </main>
      <aside class="stack">
        <div class="panel"><h2>Players</h2>${scoresHtml()}<div class="mini-grid">${state.players.filter((p) => !p.is_host).map((p) => `
          <div class="stack">
            <strong>${escapeHtml(p.display_name)}</strong>
            <input id="adj-${p.player_id}" type="number" value="0">
            <button class="secondary" onclick="emit('score:adjust',{playerId:${p.player_id},delta:Number(document.querySelector('#adj-${p.player_id}').value)})">Adjust</button>
          </div>`).join('')}</div></div>
        ${judgeAdminOptionsHtml()}
      </aside>
    </div>`;
  setupFinalTimer();
  setupAnswerTimer();
}

function claimJudge(takeover) {
  if (takeover && !window.confirm('Take over as host? The current host will immediately lose control.')) return;
  emit('judge:claim', {
    judgeToken: localStorage.getItem('gregpardyJudgeToken') || '',
    takeover
  });
}

function judgeFinalTopHtml() {
  if (!state.session.status.startsWith('final') && state.session.status !== 'complete') return '';
  return judgeFinalHtml();
}

function judgeRoundIntroControlsHtml() {
  if (!['J_categories', 'DJ_categories'].includes(state.session.status)) return '';
  return `<div class="panel stack round-start-panel">
    <h2>The Categories Are</h2>
    <button class="good" onclick="emit('round:introNext')">Start</button>
  </div>`;
}

function judgeRoundSummaryControlsHtml() {
  if (!['J_complete', 'DJ_complete'].includes(state.session.status)) return '';
  const nonPositivePlayers = state.players.filter((player) => player.score <= 0);
  return `<div class="panel stack round-start-panel">
    <h2>${state.session.status === 'DJ_complete' ? 'Double GREGPARDY Complete' : 'Round Complete'}</h2>
    <p class="muted">${state.session.status === 'DJ_complete' ? 'Review scores before Final GREGPARDY.' : 'Last place will choose first in Double GREGPARDY.'}</p>
    ${state.session.status === 'DJ_complete' && nonPositivePlayers.length ? `<div class="stack pity-panel">
      <h2>Dole out pity points?</h2>
      <p class="muted">At least one player needs a positive score to play Final GREGPARDY.</p>
      <div class="mini-grid">${nonPositivePlayers.map((player) => `
        <div class="stack">
          <strong>${escapeHtml(player.display_name)} ${money(player.score)}</strong>
          <input id="pity-adj-${player.player_id}" type="number" value="${1 - player.score}">
          <button class="secondary" onclick="emit('score:adjust',{playerId:${player.player_id},delta:Number(document.querySelector('#pity-adj-${player.player_id}').value)})">Adjust</button>
        </div>
      `).join('')}</div>
    </div>` : ''}
    <button class="good" onclick="emit('round:continueFromSummary')">${state.session.status === 'DJ_complete' ? 'Continue to Final' : 'Show Double GREGPARDY Categories'}</button>
  </div>`;
}

function judgeAdminOptionsHtml() {
  return `<div class="panel stack admin-options">
    <h2>Admin Options</h2>
    <div class="actions">
      <button onclick="confirmNewRoom()" class="secondary">New Room</button>
      ${state.session.status === 'lobby'
        ? '<button onclick="emit(\'game:start\')">Start Game</button>'
        : '<button onclick="confirmNewGame()">New Game</button>'}
      ${state.allowRepeatOffer ? `<button class="danger" onclick="emit('game:start',{allowRepeats:true})">Allow Repeats For This Game</button>` : ''}
      <button onclick="confirmAdvanceRound()" class="blue">Advance Round</button>
      <button onclick="emit('game:end')" class="danger">End Game</button>
    </div>
    ${state.lastError ? `<p class="error">${escapeHtml(state.lastError)}</p>` : ''}
  </div>`;
}

function confirmNewRoom() {
  const shouldWarn = state.players.length > 0 || state.session.status !== 'lobby' || state.clues.length > 0;
  if (shouldWarn && !window.confirm('Open another room? The current game will be recorded as complete.')) return;
  const requestedCode = window.prompt(
    'Enter a previous 4-digit room code to reopen its series, enter a new 4-digit code, or leave blank to generate one.',
    ''
  );
  if (requestedCode === null) return;
  const cleanCode = requestedCode.trim();
  if (cleanCode && !/^\d{4}$/.test(cleanCode)) {
    window.alert('Room codes must contain exactly four digits.');
    return;
  }
  emit('game:create', { roomCode: cleanCode });
}

function confirmNewGame() {
  const unfinished = state.session.status !== 'complete';
  if (!unfinished || window.confirm('Start a new game in this room? The current game will be recorded as complete.')) {
    const requestedCount = window.prompt('How many categories should each round have? Enter 3, 4, 5, or 6.', '6');
    if (requestedCount === null) return;
    const categoryCount = Number(requestedCount.trim());
    if (![3, 4, 5, 6].includes(categoryCount)) {
      window.alert('Please enter 3, 4, 5, or 6 categories.');
      return;
    }
    emit('game:new', { categoryCount });
  }
}

function confirmAdvanceRound() {
  if (window.confirm('Advance round now? This will immediately end the current round and jump to the next phase.')) {
    emit('round:advance');
  }
}

function judgeClueHtml(active) {
  const selected = state.buzz?.selectedPlayerId;
  const daily = active.is_daily_double;
  const activePlayer = state.activePlayer;
  const maxWager = activePlayer ? Math.max(activePlayer.score > 0 ? activePlayer.score : 0, active.round === 'DJ' ? 2000 : 1000) : active.display_value;
  const dailyWaiting = daily && active.status === 'daily_double';
  const dailyLocked = daily && !dailyWaiting;
  const dailyWager = daily ? Number(state.dailyDoubleWager || Math.min(maxWager, active.display_value || 1000)) : 0;
  const roundWagerLimit = active.round === 'DJ' ? 2000 : 1000;
  const playerAnswering = !daily && !!selected;
  return `<div class="panel stack">
    <h2>${daily ? 'Daily Double' : 'Current Clue'}</h2>
    ${dailyWaiting ? `<p class="answer">Category: ${escapeHtml(activeCategoryName())}</p><p class="muted">Enter the wager, then show the clue.</p>` : `<p>${escapeHtml(active.clue_text)}</p><p class="answer">Response: ${escapeHtml(active.correct_response)}</p>`}
    ${daily ? `<p class="muted">${escapeHtml(activePlayer?.display_name || 'The player')} may wager up to ${money(roundWagerLimit)} or their entire current score, whichever is higher. Their maximum wager is ${money(maxWager)}.</p>
      <label>Wager<input id="ddWager" type="number" min="5" max="${maxWager}" value="${dailyWager}" ${dailyLocked ? 'disabled' : ''}></label>
      ${dailyLocked ? `<p class="locked-wager">Locked wager: ${money(dailyWager)}</p>` : ''}
      <div class="actions">
        <button class="secondary" onclick="document.querySelector('#ddWager').value=${maxWager}" ${dailyLocked ? 'disabled' : ''}>True Daily Double</button>
        ${dailyWaiting ? `<button onclick="showDailyDoubleClue()">Show Clue</button>` : ''}
      </div>` : `
      ${playerAnswering ? judgeAnswerPromptHtml(active) : `${judgeBuzzControlHtml()}
      <button class="secondary wide-action" onclick="emit('clue:close')">Close Clue</button>`}
      <p class="muted">Selected: ${selected ? escapeHtml(playerName(selected)) : 'none'}</p>
      <select id="winner">${state.players.filter((p) => !p.is_host).map((p) => `<option value="${p.player_id}" ${selected === p.player_id ? 'selected' : ''}>${escapeHtml(p.display_name)}</option>`).join('')}</select>
      <button class="secondary" onclick="emit('buzz:overrideWinner',{playerId:Number(document.querySelector('#winner').value)})">Override Winner</button>`}
    ${daily ? `<div class="actions judge-primary-actions">
      <button class="good" onclick="judgeMark(true)" ${dailyWaiting ? 'disabled' : ''}>Correct</button>
      <button class="danger" onclick="judgeMark(false)" ${dailyWaiting ? 'disabled' : ''}>Incorrect</button>
    </div>
    ${state.answerTimerEndsAt ? '<div id="answerTimer" class="phone-timer"></div>' : ''}
    <button class="secondary" onclick="emit('answer:startTimer')" ${dailyWaiting ? 'disabled' : ''}>Give Them 5 Seconds</button>` : ''}
  </div>`;
}

function judgeAnswerPromptHtml(active) {
  if (!active || active.is_daily_double || !state.buzz?.selectedPlayerId) return '';
  return `<div class="stack answer-prompt">
    <h2>Is ${escapeHtml(playerName(state.buzz.selectedPlayerId))} correct?</h2>
    ${state.answerTimerEndsAt ? '<div id="answerTimer" class="phone-timer"></div>' : ''}
    <div class="actions judge-primary-actions">
      <button class="good" onclick="judgeMark(true)">Correct</button>
      <button class="danger" onclick="judgeMark(false)">Incorrect</button>
    </div>
    <button class="secondary" onclick="emit('answer:startTimer')">Give Them 5 Seconds</button>
    ${judgeBuzzControlHtml()}
  </div>`;
}

function judgeBuzzControlHtml() {
  const buzzingOpen = Boolean(state.buzz?.open);
  const eventName = buzzingOpen ? 'buzz:close' : 'buzz:open';
  const label = buzzingOpen ? 'CLOSE BUZZING' : 'OPEN BUZZING';
  const status = buzzingOpen ? 'BUZZING IS OPEN' : 'BUZZING IS CLOSED';
  return `<div class="stack judge-buzz-control">
    <div class="judge-buzz-status ${buzzingOpen ? 'open' : 'closed'}">${status}</div>
    <button class="${buzzingOpen ? 'secondary' : 'blue'}" onclick="emit('${eventName}')">${label}</button>
  </div>`;
}

function showDailyDoubleClue() {
  emit('clue:showDailyDouble', { wager: Number(document.querySelector('#ddWager')?.value || 0) });
}

function judgeMark(isCorrect) {
  const active = state.activeClue;
  const playerId = active?.is_daily_double
    ? state.session.active_player_id
    : (state.buzz?.selectedPlayerId || Number(document.querySelector('#winner')?.value || 0));
  const wager = active?.is_daily_double ? Number(document.querySelector('#ddWager')?.value || 0) : 0;
  emit(isCorrect ? 'answer:correct' : 'answer:incorrect', { playerId, wager });
}

function judgeFinalHtml() {
  if (!state.session.status.startsWith('final') && state.session.status !== 'complete') return '';
  const eligible = state.players.filter((p) => !p.is_host && p.score > 0);
  const responses = new Map(state.final.responses.map((r) => [r.player_id, r]));
  const allWagered = eligible.length > 0 && eligible.every((p) => responses.get(p.player_id)?.wager_submitted_at);
  const allJudged = eligible.length && eligible.every((p) => responses.get(p.player_id)?.is_correct !== null && responses.get(p.player_id)?.is_correct !== undefined);
  return `<div class="panel stack">
    <h2>Final GREGPARDY</h2>
    <p><strong>Category:</strong> ${escapeHtml(state.final.category?.category_name || '')}</p>
    <p class="answer"><strong>Correct:</strong> ${escapeHtml(state.final.clue?.correct_response || '')}</p>
    <div class="actions">
      <button onclick="emit('final:revealClue')" ${state.session.status !== 'final_wager' || !allWagered ? 'disabled' : ''}>Reveal Final Clue</button>
      ${state.session.status === 'final_clue' ? `<button onclick="emit('final:startTimer')">Start 30s Timer</button>` : ''}
      ${state.session.status === 'final_answering' ? `<button class="blue" onclick="emit('final:addTime')">Add 5 Seconds</button>` : ''}
      ${state.session.status === 'final_results' ? `<button onclick="emit('final:nextReveal')">${finalRevealButtonLabel()}</button>` : ''}
      <button class="good" onclick="emit('game:end')" ${!allJudged && state.session.status !== 'final_results' ? 'disabled' : ''}>End Game</button>
    </div>
    ${state.session.status === 'final_answering' ? '<p id="finalTimer" class="phone-timer"></p>' : ''}
    ${eligible.map((p) => {
      const response = responses.get(p.player_id);
      const canJudge = !!response?.response_text || ['final_judging', 'final_results', 'complete'].includes(state.session.status);
      const alreadyJudged = response?.is_correct !== null && response?.is_correct !== undefined;
      return `<div class="panel stack">
        <strong>${escapeHtml(p.display_name)} ${response ? `wagered ${money(response.wager)}` : 'has not wagered'}</strong>
        <span>${escapeHtml(response?.response_text || 'No response yet')}</span>
        <div class="actions">
          <button class="good" onclick="emit('final:judgeResponse',{playerId:${p.player_id},isCorrect:true})" ${!canJudge || alreadyJudged ? 'disabled' : ''}>Correct</button>
          <button class="danger" onclick="emit('final:judgeResponse',{playerId:${p.player_id},isCorrect:false})" ${!canJudge || alreadyJudged ? 'disabled' : ''}>Incorrect</button>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

function finalRevealButtonLabel() {
  const rows = state.finalRevealRows || [];
  const step = Number(state.finalRevealStep || 0);
  if (step >= rows.length * 5) return 'Show Final Scoreboard';
  const labels = ['Show Score', 'Show Guess', 'Reveal Correct/Incorrect', 'Show Wager', 'Show Final Score'];
  return labels[step % 5] || 'Next';
}

function setupFinalTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  if (state?.session?.status !== 'final_answering') finalAutoSubmitted = false;
  updateFinalTimer();
  if (state?.finalAnswerEndsAt && state.session.status === 'final_answering') {
    timerInterval = setInterval(updateFinalTimer, 250);
  }
}

function updateFinalTimer() {
  const timer = $('#finalTimer');
  if (!timer || !state?.finalAnswerEndsAt) return;
  const remaining = Math.max(0, Math.ceil((state.finalAnswerEndsAt - Date.now()) / 1000));
  timer.textContent = `${remaining}s`;
  if (remaining <= 0) autoSubmitFinalResponse();
}

function setupAnswerTimer() {
  if (answerTimerInterval) clearInterval(answerTimerInterval);
  answerTimerInterval = null;
  updateAnswerTimer();
  if (state?.answerTimerEndsAt) answerTimerInterval = setInterval(updateAnswerTimer, 100);
}

function setupBuzzTimerBar() {
  if (buzzTimerInterval) clearInterval(buzzTimerInterval);
  buzzTimerInterval = null;
  updateBuzzTimerBar();
  if (state?.buzz?.open && state.buzz.closesAt && $('#buzzTimerBar')) {
    buzzTimerInterval = setInterval(updateBuzzTimerBar, 50);
  }
}

function updateBuzzTimerBar() {
  const bar = $('#buzzTimerBar');
  if (!bar || !state?.buzz?.closesAt) return;
  const remainingRatio = Math.max(0, Math.min(1, (state.buzz.closesAt - Date.now()) / 10000));
  bar.style.width = `${remainingRatio * 100}%`;
  if (remainingRatio === 0 && buzzTimerInterval) {
    clearInterval(buzzTimerInterval);
    buzzTimerInterval = null;
  }
}

function updateAnswerTimer() {
  const timer = $('#answerTimer');
  if (!timer || !state?.answerTimerEndsAt) return;
  const remaining = Math.max(0, Math.ceil((state.answerTimerEndsAt - Date.now()) / 1000));
  timer.textContent = `${remaining}s`;
}

function playBuzzBuzz() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioContext();
    [0, 0.18].forEach((offset) => {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = 'square';
      oscillator.frequency.value = 160;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + offset + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.13);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(ctx.currentTime + offset);
      oscillator.stop(ctx.currentTime + offset + 0.14);
    });
  } catch (_error) {
    // Audio is best-effort; some browsers require prior interaction.
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function render() {
  if (!authenticated) return renderAuth();
  const page = document.body.dataset.page;
  if (page === 'screen') renderScreen();
  if (page === 'join') renderJoin();
  if (page === 'player') renderPlayer();
  if (page === 'judge') renderJudge();
}
