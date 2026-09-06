import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * recordHealth's debounce, exercised against a real Postgres.
 *
 * The bug these cover: one dropped request flipped the service to degraded and
 * the next poll "recovered" it, so a flaky network produced a Telegram message
 * every few hours.
 */
const db = new PGlite();
vi.mock("@huxtrade/config", () => ({ getConfig: () => ({ DATABASE_URL: "postgres://x" }) }));
vi.mock("pg", () => ({ default: { Pool: class { async query(text: string, values: unknown[]) { return db.query(text, values as never[]); } } } }));

const { recordHealth } = await import("./index.js");

const state = async () => (await db.query<{ state: string; consecutive_failures: number }>(
  "SELECT state,consecutive_failures FROM service_health WHERE service='svc'")).rows[0];
const recoveries = async () => Number((await db.query<{ n: string }>(
  "SELECT count(*)::text n FROM outbox WHERE topic='notification.service_recovered'")).rows[0]!.n);
const errors = async () => Number((await db.query<{ n: string }>(
  "SELECT count(*)::text n FROM business_errors WHERE code='SERVICE_HEALTH_FAILURE'")).rows[0]!.n);

beforeEach(async () => {
  await db.exec(`
    DROP TABLE IF EXISTS service_health; DROP TABLE IF EXISTS outbox; DROP TABLE IF EXISTS business_errors;
    CREATE TABLE service_health(service text PRIMARY KEY, state text NOT NULL, last_success_at timestamptz,
      consecutive_failures int NOT NULL DEFAULT 0, error text, blocks_trading boolean NOT NULL DEFAULT false,
      updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE outbox(id bigserial PRIMARY KEY, topic text NOT NULL, payload jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0,
      available_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE business_errors(id bigserial PRIMARY KEY, service text NOT NULL, code text NOT NULL,
      message text NOT NULL, blocks_trading boolean NOT NULL DEFAULT false, occurred_at timestamptz NOT NULL DEFAULT now());
  `);
});

describe("recordHealth", () => {
  it("keeps a single blip off the wire when it is under the threshold", async () => {
    await recordHealth("svc", true, undefined, false, true, 3);
    await recordHealth("svc", false, "Binance API unreachable", true, true, 3);

    expect(await state()).toMatchObject({ state: "healthy", consecutive_failures: 1 });
    await recordHealth("svc", true, undefined, false, true, 3);
    expect(await recoveries()).toBe(0);
    expect(await errors()).toBe(0);
  });

  it("degrades once the failures reach the threshold, then notifies once on recovery", async () => {
    await recordHealth("svc", true, undefined, false, true, 3);
    for (let i = 0; i < 3; i++) await recordHealth("svc", false, "Binance API unreachable", true, true, 3);

    expect(await state()).toMatchObject({ state: "degraded", consecutive_failures: 3 });
    expect(await errors()).toBe(1);

    await recordHealth("svc", true, undefined, false, true, 3);
    expect(await state()).toMatchObject({ state: "healthy", consecutive_failures: 0 });
    expect(await recoveries()).toBe(1);
  });

  it("does not re-log the same error on every failed poll while degraded", async () => {
    for (let i = 0; i < 6; i++) await recordHealth("svc", false, "same message", true, true, 3);
    expect(await errors()).toBe(1);
  });

  it("resets the count so a later blip starts over rather than accumulating", async () => {
    await recordHealth("svc", false, "boom", true, true, 3);
    await recordHealth("svc", false, "boom", true, true, 3);
    await recordHealth("svc", true, undefined, false, true, 3);
    await recordHealth("svc", false, "boom", true, true, 3);

    expect(await state()).toMatchObject({ state: "healthy", consecutive_failures: 1 });
    expect(await recoveries()).toBe(0);
  });

  it("still degrades on the first failure at the default threshold", async () => {
    await recordHealth("svc", true);
    await recordHealth("svc", false, "down");
    expect(await state()).toMatchObject({ state: "degraded", consecutive_failures: 1 });
    await recordHealth("svc", true);
    expect(await recoveries()).toBe(1);
  });
});
