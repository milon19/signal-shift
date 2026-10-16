import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  type ClaimStatus,
  type CommandStatus,
  type GameCommand,
  type Phase,
  type PrivateClue,
  type Role,
  type ScoreBreakdown,
} from "@signal-shift/shared";
import { createRng, shuffle } from "./rng.js";
import { STANDARD_SHIFT_ACTS, type Scenario, type ScenarioAct, type TimedPhase } from "./scenario.js";

// Authoritative game state machine. All functions here are synchronous and
// deterministic given (state, input, now); the room layer owns timers and I/O.
//
//   LOBBY -> ACT_SCAN -> ACT_RELAY -> ACT_VERIFY -> ACT_COMMIT -> CONSEQUENCE
//            ^                                                        |
//            +------------------------- HANDOFF <---------------------+--> RESULTS

export const MAX_CLAIMS_PER_ACT = 30;
export const MAX_CLAIM_TEXT = 200;
export const MAX_NICKNAME = 20;

/** Extra seats beyond the five core roles get overlapping information roles. */
const EXTRA_ROLE_CYCLE: Role[] = ["Navigator", "Decoder", "Dispatcher"];
const CORE_ROLES: Role[] = ["Navigator", "Decoder", "Operator", "Auditor", "Dispatcher"];

export interface Player {
  id: string;
  nickname: string;
  /** Secret used to rejoin after a disconnect. Never sent to other players. */
  token: string;
  connected: boolean;
}

export interface Claim {
  id: string;
  actNumber: number;
  authorId: string;
  factId: string;
  assertion: boolean;
  text: string;
  stakes: { playerId: string; amount: number }[];
  status: ClaimStatus;
  correct: boolean | null;
}

export interface ActOutcome {
  actId: string;
  actionId: string | null;
  correct: boolean;
  narration: string;
  stabilityDelta: number;
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
  /** Player ids in seat order, fixed at game start; drives role rotation. */
  seats: string[];
  actNumber: number;
  actId: string | null;
  /** The act the current one branches to, decided at commit time. */
  nextActId: string | null;
  roles: Record<string, Role>;
  stability: number;
  sync: number;
  claims: Claim[];
  claimSeq: number;
  pinned: { clueId: string; text: string; pinnedBy: string }[];
  auditsUsed: number;
  pinsUsed: Record<string, number>;
  outcomes: ActOutcome[];
  /** actNumber -> ids of players who took a meaningful action that act. */
  participation: Record<number, string[]>;
  result: { won: boolean; score: ScoreBreakdown } | null;
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
    actNumber: 0,
    actId: null,
    nextActId: null,
    roles: {},
    stability: scenario.startingStability,
    sync: scenario.startingSync,
    claims: [],
    claimSeq: 0,
    pinned: [],
    auditsUsed: 0,
    pinsUsed: {},
    outcomes: [],
    participation: {},
    result: null,
  };
}

export function currentAct(state: GameState): ScenarioAct | null {
  return state.actId ? state.scenario.acts[state.actId]! : null;
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
 * Lobby disconnects free the seat; in-game disconnects keep the seat (and role)
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

// ---------------------------------------------------------------- roles & clues

/** The role list for n seats: five core roles, then overlapping extras. */
export function roleSlots(n: number): Role[] {
  const slots = CORE_ROLES.slice(0, n);
  for (let i = 0; slots.length < n; i++) slots.push(EXTRA_ROLE_CYCLE[i % EXTRA_ROLE_CYCLE.length]!);
  return slots;
}

/** Seat s holds slot (s + act) mod n, so every core role moves to a new player each act. */
export function assignRoles(seats: string[], actIndex: number): Record<string, Role> {
  const slots = roleSlots(seats.length);
  const roles: Record<string, Role> = {};
  seats.forEach((playerId, seat) => {
    roles[playerId] = slots[(seat + actIndex) % slots.length]!;
  });
  return roles;
}

/**
 * A player's private clues for the current act. When several players share a
 * role, the role's clues are dealt round-robin among them (wrapping if there
 * are more holders than clues), so information partially overlaps.
 */
export function cluesFor(state: GameState, playerId: string): PrivateClue[] {
  const act = currentAct(state);
  const role = state.roles[playerId];
  if (!act || !role) return [];
  const all = act.clues[role];
  const holders = state.seats.filter((id) => state.roles[id] === role);
  const k = holders.indexOf(playerId);
  const m = holders.length;
  if (m <= 1) return all.map(({ id, text }) => ({ id, text }));
  if (all.length < m) {
    const clue = all[k % all.length]!;
    return [{ id: clue.id, text: clue.text }];
  }
  return all.filter((_, i) => i % m === k).map(({ id, text }) => ({ id, text }));
}

// ---------------------------------------------------------------- commands

export function applyCommand(state: GameState, playerId: string, command: GameCommand, now: number): CommandOutcome {
  const player = findPlayer(state, playerId);
  if (!player) return unauthorised("Not a member of this room");
  const isHost = state.hostId === playerId;
  const role = state.roles[playerId];
  const act = currentAct(state);

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
      startAct(state, state.scenario.startActId, now);
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

    case "CLAIM_CREATE": {
      if (state.phase !== "ACT_RELAY" && state.phase !== "ACT_VERIFY") return invalid("Claims open during Relay and Verify");
      if (!act!.facts.some((f) => f.id === command.factId)) return invalid("Unknown fact");
      const text = command.text.trim();
      if (text.length < 1 || text.length > MAX_CLAIM_TEXT) return invalid(`Claim text must be 1-${MAX_CLAIM_TEXT} characters`);
      if (actClaims(state).length >= MAX_CLAIMS_PER_ACT) return invalid("Claim limit reached for this act");
      state.claimSeq += 1;
      state.claims.push({
        id: `c${state.claimSeq}`,
        actNumber: state.actNumber,
        authorId: playerId,
        factId: command.factId,
        assertion: command.assertion,
        text,
        stakes: [],
        status: "open",
        correct: null,
      });
      participate(state, playerId);
      bump(state);
      return ok;
    }

    case "SYNC_STAKE": {
      if (state.phase !== "ACT_RELAY" && state.phase !== "ACT_VERIFY") return invalid("Staking opens during Relay and Verify");
      const claim = actClaims(state).find((c) => c.id === command.claimId);
      if (!claim) return invalid("Unknown claim");
      if (claim.status !== "open") return invalid("Claim already audited");
      if (![1, 2, 3].includes(command.amount)) return invalid("Stake must be 1-3 Sync");
      if (claim.stakes.some((s) => s.playerId === playerId)) return invalid("Already staked on this claim");
      if (command.amount > state.sync) return invalid("Not enough Sync");
      state.sync -= command.amount;
      claim.stakes.push({ playerId, amount: command.amount });
      participate(state, playerId);
      bump(state);
      return ok;
    }

    case "CLAIM_VERIFY": {
      if (role !== "Auditor") return unauthorised("Only the Auditor can verify claims");
      if (state.phase !== "ACT_VERIFY") return invalid("Audits happen during Verify");
      if (state.auditsUsed >= state.scenario.auditsPerAct) return invalid("No audits remaining this act");
      const claim = actClaims(state).find((c) => c.id === command.claimId);
      if (!claim) return invalid("Unknown claim");
      if (claim.status !== "open") return invalid("Claim already audited");
      claim.status = claimIsTrue(act!, claim) ? "verified" : "refuted";
      state.auditsUsed += 1;
      participate(state, playerId);
      bump(state);
      return ok;
    }

    case "DISPATCH_PIN": {
      if (role !== "Dispatcher") return unauthorised("Only a Dispatcher can pin clues");
      if (!["ACT_SCAN", "ACT_RELAY", "ACT_VERIFY"].includes(state.phase)) return invalid("Pins are available until Commit");
      if ((state.pinsUsed[playerId] ?? 0) >= state.scenario.pinsPerAct) return invalid("No pins remaining this act");
      const clue = cluesFor(state, playerId).find((c) => c.id === command.clueId);
      if (!clue) return unauthorised("You can only pin your own clues");
      if (state.pinned.some((p) => p.clueId === clue.id)) return invalid("Already pinned");
      state.pinned.push({ clueId: clue.id, text: clue.text, pinnedBy: playerId });
      state.pinsUsed[playerId] = (state.pinsUsed[playerId] ?? 0) + 1;
      participate(state, playerId);
      bump(state);
      return ok;
    }

    case "COMMIT_ACTION": {
      if (role !== "Operator") return unauthorised("Only the Operator can commit actions");
      if (state.phase !== "ACT_COMMIT") return invalid("Actions are committed during Commit");
      const action = act!.actions.find((a) => a.id === command.actionId);
      if (!action) return invalid("Unknown action");
      participate(state, playerId);
      resolveAct(state, action.id, now);
      return ok;
    }

    case "PLAY_AGAIN": {
      if (!isHost) return unauthorised("Only the host can start a new shift");
      if (state.phase !== "RESULTS") return invalid("The shift is still running");
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
    case "ACT_SCAN":
      return enterPhase(state, "ACT_RELAY", now);
    case "ACT_RELAY":
      return enterPhase(state, "ACT_VERIFY", now);
    case "ACT_VERIFY":
      return enterPhase(state, "ACT_COMMIT", now);
    case "ACT_COMMIT":
      // Nobody committed in time.
      return resolveAct(state, null, now);
    case "CONSEQUENCE":
      if (state.nextActId === null || state.stability <= 0) return finish(state);
      state.roles = assignRoles(state.seats, state.actNumber);
      return enterPhase(state, "HANDOFF", now);
    case "HANDOFF":
      return startAct(state, state.nextActId!, now);
    case "LOBBY":
    case "RESULTS":
      return;
  }
}

function enterPhase(state: GameState, phase: TimedPhase, now: number): void {
  state.phase = phase;
  state.phaseDeadline = now + state.scenario.phaseDurationsSec[phase] * 1000;
  bump(state);
}

function startAct(state: GameState, actId: string, now: number): void {
  state.actNumber += 1;
  state.actId = actId;
  state.nextActId = null;
  state.roles = assignRoles(state.seats, state.actNumber - 1);
  state.auditsUsed = 0;
  state.pinsUsed = {};
  state.pinned = [];
  enterPhase(state, "ACT_SCAN", now);
}

/** Applies the committed action (or the timeout outcome), settles claims and picks the branch. */
function resolveAct(state: GameState, actionId: string | null, now: number): void {
  const act = currentAct(state)!;
  const action = actionId === null ? null : act.actions.find((a) => a.id === actionId)!;
  const outcome = action ?? act.timeout;

  state.stability = Math.max(0, state.stability + outcome.stabilityDelta);
  state.nextActId = outcome.next;
  state.outcomes.push({
    actId: state.actId!,
    actionId,
    correct: action?.correct ?? false,
    narration: outcome.narration,
    stabilityDelta: outcome.stabilityDelta,
  });

  // Correct stakes are returned doubled; incorrect stakes are lost.
  for (const claim of actClaims(state)) {
    claim.correct = claimIsTrue(act, claim);
    if (claim.correct) state.sync += 2 * totalStake(claim);
  }

  enterPhase(state, "CONSEQUENCE", now);
}

function finish(state: GameState): void {
  state.phase = "RESULTS";
  state.phaseDeadline = null;
  state.result = scoreGame(state);
  bump(state);
}

// ---------------------------------------------------------------- scoring

/**
 * Team-first 1,000-point score (design doc "Win conditions and scoring").
 * Deliberately never counts messages, talk time or speed.
 */
export function scoreGame(state: GameState): { won: boolean; score: ScoreBreakdown } {
  const { startingStability, startingSync } = state.scenario;
  const correctActs = state.outcomes.filter((o) => o.correct).length;
  const objectives = Math.round((450 * correctActs) / STANDARD_SHIFT_ACTS);

  const ratio = (x: number, of: number) => (of <= 0 ? 1 : Math.min(1, Math.max(0, x / of)));
  const efficiency = Math.round(100 * ratio(state.stability, startingStability) + 100 * ratio(state.sync, startingSync));

  const staked = state.claims.filter((c) => c.stakes.length > 0);
  const claims = staked.length === 0 ? 0 : Math.round((150 * staked.filter((c) => c.correct).length) / staked.length);

  const playedActs = state.outcomes.length;
  let coverageSum = 0;
  for (let a = 1; a <= playedActs; a++) {
    coverageSum += (state.participation[a]?.length ?? 0) / Math.max(1, state.seats.length);
  }
  const coverage = playedActs === 0 ? 0 : Math.round((100 * coverageSum) / playedActs);

  const recovery = state.stability >= startingStability ? 100 : 0;

  const last = state.outcomes[state.outcomes.length - 1];
  const won = playedActs === STANDARD_SHIFT_ACTS && !!last?.correct && state.stability > 0;

  return {
    won,
    score: { objectives, efficiency, claims, coverage, recovery, total: objectives + efficiency + claims + coverage + recovery },
  };
}

// ---------------------------------------------------------------- helpers

function actClaims(state: GameState): Claim[] {
  return state.claims.filter((c) => c.actNumber === state.actNumber);
}

function claimIsTrue(act: ScenarioAct, claim: Claim): boolean {
  return act.facts.find((f) => f.id === claim.factId)!.truth === claim.assertion;
}

function totalStake(claim: Claim): number {
  return claim.stakes.reduce((sum, s) => sum + s.amount, 0);
}

function participate(state: GameState, playerId: string): void {
  const list = (state.participation[state.actNumber] ??= []);
  if (!list.includes(playerId)) list.push(playerId);
}

function bump(state: GameState): void {
  state.version += 1;
}
