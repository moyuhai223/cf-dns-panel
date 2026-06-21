# cf-dns-panel

通过 **Cloudflare API** 管理域名解析的自托管 Web 面板。设计为只监听 `127.0.0.1`,
对外暴露与 TLS 交给 **1Panel 反向代理**。支持多账号(多 Token)、多 zone、全记录类型的增删改查,并带操作审计日志。

> 反向代理 / 证书不在本项目内 —— 由 1Panel 负责。本服务只做 “Cloudflare DNS 管理 + Web UI”。

## 一键安装(Linux VPS)

在一台全新的 Debian/Ubuntu 或 RHEL 系(CentOS/Alma/Rocky)VPS 上,以 root 执行:

```bash
curl -fsSL https://raw.githubusercontent.com/moyuhai223/cf-dns-panel/main/install.sh | sudo bash
```

脚本会自动完成:安装 Node 22 与构建工具 → 克隆代码到 `/opt/cf-dns-panel` → `npm install` 并构建前端 → 生成带随机 `APP_SECRET` 的 `.env`(权限 600)→ 注册并启动 systemd 服务(以非登录用户 `cfpanel` 运行,仅监听 `127.0.0.1:8787`)→ 校验 `/healthz`。**幂等**:再次执行即更新到最新代码并重启,且不会覆盖已有 `.env`。

装完后在 1Panel 建反向代理指向 `http://127.0.0.1:8787` 并签发证书;HTTPS 通了之后把 `.env` 里的 `COOKIE_SECURE=true` 再 `systemctl restart cf-dns-panel`。

自定义端口/目录等(均有默认值,用长参数最稳妥):

```bash
curl -fsSL https://raw.githubusercontent.com/moyuhai223/cf-dns-panel/main/install.sh | sudo bash -s -- --port 9000 --install-dir /opt/cfdns
```

卸载:

```bash
# 删服务,保留数据
curl -fsSL https://raw.githubusercontent.com/moyuhai223/cf-dns-panel/main/install.sh | sudo bash -s -- --uninstall
# 连同安装目录 + 服务用户一起删(会丢失面板数据库)
curl -fsSL https://raw.githubusercontent.com/moyuhai223/cf-dns-panel/main/install.sh | sudo bash -s -- --uninstall --purge
```

## 特性

- 🔐 管理员登录(单用户,首次初始化,可改密),会话用签名 httpOnly Cookie。
- 🔑 录入多个 Cloudflare API Token;录入前先校验,落盘 **AES-256-GCM 加密**,列表只显示末 4 位。
- 🌐 列出 Token 可见的全部 zone;选定后管理 A/AAAA/CNAME/TXT/MX/NS/SRV/CAA 等记录。
- 🟠 A/AAAA/CNAME 支持 proxied(橙云)开关、TTL、优先级。
- 🧾 每次新增/修改/删除写审计日志(操作者、时间、记录、来源 IP)。
- 📦 单进程同时托管 SPA 与 `/api`;`node server/index.js` 一键启动。

## 技术栈

- 后端:Node.js 22 + Fastify 5 + better-sqlite3;CF 调用用原生 `fetch`。
- 前端:Vue 3 + Vite + Element Plus(构建产物输出到 `public/`,由后端静态托管)。
- 无需 axios / OpenAI 等额外依赖;密码哈希用内置 `crypto.scrypt`。

## 目录结构

```
cf-dns-panel/
├── server/        # Fastify 后端(config/db/crypto/cf-client/routes)
├── web/           # Vue 3 + Vite 前端
├── public/        # 前端构建产物(npm run build 生成)
├── deploy/        # systemd 单元 / Dockerfile / 1Panel 反代说明
├── data/          # 运行时数据:SQLite 库 + 自动生成的 secret.key(已 gitignore)
└── .env.example
```

## 准备 Cloudflare API Token

Cloudflare 控制台 → 个人资料 → **API 令牌** → 创建令牌(可用「编辑区域 DNS」模板),权限至少:

- **区域 - DNS - 编辑(Edit)**
- **区域 - 区域 - 读取(Read)**

作用范围可选「所有区域」或指定区域。Token 创建后只显示一次,复制到面板里录入即可。

> 同时支持**用户 API 令牌**和**账户 API 令牌**(`cfat_` 前缀)。校验走 `GET /zones`(而非仅限用户令牌的 `/user/tokens/verify`,后者会把账户令牌误判为 `1000 Invalid API Token`)。

## 本地运行(开发)

```bash
# 1) 后端依赖
npm install

# 2) 前端依赖 + 构建(产物进 public/)
npm run build        # 等于 install:web && build:web

# 3) 启动(默认 127.0.0.1:8787)
npm start
# 浏览器打开 http://127.0.0.1:8787,按引导初始化
```

前端热更新开发(可选,两个终端):

```bash
npm start                       # 终端 A:后端 8787
npm --prefix web run dev        # 终端 B:Vite 5173,已代理 /api 到 8787
```

## 配置(`.env`,可选)

复制 `.env.example` 为 `.env`。关键项:

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址,保持本机 |
| `PORT` | `8787` | 监听端口 |
| `APP_SECRET` | 自动生成 | Cookie 签名 + Token 加密密钥,**生产建议固定** |
| `COOKIE_SECURE` | `false` | 经 1Panel 走 HTTPS 时设 `true` |
| `BASE_PATH` | 空 | 仅子路径反代时设置(需与前端构建一致) |
| `DATA_DIR` / `DB_PATH` | `./data` | 数据目录/数据库路径 |

生成固定密钥:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## 部署到 Linux VPS + 1Panel

```bash
git clone <repo> /opt/cf-dns-panel && cd /opt/cf-dns-panel
npm install && npm run build
cp .env.example .env   # 设好 APP_SECRET、COOKIE_SECURE=true

# 用 systemd 托管
cp deploy/cf-dns-panel.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now cf-dns-panel
```

然后在 1Panel 新建「反向代理」网站指向 `http://127.0.0.1:8787` 并签发证书。
详见 [deploy/1panel-reverse-proxy.md](deploy/1panel-reverse-proxy.md)。

Docker 方式见 [deploy/Dockerfile](deploy/Dockerfile)。

## API 一览(均在 `/api` 下,除 `/auth/status` 外需登录)

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/auth/status` | 是否已初始化 / 是否已登录 |
| POST | `/auth/setup` | 首次创建管理员 |
| POST | `/auth/login` `/auth/logout` | 登录 / 登出 |
| POST | `/auth/change-password` | 改密 |
| GET/POST/DELETE | `/accounts` `…/:id` | Token 列表 / 录入(先校验) / 删除 |
| GET | `/accounts/:id/zones` | 列出该 Token 的 zone |
| GET/POST | `/zones/:zoneId/records` | 记录列表(`?accountId=&type=&name=&page=`)/ 新增 |
| PUT/DELETE | `/zones/:zoneId/records/:recordId` | 修改 / 删除 |
| GET | `/audit` | 审计日志(分页) |

## 安全说明

- 仅监听本机;务必只通过 1Panel 反代访问,不要把 `8787` 暴露到公网。
- CF Token 加密存储;接口与日志均不回显完整 Token。
- 登录接口有限速(5 分钟 10 次)。
- 生产请设置固定 `APP_SECRET` 并 `COOKIE_SECURE=true`。

## 已知边界 / 后续

- MVP 为**单管理员**;多用户与权限、登录 2FA 为后续项。
- SRV/CAA 等结构化记录目前以 `content` 字符串提交,复杂场景以 Cloudflare 返回的报错为准。
- 记录批量导入/导出(BIND/CSV)、跨 zone 搜索为后续项。
