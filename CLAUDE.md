# Signal Shift — MVP

Design doc: docs/design.md. Build ONLY the MVP slice below; ignore beta/full-release features.

## MVP scope — "Signal Shift Lite"
- 5–10 players, one scenario, 3 rounds
- Room code join, guest nickname, host start/kick/skip/play again
- Each round: shared question + 3 answers, one private clue per player, a rotating Captain picks the answer (90 s timer); then a reveal of everyone's clues
- Score = rounds solved (out of 3). No roles, claims, Sync, audits, pins, Stability or branching
- Voice: NONE (players use Google Meet/Discord alongside)
- No accounts, no database, no LiveKit, no Phaser yet

## Stack
- Monorepo with Yarn (v1) workspaces: apps/web (React + TS + Vite), apps/server (Node + TS + Socket.IO), packages/shared (types)
- Server is authoritative: clients send commands with commandId; server validates player/phase/version
- Game state in memory on the server

## Rules
- Each task: add tests for game logic, run them, open a PR
- Keep scenario content as JSON data, not hard-coded logic