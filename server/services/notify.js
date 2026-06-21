import { db } from '../db.js';
import { encrypt, decrypt } from '../crypto.js';

// Change notifications: send a webhook POST and/or a Telegram message when DNS
// records change. Config (incl. the Telegram token) is stored AES-encrypted in
// the settings table. Dispatch is fire-and-forget and never throws into a request.

const KEY = 'notifications';

function defaults() {
  return {
    enabled: false,
    webhookUrl: '',
    telegramToken: '',
    telegramChat: '',
    events: { create: true, update: true, delete: true, ddns: false, batch: true },
  };
}

export function getNotifyConfig() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  if (!row) return defaults();
  try {
    return { ...defaults(), ...JSON.parse(decrypt(row.value)) };
  } catch {
    return defaults();
  }
}

export function setNotifyConfig(cfg) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(KEY, encrypt(JSON.stringify(cfg)));
}

const EVENT_LABEL = {
  create: '新增记录',
  update: '修改记录',
  delete: '删除记录',
  ddns: 'DDNS 更新',
  batch: '批量变更',
  test: '测试通知',
};

function formatText(p) {
  return [
    `🔔 ${EVENT_LABEL[p.event] || p.event}`,
    p.zone ? `域名: ${p.zone}` : null,
    p.type || p.name ? `记录: ${[p.type, p.name].filter(Boolean).join(' ')}` : null,
    p.content ? `内容: ${p.content}` : null,
    p.summary || null,
    p.user ? `操作者: ${p.user}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

async function dispatch(cfg, payload) {
  const text = formatText(payload);
  const ts = new Date().toISOString();
  const tasks = [];
  const opts = (body) => ({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (cfg.webhookUrl) {
    tasks.push(fetch(cfg.webhookUrl, opts({ ...payload, text, ts })));
  }
  if (cfg.telegramToken && cfg.telegramChat) {
    tasks.push(
      fetch(
        `https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`,
        opts({ chat_id: cfg.telegramChat, text }),
      ),
    );
  }
  return Promise.allSettled(tasks);
}

/** Fire-and-forget notification, gated by the saved config + event toggles. */
export function notifyChange(payload) {
  let cfg;
  try {
    cfg = getNotifyConfig();
  } catch {
    return;
  }
  if (!cfg.enabled) return;
  if (cfg.events && cfg.events[payload.event] === false) return;
  if (!cfg.webhookUrl && !(cfg.telegramToken && cfg.telegramChat)) return;
  dispatch(cfg, payload).catch(() => {});
}

/** Awaited test send — returns per-target results so the UI can report success. */
export async function sendTest(cfg) {
  const results = await dispatch(cfg, { event: 'test', summary: '这是一条来自 cf-dns-panel 的测试通知' });
  return results.map((r) => (r.status === 'fulfilled' ? { ok: r.value.ok, status: r.value.status } : { ok: false, error: String(r.reason?.message || r.reason) }));
}
