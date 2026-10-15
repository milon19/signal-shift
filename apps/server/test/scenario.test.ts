import { describe, expect, it } from "vitest";
import { parseScenario } from "../src/game/scenario.js";
import { scenario } from "./helpers.js";

const clone = () => structuredClone(scenario) as Record<string, any>;

describe("scenario data", () => {
  it("the bundled scenario is valid", () => {
    expect(Object.keys(scenario.acts)).toHaveLength(4);
  });

  it("rejects references to unknown acts", () => {
    const raw = clone();
    raw.acts.docking.actions[0].next = "nowhere";
    expect(() => parseScenario(raw)).toThrow(/unknown act "nowhere"/);
  });

  it("rejects branches that are not exactly three acts", () => {
    const raw = clone();
    raw.acts.power.actions[0].next = null;
    expect(() => parseScenario(raw)).toThrow(/expected 3/);
  });

  it("rejects acts missing clues for a role", () => {
    const raw = clone();
    raw.acts.docking.clues.Auditor = [];
    expect(() => parseScenario(raw)).toThrow();
  });

  it("rejects duplicate clue ids", () => {
    const raw = clone();
    raw.acts.power.clues.Navigator[0].id = "docking.nav.1";
    expect(() => parseScenario(raw)).toThrow(/duplicate clue id/);
  });

  it("rejects acts with no correct action", () => {
    const raw = clone();
    for (const a of raw.acts.docking.actions) a.correct = false;
    expect(() => parseScenario(raw)).toThrow(/no correct action/);
  });
});
