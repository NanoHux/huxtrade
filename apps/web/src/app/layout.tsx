import type { Metadata } from "next";
import "./globals.css";
import "./navigation.css";
import "./chart.css";
import "./settings.css";
import { Sidebar } from "../components/Sidebar";
export const metadata:Metadata={title:"HuxTrade · Variational Market System",description:"Deterministic crypto market analysis and execution console"};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body><div className="app"><Sidebar/><main className="main">{children}</main></div></body></html>}
