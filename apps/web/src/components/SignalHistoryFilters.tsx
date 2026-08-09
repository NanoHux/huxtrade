"use client";
import { useRouter } from "next/navigation";

type Option={id:string;label:string};

export function SignalHistoryFilters({assetId,strategyId,assets,strategies}:{assetId:string;strategyId:string;assets:Option[];strategies:Option[]}){
  const router=useRouter();
  const apply=(next:{assetId?:string;strategyId?:string})=>{
    const params=new URLSearchParams();
    const nextAsset=next.assetId??assetId;
    const nextStrategy=next.strategyId??strategyId;
    if(nextAsset)params.set("assetId",nextAsset);
    if(nextStrategy)params.set("strategyId",nextStrategy);
    const query=params.toString();
    router.push(query?`/statistics?${query}`:"/statistics");
  };
  const style={background:"#071217",border:"1px solid var(--line)",color:"var(--text)",padding:"8px 10px",fontSize:11};
  return <div className="toolbar" style={{flexWrap:"wrap"}}>
    <select aria-label="按币种筛选" value={assetId} onChange={(event)=>apply({assetId:event.target.value})} style={style}>
      <option value="">全部币种</option>
      {assets.map((option)=><option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
    <select aria-label="按策略筛选" value={strategyId} onChange={(event)=>apply({strategyId:event.target.value})} style={style}>
      <option value="">全部策略</option>
      {strategies.map((option)=><option key={option.id} value={option.id}>{option.label}</option>)}
    </select>
    {(assetId||strategyId)&&<button className="btn" onClick={()=>router.push("/statistics")}>清除筛选</button>}
  </div>;
}
