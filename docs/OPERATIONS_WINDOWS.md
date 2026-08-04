# Windows Server 运行说明

目标主机通过 Tailscale 管理，内网地址 `100.99.80.126`，项目目录按环境约定放在 `C:\supercasino`。Dashboard V1 不应直接挂到公网域名；Compose 端口只绑定 `127.0.0.1`，需要远程查看时使用 Tailscale/SSH 端口转发或经明确配置的内网反向代理。

## 更新与启动

```powershell
Set-Location -LiteralPath 'C:\supercasino'
git pull --ff-only
Copy-Item .env.example .env -ErrorAction SilentlyContinue
docker compose up -d postgres
docker compose run --rm migrate
docker compose run --rm migrate pnpm db:seed
docker compose up -d --build api web market-collector signal-engine telegram-worker
docker compose ps
```

不要把 `.env` 提交到 Git。生产主机应设置强 `POSTGRES_PASSWORD`，并同步修改 `DATABASE_URL` 中的密码。若 Dashboard 经反向代理访问，构建前把 `NEXT_PUBLIC_API_URL` 设置为浏览器可访问的 API 地址；改变该值后必须重新构建 Web 镜像。

## Variational Agent

Windows 上先原生运行 Agent，浏览器 Profile 放在固定目录并限制当前服务账号访问。完成 `apps/variational-agent/DISCOVERY.md` 前不要设置 `LIVE_TRADING_ENABLED=true`。

```powershell
pnpm --filter @huxtrade/variational-agent start
```

可在验证完成后用 Windows Task Scheduler 配置“用户登录时启动”和失败重启。钱包登录/验证必须由用户在可见浏览器会话中人工完成，不自动化钱包确认。

## 运维检查

```powershell
docker compose ps
docker compose logs --tail 200 api market-collector signal-engine telegram-worker
Invoke-RestMethod http://127.0.0.1:4000/health
```

出现数据异常后，单币不会自动恢复；在 Dashboard 查看最后成功时间与原因，修复源问题后手动恢复。订单状态为 `UNKNOWN` 或 `RECONCILIATION_REQUIRED` 时，不要手工删除本地记录，应先在 Variational 页面确认真实状态。
