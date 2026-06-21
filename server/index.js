import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import path from 'node:path';
import { existsSync } from 'node:fs';

import { config } from './config.js';
import { purgeExpiredSessions } from './db.js';
import authRoutes from './routes/auth.js';
import accountRoutes from './routes/accounts.js';
import recordRoutes from './routes/records.js';
import auditRoutes from './routes/audit.js';
import ddnsRoutes from './routes/ddns.js';
import cacheRoutes from './routes/cache.js';
import rulesRoutes from './routes/rules.js';
import settingsRoutes from './routes/settings.js';
import snapshotRoutes from './routes/snapshots.js';

const prefix = config.basePath; // '' or '/sub-path'
const webDist = path.join(config.projectRoot, 'public');

const app = Fastify({
  trustProxy: true, // honor X-Forwarded-* from the 1Panel reverse proxy
  logger: { level: config.logLevel },
  bodyLimit: 1 * 1024 * 1024,
});

await app.register(fastifyCookie, { secret: config.appSecret });
await app.register(fastifyRateLimit, { global: false });

// Never leak internal error details; log them, return a generic 500.
app.setErrorHandler((err, request, reply) => {
  request.log.error(err);
  reply.code(err.statusCode && err.statusCode >= 400 ? err.statusCode : 500);
  reply.send({ error: 'server_error', message: '服务器内部错误' });
});

app.get(`${prefix}/healthz`, async () => ({ ok: true, ts: Date.now() }));

// All JSON endpoints live under <prefix>/api.
await app.register(
  async (api) => {
    await api.register(authRoutes, { prefix: '/auth' });
    await api.register(accountRoutes, { prefix: '/accounts' });
    await api.register(recordRoutes, { prefix: '/zones' });
    await api.register(auditRoutes, { prefix: '/audit' });
    await api.register(ddnsRoutes, { prefix: '/ddns' });
    await api.register(cacheRoutes, { prefix: '/cache' });
    await api.register(rulesRoutes, { prefix: '/rules' });
    await api.register(settingsRoutes, { prefix: '/settings' });
    await api.register(snapshotRoutes, { prefix: '/snapshots' });
  },
  { prefix: `${prefix}/api` },
);

// Serve the built SPA (if present) and fall back to index.html for client routes.
if (existsSync(path.join(webDist, 'index.html'))) {
  await app.register(fastifyStatic, {
    root: webDist,
    prefix: `${prefix || ''}/`,
    wildcard: false,
  });
  app.setNotFoundHandler((request, reply) => {
    const url = request.raw.url || '';
    if (url.startsWith(`${prefix}/api`) || url.startsWith(`${prefix}/healthz`)) {
      return reply.code(404).send({ error: 'not_found' });
    }
    return reply.sendFile('index.html');
  });
} else {
  app.get(`${prefix}/`, async () => ({
    ok: true,
    message: 'API running. Build the web UI with: npm run build',
  }));
}

purgeExpiredSessions();

try {
  await app.listen({ host: config.host, port: config.port });
  if (config.appSecretGenerated) {
    app.log.warn(
      'APP_SECRET 未设置,已在 data/secret.key 生成并持久化。生产环境建议改用环境变量 APP_SECRET。',
    );
  }
  app.log.info(`cf-dns-panel listening on http://${config.host}:${config.port}${prefix || ''}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
