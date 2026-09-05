import { vi } from "vitest";
import type { SealApiClient, SealSubscription } from "@/integrations/seal-api";

export function createMockSealApiClient(
  overrides?: Partial<SealApiClient>
): SealApiClient {
  return {
    getAllSubscriptions: vi.fn().mockResolvedValue([]),
    getSubscriptionDetail: vi.fn().mockResolvedValue({ customerId: null, log: null, tags: null }),
    ...overrides,
  };
}

/** A realistic ACTIVE Spark subscription on current pricing. */
export function makeSealSubscription(
  overrides: Partial<SealSubscription> = {}
): SealSubscription {
  return {
    id: 15876884,
    order_id: "7792730308853",
    email: "a@example.com",
    first_name: "A",
    last_name: "B",
    status: "ACTIVE",
    billing_interval: "1 month",
    delivery_interval: "1 month",
    currency: "USD",
    total_value: 8,
    order_placed: "2026-09-02T09:07:47-07:00",
    cancelled_on: "",
    paused_on: "",
    cancellation_reason: "",
    cancellation_scheduled_for: "",
    internal_id: 5627,
    items: [
      {
        id: 32156132,
        product_id: "9465149784309",
        variant_id: "48093950214389",
        title: "Really Awesome Doodles - Spark",
        variant_sku: "rad-t1",
        quantity: 1,
        price: "8.0",
        selling_plan_id: "10080551157",
        selling_plan_name: "Spark Monthly Plan",
        is_one_time_item: 0,
        requires_shipping: 0,
        taxable: 1,
      },
    ],
    billing_attempts: [
      {
        id: 169941048,
        date: "2026-10-01T08:00:00+00:00",
        status: "",
        order_id: "",
        error_code: "",
        error_message: "",
        triggered_manually: "",
        customer_authentication_challenge_url: "",
        completed_at: "",
      },
    ],
    ...overrides,
  };
}
