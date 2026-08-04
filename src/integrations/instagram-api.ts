/**
 * Instagram Graph API client — the seam between our code and Instagram's API.
 * Uses the same Meta access token as the ads API, but hits the Instagram
 * Graph API endpoints for organic post data.
 *
 * API docs: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api
 */

const GRAPH_API_VERSION = "v21.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export interface IgMedia {
  id: string;
  caption?: string;
  media_type: "IMAGE" | "VIDEO" | "CAROUSEL_ALBUM";
  media_product_type?: "FEED" | "REELS" | "STORY";
  media_url?: string;
  thumbnail_url?: string;
  permalink?: string;
  timestamp: string;
  like_count?: number;
  comments_count?: number;
}

export interface IgMediaInsight {
  name: string;
  period: string;
  values: Array<{ value: number }>;
}

export interface IgMediaInsights {
  mediaId: string;
  impressions: number;
  reach: number;
  saved: number;
  shares: number;
  plays: number;
  totalInteractions: number;
}

export interface IgAccountInfo {
  id: string;
  username: string;
  followers_count: number;
  media_count: number;
}

export interface InstagramApiClient {
  getAccountInfo(igUserId: string): Promise<IgAccountInfo>;
  getRecentMedia(igUserId: string, limit?: number): Promise<IgMedia[]>;
  getMediaInsights(mediaId: string, mediaType: string): Promise<IgMediaInsights>;
}

const MEDIA_FIELDS = [
  "id",
  "caption",
  "media_type",
  "media_product_type",
  "media_url",
  "thumbnail_url",
  "permalink",
  "timestamp",
  "like_count",
  "comments_count",
].join(",");

/**
 * Parse the insights response from the Graph API into a flat object.
 * Missing metrics default to 0.
 */
export function parseInsightsResponse(
  mediaId: string,
  data: IgMediaInsight[]
): IgMediaInsights {
  const byName = new Map<string, number>();
  for (const metric of data) {
    const value = metric.values?.[0]?.value ?? 0;
    byName.set(metric.name, value);
  }

  return {
    mediaId,
    impressions: byName.get("views") ?? byName.get("impressions") ?? 0,
    reach: byName.get("reach") ?? 0,
    saved: byName.get("saved") ?? 0,
    shares: byName.get("shares") ?? 0,
    // plays only meaningful for reels — ig_reels_avg_watch_time presence
    // signals this is a reel response. For images, views = impressions, not plays.
    plays: byName.has("ig_reels_avg_watch_time")
      ? (byName.get("views") ?? byName.get("ig_reels_video_view_total") ?? byName.get("plays") ?? 0)
      : (byName.get("ig_reels_video_view_total") ?? byName.get("plays") ?? 0),
    totalInteractions: byName.get("total_interactions") ?? 0,
  };
}

/**
 * Pick the right insight metrics based on media type.
 *
 * The IG API is picky about which metrics each media type supports.
 * Stories, older posts, and carousel children reject many metrics.
 * Use the safest common set per type to minimize 400 errors.
 */
function getMetricsForMediaType(mediaType: string, mediaProductType?: string): string {
  if (mediaProductType === "REELS") {
    // Reels support reel-specific metrics
    return "reach,saved,shares,total_interactions,ig_reels_avg_watch_time";
  }

  if (mediaProductType === "STORY") {
    // Stories only support a limited set
    return "reach";
  }

  // IMAGE, CAROUSEL_ALBUM, VIDEO (non-reel)
  // Use the most universally supported metrics
  return "reach,saved,total_interactions";
}

async function fetchJson<T>(url: string): Promise<T> {
  const safeUrl = url.replace(/access_token=[^&]+/, "access_token=***");
  console.log(`[instagram-api] GET ${safeUrl}`);
  const response = await fetch(url);
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[instagram-api] Error ${response.status}: ${errorText.slice(0, 300)}`);
    throw new Error(`Instagram API error (${response.status}): ${errorText}`);
  }
  return response.json() as Promise<T>;
}

const MAX_PAGES = 20;

async function fetchAllPages<T>(url: string): Promise<T[]> {
  const results: T[] = [];
  let nextUrl: string | null = url;
  let page = 0;

  while (nextUrl && page < MAX_PAGES) {
    const response: { data?: T[]; paging?: { next?: string } } =
      await fetchJson<{ data?: T[]; paging?: { next?: string } }>(nextUrl);
    if (response.data) {
      results.push(...response.data);
    }
    nextUrl = response.paging?.next ?? null;
    page++;
  }

  if (page >= MAX_PAGES) {
    console.warn(`[instagram-api] Hit max page limit (${MAX_PAGES}), stopping pagination with ${results.length} results`);
  }

  return results;
}

export function createInstagramApiClient(accessToken: string): InstagramApiClient {
  function buildUrl(path: string, params: Record<string, string> = {}): string {
    const url = new URL(`${GRAPH_API_BASE}/${path}`);
    url.searchParams.set("access_token", accessToken);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  return {
    async getAccountInfo(igUserId) {
      const url = buildUrl(igUserId, {
        fields: "id,username,followers_count,media_count",
      });
      return fetchJson<IgAccountInfo>(url);
    },

    async getRecentMedia(igUserId, limit = 50) {
      const url = buildUrl(`${igUserId}/media`, {
        fields: MEDIA_FIELDS,
        limit: String(Math.min(limit, 100)), // IG max per page is 100
      });
      // Single page fetch — no pagination. For daily sync we only need
      // the most recent posts, not the entire history. The limit param
      // controls how many we get (up to 100 per request).
      const json = await fetchJson<{ data?: IgMedia[] }>(url);
      return json.data ?? [];
    },

    async getMediaInsights(mediaId, mediaType) {
      const metrics = getMetricsForMediaType(mediaType);
      const url = buildUrl(`${mediaId}/insights`, {
        metric: metrics,
      });

      const json = await fetchJson<{ data?: IgMediaInsight[] }>(url);
      return parseInsightsResponse(mediaId, json.data ?? []);
    },
  };
}
