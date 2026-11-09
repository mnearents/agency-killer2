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
  /**
   * The measures below are null when Instagram did not return them — a reel
   * cannot report follows, a feed post has no watch time — never zero, so a
   * measure that does not exist is not read as one that came to nothing.
   */
  views?: number | null;
  reposts?: number | null;
  /** Reels only. Milliseconds. */
  avgWatchTimeMs?: number | null;
  /** Reels only. Milliseconds, summed over every view. */
  totalWatchTimeMs?: number | null;
  /** Feed posts only: accounts that followed from this post. */
  follows?: number | null;
  /** Feed posts only. */
  profileVisits?: number | null;
}

/**
 * One day of account-level insight. Null is a measure Instagram returned
 * nothing for, which happens for days beyond what it keeps.
 */
export interface IgAccountDay {
  /** Accounts that started following that day. */
  follows: number | null;
  /** Accounts that stopped following that day. */
  unfollows: number | null;
  reach: number | null;
  reachFollowers: number | null;
  /** Reach outside the existing audience: what growth is made of. */
  reachNonFollowers: number | null;
  views: number | null;
  viewsReel: number | null;
  viewsPost: number | null;
  viewsCarousel: number | null;
  viewsStory: number | null;
  /** Views of the account's content shown as ads — paid, not organic. */
  viewsAd: number | null;
  profileViews: number | null;
  accountsEngaged: number | null;
}

export interface IgAccountInfo {
  id: string;
  username: string;
  followers_count: number;
  media_count: number;
}

/** Another account, as Business Discovery shows it. */
export interface IgPeerProfile {
  username: string;
  name: string | null;
  followersCount: number;
  mediaCount: number;
}

/**
 * Another account's post. Instagram shares likes, comments and — for reels —
 * views; never reach, saves, shares or watch time. `viewCount` is null for
 * anything that is not a reel.
 */
export interface IgPeerMedia {
  id: string;
  caption: string | null;
  mediaType: string;
  mediaProductType: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  timestamp: string;
  likeCount: number | null;
  commentsCount: number | null;
  viewCount: number | null;
}

export interface InstagramApiClient {
  getAccountInfo(igUserId: string): Promise<IgAccountInfo>;
  getRecentMedia(igUserId: string, limit?: number): Promise<IgMedia[]>;
  getStories(igUserId: string): Promise<IgMedia[]>;
  getMediaInsights(mediaId: string, mediaType: string, mediaProductType?: string): Promise<IgMediaInsights>;
  /** Account insight for one day, `YYYY-MM-DD`, requested as that UTC day. */
  getAccountDay(igUserId: string, day: string): Promise<IgAccountDay>;
  /**
   * Another business or creator account's profile and newest posts, read
   * through our own account (`igUserId`) by Business Discovery.
   */
  getPeerAccount(igUserId: string, username: string, limit: number): Promise<{ profile: IgPeerProfile; media: IgPeerMedia[] }>;
}

/** Instagram usernames: letters, digits, dots and underscores, up to 30. */
export const IG_USERNAME = /^[a-z0-9._]{1,30}$/;

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
    views: byName.get("views") ?? null,
    reposts: byName.get("reposts") ?? null,
    avgWatchTimeMs: byName.get("ig_reels_avg_watch_time") ?? null,
    totalWatchTimeMs: byName.get("ig_reels_video_view_total_time") ?? null,
    follows: byName.get("follows") ?? null,
    profileVisits: byName.get("profile_visits") ?? null,
  };
}

/**
 * The insight metrics to request for a post.
 *
 * One metric a type does not support fails the whole call, so each type asks
 * for exactly its own set. Probed against the live account on 2026-11-09:
 * reels refuse `follows`, `profile_visits` and `impressions`; feed posts
 * refuse the `ig_reels_*` watch-time metrics; `plays` no longer exists.
 *
 * It is chosen by `media_product_type`, which is what separates a reel from a
 * feed video — `media_type` is VIDEO for both.
 */
export function insightMetricsFor(mediaType: string, mediaProductType?: string): string {
  if (mediaProductType === "REELS") {
    return "views,reach,saved,shares,reposts,total_interactions,ig_reels_avg_watch_time,ig_reels_video_view_total_time";
  }

  if (mediaProductType === "STORY") {
    // Stories expire from the API after 24h and were not probed; account
    // insight carries their views by day.
    return "reach";
  }

  // IMAGE, CAROUSEL_ALBUM, and feed VIDEO
  return "views,reach,saved,shares,reposts,total_interactions,follows,profile_visits";
}

interface AccountInsightRow {
  name: string;
  total_value?: {
    value?: number;
    breakdowns?: Array<{ dimension_keys?: string[]; results?: Array<{ dimension_values: string[]; value: number }> }>;
  };
}

/**
 * Reads the three account insight responses for one day.
 *
 * `follows_and_unfollows` broken down by `follow_type` puts accounts that
 * followed under FOLLOWER and accounts that unfollowed under NON_FOLLOWER.
 * A breakdown with no results — what Instagram returns for a day it no longer
 * holds — leaves both null rather than reporting a day nobody followed.
 */
export function parseAccountDay(input: { followsAndReach: AccountInsightRow[]; views: AccountInsightRow[]; totals: AccountInsightRow[] }): IgAccountDay {
  const all = [...input.followsAndReach, ...input.views, ...input.totals];
  const row = (name: string) => all.find((r) => r.name === name);
  const part = (name: string, key: string): number | null => {
    const results = row(name)?.total_value?.breakdowns?.[0]?.results;
    if (!results) return null;
    return results.find((r) => r.dimension_values[0] === key)?.value ?? 0;
  };
  const total = (name: string): number | null => row(name)?.total_value?.value ?? null;

  return {
    follows: part("follows_and_unfollows", "FOLLOWER"),
    unfollows: part("follows_and_unfollows", "NON_FOLLOWER"),
    reach: total("reach"),
    reachFollowers: part("reach", "FOLLOWER"),
    reachNonFollowers: part("reach", "NON_FOLLOWER"),
    views: total("views"),
    viewsReel: part("views", "REEL"),
    viewsPost: part("views", "POST"),
    viewsCarousel: part("views", "CAROUSEL_CONTAINER"),
    viewsStory: part("views", "STORY"),
    viewsAd: part("views", "AD"),
    profileViews: total("profile_views"),
    accountsEngaged: total("accounts_engaged"),
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const safeUrl = url.replace(/access_token=[^&]+/, "access_token=***");
  console.log(`[instagram-api] GET ${safeUrl}`);
  const response = await fetch(url);
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[instagram-api] Error ${response.status}: ${errorText.slice(0, 300)}`);
    throw new Error(describeInstagramError(response.status, errorText));
  }
  return response.json() as Promise<T>;
}

/**
 * The error to raise, with the fix named where the cause is known. Code 100
 * subcode 33 on the account means the token cannot see it — on a system user
 * token, because no Page (and so no Instagram account) is assigned to it.
 */
export function describeInstagramError(status: number, body: string): string {
  let hint = "";
  try {
    const e = (JSON.parse(body) as { error?: { code?: number; error_subcode?: number } }).error;
    if (e?.code === 100 && e.error_subcode === 33) {
      hint =
        " — the token cannot see this Instagram account. Assign the Facebook Page and the Instagram account to the system user " +
        "(Business Settings → System users → Assign assets), then the next sync reads it.";
    }
  } catch {
    // Not JSON: nothing to add.
  }
  return `Instagram API error (${status}): ${body}${hint}`;
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

    async getStories(igUserId) {
      // Stories expire after 24h — this returns only currently live stories
      const url = buildUrl(`${igUserId}/stories`, {
        fields: "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp",
      });
      const json = await fetchJson<{ data?: IgMedia[] }>(url);
      // Mark stories with STORY product type for downstream handling
      return (json.data ?? []).map((s) => ({
        ...s,
        media_product_type: "STORY" as const,
      }));
    },

    async getMediaInsights(mediaId, mediaType, mediaProductType) {
      const metrics = insightMetricsFor(mediaType, mediaProductType);
      const url = buildUrl(`${mediaId}/insights`, {
        metric: metrics,
      });

      const json = await fetchJson<{ data?: IgMediaInsight[] }>(url);
      return parseInsightsResponse(mediaId, json.data ?? []);
    },

    async getPeerAccount(igUserId, username, limit) {
      const name = username.trim().replace(/^@/, "").toLowerCase();
      // It is interpolated into the field expression, so nothing else may pass.
      if (!IG_USERNAME.test(name)) throw new Error(`"${username}" is not an Instagram username`);
      const media = `media.limit(${Math.min(Math.max(limit, 1), 100)}){id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count,view_count,media_url,thumbnail_url}`;
      const json = await fetchJson<{
        business_discovery?: {
          username: string; name?: string; followers_count: number; media_count: number;
          media?: { data?: Array<IgMedia & { view_count?: number }> };
        };
      }>(buildUrl(igUserId, { fields: `business_discovery.username(${name}){username,name,followers_count,media_count,${media}}` }));
      const bd = json.business_discovery;
      if (!bd) throw new Error(`Instagram returned no account for @${name}`);
      return {
        profile: { username: bd.username, name: bd.name ?? null, followersCount: bd.followers_count, mediaCount: bd.media_count },
        media: (bd.media?.data ?? []).map((m) => ({
          id: m.id,
          caption: m.caption ?? null,
          mediaType: m.media_type,
          mediaProductType: m.media_product_type ?? null,
          permalink: m.permalink ?? null,
          thumbnailUrl: m.thumbnail_url ?? (m.media_type === "VIDEO" ? null : m.media_url ?? null),
          timestamp: m.timestamp,
          likeCount: m.like_count ?? null,
          commentsCount: m.comments_count ?? null,
          viewCount: m.view_count ?? null,
        })),
      };
    },

    async getAccountDay(igUserId, day) {
      const since = Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000);
      const range = { period: "day", metric_type: "total_value", since: String(since), until: String(since + 86_400) };
      // Three calls because a call takes one breakdown for all its metrics.
      const [followsAndReach, views, totals] = await Promise.all([
        fetchJson<{ data?: AccountInsightRow[] }>(buildUrl(`${igUserId}/insights`, { ...range, metric: "follows_and_unfollows,reach", breakdown: "follow_type" })),
        fetchJson<{ data?: AccountInsightRow[] }>(buildUrl(`${igUserId}/insights`, { ...range, metric: "views", breakdown: "media_product_type" })),
        fetchJson<{ data?: AccountInsightRow[] }>(buildUrl(`${igUserId}/insights`, { ...range, metric: "profile_views,accounts_engaged" })),
      ]);
      return parseAccountDay({ followsAndReach: followsAndReach.data ?? [], views: views.data ?? [], totals: totals.data ?? [] });
    },
  };
}
