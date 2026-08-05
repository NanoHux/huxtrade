import { describe, expect, it } from "vitest";
import { timestampIso } from "./time.js";

describe("timestampIso", () => {
  it("normalizes PostgreSQL Date objects to an ISO timestamp", () => {
    expect(timestampIso(new Date("2026-08-05T05:45:00.000Z"))).toBe("2026-08-05T05:45:00.000Z");
  });

  it("repairs legacy JavaScript Date strings stored in app_state", () => {
    expect(timestampIso("Wed Aug 05 2026 13:45:00 GMT+0800 (China Standard Time)")).toBe("2026-08-05T05:45:00.000Z");
  });

  it("rejects unusable cursor values", () => {
    expect(timestampIso("not-a-timestamp")).toBeNull();
  });
});
