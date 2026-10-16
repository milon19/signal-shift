import { useEffect, useState, type FormEvent } from "react";
import { MIN_PLAYERS, type GameCommand, type PlayerView } from "@signal-shift/shared";
import { SERVER_URL, createRoom, forgetSession, joinRoom, sendCommand, socket, tryRejoin } from "./socket";

type Run = (c: GameCommand) => void;

const RULES = "Everyone has a secret clue. Talk it through, then the Captain picks the answer.";

export function App() {
  const [view, setView] = useState<PlayerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<"connecting" | "up" | "down">(socket.connected ? "up" : "connecting");

  useEffect(() => {
    const onState = (v: PlayerView) => setView(v);
    const onKicked = () => {
      forgetSession();
      setView(null);
      setError("You were removed from the room by the host.");
    };
    const onConnect = () => {
      setConnection("up");
      void tryRejoin();
    };
    const onDown = () => setConnection("down");
    socket.on("game:state", onState);
    socket.on("room:kicked", onKicked);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDown);
    socket.on("connect_error", onDown);
    if (socket.connected) onConnect();
    return () => {
      socket.off("game:state", onState);
      socket.off("room:kicked", onKicked);
      socket.off("connect", onConnect);
      socket.off("disconnect", onDown);
      socket.off("connect_error", onDown);
    };
  }, []);

  const run = async (command: GameCommand) => {
    const result = await sendCommand(command);
    setError(result.status === "accepted" ? null : (result.error ?? result.status));
  };

  return (
    <main>
      <h1>Signal Shift</h1>
      {connection === "down" && (
        <p role="alert" className="error">
          Can't reach the game server at {SERVER_URL}. Retrying…
        </p>
      )}
      {connection === "connecting" && <p className="muted">Connecting to the game server…</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {view ? <Room view={view} run={run} /> : <JoinForm online={connection === "up"} onError={setError} />}
    </main>
  );
}

function JoinForm({ online, onError }: { online: boolean; onError: (e: string | null) => void }) {
  const [nickname, setNickname] = useState("");
  const [code, setCode] = useState("");

  const submit = async (e: FormEvent, mode: "create" | "join") => {
    e.preventDefault();
    const response = mode === "create" ? await createRoom(nickname) : await joinRoom(code, nickname);
    onError(response.ok ? null : response.error);
  };

  return (
    <form className="card" onSubmit={(e) => submit(e, code ? "join" : "create")}>
      <p>{RULES}</p>
      <label>
        Nickname
        <input value={nickname} onChange={(e) => setNickname(e.target.value)} maxLength={20} required />
      </label>
      <label>
        Room code (leave empty to host)
        <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={4} />
      </label>
      <button type="submit" disabled={!online}>
        {code ? "Join room" : "Create room"}
      </button>
    </form>
  );
}

function Room({ view, run }: { view: PlayerView; run: Run }) {
  const isHost = !!view.players.find((p) => p.id === view.me.id)?.isHost;
  const inPlay = view.phase === "ROUND" || view.phase === "REVEAL";

  return (
    <>
      <section className="card">
        <p>
          Room <strong className="code">{view.roomCode}</strong> · {view.scenarioTitle}
        </p>
        {inPlay && (
          <p>
            Round {view.roundNumber}/{view.totalRounds} · Solved {view.solved}
            <Countdown deadline={view.phaseDeadline} />
          </p>
        )}
        {isHost && inPlay && <button onClick={() => run({ type: "ADVANCE_PHASE" })}>Skip to next phase</button>}
      </section>

      {view.phase === "LOBBY" && <Lobby view={view} run={run} isHost={isHost} />}
      {view.phase === "ROUND" && <RoundPanel view={view} run={run} />}
      {view.phase === "REVEAL" && <RevealPanel view={view} />}
      {view.results && (
        <section className="card">
          <h2>
            You solved {view.results.solved} of {view.results.total}
          </h2>
          <p>{view.results.line}</p>
          {isHost ? (
            <button onClick={() => run({ type: "PLAY_AGAIN" })}>Play again</button>
          ) : (
            <p className="muted">Waiting for the host…</p>
          )}
        </section>
      )}
    </>
  );
}

function Lobby({ view, run, isHost }: { view: PlayerView; run: Run; isHost: boolean }) {
  return (
    <section className="card">
      <p>{RULES}</p>
      <h2>Players</h2>
      <ul>
        {view.players.map((p) => (
          <li key={p.id}>
            {p.nickname}
            {p.isHost && " (host)"}
            {isHost && p.id !== view.me.id && (
              <button className="small" onClick={() => run({ type: "KICK_PLAYER", playerId: p.id })}>
                Kick
              </button>
            )}
          </li>
        ))}
      </ul>
      {isHost ? (
        <button disabled={view.players.length < MIN_PLAYERS} onClick={() => run({ type: "START_GAME" })}>
          Start game ({view.players.length}/{MIN_PLAYERS}+ players)
        </button>
      ) : (
        <p className="muted">Waiting for the host to start…</p>
      )}
    </section>
  );
}

function RoundPanel({ view, run }: { view: PlayerView; run: Run }) {
  const round = view.round!;
  const captain = view.players.find((p) => p.id === view.captainId);
  const iAmCaptain = view.captainId === view.me.id;

  return (
    <section className="card">
      <h2>{round.title}</h2>
      <p className="question">{round.question}</p>
      <div className="clue">
        <h3>Your clue</h3>
        <p>{view.me.clue}</p>
      </div>
      <p>
        Captain: <strong>{iAmCaptain ? "You!" : captain?.nickname}</strong>
        {captain && !captain.connected && " · disconnected"}
      </p>
      {iAmCaptain ? (
        <div className="actions">
          {round.answers.map((a) => (
            <button key={a.id} onClick={() => run({ type: "PICK_ANSWER", answerId: a.id })}>
              {a.label}
            </button>
          ))}
        </div>
      ) : (
        <>
          <ul>
            {round.answers.map((a) => (
              <li key={a.id}>{a.label}</li>
            ))}
          </ul>
          <p className="muted">Tell {captain?.nickname} what you think!</p>
        </>
      )}
    </section>
  );
}

function RevealPanel({ view }: { view: PlayerView }) {
  const reveal = view.reveal!;
  const labelOf = (id: string | null) => view.round?.answers.find((a) => a.id === id)?.label;

  return (
    <section className="card">
      <h2>{reveal.correct ? "✓ Solved!" : reveal.answerId ? "✗ Wrong answer" : "⏱ Time's up"}</h2>
      {reveal.answerId && <p>The Captain picked {labelOf(reveal.answerId)}.</p>}
      <p className="question">{reveal.narration}</p>
      {!reveal.correct && <p>The right answer was {labelOf(reveal.correctAnswerId)}.</p>}
      <h3>Everyone's clues</h3>
      <ul>
        {reveal.clues.map((c) => (
          <li key={c.playerId}>
            <strong>{c.nickname}:</strong> {c.text}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Countdown({ deadline }: { deadline: number | null }) {
  const [, rerender] = useState(0);
  useEffect(() => {
    if (deadline === null) return;
    const id = setInterval(() => rerender((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [deadline]);
  if (deadline === null) return null;
  // ponytail: trusts the client clock; send server time with each view if players see skewed timers.
  const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
  return <> · ⏱ {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")}</>;
}
