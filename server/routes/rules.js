import { db } from '../db.js';
import { decrypt } from '../crypto.js';
import { requireAuth, clientIp } from '../middleware/auth.js';
import { getPhaseEntrypoint, putPhaseEntrypoint, CloudflareError } from '../cf/client.js';
import { writeAudit } from '../services/audit.js';

// Rulesets phases this panel manages (Cache Rules, Redirect Rules, Response Header Transform).
const PHASES = new Set([
  'http_request_cache_settings',
  'http_request_dynamic_redirect',
  'http_response_headers_transform',
]);

function tokenFor(accountId) {
  const a = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  return a ? decrypt(a.token_encrypted) : null;
}

function onCf(reply, e) {
  if (e instanceof CloudflareError) {
    return reply.code(502).send({ error: 'cf_error', message: e.message, errors: e.errors });
  }
  throw e;
}

// Keep only the fields Cloudflare accepts when writing rules; drop id/version/etc.
function sanitizeRule(r) {
  const out = {
    action: String((r && r.action) || ''),
    expression: String((r && r.expression) || ''),
    enabled: !(r && r.enabled === false),
  };
  if (r && r.description != null) out.description = String(r.description);
  if (r && r.action_parameters && typeof r.action_parameters === 'object') {
    out.action_parameters = r.action_parameters;
  }
  return out;
}

export default async function rulesRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  // GET /api/rules/:phase?accountId=&zoneId=
  fastify.get('/:phase', async (request, reply) => {
    const { phase } = request.params;
    const { accountId, zoneId } = request.query;
    if (!PHASES.has(phase)) return reply.code(400).send({ error: 'invalid_phase', message: '不支持的规则类型' });
    const token = tokenFor(accountId);
    if (!token) return reply.code(400).send({ error: 'invalid_account', message: '账号无效' });
    if (!zoneId || typeof zoneId !== 'string') {
      return reply.code(400).send({ error: 'invalid_input', message: '缺少 zoneId' });
    }
    try {
      const rs = await getPhaseEntrypoint(token, zoneId, phase);
      return { rules: rs.rules || [] };
    } catch (e) {
      return onCf(reply, e);
    }
  });

  // PUT /api/rules/:phase  { accountId, zoneId, zoneName, rules: [...] }
  // Replaces the whole phase ruleset with the supplied rules (in order).
  fastify.put('/:phase', async (request, reply) => {
    const { phase } = request.params;
    const { accountId, zoneId, zoneName, rules } = request.body || {};
    if (!PHASES.has(phase)) return reply.code(400).send({ error: 'invalid_phase', message: '不支持的规则类型' });
    const token = tokenFor(accountId);
    if (!token) return reply.code(400).send({ error: 'invalid_account', message: '账号无效' });
    if (!zoneId || typeof zoneId !== 'string') {
      return reply.code(400).send({ error: 'invalid_input', message: '缺少 zoneId' });
    }
    if (!Array.isArray(rules)) return reply.code(400).send({ error: 'invalid_input', message: 'rules 必须是数组' });
    if (rules.length > 100) return reply.code(400).send({ error: 'too_many', message: '规则过多(上限 100)' });
    const cleaned = rules.map(sanitizeRule);
    const badIdx = cleaned.findIndex((r) => !r.action || !r.expression);
    if (badIdx >= 0) {
      return reply.code(400).send({ error: 'invalid_input', message: `第 ${badIdx + 1} 条规则缺少动作或表达式` });
    }
    try {
      const r = await putPhaseEntrypoint(token, zoneId, phase, cleaned);
      writeAudit({
        username: request.user.username, accountId, zoneId, zoneName,
        action: 'update', rrType: 'rules', rrName: phase,
        detail: { count: rules.length }, clientIp: clientIp(request),
      });
      return { rules: r.rules || [] };
    } catch (e) {
      return onCf(reply, e);
    }
  });
}
