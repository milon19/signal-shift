import { MAX_PLAYERS, MIN_PLAYERS, type CommandStatus, type GameCommand, type Phase } from "@signal-shift/shared";
import { createRng, shuffle } from "./rng.js";
import type { Scenario, ScenarioRound } from "./scenario.js";

// Authoritative game state machine. All functions here are synchronous and
// deterministic given (state, input, now); the room layer owns timers and I/O.
//
//   LOBBY -> ROUND -> REVEAL -> ROUND -> REVEAL -> ROUND -> REVEAL -> RESULTS

export const MAX_NICKNAME = 20;

export interface Player {
  id: string;
  nickname: string;
  /** Secret used to rejoin after a disconnect. Never sent to other players. */
  token: string;
  connected: boolean;
}

export interface RoundOutcome {
  /** The Captain's pick, or null if the round timed out. */
  answerId: string | null;
  correct: boolean;
  narration: string;
}

export interface GameState {
  roomCode: string;
  scenario: Scenario;
  seed: number;
  version: number;
  phase: Phase;
  phaseDeadline: number | null;
  hostId: string | null;
  /** Join order. */
  players: Player[];
  /** Lower-cased nicknames the host kicked; they cannot rejoin this room. */
  kickedNicknames: string[];
  /** Player ids in seat order, shuffled from the seed at game start; drives Captain rotation and clue dealing. */
  seats: string[];
  /** 1-based; 0 in the lobby. */
  roundNumber: number;
  /** One entry per finished round. */
  outcomes: RoundOutcome[];
}

export type CommandOutcome = { status: "accepted" } | { status: Exclude<CommandStatus, "accepted">; error: string };

const ok = { status: "accepted" } as const;
const invalid = (error: string): CommandOutcome => ({ status: "invalid", error });
const unauthorised = (error: string): CommandOutcome => ({ status: "unauthorised", error });

export function createGame(roomCode: string, scenario: Scenario, seed: number): GameState {
  return {
    roomCode,
    scenario,
    seed,
    version: 1,
    phase: "LOBBY",
    phaseDeadline: null,
    hostId: null,
    players: [],
    kickedNicknames: [],
    seats: [],
    roundNumber: 0,
    outcomes: [],
  };
}

export function currentRound(state: GameState): ScenarioRound | null {
  return state.roundNumber > 0 ? state.scenario.rounds[state.roundNumber - 1]! : null;
}

export function findPlayer(state: GameState, playerId: string): Player | undefined {
  return state.players.find((p) => p.id === playerId);
}

// ---------------------------------------------------------------- lobby

export function normaliseNickname(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/** Adds a guest to the lobby. The first player becomes host. */
export function addPlayer(
  state: GameState,
  player: { id: string; nickname: string; token: string },
): CommandOutcome {
  if (state.phase !== "LOBBY") return invalid("Game already started");
  if (state.players.length >= MAX_PLAYERS) return invalid("Room is full");
  const nickname = normaliseNickname(player.nickname);
  if (nickname.length < 1 || nickname.length > MAX_NICKNAME) {
    return invalid(`Nickname must be 1-${MAX_NICKNAME} characters`);
  }
  // ponytail: nickname ban only; a kicked guest can return under a new name. Needs accounts to do better.
  if (state.kickedNicknames.includes(nickname.toLowerCase())) return invalid("You were removed from this room by the host");
  if (state.players.some((p) => p.nickname.toLowerCase() === nickname.toLowerCase())) {
    return invalid("Nickname already taken");
  }
  state.players.push({ id: player.id, nickname, token: player.token, connected: true });
  state.hostId ??= player.id;
  bump(state);
  return ok;
}

/** Removes a player in the lobby, reassigning host if needed. */
export function removePlayer(state: GameState, playerId: string): void {
  const before = state.players.length;
  state.players = state.players.filter((p) => p.id !== playerId);
  if (state.players.length === before) return;
  if (state.hostId === playerId) state.hostId = state.players[0]?.id ?? null;
  bump(state);
}

/**
 * Lobby disconnects free the seat; in-game disconnects keep the seat (and clue)
 * so the player can rejoin with their token.
 */
export function setConnected(state: GameState, playerId: string, connected: boolean): void {
  const player = findPlayer(state, playerId);
  if (!player || player.connected === connected) return;
  if (!connected && state.phase === "LOBBY") {
    removePlayer(state, playerId);
    return;
  }
  player.connected = connected;
  if (!connected && state.hostId === playerId) {
    const nextHost = state.players.find((p) => p.connected);
    if (nextHost) state.hostId = nextHost.id;
  }
  bump(state);
}

// ---------------------------------------------------------------- captain & clues

/** The Captain moves one seat along each round, so 5+ players never repeat within a game. */
export function captainId(state: GameState): string | null {
  if (state.roundNumber === 0 || state.seats.length === 0) return null;
  return state.seats[(state.roundNumber - 1) % state.seats.length]!;
}

/**
 * Seat s gets clue (s + round) mod clueCount: one clue each, wrapping when there are
 * more players than clues, with the offset shifting per round so the Captain's clue varies.
 */
export function clueFor(state: GameState, playerId: string): string | null {
  const round = currentRound(state);
  const seat = state.seats.indexOf(playerId);
  if (!round || seat < 0) return null;
  return round.clues[(seat + state.roundNumber - 1) % round.clues.length]!;
}

// ---------------------------------------------------------------- commands

export function applyCommand(state: GameState, playerId: string, command: GameCommand, now: number): CommandOutcome {
  const player = findPlayer(state, playerId);
  if (!player) return unauthorised("Not a member of this room");
  const isHost = state.hostId === playerId;

  switch (command.type) {
    case "START_GAME": {
      if (!isHost) return unauthorised("Only the host can start");
      if (state.phase !== "LOBBY") return invalid("Game already started");
      const count = state.players.length;
      if (count < MIN_PLAYERS || count > MAX_PLAYERS) {
        return invalid(`Need ${MIN_PLAYERS}-${MAX_PLAYERS} players (have ${count})`);
      }
      state.seats = shuffle(
        state.players.map((p) => p.id),
        createRng(state.seed),
      );
      startRound(state, now);
      return ok;
    }

    case "KICK_PLAYER": {
      if (!isHost) return unauthorised("Only the host can kick");
      if (state.phase !== "LOBBY") return invalid("Players can only be kicked in the lobby");
      if (command.playerId === playerId) return invalid("Host cannot kick themselves");
      const target = findPlayer(state, command.playerId);
      if (!target) return invalid("No such player");
      state.kickedNicknames.push(target.nickname.toLowerCase());
      removePlayer(state, command.playerId);
      return ok;
    }

    case "ADVANCE_PHASE": {
      if (!isHost) return unauthorised("Only the host can advance the phase");
      if (state.phase === "LOBBY" || state.phase === "RESULTS") return invalid(`Cannot advance from ${state.phase}`);
      advancePhase(state, now);
      return ok;
    }

    case "PICK_ANSWER": {
      if (state.phase !== "ROUND") return invalid("Answers can only be picked during a round");
      if (captainId(state) !== playerId) return unauthorised("Only the Captain can pick the answer");
      if (!currentRound(state)!.answers.some((a) => a.id === command.answerId)) return invalid("Unknown answer");
      endRound(state, command.answerId, now);
      return ok;
    }

    case "PLAY_AGAIN": {
      if (!isHost) return unauthorised("Only the host can start a new game");
      if (state.phase !== "RESULTS") return invalid("The game is still running");
      // Back to the lobby with the connected players, a fresh game and new seating.
      // Disconnected players are dropped, as they would be from any lobby.
      Object.assign(state, createGame(state.roomCode, state.scenario, (state.seed + 1) >>> 0), {
        version: state.version,
        hostId: state.hostId,
        players: state.players.filter((p) => p.connected),
        kickedNicknames: state.kickedNicknames,
      });
      bump(state);
      return ok;
    }

    default: {
      const _exhaustive: never = command;
      return invalid(`Unknown command ${(_exhaustive as { type: string }).type}`);
    }
  }
}

// ---------------------------------------------------------------- phases

/** Advances on deadline expiry. Returns true if the state changed. */
export function tick(state: GameState, now: number): boolean {
  if (state.phaseDeadline === null || now < state.phaseDeadline) return false;
  advancePhase(state, now);
  return true;
}

export function advancePhase(state: GameState, now: number): void {
  switch (state.phase) {
    case "ROUND":
      // Timer ran out (or the host skipped): the round counts as failed.
      return endRound(state, null, now);
    case "REVEAL":
      if (state.roundNumber >= state.scenario.rounds.length) return finish(state);
      return startRound(state, now);
    case "LOBBY":
    case "RESULTS":
      return;
  }
}

function startRound(state: GameState, now: number): void {
  state.roundNumber += 1;
  state.phase = "ROUND";
  state.phaseDeadline = now + state.scenario.roundSeconds * 1000;
  bump(state);
}

function endRound(state: GameState, answerId: string | null, now: number): void {
  const round = currentRound(state)!;
  const answer = round.answers.find((a) => a.id === answerId);
  state.outcomes.push({
    answerId: answer?.id ?? null,
    correct: answer?.correct ?? false,
    narration: answer?.narration ?? round.timeout,
  });
  state.phase = "REVEAL";
  state.phaseDeadline = now + state.scenario.revealSeconds * 1000;
  bump(state);
}

function finish(state: GameState): void {
  state.phase = "RESULTS";
  state.phaseDeadline = null;
  bump(state);
}

export function solvedCount(state: GameState): number {
  return state.outcomes.filter((o) => o.correct).length;
}

function bump(state: GameState): void {
  state.version += 1;
}
