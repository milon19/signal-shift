import { useEffect, useState, type FormEvent } from "react";
import { MIN_PLAYERS, type GameCommand, type PlayerView } from "@signal-shift/shared";
import { createRoom, forgetSession, joinRoom, sendCommand, socket, tryRejoin } from "./socket";

export function App() {
  const [view, setView] = useState<PlayerView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onState = (v: PlayerView) => setView(v);
    const onKicked = () => {
      forgetSession();
      setView(null);
      setError("You were removed from the room by the host.");
    };
    const onConnect = () => void tryRejoin();
    socket.on("game:state", onState);
    socket.on("room:kicked", onKicked);
    socket.on("connect", onConnect);
    if (socket.connected) onConnect();
    return () => {
      socket.off("game:state", onState);
      socket.off("room:kicked", onKicked);
      socket.off("connect", onConnect);
    };
  }, []);

  const run = async (command: GameCommand) => {
    const result = await sendCommand(command);
    setError(result.status === "accepted" ? null : (result.error ?? result.status));
  };

  return (
    <main>
      <h1>Signal Shift</h1>
      {error && <p role="alert" className="error">{error}</p>}
      {view ? <Room view={view} run={run} /> : <JoinForm onError={setError} />}
    </main>
  );
}

function JoinForm({ onError }: { onError: (e: string | null) => void }) {
  const [nickname, setNickname] = useState("");
  const [code, setCode] = useState("");

  const submit = async (e: FormEvent, mode: "create" | "join") => {
    e.preventDefault();
    const response = mode === "create" ? await createRoom(nickname) : await joinRoom(code, nickname);
    onError(response.ok ? null : response.error);
  };

  return (
    <form className="card" onSubmit={(e) => submit(e, code ? "join" : "create")}>
      <label>
        Nickname
        <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={20} required />
      </label>
      <label>
        Room code (leave empty to host)
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={4} />
      </label>
      <button type="submit">{code ? "Join room" : "Create room"}</button>
    </form>
  );
}

function Room({ view, run }: { view: PlayerView; run: (c: GameCommand) => void }) {
  const me = view.players.find((p) => p.id === view.me.id);
  const isHost = !!me?.isHost;

  return (
    <>
      <section className="card">
        <p>
          Room <strong className="code">{view.roomCode}</strong> · {view.scenarioTitle}
        </p>
        <p>
          Phase <strong>{view.phase}</strong>
          {view.actNumber > 0 && ` · Act ${view.actNumber}/${view.totalActs}`} · Stability {view.stability} · Sync {view.sync}
        </p>
        {isHost && view.phase === "LOBBY" && (
          <button disabled={view.players.length < MIN_PLAYERS} onClick={() => run({ type: "START_GAME" })}>
            Start game ({view.players.length}/{MIN_PLAYERS}+ players)
          </button>
        )}
        {isHost && view.phase !== "LOBBY" && view.phase !== "RESULTS" && (
          <button onClick={() => run({ type: "ADVANCE_PHASE" })}>Skip to next phase</button>
        )}
      </section>

      <section className="card">
        <h2>Players</h2>
        <ul>
          {view.players.map((p) => (
            <li key={p.id}>
              {p.nickname}
              {p.isHost && " (host)"}
              {p.role && ` — ${p.role}`}
              {!p.connected && " · disconnected"}
              {isHost && view.phase === "LOBBY" && p.id !== view.me.id && (
                <button className="small" onClick={() => run({ type: "KICK_PLAYER", playerId: p.id })}>
                  Kick
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      {view.act && (
        <section className="card">
          <h2>{view.act.title}</h2>
          <p>{view.act.briefing}</p>
          <h3>Your role: {view.me.role}</h3>
          <ul>
            {view.me.clues.map((c) => (
              <li key={c.id}>{c.text}</li>
            ))}
          </ul>
        </section>
      )}

      {view.result && (
        <section className="card">
          <h2>{view.result.won ? "Incident resolved!" : "Shift over"}</h2>
          <p>Team score: {view.result.score.total} / 1000</p>
        </section>
      )}
    </>
  );
}
