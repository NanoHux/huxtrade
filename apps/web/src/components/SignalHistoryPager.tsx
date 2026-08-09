"use client";
import { useRouter } from "next/navigation";

export function SignalHistoryPager({page,pageCount,assetId,strategyId}:{page:number;pageCount:number;assetId:string;strategyId:string}){
  const router=useRouter();
  const go=(next:number)=>{
    const params=new URLSearchParams();
    if(assetId)params.set("assetId",assetId);
    if(strategyId)params.set("strategyId",strategyId);
    if(next>0)params.set("page",String(next+1));
    const query=params.toString();
    router.push(query?`/statistics?${query}`:"/statistics");
  };
  return <div className="toolbar">
    <button className="btn" disabled={page<=0} onClick={()=>go(page-1)}>上一页</button>
    <span className="subtle">{page+1} / {pageCount}</span>
    <button className="btn" disabled={page>=pageCount-1} onClick={()=>go(page+1)}>下一页</button>
  </div>;
}
