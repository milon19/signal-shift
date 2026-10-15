import { describe, expect, it } from "vitest";
import { ROLES } from "@signal-shift/shared";
import {
  MAX_CLAIMS_PER_ACT,
  addPlayer,
  assignRoles,
  cluesFor,
  roleSlots,
  setConnected,
  tick,
} from "../src/game/engine.js";
import { T0, advanceTo, commit, expectAccepted, holder, lobby, run, scenario, started } from "./helpers.js";

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
    expect(state.phase).toBe("ACT_SCAN");
    expect(state.actNumber).toBe(1);
    expect(state.phaseDeadline).toBe(T0 + scenario.phaseDurationsSec.ACT_SCAN * 1000);
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

  it("frees lobby seats on disconnect and passes host on", () => {
    const state = lobby(3);
    setConnected(state, "p1", false);
    expect(state.players.map((p) => p.id)).toEqual(["p2", "p3"]);
    expect(state.hostId).toBe("p2");
  });

  it("keeps in-game seats on disconnect, hands host to a connected player, and allows reconnect", () => {
    const state = started();
    const role = state.roles.p1;
    setConnected(state, "p1", false);
    expect(state.players.find((p) => p.id === "p1")?.connected).toBe(false);
    expect(state.roles.p1).toBe(role);
    expect(state.hostId).not.toBe("p1");
    setConnected(state, "p1", true);
    expect(state.players.find((p) => p.id === "p1")?.connected).toBe(true);
  });

  it("rejects commands from non-members", () => {
    const state = started();
    expect(run(state, "ghost", { type: "ADVANCE_PHASE" }).status).toBe("unauthorised");
  });
});

describe("roles", () => {
  it("assigns each core role exactly once at five players", () => {
    const state = started(5);
    expect(Object.values(state.roles).sort()).toEqual([...ROLES].sort());
  });

  it("fills extra seats with overlapping information roles, keeping one Operator and Auditor", () => {
    const slots = roleSlots(10);
    expect(slots.filter((r) => r === "Operator")).toHaveLength(1);
    expect(slots.filter((r) => r === "Auditor")).toHaveLength(1);
    expect(slots).toHaveLength(10);
    expect(new Set(slots)).toEqual(new Set(ROLES));
  });

  it("rotates every player to a new role each act", () => {
    for (const n of [5, 7, 10]) {
      const seats = Array.from({ length: n }, (_, i) => `p${i}`);
      const acts = [0, 1, 2].map((a) => assignRoles(seats, a));
      for (const id of seats) {
        if (n === 5) expect(new Set(acts.map((r) => r[id])).size).toBe(3);
      }
      // Authority roles always move to a different player.
      for (const role of ["Operator", "Auditor"] as const) {
        const owners = acts.map((r) => seats.find((id) => r[id] === role));
        expect(new Set(owners).size).toBe(3);
      }
    }
  });

  it("seats players deterministically from the seed", () => {
    expect(started(6, 7).seats).toEqual(started(6, 7).seats);
  });

  it("deals shared-role clues round-robin with partial overlap", () => {
    const state = started(10);
    const navigators = state.seats.filter((id) => state.roles[id] === "Navigator");
    expect(navigators.length).toBeGreaterThan(1);
    const dealt = navigators.map((id) => cluesFor(state, id));
    for (const clues of dealt) expect(clues.length).toBeGreaterThan(0);
    // Act 1 has two Navigator clues; together the holders see all of them.
    expect(new Set(dealt.flat().map((c) => c.id))).toEqual(new Set(scenario.acts.docking!.clues.Navigator.map((c) => c.id)));
  });
});

describe("phase machine", () => {
  it("walks SCAN -> RELAY -> VERIFY -> COMMIT on deadlines", () => {
    const state = started();
    expect(tick(state, T0 + 1)).toBe(false);
    let now = state.phaseDeadline!;
    for (const phase of ["ACT_RELAY", "ACT_VERIFY", "ACT_COMMIT"] as const) {
      expect(tick(state, now)).toBe(true);
      expect(state.phase).toBe(phase);
      expect(state.phaseDeadline).toBe(now + scenario.phaseDurationsSec[phase] * 1000);
      now = state.phaseDeadline!;
    }
  });

  it("applies the timeout outcome when no action is committed", () => {
    const state = started();
    advanceTo(state, "ACT_COMMIT");
    tick(state, state.phaseDeadline!);
    expect(state.phase).toBe("CONSEQUENCE");
    expect(state.stability).toBe(scenario.startingStability + scenario.acts.docking!.timeout.stabilityDelta);
    expect(state.outcomes[0]).toMatchObject({ actionId: null, correct: false });
  });

  it("lets only the host skip ahead, and not from LOBBY or RESULTS", () => {
    const state = started();
    const other = state.players.find((p) => p.id !== state.hostId)!.id;
    expect(run(state, other, { type: "ADVANCE_PHASE" }).status).toBe("unauthorised");
    expectAccepted(state, "p1", { type: "ADVANCE_PHASE" });
    expect(state.phase).toBe("ACT_RELAY");
    expect(run(lobby(5), "p1", { type: "ADVANCE_PHASE" }).status).toBe("invalid");
  });

  it("rotates roles at handoff and starts the next act", () => {
    const state = started();
    const operatorAct1 = holder(state, "Operator");
    commit(state, "open_gate_c");
    advanceTo(state, "HANDOFF");
    expect(holder(state, "Operator")).not.toBe(operatorAct1);
    advanceTo(state, "ACT_SCAN");
    expect(state.actNumber).toBe(2);
    expect(state.actId).toBe("power");
  });

  it("increments the version on every change", () => {
    const state = started();
    const v = state.version;
    expectAccepted(state, "p1", { type: "ADVANCE_PHASE" });
    expect(state.version).toBe(v + 1);
    expect(run(state, "p1", { type: "COMMIT_ACTION", actionId: "open_gate_c" }).status).not.toBe("accepted");
    expect(state.version).toBe(v + 1);
  });
});

describe("commit and branching", () => {
  it("only the Operator can commit, and only during COMMIT", () => {
    const state = started();
    const op = holder(state, "Operator");
    expect(run(state, op, { type: "COMMIT_ACTION", actionId: "open_gate_c" }).status).toBe("invalid");
    advanceTo(state, "ACT_COMMIT");
    expect(run(state, holder(state, "Navigator"), { type: "COMMIT_ACTION", actionId: "open_gate_c" }).status).toBe("unauthorised");
    expect(run(state, op, { type: "COMMIT_ACTION", actionId: "nope" }).status).toBe("invalid");
    expectAccepted(state, op, { type: "COMMIT_ACTION", actionId: "open_gate_c" });
    expect(state.phase).toBe("CONSEQUENCE");
  });

  it("wrong actions cost stability", () => {
    const state = started();
    commit(state, "open_gate_a");
    expect(state.stability).toBe(70);
    expect(state.outcomes[0]).toMatchObject({ actionId: "open_gate_a", correct: false, stabilityDelta: -30 });
  });

  it.each([
    ["reroute_observatory", "finale_observatory"],
    ["reroute_kitchens", "finale_kitchens"],
    ["reroute_spa", "finale_kitchens"],
  ])("act 2 decision %s branches to %s", (action, finale) => {
    const state = started();
    commit(state, "open_gate_c");
    advanceTo(state, "ACT_SCAN");
    commit(state, action);
    advanceTo(state, "ACT_SCAN");
    expect(state.actNumber).toBe(3);
    expect(state.actId).toBe(finale);
  });

  it("a perfect run wins with full objective, efficiency and recovery points", () => {
    const state = started();
    commit(state, "open_gate_c");
    advanceTo(state, "ACT_SCAN");
    commit(state, "reroute_observatory");
    advanceTo(state, "ACT_SCAN");
    commit(state, "launch_east");
    advanceTo(state, "RESULTS");
    expect(state.phaseDeadline).toBeNull();
    expect(state.result?.won).toBe(true);
    expect(state.result?.score).toMatchObject({ objectives: 450, efficiency: 200, recovery: 100, claims: 0 });
  });

  it("ends early at zero stability but still produces a scored debrief", () => {
    const state = started();
    commit(state, "open_gate_a"); // 70
    advanceTo(state, "ACT_SCAN");
    commit(state, "reroute_spa"); // 40
    advanceTo(state, "ACT_SCAN");
    commit(state, "load_flambe"); // 0
    expect(state.stability).toBe(0);
    advanceTo(state, "RESULTS");
    expect(state.result?.won).toBe(false);
    expect(state.result?.score.objectives).toBe(0);
    expect(state.result?.score.total).toBeGreaterThanOrEqual(0);
  });

  it("finishes immediately when stability hits zero before the finale", () => {
    const state = started();
    state.stability = 20;
    commit(state, "open_gate_a");
    expect(state.stability).toBe(0);
    advanceTo(state, "RESULTS");
    expect(state.actNumber).toBe(1);
    expect(state.result?.won).toBe(false);
  });
});

describe("claims and Sync", () => {
  function relay() {
    const state = started();
    advanceTo(state, "ACT_RELAY");
    return state;
  }

  it("validates claim phase, fact and text", () => {
    const state = started();
    expect(run(state, "p1", { type: "CLAIM_CREATE", factId: "gate_c_safe", assertion: true, text: "C is fine" }).status).toBe("invalid");
    advanceTo(state, "ACT_RELAY");
    expect(run(state, "p1", { type: "CLAIM_CREATE", factId: "nope", assertion: true, text: "x" }).status).toBe("invalid");
    expect(run(state, "p1", { type: "CLAIM_CREATE", factId: "gate_c_safe", assertion: true, text: "   " }).status).toBe("invalid");
    expect(run(state, "p1", { type: "CLAIM_CREATE", factId: "gate_c_safe", assertion: true, text: "x".repeat(201) }).status).toBe("invalid");
    expectAccepted(state, "p1", { type: "CLAIM_CREATE", factId: "gate_c_safe", assertion: true, text: " Gate C is safe " });
    expect(state.claims[0]).toMatchObject({ id: "c1", authorId: "p1", text: "Gate C is safe", status: "open", correct: null });
  });

  it("caps claims per act", () => {
    const state = relay();
    for (let i = 0; i < MAX_CLAIMS_PER_ACT; i++) {
      expectAccepted(state, "p1", { type: "CLAIM_CREATE", factId: "gate_c_safe", assertion: true, text: `claim ${i}` });
    }
    expect(run(state, "p1", { type: "CLAIM_CREATE", factId: "gate_c_safe", assertion: true, text: "one more" }).status).toBe("invalid");
  });

  it("stakes spend from the shared Sync pool, once per player per claim", () => {
    const state = relay();
    expectAccepted(state, "p1", { type: "CLAIM_CREATE", factId: "gate_c_safe", assertion: true, text: "C safe" });
    expectAccepted(state, "p2", { type: "SYNC_STAKE", claimId: "c1", amount: 3 });
    expect(state.sync).toBe(7);
    expect(run(state, "p2", { type: "SYNC_STAKE", claimId: "c1", amount: 1 }).status).toBe("invalid");
    expect(run(state, "p3", { type: "SYNC_STAKE", claimId: "zz", amount: 1 }).status).toBe("invalid");
    state.sync = 1;
    expect(run(state, "p3", { type: "SYNC_STAKE", claimId: "c1", amount: 2 })).toEqual({ status: "invalid", error: "Not enough Sync" });
  });

  it("settles stakes at consequence: correct stakes double, wrong stakes are lost", () => {
    const state = relay();
    expectAccepted(state, "p1", { type: "CLAIM_CREATE", factId: "gate_c_safe", assertion: true, text: "C safe" });
    expectAccepted(state, "p2", { type: "CLAIM_CREATE", factId: "gate_a_safe", assertion: true, text: "A safe" });
    expectAccepted(state, "p3", { type: "SYNC_STAKE", claimId: "c1", amount: 2 });
    expectAccepted(state, "p4", { type: "SYNC_STAKE", claimId: "c2", amount: 3 });
    expect(state.sync).toBe(5);
    commit(state, "open_gate_c");
    expect(state.sync).toBe(9);
    expect(state.claims.map((c) => c.correct)).toEqual([true, false]);
  });

  it("only the Auditor verifies, during VERIFY, within the audit budget; audited claims close to staking", () => {
    const state = relay();
    for (const [i, factId] of ["gate_c_safe", "gate_a_safe", "blue_overload"].entries()) {
      expectAccepted(state, "p1", { type: "CLAIM_CREATE", factId, assertion: true, text: `claim ${i}` });
    }
    const auditor = holder(state, "Auditor");
    expect(run(state, auditor, { type: "CLAIM_VERIFY", claimId: "c1" }).status).toBe("invalid");
    advanceTo(state, "ACT_VERIFY");
    expect(run(state, holder(state, "Navigator"), { type: "CLAIM_VERIFY", claimId: "c1" }).status).toBe("unauthorised");

    expectAccepted(state, auditor, { type: "CLAIM_VERIFY", claimId: "c1" });
    expectAccepted(state, auditor, { type: "CLAIM_VERIFY", claimId: "c2" });
    expect(state.claims.slice(0, 2).map((c) => c.status)).toEqual(["verified", "refuted"]);
    expect(run(state, auditor, { type: "CLAIM_VERIFY", claimId: "c3" })).toEqual({ status: "invalid", error: "No audits remaining this act" });
    expect(run(state, "p2", { type: "SYNC_STAKE", claimId: "c1", amount: 1 }).status).toBe("invalid");
  });

  it("claims are scoped to their act", () => {
    const state = relay();
    expectAccepted(state, "p1", { type: "CLAIM_CREATE", factId: "gate_c_safe", assertion: true, text: "C safe" });
    commit(state, "open_gate_c");
    advanceTo(state, "ACT_RELAY");
    expect(run(state, "p2", { type: "SYNC_STAKE", claimId: "c1", amount: 1 }).status).toBe("invalid");
  });

  it("scores the share of staked claims that were correct", () => {
    const state = relay();
    expectAccepted(state, "p1", { type: "CLAIM_CREATE", factId: "gate_c_safe", assertion: true, text: "C safe" });
    expectAccepted(state, "p1", { type: "CLAIM_CREATE", factId: "gate_a_safe", assertion: true, text: "A safe" });
    expectAccepted(state, "p2", { type: "SYNC_STAKE", claimId: "c1", amount: 1 });
    expectAccepted(state, "p2", { type: "SYNC_STAKE", claimId: "c2", amount: 1 });
    commit(state, "open_gate_c");
    state.nextActId = null; // end after this act
    advanceTo(state, "RESULTS");
    expect(state.result?.score.claims).toBe(75);
  });
});

describe("Dispatcher pins", () => {
  it("pins one of the Dispatcher's own clues per act", () => {
    const state = started();
    const dispatcher = holder(state, "Dispatcher");
    expect(run(state, holder(state, "Navigator"), { type: "DISPATCH_PIN", clueId: "docking.nav.1" }).status).toBe("unauthorised");
    expect(run(state, dispatcher, { type: "DISPATCH_PIN", clueId: "docking.nav.1" }).status).toBe("unauthorised");
    expectAccepted(state, dispatcher, { type: "DISPATCH_PIN", clueId: "docking.dis.1" });
    expect(state.pinned).toEqual([{ clueId: "docking.dis.1", text: expect.stringContaining("Gate A"), pinnedBy: dispatcher }]);
    expect(run(state, dispatcher, { type: "DISPATCH_PIN", clueId: "docking.dis.1" }).status).toBe("invalid");
  });

  it("clears pins when the next act starts", () => {
    const state = started();
    expectAccepted(state, holder(state, "Dispatcher"), { type: "DISPATCH_PIN", clueId: "docking.dis.1" });
    commit(state, "open_gate_c");
    advanceTo(state, "ACT_SCAN");
    expect(state.pinned).toEqual([]);
  });
});

describe("coverage score", () => {
  it("counts players who took a meaningful action each act", () => {
    const state = started();
    advanceTo(state, "ACT_RELAY");
    expectAccepted(state, "p1", { type: "CLAIM_CREATE", factId: "gate_c_safe", assertion: true, text: "C safe" });
    commit(state, "open_gate_c"); // operator also participates
    state.nextActId = null;
    advanceTo(state, "RESULTS");
    const expected = new Set(["p1", holder(state, "Operator")]).size * 20;
    expect(state.result?.score.coverage).toBe(expected);
  });
});
