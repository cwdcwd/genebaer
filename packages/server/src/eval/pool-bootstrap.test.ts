import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from "@genebaer/core";
import { createServerRegistry } from "../registry.js";
import { poolCapabilities, startupReport, threadsFromEnv } from "./pool-bootstrap.js";

describe("how many threads to start", () => {
  it("starts none unless asked", () => {
    // Off by default on purpose: threads that cannot load a model would
    // replace a missing worker with a failing one.
    expect(threadsFromEnv({})).toBe(0);
    expect(threadsFromEnv({ GENEBAER_WORKER_THREADS: "" })).toBe(0);
    expect(threadsFromEnv({ GENEBAER_WORKER_THREADS: "0" })).toBe(0);
  });

  it("reads a count", () => {
    expect(threadsFromEnv({ GENEBAER_WORKER_THREADS: "4" })).toBe(4);
  });

  it("rejects nonsense instead of silently starting none", () => {
    // Falling back to 0 would look identical to not setting it, so an operator
    // who typed the value wrong would never find out.
    expect(() => threadsFromEnv({ GENEBAER_WORKER_THREADS: "two" })).toThrow(
      /non-negative integer/,
    );
    expect(() => threadsFromEnv({ GENEBAER_WORKER_THREADS: "-1" })).toThrow();
    expect(() => threadsFromEnv({ GENEBAER_WORKER_THREADS: "2.5" })).toThrow();
  });
});

describe("what the pool advertises", () => {
  it("takes its contracts from the registry, not a hardcoded list", () => {
    // Registering another queued evaluator must extend what threads can claim
    // without anyone editing the bootstrap.
    const caps = poolCapabilities(createServerRegistry());
    expect(caps.map((c) => c.evaluatorId)).toContain("clip-similarity");
  });

  it("advertises the version too, since scores across versions differ", () => {
    const clip = poolCapabilities(createServerRegistry()).find(
      (c) => c.evaluatorId === "clip-similarity",
    );
    expect(clip?.version).toBeTruthy();
  });

  it("ignores evaluators that score in-process", () => {
    // 'local' never claims from the queue; advertising it would have threads
    // competing for jobs that are never queued.
    const caps = poolCapabilities(createServerRegistry());
    expect(caps.map((c) => c.evaluatorId)).not.toContain("local");
    expect(poolCapabilities(createDefaultRegistry())).toEqual([]);
  });
});

describe("telling the operator what they actually got", () => {
  const caps = [{ evaluatorId: "clip-similarity", version: "v1" }];

  it("names the missing dependency rather than failing job by job", () => {
    // Without this, a missing optional install looks like every run being
    // broken instead of one command to run.
    const msg = startupReport(4, caps, false);
    expect(msg).toMatch(/NOT installed/);
    expect(msg).toMatch(/@huggingface\/transformers/);
    // And says what to do instead, since a browser worker still works.
    expect(msg).toMatch(/browser worker/);
  });

  it("confirms what is serving what when it is all present", () => {
    const msg = startupReport(4, caps, true);
    expect(msg).toMatch(/4 thread/);
    expect(msg).toMatch(/clip-similarity@v1/);
    expect(msg).not.toMatch(/NOT installed/);
  });

  it("says so when threads were asked for but nothing can use them", () => {
    // Silently starting idle threads would look like a working pool.
    expect(startupReport(4, [], true)).toMatch(/no queued evaluators are registered/);
  });
});
