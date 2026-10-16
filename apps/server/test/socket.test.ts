import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  CommandEnvelope,
  CommandResult,
  JoinResponse,
  PlayerView,
  ServerToClientEvents,
} from "@signal-shift/shared";
import { RoomManager } from "../src/rooms/roomManager.js";
import { attachSocketServer } from "../src/socket.js";
import { scenario } from "./helpers.js";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

let httpServer: HttpServer;
let url: string;
const clients: Client[] = [];

beforeEach(async () => {
  httpServer = createServer();
  const io = attachSocketServer(httpServer, { rooms: new RoomManager({ scenario }), tickMs: 1000 });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
  httpServer.once("close", () => io.close());
});

afterEach(async () => {
  clients.splice(0).forEach((c) => c.disconnect());
  await new Promise((resolve) => httpServer.close(resolve));
});

async function client(): Promise<Client & { until: (pred: (v: PlayerView) => boolean) => Promise<PlayerView> }> {
  const socket: Client = connect(url, { transports: ["websocket"], forceNew: true });
  clients.push(socket);
  let latest: PlayerView | undefined;
  socket.on("game:state", (v) => (latest = v));
  await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
  /** Resolves with the first view (latest or upcoming) that satisfies pred. */
  const until = (pred: (v: PlayerView) => boolean) =>
    new Promise<PlayerView>((resolve) => {
      if (latest && pred(latest)) return resolve(latest);
      const listener = (v: PlayerView) => {
        if (!pred(v)) return;
        socket.off("game:state", listener);
        resolve(v);
      };
      socket.on("game:state", listener);
    });
  return Object.assign(socket, { until });
}

const create = (c: Client, nickname: string) =>
  new Promise<JoinResponse>((resolve) => c.emit("room:create", { nickname }, resolve));
const join = (c: Client, roomCode: string, nickname: string) =>
  new Promise<JoinResponse>((resolve) => c.emit("room:join", { roomCode, nickname }, resolve));
const send = (c: Client, envelope: CommandEnvelope) =>
  new Promise<CommandResult>((resolve) => c.emit("game:command", envelope, resolve));

describe("Socket.IO rooms", () => {
  it("creates a room, joins guests and broadcasts the lobby", async () => {
    const host = await client();
    const created = await create(host, "Ada");
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const guest = await client();
    const joined = await join(guest, created.roomCode, "Grace");
    expect(joined).toMatchObject({ ok: true, roomCode: created.roomCode });
    const view = await host.until((v) => v.players.length === 2);
    expect(view.players.map((p) => p.nickname)).toEqual(["Ada", "Grace"]);
    expect(view.players[0]!.isHost).toBe(true);
  });

  it("rejects joining an unknown room or twice from one socket", async () => {
    const c = await client();
    expect(await join(c, "QQQQ", "Bob")).toEqual({ ok: false, error: "Room not found" });
    await create(c, "Bob");
    expect(await create(c, "Bob again")).toEqual({ ok: false, error: "Already in a room" });
  });

  it("requires joining before sending commands", async () => {
    const c = await client();
    const result = await send(c, { commandId: "1", command: { type: "START_GAME" } });
    expect(result.status).toBe("unauthorised");
  });

  it("host starts, each player sees only their own clue, and the Captain's pick reveals everyone's", async () => {
    const host = await client();
    const created = await create(host, "P1");
    if (!created.ok) throw new Error(created.error);
    const guests = [];
    for (let i = 2; i <= 5; i++) {
      const g = await client();
      await join(g, created.roomCode, `P${i}`);
      guests.push(g);
    }
    const everyone = [host, ...guests];
    expect((await send(host, { commandId: "start", command: { type: "START_GAME" } })).status).toBe("accepted");
    const views = await Promise.all(everyone.map((c) => c.until((v) => v.phase === "ROUND")));

    const clues = views.map((v) => v.me.clue);
    expect(new Set(clues).size).toBe(5);
    views.forEach((v, i) => {
      const serialised = JSON.stringify(v);
      for (const other of clues.filter((_, j) => j !== i)) expect(serialised).not.toContain(other);
    });

    const dup = await send(host, { commandId: "start", command: { type: "START_GAME" } });
    expect(dup.status).toBe("duplicate");

    const captainId = views[0]!.captainId;
    const captainIndex = views.findIndex((v) => v.me.id === captainId);
    const notCaptain = everyone[(captainIndex + 1) % 5]!;
    const pick = { type: "PICK_ANSWER", answerId: "gate_c" } as const;
    expect((await send(notCaptain, { commandId: "p", command: pick })).status).toBe("unauthorised");
    expect((await send(everyone[captainIndex]!, { commandId: "p", command: pick })).status).toBe("accepted");

    const reveal = await host.until((v) => v.phase === "REVEAL");
    expect(reveal.reveal).toMatchObject({ answerId: "gate_c", correct: true });
    expect(new Set(reveal.reveal!.clues.map((c) => c.text))).toEqual(new Set(clues));
    expect(reveal.reveal!.clues.map((c) => c.nickname).sort()).toEqual(["P1", "P2", "P3", "P4", "P5"]);
    expect(reveal.solved).toBe(1);
  });

  it("host can kick a player in the lobby", async () => {
    const host = await client();
    const created = await create(host, "Host");
    if (!created.ok) throw new Error(created.error);
    const guest = await client();
    const joined = await join(guest, created.roomCode, "Guest");
    if (!joined.ok) throw new Error(joined.error);

    const kicked = new Promise<void>((resolve) => guest.once("room:kicked", () => resolve()));
    const result = await send(host, { commandId: "k", command: { type: "KICK_PLAYER", playerId: joined.playerId } });
    expect(result.status).toBe("accepted");
    await kicked;
    const view = await host.until((v) => v.players.length === 1);
    expect(view.players.map((p) => p.nickname)).toEqual(["Host"]);
  });
});
