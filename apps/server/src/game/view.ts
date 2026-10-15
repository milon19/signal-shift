import type { PlayerView } from "@signal-shift/shared";
import { STANDARD_SHIFT_ACTS } from "./scenario.js";
import { cluesFor, currentAct, type GameState } from "./engine.js";

const CLUE_PHASES = new Set(["ACT_SCAN", "ACT_RELAY", "ACT_VERIFY", "ACT_COMMIT", "CONSEQUENCE"]);

/**
 * Projects the authoritative state down to what one player may see.
 * Fact truths, other players' clues and reconnect tokens never leave the server.
 */
export function projectView(state: GameState, playerId: string): PlayerView {
  const act = currentAct(state);
  const role = state.roles[playerId] ?? null;
  return {
    roomCode: state.roomCode,
    version: state.version,
    phase: state.phase,
    phaseDeadline: state.phaseDeadline,
    scenarioTitle: state.scenario.title,
    actNumber: state.actNumber,
    totalActs: STANDARD_SHIFT_ACTS,
    act: act && {
      id: state.actId!,
      title: act.title,
      briefing: act.briefing,
      facts: act.facts.map(({ id, prompt }) => ({ id, prompt })),
      actions: act.actions.map(({ id, label }) => ({ id, label })),
    },
    stability: state.stability,
    sync: state.sync,
    players: state.players.map((p) => ({
      id: p.id,
      nickname: p.nickname,
      isHost: p.id === state.hostId,
      connected: p.connected,
      role: state.roles[p.id] ?? null,
    })),
    claims: state.claims
      .filter((c) => c.actNumber === state.actNumber)
      .map(({ id, authorId, factId, assertion, text, stakes, status, correct }) => ({
        id,
        authorId,
        factId,
        assertion,
        text,
        stakes: stakes.map((s) => ({ ...s })),
        status,
        correct,
      })),
    pinned: state.pinned.map((p) => ({ ...p })),
    outcomes: state.outcomes.map((o) => ({ ...o })),
    result: state.result,
    me: {
      id: playerId,
      role,
      clues: CLUE_PHASES.has(state.phase) ? cluesFor(state, playerId) : [],
      auditsRemaining: role === "Auditor" ? state.scenario.auditsPerAct - state.auditsUsed : 0,
      pinsRemaining: role === "Dispatcher" ? state.scenario.pinsPerAct - (state.pinsUsed[playerId] ?? 0) : 0,
    },
  };
}
