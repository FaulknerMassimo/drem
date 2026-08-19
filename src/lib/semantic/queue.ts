/**
 * Deciding when an entry gets indexed without being asked.
 *
 * Search is only useful if the index keeps up with the journal, so writing an
 * entry queues its embedding. But embedding sends the entry to a model, and the
 * rule the rest of the app holds to is that a dream does not leave this machine
 * without the destination being on screen first.
 *
 * Both survive by splitting the case: a *local* embedding model is indexed
 * automatically, because nothing leaves; a remote one is never queued as a side
 * effect of saving, and has to be asked for on the search page, where the badge
 * and the acknowledgement are.
 */
import "server-only";
import { loadAiConfig } from "@/lib/ai/config";
import { destinationFor } from "@/lib/ai/destination";
import { enqueueEmbedDreams } from "@/lib/ai/jobs";
import { kickWorker } from "@/lib/ai/worker";
import type { UserKeys } from "@/lib/crypto/envelope";

/**
 * Queues embeddings for entries that were just written, if and only if the
 * assigned embedding model is on this machine.
 *
 * Never throws: an entry that was saved must not appear to have failed because
 * the index could not be updated. The backfill on the search page is the
 * backstop for anything missed here.
 */
export async function queueLocalEmbeddings(
  userId: string,
  keys: UserKeys,
  dreamIds: readonly string[],
): Promise<void> {
  if (dreamIds.length === 0) return;

  try {
    const config = await loadAiConfig(userId, keys);
    const destination = destinationFor(config, "embedding");
    if (!destination.configured || destination.leavesMachine) return;

    const queued = await enqueueEmbedDreams(userId, dreamIds);
    if (queued > 0) kickWorker();
  } catch (error) {
    console.error(
      "[semantic] could not queue embeddings: %s",
      error instanceof Error ? error.message : "unknown",
    );
  }
}
