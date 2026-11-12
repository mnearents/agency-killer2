import { describe, it, expect } from "vitest";
import { SQL } from "drizzle-orm";
import { setPeer } from "@/domain/social/review-queries";
import { fakeDb } from "../../mocks/recording-db";

describe("setPeer", () => {
  // The 30-day cutoff for a teacher's downloads runs from this date.
  it("records when an account first becomes a teacher, and keeps that date afterwards", async () => {
    const { db, inserts } = fakeDb();
    await setPeer(db, { username: "lana.k.social", active: true, purpose: "teacher", addedBy: "Matt" });
    const w = inserts[0];
    expect(w.values.firstFillAt).toBeInstanceOf(Date);
    // On an existing account: COALESCE with the stored date, never a new one.
    expect(w.set!.firstFillAt).toBeInstanceOf(SQL);
  });

  it("leaves the date alone for a peer", async () => {
    const { db, inserts } = fakeDb();
    await setPeer(db, { username: "pippipost.shop", active: true, purpose: "peer", addedBy: null });
    expect(inserts[0].values.firstFillAt).toBeUndefined();
    expect(inserts[0].set!.firstFillAt).toBeUndefined();
  });
});
