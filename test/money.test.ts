import { describe, expect, it } from "vitest";
import { formatCents, percentOf } from "../src/money.js";

describe("percentOf", () => {
  it("rounds down to the cent", () => {
    // 10% of 3333 cents is 333.3, the store keeps the 0.3 of a cent
    expect(percentOf(3333, 10)).toBe(333);
    expect(percentOf(1, 50)).toBe(0);
  });

  it("never exceeds the amount, even at 100%", () => {
    expect(percentOf(8999, 100)).toBe(8999);
  });

  it("stays exact where float maths would drift", () => {
    // 0.07 * 100 style bugs show up here if percentages are applied as floats
    expect(percentOf(1999, 7)).toBe(139);
    expect(percentOf(29, 100)).toBe(29);
  });

  it("rejects fractional or out of range input", () => {
    expect(() => percentOf(100, 10.5)).toThrow();
    expect(() => percentOf(100, 101)).toThrow();
    expect(() => percentOf(100.5, 10)).toThrow();
    expect(() => percentOf(-1, 10)).toThrow();
  });
});

describe("formatCents", () => {
  it("pads the cents", () => {
    expect(formatCents(8999)).toBe("$89.99");
    expect(formatCents(5)).toBe("$0.05");
  });
});
