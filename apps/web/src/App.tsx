import { useEffect, useState, type FormEvent } from "react";
import { MIN_PLAYERS, type GameCommand, type PlayerView, type StakeAmount } from "@signal-shift/shared";
import { SERVER_URL, createRoom, forgetSession, joinRoom, sendCommand, socket, tryRejoin } from "./socket";

type Run = (c: GameCommand) => void;

const CLAIM_PHASES = new Set(["ACT_RELAY", "ACT_VERIFY"]);
const PIN_PHASES = new Set(["ACT_SCAN", "ACT_RELAY", "ACT_VERIFY"]);
const STAKES: StakeAmount[] = [1, 2, 3];

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
  const me = view.players.find((p) => p.id === view.me.id);
  const isHost = !!me?.isHost;
  const nameOf = (id: string) => view.players.find((p) => p.id === id)?.nickname ?? "?";

  return (
    <>
      <section className="card">
        <p>
          Room <strong className="code">{view.roomCode}</strong> · {view.scenarioTitle}
        </p>
        <p>
          Phase <strong>{view.phase}</strong>
          {view.actNumber > 0 && ` · Act ${view.actNumber}/${view.totalActs}`} · Stability {view.stability} · Sync {view.sync}
          <Countdown deadline={view.phaseDeadline} />
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

      {view.outcomes.length > 0 && (
        <section className="card">
          <h2>Shift log</h2>
          <ol>
            {view.outcomes.map((o, i) => (
              <li key={i}>
                {o.narration}{" "}
                <span className="muted">
                  ({o.correct ? "correct" : "wrong"}, stability {o.stabilityDelta >= 0 ? "+" : ""}
                  {o.stabilityDelta})
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {view.act && <ActPanel view={view} run={run} />}
      {view.act && view.pinned.length > 0 && (
        <section className="card">
          <h2>Pinned clues</h2>
          <ul>
            {view.pinned.map((p) => (
              <li key={p.clueId}>
                {p.text} <span className="muted">— pinned by {nameOf(p.pinnedBy)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {view.act && (CLAIM_PHASES.has(view.phase) || view.claims.length > 0) && (
        <ClaimsPanel view={view} run={run} nameOf={nameOf} />
      )}
      {view.phase === "ACT_COMMIT" && <CommitPanel view={view} run={run} nameOf={nameOf} />}

      {view.result && (
        <section className="card">
          <h2>{view.result.won ? "Incident resolved!" : "Shift over"}</h2>
          <p>Team score: {view.result.score.total} / 1000</p>
          {isHost ? (
            <button onClick={() => run({ type: "PLAY_AGAIN" })}>Play again</button>
          ) : (
            <p className="muted">Waiting for the host to start a new shift.</p>
          )}
        </section>
      )}
    </>
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

function ActPanel({ view, run }: { view: PlayerView; run: Run }) {
  const act = view.act!;
  const canPin = view.me.role === "Dispatcher" && view.me.pinsRemaining > 0 && PIN_PHASES.has(view.phase);
  const pinned = new Set(view.pinned.map((p) => p.clueId));

  return (
    <section className="card">
      <h2>{act.title}</h2>
      <p>{act.briefing}</p>
      <h3>Your role: {view.me.role}</h3>
      <ul>
        {view.me.clues.map((c) => (
          <li key={c.id}>
            {c.text}
            {canPin && !pinned.has(c.id) && (
              <button className="small" onClick={() => run({ type: "DISPATCH_PIN", clueId: c.id })}>
                Pin for everyone
              </button>
            )}
          </li>
        ))}
      </ul>
      {view.me.role === "Dispatcher" && PIN_PHASES.has(view.phase) && (
        <p className="muted">Pins left this act: {view.me.pinsRemaining}</p>
      )}
    </section>
  );
}

function ClaimsPanel({ view, run, nameOf }: { view: PlayerView; run: Run; nameOf: (id: string) => string }) {
  const facts = view.act!.facts;
  const open = CLAIM_PHASES.has(view.phase);
  const canAudit = view.me.role === "Auditor" && view.phase === "ACT_VERIFY" && view.me.auditsRemaining > 0;
  const promptOf = (id: string) => facts.find((f) => f.id === id)?.prompt ?? id;

  return (
    <section className="card">
      <h2>Claims</h2>
      {open && <ClaimForm facts={facts} run={run} />}
      {view.me.role === "Auditor" && view.phase === "ACT_VERIFY" && (
        <p className="muted">Audits left this act: {view.me.auditsRemaining}</p>
      )}
      {view.claims.length === 0 && <p className="muted">No claims yet.</p>}
      <ul className="claims">
        {view.claims.map((c) => {
          const staked = c.stakes.reduce((sum, s) => sum + s.amount, 0);
          const mine = c.stakes.find((s) => s.playerId === view.me.id);
          return (
            <li key={c.id}>
              <strong>{nameOf(c.authorId)}</strong>: “{promptOf(c.factId)}” is{" "}
              <strong>{c.assertion ? "TRUE" : "FALSE"}</strong> — {c.text}
              <div className="muted">
                Staked {staked} Sync{mine && ` (you: ${mine.amount})`}
                {c.status !== "open" && ` · Audit: ${c.status}`}
                {c.correct !== null && ` · ${c.correct ? "✓ correct" : "✗ wrong"}`}
              </div>
              {open && c.status === "open" && !mine && (
                <div>
                  {STAKES.map((amount) => (
                    <button
                      key={amount}
                      className="small"
                      disabled={amount > view.sync}
                      onClick={() => run({ type: "SYNC_STAKE", claimId: c.id, amount })}
                    >
                      Stake {amount}
                    </button>
                  ))}
                </div>
              )}
              {canAudit && c.status === "open" && (
                <button className="small" onClick={() => run({ type: "CLAIM_VERIFY", claimId: c.id })}>
                  Audit
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function ClaimForm({ facts, run }: { facts: { id: string; prompt: string }[]; run: Run }) {
  const [factId, setFactId] = useState(facts[0]?.id ?? "");
  const [assertion, setAssertion] = useState(true);
  const [text, setText] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    run({ type: "CLAIM_CREATE", factId, assertion, text });
    setText("");
  };

  return (
    <form className="claim-form" onSubmit={submit}>
      <label>
        Fact
        <select value={factId} onChange={(e) => setFactId(e.target.value)}>
          {facts.map((f) => (
            <option key={f.id} value={f.id}>
              {f.prompt}
            </option>
          ))}
        </select>
      </label>
      <label>
        I claim it is
        <select value={String(assertion)} onChange={(e) => setAssertion(e.target.value === "true")}>
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
      </label>
      <label>
        Because…
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} required />
      </label>
      <button type="submit">Post claim</button>
    </form>
  );
}

function CommitPanel({ view, run, nameOf }: { view: PlayerView; run: Run; nameOf: (id: string) => string }) {
  const operators = view.players.filter((p) => p.role === "Operator");

  return (
    <section className="card">
      <h2>Commit</h2>
      {view.me.role === "Operator" ? (
        <>
          <p>You have one attempt. Choose the action:</p>
          <div className="actions">
            {view.act!.actions.map((a) => (
              <button key={a.id} onClick={() => run({ type: "COMMIT_ACTION", actionId: a.id })}>
                {a.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="muted">Waiting for the Operator ({operators.map((p) => nameOf(p.id)).join(", ")}) to commit.</p>
      )}
    </section>
  );
}
