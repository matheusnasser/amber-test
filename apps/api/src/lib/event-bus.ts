/**
 * In-memory event bus for real-time SSE streaming.
 *
 * The negotiate POST route emits events here as they happen.
 * The negotiate/:id/stream GET route subscribes and forwards them to SSE clients.
 */

import { EventEmitter } from "events";

// Increase max listeners since multiple SSE clients may subscribe
const bus = new EventEmitter();
bus.setMaxListeners(50);

export type NegotiationEventData = Record<string, unknown>;

/**
 * Emit a negotiation event. Called from the negotiation loop.
 */
export function emitNegotiationEvent(
  negotiationId: string,
  event: NegotiationEventData,
): void {
  bus.emit(`negotiation:${negotiationId}`, event);
}

/**
 * Subscribe to negotiation events. Returns an unsubscribe function.
 */
export function subscribeToNegotiation(
  negotiationId: string,
  listener: (event: NegotiationEventData) => void,
): () => void {
  const channel = `negotiation:${negotiationId}`;
  bus.on(channel, listener);
  return () => {
    bus.off(channel, listener);
  };
}
