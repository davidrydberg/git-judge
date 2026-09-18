import { beforeAll, expect, test } from "vitest";
import { canRefund, orderTotalCents, subtotalCents } from "../src/orders";

beforeAll(() => {
  process.env.DATABASE_URL = "postgres://localhost/shop_test";
});

test("subtotal multiplies price by quantity", () => {
  expect(subtotalCents([{ priceCents: 1000, quantity: 2 }, { priceCents: 500, quantity: 1 }])).toBe(2500);
});

test("total applies the discount before VAT", () => {
  expect(orderTotalCents([{ priceCents: 10000, quantity: 1 }], 10)).toBe(11250);
});

test("total is always whole cents", () => {
  // 999 * 0.67 = 669.33, rounded to 669, plus 25% VAT = 836.25, rounded to 836.
  expect(orderTotalCents([{ priceCents: 999, quantity: 1 }], 33)).toBe(836);
});

test("only an admin can refund, and only up to the limit", () => {
  const admin = { id: "a", role: "admin" as const, disabled: false, failedLogins: 0 };
  const staff = { ...admin, role: "staff" as const };
  expect(canRefund(admin, 100_00)).toBe(true);
  expect(canRefund(admin, 900_00)).toBe(false);
  expect(canRefund(staff, 100_00)).toBe(false);
});
