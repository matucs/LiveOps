import { Kafka, logLevel } from "kafkajs";
import { config } from "../../../shared/config.js";

/** Shared Kafka client — one connection pool for both the producer
 * (outbox publisher) and every consumer group in this process. */
export const kafka = new Kafka({
  clientId: "liveops-api",
  brokers: config.eventBus.kafkaBrokers,
  logLevel: logLevel.NOTHING, // this app's own structured logs cover what matters; kafkajs's own logger is noisy by default
  retry: { retries: 5 },
});
