import type { FastifyInstance } from "fastify";
import { requireTenant } from "../tenant/auth.js";
import { eventEnvelopeSchema } from "./schema.js";
import { ingestEvent } from "./service.js";
import { log } from "../../shared/telemetry.js";

export async function registerIngestRoutes(app: FastifyInstance) {
  app.post("/api/v1/events", { preHandler: requireTenant }, async (request, reply) => {
    const parsed = eventEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "invalid_event",
        message: "Event failed schema validation.",
        details: parsed.error.flatten(),
      });
    }

    const tenant = request.tenant!;
    const result = await ingestEvent(tenant.tenantId, parsed.data);

    log("info", "event ingested", {
      tenantId: tenant.tenantId,
      eventId: result.eventId,
      correlationId: result.correlationId,
      wasDuplicate: result.wasDuplicate,
    });

    return reply.code(result.wasDuplicate ? 200 : 201).send({
      eventId: result.eventId,
      correlationId: result.correlationId,
      duplicate: result.wasDuplicate,
    });
  });
}
