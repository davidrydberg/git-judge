// Every question readfirst asks TypeSafe's Jev model, grouped by the call it is sent in.
// This file is meant to be read and edited without knowing the rest of the pipeline.
//
// Rules for wording, from the Jev documentation:
// - Jev reads literally. Write the exact condition, not the intent behind it.
// - Ask one judgement per question. Combining answers happens in policy.ts, never here.
// - Never ask for counting, arithmetic, or date comparison.
//
// A "noul" is a yes/no question and returns the probability of yes.
// A "choice" picks one option and returns a probability per option.
// A "score" rates along ordered levels, lowest first.

import type { Questions } from "@typesafe-ai/sdk";

/**
 * Call A: the state is one hunk of code and its file path.
 * The PR description is never part of this call, so it cannot talk the model out of a gate.
 */
export const CODE_QUESTIONS = {
  secret_semantic: {
    type: "noul",
    instructions:
      "The added lines contain a credential, key, or token, or instructions for obtaining one.",
  },
  destructive_data: {
    type: "noul",
    instructions:
      "This change deletes, renames, or truncates a database table or column, or rewrites existing stored data.",
  },
  mechanical: {
    type: "noul",
    instructions:
      "This chunk is a mechanical change: rename, import reorder, formatting, generated code, lockfile, or version bump.",
  },
  refactor_changes_behaviour: {
    type: "noul",
    instructions:
      "The change alters what the program does for some input, not only how the code is organised.",
  },
  test_loosened: {
    type: "noul",
    instructions:
      "This change makes a test pass by weakening or removing an assertion rather than by fixing the code under test.",
  },
  safety_check_weakened: {
    type: "noul",
    instructions:
      "This change removes or weakens validation, error handling, a permission check, or a limit.",
  },
  comment_drift: {
    type: "noul",
    instructions:
      "A comment or docstring in this chunk no longer matches what the code beside it does.",
  },
  change_type: {
    type: "choice",
    instructions: "What kind of change is this?",
    criteria: {
      feature: null,
      bugfix: null,
      refactor: null,
      test: null,
      docs: null,
      chore: null,
    },
  },
  sensitive_area: {
    type: "choice",
    instructions: "Which area does this chunk touch?",
    criteria: {
      auth: null,
      payments: null,
      data_migration: null,
      public_api: null,
      none: null,
    },
  },
  blast_radius: {
    type: "choice",
    instructions: "Who could notice if this change is wrong?",
    criteria: {
      nobody: null,
      "other developers": null,
      "end users": null,
      "money or data": null,
    },
  },
} as const satisfies Questions;

/** Call B: the state is one hunk plus the PR title and description. */
export const MISMATCH_QUESTIONS = {
  unrelated_to_description: {
    type: "noul",
    instructions: "This chunk contains changes the PR description does not mention.",
  },
} as const satisfies Questions;

/** Call C: once per PR. The state is the title, the description, and the list of changed files. */
export const PR_QUESTIONS = {
  description_quality: {
    type: "score",
    instructions: "Rate the PR description.",
    criteria: ["generic", "names the area", "states what changed and why"],
  },
  tests_cover_change: {
    type: "noul",
    instructions: "The changed files include tests that plausibly cover the described change.",
  },
} as const satisfies Questions;

/** The only questions that can fail the check. Custom questions from the policy file can never be added here. */
export const GATES = ["secret_semantic", "destructive_data"] as const;

export type GateId = (typeof GATES)[number];
