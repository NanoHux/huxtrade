import { describe,expect,it } from "vitest";
import { discoveryJsonBody,discoverySafeUrl,redactDiscoveryValue } from "./discovery-utils.js";

describe("Variational discovery redaction",()=>{
  it("recursively removes credentials and identity fields",()=>{
    expect(redactDiscoveryValue({order:{price:100,walletAddress:"0xabc"},sessionToken:"token",items:[{signature:"sig",quantity:2}]})).toEqual({
      order:{price:100,walletAddress:"[REDACTED]"},sessionToken:"[REDACTED]",items:[{signature:"[REDACTED]",quantity:2}]
    });
  });
  it("keeps query names but removes every query value",()=>{
    expect(discoverySafeUrl("https://trade.variational.io/api/orders?account=abc&cursor=secret")).toBe("https://trade.variational.io/api/orders?account=[REDACTED]&cursor=[REDACTED]");
  });
  it("never records opaque request bodies",()=>{
    expect(discoveryJsonBody("wallet=secret")).toBe("[NON_JSON_BODY]");
  });
});
