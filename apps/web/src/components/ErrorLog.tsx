"use client";
import { useState } from "react";

type ErrorRow=Record<string,unknown>;
const pageSize=10;
const time=(value:unknown)=>value?new Date(String(value)).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}):"—";
const truncate=(value:string,max=140)=>value.length>max?`${value.slice(0,max)}…`:value;

export function ErrorLog({errors}:{errors:ErrorRow[]}){
  const [page,setPage]=useState(0);
  const pageCount=Math.max(1,Math.ceil(errors.length/pageSize));
  const rows=errors.slice(page*pageSize,page*pageSize+pageSize);
  return <section className="panel">
    <div className="panelHead">
      <div><h2>永久错误记录</h2><small>共 {errors.length} 条 · 数据库不自动清理</small></div>
      <div className="toolbar">
        <button className="btn" disabled={page===0} onClick={()=>setPage((p)=>Math.max(0,p-1))}>上一页</button>
        <span className="subtle">{page+1} / {pageCount}</span>
        <button className="btn" disabled={page>=pageCount-1} onClick={()=>setPage((p)=>Math.min(pageCount-1,p+1))}>下一页</button>
      </div>
    </div>
    <table><thead><tr><th>发生时间</th><th>服务</th><th>币种</th><th>代码</th><th>错误</th><th>交易</th></tr></thead>
      <tbody>{rows.map((error)=><tr key={String(error.id)}>
        <td>{time(error.occurred_at)}</td>
        <td>{String(error.service)}</td>
        <td>{String(error.asset_code??"—")}</td>
        <td className="mono">{String(error.code)}</td>
        <td className="subtle" title={String(error.message)}>{truncate(String(error.message))}</td>
        <td className={error.blocks_trading?"down":"up"}>{error.blocks_trading?"阻断":"不阻断"}</td>
      </tr>)}
      {!rows.length&&<tr><td colSpan={6} className="empty">尚无业务错误记录</td></tr>}
      </tbody>
    </table>
  </section>;
}
