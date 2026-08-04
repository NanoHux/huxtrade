export function Header({title,eyebrow}:{title:string;eyebrow:string}){return <header className="topbar"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1></div><div className="topActions"><span className="timeTag">UTC+8</span><span className="avatar">NH</span></div></header>}

