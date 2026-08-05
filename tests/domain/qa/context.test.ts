import { describe, it, expect } from "vitest";
import { detectTopics, type Topic } from "@/domain/qa/context";

describe("detectTopics", () => {
  it("detects ads-related questions", () => {
    expect(detectTopics("how are our ads doing")).toContain("ads");
    expect(detectTopics("what's our ROAS this week")).toContain("ads");
    expect(detectTopics("meta campaign performance")).toContain("ads");
    expect(detectTopics("ad spend last month")).toContain("ads");
    expect(detectTopics("how much did we spend on advertising")).toContain("ads");
  });

  it("detects shopify-related questions", () => {
    expect(detectTopics("how many orders did we get")).toContain("shopify");
    expect(detectTopics("what's our revenue this week")).toContain("shopify");
    expect(detectTopics("best selling product")).toContain("shopify");
    expect(detectTopics("subscription numbers")).toContain("shopify");
    expect(detectTopics("what's our AOV")).toContain("shopify");
  });

  it("detects social-related questions", () => {
    expect(detectTopics("how are our reels doing")).toContain("social");
    expect(detectTopics("instagram engagement this week")).toContain("social");
    expect(detectTopics("which posts performed best")).toContain("social");
    expect(detectTopics("what's our save rate")).toContain("social");
  });

  it("detects email/sms-related questions", () => {
    expect(detectTopics("how did our email perform")).toContain("email");
    expect(detectTopics("sms click rate")).toContain("email");
    expect(detectTopics("attentive campaign results")).toContain("email");
    expect(detectTopics("unsubscribe rate this month")).toContain("email");
  });

  it("detects multiple topics", () => {
    const topics = detectTopics("compare our ad spend to email revenue");
    expect(topics).toContain("ads");
    expect(topics).toContain("email");
  });

  it("returns all topics for broad questions", () => {
    const topics = detectTopics("how is the business doing overall");
    expect(topics.length).toBeGreaterThanOrEqual(2);
  });

  it("returns at least one topic for any question", () => {
    const topics = detectTopics("what should we do next");
    expect(topics.length).toBeGreaterThanOrEqual(1);
  });
});
