import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents,
  CommandResult,
  GameCommand,
  JoinResponse,
  ServerToClientEvents,
} from "@signal-shift/shared";

export const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? "http://localhost:3001";
const SESSION_KEY = "signal-shift:session";

export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(SERVER_URL, { autoConnect: true });

interface Session {
  roomCode: string;
  token: string;
}

function remember(response: JoinResponse): JoinResponse {
  try {
    if (response.ok) sessionStorage.setItem(SESSION_KEY, JSON.stringify({ roomCode: response.roomCode, token: response.token }));
  } catch {
    // Storage unavailable: rejoin after refresh just won't work.
  }
  return response;
}

export function forgetSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore
  }
}

export function createRoom(nickname: string): Promise<JoinResponse> {
  return new Promise((resolve) => socket.emit("room:create", { nickname }, (r) => resolve(remember(r))));
}

export function joinRoom(roomCode: string, nickname: string): Promise<JoinResponse> {
  return new Promise((resolve) => socket.emit("room:join", { roomCode, nickname }, (r) => resolve(remember(r))));
}

/** Reclaims our seat after a refresh or dropped connection, if we have one. */
export function tryRejoin(): Promise<JoinResponse | null> {
  let session: Session | null = null;
  try {
    session = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? "null");
  } catch {
    session = null;
  }
  if (!session) return Promise.resolve(null);
  return new Promise((resolve) =>
    socket.emit("room:rejoin", session, (r) => {
      if (!r.ok) forgetSession();
      resolve(r);
    }),
  );
}

export function sendCommand(command: GameCommand, expectedVersion?: number): Promise<CommandResult> {
  const commandId = crypto.randomUUID();
  return new Promise((resolve) => socket.emit("game:command", { commandId, expectedVersion, command }, resolve));
}
