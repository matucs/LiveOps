-- Idempotent workflow triggering: a trigger event redelivered by the bus
-- (at-least-once) must not start a second execution of the same workflow.
CREATE UNIQUE INDEX uq_workflow_trigger ON workflow_executions(definition, trigger_event_seq)
  WHERE trigger_event_seq IS NOT NULL;
