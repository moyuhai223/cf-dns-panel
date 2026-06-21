# 更新日志

本项目所有重要变更记录于此。版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/),
每条日期为发布当天。

## [1.0.0] - 2026-06-22

首个正式版。通过 Cloudflare API 管理域名解析的自托管 Web 面板:只监听本机,
对外暴露与 TLS 交给 1Panel 反向代理。

### 账号与认证
- 单管理员登录:首次初始化创建,可改密;会话用签名 httpOnly Cookie。
- 两步验证(TOTP):内置实现、无外部加密依赖;支持设置 / 启用 / 关闭。
- 登录接口限速。
- 多个 Cloudflare API Token:用户令牌与 `cfat_` 账户令牌均可;录入前先校验
  (走 `GET /zones`,兼容账户令牌),落盘 AES-256-GCM 加密,列表只显示末 4 位。
- Token 权限自检:只读探测令牌可用的功能(列域名 / DNS / 区域设置 / 规则)。

### DNS 记录管理
- 列出 Token 可见的全部 zone;管理 A/AAAA/CNAME/TXT/MX/NS/SRV/CAA 等记录。
- 客户端即时搜索(名称 / 内容 / 备注)、筛选、分页。
- A/AAAA/CNAME 支持 proxied(橙云)开关;记录可设 TTL;MX/SRV 支持优先级。
- 表格多选批量:删除 / 改 TTL / 开关代理。
- 全局搜索:在一个账号下跨所有域名搜记录,命中标出所属域名,可跳转管理或删除。
- 记录标签(tags)。

### 导入 / 导出
- 支持 CSV / JSON / BIND `.txt` 三种格式。
- 导入按「同名同类型」覆盖更新;支持导入预演(dry-run)与可选的完全同步
  (删除文件中没有的记录,跳过 SOA/NS);单次最多 1000 条。

### DDNS
- 给 A/AAAA 记录生成专属更新 URL,设备定时调用即把记录更新为来访 IP。

### 缓存与规则
- 缓存管理:清除缓存(全部 / 按 URL)、开发模式、缓存级别、浏览器缓存 TTL、
  Always Online、始终 HTTPS、SSL 模式。
- 规则引擎(Rulesets):Cache Rules、重定向规则、响应头转换;含常用规则模板、
  本地编辑、整组保存。

### 快照与通知
- 区域快照 + 一键回滚:给域名记录打快照,出错时预览差异并一键还原;回滚为完全同步
  (跳过 SOA/NS),**回滚前**会拒绝空快照或超量(> 5000 条)快照以防误删;每域名保留最近 30 个。
- 变更通知:记录增改删 / 导入批量 / DDNS 变更时推 Webhook / Telegram
  (配置加密存储,可发测试)。

### 界面
- 侧边栏布局、Cloudflare 橙主题、明暗双主题、品牌登录 / 初始化页、云朵 Logo。

### 运维与部署
- 单进程同时托管 SPA 与 `/api`;`node server/index.js` 一键启动。
- 每次新增 / 修改 / 删除写审计日志(操作者、时间、记录、来源 IP)。
- 一键安装脚本 `install.sh`:root 执行,装 Node 22 + 构建前端 + 生成随机
  `APP_SECRET` + 注册 systemd(非登录用户、仅监听 `127.0.0.1`);幂等,支持
  卸载 / `--purge`。
- 部署物料:systemd 单元、Dockerfile、1Panel 反代说明。
- GitHub Actions CI(构建前端 + 跑单元测试);MIT 许可证。

[1.0.0]: https://github.com/moyuhai223/cf-dns-panel/releases/tag/v1.0.0
