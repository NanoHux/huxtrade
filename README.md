# HuxTrade — 加密市场分析与 Variational 自动交易系统

依据根目录《加密市场分析与 Variational 自动交易系统_需求规格说明书_V1.0》实现的单用户、确定性、可审计交易系统。V1 不使用 AI 判断，不做历史回测，不补停机信号，不在后台提供手动平仓或改保护单。

## 当前交付范围

- Next.js 管理台：市场总览、K 线/Heatmap 标记、币种、策略、订单与持仓、统计、系统设置与健康。
- Fastify API：白名单双数据源校验、策略唯一启用、只读订单、统计、全局/单币暂停、Telegram 测试与保存。
- PostgreSQL：扫描批次、30 天指标基线、指标快照、Heatmap 候选、信号、订单、持仓、成交、事件、永久业务错误、健康状态和事务 Outbox。
- 市场采集：Binance USDⓈ-M K 线、价格、OI、Funding、聚合成交 CVD；CoinGlass V4 Binance 单交易所清算 Heatmap；启动预热 30 天并以最多 5 个币种受控并发完成收盘扫描。
- 指标与策略：Robust Z-score、EMA、ATR、ADX、BTC 状态、2-of-3 方向确认、AND/N-of-M、最强有效 Heatmap 区、1.5R、0.5 ATR 止损缓冲、0.15 ATR 止盈偏移。
- 风控与状态机：80%/75% 保证金阈值、同币同方向综合上限、幂等键、UNKNOWN/待对账失败关闭策略；首次 TP/SL 失败按成交状态撤入场或紧急市价平仓，既有保护单消失只暂停并通知。
- Telegram Worker：10 秒固定重试、最多 3 次、异常期间丢弃、手动测试恢复。
- Docker Compose：除 Mac/Windows 原生 Variational Agent 外的服务可容器化；端口默认只绑定回环地址。

## 真实资金安全门

仓库默认设置：

```dotenv
VARIATIONAL_ADAPTER_MODE=disabled
LIVE_TRADING_ENABLED=false
```

这不是演示开关。规格书要求先完成“阶段 0：Variational 协议发现”，但仓库当前没有用户的已登录 Variational 浏览器会话。`apps/variational-agent/DISCOVERY.md` 给出了必须完成的会话、读取、写入、幂等、超时和保护单验证清单。未经实际会话验证，Agent 只会上报阻断状态，绝不会提交订单。

仓库同时提供 `pnpm --filter @huxtrade/variational-agent discover`：它会打开可见的持久化浏览器并在本机生成脱敏协议记录，不自动点击交易或钱包确认。使用方式见上述清单。

## 本机启动

要求：Node.js 22、pnpm 10+、Docker Desktop。

```powershell
Copy-Item .env.example .env
pnpm install
docker compose up -d postgres
docker compose run --rm migrate
docker compose run --rm migrate pnpm db:seed
docker compose up -d --build api web market-collector signal-engine telegram-worker
```

打开 `http://localhost:3000`。首次运行前至少配置 `COINGLASS_API_KEY`；Telegram 可在系统设置中测试并保存。第一版所有展示时间固定为 UTC+8。

本地开发：

```powershell
pnpm dev
pnpm test
pnpm typecheck
pnpm build
```

## 服务边界

```text
apps/web                  Dashboard 与管理台
apps/api                  REST API、控制面、状态聚合
apps/market-collector     Binance/CoinGlass 采集与指标快照
apps/signal-engine        15 分钟信号、风险门、订单计划
apps/variational-agent    会话、提交、保护单、对账适配边界
apps/telegram-worker      Outbox 通知与故障状态
packages/database         PostgreSQL 连接、迁移、事务
packages/indicators       确定性指标
packages/strategy-engine  条件、Heatmap、RR、状态机与风控
packages/exchange-clients 官方市场数据适配器
packages/config           环境配置与固定规则
packages/shared-types     跨服务类型
```

## 运行原则

- 启动顺序为：数据库迁移 → 市场历史预热 → 下一根完整 15 分钟收盘扫描；启用真实交易前，Variational Agent 还必须先完成启动对账。
- 数据异常会暂停单币，且只能后台手动恢复；不会因为重启自动清除。
- Variational 登录失效时分析可继续，但信号标记为不可执行，恢复后不补单。
- 平台返回超时或状态不明确时进入 `UNKNOWN`，继续占用订单上限；每 30 秒以 Variational 权威状态同步订单、持仓与成交。
- `.env` 被 Git 忽略；设置页保存 Telegram 密钥前会发送真实测试消息。

详见 [需求验收映射](docs/REQUIREMENTS_TRACEABILITY.md) 与 [Windows Server 运行说明](docs/OPERATIONS_WINDOWS.md)。
