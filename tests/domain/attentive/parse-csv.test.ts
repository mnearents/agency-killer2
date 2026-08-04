import { describe, it, expect } from "vitest";
import {
  parseCampaignPerformanceCsv,
  parseAttributedRevenueCsv,
  type CampaignPerformanceRow,
  type AttributedRevenueRow,
} from "@/domain/attentive/parse-csv";

const CAMPAIGN_CSV = `Message Send Date\tMessage Variant\tHas Media\tDelivered\tTotal Clicks\tTotal Click Rate\tConversions\tConversion Rate\tRevenue ($ USD)\tUnsubscribes\tUnsubscribe Rate
Total\t\t\t817415\t17971\t0.021985\t1262\t0.070224\t24453.4\t4599\t0.005626
2026-01-06\tEmail\tFALSE\t62114\t1470\t0.023666\t43\t0.029252\t534.71\t547\t0.008806
2026-01-07\tSMS\tTRUE\t15230\t890\t0.058438\t28\t0.031461\t412.50\t120\t0.007878`;

const REVENUE_CSV = `Conversion Date\tConversions\tTotal Revenue ($ USD)\tAverage Order Value ($ USD)
Total\t3968\t56956.04000000000\t14.35384072580650
2026-01-01\t1781\t9924.110000000000\t5.572212240314430
2026-01-02\t9\t518.1900000000000\t57.57666666666670`;

describe("parseCampaignPerformanceCsv", () => {
  it("parses tab-separated campaign data, skipping the Total row", () => {
    const rows = parseCampaignPerformanceCsv(CAMPAIGN_CSV);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual<CampaignPerformanceRow>({
      date: "2026-01-06",
      messageVariant: "Email",
      hasMedia: false,
      delivered: 62114,
      totalClicks: 1470,
      totalClickRate: 0.023666,
      conversions: 43,
      conversionRate: 0.029252,
      revenueDollars: 534.71,
      unsubscribes: 547,
      unsubscribeRate: 0.008806,
    });
  });

  it("parses SMS row with media", () => {
    const rows = parseCampaignPerformanceCsv(CAMPAIGN_CSV);

    expect(rows[1].messageVariant).toBe("SMS");
    expect(rows[1].hasMedia).toBe(true);
    expect(rows[1].delivered).toBe(15230);
  });

  it("handles empty input", () => {
    expect(parseCampaignPerformanceCsv("")).toEqual([]);
  });

  it("handles header-only input", () => {
    const headerOnly = "Message Send Date\tMessage Variant\tHas Media\tDelivered\tTotal Clicks\tTotal Click Rate\tConversions\tConversion Rate\tRevenue ($ USD)\tUnsubscribes\tUnsubscribe Rate";
    expect(parseCampaignPerformanceCsv(headerOnly)).toEqual([]);
  });

  it("parses comma-separated CSV", () => {
    const commaCsv = `Message Send Date,Message Variant,Has Media,Delivered,Total Clicks,Total Click Rate,Conversions,Conversion Rate,Revenue ($ USD),Unsubscribes,Unsubscribe Rate
Total,,,"817,415","17,971",0.021985,"1,262",0.070224,"24,453.40","4,599",0.005626
2026-01-06,Email,FALSE,"62,114","1,470",0.023666,43,0.029252,534.71,547,0.008806`;

    const rows = parseCampaignPerformanceCsv(commaCsv);
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe("2026-01-06");
    expect(rows[0].delivered).toBe(62114);
    expect(rows[0].totalClicks).toBe(1470);
    expect(rows[0].revenueDollars).toBe(534.71);
  });

  it("handles quoted fields with commas inside", () => {
    const quotedCsv = `Message Send Date,Message Variant,Has Media,Delivered,Total Clicks,Total Click Rate,Conversions,Conversion Rate,Revenue ($ USD),Unsubscribes,Unsubscribe Rate
2026-01-06,Email,FALSE,"62,114","1,470",0.023666,43,0.029252,"1,534.71",547,0.008806`;

    const rows = parseCampaignPerformanceCsv(quotedCsv);
    expect(rows[0].delivered).toBe(62114);
    expect(rows[0].revenueDollars).toBe(1534.71);
  });
});

describe("parseAttributedRevenueCsv", () => {
  it("parses tab-separated revenue data, skipping the Total row", () => {
    const rows = parseAttributedRevenueCsv(REVENUE_CSV);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual<AttributedRevenueRow>({
      date: "2026-01-01",
      conversions: 1781,
      totalRevenueDollars: 9924.11,
      avgOrderValueDollars: 5.57,
    });
  });

  it("rounds AOV to 2 decimal places", () => {
    const rows = parseAttributedRevenueCsv(REVENUE_CSV);
    expect(rows[1].avgOrderValueDollars).toBe(57.58);
  });

  it("handles empty input", () => {
    expect(parseAttributedRevenueCsv("")).toEqual([]);
  });
});
