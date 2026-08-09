import { describe,expect,it } from "vitest";
import { isTransientVenueRejection,summariseRejection,VariationalRequestError,isRetryableEntryRejection,looksLikeNothingListening } from "./browser-fetch-transport.js";

describe("isRetryableEntryRejection",()=>{
  it("retries a 4xx from the order-creation call itself, matching the real ZRO HTTP 400 failure",()=>{
    expect(isRetryableEntryRejection(new VariationalRequestError(400,"/api/orders/new/limit"))).toBe(true);
    expect(isRetryableEntryRejection(new VariationalRequestError(422,"/api/orders/new/limit"))).toBe(true);
  });

  it("never retries a 5xx — the server may still have processed the request",()=>{
    expect(isRetryableEntryRejection(new VariationalRequestError(500,"/api/orders/new/limit"))).toBe(false);
    expect(isRetryableEntryRejection(new VariationalRequestError(503,"/api/orders/new/limit"))).toBe(false);
  });

  it("never retries a 4xx from any other endpoint — only the order-creation call is provably a no-op on rejection",()=>{
    expect(isRetryableEntryRejection(new VariationalRequestError(400,"/api/quotes/indicative"))).toBe(false);
    expect(isRetryableEntryRejection(new VariationalRequestError(400,"/api/settlement_pools/leverage"))).toBe(false);
  });

  it("never retries a plain network/timeout error — genuinely ambiguous, must go through reconciliation",()=>{
    expect(isRetryableEntryRejection(new Error("Variational browser fetch /api/orders/new/limit timed out after 20000ms"))).toBe(false);
    expect(isRetryableEntryRejection(new TypeError("fetch failed"))).toBe(false);
  });
});

describe("looksLikeNothingListening",()=>{
  it("recognizes connection-refused errors — the real symptom when the dedicated Chrome window crashed or was closed",()=>{
    expect(looksLikeNothingListening(new Error("connect ECONNREFUSED 127.0.0.1:9222"))).toBe(true);
    expect(looksLikeNothingListening(new Error("browserType.connectOverCDP: Failed to connect: connect ECONNREFUSED 127.0.0.1:9222"))).toBe(true);
  });

  it("does not treat a reachable-but-not-logged-in session as a relaunch case — a relaunch can't fix that",()=>{
    expect(looksLikeNothingListening(new Error("Variational browser is not on the configured origin; login or CAPTCHA may be blocking it"))).toBe(false);
    expect(looksLikeNothingListening(new Error("The Chrome CDP endpoint has no browser context"))).toBe(false);
  });
});

describe("rejection bodies",()=>{
  it("surfaces the platform's own reason so a 4xx is diagnosable",()=>{
    expect(summariseRejection({message:"leverage 5 not supported for JUP"})).toBe("leverage 5 not supported for JUP");
    expect(summariseRejection({error:"limit price outside allowed band"})).toBe("limit price outside allowed band");
    expect(summariseRejection({code:422,fields:["qty"]})).toBe('{"code":422,"fields":["qty"]}');
    expect(summariseRejection("plain text reason")).toBe("plain text reason");
  });

  it("stays readable in an audit trail",()=>{
    expect(summariseRejection(null)).toBeUndefined();
    expect(summariseRejection({})).toBeUndefined();
    expect(summariseRejection({message:"x".repeat(400)})!.length).toBe(301);
    expect(summariseRejection({message:"x".repeat(400)})!.endsWith("…")).toBe(true);
  });
});

describe("transient venue rejections",()=>{
  const skew='{"error_code":"skew_limit_exceeded","error_message":"The skew (long OI minus short OI) on this asset is too large"}';

  it("separates a lopsided book from a structurally broken asset",()=>{
    expect(isTransientVenueRejection(new VariationalRequestError(422,"/api/orders/new/limit",skew))).toBe(true);
    // Same status, different cause: this one really is the asset's problem.
    expect(isTransientVenueRejection(new VariationalRequestError(422,"/api/orders/new/limit",'{"error_code":"leverage_not_supported"}'))).toBe(false);
    expect(isTransientVenueRejection(new VariationalRequestError(422,"/api/orders/new/limit"))).toBe(false);
    expect(isTransientVenueRejection(new Error("boom"))).toBe(false);
  });

  it("still counts as a definite rejection, so nothing is left ambiguous",()=>{
    // It must stay SUBMISSION_FAILED rather than UNKNOWN — a 4xx means the
    // platform parsed and refused, so nothing was created server-side.
    const error=new VariationalRequestError(422,"/api/orders/new/limit",skew);
    expect(error.status>=400&&error.status<500).toBe(true);
    expect(isRetryableEntryRejection(error)).toBe(true);
  });
});
