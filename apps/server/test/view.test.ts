import { describe, expect, it } from "vitest";
import { projectView } from "../src/game/view.js";
import { captain, expectAccepted, lobby, playRound, scenario, started } from "./helpers.js";

const round1Clues = scenario.rounds[0]!.clues;

describe("projectView", () => {
  it("shows a lobby without a round, captain or clue", () => {
    const view = projectView(lobby(3), "p2");
    expect(view).toMatchObject({ phase: "LOBBY", round: null, captainId: null, reveal: null, results: null });
    expect(view.me).toEqual({ id: "p2", clue: null });
    expect(view.players.map((p) => p.isHost)).toEqual([true, false, false]);
  });

  it("during ROUND shows the question, answers, captain and only my own clue", () => {
    const state = started();
    const view = projectView(state, "p3");
    expect(view.round).toEqual({
      title: scenario.rounds[0]!.title,
      question: scenario.rounds[0]!.question,
      answers: scenario.rounds[0]!.answers.map(({ id, label }) => ({ id, label })),
    });
    expect(view.captainId).toBe(captain(state));
    expect(round1Clues).toContain(view.me.clue);
    expect(view.reveal).toBeNull();

    const serialised = JSON.stringify(view);
    for (const clue of round1Clues.filter((c) => c !== view.me.clue)) {
      expect(serialised).not.toContain(JSON.stringify(clue).slice(1, -1));
    }
  });

  it("never leaks answer correctness, narration or reconnect tokens during ROUND", () => {
    const serialised = JSON.stringify(projectView(started(), "p1"));
    expect(serialised).not.toContain('"correct"');
    expect(serialised).not.toContain("narration");
    expect(serialised).not.toContain('"token"');
    expect(serialised).not.toContain("t2");
  });

  it("in REVEAL shows the result, narration and everyone's clue with their name", () => {
    const state = started(6);
    expectAccepted(state, captain(state), { type: "PICK_ANSWER", answerId: "gate_a" });
    const view = projectView(state, "p2");
    expect(view.reveal).toMatchObject({
      answerId: "gate_a",
      correctAnswerId: "gate_c",
      correct: false,
      narration: scenario.rounds[0]!.answers[0]!.narration,
    });
    expect(view.reveal!.clues).toHaveLength(6);
    expect(view.reveal!.clues[0]).toEqual({
      playerId: state.seats[0],
      nickname: state.players.find((p) => p.id === state.seats[0])!.nickname,
      text: round1Clues[0],
    });
    expect(new Set(view.reveal!.clues.map((c) => c.text))).toEqual(new Set(round1Clues));
  });

  it("shows the solved count and a result line in RESULTS", () => {
    const state = started();
    playRound(state, true);
    expect(projectView(state, "p1").solved).toBe(1);
    playRound(state, true);
    playRound(state, false);
    const view = projectView(state, "p1");
    expect(view).toMatchObject({ phase: "RESULTS", round: null, captainId: null, reveal: null });
    expect(view.me.clue).toBeNull();
    expect(view.results).toEqual({ solved: 2, total: 3, line: scenario.resultLines[2] });
  });
});
