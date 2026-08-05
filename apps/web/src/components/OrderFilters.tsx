"use client";
import { useRouter } from "next/navigation";
import { orderStates } from "@huxtrade/shared-types";

/**
 * Spec 12.4: the order view is read-only but must be filterable. The state
 * lives in the URL so a filtered view can be refreshed or bookmarked.
 */
export function OrderFilters({ state, code, codes }: { state: string; code: string; codes: string[] }) {
  const router = useRouter();
  const apply = (next: { state?: string; code?: string }) => {
    const params = new URLSearchParams();
    const nextState = next.state ?? state;
    const nextCode = next.code ?? code;
    if (nextState) params.set("state", nextState);
    if (nextCode) params.set("code", nextCode);
    const query = params.toString();
    router.push(query ? `/orders?${query}` : "/orders");
  };
  const style = { background: "#071217", border: "1px solid var(--line)", color: "var(--text)", padding: "8px 10px", fontSize: 11 };
  return (
    <div className="toolbar" style={{ flexWrap: "wrap" }}>
      <select aria-label="按状态筛选" value={state} onChange={(event) => apply({ state: event.target.value })} style={style}>
        <option value="">全部状态</option>
        {orderStates.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
      <select aria-label="按币种筛选" value={code} onChange={(event) => apply({ code: event.target.value })} style={style}>
        <option value="">全部币种</option>
        {codes.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
      {(state || code) && <button className="btn" onClick={() => router.push("/orders")}>清除筛选</button>}
    </div>
  );
}
