/**
 * The Drive invoice sync at its call sites. The folder logic is covered in
 * tests/domain/economics/invoice-folder-sync.test.ts and would pass forever
 * with nothing calling it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getPhase1Tasks, getTaskHandlerMap } from "@/worker/tasks/registry";
import { routeCommand } from "@/worker/slack/router";
import { FRESHNESS_SOURCES } from "@/db/freshness";

const worker = readFileSync(join(process.cwd(), "src/worker/index.ts"), "utf-8");

describe("sync:invoices wiring", () => {
  it("runs the folder sync through Drive, recorded as sync:invoices", () => {
    const shared = worker.match(/const runInvoiceSync = async[\s\S]*?\n  \};/);
    expect(shared, "no runInvoiceSync").not.toBeNull();
    expect(shared![0]).toMatch(/recorded\("sync:invoices"/);
    expect(shared![0]).toMatch(/syncInvoiceFolder\(\{/);
    expect(shared![0]).toMatch(/listFolder: \(\) => drive\.listFolder\(invoiceFolderId\)/);
  });

  it("is called by the scheduled handler and by the Slack command", () => {
    expect(worker).toMatch(/"sync:invoices": async \(\) => \{\s*await runInvoiceSync\(\);/);
    expect(worker).toMatch(/"sync:invoices": async \(\) => \{\s*let result[\s\S]*?await runInvoiceSync\(\)/);
  });

  it("is scheduled daily and mapped to its handler", () => {
    const task = getPhase1Tasks().find((t) => t.id === "invoices-sync");
    expect(task?.enabled).toBe(true);
    expect(task?.schedule.type).toBe("daily");
    expect(getTaskHandlerMap()["invoices-sync"]).toBe("sync:invoices");
  });

  it("answers !sync invoices", () => {
    expect(routeCommand({ type: "command", category: "sync", action: "invoices", args: "", raw: "!sync invoices" }).handler).toBe("sync:invoices");
  });

  // An import that stopped running must show, not leave margins on old averages.
  it("is the run data_freshness reads for the invoices", () => {
    const source = FRESHNESS_SOURCES.find((s) => s.name === "fulfilment_invoices");
    expect(source && "task" in source ? source.task : null).toBe("sync:invoices");
  });
});
