# GREGPARDY!

A single-room multiplayer trivia game built with Node, Express, Socket.IO, and SQLite.

## Local development

The clue database is intentionally excluded from Git. Place `jeopardy.db` in this
directory, create `.env` from `.env.example`, then run:

```bash
npm ci
npm run dev
```

For repository linting, install Ruff and run both lint suites:

```bash
python -m pip install -r requirements-dev.txt
npm run lint
```

Open:

- Player join: `http://localhost:3000`
- Main screen: `http://localhost:3000/screen`
- Judge: `http://localhost:3000/judge`

## Environment variables

- `GAME_PASSWORD`: shared password required on every device.
- `AUTH_SECRET`: long random value used to sign browser access tokens.
- `PUBLIC_URL`: public origin with no trailing slash, such as
  `https://gregpardy.onrender.com`.
- `DB_PATH`: SQLite path. It defaults to `./jeopardy.db` locally and should be
  `/var/data/jeopardy.db` on Render.
- `PORT`: supplied automatically by Render.

Never commit `.env` or any SQLite database files.

## Render database setup

The repository does not contain the SQLite database. The first Render deployment
can start with an empty database at `/var/data/jeopardy.db`; the site will not have
clues until the real file is transferred.

For the initial transfer:

1. Create the paid Render web service and persistent disk using `render.yaml`.
2. Set `GAME_PASSWORD` and `PUBLIC_URL` in the Render dashboard.
3. Complete one successful deployment.
4. Use Render SSH/SCP or Magic Wormhole to upload the local database to a staging
   filename such as `/var/data/jeopardy.upload.db`.
5. In Render, temporarily set `DB_PATH=/var/data/jeopardy.upload.db` and restart.
6. After verifying the clue count and site, keep that path or, during planned
   downtime, rename it to `/var/data/jeopardy.db` and restore the normal `DB_PATH`.

Do not overwrite a SQLite file while the application has it open.

The persistent disk retains player profiles, completed games, leaderboards, and
used-category history across code deployments. Keep the service at one instance.

## Game and room behavior

- **New Game** completes the current game, retains the room code, and opens a new
  lobby. When the host starts the game, they choose a regular six-category game
  or a shorter game with 3-5 categories per round. Existing player browsers
  automatically rejoin with their persistent profile.
- **New Room** generates a new room code and clears the current group.
- The lobby shows the room QR code, waiting players, total wins, and cumulative
  winning scores.
