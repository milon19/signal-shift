import type { GameCommand } from "@signal-shift/shared";
import { addPlayer, applyCommand, captainId, createGame, type GameState } from "../src/game/engine.js";
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

export function captain(state: GameState): string {
  const id = captainId(state);
  if (!id) throw new Error("no captain");
  return id;
}

/** Id of the current round's correct (or a wrong) answer. */
export function answer(state: GameState, correct: boolean): string {
  return scenario.rounds[state.roundNumber - 1]!.answers.find((a) => a.correct === correct)!.id;
}

/** Captain picks, then the host skips the reveal. Ends in the next ROUND, or RESULTS after the last. */
export function playRound(state: GameState, correct: boolean): void {
  expectAccepted(state, captain(state), { type: "PICK_ANSWER", answerId: answer(state, correct) });
  expectAccepted(state, state.hostId!, { type: "ADVANCE_PHASE" });
}
