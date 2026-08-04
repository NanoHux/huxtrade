"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
const links=[
 ["/","⌁","总览"],["/assets","◫","币种管理"],["/strategies","◇","策略管理"],["/orders","⇄","订单与持仓"],["/statistics","⌗","统计"],["/system","⚙","系统与健康"]
];
export function Sidebar(){const pathname=usePathname();return <aside className="sidebar">
 <div className="brand"><span className="brandMark">V</span><div><b>VARIATIONAL</b><small>MARKET SYSTEM</small></div></div>
 <nav>{links.map(([href,icon,label])=><Link className={pathname===href?"active":""} href={href!} key={href}><span>{icon}</span>{label}</Link>)}</nav>
 <div className="sidebarFoot"><span className="pulse"/><div><b>V1 · 内测</b><small>UTC+8 · 本机访问</small></div></div>
 </aside>}
