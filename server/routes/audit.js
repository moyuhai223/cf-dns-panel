import { requireAuth } from '../middleware/auth.js';
import { listAudit } from '../services/audit.js';

export default async function auditRoutes(fastify) {
  fastify.addHook('preHandler', requireAuth);

  fastify.get('/', async (request) => {
    const { page, perPage } = request.query;
    return listAudit({
      page: Number(page) || 1,
      perPage: Math.min(Number(perPage) || 50, 200),
    });
  });
}
