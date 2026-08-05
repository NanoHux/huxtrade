"use client";
import { useState } from "react";
import type { Asset } from "@huxtrade/shared-types";
import { ControlButton } from "./ControlButton";
import { publicApi } from "../lib/api";

/**
 * Spec 12.2 快捷控制: global pause/resume, per-asset pause/resume and the
 * Telegram re-test must all be reachable from the Dashboard itself — including
 * while live trading is enabled, which is exactly when a stop is needed.
 */
export function QuickControls({ globalPaused, assets }: { globalPaused: boolean; assets: Asset[] }) {
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [assetId, setAssetId] = useState(assets[0]?.id ?? "");
  const selected = assets.find((asset) => asset.id === assetId);

  async function toggleAsset() {
    if (!selected) return;
    setBusy("asset");
    try {
      const response = await fetch(`${publicApi}/api/control/assets/${selected.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paused: !selected.paused, reason: !selected.paused ? "Dashboard manual pause" : null })
      });
      if (!response.ok) { setMessage(`${selected.code} 操作失败`); return; }
      location.reload();
    } finally { setBusy(""); }
  }

  async function retestTelegram() {
    setBusy("telegram");
    setMessage("正在读取本机密钥并发送测试消息…");
    try {
      const secrets = await fetch(`${publicApi}/api/settings/secrets/telegram`);
      if (!secrets.ok) { setMessage("读取本机 Telegram 密钥失败"); return; }
      const body = await secrets.json();
      if (!body.botToken || !body.chatId) { setMessage("尚未配置 Telegram，请前往系统设置"); return; }
      const test = await fetch(`${publicApi}/api/settings/telegram/test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ botToken: body.botToken, chatId: body.chatId })
      });
      if (!test.ok) { setMessage("测试失败，Telegram 仍处于异常状态"); return; }
      const result = await test.json();
      setMessage(result.recovered ? "测试成功，Telegram 服务已恢复" : "测试消息发送成功");
    } catch (error) {
      setMessage(`测试失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally { setBusy(""); }
  }

  return (
    <section className="panel">
      <div className="panelHead">
        <div><h2>快捷控制</h2><small>全局暂停 · 单币暂停/恢复 · Telegram 重新测试</small></div>
        <span className={`tag ${globalPaused ? "red" : ""}`}>{globalPaused ? "GLOBAL PAUSED" : "RUNNING"}</span>
      </div>
      <div className="toolbar" style={{ flexWrap: "wrap" }}>
        <ControlButton paused={globalPaused}/>
        <select
          aria-label="选择币种"
          value={assetId}
          onChange={(event) => { setAssetId(event.target.value); setMessage(""); }}
          style={{ background: "#071217", border: "1px solid var(--line)", color: "var(--text)", padding: "9px 11px" }}
        >
          {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.code}{asset.paused ? " · PAUSED" : ""}</option>)}
          {!assets.length && <option value="">暂无币种</option>}
        </select>
        <button className={selected?.paused ? "btn primary" : "btn"} disabled={!selected || busy === "asset"} onClick={toggleAsset}>
          {busy === "asset" ? "处理中…" : selected?.paused ? `手动恢复 ${selected.code}` : `暂停 ${selected?.code ?? ""}`}
        </button>
        <button className="btn" disabled={busy === "telegram"} onClick={retestTelegram}>
          {busy === "telegram" ? "测试中…" : "Telegram 重新测试"}
        </button>
        <span className="subtle">{message}</span>
      </div>
      {selected?.paused && <p className="subtle" style={{ marginBottom: 0 }}>暂停原因：{selected.pauseReason ?? "—"}（系统不会自动恢复）</p>}
    </section>
  );
}
