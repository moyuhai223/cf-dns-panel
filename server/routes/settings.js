import { requireAuth } from '../middleware/auth.js';
import { getNotifyConfig, setNotifyConfig, sendTest } from '../services/notify.js';

export default async function settingsRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // GET notification config — the Telegram token is masked (set-or-not), never echoed.
  fastify.get('/notifications', async () => {
    const c = getNotifyConfig();
    return {
      config: {
        enabled: c.enabled,
        webhookUrl: c.webhookUrl,
        telegramChat: c.telegramChat,
        telegramTokenSet: !!c.telegramToken,
        events: c.events,
      },
    };
  });

  // PUT — empty telegramToken keeps the existing one (so the masked field round-trips).
  fastify.put('/notifications', async (request) => {
    const b = request.body || {};
    const cur = getNotifyConfig();
    const incomingToken = String(b.telegramToken || '').trim();
    const cfg = {
      enabled: !!b.enabled,
      webhookUrl: String(b.webhookUrl || '').trim(),
      telegramToken: incomingToken || cur.telegramToken,
      telegramChat: String(b.telegramChat || '').trim(),
      events: {
        create: b.events?.create !== false,
        update: b.events?.update !== false,
        delete: b.events?.delete !== false,
        ddns: !!b.events?.ddns,
        batch: b.events?.batch !== false,
      },
    };
    setNotifyConfig(cfg);
    return { ok: true };
  });

  // POST test — sends a test message with the CURRENTLY SAVED config and reports results.
  fastify.post('/notifications/test', async (request, reply) => {
    const c = getNotifyConfig();
    if (!c.webhookUrl && !(c.telegramToken && c.telegramChat)) {
      return reply.code(400).send({ error: 'not_configured', message: '请先保存 Webhook 或 Telegram 配置' });
    }
    const results = await sendTest(c);
    return { results };
  });
}
