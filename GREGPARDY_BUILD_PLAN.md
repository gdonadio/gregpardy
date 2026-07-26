# GREGPARDY! Build Plan

This document is a self-contained programming brief for building the first playable version of **GREGPARDY!**, a local multiplayer Jeopardy-style party game. Assume no prior project context beyond this file.

## Project Location

Build in the repository root:

```text
gregpardy/
```

Existing files include:

```text
jeopardy.db
jeopardy.db-wal
jeopardy.db-shm
webscraper.ipynb
```

The existing SQLite database is the source of all clue/category data.

## Product Goal

Create a Jackbox-style local web game:

- A TV/computer screen shows the game board, clues, scores, and final results.
- Players join from phones through a webpage. No app downloads.
- A judge joins from a phone/tablet/laptop and acts as host/admin.
- Players speak answers out loud.
- The judge marks answers correct or incorrect.
- Scores update automatically.
- Categories already used in previous games should be avoided.
- If unused categories run out, the app should clearly say so and offer the judge an option to allow repeats.

The game should be named:

```text
GREGPARDY!
```

Avoid using official Jeopardy branding beyond generic game mechanics.

## Recommended Tech Stack

Use:

- Node.js
- Express
- Socket.IO
- SQLite
- `better-sqlite3` preferred for simple synchronous SQLite access
- Plain HTML/CSS/JS or React/Vite

For the first version, simplicity is more important than perfect architecture. A well-organized Express + Socket.IO app with simple client pages is acceptable.

## Existing Database Schema

The current `jeopardy.db` includes:

```sql
CREATE TABLE episode (
  game_id     INTEGER PRIMARY KEY,
  show_number INTEGER NOT NULL,
  air_date    TEXT    NOT NULL,
  title       TEXT
);

CREATE TABLE category (
  category_id INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     INTEGER NOT NULL REFERENCES episode(game_id),
  round       TEXT    NOT NULL CHECK (round IN ('J','DJ','FJ')),
  board_col   INTEGER,
  name        TEXT    NOT NULL,
  comments    TEXT,
  UNIQUE(game_id, round, board_col)
);

CREATE TABLE clue (
  clue_id          INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id      INTEGER NOT NULL REFERENCES category(category_id),
  row_in_category  INTEGER NOT NULL,
  value_cents      INTEGER,
  clue_order       INTEGER,
  is_daily_double  INTEGER NOT NULL DEFAULT 0,
  clue_text        TEXT NOT NULL,
  correct_response TEXT NOT NULL,
  UNIQUE(category_id, row_in_category)
);

CREATE TABLE used_category (
  category_id INTEGER PRIMARY KEY REFERENCES category(category_id),
  used_at     TEXT NOT NULL
);

CREATE INDEX idx_episode_air_date ON episode(air_date);
CREATE INDEX idx_category_round_game ON category(round, game_id);
CREATE INDEX idx_clue_category_row ON clue(category_id, row_in_category);
```

Important:

- `clue.clue_text` is the clue shown to everyone.
- `clue.correct_response` is shown only to the judge.
- Ignore `clue.is_daily_double` for gameplay. GREGPARDY! assigns Daily Doubles randomly each game.
- Normalize dollar values instead of relying on historical database values.

## New Tables To Add

Add migration code that creates these tables if they do not exist:

```sql
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
```

## User Roles And Routes

Implement these pages:

```text
/screen
```

The big display for TV/computer. Shows lobby, join URL, room code, board, clues, scores, Final Jeopardy, and winner.

```text
/
```

Player phone join page. Players enter room code and display name.

```text
/player
```

Player phone game page. Shows current state, buzz button, final wager/response forms, and pity vote UI when needed.

```text
/judge
```

Judge/host/admin page. The judge starts games, chooses clues, sees correct responses, opens buzzing, marks answers, enters wagers for Daily Doubles if needed, advances rounds, handles Final Jeopardy, and can allow repeated categories if necessary.

Optional:

```text
/admin
```

Only add this if useful. For MVP, judge can be the admin.

## Joining Flow

The host starts the server locally on the laptop. The screen page should display:

- Game title: `GREGPARDY!`
- Local join URL, for example `http://192.168.1.23:3000`
- Room code, for example `4827`
- Optional QR code for the player URL
- Player list as players join

Players:

1. Open the join URL on their phones.
2. Enter room code.
3. Enter display name.
4. Wait in lobby until judge starts.

Judge:

1. Open `/judge`.
2. Start a new game.
3. Manage the game from judge page.

For MVP, assume one active room/game at a time. Still use a room code so the UI feels intentional and so stale tabs can be rejected.

Support 2 to 8 players.

## Board Generation

When the judge starts a new game:

1. Randomly select 6 unused complete `J` categories.
2. Randomly select 6 unused complete `DJ` categories.
3. Randomly select 1 unused `FJ` category.
4. Mark selected categories in `used_category` immediately when the game starts.
5. Create `game_session_category` and `game_session_clue` records for all selected data.

Completeness rules:

- A `J` or `DJ` category must have exactly 5 clues.
- An `FJ` category must have exactly 1 clue.
- Prefer filtering out categories with empty/null clue text or correct response.

If not enough unused categories exist:

1. Stop game creation.
2. Show the judge a clear message like: `Not enough unused complete categories remain.`
3. Offer a judge button: `Allow Repeats For This Game`.
4. If clicked, regenerate while allowing previously used categories.

## Normalized Values

Ignore historic clue values for display/scoring.

Regular Jeopardy round:

```text
Row 1: $200
Row 2: $400
Row 3: $600
Row 4: $800
Row 5: $1000
```

Double Jeopardy round:

```text
Row 1: $400
Row 2: $800
Row 3: $1200
Row 4: $1600
Row 5: $2000
```

Final Jeopardy:

- Player-specific wager.

## Daily Doubles

Ignore `clue.is_daily_double`.

Randomly assign Daily Doubles each new game:

- 1 Daily Double in `J`.
- 2 Daily Doubles in `DJ`.
- Daily Doubles can only appear in rows 2, 3, or 4.
- Do not put more than one Daily Double in the same category within a round.

When a Daily Double is selected:

1. Screen shows Daily Double state.
2. Judge asks active player for wager out loud.
3. Judge types wager into judge UI.
4. Judge UI includes a `True Daily Double` button.
5. The Daily Double player answers without buzzing.
6. Judge marks correct/incorrect.
7. Score changes by wager amount.

Daily Double wager validation:

- If player score is positive, max wager is their current score or the highest clue value in the round, whichever is greater.
- If player score is zero or negative, max wager is the highest clue value in the round.
- Minimum wager should be 5 or 1. Use 5 unless the user later requests exact TV rules.

## Clue Selection

For V1, clue selection is judge-only.

Flow:

1. Active player says their desired clue out loud, e.g. `History for 800`.
2. Judge taps that clue on the judge UI.
3. Screen reveals the clue.
4. Judge controls buzzing/scoring.

Do not build player-pick clue selection in V1.

## Buzzing Rules

Use a configurable buzz fairness window:

```js
const BUZZ_WINDOW_MS = 300;
```

Flow:

1. Judge taps `Open Buzzing`.
2. Player phones show a large buzz button.
3. Nothing happens until the first buzz arrives.
4. When the first buzz arrives, start a 300ms collection window.
5. Collect all buzzes received during that 300ms window.
6. Randomly select one player from the collected group.
7. Show selected player on screen and judge UI.
8. Store all buzzes in `buzz_event`, with the selected one marked.
9. Selected player answers out loud.
10. Judge marks correct or incorrect.

If correct:

- Add clue value to selected player's score.
- Mark clue complete.
- Selected player becomes active player.

If incorrect:

- Subtract clue value from selected player's score.
- Lock selected player out for this clue.
- Judge may reopen buzzing for remaining players.
- If no one else answers, judge can mark the clue complete.

Judge should have override controls:

- Pick a different buzz winner.
- Reopen buzzing.
- Close clue with no correct answer.
- Adjust player scores manually.

## Turn Control

Allow negative scores during regular and double rounds.

The active player is the player who last answered correctly. At game start, judge can choose the first active player or the app can randomly select one.

Because clue selection is judge-only in V1, active player is mostly informational and used for Daily Doubles.

## Round Flow

Statuses should be explicit, for example:

```text
lobby
J
DJ
final_pity_vote
final_wager
final_clue
final_judging
complete
```

Flow:

1. Lobby
2. Judge starts game
3. Regular Jeopardy board
4. All regular clues completed
5. Judge advances to Double Jeopardy
6. All double clues completed
7. Pity vote phase, if any player has zero or negative score
8. Final Jeopardy wager phase
9. Final clue/response phase
10. Final judging
11. Winner screen

## Pity Vote Rule

Players with positive scores can vote to allow players with zero or negative scores to be reset to `$1` so they can participate in Final Jeopardy.

Implement simply:

1. After Double Jeopardy, identify:
   - Eligible voters: players with score > 0.
   - Pity candidates: players with score <= 0.
2. For each pity candidate, show positive-score players a vote:
   - `Let [name] play Final with $1?`
   - `Yes`
   - `No`
3. If a majority of eligible voters vote yes, set that player's score to 1.
4. Record score adjustment in `score_event` with reason `pity_reset`.
5. If there are no positive-score players, skip Final Jeopardy and show final results.

For MVP, it is acceptable to process candidates one at a time on the judge page to avoid complicated UI.

## Final Jeopardy

Only players with positive scores after the pity vote phase may play Final Jeopardy.

Flow:

1. Screen shows Final Jeopardy category only.
2. Eligible players submit wagers on their phones.
3. Wager must be between 0 and their current score.
4. Judge can monitor who has submitted.
5. Once all wagers are submitted, judge reveals final clue.
6. Screen shows final clue.
7. Eligible players type final response on their phones.
8. Judge sees:
   - each player's wager
   - each player's typed response
   - the correct response
9. Judge marks each response correct or incorrect.
10. App applies score changes.
11. Screen shows final scores and winner.

## Screen UI Requirements

The screen should be readable from across a room.

Lobby screen:

- Large `GREGPARDY!` title.
- Join URL.
- Room code.
- Player list.
- Waiting/ready status.

Board screen:

- 6 category columns.
- 5 value rows.
- Current round label.
- Current scores visible.
- Used clues visually disabled.
- Active player visible.

Clue screen:

- Large clue text.
- Scores still visible if possible.
- Buzzing status.
- Selected buzzer name when chosen.

Final screen:

- Category.
- Clue.
- Player submission status.
- Final results.

## Player Phone UI Requirements

Keep phone UI large and simple.

States:

- Join room
- Lobby/waiting
- Waiting for clue
- Buzz button
- Locked out for current clue
- Daily Double status if active player
- Final wager form
- Final response form
- Pity vote UI
- Final score/result

Buzz button should be very large and hard to miss.

## Judge UI Requirements

Judge is host/admin in V1.

Judge page should support:

- Start new game.
- See players.
- Start round.
- Select clues.
- See clue text and correct response.
- Open buzzing.
- See buzz group and selected player.
- Mark correct.
- Mark incorrect.
- Reopen buzzing.
- Close clue.
- Handle Daily Double wagers.
- Use `True Daily Double` button.
- Adjust scores manually.
- Advance to next round.
- Run pity vote.
- Reveal Final Jeopardy clue.
- Judge final responses.
- End game.
- Allow repeated categories if unused categories are insufficient.

## Socket.IO Events

Suggested events from client to server:

```text
player:join
judge:join
game:create
game:start
game:allowRepeats
clue:select
buzz:open
buzz:submit
buzz:overrideWinner
answer:correct
answer:incorrect
clue:close
score:adjust
round:advance
dailyDouble:setWager
dailyDouble:trueDailyDouble
final:submitWager
final:submitResponse
pity:submitVote
final:judgeResponse
game:end
```

Suggested events from server to clients:

```text
state:update
error:message
buzz:opened
buzz:closed
buzz:winner
clue:revealed
score:updated
round:changed
final:category
final:clue
game:complete
```

The server should be the source of truth. Clients should render the latest `state:update`.

## State Management

Maintain an in-memory representation of the active game for speed, but persist all meaningful events to SQLite.

On server start:

- Run migrations.
- If there is an incomplete session, either load it or offer the judge a `Resume / Start Fresh` choice.

For MVP, it is acceptable to support only one active session.

## SQLite Notes

Because the database may also be open in a notebook, use SQLite carefully:

- Use short transactions.
- Enable busy timeout.
- Consider WAL mode if not already enabled.
- Handle `database is locked` gracefully with a friendly error and retry where appropriate.

Example setup with `better-sqlite3`:

```js
const db = new Database('jeopardy.db');
db.pragma('busy_timeout = 5000');
db.pragma('journal_mode = WAL');
```

## Category Selection Query Guidance

Use SQL that finds complete categories.

For J/DJ:

```sql
SELECT c.category_id
FROM category c
JOIN clue cl ON cl.category_id = c.category_id
WHERE c.round = ?
  AND (? = 1 OR c.category_id NOT IN (SELECT category_id FROM used_category))
  AND TRIM(c.name) <> ''
GROUP BY c.category_id
HAVING COUNT(cl.clue_id) = 5
   AND SUM(CASE WHEN TRIM(cl.clue_text) = '' THEN 1 ELSE 0 END) = 0
   AND SUM(CASE WHEN TRIM(cl.correct_response) = '' THEN 1 ELSE 0 END) = 0
ORDER BY RANDOM()
LIMIT ?;
```

For FJ:

```sql
SELECT c.category_id
FROM category c
JOIN clue cl ON cl.category_id = c.category_id
WHERE c.round = 'FJ'
  AND (? = 1 OR c.category_id NOT IN (SELECT category_id FROM used_category))
  AND TRIM(c.name) <> ''
GROUP BY c.category_id
HAVING COUNT(cl.clue_id) = 1
   AND SUM(CASE WHEN TRIM(cl.clue_text) = '' THEN 1 ELSE 0 END) = 0
   AND SUM(CASE WHEN TRIM(cl.correct_response) = '' THEN 1 ELSE 0 END) = 0
ORDER BY RANDOM()
LIMIT 1;
```

## Implementation Milestones

### Milestone 1: Project Setup

- Create `package.json`.
- Install dependencies.
- Create server entry point.
- Serve static pages.
- Add Socket.IO.
- Add SQLite connection and migrations.
- Add basic `/screen`, `/`, `/player`, and `/judge` pages.

### Milestone 2: Lobby

- Create a new game session.
- Generate room code.
- Let players join with name and room code.
- Enforce 2-8 players.
- Display joined players on screen and judge page.

### Milestone 3: Board Generation

- Select random categories and clues.
- Assign normalized values.
- Assign random Daily Doubles.
- Mark categories used.
- Render regular round board on screen and judge page.

### Milestone 4: Clue Play

- Judge selects clue.
- Screen displays clue.
- Judge sees clue and correct response.
- Judge opens buzzing.
- Players buzz.
- Server applies 300ms buzz window.
- Judge marks correct/incorrect.
- Scores update.
- Clue becomes completed.

### Milestone 5: Daily Doubles

- Detect selected Daily Double.
- Skip buzzing.
- Judge enters wager.
- Include `True Daily Double` button.
- Judge marks correct/incorrect.
- Apply score delta.

### Milestone 6: Round Advancement

- Detect all clues completed.
- Judge advances from J to DJ.
- Render DJ board with normalized values.

### Milestone 7: Pity Vote

- After DJ, identify players with score <= 0.
- Let positive-score players vote from phones.
- Apply majority yes vote as reset to $1.
- Record score events.

### Milestone 8: Final Jeopardy

- Show final category.
- Collect typed wagers from eligible players.
- Reveal final clue.
- Collect typed responses.
- Judge marks responses.
- Apply scoring.
- Show winner.

### Milestone 9: Admin Polish

- Manual score adjustment.
- Reopen buzzing.
- Override buzz winner.
- Close clue.
- Allow repeated categories if needed.
- Resume/start fresh handling.

### Milestone 10: Usability Polish

- QR code for player join URL.
- Large readable TV styling.
- Large phone buttons.
- Clear judge controls.
- Friendly error states.

## Acceptance Criteria For MVP

The MVP is complete when:

- The server runs locally.
- A screen page can show a join URL and room code.
- 2-8 players can join from phones/browsers.
- Judge can start a game.
- The app creates J, DJ, and FJ boards from `jeopardy.db`.
- Used categories are marked at game start.
- Repeated categories are blocked by default.
- Judge can allow repeats if necessary.
- Judge can select clues.
- Screen displays clues.
- Judge sees correct responses.
- Players can buzz.
- Buzzing uses the 300ms first-buzz collection window.
- Judge can mark answers correct/incorrect.
- Scores update automatically, including negative scores.
- Random Daily Doubles work with judge-entered wagers and a True Daily Double button.
- Final Jeopardy supports typed wagers and typed responses.
- Positive-score players can vote to reset non-positive players to $1 before Final Jeopardy.
- Final scores and winner are shown.

## Suggested Development Commands

The final project should ideally support:

```bash
npm install
npm run dev
```

And then open:

```text
http://localhost:3000/screen
http://localhost:3000
http://localhost:3000/judge
```

For local phone testing, the screen should show the computer's LAN IP address, for example:

```text
http://192.168.1.23:3000
```

## Important UX Defaults

- Judge-only clue selection in V1.
- Judge is also host/admin.
- 2-8 players.
- Negative scores allowed.
- Only positive-score players reach Final Jeopardy unless pity vote resets them to $1.
- Pity vote is performed by positive-score players.
- Buzz window is 300ms, starting after the first buzz.
- Daily Doubles are randomly assigned by the app, not copied from source data.
- Daily Doubles appear only in rows 2-4.
- No more than one Daily Double per category per round.
- Categories are marked used when the game starts.
