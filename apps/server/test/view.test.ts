import { describe, expect, it } from "vitest";
import { projectView } from "../src/game/view.js";
import { advanceTo, commit, expectAccepted, holder, lobby, started } from "./helpers.js";

describe("projectView", () => {
  it("shows a lobby without roles or clues", () => {
    const view = projectView(lobby(3), "p2");
    expect(view.phase).toBe("LOBBY");
    expect(view.act).toBeNull();
    expect(view.me).toMatchObject({ id: "p2", role: null, clues: [] });
    expect(view.players.map((p) => p.isHost)).toEqual([true, false, false]);
  });

  it("gives each player only their own role's clues", () => {
    const state = started();
    const nav = holder(state, "Navigator");
    const view = projectView(state, nav);
    expect(view.me.role).toBe("Navigator");
    expect(view.me.clues.map((c) => c.id)).toEqual(["docking.nav.1", "docking.nav.2"]);
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain("docking.dec.");
    expect(serialised).not.toContain("docking.dis.");
  });

  it("never leaks fact truths, action correctness or reconnect tokens", () => {
    const state = started();
    const serialised = JSON.stringify(projectView(state, "p1"));
    expect(serialised).not.toContain('"truth"');
    expect(serialised).not.toContain('"correct":true');
    expect(serialised).not.toContain('"token"');
    expect(serialised).not.toContain("t2");
  });

  it("shows audit and pin budgets only to the role that owns them", () => {
    const state = started();
    expect(projectView(state, holder(state, "Auditor")).me.auditsRemaining).toBe(2);
    expect(projectView(state, holder(state, "Navigator")).me.auditsRemaining).toBe(0);
    const dispatcher = holder(state, "Dispatcher");
    expectAccepted(state, dispatcher, { type: "DISPATCH_PIN", clueId: "docking.dis.1" });
    expect(projectView(state, dispatcher).me.pinsRemaining).toBe(0);
    expect(projectView(state, "p1").pinned).toHaveLength(1);
  });

  it("hides clues during handoff", () => {
    const state = started();
    commit(state, "open_gate_c");
    advanceTo(state, "HANDOFF");
    expect(projectView(state, "p1").me.clues).toEqual([]);
  });
});
