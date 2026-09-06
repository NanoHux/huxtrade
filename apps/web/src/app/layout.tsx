import type { Metadata } from "next";
import "./globals.css";
import "./navigation.css";
import "./settings.css";
import "./calendar.css";
import { Sidebar } from "../components/Sidebar";
export const metadata:Metadata={title:"HuxTrade",description:"Multi-platform momentum trading system"};
export default function RootLayout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body><div className="app"><Sidebar/><main className="main">{children}</main></div></body></html>}
