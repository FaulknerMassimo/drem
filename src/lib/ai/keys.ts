/**
 * Resolves the data key a queued job needs in order to decrypt anything.
 *
 * Live session first: that is the default, and it keeps the threat model
 * intact. The MASTER_KEY wrap is consulted only when the operator has opted
 * into `ALLOW_BACKGROUND_PROCESSING`. Callers must wipe keys they received
 * from the background path; session keys are owned by the key store.
 */
import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { peekKeysForUser } from "@/lib/auth/key-store";
import { unlockForBackground, wipeUserKeys, type UserKeys } from "@/lib/crypto/envelope";
import { env, masterKey } from "@/lib/env";

export interface JobKeys {
  keys: UserKeys;
  /** True when these were unwrapped from the master wrap, so the caller must wipe. */
  ephemeral: boolean;
}

export async function resolveJobKeys(userId: string): Promise<JobKeys | null> {
  const live = peekKeysForUser(userId);
  if (live) return { keys: live, ephemeral: false };

  if (!env().ALLOW_BACKGROUND_PROCESSING) return null;

  const [user] = await db
    .select({ dekWrappedMaster: users.dekWrappedMaster })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user?.dekWrappedMaster) return null;

  return {
    keys: unlockForBackground(
      { userId, dekWrappedMaster: user.dekWrappedMaster },
      masterKey(),
    ),
    ephemeral: true,
  };
}

export function releaseJobKeys(resolved: JobKeys): void {
  if (resolved.ephemeral) wipeUserKeys(resolved.keys);
}
