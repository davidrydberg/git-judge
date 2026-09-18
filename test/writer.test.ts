import { describe, expect, test } from "vitest";
import type { Hunk } from "../src/diff.js";
import { parsePolicy, type Flag } from "../src/policy.js";
import { write, type GenerateRequest, type Generator, type WriterInput } from "../src/writer.js";

type Reply = { confirmed: boolean; severity?: "low" | "medium" | "high" };

/** Answers a verdict request by looking up the hunk's file in `replies`. Records every request. */
function fakeGenerator(model: string, replies: Record<string, Reply> = {}) {
  const requests: GenerateRequest<unknown>[] = [];
  const generator: Generator = {
    model,
    async generate(request) {
      requests.push(request);
      if (request.schemaName === "tldr") {
        return { value: request.schema.parse({ tldr: "Drops the expiry check." }), inputTokens: 50, outputTokens: 10 };
      }
      const file = /^File: (.*)$/m.exec(request.prompt)![1]!;
      const reply = replies[file] ?? { confirmed: true };
      const value = request.schema.parse({
        confirmed: reply.confirmed,
        severity: reply.severity ?? "medium",
        what_changed: `Changed ${file}.`,
        what_to_verify: `Verify ${file}.`,
      });
      return { value, inputTokens: 100, outputTokens: 20 };
    },
  };
  return { generator, requests };
}

function hunk(path: string, content = `@@ -1 +1 @@\n-old ${path}\n+new ${path}`): Hunk {
  return {
    id: `${path}#0`,
    path,
    language: "TypeScript",
    isTest: false,
    startLine: 1,
    endLine: 1,
    added: 1,
    deleted: 1,
    size: 2,
    preClass: null,
    anchor: { line: 1, side: "RIGHT" },
    content,
    hash: path,
  };
}

function flag(path: string, id: Flag["id"], overrides: Partial<Flag> = {}): Flag {
  const kind = id === "secret_semantic" || id === "destructive_data" ? "gate" : "warning";
  return { hunkId: `${path}#0`, id, kind, probability: 0.8, escalate: false, ...overrides };
}

function input(flags: Flag[], generator: Generator, overrides: Partial<WriterInput> = {}): WriterInput {
  const paths = [...new Set(flags.map((entry) => entry.hunkId.replace(/#0$/, "")))];
  return {
    flags,
    hunks: [...paths.map((path) => hunk(path)), hunk("src/unflagged.ts", "@@ -1 +1 @@\n+UNFLAGGED_MARKER")],
    title: "Refactor session handling",
    description: "Pure refactor, no behaviour change.",
    policy: parsePolicy(""),
    generator,
    ...overrides,
  };
}

describe("verdicts", () => {
  test("a confirmed flag becomes a verdict with both sentences", async () => {
    const { generator } = fakeGenerator("gpt-5.6-luna", { "src/auth.ts": { confirmed: true, severity: "high" } });
    const { verdicts } = await write(input([flag("src/auth.ts", "safety_check_weakened")], generator));

    expect(verdicts).toEqual([
      {
        hunkId: "src/auth.ts#0",
        flagId: "safety_check_weakened",
        kind: "warning",
        probability: 0.8,
        confirmed: true,
        severity: "high",
        whatChanged: "Changed src/auth.ts.",
        whatToVerify: "Verify src/auth.ts.",
        model: "gpt-5.6-luna",
      },
    ]);
  });

  test("a rejected warning is dropped entirely", async () => {
    const { generator } = fakeGenerator("gpt-5.6-luna", { "src/noise.ts": { confirmed: false } });
    const flags = [flag("src/auth.ts", "safety_check_weakened"), flag("src/noise.ts", "comment_drift")];
    const { verdicts } = await write(input(flags, generator));

    expect(verdicts.map((verdict) => verdict.hunkId)).toEqual(["src/auth.ts#0"]);
  });

  test("a rejected gate is kept, marked as not confirmed", async () => {
    const { generator } = fakeGenerator("gpt-5.6-luna", { "db/migrate.sql": { confirmed: false } });
    const { verdicts } = await write(input([flag("db/migrate.sql", "destructive_data")], generator));

    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]).toMatchObject({ kind: "gate", confirmed: false });
  });

  test("a suspected secret is never sent to the generator", async () => {
    const { generator, requests } = fakeGenerator("gpt-5.6-luna");
    const { verdicts, tldr } = await write(input([flag("config/prod.ts", "secret_semantic")], generator));

    expect(verdicts[0]).toMatchObject({ flagId: "secret_semantic", confirmed: true, severity: "high", model: null });
    expect(requests.filter((request) => request.schemaName === "verdict")).toEqual([]);
    expect(requests.some((request) => request.prompt.includes("new config/prod.ts"))).toBe(false);
    expect(tldr).not.toBeNull();
  });
});

describe("what the generator is shown", () => {
  test("one request per flag, holding that flag's claim and hunk and nothing else", async () => {
    const { generator, requests } = fakeGenerator("gpt-5.6-luna");
    const flags = [flag("src/auth.ts", "safety_check_weakened"), flag("test/auth.test.ts", "test_loosened")];
    await write(input(flags, generator));

    const verdictRequests = requests.filter((request) => request.schemaName === "verdict");
    expect(verdictRequests).toHaveLength(2);
    const [first] = verdictRequests;
    expect(first!.prompt).toContain("removes or weakens validation");
    expect(first!.prompt).toContain("new src/auth.ts");
    expect(first!.prompt).toContain("Pure refactor, no behaviour change.");
    expect(first!.prompt).not.toContain("weakening or removing an assertion");
    expect(first!.prompt).not.toContain("test/auth.test.ts");
    expect(first!.prompt).not.toContain("UNFLAGGED_MARKER");
  });

  test.each<[Flag["id"], string]>([
    ["refactor_changes_behaviour", "presents itself as a refactor"],
    ["unrelated_to_description", "the PR description does not mention"],
    ["custom:invoicing", "This chunk touches invoicing."],
  ])("the claim for %s", async (id, expected) => {
    const { generator, requests } = fakeGenerator("gpt-5.6-luna");
    const policy = parsePolicy("customQuestions:\n  - id: invoicing\n    question: This chunk touches invoicing.");
    await write(input([flag("src/a.ts", id)], generator, { policy }));

    expect(requests[0]!.prompt).toContain(expected);
  });

  test("the output shape has one slot, with no room for extra findings", async () => {
    const { generator, requests } = fakeGenerator("gpt-5.6-luna");
    await write(input([flag("src/a.ts", "comment_drift")], generator));

    const shape = (requests[0]!.schema as unknown as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape)).toEqual(["confirmed", "severity", "what_changed", "what_to_verify"]);
  });

  test("the TL;DR call gets the title and confirmed verdicts, never the diff or rejected flags", async () => {
    const { generator, requests } = fakeGenerator("gpt-5.6-luna", { "src/noise.ts": { confirmed: false } });
    const flags = [flag("src/auth.ts", "safety_check_weakened"), flag("src/noise.ts", "comment_drift")];
    const { tldr } = await write(input(flags, generator));

    const tldrRequest = requests.find((request) => request.schemaName === "tldr")!;
    expect(tldr).toBe("Drops the expiry check.");
    expect(tldrRequest.prompt).toContain("Refactor session handling");
    expect(tldrRequest.prompt).toContain("Changed src/auth.ts.");
    expect(tldrRequest.prompt).not.toContain("src/noise.ts");
    expect(tldrRequest.prompt).not.toContain("+new");
    expect(tldrRequest.prompt).not.toContain("<diff>");
  });

  test("nothing confirmed means no TL;DR call", async () => {
    const { generator, requests } = fakeGenerator("gpt-5.6-luna", { "src/noise.ts": { confirmed: false } });
    const none = await write(input([], generator));
    const rejected = await write(input([flag("src/noise.ts", "comment_drift")], generator));

    expect(none.tldr).toBeNull();
    expect(rejected.tldr).toBeNull();
    expect(requests.some((request) => request.schemaName === "tldr")).toBe(false);
  });
});

describe("escalation", () => {
  test("an escalated flag goes to the escalation model, the rest and the TL;DR to the default", async () => {
    const standard = fakeGenerator("gpt-5.6-luna");
    const strong = fakeGenerator("claude-opus-5");
    const flags = [
      flag("src/auth.ts", "safety_check_weakened", { escalate: true }),
      flag("src/util.ts", "comment_drift"),
    ];
    const result = await write(input(flags, standard.generator, { escalationGenerator: strong.generator }));

    expect(result.verdicts.map((verdict) => verdict.model)).toEqual(["claude-opus-5", "gpt-5.6-luna"]);
    expect(strong.requests).toHaveLength(1);
    expect(standard.requests.map((request) => request.schemaName)).toEqual(["verdict", "tldr"]);
    expect(result.usage).toEqual({
      "claude-opus-5": { requests: 1, inputTokens: 100, outputTokens: 20 },
      "gpt-5.6-luna": { requests: 2, inputTokens: 150, outputTokens: 30 },
    });
  });

  test("an escalated flag without an escalation generator is an error", async () => {
    const { generator } = fakeGenerator("gpt-5.6-luna");
    const flags = [flag("src/auth.ts", "safety_check_weakened", { escalate: true })];

    await expect(write(input(flags, generator))).rejects.toThrow(/no escalation generator/);
  });
});

describe("failure", () => {
  test("a failing generator fails the whole write", async () => {
    const generator: Generator = {
      model: "gpt-5.6-luna",
      generate: async () => {
        throw new Error("OpenAI unreachable");
      },
    };
    await expect(write(input([flag("src/a.ts", "comment_drift")], generator))).rejects.toThrow("OpenAI unreachable");
  });
});
