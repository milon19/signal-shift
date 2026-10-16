# Signal Shift Lite (MVP)

> Everyone has a secret clue. Talk it through, then the Captain picks the answer.

See `CLAUDE.md` for the MVP scope and `docs/design.md` for the long-term design.

```
apps/server      Node + TS + Socket.IO — authoritative game state (in memory)
apps/web         React + TS + Vite — lobby/round/reveal client
packages/shared  Types shared by both (commands, views, socket events)
```

## Running

```sh
yarn install
yarn dev:server   # http://localhost:3001 (PORT, CORS_ORIGIN env vars)
yarn dev:web      # http://localhost:5173 (VITE_SERVER_URL to point elsewhere)
yarn test         # game logic, room manager and Socket.IO integration tests
yarn typecheck
yarn build
```

## How to play / test locally

1. Run `yarn dev:server` and `yarn dev:web` in two terminals.
2. Open http://localhost:5173 in **5 browser tabs** (the game needs 5–10 players; each tab is a separate player).
3. In tab 1, enter a nickname and leave the room code empty → **Create room**. Note the 4-letter code.
4. In the other tabs, enter a nickname and the code → **Join room**.
5. In tab 1 (the host), press **Start game**.
6. Each round, every tab shows the question, the 3 answers and its own clue. Find the tab that says
   **Captain: You!** and pick an answer (or wait for the 90 s timer to run out).
7. The reveal shows whether it was right and everyone's clues. After 3 rounds you get
   "You solved X of 3"; the host can press **Play again**.

In a real game, everyone joins from their own laptop while on a Google Meet/Discord call.

## Server design

- `src/game/engine.ts` — the state machine. Pure, synchronous functions over `GameState`:
  `LOBBY → ROUND → REVEAL → (next ROUND …) → RESULTS`.
  Phases advance on server-owned deadlines (`tick`) or when the host skips ahead; the Captain's pick ends a round.
- `src/game/view.ts` — per-player projection. During a round a client receives only its own clue and never which
  answer is correct; everyone's clues are sent only in REVEAL. Tokens stay on the server.
- `src/game/scenario.ts` + `scenarios/*.json` — scenario content as data, validated on load
  (exactly 3 rounds, 3 answers with exactly one correct, 5 clues each).
- `src/rooms/roomManager.ts` — room codes, join/rejoin, command validation (zod), `commandId` de-duplication and `expectedVersion` checks.
  Results are `accepted | duplicate | stale_state | unauthorised | invalid`.
- `src/socket.ts` — Socket.IO wiring: `room:create`, `room:join`, `room:rejoin`, `game:command`; pushes `game:state` to each socket.

### Rules implemented

- 5–10 players; first joiner is host; host can start, kick (lobby only; kicked nicknames can't rejoin), skip a phase and play again.
- Seats are shuffled from the room's seed at start. The Captain is seat *(round − 1)*, so it's a different player every round.
- Clues: seat *s* gets clue *(s + round − 1) mod 5* — one clue each, shared when there are more than 5 players.
- ROUND (90 s): only the Captain can `PICK_ANSWER`; picking ends the round. Timing out (or a host skip) fails the round.
- REVEAL (15 s): result, narration and every player's clue with their name.
- RESULTS: score = rounds solved out of 3, plus a fun line from the scenario.
- Disconnected players keep their seat and can rejoin with their token; the host role passes to a connected player.
