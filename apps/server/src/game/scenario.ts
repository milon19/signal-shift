import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ROLES } from "@signal-shift/shared";

const clueSchema = z.object({ id: z.string().min(1), text: z.string().min(1) });

const outcomeFields = {
  stabilityDelta: z.number().int(),
  narration: z.string(),
  /** Next act id, or null when this is the final act. */
  next: z.string().nullable(),
};

const actSchema = z.object({
  title: z.string(),
  briefing: z.string(),
  facts: z.array(z.object({ id: z.string().min(1), prompt: z.string(), truth: z.boolean() })).min(1),
  clues: z.object(
    Object.fromEntries(ROLES.map((r) => [r, z.array(clueSchema).min(1)])) as Record<
      (typeof ROLES)[number],
      z.ZodArray<typeof clueSchema>
    >,
  ),
  actions: z
    .array(
      z.object({ id: z.string().min(1), label: z.string(), correct: z.boolean(), ...outcomeFields }),
    )
    .min(2),
  timeout: z.object(outcomeFields),
});

const durationsSchema = z.object({
  ACT_SCAN: z.number().positive(),
  ACT_RELAY: z.number().positive(),
  ACT_VERIFY: z.number().positive(),
  ACT_COMMIT: z.number().positive(),
  CONSEQUENCE: z.number().positive(),
  HANDOFF: z.number().positive(),
});

export const scenarioSchema = z.object({
  id: z.string(),
  title: z.string(),
  startingStability: z.number().int().positive(),
  startingSync: z.number().int().nonnegative(),
  auditsPerAct: z.number().int().nonnegative(),
  pinsPerAct: z.number().int().nonnegative(),
  phaseDurationsSec: durationsSchema,
  startActId: z.string(),
  acts: z.record(actSchema),
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioAct = Scenario["acts"][string];
export type ScenarioAction = ScenarioAct["actions"][number];
export type TimedPhase = keyof Scenario["phaseDurationsSec"];

/** Standard Shift is always three acts. */
export const STANDARD_SHIFT_ACTS = 3;

/**
 * Parses and checks the structural rules that the schema alone cannot express:
 * every act reference resolves, ids are unique, and every branch is exactly
 * STANDARD_SHIFT_ACTS long.
 */
export function parseScenario(raw: unknown): Scenario {
  const scenario = scenarioSchema.parse(raw);
  const actIds = new Set(Object.keys(scenario.acts));
  if (!actIds.has(scenario.startActId)) {
    throw new Error(`startActId "${scenario.startActId}" does not exist`);
  }

  const clueIds = new Set<string>();
  for (const [actId, act] of Object.entries(scenario.acts)) {
    for (const clue of Object.values(act.clues).flat()) {
      if (clueIds.has(clue.id)) throw new Error(`duplicate clue id "${clue.id}"`);
      clueIds.add(clue.id);
    }
    assertUnique(act.facts.map((f) => f.id), `fact id in act "${actId}"`);
    assertUnique(act.actions.map((a) => a.id), `action id in act "${actId}"`);
    if (!act.actions.some((a) => a.correct)) {
      throw new Error(`act "${actId}" has no correct action`);
    }
    for (const outcome of [...act.actions, act.timeout]) {
      if (outcome.next !== null && !actIds.has(outcome.next)) {
        throw new Error(`act "${actId}" references unknown act "${outcome.next}"`);
      }
    }
  }

  // Every path from the start must last exactly STANDARD_SHIFT_ACTS acts.
  const walk = (actId: string, depth: number): void => {
    const act = scenario.acts[actId]!;
    for (const outcome of [...act.actions, act.timeout]) {
      if (outcome.next === null) {
        if (depth !== STANDARD_SHIFT_ACTS) {
          throw new Error(`branch ending at act "${actId}" has ${depth} acts, expected ${STANDARD_SHIFT_ACTS}`);
        }
      } else {
        if (depth >= STANDARD_SHIFT_ACTS) {
          throw new Error(`branch through act "${actId}" exceeds ${STANDARD_SHIFT_ACTS} acts`);
        }
        walk(outcome.next, depth + 1);
      }
    }
  };
  walk(scenario.startActId, 1);

  return scenario;
}

function assertUnique(ids: string[], what: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`duplicate ${what}`);
}

export function loadScenarioFile(path: string): Scenario {
  return parseScenario(JSON.parse(readFileSync(path, "utf8")));
}

export function loadDefaultScenario(): Scenario {
  return loadScenarioFile(fileURLToPath(new URL("../../scenarios/orbital-hotel.json", import.meta.url)));
}
