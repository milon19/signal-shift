import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/** A game is always three rounds. */
export const ROUNDS_PER_GAME = 3;
export const ANSWERS_PER_ROUND = 3;
export const CLUES_PER_ROUND = 5;

const answerSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  correct: z.boolean(),
  narration: z.string().min(1),
});

const roundSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  question: z.string().min(1),
  answers: z.array(answerSchema).length(ANSWERS_PER_ROUND),
  clues: z.array(z.string().min(1)).length(CLUES_PER_ROUND),
  timeout: z.string().min(1),
});

export const scenarioSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  roundSeconds: z.number().positive(),
  revealSeconds: z.number().positive(),
  /** resultLines[n] is shown when the team solved n rounds. */
  resultLines: z.array(z.string().min(1)).length(ROUNDS_PER_GAME + 1),
  rounds: z.array(roundSchema).length(ROUNDS_PER_GAME),
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type ScenarioRound = Scenario["rounds"][number];

/** Parses scenario JSON, throwing a readable error naming the offending field. */
export function parseScenario(raw: unknown): Scenario {
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new Error(`Invalid scenario: ${issues.join("; ")}`);
  }
  const scenario = parsed.data;
  assertUnique(scenario.rounds.map((r) => r.id), "round id");
  for (const round of scenario.rounds) {
    assertUnique(round.answers.map((a) => a.id), `answer id in round "${round.id}"`);
    const correct = round.answers.filter((a) => a.correct).length;
    if (correct !== 1) {
      throw new Error(`Invalid scenario: round "${round.id}" must have exactly one correct answer (has ${correct})`);
    }
  }
  return scenario;
}

function assertUnique(ids: string[], what: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`Invalid scenario: duplicate ${what}`);
}

export function loadScenarioFile(path: string): Scenario {
  return parseScenario(JSON.parse(readFileSync(path, "utf8")));
}

export function loadDefaultScenario(): Scenario {
  return loadScenarioFile(fileURLToPath(new URL("../../scenarios/orbital-hotel.json", import.meta.url)));
}
