# 在 1Panel 中反代本服务

本服务只监听 `127.0.0.1:8787`,不直接对公网开放。对外访问与 HTTPS 证书由 1Panel 承担。

## 步骤

1. **启动服务**
   - 直接进程:`node server/index.js`(或用 `deploy/cf-dns-panel.service` 装成 systemd)。
   - 或 Docker:`docker run -d --name cf-dns-panel -p 127.0.0.1:8787:8787 -v cfp-data:/app/data cf-dns-panel`。

2. **1Panel → 网站 → 创建网站**
   - 类型选 **反向代理**。
   - 主域名填你的访问域名,例如 `dns.example.com`。
   - 代理地址填:`http://127.0.0.1:8787`。

3. **签发证书(HTTPS)**
   - 在该网站的「HTTPS」里申请/绑定证书(Let's Encrypt 或已有证书),开启强制 HTTPS。
   - 服务端设置 `COOKIE_SECURE=true`(让会话 Cookie 带 Secure 属性)。

4. **WebSocket / 头部**
   - 本服务无需 WebSocket。1Panel 默认会带上 `X-Forwarded-For`/`X-Forwarded-Proto`,
     服务端已开启 `trustProxy`,审计日志即可记录真实来源 IP。

5. 打开 `https://dns.example.com`,首次进入会引导设置管理员账号,然后添加 Cloudflare API Token 即可。

## 注意

- **不要**直接把 `8787` 暴露到公网;仅通过 1Panel 反代访问。
- 若用容器,把端口映射成 `127.0.0.1:8787:8787`,只暴露给本机的 1Panel。
- 如果一定要以**子路径**反代(如 `example.com/dns`),需要同时:
  服务端设 `BASE_PATH=/dns`,且前端用 `BASE_PATH=/dns npm run build` 重新构建。默认根路径无需关心。
