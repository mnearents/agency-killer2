import { describe, it, expect } from "vitest";
import { setPeer } from "@/domain/social/review-queries";
import { fakeDb } from "../../mocks/recording-db";

describe("setPeer", () => {
  // No account is followed for advice: whatever is watched is a competitor.
  it("watches every account as a peer, including one that was a teacher", async () => {
    const { db, inserts } = fakeDb();
    await setPeer(db, { username: "lana.k.social", active: true, addedBy: "Matt" });
    expect(inserts[0].values).toMatchObject({ username: "lana.k.social", purpose: "peer", active: 1 });
    expect(inserts[0].set).toMatchObject({ purpose: "peer", active: 1 });
    expect(inserts[0].values.firstFillAt).toBeUndefined();
  });

  it("stops an account without changing what it was", async () => {
    const { db, inserts } = fakeDb();
    await setPeer(db, { username: "lana.k.social", active: false, addedBy: null });
    expect(inserts[0].set).toEqual({ active: 0, updatedAt: expect.any(Date) });
  });
});
