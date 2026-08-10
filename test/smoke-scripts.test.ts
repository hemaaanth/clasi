import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runHostSmoke } from "../scripts/smoke-host.ts";
import {
  IsolationError,
  ISOLATED_ENV_KEYS,
  assertPathInsideRoot,
  cleanupIsolatedRoots,
  createIsolatedRoots,
  runCheckedProcess,
} from "../scripts/isolation.ts";
import type { IsolatedRoots, ProcessAdapter } from "../scripts/isolation.ts";
import {
  assertCapturedModelRequests,
  inspectDoctorOutput,
  parseOmpVersion,
  resolveMatrixRow,
  startOpenAIStub,
} from "../scripts/smoke-omp.ts";

const MANIFEST = {
  name: "clasi",
  version: "0.1.0",
  bin: { clasi: "./bin/clasi.ts" },
  omp: { extensions: ["./src/index.ts"] },
  peerDependencies: { "@oh-my-pi/pi-coding-agent": ">=17.2.4 <18" },
};
const SKILL = [
  "clasi provides three distinct kinds of quiet, scoped memory:",
  "Never send clasi raw prompts",
  "Routine capture and loading are silent.",
].join("\n");

function modelRequest(content: string) {
  return { model: "smoke-model", messages: [{ role: "system", content }] };
}

describe("public smoke scripts", () => {
  test("registers the exact provider-free host surface", async () => {
    expect(await runHostSmoke()).toEqual({
      checks: ["exact_extension_registration", "bounded_context_injection", "provider_free"],
    });
  });

  test("isolates roots, leaves the data root for secure setup, and refuses unissued cleanup", async () => {
    const parent = await mkdtemp(join(tmpdir(), "clasi-smoke-test-parent-"));
    try {
      const roots = await createIsolatedRoots({ parent, prefix: "case-" });
      for (const key of ISOLATED_ENV_KEYS) {
        expect(assertPathInsideRoot(roots.root, roots.environment[key]))
          .toBe(resolve(roots.environment[key]));
      }
      await expect(access(roots.clasiHome)).rejects.toThrow();
      expect(() => assertPathInsideRoot(roots.root, resolve(roots.root, "..", "outside")))
        .toThrow(new IsolationError("path-escape"));
      const outside = join(parent, "must-survive");
      await writeFile(outside, "keep", { flag: "wx" });
      await expect(cleanupIsolatedRoots({ ...roots, root: outside } as IsolatedRoots))
        .rejects.toEqual(new IsolationError("unissued-root"));
      await access(outside);
      const removed = roots.root;
      await cleanupIsolatedRoots(roots);
      await expect(access(removed)).rejects.toThrow();
      await access(outside);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test("passes argv directly through a bounded fake process", async () => {
    const calls: unknown[] = [];
    const adapter: ProcessAdapter = async request => {
      calls.push(request);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const request = {
      command: "git",
      args: ["config", "value;not-a-shell"],
      cwd: resolve("."),
      timeoutMs: 100,
      maxOutputBytes: 16,
    } as const;
    expect(await runCheckedProcess(adapter, request)).toEqual({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    });
    expect(calls).toEqual([request]);
    await expect(runCheckedProcess(async () => ({
      exitCode: 0,
      stdout: "x".repeat(17),
      stderr: "",
    }), request)).rejects.toEqual(new IsolationError("process-output-limit"));
    await expect(runCheckedProcess(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "private failure text",
    }), { ...request, maxOutputBytes: 64 })).rejects.toEqual(new IsolationError("process-failed"));
  });

  test("accepts exact clasi diagnostics without retaining raw text", () => {
    const raw = "ghp_0123456789abcdefghijklmnopqrstuvwxyz /private/source/path";
    const doctor = JSON.stringify([
      { name: "plugins_directory", status: "ok", message: raw },
      { name: "package_manifest", status: "ok", message: raw },
      { name: "node_modules", status: "ok", message: raw },
      { name: "plugin:clasi", status: "ok", message: raw },
    ]);
    const diagnostics = inspectDoctorOutput(doctor, MANIFEST);
    expect(diagnostics).toEqual([
      { name: "plugin:clasi", result: "passed" },
      { name: "plugin:clasi:manifest", result: "passed" },
      { name: "plugin:clasi:extension:./src/index.ts", result: "passed" },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain(raw);
    expect(JSON.stringify(diagnostics)).not.toContain("/private/source/path");
    expect(() => inspectDoctorOutput(JSON.stringify([
      { name: "plugin:clasi", status: "ok", message: "ok", extra: true },
    ]), MANIFEST)).toThrow(new IsolationError("doctor-shape-invalid"));
    expect(() => inspectDoctorOutput(JSON.stringify([
      { name: "plugin:clasi", status: "ok", message: "ok" },
      { name: "plugin:clasi:extension:./src/index.ts", status: "error", message: "missing" },
    ]), MANIFEST)).toThrow(new IsolationError("clasi-doctor-failed"));
  });

  test("requires skill guidance and exactly one clasi block per request", () => {
    const requests = [
      modelRequest("# clasi context\nfirst"),
      modelRequest(`# clasi context\nsecond\n${SKILL}`),
    ];
    expect(() => assertCapturedModelRequests(requests, SKILL)).not.toThrow();
    expect(() => assertCapturedModelRequests([
      requests[0],
      modelRequest(`# clasi context\n# clasi context\n${SKILL}`),
    ], SKILL)).toThrow(new IsolationError("clasi-context-count-invalid"));
    expect(() => assertCapturedModelRequests([
      requests[0],
      modelRequest("# clasi context\nmissing skill"),
    ], SKILL)).toThrow(new IsolationError("bundled-skill-missing"));
  });

  test("keeps loopback requests in memory and rejects unexpected routes", async () => {
    const stub = startOpenAIStub();
    try {
      const response = await fetch(`${stub.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "smoke-model", messages: [] }),
      });
      expect(response.status).toBe(200);
      expect(stub.requests).toHaveLength(1);
      stub.clear();
      expect(stub.requests).toHaveLength(0);
    } finally {
      stub.stop();
    }

    const rejecting = startOpenAIStub();
    try {
      const response = await fetch(rejecting.baseUrl.replace(/\/v1$/, "/outside"));
      expect(response.status).toBe(400);
      expect(rejecting.unexpectedRequest).toBeTrue();
      expect(rejecting.requests).toHaveLength(0);
    } finally {
      rejecting.stop();
    }
  });

  test("parses exact OMP versions and fails closed on matrix mismatches", () => {
    expect(parseOmpVersion("omp/17.2.4\n")).toBe("17.2.4");
    expect(resolveMatrixRow("17.2.4", undefined)).toBe("minimum");
    expect(resolveMatrixRow("17.9.0", "latest_17")).toBe("latest_17");
    expect(() => parseOmpVersion("17.2.4\n"))
      .toThrow(new IsolationError("omp-version-invalid"));
    expect(() => resolveMatrixRow("17.2.4", "latest_17"))
      .toThrow(new IsolationError("omp-matrix-row-mismatch"));
  });
});
