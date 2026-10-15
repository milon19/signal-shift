# Signal Shift — MVP

Design doc: docs/design.md. Build ONLY the MVP slice below; ignore beta/full-release features.

## MVP scope
- 5–10 players, one scenario, Standard Shift (3 acts)
- Room code join, guest nickname, host start/kick
- Roles: Navigator, Decoder, Operator, Auditor, Dispatcher
- Private clues per role, role rotation each act, claims + Sync staking, one branch decision
- Voice: NONE (players use Google Meet/Discord alongside)
- No accounts, no database, no LiveKit, no Phaser yet

## Stack
- Monorepo with pnpm workspaces: apps/web (React + TS + Vite), apps/server (Node + TS + Socket.IO), packages/shared (types)
- Server is authoritative: clients send commands with commandId; server validates role/phase/version
- Game state in memory on the server

## Rules
- Each task: add tests for game logic, run them, open a PR
- Keep scenario content as JSON data, not hard-coded logic