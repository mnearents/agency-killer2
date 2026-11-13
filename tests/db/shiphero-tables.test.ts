/**
 * ShipHero's token can see customers' names, addresses and emails. Nothing
 * from ShipHero may hold them: not the tables, not the analytics views.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getTableColumns } from "drizzle-orm";
import { shipheroLabels, shipheroShipments } from "@/db/schema";

const CUSTOMER = /address|email|phone|first_name|last_name|customer|^name$|zip|postal|city|state|country/i;

describe("ShipHero tables hold no customer details", () => {
  it.each([["shiphero_shipments", shipheroShipments], ["shiphero_labels", shipheroLabels]] as const)("%s has no customer column", (_name, table) => {
    const columns = Object.values(getTableColumns(table)).map((c) => c.name);
    expect(columns.filter((c) => CUSTOMER.test(c))).toEqual([]);
  });

  it("the analytics views select no customer column", () => {
    const sql = fs.readFileSync(path.join(process.cwd(), "src/db/migrations/0063_shiphero.sql"), "utf8");
    const views = [...sql.matchAll(/CREATE VIEW (analytics\.shiphero_\w+) AS([\s\S]*?)FROM/g)];
    expect(views.map((v) => v[1])).toEqual(["analytics.shiphero_shipments", "analytics.shiphero_labels"]);
    for (const [, , body] of views) {
      const selected = body.split("\n").map((l) => l.trim()).filter((l) => /^[sl]\.\w+/.test(l)).map((l) => l.replace(/^[sl]\.(\w+).*$/, "$1"));
      expect(selected.filter((c) => CUSTOMER.test(c))).toEqual([]);
    }
  });
});
