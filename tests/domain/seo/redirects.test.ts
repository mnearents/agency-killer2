import { describe, it, expect, vi } from "vitest";
import { resolveProductRedirect, handleOf, type Fetcher } from "@/domain/seo/redirects";

const STORE = "https://radandhappy.com";
const fetcher = (map: Record<string, { status: number; location: string | null }>): Fetcher =>
  vi.fn(async (url: string) => map[url] ?? { status: 200, location: null });

describe("handleOf", () => {
  it("reads the handle from a product URL", () => {
    expect(handleOf("https://radandhappy.com/products/rad-club")).toBe("rad-club");
  });
  it("returns null for a collection", () => {
    expect(handleOf("https://radandhappy.com/collections/planners")).toBeNull();
  });
});

describe("resolveProductRedirect", () => {
  // The live case: 189,381 impressions reported as a page with no meta
  // description, when it is a 301 to a product that has one.
  it("follows a 301 to the product that serves it", async () => {
    const f = fetcher({
      [`${STORE}/products/color-happy-subscription`]: {
        status: 301, location: "/products/really-awesome-doodles",
      },
    });
    expect(await resolveProductRedirect(STORE, "color-happy-subscription", f)).toEqual({
      fromHandle: "color-happy-subscription",
      toHandle: "really-awesome-doodles",
      statusCode: 200,
      finalUrl: `${STORE}/products/really-awesome-doodles`,
    });
  });

  it("follows an absolute Location header", async () => {
    const f = fetcher({
      [`${STORE}/products/old`]: { status: 301, location: `${STORE}/products/new` },
    });
    expect((await resolveProductRedirect(STORE, "old", f)).toHandle).toBe("new");
  });

  it("follows a chain of redirects", async () => {
    const f = fetcher({
      [`${STORE}/products/a`]: { status: 301, location: "/products/b" },
      [`${STORE}/products/b`]: { status: 301, location: "/products/c" },
    });
    expect((await resolveProductRedirect(STORE, "a", f)).toHandle).toBe("c");
  });

  // A dead URL and one that redirects need different responses, so a 404 is
  // not collapsed into "redirects nowhere".
  it("reports a 404 rather than a redirect", async () => {
    const f = fetcher({ [`${STORE}/products/gone`]: { status: 404, location: null } });
    expect(await resolveProductRedirect(STORE, "gone", f)).toMatchObject({
      toHandle: null, statusCode: 404,
    });
  });

  it("reports a live page as not redirecting", async () => {
    const f = fetcher({ [`${STORE}/products/live`]: { status: 200, location: null } });
    expect((await resolveProductRedirect(STORE, "live", f)).toHandle).toBeNull();
  });

  // Two renamed products pointing at each other is a configuration someone can
  // create in admin without noticing, and an unbounded follower would hang.
  it("stops on a redirect loop instead of hanging", async () => {
    const f = fetcher({
      [`${STORE}/products/a`]: { status: 301, location: "/products/b" },
      [`${STORE}/products/b`]: { status: 301, location: "/products/a" },
    });
    expect((await resolveProductRedirect(STORE, "a", f)).toHandle).toBeNull();
  });

  it("gives up after the hop limit rather than following forever", async () => {
    let n = 0;
    const f: Fetcher = vi.fn(async () => ({ status: 301, location: `/products/next-${n++}` }));
    const r = await resolveProductRedirect(STORE, "start", f, 3);
    expect(f).toHaveBeenCalledTimes(3);
    expect(r.toHandle).toBeNull();
  });

  it("reports a redirect that leaves the product space", async () => {
    const f = fetcher({
      [`${STORE}/products/old`]: { status: 301, location: "/collections/planners" },
    });
    const r = await resolveProductRedirect(STORE, "old", f);
    expect(r.toHandle).toBeNull();
    expect(r.finalUrl).toContain("/collections/planners");
  });
});
