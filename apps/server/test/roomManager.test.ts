import { describe, expect, it } from "vitest";
import { ABANDONED_ROOM_MS, RoomManager } from "../src/rooms/roomManager.js";
import { scenario } from "./helpers.js";

function manager() {
  let now = 1_000;
  const rooms = new RoomManager({ scenario, now: () => now, seed: () => 1 });
  return { rooms, advance: (ms: number) => (now += ms) };
}

function fullRoom(rooms: RoomManager, n = 5) {
  const host = rooms.createRoom("Host");
  if (!host.ok) throw new Error(host.error);
  const ids = [host.playerId];
  for (let i = 2; i <= n; i++) {
    const r = rooms.joinRoom(host.roomCode.toLowerCase(), `P${i}`);
    if (!r.ok) throw new Error(r.error);
    ids.push(r.playerId);
  }
  return { code: host.roomCode, ids, hostToken: host.token };
}

describe("RoomManager", () => {
  it("creates rooms with 4-letter codes and joins case-insensitively", () => {
    const { rooms } = manager();
    const { code, ids } = fullRoom(rooms, 3);
    expect(code).toMatch(/^[A-Z]{4}$/);
    expect(rooms.get(code)?.state.players).toHaveLength(3);
    expect(rooms.get(code)?.state.hostId).toBe(ids[0]);
  });

  it("reports unknown rooms and invalid nicknames", () => {
    const { rooms } = manager();
    expect(rooms.joinRoom("ZZZZ", "Bob")).toEqual({ ok: false, error: "Room not found" });
    expect(rooms.createRoom("").ok).toBe(false);
    expect(rooms.size).toBe(0);
  });

  it("accepts a command once and reports replays as duplicates", () => {
    const { rooms } = manager();
    const { code, ids } = fullRoom(rooms);
    const first = rooms.handleCommand(code, ids[0]!, { commandId: "cmd-1", command: { type: "START_GAME" } });
    expect(first.status).toBe("accepted");
    const replay = rooms.handleCommand(code, ids[0]!, { commandId: "cmd-1", command: { type: "START_GAME" } });
    expect(replay.status).toBe("duplicate");
    expect(replay.version).toBe(first.version);
  });

  it("rejects stale expectedVersion without consuming the command id", () => {
    const { rooms } = manager();
    const { code, ids } = fullRoom(rooms);
    const version = rooms.get(code)!.state.version;
    const stale = rooms.handleCommand(code, ids[0]!, { commandId: "a", expectedVersion: version - 1, command: { type: "START_GAME" } });
    expect(stale.status).toBe("stale_state");
    const retry = rooms.handleCommand(code, ids[0]!, { commandId: "a", expectedVersion: version, command: { type: "START_GAME" } });
    expect(retry.status).toBe("accepted");
  });

  it("rejects malformed and foreign commands", () => {
    const { rooms } = manager();
    const { code, ids } = fullRoom(rooms);
    expect(rooms.handleCommand(code, ids[0]!, { commandId: "x", command: { type: "SET_SCORE", score: 1000 } }).status).toBe("invalid");
    expect(rooms.handleCommand(code, ids[0]!, null).status).toBe("invalid");
    expect(rooms.handleCommand(code, ids[0]!, { commandId: "y", command: { type: "PICK_ANSWER", answerId: 7 } }).status).toBe("invalid");
    expect(rooms.handleCommand(code, ids[0]!, { commandId: "y", command: { type: "PICK_ANSWER", answerId: "x".repeat(65) } }).status).toBe("invalid");
    expect(rooms.handleCommand(code, ids[0]!, { commandId: "y", command: { type: "CLAIM_CREATE", factId: "f" } }).status).toBe("invalid");
    expect(rooms.handleCommand(code, "intruder", { commandId: "z", command: { type: "START_GAME" } }).status).toBe("unauthorised");
    expect(rooms.handleCommand("NOPE", ids[0]!, { commandId: "z", command: { type: "START_GAME" } }).status).toBe("unauthorised");
  });

  it("lets a disconnected player rejoin mid-game with their token", () => {
    const { rooms } = manager();
    const { code, ids, hostToken } = fullRoom(rooms);
    rooms.handleCommand(code, ids[0]!, { commandId: "s", command: { type: "START_GAME" } });
    rooms.disconnect(code, ids[0]!);
    expect(rooms.get(code)!.state.players[0]!.connected).toBe(false);
    expect(rooms.rejoin(code, "wrong").ok).toBe(false);
    expect(rooms.rejoin(code, hostToken)).toMatchObject({ ok: true, playerId: ids[0] });
    expect(rooms.get(code)!.state.players[0]!.connected).toBe(true);
  });

  it("deletes a lobby once everyone leaves", () => {
    const { rooms } = manager();
    const { code, ids } = fullRoom(rooms, 2);
    ids.forEach((id) => rooms.disconnect(code, id));
    expect(rooms.get(code)).toBeUndefined();
  });

  it("drives phase timers and evicts abandoned games", () => {
    const { rooms, advance } = manager();
    const { code, ids } = fullRoom(rooms);
    rooms.handleCommand(code, ids[0]!, { commandId: "s", command: { type: "START_GAME" } });
    expect(rooms.tick()).toEqual([]);
    advance(scenario.roundSeconds * 1000);
    expect(rooms.tick()).toEqual([code]);
    expect(rooms.get(code)!.state.phase).toBe("REVEAL");

    ids.forEach((id) => rooms.disconnect(code, id));
    advance(ABANDONED_ROOM_MS);
    rooms.tick();
    expect(rooms.get(code)).toBeUndefined();
  });
});
