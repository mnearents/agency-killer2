/**
 * Resolving a Shopify URL that no longer maps to a product.
 *
 * Search Console reports the URL it has INDEXED, which for a renamed product
 * is the old path. Joining on that path finds no product, and a naive report
 * then says the page has no SEO title and no meta description — when in fact
 * it redirects to a product that has both. That is exactly how
 * `/products/color-happy-subscription` came to be reported as the biggest
 * organic asset with no copy, when it is a 301 to `really-awesome-doodles`.
 *
 * Resolution is over HTTP rather than through the Admin API. `urlRedirects`
 * exists but needs an online-store scope this token does not have, and the
 * HTTP answer is better regardless: it is what a crawler actually receives,
 * so it also catches redirects created by apps or theme rules that the API
 * would not list.
 */

export interface RedirectResolution {
  fromHandle: string;
  /** The handle it lands on, or null when it does not redirect to a product. */
  toHandle: string | null;
  statusCode: number;
  /** The final URL, for anything that left the product space entirely. */
  finalUrl: string | null;
}

export type Fetcher = (url: string) => Promise<{ status: number; location: string | null }>;

/** Reads the handle out of a storefront product URL. Null for anything else. */
export function handleOf(url: string): string | null {
  const match = url.match(/\/products\/([^/?#]+)/);
  if (!match) return null;
  const handle = decodeURIComponent(match[1]).toLowerCase();
  return handle === "" ? null : handle;
}

/**
 * Follows a product URL to wherever it ends up.
 *
 * `maxHops` is bounded because a redirect loop between two renamed products is
 * a configuration someone can create in Shopify admin without noticing, and an
 * unbounded follower would hang the sync rather than report it.
 */
export async function resolveProductRedirect(
  storeUrl: string,
  handle: string,
  fetcher: Fetcher,
  maxHops = 5,
): Promise<RedirectResolution> {
  let url = `${storeUrl}/products/${handle}`;
  let status = 0;
  const seen = new Set<string>([url]);

  for (let hop = 0; hop < maxHops; hop++) {
    const response = await fetcher(url);
    status = response.status;

    if (response.status < 300 || response.status >= 400 || response.location === null) {
      const landed = handleOf(url);
      return {
        fromHandle: handle,
        // A page that resolves to itself has not redirected anywhere.
        toHandle: landed === handle ? null : landed,
        statusCode: status,
        finalUrl: url,
      };
    }

    const next = response.location.startsWith("http")
      ? response.location
      : `${storeUrl}${response.location}`;

    if (seen.has(next)) {
      return { fromHandle: handle, toHandle: null, statusCode: status, finalUrl: next };
    }
    seen.add(next);
    url = next;
  }

  // Out of hops. Reported rather than guessed at: a chain this long is a
  // problem in its own right.
  return { fromHandle: handle, toHandle: null, statusCode: status, finalUrl: url };
}

/** The default fetcher. HEAD, no auto-follow, so each hop is visible. */
export function createRedirectFetcher(timeoutMs = 10_000): Fetcher {
  return async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method: "HEAD",
        redirect: "manual",
        signal: controller.signal,
      });
      return { status: response.status, location: response.headers.get("location") };
    } finally {
      clearTimeout(timer);
    }
  };
}
