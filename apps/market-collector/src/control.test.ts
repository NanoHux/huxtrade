import { describe,expect,it } from "vitest";
import { scanningPaused } from "./control.js";

describe("scanningPaused",()=>{
  it("stops collection during a manual global pause",()=>{
    expect(scanningPaused({paused:true},{autoPaused:false})).toBe(true);
  });

  it("stops collection during the automatic margin pause",()=>{
    expect(scanningPaused({paused:false},{autoPaused:true})).toBe(true);
  });

  it("allows collection only when both gates are open",()=>{
    expect(scanningPaused({paused:false},{autoPaused:false})).toBe(false);
  });
});
