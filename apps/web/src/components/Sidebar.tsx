"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
const links=[
 ["/","⌁","总览"],["/calendar","▦","日历"],["/system","⚙","系统"]
];
export function Sidebar(){const pathname=usePathname();return <aside className="sidebar">
 <div className="brand"><span className="brandMark">H</span><div><b>HUXTRADE</b><small>MOMENTUM</small></div></div>
 <nav>{links.map(([href,icon,label])=><Link className={pathname===href?"active":""} href={href!} key={href}><span>{icon}</span>{label}</Link>)}</nav>
 <div className="sidebarFoot"><span className="pulse"/><div><b>V2 · 多平台</b><small>UTC+8 · 本机访问</small></div></div>
 </aside>}
