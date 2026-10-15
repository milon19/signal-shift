# Signal Shift (MVP)

See `docs/design.md` for the full design and `CLAUDE.md` for the MVP scope.

```
apps/server      Node + TS + Socket.IO — authoritative game state (in memory)
apps/web         React + TS + Vite — lobby/role/clue client
packages/shared  Types shared by both (commands, views, socket events)
```

## Running

```sh
yarn install
yarn dev:server   # http://localhost:3001 (PORT, CORS_ORIGIN env vars)
yarn dev:web      # http://localhost:5173 (VITE_SERVER_URL to point elsewhere)
yarn test         # game logic, room manager and Socket.IO integration tests
yarn typecheck
```

## Server design

- `src/game/engine.ts` — the state machine. Pure, synchronous functions over `GameState`:
  `LOBBY → ACT_SCAN → ACT_RELAY → ACT_VERIFY → ACT_COMMIT → CONSEQUENCE → HANDOFF → … → RESULTS`.
  Phases advance on server-owned deadlines (`tick`) or when the host skips ahead; committing an action ends the act.
- `src/game/view.ts` — per-player projection. Clients receive only their own clues; fact truths and tokens stay on the server.
- `src/game/scenario.ts` + `scenarios/*.json` — scenario content as data, validated on load (act graph must be exactly 3 acts on every branch).
- `src/rooms/roomManager.ts` — room codes, join/rejoin, command validation (zod), `commandId` de-duplication and `expectedVersion` checks.
  Results are `accepted | duplicate | stale_state | unauthorised | invalid`.
- `src/socket.ts` — Socket.IO wiring: `room:create`, `room:join`, `room:rejoin`, `game:command`; pushes `game:state` to each socket.

### Rules implemented

- 5–10 players; first joiner is host; host can start, kick (lobby only) and skip a phase.
- Roles: the five core roles at 5 players; extra seats get overlapping Navigator/Decoder/Dispatcher roles whose clues are dealt round-robin. Exactly one Operator and Auditor.
- Rotation: seat *s* holds role slot *(s + act) mod n*, so Operator and Auditor change hands every act.
- Claims reference a scenario fact (true/false assertion + free text). Anyone can stake 1–3 team Sync once per claim during Relay/Verify. The Auditor can verify a limited number per act, which closes staking on that claim. At Consequence, correct stakes return double; wrong stakes are lost.
- Dispatcher can pin one of their own clues to the shared board per act.
- The Operator's act-2 decision picks the finale. Stability ≤ 0 ends the shift early, but a scored debrief is still produced.
- Score (1,000 max): objectives 450, efficiency 200 (stability + Sync), staked claim accuracy 150, per-act action coverage 100, stability recovery 100. Talk time, message counts and speed are never scored.
