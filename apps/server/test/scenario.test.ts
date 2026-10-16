import { describe, expect, it } from "vitest";
import { parseScenario } from "../src/game/scenario.js";
import { scenario } from "./helpers.js";

const clone = () => structuredClone(scenario) as Record<string, any>;

describe("scenario data", () => {
  it("the bundled scenario has 3 rounds of 3 answers and 5 clues, one correct answer each", () => {
    expect(scenario.rounds).toHaveLength(3);
    for (const round of scenario.rounds) {
      expect(round.answers).toHaveLength(3);
      expect(round.clues).toHaveLength(5);
      expect(round.answers.filter((a) => a.correct)).toHaveLength(1);
    }
    expect(scenario.rounds[0]!.answers.find((a) => a.correct)!.label).toBe("Gate C");
  });

  it("rejects the wrong number of rounds", () => {
    const raw = clone();
    raw.rounds.pop();
    expect(() => parseScenario(raw)).toThrow(/Invalid scenario: rounds:/);
  });

  it("rejects the wrong number of answers or clues", () => {
    const answers = clone();
    answers.rounds[1].answers.pop();
    expect(() => parseScenario(answers)).toThrow(/rounds\.1\.answers/);

    const clues = clone();
    clues.rounds[2].clues.push("one too many");
    expect(() => parseScenario(clues)).toThrow(/rounds\.2\.clues/);
  });

  it("rejects rounds without exactly one correct answer", () => {
    const none = clone();
    for (const a of none.rounds[0].answers) a.correct = false;
    expect(() => parseScenario(none)).toThrow(/round "shuttle" must have exactly one correct answer \(has 0\)/);

    const two = clone();
    two.rounds[0].answers[0].correct = true;
    expect(() => parseScenario(two)).toThrow(/has 2/);
  });

  it("rejects duplicate answer and round ids", () => {
    const answers = clone();
    answers.rounds[0].answers[1].id = answers.rounds[0].answers[0].id;
    expect(() => parseScenario(answers)).toThrow(/duplicate answer id/);

    const rounds = clone();
    rounds.rounds[1].id = rounds.rounds[0].id;
    expect(() => parseScenario(rounds)).toThrow(/duplicate round id/);
  });

  it("rejects missing fields and a wrong number of result lines", () => {
    const raw = clone();
    delete raw.rounds[0].timeout;
    expect(() => parseScenario(raw)).toThrow(/rounds\.0\.timeout/);

    const lines = clone();
    lines.resultLines.pop();
    expect(() => parseScenario(lines)).toThrow(/resultLines/);
    expect(() => parseScenario(null)).toThrow(/Invalid scenario/);
  });
});
