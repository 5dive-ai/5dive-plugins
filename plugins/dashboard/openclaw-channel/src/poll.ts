// The inbox poll loop. No OpenClaw imports: the gateway hands it a callback,
// the tests hand it a fake one.

import { takeInbox, type SpoolMessage } from "./spool.js";

export const POLL_MS = 500;

export type PollSpoolOptions = {
  spool: string;
  signal: AbortSignal;
  /** Called once per message, in arrival order. Not awaited before the next poll. */
  onMessage: (msg: SpoolMessage) => Promise<void>;
  onError?: (err: unknown) => void;
  onDrop?: (name: string, why: string) => void;
  intervalMs?: number;
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Poll the inbox until `signal` aborts, then wait for every message already
 * handed on to finish (so a stop never cuts a reply in half).
 *
 * Messages start in arrival order but run side by side: OpenClaw's own
 * per-session queue decides whether a second message waits, steers or is
 * collected, as it does for any other channel. One failing message never
 * stops the loop.
 */
export async function pollSpool(o: PollSpoolOptions): Promise<void> {
  const inFlight = new Set<Promise<void>>();
  const interval = o.intervalMs ?? POLL_MS;
  while (!o.signal.aborted) {
    let batch: SpoolMessage[] = [];
    try {
      batch = takeInbox(o.spool, o.onDrop);
    } catch (err) {
      o.onError?.(err);
    }
    for (const msg of batch) {
      const task: Promise<void> = Promise.resolve()
        .then(() => o.onMessage(msg))
        .catch((err) => o.onError?.(err))
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
    }
    await sleep(interval, o.signal);
  }
  await Promise.all([...inFlight]);
}
