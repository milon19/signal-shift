import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import type { CommandEnvelope, CommandResult, GameCommand, JoinResponse } from "@signal-shift/shared";
import {
  addPlayer,
  applyCommand,
  createGame,
  findPlayer,
  setConnected,
  tick,
  type GameState,
} from "../game/engine.js";
import type { Scenario } from "../game/scenario.js";

const ROOM_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
const ROOM_CODE_LENGTH = 4;
/** Remember this many processed command ids per room for idempotency. */
const DEDUPE_WINDOW = 500;
/** Rooms with nobody connected are discarded after this long. */
export const ABANDONED_ROOM_MS = 10 * 60 * 1000;

// Untrusted input: validate every command payload before it reaches the engine.
const commandSchema: z.ZodType<GameCommand> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("START_GAME") }),
  z.object({ type: z.literal("KICK_PLAYER"), playerId: z.string().max(64) }),
  z.object({ type: z.literal("ADVANCE_PHASE") }),
  z.object({
    type: z.literal("CLAIM_CREATE"),
    factId: z.string().max(64),
    assertion: z.boolean(),
    text: z.string().max(500),
  }),
  z.object({
    type: z.literal("SYNC_STAKE"),
    claimId: z.string().max(64),
    amount: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  }),
  z.object({ type: z.literal("CLAIM_VERIFY"), claimId: z.string().max(64) }),
  z.object({ type: z.literal("DISPATCH_PIN"), clueId: z.string().max(64) }),
  z.object({ type: z.literal("COMMIT_ACTION"), actionId: z.string().max(64) }),
]);

const envelopeSchema = z.object({
  commandId: z.string().min(1).max(64),
  expectedVersion: z.number().int().nonnegative().optional(),
  command: commandSchema,
});

export interface Room {
  state: GameState;
  processed: Map<string, CommandResult>;
  emptySince: number | null;
}

export interface RoomManagerOptions {
  scenario: Scenario;
  now?: () => number;
  seed?: () => number;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly scenario: Scenario;
  private readonly now: () => number;
  private readonly seed: () => number;

  constructor(options: RoomManagerOptions) {
    this.scenario = options.scenario;
    this.now = options.now ?? Date.now;
    this.seed = options.seed ?? (() => randomInt(0, 2 ** 31));
  }

  get(roomCode: string): Room | undefined {
    return this.rooms.get(normaliseCode(roomCode));
  }

  get size(): number {
    return this.rooms.size;
  }

  createRoom(nickname: string): JoinResponse {
    const code = this.uniqueCode();
    const room: Room = { state: createGame(code, this.scenario, this.seed()), processed: new Map(), emptySince: null };
    const response = this.addToRoom(room, nickname);
    if (response.ok) this.rooms.set(code, room);
    return response;
  }

  joinRoom(roomCode: string, nickname: string): JoinResponse {
    const room = this.get(roomCode);
    if (!room) return { ok: false, error: "Room not found" };
    return this.addToRoom(room, nickname);
  }

  /** Reclaims a seat after a disconnect using the secret token issued at join. */
  rejoin(roomCode: string, token: string): JoinResponse {
    const room = this.get(roomCode);
    const player = room?.state.players.find((p) => p.token === token);
    if (!room || !player) return { ok: false, error: "Cannot rejoin this room" };
    setConnected(room.state, player.id, true);
    room.emptySince = null;
    return { ok: true, roomCode: room.state.roomCode, playerId: player.id, token };
  }

  disconnect(roomCode: string, playerId: string): void {
    const room = this.get(roomCode);
    if (!room) return;
    setConnected(room.state, playerId, false);
    if (room.state.players.length === 0) {
      this.rooms.delete(room.state.roomCode);
    } else if (!room.state.players.some((p) => p.connected)) {
      room.emptySince = this.now();
    }
  }

  handleCommand(roomCode: string, playerId: string, payload: unknown): CommandResult {
    const room = this.get(roomCode);
    const rawId = (payload as { commandId?: unknown } | null)?.commandId;
    const commandId = typeof rawId === "string" ? rawId.slice(0, 64) : "";
    if (!room) return { commandId, status: "unauthorised", version: 0, error: "Room not found" };
    const { state } = room;
    if (!findPlayer(state, playerId)) {
      return { commandId, status: "unauthorised", version: state.version, error: "Not a member of this room" };
    }

    const parsed = envelopeSchema.safeParse(payload);
    if (!parsed.success) return { commandId, status: "invalid", version: state.version, error: "Malformed command" };
    const envelope: CommandEnvelope = parsed.data;

    const key = `${playerId}:${envelope.commandId}`;
    if (room.processed.has(key)) return { commandId, status: "duplicate", version: state.version };

    let result: CommandResult;
    if (envelope.expectedVersion !== undefined && envelope.expectedVersion !== state.version) {
      result = { commandId, status: "stale_state", version: state.version, error: "State has changed" };
    } else {
      const outcome = applyCommand(state, playerId, envelope.command, this.now());
      result = { commandId, version: state.version, ...outcome };
    }

    // Only remember commands that took effect, so a client can retry after a stale/invalid response.
    if (result.status === "accepted") {
      room.processed.set(key, result);
      if (room.processed.size > DEDUPE_WINDOW) {
        room.processed.delete(room.processed.keys().next().value!);
      }
    }
    return result;
  }

  /** Advances expired phase timers and evicts abandoned rooms. Returns codes of rooms that changed. */
  tick(): string[] {
    const now = this.now();
    const changed: string[] = [];
    for (const [code, room] of this.rooms) {
      if (room.emptySince !== null && now - room.emptySince >= ABANDONED_ROOM_MS) {
        this.rooms.delete(code);
        continue;
      }
      if (tick(room.state, now)) changed.push(code);
    }
    return changed;
  }

  private addToRoom(room: Room, nickname: string): JoinResponse {
    const playerId = randomUUID();
    const token = randomUUID();
    const outcome = addPlayer(room.state, { id: playerId, nickname, token });
    if (outcome.status !== "accepted") return { ok: false, error: outcome.error };
    room.emptySince = null;
    return { ok: true, roomCode: room.state.roomCode, playerId, token };
  }

  private uniqueCode(): string {
    for (;;) {
      let code = "";
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
  }
}

export function normaliseCode(code: string): string {
  return String(code).trim().toUpperCase();
}
