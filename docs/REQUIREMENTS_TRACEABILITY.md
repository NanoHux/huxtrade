# V1 验收条件映射

| 验收项 | 实现位置 | 自动验证/状态 |
|---|---|---|
| AC-01 白名单双源校验 | `apps/api/src/index.ts`、`packages/exchange-clients` | API 保存前同时验证；需 CoinGlass Key 集成测试 |
| AC-02 启动预热、对账、下一根 K 线 | Collector 对齐时钟、30 天基线、Agent 适配边界 | Collector 已实现并通过 Binance 30 天数据烟测；真实对账需阶段 0 |
| AC-03 BTC + 四条件默认策略 | `packages/indicators`、`packages/strategy-engine`、`apps/signal-engine` | OI 1h、CVD 15m、Funding 4h 绝对变化、Heatmap 延迟确认均有确定性测试 |
| AC-04 每 15 分钟最多一单、默认上限 5 | signals 唯一约束、riskGate、orders 幂等键 | PostgreSQL 引擎测试已验证方向唯一约束和幂等键 |
| AC-05 最新价、10 USDC/5×、最高 20 | config、OrderPlan | 10/5 默认已实现；平台最低额需阶段 0 返回规则 |
| AC-06 1h 结构 + ATR、Heatmap TP、RR≥1.5 | `packages/indicators`、`packages/strategy-engine` | 单元测试通过 |
| AC-07 TP/SL 失败的撤单/市价平仓 | `apps/variational-agent/src/execution.ts` | 未成交撤单、已成交市价平仓、失败关闭、既有保护消失不自动修复均有测试；真实调用仍需阶段 0 |
| AC-08 登录失效停止下单且不补单 | riskGate、Agent session state | 失败关闭已实现；真实失效识别需阶段 0 |
| AC-09 重启对账与不重复下单 | orders 幂等键、30 秒权威同步、状态机、Agent | 迁移/约束已在 PostgreSQL 引擎执行；平台对账调用需阶段 0 |
| AC-10 Telegram 3 次失败及手动恢复 | `apps/telegram-worker`、设置 API | 逻辑实现；需真实 Bot 集成测试 |
| AC-11 全局暂停、撤挂单、保留持仓 | 控制 API + Outbox | 控制与事件已实现；平台撤单需阶段 0 |
| AC-12 UTC+8、K 线标记 | `apps/web`、真实 Binance candles API | 生产构建及浏览器视觉检查通过 |

## 已验证命令

```text
pnpm test       5 个测试文件、26 个用例通过（含 PostgreSQL 迁移/约束、保护单补偿、方向候选、状态通知与发现记录脱敏）
pnpm typecheck  12 个 workspace 项目通过
pnpm build      Next.js 与所有 TypeScript 服务通过
```

另已用 Binance 官方公开接口完成 BTCUSDT symbol/Kline/OI 烟测及 30 天 15m OI 分页覆盖检查。当前开发机没有 Docker/PostgreSQL，因此 Compose、迁移和数据库约束仍需在目标 Windows Server 上执行一次集成验收。

## 不能用模拟数据替代的验收

以下项目直接影响真实资金，必须在用户明确授权、已登录的 Variational 会话和最小订单规模下完成：登录生命周期、余额/保证金权威读取、限价单、TP、SL、撤单、紧急市价平仓、平台最小额/精度、超时后的权威查询、手工网页操作后的对账。系统在这些项目完成前保持真实下单关闭。
