-- Demo consumer's side-effect table (Phase 02). Its purpose is to make
-- "no duplicated side effects under at-least-once delivery" checkable with
-- a query instead of just asserted in prose: the UNIQUE constraint means a
-- message redelivered after a crash (checkpoint not yet advanced) can be
-- reprocessed safely — the second INSERT is a no-op.

CREATE TABLE audit_log (
  id          BIGSERIAL PRIMARY KEY,
  handler     TEXT NOT NULL,
  event_seq   BIGINT NOT NULL REFERENCES events(seq),
  event_type  TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_audit_log_handler_event UNIQUE (handler, event_seq)
);
