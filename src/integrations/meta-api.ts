/**
 * Meta Marketing API client — the seam between our code and Meta's API.
 * Tests mock this interface; production uses the real SDK.
 */

export interface MetaApiCampaign {
  id: string;
  name: string;
  status: string;
  objective?: string;
  buying_type?: string;
  daily_budget?: string; // Already in cents from Meta
  lifetime_budget?: string; // Already in cents from Meta
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
  daily_budget?: string; // Already in cents from Meta
  lifetime_budget?: string; // Already in cents from Meta
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
  date_start: string; // YYYY-MM-DD
  impressions?: string;
  clicks?: string;
  spend?: string; // In DOLLARS — must convert to cents
  reach?: string;
  cpm?: string; // In DOLLARS
  cpc?: string; // In DOLLARS
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

export function createMetaApiClient(_accessToken: string): MetaApiClient {
  throw new Error(
    "Real Meta API client not yet implemented — use createMockMetaApiClient in tests"
  );
}
