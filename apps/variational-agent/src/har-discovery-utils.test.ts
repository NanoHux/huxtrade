import { describe,expect,it } from "vitest";
import { sanitizeHar } from "./har-discovery-utils.js";

describe("Variational HAR sanitization",()=>{
  it("keeps only allowlisted API JSON and removes identity data",()=>{
    const har={log:{entries:[{
      startedDateTime:"2026-08-05T00:00:00.000Z",
      request:{
        method:"post",url:"https://omni.variational.io/api/quotes/indicative?account=secret",
        headers:[{name:"Cookie",value:"session=secret"}],
        postData:{mimeType:"application/json",text:JSON.stringify({instrument:"BTC",walletAddress:"0xabc"})}
      },
      response:{status:200,headers:[{name:"set-cookie",value:"secret"}],content:{mimeType:"application/json",text:JSON.stringify({quote_id:"q1",sessionToken:"secret"})}}
    },{
      request:{method:"GET",url:"https://example.com/api/private"},response:{status:200,content:{mimeType:"application/json",text:"{}"}}
    }]}};
    expect(sanitizeHar(har,new Set(["https://omni.variational.io"]))).toEqual([
      {at:"2026-08-05T00:00:00.000Z",kind:"request",method:"POST",url:"https://omni.variational.io/api/quotes/indicative?account=[REDACTED]",body:{instrument:"BTC",walletAddress:"[REDACTED]"}},
      {at:"2026-08-05T00:00:00.000Z",kind:"response",method:"POST",url:"https://omni.variational.io/api/quotes/indicative?account=[REDACTED]",status:200,contentType:"application/json",body:{quote_id:"q1",sessionToken:"[REDACTED]"}}
    ]);
  });

  it("decodes JSON response bodies exported as base64",()=>{
    const text=Buffer.from(JSON.stringify({result:[{address:"0xabc",qty:"1"}]})).toString("base64");
    const har={log:{entries:[{request:{method:"GET",url:"https://omni.variational.io/api/positions"},response:{status:200,content:{mimeType:"application/json",encoding:"base64",text}}}]}};
    expect(sanitizeHar(har,new Set(["https://omni.variational.io"]))[1]).toMatchObject({body:{result:[{address:"[REDACTED]",qty:"1"}]}});
  });
});

