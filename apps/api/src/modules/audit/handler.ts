import { pool } from "../../db/pool.js";
import type { Handler } from "../bus/types.js";

/**
 * Demo consumer group for Phase 02. Its only job is to prove the bus's
 * delivery guarantees end to end: the INSERT is idempotent via the unique
 * (handler, event_seq) constraint, so redelivery after a crash (checkpoint
 * not yet committed) is a safe no-op rather than a duplicate side effect.
 */
export const auditLogHandler: Handler = async (message) => {
  await pool.query(
    `INSERT INTO audit_log (handler, event_seq, event_type)
     VALUES ($1, $2, $3)
     ON CONFLICT ON CONSTRAINT uq_audit_log_handler_event DO NOTHING`,
    ["audit-log", message.seq, message.type],
  );
};
