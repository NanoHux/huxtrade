# macOS 运行说明

本项目在 macOS 上采用 Colima 提供 Docker 兼容运行时；PostgreSQL、API、Web 和无浏览器 Worker 在容器内运行，Variational Agent 与 CoinGlass Agent 都需要驱动真实浏览器，因此原生运行并使用本机 Chrome/Profile。

## 首次安装

```bash
corepack enable pnpm
corepack prepare pnpm@10.14.0 --activate
brew install docker docker-compose docker-buildx colima
```

Homebrew 的 Compose/Buildx 是 Docker CLI 插件。确保 `~/.docker/config.json` 包含：

```json
{
  "cliPluginsExtraDirs": ["/opt/homebrew/lib/docker/cli-plugins"]
}
```

启动本机容器运行时：

```bash
colima start --cpu 4 --memory 6 --disk 40
```

如需登录后自动启动 Colima，可执行 `brew services start colima`。项目容器自身使用 `restart: unless-stopped`。

## 安全启动

```bash
cd /Users/hux/Desktop/huxtrade
cp .env.example .env
pnpm install --frozen-lockfile
docker compose up -d postgres
docker compose run --rm migrate
docker compose run --rm migrate pnpm db:seed
docker compose up -d --build api web
docker compose ps
curl -fsS http://127.0.0.1:4000/health
```

Dashboard 位于 `http://localhost:3000`。上述安全启动不运行 CoinGlass Agent、Collector、Signal Engine、Telegram Worker 或 Variational Agent，适合尚未建立外部会话时检查管理台。

## 开启市场分析

CoinGlass 免费网页 Heatmap 不需要付费 API Key。它的响应是加密的，且加密版本会不定期更换（已实测从 `v0` 变为 `v1`，导致早期逆向实现的 AES 客户端直接失效）。因此 Agent 不再自己解密：它驱动一个真实登录的 Chrome 打开 Heatmap 页面，由 CoinGlass 自己的前端 JS 完成解密，Agent 只 hook `JSON.parse` 读出解密后的结果——这样无论 CoinGlass 之后怎么改加密算法都不受影响。

与 Variational Agent 一样，coinglass-agent 需要访问真实浏览器，所以在 Mac 上原生运行，不在 Docker 容器内（容器默认 compose 也已经不再启动它）。先在 `.env` 中启用：

```dotenv
COINGLASS_ADAPTER_MODE=browser
COINGLASS_PROFILE_PATH=./coinglass-profile
COINGLASS_BROWSER_EXECUTABLE=
COINGLASS_CDP_URL=
```

BTC 不需要登录，可直接烟测（首次运行会用 Playwright 自己启动一个可见的 Chrome 窗口，使用 `COINGLASS_PROFILE_PATH` 指定的 Profile）：

```bash
pnpm --filter @huxtrade/coinglass-agent smoke \
  'https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=BTC&type=pair'
```

非 BTC 币种需要登录 CoinGlass 账号。**注意**：Google 的登录会把 Playwright 自己启动的浏览器判定为"不安全浏览器"并拒绝登录（Variational Agent 也有同样的问题）。遇到这种情况，改成自己手动启动一个带调试端口的 Chrome，再让 Agent 附加上去，而不是让 Playwright 自己拉起浏览器：

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9223 \
  --user-data-dir=/Users/hux/Desktop/huxtrade/coinglass-profile \
  'https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=BTC&type=pair'
```

在这个窗口里正常登录一次 CoinGlass 账号，然后把调试端口写进 `.env`（只允许回环地址）：

```dotenv
COINGLASS_CDP_URL=http://127.0.0.1:9223
```

随后做 BTC、ETH、SOL、XRP 真实数据烟测（Agent 会连接到上面这个已登录的 Chrome，不再自己启动新的）：

```bash
pnpm --filter @huxtrade/coinglass-agent smoke \
  'https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=BTC&type=pair' \
  'https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=ETH&type=pair' \
  'https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=SOL&type=pair' \
  'https://www.coinglass.com/pro/futures/LiquidationHeatMap?coin=XRP&type=pair'
```

每行应返回 `regionCount` 和最强三个价格区。确认无误后原生常驻启动 Agent（`DATABASE_URL` 需要指向宿主机发布的端口，而不是容器内部主机名）：

```bash
ENV_FILE_OVERRIDE=false \
DATABASE_URL=postgres://huxtrade:huxtrade@127.0.0.1:5432/huxtrade \
pnpm --filter @huxtrade/coinglass-agent start
```

Agent 启动后先同步处理 API 转发过来的一次性抓取请求（新增币种校验、系统设置页「重新测试」都是通过 Postgres `app_state` 的 `coinglass_probe_request`/`coinglass_probe_result` 握手转给这个原生进程完成的，因为容器内的 `api` 服务连不到宿主机 Chrome），再按运行策略的 12h/24h/3d/7d/30d 周期定期采集全部白名单币种，写入 `coinglass_heatmaps`。页面加载超时、还没登录或数据过期都会失败关闭并阻止交易。Dashboard 的系统页显示 `DATA READY` 且每个币种出现 Heatmap 年龄后，再启动：

```bash
docker compose up -d --build market-collector signal-engine
docker compose logs --tail 200 -f market-collector signal-engine
```

新增币种时，在资产页粘贴该币种的 Model 1、Pair 模式链接。系统校验域名、路径、`coin` 参数，并通过上述握手实际取得一次 Heatmap 后才保存，同时强制要求它与 Binance 永续合约一致；同一个已登录 Chrome 可跨币种复用。若登录会话失效，在 Agent 使用的那个 Chrome 窗口里重新登录一次即可，不需要重启任何服务、也不需要导出 HAR。

### Linux 部署

Linux 上 coinglass-agent 走 `linux-agent` compose profile 容器化运行，浏览器 Profile 用 `coinglass_profile` 持久化 Volume；首次登录同样需要通过远程桌面在该容器内的浏览器里手动完成一次。

Telegram 配置经页面真实测试并保存后，可启动或重启 Worker：

```bash
docker compose up -d --build telegram-worker
```

## Variational 浏览器上下文适配器

真实下单默认关闭。适配器不导出 Cookie 或 Session；它在专用 Chrome Profile 的已登录页面中执行同源 `/api/` fetch。首次启动只启用只读连接：

```bash
ENV_FILE_OVERRIDE=false \
VARIATIONAL_ADAPTER_MODE=browser-fetch \
VARIATIONAL_BASE_URL=https://omni.variational.io/perpetual/BTC \
LIVE_TRADING_ENABLED=false \
pnpm --filter @huxtrade/variational-agent start
```

Chrome 打开后由用户人工完成登录/CAPTCHA。Agent 会读取账户、挂单、持仓和成交并执行启动对账，但不会提交交易。Dashboard 显示 `loggedIn=true` 与 `reconciled=true` 后才说明只读链路就绪。

若 Playwright 启动的 Profile 被 CAPTCHA 阻断，可由用户使用专用目录启动 Chrome 的本地调试端口，再让 Agent 附加；调试端口只允许回环地址：

```bash
open -na "Google Chrome" --args \
  --remote-debugging-port=9222 \
  --user-data-dir=/Users/hux/Desktop/huxtrade/playwright-profile \
  https://omni.variational.io/perpetual/BTC

ENV_FILE_OVERRIDE=false \
VARIATIONAL_ADAPTER_MODE=browser-fetch \
VARIATIONAL_CDP_URL=http://127.0.0.1:9222 \
LIVE_TRADING_ENABLED=false \
pnpm --filter @huxtrade/variational-agent start
```

写入调用虽已按真实 HAR 和 Omni 前端静态实现完成，但限价入场、主动撤销的成功响应以及登录失效生命周期尚未完成独立实盘验收。在这些验收完成前不要设置 `LIVE_TRADING_ENABLED=true`。

只读连接完成并确认 `.env` 中的 Variational 模式、URL 和回环 CDP 地址正确后，可安装规格要求的 launchd 守护进程。安装器会拒绝 `disabled`、非回环 CDP、缺少 URL 或已经开启真实交易的配置；它只额外覆盖本机 PostgreSQL 地址，其余配置仍从根目录 `.env` 读取：

```bash
pnpm macos:variational:install
pnpm macos:variational:status
tail -f ~/Library/Logs/HuxTrade/variational-agent.err.log
```

卸载时执行 `pnpm macos:variational:uninstall`。在只读验收完成前仍保持 `LIVE_TRADING_ENABLED=false`；安装 launchd 本身不会扩大交易权限。

相对 Profile/发现输出路径统一按根目录 `.env` 所在目录解析，不再受 pnpm workspace 的进程工作目录影响。钱包重新验证应在上述启用扩展的 CDP Chrome 中人工完成；Playwright 自启动浏览器只适合复用已经建立的会话。

## 日常运维

```bash
docker compose ps
docker compose logs --tail 200 api web market-collector signal-engine telegram-worker
colima status
```

coinglass-agent 和 variational-agent 在 Mac 上都原生运行（不在 `docker compose ps` 里），日志直接看各自终端输出或 `nohup` 重定向的文件。

停止项目但保留数据库：

```bash
docker compose stop
```

不要使用 `docker compose down -v`，它会删除 PostgreSQL 数据卷。
