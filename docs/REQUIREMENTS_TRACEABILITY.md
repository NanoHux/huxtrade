# V1 验收条件映射

| 验收项 | 实现位置 | 自动验证/状态 |
|---|---|---|
| AC-01 白名单双源校验 | `apps/api/src/index.ts`、`packages/exchange-clients`、`apps/coinglass-agent` | API 保存/换链前通过 `coinglass_probe_request`/`coinglass_probe_result` 握手请求原生 coinglass-agent 用真实登录 Chrome 实际抓取一次 Heatmap（解密由 CoinGlass 页面自己完成），并校验 Binance 合约一致性；成功后资产和首份 24h 缓存同事务写入 |
| AC-02 启动预热、对账、下一根 K 线 | Collector 对齐时钟、30 天基线、Agent 启动对账门 | `reconciled=false` 会阻断执行；浏览器上下文只读对账 Adapter 已实现 |
| AC-03 BTC + 四条件默认策略 | `packages/indicators`、`packages/strategy-engine`、`apps/signal-engine` | OI 1h、CVD 15m、Funding 4h 绝对变化、Heatmap 延迟确认均有确定性测试 |
| AC-04 每 15 分钟最多一单、默认上限 5 | signals 唯一约束、riskGate、orders 幂等键 | PostgreSQL 引擎测试已验证方向唯一约束和幂等键 |
| AC-05 最新价、10 USDC/5×、最高 20 | config、OrderPlan、Omni indicative quote | 信号确认时重新读取 Binance 最新价；提交前校验 Omni 当前杠杆、按 `min_qty_tick/min_qty` 量化数量，并按报价 `bid/ask` 的小数位量化入场/TP/SL 三个价格 |
| AC-06 1h 结构 + ATR、Heatmap TP、RR≥1.5 | `packages/indicators`、`packages/strategy-engine` | 反向阻挡以固定 1.5R 为锚，对所有新订单生效；TP 首选最强区、不足 1.5R 时只向更远搜索；量化后二次校验 1.5R，单元测试通过 |
| AC-07 TP/SL 失败的撤单/市价平仓 | `execution.ts`、`omni-adapter.ts` | 原子限价+TP/SL 响应必须同时返回三个 RFQ ID；失败时撤单或按该入场数量 reduce-only 平仓；单元测试通过 |
| AC-08 登录失效停止下单且不补单 | riskGate、浏览器同源账户探针、Agent session state | 失败关闭已实现；真实登录过期/重新登录生命周期仍需验收 |
| AC-09 重启对账与不重复下单 | orders 幂等键、30 秒权威同步、状态机、Agent | 平台订单/持仓/成交读取已实现；重启时中断于 `SUBMITTING` 的订单转 `UNKNOWN` 且绝不重提 |
| AC-10 Telegram 3 次失败及手动恢复 | `apps/telegram-worker`、设置 API | 3 次固定间隔重试、降级期丢弃和手动测试恢复消息已实现；需真实 Bot 集成测试 |
| AC-11 全局暂停、撤挂单、保留持仓 | 控制 API + Outbox + Omni cancel + `QuickControls` | 只按本地受管 `PENDING_ENTRY` 的平台 ID 精确撤单（已确认接受的偏差，手工单需自行处理）；急停按钮常驻首页，不再随安全门提示条消失；主动撤单成功响应仍需实盘验收 |
| AC-12 UTC+8、K 线标记 | `apps/web` | 首页含未成交订单与开放持仓模块；K 线可切换白名单币种与周期，Heatmap 以区域带绘制，全部订单标注入场/TP/SL；所有时间固定 UTC+8 |

## 已验证命令

```text
pnpm test       12 个测试文件、51 个用例通过（含 PostgreSQL 迁移/约束、CoinGlass URL/Heatmap 签名解密与 HAR 安全导入、保护单补偿、Omni Adapter 请求结构/对账、发现记录脱敏、CVD 分页完整性、暂停扫描门、运行路径和跨时区信号游标规范化）
pnpm typecheck  13 个 workspace 项目通过
pnpm build      Next.js 与所有 TypeScript 服务通过
```

另已用 Binance 官方公开接口完成 BTCUSDT K 线烟测。2026-08-05 已在 Apple Silicon Mac 上通过 Colima 启动 PostgreSQL 17、执行全部迁移与种子，并将 API/Web 容器运行到健康状态；浏览器实测 Dashboard、K 线和系统健康页可用。CoinGlass 免费网页请求签名、响应解密与规范化已实现；识别并修复了 `obe` 与 Chrome 指纹绑定问题，同一登录会话已真实验证 BTC、ETH、SOL、XRP、DOGE、ADA、BNB、AVAX；数据库中的 BTC/ETH/SOL 分别缓存 19/17/20 个有效区域。API 报告 `coinglassReady=true`。

## 2026-08-05 差距分析修复轮

对照 `docs/GAP_ANALYSIS_2026-08-05.md` 逐项修复：

- **急停常驻**：全局暂停/恢复、单币暂停/恢复、Telegram 重新测试合并为首页 `QuickControls` 面板，不再嵌在「安全门已关闭」提示条内，实盘模式下同样可见。
- **首页订单与持仓**：`/api/dashboard` 新增 `openOrders` 与 `openPositions`，首页渲染未成交订单和开放持仓（数量、入场、TP/SL、当前 PnL、状态更新时间）。
- **K 线图**：支持白名单币种与 5m～1d 周期切换；Heatmap 以 `markArea` 区域带绘制最强三个区；标注全部订单的入场/TP/SL 而非仅最后一笔。
- **订单页筛选**：状态与币种筛选写入 URL，服务端按 `/api/orders?state=` 查询。
- **系统健康页**：每个币种直接提供手动恢复按钮；新增「密钥更新与服务重启」面板。
- **价格精度**：`quantizePlanPrices` 按报价 `bid/ask` 的小数位量化入场、TP、SL——入场不优于信号价、止损留在结构之外、止盈不虚报——并在量化后二次校验 1.5R，未达标则拒绝提交而非下单。实际提交价格回写 `orders` 表。
- **反向阻挡**：`findBlockingRegion` 以固定 1.5R 为锚，对所有新订单生效，不再只在回退路径检查。
- **TP 搜索**：首选强度最大区；不足 1.5R 时只向**更远**搜索，弱而更近的区域不会被选中。
- **CoinGlass 后台密钥**：系统设置页可粘贴 `obe` 与浏览器指纹，保存前执行真实 Heatmap 抓取校验，通过后写入 `.env` 并请求重启 Agent；命令行 `discover:har` 保留。
- **重启结果跟踪**：API 每 15 秒核对重启请求，服务未在 90 秒内上报健康即标记异常、写入业务错误并发出 `notification.system_error`；新密钥不回滚。
- **过期数据**：信号引擎跳过过期快照，不再写入只有 `STALE_DATA` 的噪音信号，并作废该币的 Heatmap 候选。
- **死代码**：`/api/assets/validate` 接入币种表单的「先校验数据源」按钮；`heatmap_candidates.confirm_after` 成为确认边界的实际依据。
- **CoinGlass Agent**：模式未配置时降级上报健康而非崩溃退出，并响应 `service.restart_requested`；`docker-compose` 为其挂载 `.env`。

## 本轮代码核查修正

- 下单计划（结构、ATR、RR 或 Heatmap 阻挡）失败时，信号和条件结果现在仍永久保存，并记录明确拒绝原因；网络读取不再发生在数据库事务内。
- 订单计划使用信号确认时重新获取的 Binance 最新成交价，而不是较早的采集快照价。
- Variational Agent 每次启动先清除 `reconciled`，完成权威对账后才开放执行；旧进程留下的登录状态不能绕过启动顺序。
- Binance 15 分钟聚合成交超过分页上限时直接暂停该币，不再用截断数据计算 CVD。
- Dashboard 展示 BTC 日线方向、4h 确认、ADX 状态和 Variational 对账状态。
- Docker 构建纳入锁文件并强制 `--frozen-lockfile`；macOS 协议发现可自动定位 Chrome。
- CoinGlass 会话拒绝后保持失败关闭，同一故障不会在每个轮询周期重复请求或无限写入业务错误；HAR 导入同时提取 `obe` 与白名单浏览器指纹，先完成真实探测，再以 `0600` 权限更新根目录 `.env`。
- Signal Engine 写入游标前统一转 ISO 8601，兼容并自动修复旧的 JavaScript `GMT+0800` 字符串，避免 PostgreSQL 时区解析失败。
- 策略切换和全局暂停改为只逐笔撤销本系统数据库中的待成交入场单；不再使用平台级批量撤单。
- Collector 在每根 15 分钟收盘创建唯一刷新请求，并等待 CoinGlass Agent 回写同一请求的结果；只有本轮请求之后采集的 Heatmap 才能进入快照。2026-08-05 14:00（UTC+8）真实轮次完成 3/3 刷新与扫描。
- 全局手动暂停或 80% 保证金自动暂停时，Collector 不再创建扫描批次；恢复后只等待下一根完整收盘 K 线。
- Variational Profile 与发现输出的相对路径改为相对根 `.env` 解析，避免 pnpm workspace 静默创建错误的空 Profile；launchd 安装器强制要求只读模式和回环 CDP。

## 2026-08-05 CoinGlass Heatmap 改为浏览器驱动

用户反馈免费网页版 Heatmap 抓取又开始失败（`CoinGlass free web Heatmap returned an unsupported encryption version`）。用真实登录的 Chrome 直接抓包核实：CoinGlass 把响应头 `v` 从 `0` 换成了 `1`，此前逆向出的 AES-128-ECB + TOTP 签名协议随之失效；同时确认它不使用 WebCrypto（`crypto.subtle` 未被调用），是自带的混淆 JS 实现，继续逆向只是在追一个随时可能再变的移动目标。

改为让 CoinGlass 自己解密：`apps/coinglass-agent` 新增 `browser-capture.ts`，用 Playwright 驱动一个真实登录的 Chrome 打开 Heatmap 页面，通过 `page.addInitScript` 在任何页面脚本执行前 hook `JSON.parse`，捕获 CoinGlass 前端自己解密出的 `{liq, y}` 明文，再复用原有的 `normalizeCoinGlassWebHeatmap` 计算强度区。非 24h 周期通过 Playwright 的 `getByRole('combobox')`/`getByRole('option')` 语义化定位器点选页面上的周期下拉框触发对应请求。移除了整套 AES/TOTP 逆向实现（`coinGlassWebSignature`、`decryptCoinGlassValue`、`CoinGlassFreeWebClient`）及配套的 HAR 导入工具（`har.ts`、`import-har.ts`）。

`apps/api` 容器访问不到宿主机 Chrome，资产新增校验和系统设置「重新测试」改为通过 `app_state` 的 `coinglass_probe_request`/`coinglass_probe_result` 键值对，把一次性抓取请求转交给原生运行的 coinglass-agent 处理（复用 Collector 早已在用的 `coinglass_refresh_request`/`coinglass_refresh_result` 握手模式，只是换成任意 URL 而非已存资产）。`COINGLASS_ADAPTER_MODE` 从 `free-web` 改名为 `browser`；新增 `COINGLASS_PROFILE_PATH`/`COINGLASS_BROWSER_EXECUTABLE`/`COINGLASS_CDP_URL`，与 Variational 的浏览器配置对称。`docker-compose.yml` 中 coinglass-agent 移入 `linux-agent` profile，Mac 上原生运行（同 variational-agent）。

**已知坑**：Google 的登录页会把 Playwright 自己启动的浏览器判定为「此浏览器或应用可能不安全」并拒绝登录（与 Variational Agent 已记录的 CAPTCHA 问题同源）。修复方式沿用 Variational 已有的解法——不让 Playwright 自己拉起浏览器，而是手动 `open`/直接执行 Chrome 二进制并带上 `--remote-debugging-port`，登录后把回环调试端口写入 `COINGLASS_CDP_URL`，Agent 改为 `connectOverCDP` 附加上去而不是新开一个自动化窗口。真实验证：BTC 无需登录即可直接抓取成功（19 个有效区）；ETH/SOL/XRP 在附加到已登录的调试端口 Chrome 后验证通过。

## 仍需外部条件的未完成项

- Variational 浏览器上下文 Adapter 已实现；读取、报价、市价开平仓及 TP/SL 已有真实 HAR/页面结果。限价入场和主动撤单的成功/错误响应、平台幂等支持、登录失效生命周期尚未完成独立实盘验收，因此 `LIVE_TRADING_ENABLED` 继续默认关闭。
- CoinGlass 免费 Heatmap 不需要 API Key，也不再自己解密响应——2026-08-05 发现 CoinGlass 把响应加密版本从 `v0` 换成了 `v1`，此前逆向实现的 AES 客户端随之失效。改为 coinglass-agent 驱动真实登录 Chrome，读 CoinGlass 页面自己解密后的结果（hook `JSON.parse`），天然不受其加密算法变化影响；`apps/api` 容器无法直接访问宿主机 Chrome，改为通过 `app_state` 的 `coinglass_probe_request`/`coinglass_probe_result` 握手把一次性抓取请求转给原生运行的 Agent。今后仅在登录会话失效时，需要在 Agent 使用的那个 Chrome 窗口里重新登录一次，不再需要导出/导入 HAR。
- Telegram 需要用户 Bot Token/Chat ID 才能完成真实发送、三次失败和手动恢复集成验收。

## 不能用模拟数据替代的验收

以下项目直接影响真实资金，仍必须在用户针对该次操作明确确认后完成：限价单从挂单到成交/撤销、主动撤单返回、限价单附带 TP/SL 的三个 RFQ ID、超时后的权威查询、登录自然过期后的状态码与重新登录流程。系统在这些项目完成前保持真实下单关闭。
