/**
 * Database schema.
 *
 * Naming convention: any column holding a ciphertext is suffixed `Enc`, and any
 * keyed fingerprint is suffixed `Bidx`. Everything else is stored in the clear
 * and should be assumed readable by anyone holding a database dump — so only
 * structural metadata lives there, never dream content.
 */
import {
  boolean,
  customType,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  time,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

/** postgres.js hands back Uint8Array; normalise to Buffer for the crypto layer. */
const bytea = customType<{ data: Buffer; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) => Buffer.from(value),
  toDriver: (value) => value,
});

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const inductionTechnique = pgEnum("induction_technique", [
  "none",
  "mild", // Mnemonic Induction of Lucid Dreams
  "wbtb", // Wake Back To Bed
  "wild", // Wake Induced Lucid Dream
  "ssild", // Senses Initiated Lucid Dream
  "fild", // Finger Induced Lucid Dream
  "dild", // Dream Initiated Lucid Dream
  "reality_check",
  "dream_journal",
  "other",
]);

export const dreamSource = pgEnum("dream_source", [
  "typed",
  "quick_capture", // the 3am screen
  "ocr", // photographed handwritten page
  "voice", // dictated and transcribed
  "import",
]);

export const attachmentKind = pgEnum("attachment_kind", ["image", "audio"]);

export const processingStatus = pgEnum("processing_status", [
  "pending",
  "running",
  "succeeded",
  "failed",
  "skipped",
]);

export const insightKind = pgEnum("insight_kind", [
  "extraction", // neutral structured extraction; substrate for the rest
  "lucidity", // lucidity-coach feedback
  "symbolic", // symbolic / psychological reading
  "report", // cross-dream period rollup
]);

export const dreamSignCategory = pgEnum("dream_sign_category", [
  "person",
  "place",
  "object",
  "action",
  "emotion",
  "anomaly", // impossible or inconsistent details: the richest lucidity cues
  "theme",
]);

export const authEventType = pgEnum("auth_event_type", [
  "login_success",
  "login_failure",
  "totp_success",
  "totp_failure",
  "recovery_used",
  "logout",
  "session_revoked",
  "password_changed",
  "totp_enrolled",
  "totp_disabled",
  "lockout",
  "export_created",
  "entry_deleted",
  "ai_request", // every outbound model call, local or remote
  "settings_changed",
]);

export const jobKind = pgEnum("job_kind", [
  "embed_dream",
  "extract_insight",
  "lucidity_insight",
  "symbolic_insight",
  "period_report",
  "detect_dream_signs",
  "ocr_attachment",
  "transcribe_attachment",
]);

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),

  /** Argon2id PHC string. Peppered with MASTER_KEY. */
  passwordHash: text("password_hash").notNull(),
  /** Salt for the KEK derivation — distinct from the password hash's own salt. */
  kekSalt: bytea("kek_salt").notNull(),
  /** Cost parameters this account's KEK was derived under. See kdf.ts. */
  kdfParams: jsonb("kdf_params").notNull(),
  /** The data key, wrapped under the password-derived KEK. */
  dekWrapped: bytea("dek_wrapped").notNull(),
  /** Optional second wrap under MASTER_KEY alone, for headless job processing. */
  dekWrappedMaster: bytea("dek_wrapped_master"),

  totpSecretEnc: bytea("totp_secret_enc"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  /**
   * Highest TOTP time step already accepted. Codes at or below it are refused,
   * making every code strictly single-use.
   */
  totpLastStep: text("totp_last_step"),

  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const recoveryCodes = pgTable(
  "recovery_codes",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** HMAC-SHA256 fingerprint; the code itself is shown once and never stored. */
    fingerprint: bytea("fingerprint").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("recovery_codes_user_idx").on(t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /**
     * SHA-256 of the cookie token. Storing the hash means a leaked database
     * cannot be replayed as a live session.
     *
     * Note what is *absent*: the unwrapped data key. It lives only in process
     * memory, so restarting the server ends every session by design.
     */
    tokenHash: bytea("token_hash").notNull().unique(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    /** Sliding idle deadline. */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Hard ceiling, never extended. */
    absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),

    userAgent: text("user_agent"),
    /** Hashed, so the audit trail cannot be turned into a location history. */
    ipHash: bytea("ip_hash"),
  },
  (t) => [
    index("sessions_user_idx").on(t.userId),
    index("sessions_expiry_idx").on(t.expiresAt),
  ],
);

export const authEvents = pgTable(
  "auth_events",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    type: authEventType("type").notNull(),
    succeeded: boolean("succeeded").notNull().default(true),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    ipHash: bytea("ip_hash"),
    userAgent: text("user_agent"),
    /** Structural detail only — must never carry dream content. */
    detail: jsonb("detail"),
  },
  (t) => [
    index("auth_events_user_at_idx").on(t.userId, t.at),
    index("auth_events_type_idx").on(t.type),
  ],
);

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

/**
 * A night is the unit of the habit, not a dream: nights with no recall still
 * count towards technique statistics and are what make the activity heatmap
 * honest about missed mornings.
 */
export const nights = pgTable(
  "nights",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** The date the night *ended* — the morning you woke and journalled. */
    date: date("date").notNull(),

    bedTime: time("bed_time"),
    wakeTime: time("wake_time"),
    wbtbTime: time("wbtb_time"),
    sleepQuality: smallint("sleep_quality"),

    techniques: inductionTechnique("techniques").array().notNull().default([]),
    /** Explicitly logged "I remembered nothing", distinct from "not yet filled in". */
    noRecall: boolean("no_recall").notNull().default(false),
    notesEnc: bytea("notes_enc"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("nights_user_date_idx").on(t.userId, t.date)],
);

export const dreams = pgTable(
  "dreams",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    nightId: uuid("night_id").notNull().references(() => nights.id, { onDelete: "cascade" }),
    /** Denormalised from the night so heatmap and streak queries stay single-table. */
    dreamDate: date("dream_date").notNull(),

    titleEnc: bytea("title_enc"),
    bodyEnc: bytea("body_enc"),

    isLucid: boolean("is_lucid").notNull().default(false),
    /** 0 = not lucid, 5 = fully aware with stable control. */
    lucidity: smallint("lucidity").notNull().default(0),
    vividness: smallint("vividness"),
    control: smallint("control"),
    recallClarity: smallint("recall_clarity"),
    /** -2 (nightmarish) to +2 (blissful). */
    emotionalValence: smallint("emotional_valence"),

    isNightmare: boolean("is_nightmare").notNull().default(false),
    isRecurring: boolean("is_recurring").notNull().default(false),
    /** A fragment is a scrap too thin to call an entry, but still worth counting. */
    isFragment: boolean("is_fragment").notNull().default(false),
    /** Captured at 3am, metadata not yet filled in. */
    isDraft: boolean("is_draft").notNull().default(false),

    /**
     * Computed from the plaintext at write time so length statistics do not
     * require decrypting the archive. This is a deliberate, bounded leak: an
     * observer learns how much you wrote, never what.
     */
    wordCount: integer("word_count").notNull().default(0),
    source: dreamSource("source").notNull().default("typed"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("dreams_user_date_idx").on(t.userId, t.dreamDate),
    index("dreams_night_idx").on(t.nightId),
    index("dreams_lucid_idx").on(t.userId, t.isLucid),
    index("dreams_draft_idx").on(t.userId, t.isDraft),
  ],
);

export const tags = pgTable(
  "tags",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    nameEnc: bytea("name_enc").notNull(),
    /** Keyed fingerprint, so tags can be grouped and counted without decrypting. */
    nameBidx: bytea("name_bidx").notNull(),
    color: text("color"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("tags_user_bidx_idx").on(t.userId, t.nameBidx)],
);

export const dreamTags = pgTable(
  "dream_tags",
  {
    dreamId: uuid("dream_id").notNull().references(() => dreams.id, { onDelete: "cascade" }),
    tagId: uuid("tag_id").notNull().references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.dreamId, t.tagId] }), index("dream_tags_tag_idx").on(t.tagId)],
);

/**
 * Dream signs are the point of the whole exercise: recurring cues that, once
 * recognised, can trigger a reality check inside the dream.
 */
export const dreamSigns = pgTable(
  "dream_signs",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    labelEnc: bytea("label_enc").notNull(),
    labelBidx: bytea("label_bidx").notNull(),
    category: dreamSignCategory("category").notNull(),
    /** False when you added it by hand rather than the model proposing it. */
    isAuto: boolean("is_auto").notNull().default(true),
    /** Dismissed signs stay recorded so they are not re-proposed every scan. */
    isActive: boolean("is_active").notNull().default(true),

    occurrenceCount: integer("occurrence_count").notNull().default(0),
    /** How many of those occurrences were in lucid dreams — the useful ratio. */
    lucidCount: integer("lucid_count").notNull().default(0),
    lastSeenAt: date("last_seen_at"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("dream_signs_user_bidx_idx").on(t.userId, t.labelBidx)],
);

export const dreamSignOccurrences = pgTable(
  "dream_sign_occurrences",
  {
    dreamId: uuid("dream_id").notNull().references(() => dreams.id, { onDelete: "cascade" }),
    signId: uuid("sign_id").notNull().references(() => dreamSigns.id, { onDelete: "cascade" }),
    confidence: real("confidence").notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.dreamId, t.signId] }),
    index("dream_sign_occurrences_sign_idx").on(t.signId),
  ],
);

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** Null while a photo is still an unreviewed import draft. */
    dreamId: uuid("dream_id").references(() => dreams.id, { onDelete: "cascade" }),
    kind: attachmentKind("kind").notNull(),
    /**
     * The pages photographed in one sitting, read as one thing.
     *
     * A handwritten night is several pages and often several dreams, and both
     * facts are only legible from the whole stack: a dream can run across a
     * page break, and the seam between two dreams can fall mid-page. One model
     * call over every page of the stack answers both at once, which is why the
     * grouping has to exist before the reading rather than being reconstructed
     * from it afterwards.
     *
     * Null for anything uploaded before stacks existed, and for voice memos,
     * which are their own stack of one. `stackOf()` folds both cases to the
     * row's own id rather than backfilling.
     *
     * Deliberately not encrypted. It says that these files arrived together,
     * which `created_at` and `dream_id` already say in a stolen dump; it says
     * nothing about what is on them.
     */
    stackId: uuid("stack_id"),

    mimeType: text("mime_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    /** Digest of the *plaintext*, for deduplicating re-uploads of the same page. */
    sha256: bytea("sha256").notNull(),
    /** Path within UPLOAD_DIR. The file itself is encrypted with the blob key. */
    storageKey: text("storage_key").notNull(),

    /** OCR result for images, speech transcript for audio. */
    transcriptEnc: bytea("transcript_enc"),
    status: processingStatus("status").notNull().default("pending"),
    /** Model's own confidence, surfaced in the review UI. */
    confidence: real("confidence"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("attachments_user_idx").on(t.userId),
    index("attachments_dream_idx").on(t.dreamId),
    index("attachments_status_idx").on(t.status),
    index("attachments_stack_idx").on(t.stackId),
  ],
);

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export const insights = pgTable(
  "insights",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** Null for period reports, which span many dreams. */
    dreamId: uuid("dream_id").references(() => dreams.id, { onDelete: "cascade" }),
    kind: insightKind("kind").notNull(),

    periodStart: date("period_start"),
    periodEnd: date("period_end"),

    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /**
     * Lets a prompt be revised later and its outputs regenerated cleanly,
     * instead of silently mixing results from two different prompts.
     */
    promptVersion: text("prompt_version").notNull(),

    contentEnc: bytea("content_enc").notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("insights_dream_kind_idx").on(t.dreamId, t.kind),
    index("insights_user_kind_idx").on(t.userId, t.kind),
  ],
);

export const embeddings = pgTable(
  "embeddings",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    dreamId: uuid("dream_id").notNull().references(() => dreams.id, { onDelete: "cascade" }),
    model: text("model").notNull(),
    dim: integer("dim").notNull(),

    /**
     * Default backend. Vectors are a lossy projection of the text but are still
     * invertible enough to leak content, so they are encrypted like everything
     * else and similarity is computed in memory.
     */
    vectorEnc: bytea("vector_enc"),
    /**
     * Only populated when SEARCH_BACKEND=pgvector, which trades that privacy
     * for an ANN index. Worth it past roughly 20k entries.
     */
    vector: vector("vector", { dimensions: 768 }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("embeddings_dream_model_idx").on(t.dreamId, t.model),
    index("embeddings_user_idx").on(t.userId),
  ],
);

/**
 * Durable journal conversations.
 *
 * Only the human/assistant transcript is kept. Tool calls and their results
 * can contain whole decrypted dreams, so they exist only in the request that
 * is currently using them and never become a second copy of the journal.
 */
export const chatThreads = pgTable(
  "chat_threads",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** Derived from the first message, and therefore encrypted as authored text. */
    titleEnc: bytea("title_enc"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_threads_user_updated_idx").on(t.userId, t.updatedAt)],
);

export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey(),
    threadId: uuid("thread_id").notNull().references(() => chatThreads.id, { onDelete: "cascade" }),
    /** `user` or `assistant`; structural, and safe in a stolen dump. */
    role: text("role").notNull(),
    contentEnc: bytea("content_enc").notNull(),
    provider: text("provider"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("chat_messages_thread_created_idx").on(t.threadId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: jobKind("kind").notNull(),
    /** Identifiers only. Plaintext must never be queued — it would land here unencrypted. */
    payload: jsonb("payload").notNull(),

    status: processingStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),

    /**
     * How far the model has got, for a job still running.
     *
     * A count and a phase, never a character of what was written: both the
     * reasoning and the answer are derived from the journal, and this table is
     * unencrypted. A length is the most that can be stored here without
     * breaking the rule the rest of the schema exists for — and it is all the
     * screen needs, because a number going up is the whole message.
     *
     * `heartbeatAt` is also what tells a job that is slow from one whose worker
     * died: `reclaimStuckJobs` reads it rather than `startedAt`, so a scan that
     * legitimately runs for half an hour is not re-queued underneath itself.
     */
    progressPhase: text("progress_phase"),
    progressChars: integer("progress_chars").notNull().default(0),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),

    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("jobs_pending_idx").on(t.status, t.scheduledFor), index("jobs_user_idx").on(t.userId)],
);

export const settings = pgTable("settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  /** Provider endpoints, model-role assignments and API keys. Encrypted: it holds credentials. */
  aiConfigEnc: bytea("ai_config_enc"),
  /** Non-sensitive UI preferences: theme, first day of week, heatmap scale. */
  preferences: jsonb("preferences").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
