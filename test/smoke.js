const assert = require('node:assert/strict');
const { io } = require('socket.io-client');

const baseUrl = process.env.TEST_URL || 'http://localhost:3127';
const password = process.env.TEST_PASSWORD || 'test-password';

function connect(role, judgeToken = '', profileToken = '') {
  return io(baseUrl, { transports: ['websocket'], auth: { role, judgeToken, profileToken } });
}

function once(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

function stateMatching(socket, predicate) {
  return new Promise((resolve) => {
    const handler = (state) => {
      if (!predicate(state)) return;
      socket.off('state:update', handler);
      resolve(state);
    };
    socket.on('state:update', handler);
  });
}

async function authenticate(socket) {
  await once(socket, 'auth:required');
  const authenticatedPromise = once(socket, 'auth:authenticated');
  const statePromise = once(socket, 'state:update');
  socket.emit('auth:login', { password });
  const authenticated = await authenticatedPromise;
  assert.ok(authenticated.accessToken);
  return statePromise;
}

async function join(socket, roomCode, displayName, profileToken = '') {
  socket.emit('player:join', { roomCode, displayName, profileToken });
  return once(socket, 'player:joined');
}

async function claimJudge(socket, { judgeToken = '', takeover = false } = {}) {
  const claimedPromise = once(socket, 'judge:claimed');
  const statePromise = stateMatching(socket, (state) => state.isJudge);
  socket.emit('judge:claim', { judgeToken, takeover });
  const [claimed, state] = await Promise.all([claimedPromise, statePromise]);
  return { ...claimed, state };
}

async function main() {
  const judge = connect('judge');
  let playerOne = connect('player');
  const playerTwo = connect('player');
  const sockets = [judge, playerOne, playerTwo];
  try {
    await Promise.all([
      authenticate(judge),
      authenticate(playerOne),
      authenticate(playerTwo)
    ]);
    const initialJudge = await claimJudge(judge);
    const freshLobbyPromise = stateMatching(
      judge,
      (state) => state.session.status === 'lobby' && state.session.session_id !== initialJudge.state.session.session_id
    );
    judge.emit('game:create', { roomCode: '' });
    const judgeLobby = await freshLobbyPromise;
    const joinedOne = await join(playerOne, judgeLobby.session.room_code, 'Smoke One');
    const joinedTwo = await join(playerTwo, judgeLobby.session.room_code, 'Smoke Two');
    assert.ok(joinedOne.profileToken);
    assert.ok(joinedTwo.profileToken);

    const judgeStartedPromise = stateMatching(judge, (state) => state.session.status === 'J_categories');
    const playerStartedPromise = stateMatching(playerOne, (state) => state.session.status === 'J_categories');
    judge.emit('game:start');
    const judgeStarted = await judgeStartedPromise;
    assert.equal(judgeStarted.session.status, 'J_categories');
    assert.ok(judgeStarted.clues.some((clue) => clue.correct_response));

    const playerStarted = await playerStartedPromise;
    assert.equal(playerStarted.session.status, 'J_categories');
    assert.ok(playerStarted.clues.every((clue) => !Object.hasOwn(clue, 'correct_response')));
    assert.ok(!Object.hasOwn(playerStarted.final.clue || {}, 'correct_response'));

    const roundReadyPromise = stateMatching(judge, (state) => state.session.status === 'J');
    judge.emit('round:introNext');
    const roundReady = await roundReadyPromise;
    const clue = roundReady.clues.find((row) => row.status === 'hidden');
    const clueReadyPromise = stateMatching(judge, (state) => state.activeClue?.session_clue_id === clue.session_clue_id);
    judge.emit('clue:select', { sessionClueId: clue.session_clue_id });
    await clueReadyPromise;
    const buzzingPromise = stateMatching(judge, (state) => state.buzz?.open);
    judge.emit('buzz:open');
    await buzzingPromise;

    playerOne.close();
    playerOne = connect('player', '', joinedOne.profileToken);
    sockets.push(playerOne);
    const restoredPromise = once(playerOne, 'player:rejoined');
    await authenticate(playerOne);
    const restoredPlayer = await restoredPromise;
    assert.equal(restoredPlayer.playerId, joinedOne.playerId);
    const receivedPromise = once(playerOne, 'buzz:received');
    const winnerPromise = once(playerOne, 'buzz:winner');
    playerOne.emit('buzz:submit', { playerId: restoredPlayer.playerId });
    await receivedPromise;
    assert.equal((await winnerPromise).playerId, restoredPlayer.playerId);

    const reopenedPromise = stateMatching(
      judge,
      (state) => state.buzz?.open && state.buzz.selectedPlayerId === null && state.lockedOut.includes(restoredPlayer.playerId)
    );
    judge.emit('answer:incorrect', { playerId: restoredPlayer.playerId });
    await reopenedPromise;

    const secondReceivedPromise = once(playerTwo, 'buzz:received');
    const secondWinnerPromise = once(playerTwo, 'buzz:winner');
    playerTwo.emit('buzz:submit', { playerId: joinedTwo.playerId });
    await secondReceivedPromise;
    assert.equal((await secondWinnerPromise).playerId, joinedTwo.playerId);

    const exhaustedPromise = stateMatching(
      judge,
      (state) => state.buzz?.open === false && state.buzz.selectedPlayerId === null && state.lockedOut.length === 2
    );
    judge.emit('answer:incorrect', { playerId: joinedTwo.playerId });
    await exhaustedPromise;

    const clueClosedPromise = stateMatching(judge, (state) => !state.activeClue);
    judge.emit('clue:close');
    await clueClosedPromise;

    const previousRoom = judgeStarted.session.room_code;
    const newLobbyPromise = stateMatching(judge, (state) => state.session.status === 'lobby');
    judge.emit('game:new', { categoryCount: 4 });
    const newLobby = await newLobbyPromise;
    assert.equal(newLobby.session.status, 'lobby');
    assert.equal(newLobby.session.room_code, previousRoom);
    assert.equal(newLobby.session.category_count, 4);
    assert.ok(newLobby.roomLeaderboard.length >= 2);

    playerOne.emit('player:rejoin', { profileToken: joinedOne.profileToken });
    const rejoined = await once(playerOne, 'player:rejoined');
    assert.notEqual(rejoined.playerId, joinedOne.playerId);

    const rejoinedTwo = await join(playerTwo, newLobby.session.room_code, 'Smoke Two', joinedTwo.profileToken);
    const shortGamePromise = stateMatching(judge, (state) => state.session.status === 'J_categories');
    judge.emit('game:start', { allowRepeats: true, categoryCount: 4 });
    const shortGame = await shortGamePromise;
    assert.equal(shortGame.categories.length, 4);
    assert.equal(shortGame.clues.length, 20);

    const shortRoundPromise = stateMatching(judge, (state) => state.session.status === 'J');
    judge.emit('round:introNext');
    const shortRound = await shortRoundPromise;
    const dailyDouble = shortRound.clues.find((clueRow) => clueRow.is_daily_double);
    const dailySelectedPromise = stateMatching(
      judge,
      (state) => state.activeClue?.session_clue_id === dailyDouble.session_clue_id
    );
    judge.emit('clue:select', { sessionClueId: dailyDouble.session_clue_id });
    await dailySelectedPromise;
    const dailyShownPromise = stateMatching(judge, (state) => state.activeClue?.status === 'revealed');
    judge.emit('clue:showDailyDouble', { wager: 400 });
    await dailyShownPromise;
    const dailyTimerPromise = stateMatching(judge, (state) => state.answerTimerEndsAt > Date.now());
    judge.emit('answer:startTimer');
    await dailyTimerPromise;
    const dailyClosedPromise = stateMatching(judge, (state) => !state.activeClue);
    judge.emit('clue:close');
    await dailyClosedPromise;

    assert.ok(rejoinedTwo.playerId);

    const chosenRoomPromise = stateMatching(
      judge,
      (state) => state.session.status === 'lobby' && state.session.room_code === '8642'
    );
    judge.emit('game:create', { roomCode: '8642' });
    const chosenRoom = await chosenRoomPromise;
    assert.equal(chosenRoom.session.room_code, '8642');

    const secondJudge = connect('judge');
    sockets.push(secondJudge);
    const secondJudgeState = await authenticate(secondJudge);
    assert.equal(secondJudgeState.isJudge, false);
    assert.equal(secondJudgeState.judgeStatus.occupied, true);

    const revokedPromise = once(judge, 'judge:revoked');
    const changedNoticePromise = stateMatching(
      playerOne,
      (state) => state.hostNotice?.message === 'THE JUDGE/HOST HAS CHANGED!'
    );
    const secondClaim = await claimJudge(secondJudge, { takeover: true });
    assert.match(await revokedPromise, /taken over/i);
    const changedState = await changedNoticePromise;
    assert.ok(changedState.hostNotice.endsAt > Date.now());

    const deniedPromise = once(judge, 'error:message');
    judge.emit('game:create', { roomCode: '7777' });
    assert.match(await deniedPromise, /active host/i);

    secondJudge.close();
    const reconnectingJudge = connect('judge', secondClaim.judgeToken);
    sockets.push(reconnectingJudge);
    const reclaimedPromise = once(reconnectingJudge, 'judge:claimed');
    const reclaimedState = await authenticate(reconnectingJudge);
    assert.equal(reclaimedState.isJudge, true);
    assert.equal((await reclaimedPromise).judgeToken, secondClaim.judgeToken);

    await join(playerOne, chosenRoom.session.room_code, 'Smoke One', joinedOne.profileToken);
    const playerJudge = connect('judge', '', joinedOne.profileToken);
    sockets.push(playerJudge);
    await authenticate(playerJudge);
    const playerJudgeClaim = await claimJudge(playerJudge, { takeover: true });
    const markedHost = playerJudgeClaim.state.players.find((player) => player.display_name === 'Smoke One');
    assert.equal(markedHost.is_host, 1);

    const carriedHostPromise = stateMatching(
      playerJudge,
      (state) => state.session.status === 'lobby'
        && state.session.session_id !== playerJudgeClaim.state.session.session_id
        && state.players.some((player) => player.display_name === 'Smoke One' && player.is_host === 1)
    );
    playerJudge.emit('game:new');
    await carriedHostPromise;
    console.log('Smoke test passed');
  } finally {
    sockets.forEach((socket) => socket.close());
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
