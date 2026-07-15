/**
 * Meta Marketing API client — the seam between our code and Meta's API.
 * Tests mock this interface; production uses the Graph API via fetch.
 *
 * API docs: https://developers.facebook.com/docs/marketing-api
 */

const GRAPH_API_VERSION = "v21.0";
const GRAPH_API_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

export interface MetaApiCampaign {
  id: string;
  name: string;
  status: string;
  objective?: string;
  buying_type?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  created_time?: string;
  updated_time?: string;
}

export interface MetaApiAdSet {
  id: string;
  campaign_id: string;
  name: string;
  status: string;
  targeting?: Record<string, unknown>;
  optimization_goal?: string;
  billing_event?: string;
  bid_strategy?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  created_time?: string;
  updated_time?: string;
}

export interface MetaApiAd {
  id: string;
  adset_id: string;
  campaign_id: string;
  name: string;
  status: string;
  creative?: { id: string };
}

export interface MetaApiCreative {
  id: string;
  name?: string;
  title?: string;
  body?: string;
  image_url?: string;
  video_id?: string;
  thumbnail_url?: string;
  call_to_action_type?: string;
  object_type?: string;
}

export interface MetaApiAction {
  action_type: string;
  value: string;
  "7d_click"?: string;
}

export interface MetaApiActionValue {
  action_type: string;
  value: string;
  "7d_click"?: string;
}

export interface MetaApiInsight {
  ad_id: string;
  adset_id: string;
  campaign_id: string;
  date_start: string;
  impressions?: string;
  clicks?: string;
  spend?: string;
  reach?: string;
  cpm?: string;
  cpc?: string;
  ctr?: string;
  actions?: MetaApiAction[];
  action_values?: MetaApiActionValue[];
  publisher_platform?: string;
  platform_position?: string;
}

export interface MetaApiClient {
  getCampaigns(accountId: string): Promise<MetaApiCampaign[]>;
  getAdSets(accountId: string): Promise<MetaApiAdSet[]>;
  getAds(accountId: string): Promise<MetaApiAd[]>;
  getCreatives(accountId: string): Promise<MetaApiCreative[]>;
  getInsights(
    accountId: string,
    startDate: string,
    endDate: string
  ): Promise<MetaApiInsight[]>;
}

const CAMPAIGN_FIELDS = [
  "id", "name", "status", "objective", "buying_type",
  "daily_budget", "lifetime_budget", "created_time", "updated_time",
].join(",");

const ADSET_FIELDS = [
  "id", "campaign_id", "name", "status", "targeting",
  "optimization_goal", "billing_event", "bid_strategy",
  "daily_budget", "lifetime_budget", "created_time", "updated_time",
].join(",");

const AD_FIELDS = "id,adset_id,campaign_id,name,status,creative{id}";

const CREATIVE_FIELDS = [
  "id", "name", "title", "body", "image_url",
  "video_id", "thumbnail_url", "call_to_action_type", "object_type",
].join(",");

const INSIGHT_FIELDS = [
  "ad_id", "adset_id", "campaign_id", "date_start",
  "impressions", "clicks", "spend", "reach", "cpm", "cpc", "ctr",
  "actions", "action_values",
].join(",");

/**
 * Fetch all pages of a paginated Graph API response.
 */
async function fetchAllPages<T>(url: string): Promise<T[]> {
  const results: T[] = [];
  let nextUrl: string | null = url;

  while (nextUrl) {
    const response: Response = await fetch(nextUrl);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Meta API error (${response.status}): ${errorText}`);
    }

    const json: { data?: T[]; paging?: { next?: string } } = await response.json();
    if (json.data) {
      results.push(...json.data);
    }

    nextUrl = json.paging?.next ?? null;
  }

  return results;
}

export function createMetaApiClient(accessToken: string): MetaApiClient {
  function buildUrl(path: string, params: Record<string, string> = {}): string {
    const url = new URL(`${GRAPH_API_BASE}/${path}`);
    url.searchParams.set("access_token", accessToken);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  return {
    async getCampaigns(accountId) {
      const url = buildUrl(`${accountId}/campaigns`, {
        fields: CAMPAIGN_FIELDS,
        limit: "500",
      });
      return fetchAllPages<MetaApiCampaign>(url);
    },

    async getAdSets(accountId) {
      const url = buildUrl(`${accountId}/adsets`, {
        fields: ADSET_FIELDS,
        limit: "500",
      });
      return fetchAllPages<MetaApiAdSet>(url);
    },

    async getAds(accountId) {
      const url = buildUrl(`${accountId}/ads`, {
        fields: AD_FIELDS,
        limit: "500",
      });
      return fetchAllPages<MetaApiAd>(url);
    },

    async getCreatives(accountId) {
      const url = buildUrl(`${accountId}/adcreatives`, {
        fields: CREATIVE_FIELDS,
        limit: "500",
      });
      return fetchAllPages<MetaApiCreative>(url);
    },

    async getInsights(accountId, startDate, endDate) {
      const url = buildUrl(`${accountId}/insights`, {
        fields: INSIGHT_FIELDS,
        time_range: JSON.stringify({
          since: startDate,
          until: endDate,
        }),
        time_increment: "1", // daily granularity
        breakdowns: "publisher_platform,platform_position",
        action_attribution_windows: '["7d_click"]',
        level: "ad",
        limit: "500",
      });
      return fetchAllPages<MetaApiInsight>(url);
    },
  };
}
