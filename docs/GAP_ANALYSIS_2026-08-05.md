# 需求规格 V1.0 对照差距分析（2026-08-05）

> **修复状态**：A1～A7、B1～B6、C1、C3 已在同日修复，逐项说明见
> `docs/REQUIREMENTS_TRACEABILITY.md` 的「2026-08-05 差距分析修复轮」。
> **仍未关闭**：A8（Variational 阶段 0 协议发现）与 B4（撤单范围，已确认接受
> 「只撤受管订单」）。本文保留为修复前的原始记录。


对照文件：`加密市场分析与Variational自动交易系统_需求规格说明书_V1.0.docx`
核查方式：逐章通读规格 + 通读全部业务源码（3.5k 行）+ 全 workspace `tsc --noEmit` 通过（12 个 project）。
未执行：`pnpm test`（仓库 `node_modules` 是 macOS arm64 产物，Linux 沙箱缺 rollup 原生模块，请在本机运行）。

---

## 总体判断

骨架、数据链路、指标、策略、状态机、Outbox、健康与错误留痕**基本完成**，规格第 3～11、13、14 章的后端逻辑覆盖度很高。
真正的缺口集中在三处：**① Dashboard 前端未做完；② Variational 阶段 0 协议发现未收口；③ 几处策略/精度细节与规格字面不一致。**

---

## A. 尚未完成（规格明确要求，代码中缺失）

### A1. Dashboard 首页缺「订单与持仓」模块 — §12.2

`/api/dashboard` 已返回 `orders`，但 `apps/web/src/app/page.tsx` 从未渲染。
规格要求首页展示：未成交订单、开放持仓、入场/TP/SL、当前 PnL、状态更新时间 —— 目前全部缺失。

### A2. 首页「快捷控制」不完整，且实盘时暂停按钮会消失 — §12.2

```tsx
{!data.liveTradingEnabled && <div className="alertStrip"> … <ControlButton/> </div>}
```

全局暂停按钮被嵌在「安全门已关闭」提示条内。**一旦 `LIVE_TRADING_ENABLED=true`，提示条消失，暂停按钮随之消失** —— 恰好在真实资金运行时失去一键急停。属于安全性缺陷，优先级最高。
另外规格要求首页同时具备「单币手动暂停/恢复」和「Telegram 重新测试」，目前都只在子页面。

### A3. 系统健康页缺「单币手动恢复」 — §12.4

`apps/web/src/app/system/page.tsx` 只展示 `paused` / `pause_reason`，没有恢复按钮。规格明确要求系统健康页具备"单币暂停和手动恢复"。

### A4. 订单与持仓页缺筛选 — §12.4

规格："只读查看、**筛选**和跳转 Variational"。API `/api/orders?state=` 已支持，UI 未提供任何筛选控件。

### A5. 系统设置页只覆盖 Telegram 密钥 — §12.4 / §13.2

规格要求后台可对「Binance、CoinGlass、Telegram 等密钥」做「测试 → 保存 → 重启相关服务」。
现状：CoinGlass 的 `COINGLASS_OBE` 与浏览器指纹只能通过命令行 `discover:har` 导入，后台无入口；会话失效时必须回到终端操作。

### A6. 密钥更新后的「重启失败」处理未实现 — §10.3 / §11.1

`/api/settings/telegram/save` 只写了一条 `service.restart_requested` 到 outbox，之后**没有任何重启结果跟踪**。规格要求：重启失败时保留新密钥、Dashboard 标记服务异常、并尝试发送 Telegram。

### A7. K 线图能力不足 — §12.3

`MarketChart` 硬编码 `symbol="BTCUSDT"`，无法查看白名单其他币；Heatmap 只画**最强一条水平线**而非"目标区域"（区间带）；订单标记只取 `orders.at(-1)` 一笔。规格要求"标记策略信号、限价入场、TP、SL 和 Heatmap 目标区域"。

### A8. 阶段 0：Variational 协议发现尚未收口 — §9.1 / §15

`DISCOVERY.md` 自述仍有 4 项 Partial，未完成的是：

- 限价入场从挂单到成交/撤销的完整生命周期响应
- 主动撤单的成功/错误响应
- 超时、限流等**模糊结果**的平台行为（目前一律进 `UNKNOWN` 不重试，做法正确但未验证）
- 登录自然过期的状态码与重新登录流程

规格结论段明确写："未经该阶段验证，不进入真实下单执行器的正式实现。"
这是阻塞**阶段 6 真实资金验收**的唯一硬门槛，也导致 AC-08 / AC-09 / AC-11 无法结案。

---

## B. 已实现但与规格有偏差（建议修正或确认）

### B1. §7.3「反向阻挡」只在回退路径生效 — 逻辑缺口

`packages/strategy-engine/src/index.ts`：

```ts
const fallbackBlocked = !target && input.regions.some(…)
```

`!target` 意味着**只有在找不到合格 Heatmap 目标、使用固定 1.5R 时才检查反向阻挡**。当 `chooseHeatmapTarget` 找到目标区域时，入场价到目标之间的强清算区完全不做阻挡判断。规格把这条写在止盈规则表内，读法上应对所有新订单生效。

### B2. §7.3「继续搜索更远的强区域」实现为「继续搜索次强区域」

`chooseHeatmapTarget` 按 `intensity` 降序取第一个满足 RR≥1.5 的区域。次强区域可能比首选**更近**，与规格"更远"的表述不一致。建议改为：先按方向距离升序找首个满足 RR 的强区域，或在同强度档内优先取更远者。

### B3. §8.2「按平台允许的数量和价格精度生成请求」— 价格未量化

`omni-adapter.ts` 中数量已按 `min_qty_tick` / `min_qty` 量化，但 `limit_price` 直接用 Binance 最新成交价原样提交：

```ts
limit_price: positiveString(plan.entryPrice, "entry price")
```

Variational 若有价格 tick 约束，实盘会直接拒单。建议从 `/api/metadata/config` 取精度并对入场价、TP、SL 三个价格统一量化。

### B4. §10.1「撤销全部未成交限价单」实现为「只撤本系统受管订单」

`cancelManagedPending()` 只处理本地 `state='PENDING_ENTRY'` 且有 `platform_order_id` 的订单。这是刻意的安全取舍（见 `REQUIREMENTS_TRACEABILITY.md`），避免误撤用户手工单，但与规格字面不符。**建议在规格上确认接受，或在 UI 明确提示"手工单需自行处理"。**

### B5. 数据过期时仍会写入一条 signal 记录

`apps/signal-engine/src/index.ts` 中 `if(!dataFresh)` 只做暂停与游标推进，**没有 `continue`**，随后仍会为这根过期快照生成 signal 行（`rejection_reasons` 含 `STALE_DATA`，不会下单）。审计上是噪音，建议直接跳过。

### B6. 死代码与未使用字段

- `POST /api/assets/validate` 无任何调用方（`AssetsManager` 直接 POST `/api/assets`）。
- `heatmap_candidates.confirm_after` 写入后从未被读取，确认逻辑完全依赖 `closedAt > armedAt`。

---

## C. 工程与交付层面

### C1. 全部实现未提交 Git ⚠️

```
75d6e22 V0
012ff33 Add initial .gitignore file
```

40+ 个文件处于未提交状态，**没有任何可回滚点**。真实资金验收前建议先分阶段提交并打 tag。

### C2. 工作目录内含真实敏感数据

`.env`、`omni-trade-test.har`、`www.coinglass.com-liqHeatMap.har`、`coinglass-profile/`、`playwright-profile/` 都在仓库目录内。已被 `.gitignore` 覆盖，但备份、打包、迁移 Linux 时需要单独处理。

### C3. 追溯表偏乐观，建议同步修正

`docs/REQUIREMENTS_TRACEABILITY.md` 将 AC-12 标为"生产构建及 macOS 浏览器视觉检查通过"，但 A1 / A2 / A7 三项 Dashboard 要求实际未满足。

---

## D. AC-01 ～ AC-12 复核

| 编号 | 状态 | 说明 |
|---|---|---|
| AC-01 双源校验 | ✅ | Binance 合约解析 + CoinGlass 真实抓取解密，任一失败拒绝保存 |
| AC-02 预热→对账→下一根 K 线 | ✅ | `prewarmAll` → `waitForNextQuarter`；Agent 启动清 `reconciled` |
| AC-03 BTC + 四条件 | ✅ | 日线 EMA50/200 + 结构、4h EMA20/50、ADX 25/18 全部按固定参数 |
| AC-04 每 15m 一单、上限 5 | ✅ | signals 唯一约束 + `sha256(symbol\|direction\|closedAt)` 幂等键 |
| AC-05 最新价、10/5×、上限 20 | ⚠️ | 逻辑正确，但**价格精度未量化**（B3） |
| AC-06 结构 SL + Heatmap TP + RR≥1.5 | ⚠️ | RR/ATR 缓冲正确，**反向阻挡覆盖不全**（B1）、TP 搜索顺序偏差（B2） |
| AC-07 TP/SL 失败补偿 | 🟡 | 代码与单测完整，未经实盘 |
| AC-08 登录失效停单不补单 | ❌ | 失败关闭逻辑已实现，但**登录过期生命周期未验证**（A8） |
| AC-09 重启对账不重复下单 | 🟡 | `SUBMITTING`→`UNKNOWN` 且永不重提，未在真实挂单上验证 |
| AC-10 Telegram 3 次失败与手动恢复 | 🟡 | 10s×3、降级丢弃、手动测试恢复均已实现，缺真实 Bot 集成验证 |
| AC-11 全局暂停 | ⚠️ | 撤单范围收窄（B4）+ **实盘模式下首页暂停按钮消失**（A2） |
| AC-12 UTC+8 与 K 线标记 | ❌ | 时区正确，但 K 线只有 BTC、无 Heatmap 区域带、首页缺订单持仓模块（A1/A7） |

---

## E. 建议的处理顺序

1. **A2**（实盘时暂停按钮消失）— 安全性问题，改动只有几行。
2. **B3**（价格精度量化）— 直接影响首次实盘下单成功率。
3. **B1 / B2**（反向阻挡与 TP 选择）— 影响每一笔订单的风险质量。
4. **A1 / A3 / A4 / A7**（Dashboard 补齐）— 规格第 12 章剩余部分。
5. **A5 / A6**（后台密钥与重启结果跟踪）。
6. **C1**（提交并打 tag），随后再进入 **A8**（阶段 0 收口）与阶段 6 真实资金验收。
