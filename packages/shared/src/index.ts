// Types and constants shared between the authoritative server and the web client.
// The client only ever receives a PlayerView: never the full scenario or, during a round,
// other players' clues.

export const MIN_PLAYERS = 5;
export const MAX_PLAYERS = 10;

/** LOBBY -> ROUND -> REVEAL -> (next ROUND ...) -> RESULTS */
export const PHASES = ["LOBBY", "ROUND", "REVEAL", "RESULTS"] as const;
export type Phase = (typeof PHASES)[number];

// ---- Commands (client -> server) ----

export type GameCommand =
  | { type: "START_GAME" }
  | { type: "KICK_PLAYER"; playerId: string }
  | { type: "ADVANCE_PHASE" }
  | { type: "PICK_ANSWER"; answerId: string }
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
}

export interface PlayerView {
  roomCode: string;
  version: number;
  phase: Phase;
  phaseDeadline: number | null;
  scenarioTitle: string;
  roundNumber: number;
  totalRounds: number;
  /** The current round's question; answer correctness is never included. Null in LOBBY/RESULTS. */
  round: {
    title: string;
    question: string;
    answers: { id: string; label: string }[];
  } | null;
  captainId: string | null;
  players: PublicPlayer[];
  /** Only during REVEAL: what happened and everyone's clues. */
  reveal: {
    answerId: string | null;
    correctAnswerId: string;
    correct: boolean;
    narration: string;
    clues: { playerId: string; nickname: string; text: string }[];
  } | null;
  /** Rounds solved so far. */
  solved: number;
  /** Only in RESULTS. */
  results: { solved: number; total: number; line: string } | null;
  me: {
    id: string;
    /** Your own clue during ROUND and REVEAL. */
    clue: string | null;
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
