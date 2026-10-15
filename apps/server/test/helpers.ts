import type { GameCommand, Phase, Role } from "@signal-shift/shared";
import { addPlayer, advancePhase, applyCommand, createGame, type GameState } from "../src/game/engine.js";
import { loadDefaultScenario } from "../src/game/scenario.js";

export const scenario = loadDefaultScenario();
export const T0 = 1_000_000;

export function lobby(n: number, seed = 42): GameState {
  const state = createGame("TEST", scenario, seed);
  for (let i = 1; i <= n; i++) {
    const outcome = addPlayer(state, { id: `p${i}`, nickname: `Player ${i}`, token: `t${i}` });
    if (outcome.status !== "accepted") throw new Error(outcome.error);
  }
  return state;
}

export function started(n = 5, seed = 42): GameState {
  const state = lobby(n, seed);
  expectAccepted(state, "p1", { type: "START_GAME" });
  return state;
}

export function run(state: GameState, playerId: string, command: GameCommand, now = T0) {
  return applyCommand(state, playerId, command, now);
}

export function expectAccepted(state: GameState, playerId: string, command: GameCommand, now = T0): void {
  const outcome = run(state, playerId, command, now);
  if (outcome.status !== "accepted") {
    throw new Error(`${command.type} by ${playerId} rejected: ${outcome.status} ${outcome.error}`);
  }
}

export function holder(state: GameState, role: Role): string {
  const id = state.seats.find((p) => state.roles[p] === role);
  if (!id) throw new Error(`nobody holds ${role}`);
  return id;
}

export function advanceTo(state: GameState, phase: Phase, now = T0): void {
  for (let guard = 0; state.phase !== phase; guard++) {
    if (guard > 20) throw new Error(`never reached ${phase}`);
    advancePhase(state, now);
  }
}

/** Plays the current act to CONSEQUENCE by committing the given action. */
export function commit(state: GameState, actionId: string): void {
  advanceTo(state, "ACT_COMMIT");
  expectAccepted(state, holder(state, "Operator"), { type: "COMMIT_ACTION", actionId });
}
