"use client";
import { useState } from "react";
import { publicApi } from "../lib/api";
export function ControlButton({paused}:{paused:boolean}){const [busy,setBusy]=useState(false);async function toggle(){setBusy(true);try{await fetch(`${publicApi}/api/control/global`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({paused:!paused,reason:!paused?"Dashboard manual pause":null})});location.reload();}finally{setBusy(false)}}return <button className={paused?"btn primary":"btn danger"} disabled={busy} onClick={toggle}>{busy?"处理中…":paused?"恢复全局扫描":"暂停全部交易"}</button>}

