import { z } from "zod";

/**
 * Envelope every incoming event must satisfy. Business payload shape is
 * intentionally left as a free-form object here — schema evolution for
 * individual event types (e.g. "payment.failed.v1" vs "v2") is a per-type
 * concern documented in docs/adr, not enforced at the envelope level.
 */
export const eventEnvelopeSchema = z.object({
  eventId: z.string().min(1).max(200),
  type: z.string().min(1).max(200),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  correlationId: z.string().min(1).max(200).optional(),
  causationId: z.string().min(1).max(200).optional(),
  payload: z.record(z.unknown()).default({}),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
