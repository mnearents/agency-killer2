import { describe, it, expect, vi } from "vitest";
import { syncShipHero, syncWindows, dailyShipHeroRange, backfillShipHeroRange, SHIPHERO_HISTORY_START } from "@/domain/economics/shiphero-sync";
import { createMockShipHeroClient } from "../../mocks/shiphero-api";
import { fakeDb } from "../../mocks/recording-db";
import { ShipHeroError } from "@/integrations/shiphero-api";
import type { RawShipment } from "@/domain/economics/shiphero-transform";

const NOW = new Date("2026-11-13T15:45:00Z");
const ship = (id: string, status = "valid"): RawShipment => ({
  id, legacy_id: 1, created_date: "2026-11-09T18:32:28", total_packages: 1, refunded: false,
  order: { order_number: `RH${id}`, partner_order_id: "190", shipping_lines: { price: "0.00" } },
  shipping_labels: [{ id: `L${id}`, cost: "8.25", status, dimensions: { weight: "1 lb" } }],
});

describe("syncWindows", () => {
  it("walks a range in windows of at most 7 days whose ends do not overlap", () => {
    const w = syncWindows(new Date("2026-11-01T00:00:00Z"), new Date("2026-11-16T12:00:00Z"));
    expect(w.map((x) => [x.from.toISOString(), x.to.toISOString()])).toEqual([
      ["2026-11-01T00:00:00.000Z", "2026-11-07T23:59:59.000Z"],
      ["2026-11-08T00:00:00.000Z", "2026-11-14T23:59:59.000Z"],
      ["2026-11-15T00:00:00.000Z", "2026-11-16T12:00:00.000Z"],
    ]);
    for (const x of w) expect(x.to.getTime() - x.from.getTime()).toBeLessThan(7 * 86_400_000);
  });
});

describe("ranges", () => {
  it("re-reads the last 7 days daily, so late labels, voids and refunds are picked up", () => {
    const r = dailyShipHeroRange(NOW);
    expect(r.from.toISOString()).toBe("2026-11-06T00:00:00.000Z");
    expect(r.to).toEqual(NOW);
  });

  it("backfills from where the Shopify orders begin", () => {
    expect(SHIPHERO_HISTORY_START).toBe("2025-07-22");
    expect(backfillShipHeroRange(NOW).from.toISOString()).toBe("2025-07-22T00:00:00.000Z");
  });
});

describe("syncShipHero", () => {
  it("reads every page of every window and upserts shipments and labels by their ids", async () => {
    const shipments = vi.fn()
      .mockResolvedValueOnce({ requestId: "r1", complexity: 3, nodes: [ship("1"), ship("2")], hasNextPage: true, endCursor: "c1" })
      .mockResolvedValueOnce({ requestId: "r2", complexity: 2, nodes: [ship("3")], hasNextPage: false, endCursor: null })
      .mockResolvedValueOnce({ requestId: "r3", complexity: 1, nodes: [], hasNextPage: false, endCursor: null });
    const { db, inserts } = fakeDb();
    const r = await syncShipHero({ db, client: createMockShipHeroClient({ shipments }), now: () => NOW }, { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-10T00:00:00Z") });
    expect(shipments.mock.calls.map((c) => c[1])).toEqual([null, "c1", null]);
    expect(r).toMatchObject({ windows: 2, pages: 3, shipments: 3, labels: 3 });
    const shipmentWrites = inserts.filter((w) => w.table === "shiphero_shipments");
    const labelWrites = inserts.filter((w) => w.table === "shiphero_labels");
    expect(shipmentWrites.flatMap((w) => w.values as unknown as unknown[])).toHaveLength(3);
    expect(labelWrites.flatMap((w) => w.values as unknown as unknown[])).toHaveLength(3);
    // Upserts, so a second run of the same window adds no rows.
    for (const w of [...shipmentWrites, ...labelWrites]) expect(w.set).toBeDefined();
  });

  it("counts the label statuses it actually saw", async () => {
    const shipments = vi.fn().mockResolvedValue({ requestId: "r", complexity: 1, nodes: [ship("1"), ship("2", "voided")], hasNextPage: false, endCursor: null });
    const { db } = fakeDb();
    const r = await syncShipHero({ db, client: createMockShipHeroClient({ shipments }), now: () => NOW }, dailyShipHeroRange(NOW));
    expect(r.statuses).toEqual({ valid: 1, voided: 1 });
  });

  it("stops at a failed window and says which, with ShipHero's request id", async () => {
    const shipments = vi.fn()
      .mockResolvedValueOnce({ requestId: "r1", complexity: 2, nodes: [ship("1")], hasNextPage: false, endCursor: null })
      .mockRejectedValueOnce(new ShipHeroError("ShipHero error 9: boom", 9, "req-bad", null));
    const { db } = fakeDb();
    const err = await syncShipHero({ db, client: createMockShipHeroClient({ shipments }), now: () => NOW }, { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-20T00:00:00Z") }).catch((e) => e);
    expect(shipments).toHaveBeenCalledTimes(2);
    expect(err.message).toMatch(/2026-11-08.*request id req-bad.*1 shipment\(s\) saved before it/);
  });

  it("writes nothing for an empty window and says so", async () => {
    const { db, inserts } = fakeDb();
    const r = await syncShipHero({ db, client: createMockShipHeroClient(), now: () => NOW }, dailyShipHeroRange(NOW));
    expect(inserts).toEqual([]);
    expect(r).toMatchObject({ shipments: 0, labels: 0, pages: 2 });
  });
});
