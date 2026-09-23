import { describe, it, expect, vi } from "vitest";
import { runWithSyncRecord } from "@/db/sync-runs";
import type { NewSyncRun } from "@/db/schema";

const AT = new Date("2026-09-23T13:30:00Z");
const clock = () => AT;

function recorder() {
  const rows: NewSyncRun[] = [];
  return { rows, record: vi.fn(async (row: NewSyncRun) => { rows.push(row); }) };
}

describe("runWithSyncRecord", () => {
  it("records a successful run as ok", async () => {
    const r = recorder();
    await runWithSyncRecord("sync:social", clock, r.record, async () => ({
      configured: true, rowsWritten: 20,
    }));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ task: "sync:social", outcome: "ok", rowsWritten: 20 });
  });

  // Zero rows from a configured task is a real answer, not a fault.
  it("records a configured run that found nothing as no-data", async () => {
    const r = recorder();
    await runWithSyncRecord("sync:gsc", clock, r.record, async () => ({
      configured: true, rowsWritten: 0,
    }));
    expect(r.rows[0].outcome).toBe("no-data");
  });

  // The failure this wrapper exists for: a task that returns early on missing
  // credentials wrote no record at all, so a sync that never ran looked
  // exactly like a table nobody had updated.
  it("records a skipped run as not-configured, rather than nothing", async () => {
    const r = recorder();
    await runWithSyncRecord("sync:seal", clock, r.record, async () => ({
      configured: false, rowsWritten: 0,
    }));
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].outcome).toBe("not-configured");
  });

  it("records a throw as an error outcome", async () => {
    const r = recorder();
    await expect(
      runWithSyncRecord("sync:shopify", clock, r.record, async () => {
        throw new Error("connection reset");
      }),
    ).rejects.toThrow("connection reset");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ outcome: "api-error", errorMessage: "connection reset" });
  });

  // Swallowing it here would trade one silent failure for another.
  it("rethrows after recording, so the scheduler still sees the failure", async () => {
    const r = recorder();
    const boom = new Error("boom");
    await expect(
      runWithSyncRecord("sync:kb", clock, r.record, async () => { throw boom; }),
    ).rejects.toBe(boom);
    expect(r.record).toHaveBeenCalledOnce();
  });

  it("records exactly once on every path", async () => {
    for (const run of [
      async () => ({ configured: true, rowsWritten: 5 }),
      async () => ({ configured: false, rowsWritten: 0 }),
    ]) {
      const r = recorder();
      await runWithSyncRecord("t", clock, r.record, run);
      expect(r.record).toHaveBeenCalledOnce();
    }
  });

  // A partial failure on an otherwise successful run would otherwise vanish.
  it("keeps an error message passed alongside a successful run", async () => {
    const r = recorder();
    await runWithSyncRecord("sync:social", clock, r.record, async () => ({
      configured: true, rowsWritten: 18, errorMessage: "2 insights unavailable",
    }));
    expect(r.rows[0]).toMatchObject({ outcome: "ok", errorMessage: "2 insights unavailable" });
  });

  it("stamps both ends of the run from the injected clock", async () => {
    const r = recorder();
    await runWithSyncRecord("t", clock, r.record, async () => ({ configured: true, rowsWritten: 1 }));
    expect(r.rows[0].startedAt).toEqual(AT);
    expect(r.rows[0].finishedAt).toEqual(AT);
  });

  it("returns the task's own result to the caller", async () => {
    const r = recorder();
    const out = await runWithSyncRecord("t", clock, r.record, async () => ({
      configured: true, rowsWritten: 7,
    }));
    expect(out.rowsWritten).toBe(7);
  });
});
