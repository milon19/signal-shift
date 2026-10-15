import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import type {
  ClientToServerEvents,
  JoinResponse,
  ServerToClientEvents,
} from "@signal-shift/shared";
import { projectView } from "./game/view.js";
import { RoomManager } from "./rooms/roomManager.js";

interface SocketData {
  roomCode?: string;
  playerId?: string;
}

type GameServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;

export interface SocketServerOptions {
  rooms: RoomManager;
  corsOrigin?: string | string[];
  tickMs?: number;
}

export function attachSocketServer(httpServer: HttpServer, options: SocketServerOptions): GameServer {
  const { rooms } = options;
  const io: GameServer = new Server(httpServer, {
    cors: { origin: options.corsOrigin ?? "http://localhost:5173" },
    maxHttpBufferSize: 16 * 1024,
  });

  /** Each socket receives its own projection: private clues never go to the room broadcast. */
  const broadcast = (roomCode: string) => {
    const room = rooms.get(roomCode);
    const socketIds = io.sockets.adapter.rooms.get(roomCode);
    if (!room || !socketIds) return;
    for (const id of socketIds) {
      const socket = io.sockets.sockets.get(id);
      const playerId = socket?.data.playerId;
      if (socket && playerId) socket.emit("game:state", projectView(room.state, playerId));
    }
  };

  const socketFor = (roomCode: string, playerId: string): GameSocket | undefined => {
    for (const id of io.sockets.adapter.rooms.get(roomCode) ?? []) {
      const socket = io.sockets.sockets.get(id);
      if (socket?.data.playerId === playerId) return socket;
    }
    return undefined;
  };

  io.on("connection", (socket: GameSocket) => {
    const enter = (response: JoinResponse) => {
      if (!response.ok) return;
      // A rejoin replaces any stale socket still holding the seat.
      const previous = socketFor(response.roomCode, response.playerId);
      if (previous && previous.id !== socket.id) {
        previous.data = {};
        previous.leave(response.roomCode);
        previous.disconnect(true);
      }
      socket.data = { roomCode: response.roomCode, playerId: response.playerId };
      socket.join(response.roomCode);
      broadcast(response.roomCode);
    };

    const alreadySeated = (ack: (r: JoinResponse) => void) => {
      if (!socket.data.roomCode) return false;
      ack({ ok: false, error: "Already in a room" });
      return true;
    };

    socket.on("room:create", (payload, ack) => {
      if (typeof ack !== "function" || alreadySeated(ack)) return;
      const response = rooms.createRoom(String(payload?.nickname ?? ""));
      ack(response);
      enter(response);
    });

    socket.on("room:join", (payload, ack) => {
      if (typeof ack !== "function" || alreadySeated(ack)) return;
      const response = rooms.joinRoom(String(payload?.roomCode ?? ""), String(payload?.nickname ?? ""));
      ack(response);
      enter(response);
    });

    socket.on("room:rejoin", (payload, ack) => {
      if (typeof ack !== "function" || alreadySeated(ack)) return;
      const response = rooms.rejoin(String(payload?.roomCode ?? ""), String(payload?.token ?? ""));
      ack(response);
      enter(response);
    });

    socket.on("game:command", (payload, ack) => {
      if (typeof ack !== "function") return;
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) {
        ack({ commandId: String(payload?.commandId ?? ""), status: "unauthorised", version: 0, error: "Join a room first" });
        return;
      }
      const result = rooms.handleCommand(roomCode, playerId, payload);
      ack(result);
      if (result.status !== "accepted") return;

      if (payload.command.type === "KICK_PLAYER") {
        const kicked = socketFor(roomCode, payload.command.playerId);
        if (kicked) {
          kicked.emit("room:kicked");
          kicked.data = {};
          kicked.leave(roomCode);
        }
      }
      broadcast(roomCode);
    });

    socket.on("disconnect", () => {
      const { roomCode, playerId } = socket.data;
      if (!roomCode || !playerId) return;
      rooms.disconnect(roomCode, playerId);
      broadcast(roomCode);
    });
  });

  const timer = setInterval(() => {
    for (const code of rooms.tick()) broadcast(code);
  }, options.tickMs ?? 250);
  io.engine.on("close", () => clearInterval(timer));
  httpServer.on("close", () => clearInterval(timer));

  return io;
}
