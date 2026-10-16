import type { PlayerView } from "@signal-shift/shared";
import { captainId, clueFor, currentRound, findPlayer, solvedCount, type GameState } from "./engine.js";

/**
 * Projects the authoritative state down to what one player may see.
 * Answer correctness and other players' clues stay on the server until REVEAL;
 * reconnect tokens never leave it.
 */
export function projectView(state: GameState, playerId: string): PlayerView {
  const inPlay = state.phase === "ROUND" || state.phase === "REVEAL";
  const round = inPlay ? currentRound(state) : null;
  const outcome = state.outcomes[state.roundNumber - 1];
  const solved = solvedCount(state);
  const total = state.scenario.rounds.length;

  return {
    roomCode: state.roomCode,
    version: state.version,
    phase: state.phase,
    phaseDeadline: state.phaseDeadline,
    scenarioTitle: state.scenario.title,
    roundNumber: state.roundNumber,
    totalRounds: total,
    round: round && {
      title: round.title,
      question: round.question,
      answers: round.answers.map(({ id, label }) => ({ id, label })),
    },
    captainId: inPlay ? captainId(state) : null,
    players: state.players.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      isHost: p.id === state.hostId,
      connected: p.connected,
    })),
    reveal:
      state.phase === "REVEAL" && round && outcome
        ? {
            answerId: outcome.answerId,
            correctAnswerId: round.answers.find((a) => a.correct)!.id,
            correct: outcome.correct,
            narration: outcome.narration,
            clues: state.seats.map((id) => ({
              playerId: id,
              nickname: findPlayer(state, id)?.nickname ?? "?",
              text: clueFor(state, id)!,
            })),
          }
        : null,
    solved,
    results: state.phase === "RESULTS" ? { solved, total, line: state.scenario.resultLines[solved]! } : null,
    me: {
      id: playerId,
      clue: inPlay ? clueFor(state, playerId) : null,
    },
  };
}
