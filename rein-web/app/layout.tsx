import type { Metadata } from "next";
import "./globals.css";
export const metadata:Metadata={title:"REIN｜馬券アカデミア",description:"馬場・展開・能力・人気を補正して全頭評価と買い目を生成する競馬予想ツール",icons:{icon:"/favicon.svg",shortcut:"/favicon.svg"}};
export default function RootLayout({children}:Readonly<{children:React.ReactNode}>){return <html lang="ja"><body className="antialiased">{children}</body></html>}
