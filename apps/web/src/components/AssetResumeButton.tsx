"use client";
import { useState } from "react";
import { publicApi } from "../lib/api";

/**
 * Spec 10.2 / 12.4: a per-asset pause never clears itself. The system health
 * page is where the operator sees why it paused, so the manual resume lives
 * right next to the reason.
 */
export function AssetResumeButton({ assetId, code, paused }: { assetId: string; code: string; paused: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function toggle() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${publicApi}/api/control/assets/${assetId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused: !paused, reason: !paused ? "System health manual pause" : null })
      });
      if (!response.ok) { setError("操作失败"); return; }
      location.reload();
    } finally { setBusy(false); }
  }
  return <div className="toolbar">
    <button className={paused ? "btn primary" : "btn"} disabled={busy} onClick={toggle}>
      {busy ? "处理中…" : paused ? `手动恢复 ${code}` : "暂停"}
    </button>
    {error && <span className="subtle">{error}</span>}
  </div>;
}
