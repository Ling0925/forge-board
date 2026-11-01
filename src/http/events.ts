import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { z } from "zod";
import type { Actor, eventFilterSchema } from "../domain/index.js";
import type { createBoard } from "../service/index.js";

export function eventStream(
  c: Context,
  board: ReturnType<typeof createBoard>,
  actor: Actor,
  query: z.infer<typeof eventFilterSchema>,
) {
  let events = board.replayEvents(actor, query);
  let after = query.after ?? 0;
  return streamSSE(c, async (stream) => {
    let changed = false;
    let wake: (() => void) | undefined;
    // Subscribe before the first await to close the replay-to-live handoff.
    const unsubscribe = board.onCommit(() => {
      changed = true;
      wake?.();
    });
    stream.onAbort(() => {
      unsubscribe();
      wake?.();
    });
    try {
      await stream.write(": connected\n\n");
      while (!stream.aborted) {
        for (const event of events) {
          if (stream.aborted) break;
          await stream.writeSSE({
            id: String(event.seq),
            data: JSON.stringify(event),
          });
          after = event.seq;
        }
        if (!changed && !stream.aborted)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        if (stream.aborted) break;
        changed = false;
        wake = undefined;
        events = board.replayEvents(actor, { ...query, after });
      }
    } finally {
      unsubscribe();
    }
  });
}
