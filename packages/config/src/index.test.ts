import { describe,expect,it } from "vitest";
import { resolveConfiguredPath } from "./index.js";

describe("resolveConfiguredPath",()=>{
  it("resolves relative runtime paths beside the root env file",()=>{
    expect(resolveConfiguredPath("./playwright-profile","/workspace/huxtrade/.env")).toBe("/workspace/huxtrade/playwright-profile");
  });

  it("preserves absolute runtime paths",()=>{
    expect(resolveConfiguredPath("/private/var/huxtrade/profile","/workspace/huxtrade/.env")).toBe("/private/var/huxtrade/profile");
  });
});
