-- Trace context propagation across async boundaries (ADR-011). A trace
-- started at HTTP ingest must still be the parent trace when a workflow
-- step runs, possibly seconds later and in a different tick, possibly
-- after a process restart — so the trace/span IDs travel as data on the
-- row, the same way this project persists every other piece of state
-- that must survive a restart, rather than living only in memory.

ALTER TABLE events ADD COLUMN trace_id TEXT;
ALTER TABLE events ADD COLUMN trace_span_id TEXT;

ALTER TABLE workflow_executions ADD COLUMN trace_id TEXT;
ALTER TABLE workflow_executions ADD COLUMN trace_span_id TEXT;
