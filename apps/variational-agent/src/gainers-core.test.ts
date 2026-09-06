import { describe,expect,it } from "vitest";
import { ALIAS_PRICE_TOLERANCE,resolveByPrice,type VenueAsset } from "./gainers-core.js";

const venue=(entries:Record<string,Partial<VenueAsset>&{price:number}>)=>
  new Map(Object.entries(entries).map(([k,v])=>[k,{change:0,tradable:true,...v}]));

describe("alias resolution by price",()=>{
  // The band is wide because the board selects for violent movers and the two
  // venues are read seconds apart; the pairs below are the separations that
  // actually have to survive it.
  it("accepts a same-asset gap that a fast move can open",()=>{
    expect(resolveByPrice("APR",0.1923,venue({APRO:{price:0.2050}}))).toBe("APRO");
  });
  it("refuses different assets whose names overlap",()=>{
    // Observed near-misses: AIO/AIOT sit 29% apart, SKY/SKYAI 30%.
    expect(resolveByPrice("AIO",0.06423,venue({AIOT:{price:0.04552}}))).toBeNull();
    expect(resolveByPrice("SKYAI",0.06815,venue({SKY:{price:0.05238}}))).toBeNull();
  });
  it("keeps a margin between the band and the closest real collision",()=>{
    expect(ALIAS_PRICE_TOLERANCE).toBeLessThan(0.29/2);
  });
  it("refuses a name the venue cannot open even when the price agrees",()=>{
    expect(resolveByPrice("APR",0.1923,venue({APRO:{price:0.1923,tradable:false}}))).toBeNull();
  });
  it("refuses rather than guess when two candidates both fit",()=>{
    expect(resolveByPrice("SNX",0.1982,venue({SNXX:{price:0.1990},SNXA:{price:0.1975}}))).toBeNull();
  });
});
