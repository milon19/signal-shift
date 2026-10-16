// Types and constants shared between the authoritative server and the web client.
// The client only ever receives a PlayerView: never the full scenario or other players' clues.

export const ROLES = ["Navigator", "Decoder", "Operator", "Auditor", "Dispatcher"] as const;
export type Role = (typeof ROLES)[number];

export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 10;

export const PHASES = [
  "LOBBY",
  "ACT_SCAN",
  "ACT_RELAY",
  "ACT_VERIFY",
  "ACT_COMMIT",
  "CONSEQUENCE",
  "HANDOFF",
  "RESULTS",
] as const;
export type Phase = (typeof PHASES)[number];

export type ClaimStatus = "open" | "verified" | "refuted";

// ---- Commands (client -> server) ----

export type StakeAmount = 1 | 2 | 3;

export type GameCommand =
  | { type: "START_GAME" }
  | { type: "KICK_PLAYER"; playerId: string }
  | { type: "ADVANCE_PHASE" }
  | { type: "CLAIM_CREATE"; factId: string; assertion: boolean; text: string }
  | { type: "SYNC_STAKE"; claimId: string; amount: StakeAmount }
  | { type: "CLAIM_VERIFY"; claimId: string }
  | { type: "DISPATCH_PIN"; clueId: string }
  | { type: "COMMIT_ACTION"; actionId: string }
  | { type: "PLAY_AGAIN" };

export type GameCommandType = GameCommand["type"];

export interface CommandEnvelope {
  commandId: string;
  /** Optional optimistic-concurrency check; when present it must equal the current state version. */
  expectedVersion?: number;
  command: GameCommand;
}

export type CommandStatus = "accepted" | "duplicate" | "stale_state" | "unauthorised" | "invalid";

export interface CommandResult {
  commandId: string;
  status: CommandStatus;
  version: number;
  error?: string;
}

// ---- Views (server -> client) ----

export interface PublicPlayer {
  id: string;
  nickname: string;
  isHost: boolean;
  connected: boolean;
  /** Current role; null while in the lobby. Roles are public, clues are not. */
  role: Role | null;
}

export interface PublicClaim {
  id: string;
  authorId: string;
  factId: string;
  assertion: boolean;
  text: string;
  stakes: { playerId: string; amount: number }[];
  status: ClaimStatus;
  /** Set once the claim is resolved at the end of the act. */
  correct: boolean | null;
}

export interface PublicFact {
  id: string;
  prompt: string;
}

export interface PublicAction {
  id: string;
  label: string;
}

export interface PinnedClue {
  clueId: string;
  text: string;
  pinnedBy: string;
}

export interface ActOutcomeView {
  actId: string;
  actionId: string | null;
  correct: boolean;
  narration: string;
  stabilityDelta: number;
}

export interface ScoreBreakdown {
  objectives: number;
  efficiency: number;
  claims: number;
  coverage: number;
  recovery: number;
  total: number;
}

export interface PrivateClue {
  id: string;
  text: string;
}

export interface PlayerView {
  roomCode: string;
  version: number;
  phase: Phase;
  phaseDeadline: number | null;
  scenarioTitle: string;
  actNumber: number;
  totalActs: number;
  act: {
    id: string;
    title: string;
    briefing: string;
    facts: PublicFact[];
    actions: PublicAction[];
  } | null;
  stability: number;
  sync: number;
  players: PublicPlayer[];
  claims: PublicClaim[];
  pinned: PinnedClue[];
  outcomes: ActOutcomeView[];
  result: { won: boolean; score: ScoreBreakdown } | null;
  me: {
    id: string;
    role: Role | null;
    clues: PrivateClue[];
    auditsRemaining: number;
    pinsRemaining: number;
  };
}

// ---- Socket.IO event contracts ----

export type Ack<T> = (response: T) => void;

export type JoinResponse =
  | { ok: true; roomCode: string; playerId: string; token: string }
  | { ok: false; error: string };

export interface ClientToServerEvents {
  "room:create": (payload: { nickname: string }, ack: Ack<JoinResponse>) => void;
  "room:join": (payload: { roomCode: string; nickname: string }, ack: Ack<JoinResponse>) => void;
  "room:rejoin": (payload: { roomCode: string; token: string }, ack: Ack<JoinResponse>) => void;
  "game:command": (payload: CommandEnvelope, ack: Ack<CommandResult>) => void;
}

export interface ServerToClientEvents {
  "game:state": (view: PlayerView) => void;
  "room:kicked": () => void;
}
