const pageRole = document.body.dataset.page === 'screen' ? 'screen'
  : document.body.dataset.page === 'judge' ? 'judge' : 'player';
const socket = io({
  auth: {
    accessToken: localStorage.getItem('gregpardyAccessToken') || '',
    role: pageRole
  }
});
const $ = (selector) => document.querySelector(selector);
const money = (value) => `$${Number(value || 0).toLocaleString()}`;
const emit = (event, payload = {}) => socket.emit(event, payload);

let state = null;
let myPlayerId = Number(localStorage.getItem('gregpardyPlayerId') || 0);
let profileToken = localStorage.getItem('gregpardyProfileToken') || '';
let authenticated = false;
let lastRejoinedSessionId = 0;
let timerInterval = null;
let answerTimerInterval = null;
let finalDraftTimer = null;
let finalAutoSubmitted = false;
let lastBuzzSubmitAt = 0;

socket.on('state:update', (nextState) => {
  authenticated = true;
  state = nextState;
  const profileRoomCode = localStorage.getItem('gregpardyProfileRoomCode') || '';
  if (profileToken && profileRoomCode === state.session.room_code
    && pageRole === 'player' && lastRejoinedSessionId !== state.session.session_id) {
    lastRejoinedSessionId = state.session.session_id;
    emit('player:rejoin', { profileToken });
  }
  render();
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

socket.on('player:joined', ({ playerId, profileToken: nextProfileToken, displayName }) => {
  myPlayerId = Number(playerId);
  profileToken = nextProfileToken;
  localStorage.setItem('gregpardyPlayerId', String(myPlayerId));
  localStorage.setItem('gregpardyProfileToken', profileToken);
  localStorage.setItem('gregpardyDisplayName', displayName || '');
  if (state?.session?.room_code) localStorage.setItem('gregpardyProfileRoomCode', state.session.room_code);
  location.href = '/player';
});

socket.on('player:rejoined', ({ playerId, displayName }) => {
  myPlayerId = Number(playerId);
  localStorage.setItem('gregpardyPlayerId', String(myPlayerId));
  localStorage.setItem('gregpardyDisplayName', displayName || '');
  if (state?.session?.room_code) localStorage.setItem('gregpardyProfileRoomCode', state.session.room_code);
});

socket.on('player:rejoinFailed', () => {
  profileToken = '';
  myPlayerId = 0;
  localStorage.removeItem('gregpardyProfileToken');
  localStorage.removeItem('gregpardyPlayerId');
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
    <div class="score-row ${state.session.active_player_id === p.player_id ? 'active' : ''}">
      <strong>${escapeHtml(p.display_name)}</strong>
      <span class="score">${money(p.score)}</span>
    </div>
  `).join('')}</div>`;
}

function stageScoresHtml() {
  return `<div class="stage-scores">${state.players.map((player) => `
    <div class="stage-score ${state.session.active_player_id === player.player_id ? 'active' : ''}">
      <strong>${escapeHtml(player.display_name)}</strong>
      <span>${money(player.score)}</span>
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
  return `<div class="board ${judge ? 'judge-board' : ''}">${header}${rows}</div>`;
}

function finalSummaryHtml() {
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
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
      <div class="final-row"><strong>${place}. ${escapeHtml(player.display_name)}</strong><span>${money(player.score)}</span></div>
    `).join('')}</div>
  </div></div>`;
}

function leaderboardHtml() {
  if (!state.leaderboard?.length) {
    return '<div class="panel leaderboard"><h2>All-Time Leaders</h2><p class="muted">Leaderboard results will appear after the first completed game.</p></div>';
  }
  return `<div class="panel leaderboard">
    <h2>All-Time Leaders</h2>
    <div class="leaderboard-head"><span>Player</span><span>Wins</span><span>Winnings</span></div>
    ${state.leaderboard.map((row) => `<div class="leaderboard-row">
      <strong>${escapeHtml(row.display_name)}</strong>
      <span>${Number(row.wins)}</span>
      <span>${money(row.cash_winnings)}</span>
    </div>`).join('')}
  </div>`;
}

function lobbyHtml() {
  return `<div class="lobby-grid">
    <div class="panel lobby-join">
      ${state.databaseReady === false ? '<div class="setup-notice">Setup mode: the clue database still needs to be uploaded.</div>' : ''}
      <div class="badge">ROOM ${escapeHtml(state.session.room_code)}</div>
      <h2>Scan to Join</h2>
      <img class="qr-code" src="${escapeHtml(state.qrUrl)}" alt="QR code to join room ${escapeHtml(state.session.room_code)}">
      <p class="join-url">${escapeHtml(state.joinUrl)}</p>
      <p>${state.players.length} player${state.players.length === 1 ? '' : 's'} waiting</p>
      <div class="lobby-player-list">${state.players.map((player) => `<span class="badge">${escapeHtml(player.display_name)}</span>`).join('')}</div>
    </div>
    ${leaderboardHtml()}
  </div>`;
}

function renderScreen() {
  const root = $('#app');
  if (!state) return;
  if (state.session.status === 'complete') {
    root.innerHTML = topbarHtml() + finalSummaryHtml();
    setupFinalTimer();
    return;
  }
  if (state.session.status === 'lobby') {
    root.innerHTML = topbarHtml() + lobbyHtml();
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
      <div class="badge">DAILY DOUBLE</div>
      <div class="clue-text">${escapeHtml(activeCategoryName())}</div>
      ${stageScoresHtml()}
    </div></div>`;
  }
  return `<div class="clue-stage"><div>
    <div class="badge">${active.is_daily_double ? 'DAILY DOUBLE' : state.session.status === 'final_clue' ? 'FINAL GREGPARDY' : 'CLUE'}</div>
    <div class="clue-text">${escapeHtml(active.clue_text)}</div>
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
    ${state.session.status === 'final_answering' ? `<div class="submission-grid">${state.players.filter((p) => p.score > 0).map((player) => `
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
    return `<div class="clue-stage"><div>
      <div class="badge">FINAL RESULTS</div>
      <div class="clue-text">Final Results</div>
      <h2>Judge will reveal each player.</h2>
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
  </header>`;
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
    <label>Password<input id="gamePassword" type="password" autocomplete="current-password" autofocus></label>
    <button>Continue</button>
    <p id="authError" class="error"></p>
  </form>`;
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
  const eligibleFinal = me.score > 0;
  const finalResponse = finalResponseFor(me.player_id);
  let body = `<div class="panel stack"><h2>${escapeHtml(me.display_name)}</h2><div class="score">${money(me.score)}</div><p class="muted">Room ${state.session.room_code}</p></div>`;
  if (state.session.status === 'lobby') {
    body += `<div class="panel"><h2>Waiting for the judge</h2><p class="muted">${state.players.length} player(s) joined.</p></div>`;
  } else if (state.session.status === 'final_pity_vote') {
    body += pityVoteHtml(me);
  } else if (state.session.status === 'final_wager' && eligibleFinal) {
    if (finalResponse) body += submittedPanelHtml('Wager submitted');
    else body += `<form class="panel stack" onsubmit="submitWager(event)"><h2>Final Wager</h2><input id="wager" type="number" min="0" max="${me.score}" value="0"><button>Submit Wager</button></form>`;
  } else if (state.session.status === 'final_clue' && eligibleFinal) {
    body += `<div class="panel"><h2>Final clue revealed</h2><p class="muted">Wait for the judge to start the timer.</p></div>`;
  } else if (state.session.status === 'final_answering' && eligibleFinal) {
    if (finalResponse?.response_text) body += submittedPanelHtml('Answer submitted');
    else body += `<form class="panel stack" onsubmit="submitFinalResponse(event)"><h2>Final Response</h2><p class="muted">Anything in this text box at the end of the countdown will be submitted.</p><div id="finalTimer" class="phone-timer"></div><textarea id="responseText" oninput="saveFinalDraft()"></textarea><button>Submit Response</button></form>`;
  } else if (state.session.status === 'final_judging' && eligibleFinal) {
    body += `<div class="panel"><h2>Answers locked</h2><p class="muted">${finalResponse?.response_text ? 'Your answer was submitted.' : 'No answer was submitted before time expired.'}</p></div>`;
  } else if (state.session.status === 'final_results') {
    body += `<div class="panel"><h2>Final results</h2><p class="muted">Watch the main screen.</p></div>`;
  } else if (active?.is_daily_double && state.session.active_player_id === me.player_id) {
    body += `<div class="panel"><h2>Daily Double</h2><p class="muted">${active.status === 'daily_double' ? 'Tell the judge your wager out loud.' : 'Answer out loud when the judge reads the clue.'}</p></div>`;
  } else if (state.buzz?.open && active && !locked) {
    body += `<button type="button" class="big-button danger" onpointerdown="submitBuzz(event, ${me.player_id})" onclick="submitBuzz(event, ${me.player_id})">BUZZ</button>`;
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
  root.innerHTML = `<main class="phone stack">${body}<p id="error" class="error"></p></main>`;
  setupFinalTimer();
  setupAnswerTimer();
}

function submitBuzz(event, playerId) {
  event.preventDefault();
  const nowMs = Date.now();
  if (nowMs - lastBuzzSubmitAt < 500) return;
  lastBuzzSubmitAt = nowMs;
  emit('buzz:submit', { playerId });
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
  emit('final:submitWager', { playerId: myPlayerId, wager: Number($('#wager').value) });
  event.currentTarget.innerHTML = submittedPanelHtml('Wager submitted');
}

function submitFinalResponse(event) {
  event.preventDefault();
  if (!window.confirm('Submit this Final Jeopardy answer? This is your final decision.')) return;
  emit('final:submitResponse', { playerId: myPlayerId, responseText: $('#responseText').value });
  event.currentTarget.innerHTML = submittedPanelHtml('Answer submitted');
}

function saveFinalDraft() {
  if (finalDraftTimer) clearTimeout(finalDraftTimer);
  finalDraftTimer = setTimeout(() => {
    emit('final:saveDraft', { playerId: myPlayerId, responseText: $('#responseText')?.value || '' });
  }, 120);
}

function autoSubmitFinalResponse() {
  if (finalAutoSubmitted) return;
  const input = $('#responseText');
  if (!input || state?.session?.status !== 'final_answering') return;
  finalAutoSubmitted = true;
  emit('final:saveDraft', { playerId: myPlayerId, responseText: input.value });
  emit('final:submitResponse', { playerId: myPlayerId, responseText: input.value });
  const form = input.closest('form');
  if (form) form.innerHTML = submittedPanelHtml('Answer submitted at time');
}

function renderJudge() {
  const root = $('#app');
  if (!state) return;
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
        <div class="panel"><h2>Players</h2>${scoresHtml()}<div class="mini-grid">${state.players.map((p) => `
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
  if (!shouldWarn || window.confirm('Would you like to start a new room? Any current game would be lost.')) {
    emit('game:create');
  }
}

function confirmNewGame() {
  const unfinished = state.session.status !== 'complete';
  if (!unfinished || window.confirm('Start a new game in this room? The current game will be recorded as complete.')) {
    emit('game:new');
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
  const playerAnswering = !daily && !!selected;
  return `<div class="panel stack">
    <h2>${daily ? 'Daily Double' : 'Current Clue'}</h2>
    ${dailyWaiting ? `<p class="answer">Category: ${escapeHtml(activeCategoryName())}</p><p class="muted">Enter the wager, then show the clue.</p>` : `<p>${escapeHtml(active.clue_text)}</p><p class="answer">Response: ${escapeHtml(active.correct_response)}</p>`}
    ${daily ? `<label>Wager<input id="ddWager" type="number" min="5" max="${maxWager}" value="${dailyWager}" ${dailyLocked ? 'disabled' : ''}></label>
      ${dailyLocked ? `<p class="locked-wager">Locked wager: ${money(dailyWager)}</p>` : ''}
      <div class="actions">
        <button class="secondary" onclick="document.querySelector('#ddWager').value=${maxWager}" ${dailyLocked ? 'disabled' : ''}>True Daily Double</button>
        ${dailyWaiting ? `<button onclick="showDailyDoubleClue()">Show Clue</button>` : ''}
      </div>` : `
      ${playerAnswering ? judgeAnswerPromptHtml(active) : `<div class="actions judge-primary-actions">
        <button onclick="emit('buzz:open')">Open Buzzing</button>
        <button class="secondary" onclick="emit('buzz:close')">Close Buzzing</button>
      </div>
      <button class="secondary wide-action" onclick="emit('clue:close')">Close Clue</button>`}
      <p class="muted">Selected: ${selected ? escapeHtml(playerName(selected)) : 'none'}</p>
      <select id="winner">${state.players.map((p) => `<option value="${p.player_id}" ${selected === p.player_id ? 'selected' : ''}>${escapeHtml(p.display_name)}</option>`).join('')}</select>
      <button class="secondary" onclick="emit('buzz:overrideWinner',{playerId:Number(document.querySelector('#winner').value)})">Override Winner</button>`}
    ${daily ? `<div class="actions judge-primary-actions">
      <button class="good" onclick="judgeMark(true)" ${dailyWaiting ? 'disabled' : ''}>Correct</button>
      <button class="danger" onclick="judgeMark(false)" ${dailyWaiting ? 'disabled' : ''}>Incorrect</button>
    </div>` : ''}
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
    <button class="blue" onclick="emit('buzz:open')">Reopen Buzzing</button>
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
  const eligible = state.players.filter((p) => p.score > 0);
  const responses = new Map(state.final.responses.map((r) => [r.player_id, r]));
  const allJudged = eligible.length && eligible.every((p) => responses.get(p.player_id)?.is_correct !== null && responses.get(p.player_id)?.is_correct !== undefined);
  return `<div class="panel stack">
    <h2>Final GREGPARDY</h2>
    <p><strong>Category:</strong> ${escapeHtml(state.final.category?.category_name || '')}</p>
    <p class="answer"><strong>Correct:</strong> ${escapeHtml(state.final.clue?.correct_response || '')}</p>
    <div class="actions">
      <button onclick="emit('final:revealClue')" ${state.session.status !== 'final_wager' ? 'disabled' : ''}>Reveal Final Clue</button>
      ${state.session.status === 'final_clue' ? `<button onclick="emit('final:startTimer')">Start 30s Timer</button>` : ''}
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
