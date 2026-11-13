import { describe, it, expect } from "vitest";
import {
  parseMoneyCents,
  parseLabelCost,
  parseWeightLb,
  parseLengthIn,
  parseShipHeroDate,
  shopifyOrderGid,
  toShipHeroRows,
  INCLUDED_LABEL_STATUSES,
  type RawShipment,
} from "@/domain/economics/shiphero-transform";

const SYNCED = new Date("2026-11-13T12:00:00Z");

// As ShipHero returned RH361008 on 2026-11-13.
const rh361008: RawShipment = {
  id: "U2hpcG1lbnQ6NDAwMDAwMDAx",
  legacy_id: 400000001,
  created_date: "2026-11-09T18:32:28",
  total_packages: 1,
  shipped_off_shiphero: false,
  refunded: false,
  dropshipment: false,
  order: {
    order_number: "RH361008",
    partner_order_id: "19014930497781",
    shop_name: "Rad and Happy",
    order_date: "2026-11-08T21:10:00",
    source: "shopify",
    shipping_lines: { title: "Free Shipping", carrier: "", method: "", price: "0.00" },
  },
  shipping_labels: [
    {
      id: "U2hpcHBpbmdMYWJlbDo5MDAwMDAwMDE=",
      carrier: "usps_modern",
      shipping_name: "USPS Media Mail",
      shipping_method: "MEDIA_MAIL",
      cost: "8.25",
      status: "valid",
      refunded: false,
      created_date: "2026-11-09T18:32:28",
      package_number: 1,
      box_name: "10x8x4",
      carrier_account_id: "55501",
      source: "shiphero",
      dimensions: { weight: "3.6500 lb", height: "4.0000 inch", width: "8.0000 inch", length: "10.0000 inch" },
    },
  ],
};

describe("parseMoneyCents", () => {
  it("reads ShipHero's decimal strings in dollars", () => {
    expect(parseMoneyCents("8.25")).toBe(825);
    expect(parseMoneyCents("10.28")).toBe(1028);
    expect(parseMoneyCents("0.00")).toBe(0);
  });

  it("is null for anything that is not a number, never zero", () => {
    expect(parseMoneyCents(null)).toBeNull();
    expect(parseMoneyCents("")).toBeNull();
    expect(parseMoneyCents("—")).toBeNull();
  });
});

describe("parseLabelCost", () => {
  // A label billed to a carrier account the 3PL does not invoice reports
  // 0.00 — every DHL eCommerce label seen. Unknown, not free.
  it("stores a 0.00 label cost as unknown", () => {
    expect(parseLabelCost("0.00")).toEqual({ cents: null, basis: "zero-reported" });
  });

  it("keeps a real cost", () => {
    expect(parseLabelCost("8.25")).toEqual({ cents: 825, basis: "reported" });
  });

  it("says when there was no cost at all", () => {
    expect(parseLabelCost(null)).toEqual({ cents: null, basis: "absent" });
  });
});

describe("units", () => {
  it("parses pounds and ounces into pounds", () => {
    expect(parseWeightLb("3.6500 lb")).toBe(3.65);
    expect(parseWeightLb("8.0000 oz")).toBe(0.5);
  });

  it("parses inches and centimetres into inches", () => {
    expect(parseLengthIn("4.0000 inch")).toBe(4);
    expect(parseLengthIn("10 in")).toBe(10);
    expect(parseLengthIn("2.54 cm")).toBeCloseTo(1, 6);
  });

  // Never assume pounds or inches.
  it("is null for a unit it does not recognise, or none", () => {
    expect(parseWeightLb("3.65")).toBeNull();
    expect(parseWeightLb("3.65 stone")).toBeNull();
    expect(parseLengthIn("4.0000")).toBeNull();
    expect(parseLengthIn("4 furlong")).toBeNull();
    expect(parseWeightLb(null)).toBeNull();
  });
});

describe("parseShipHeroDate", () => {
  // Dates come back in UTC with no zone suffix.
  it("reads a zoneless date as UTC", () => {
    expect(parseShipHeroDate("2026-11-09T18:32:28")?.toISOString()).toBe("2026-11-09T18:32:28.000Z");
  });

  it("keeps an explicit zone", () => {
    expect(parseShipHeroDate("2026-11-09T18:32:28+00:00")?.toISOString()).toBe("2026-11-09T18:32:28.000Z");
  });

  it("is null for nothing or nonsense", () => {
    expect(parseShipHeroDate(null)).toBeNull();
    expect(parseShipHeroDate("soon")).toBeNull();
  });
});

describe("shopifyOrderGid", () => {
  it("builds the Shopify order id from partner_order_id", () => {
    expect(shopifyOrderGid("19014930497781")).toBe("gid://shopify/Order/19014930497781");
  });

  it("is null when partner_order_id is not a Shopify order number", () => {
    expect(shopifyOrderGid("MO31")).toBeNull();
    expect(shopifyOrderGid(null)).toBeNull();
  });
});

describe("toShipHeroRows", () => {
  it("resolves RH361008 to one Media Mail label at 825 cents, 3.65lb, nothing charged", () => {
    const { shipment, labels } = toShipHeroRows(rh361008, SYNCED);
    expect(shipment).toMatchObject({
      id: rh361008.id,
      legacyId: 400000001,
      orderNumber: "RH361008",
      partnerOrderId: "19014930497781",
      shopifyOrderId: "gid://shopify/Order/19014930497781",
      shippingChargedCents: 0,
      shippingLineTitle: "Free Shipping",
      totalPackages: 1,
      refunded: 0,
      syncedAt: SYNCED,
    });
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      id: rh361008.shipping_labels![0].id,
      shipmentId: rh361008.id,
      carrier: "usps_modern",
      shippingMethod: "MEDIA_MAIL",
      costCents: 825,
      costBasis: "reported",
      status: "valid",
      weightLb: 3.65,
      lengthIn: 10,
      widthIn: 8,
      heightIn: 4,
      boxName: "10x8x4",
    });
  });

  it("stores the DHL eCommerce 0.00 labels as unknown cost", () => {
    const dhl: RawShipment = {
      ...rh361008,
      order: { ...rh361008.order!, order_number: "RH344584" },
      shipping_labels: [{ ...rh361008.shipping_labels![0], carrier: "dhl_ecommerce", shipping_method: "BGN", carrier_account_id: "124469", cost: "0.00" }],
    };
    expect(toShipHeroRows(dhl, SYNCED).labels[0]).toMatchObject({ costCents: null, costBasis: "zero-reported" });
  });

  it("takes the shipping line when ShipHero gives a list", () => {
    const listed = { ...rh361008, order: { ...rh361008.order!, shipping_lines: [{ title: "Standard", carrier: "x", method: "y", price: "8.60" }] } } as unknown as RawShipment;
    expect(toShipHeroRows(listed, SYNCED).shipment).toMatchObject({ shippingChargedCents: 860, shippingLineTitle: "Standard" });
  });

  it("keeps a shipment with no order and no labels", () => {
    const bare: RawShipment = { ...rh361008, order: null, shipping_labels: null };
    const rows = toShipHeroRows(bare, SYNCED);
    expect(rows.shipment).toMatchObject({ orderNumber: null, shopifyOrderId: null, shippingChargedCents: null });
    expect(rows.labels).toEqual([]);
  });

  // Customer details are not selected, and must not survive if ever returned.
  it("carries no customer field into either row", () => {
    const leaky = { ...rh361008, address: { name: "A Person", address1: "1 Street" }, order: { ...rh361008.order!, email: "a@b.c" } } as unknown as RawShipment;
    const { shipment, labels } = toShipHeroRows(leaky, SYNCED);
    const text = JSON.stringify({ shipment, labels });
    expect(text).not.toMatch(/A Person|1 Street|a@b\.c/);
  });
});

describe("INCLUDED_LABEL_STATUSES", () => {
  // Only what has been seen to mean a live label; anything else is excluded
  // and reported, never guessed into a cost.
  it("is exactly the statuses observed as live", () => {
    expect(INCLUDED_LABEL_STATUSES).toEqual(["valid"]);
  });
});
