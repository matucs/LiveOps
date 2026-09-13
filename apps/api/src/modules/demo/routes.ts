import type { FastifyInstance } from "fastify";

/**
 * Public, unauthenticated route exposing the demo tenant's API key, so a
 * visitor can open the live dashboard and see real data immediately
 * instead of needing to run the seed script themselves. Deliberately
 * scoped: DEMO_API_KEY is set only in the production deployment for one
 * pre-seeded, low-privilege demo tenant — never a real tenant's key, and
 * unset entirely in any environment that doesn't want this behavior
 * (local dev returns 404, matching "this feature doesn't exist here").
 */
export async function registerDemoRoutes(app: FastifyInstance) {
  app.get("/api/v1/demo/bootstrap", async (_request, reply) => {
    const key = process.env.DEMO_API_KEY;
    if (!key) {
      return reply.code(404).send({ error: "not_configured", message: "No demo tenant is configured on this deployment." });
    }
    return { apiKey: key };
  });
}
