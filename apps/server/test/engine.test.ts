import { describe, expect, it } from "vitest";
import { addPlayer, captainId, clueFor, setConnected, solvedCount, tick } from "../src/game/engine.js";
import { T0, answer, captain, expectAccepted, lobby, playRound, run, scenario, started } from "./helpers.js";

describe("lobby", () => {
  it("makes the first player host and rejects duplicate nicknames case-insensitively", () => {
    const state = lobby(2);
    expect(state.hostId).toBe("p1");
    const outcome = addPlayer(state, { id: "x", nickname: "  player   1 ", token: "tx" });
    expect(outcome).toEqual({ status: "invalid", error: "Nickname already taken" });
  });

  it("rejects empty and over-long nicknames", () => {
    const state = lobby(0);
    expect(addPlayer(state, { id: "a", nickname: "   ", token: "t" }).status).toBe("invalid");
    expect(addPlayer(state, { id: "a", nickname: "x".repeat(21), token: "t" }).status).toBe("invalid");
  });

  it("caps the room at 10 players", () => {
    const state = lobby(10);
    expect(addPlayer(state, { id: "p11", nickname: "Eleven", token: "t" })).toEqual({ status: "invalid", error: "Room is full" });
  });

  it("only lets the host start, and only with 5-10 players", () => {
    const small = lobby(4);
    expect(run(small, "p1", { type: "START_GAME" }).status).toBe("invalid");

    const state = lobby(5);
    expect(run(state, "p2", { type: "START_GAME" }).status).toBe("unauthorised");
    expectAccepted(state, "p1", { type: "START_GAME" });
    expect(state.phase).toBe("ROUND");
    expect(state.roundNumber).toBe(1);
    expect(state.phaseDeadline).toBe(T0 + scenario.roundSeconds * 1000);
    expect(run(state, "p1", { type: "START_GAME" }).status).toBe("invalid");
  });

  it("rejects late joins once the game has started", () => {
    const state = started();
    expect(addPlayer(state, { id: "late", nickname: "Late", token: "t" }).status).toBe("invalid");
  });

  it("lets the host kick in the lobby but not themselves, and not other players", () => {
    const state = lobby(3);
    expect(run(state, "p2", { type: "KICK_PLAYER", playerId: "p3" }).status).toBe("unauthorised");
    expect(run(state, "p1", { type: "KICK_PLAYER", playerId: "p1" }).status).toBe("invalid");
    expectAccepted(state, "p1", { type: "KICK_PLAYER", playerId: "p3" });
    expect(state.players.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("does not allow kicking once the game has started", () => {
    const state = started();
    expect(run(state, "p1", { type: "KICK_PLAYER", playerId: "p2" }).status).toBe("invalid");
  });

  it("stops a kicked nickname from rejoining, case-insensitively", () => {
    const state = lobby(3);
    expectAccepted(state, "p1", { type: "KICK_PLAYER", playerId: "p3" });
    expect(addPlayer(state, { id: "p3b", nickname: " PLAYER 3 ", token: "t" })).toEqual({
      status: "invalid",
      error: "You were removed from this room by the host",
    });
    expect(addPlayer(state, { id: "p4", nickname: "Player 4", token: "t4" }).status).toBe("accepted");
  });

  it("frees lobby seats on disconnect and passes host on", () => {
    const state = lobby(3);
    setConnected(state, "p1", false);
    expect(state.players.map((p) => p.id)).toEqual(["p2", "p3"]);
    expect(state.hostId).toBe("p2");
  });

  it("keeps in-game seats on disconnect, hands host to a connected player, and allows reconnect", () => {
    const state = started();
    const clue = clueFor(state, "p1");
    setConnected(state, "p1", false);
    expect(state.players.find((p) => p.id === "p1")?.connected).toBe(false);
    expect(state.seats).toContain("p1");
    expect(state.hostId).not.toBe("p1");
    setConnected(state, "p1", true);
    expect(state.players.find((p) => p.id === "p1")?.connected).toBe(true);
    expect(clueFor(state, "p1")).toBe(clue);
  });

  it("rejects commands from non-members", () => {
    const state = started();
    expect(run(state, "ghost", { type: "ADVANCE_PHASE" }).status).toBe("unauthorised");
    expect(run(state, "ghost", { type: "PICK_ANSWER", answerId: "gate_c" }).status).toBe("unauthorised");
  });
});

describe("captain", () => {
  it("seats players deterministically from the seed", () => {
    expect(started(6, 7).seats).toEqual(started(6, 7).seats);
    expect(captainId(lobby(5))).toBeNull();
  });

  it.each([5, 7, 10])("rotates to a different player each round at %i players", (n) => {
    const state = started(n);
    const captains = [captain(state)];
    playRound(state, true);
    captains.push(captain(state));
    playRound(state, true);
    captains.push(captain(state));
    expect(new Set(captains).size).toBe(3);
    expect(captains).toEqual(state.seats.slice(0, 3));
  });

  it("only the Captain can pick, and only during ROUND", () => {
    const state = started();
    const cap = captain(state);
    const other = state.seats.find((id) => id !== cap)!;
    expect(run(state, other, { type: "PICK_ANSWER", answerId: "gate_c" }).status).toBe("unauthorised");
    expect(run(state, cap, { type: "PICK_ANSWER", answerId: "gate_z" }).status).toBe("invalid");
    expect(state.phase).toBe("ROUND");
    expectAccepted(state, cap, { type: "PICK_ANSWER", answerId: "gate_c" });
    expect(state.phase).toBe("REVEAL");
    expect(run(state, cap, { type: "PICK_ANSWER", answerId: "gate_a" }).status).toBe("invalid");
    expect(run(lobby(5), "p1", { type: "PICK_ANSWER", answerId: "gate_c" }).status).toBe("invalid");
  });
});

describe("rounds", () => {
  it("picking ends the round immediately and records a correct answer", () => {
    const state = started();
    expectAccepted(state, captain(state), { type: "PICK_ANSWER", answerId: "gate_c" }, T0 + 5_000);
    expect(state.phase).toBe("REVEAL");
    expect(state.phaseDeadline).toBe(T0 + 5_000 + scenario.revealSeconds * 1000);
    expect(state.outcomes).toEqual([{ answerId: "gate_c", correct: true, narration: scenario.rounds[0]!.answers[2]!.narration }]);
  });

  it("records a wrong answer as failed", () => {
    const state = started();
    expectAccepted(state, captain(state), { type: "PICK_ANSWER", answerId: "gate_a" });
    expect(state.outcomes[0]).toMatchObject({ answerId: "gate_a", correct: false });
  });

  it("a timeout counts as failed with the timeout narration", () => {
    const state = started();
    expect(tick(state, T0 + 1)).toBe(false);
    expect(tick(state, state.phaseDeadline!)).toBe(true);
    expect(state.phase).toBe("REVEAL");
    expect(state.outcomes[0]).toEqual({ answerId: null, correct: false, narration: scenario.rounds[0]!.timeout });
  });

  it("reveal advances to the next round on its deadline", () => {
    const state = started();
    expectAccepted(state, captain(state), { type: "PICK_ANSWER", answerId: "gate_c" });
    expect(tick(state, state.phaseDeadline!)).toBe(true);
    expect(state).toMatchObject({ phase: "ROUND", roundNumber: 2 });
  });

  it("lets only the host skip ahead, and not from LOBBY or RESULTS", () => {
    const state = started();
    const other = state.players.find((p) => p.id !== state.hostId)!.id;
    expect(run(state, other, { type: "ADVANCE_PHASE" }).status).toBe("unauthorised");
    expectAccepted(state, "p1", { type: "ADVANCE_PHASE" });
    expect(state.phase).toBe("REVEAL");
    expect(state.outcomes[0]?.correct).toBe(false);
    expect(run(lobby(5), "p1", { type: "ADVANCE_PHASE" }).status).toBe("invalid");
  });

  it("goes to RESULTS after round 3 and scores the rounds solved", () => {
    const state = started();
    playRound(state, true);
    playRound(state, false);
    expect(state.roundNumber).toBe(3);
    playRound(state, true);
    expect(state.phase).toBe("RESULTS");
    expect(state.phaseDeadline).toBeNull();
    expect(solvedCount(state)).toBe(2);
    expect(run(state, "p1", { type: "ADVANCE_PHASE" }).status).toBe("invalid");
  });

  it("increments the version on every change and not on rejected commands", () => {
    const state = started();
    const v = state.version;
    expect(run(state, "p2", { type: "PICK_ANSWER", answerId: "nope" }).status).not.toBe("accepted");
    expect(state.version).toBe(v);
    expectAccepted(state, "p1", { type: "ADVANCE_PHASE" });
    expect(state.version).toBe(v + 1);
  });
});

describe("clue dealing", () => {
  it("gives each of 5 players a different clue, covering all 5", () => {
    const state = started(5);
    const clues = state.seats.map((id) => clueFor(state, id));
    expect(new Set(clues)).toEqual(new Set(scenario.rounds[0]!.clues));
  });

  it("wraps around with more than 5 players, so some players share a clue", () => {
    const state = started(8);
    const clues = state.seats.map((id) => clueFor(state, id));
    expect(clues.every((c) => c !== null)).toBe(true);
    expect(new Set(clues)).toEqual(new Set(scenario.rounds[0]!.clues));
    expect(clues[0]).toBe(clues[5]);
  });

  it("shifts the dealing each round so the Captain's clue changes", () => {
    const state = started(5);
    const captainClues = [];
    for (let r = 0; r < 3; r++) {
      const clues = scenario.rounds[r]!.clues;
      captainClues.push(clues.indexOf(clueFor(state, captain(state))!));
      if (r < 2) playRound(state, true);
    }
    expect(new Set(captainClues).size).toBe(3);
  });

  it("deals nothing outside a round or to non-players", () => {
    expect(clueFor(lobby(5), "p1")).toBeNull();
    expect(clueFor(started(), "ghost")).toBeNull();
  });
});

describe("play again", () => {
  it("returns connected players to a fresh lobby, host only, from RESULTS only", () => {
    const state = started();
    expect(run(state, "p1", { type: "PLAY_AGAIN" })).toEqual({ status: "invalid", error: "The game is still running" });
    playRound(state, true);
    playRound(state, true);
    playRound(state, false);
    expect(state.phase).toBe("RESULTS");
    setConnected(state, "p5", false);
    const version = state.version;

    expect(run(state, "p2", { type: "PLAY_AGAIN" }).status).toBe("unauthorised");
    expectAccepted(state, "p1", { type: "PLAY_AGAIN" });

    expect(state).toMatchObject({
      phase: "LOBBY",
      phaseDeadline: null,
      roundNumber: 0,
      seats: [],
      outcomes: [],
      hostId: "p1",
    });
    expect(state.players.map((p) => p.id)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(state.version).toBeGreaterThan(version);
    expect(state.seed).not.toBe(42);

    addPlayer(state, { id: "p6", nickname: "Six", token: "t6" });
    expectAccepted(state, "p1", { type: "START_GAME" });
    expect(state.phase).toBe("ROUND");
    expect(answer(state, true)).toBe("gate_c");
  });
});
