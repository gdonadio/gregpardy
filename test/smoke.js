const assert = require('node:assert/strict');
const { io } = require('socket.io-client');

const baseUrl = process.env.TEST_URL || 'http://localhost:3127';
const password = process.env.TEST_PASSWORD || 'test-password';

function connect(role) {
  return io(baseUrl, { transports: ['websocket'], auth: { role } });
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

async function main() {
  const judge = connect('judge');
  const playerOne = connect('player');
  const playerTwo = connect('player');
  const sockets = [judge, playerOne, playerTwo];
  try {
    const [judgeLobby] = await Promise.all([
      authenticate(judge),
      authenticate(playerOne),
      authenticate(playerTwo)
    ]);
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

    const previousRoom = judgeStarted.session.room_code;
    const newLobbyPromise = stateMatching(judge, (state) => state.session.status === 'lobby');
    judge.emit('game:new');
    const newLobby = await newLobbyPromise;
    assert.equal(newLobby.session.status, 'lobby');
    assert.equal(newLobby.session.room_code, previousRoom);
    assert.ok(newLobby.roomLeaderboard.length >= 2);

    playerOne.emit('player:rejoin', { profileToken: joinedOne.profileToken });
    const rejoined = await once(playerOne, 'player:rejoined');
    assert.notEqual(rejoined.playerId, joinedOne.playerId);

    const chosenRoomPromise = stateMatching(
      judge,
      (state) => state.session.status === 'lobby' && state.session.room_code === '8642'
    );
    judge.emit('game:create', { roomCode: '8642' });
    const chosenRoom = await chosenRoomPromise;
    assert.equal(chosenRoom.session.room_code, '8642');
    console.log('Smoke test passed');
  } finally {
    sockets.forEach((socket) => socket.close());
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
