const aiBaseUrl = (process.env.AI_BASE_URL ?? "https://ai-models.kevyn.com.br/v1").replace(/\/$/, "");
const aiApiKey = process.env.AI_API_KEY ?? "";

export const config = {
  port: Number(process.env.PORT ?? 3000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",

  mongoUri: process.env.MONGODB_URI ?? "mongodb://localhost:27017",
  dbName: process.env.MONGODB_DB ?? "camping",

  /**
   * Where uploaded images live on disk (editor pictures + the photo album).
   * Point it at a mounted volume in production — Mongo keeps only the
   * metadata (name, type, size, uploader), the bytes are plain files named
   * by their unguessable id.
   */
  filesDir: process.env.FILES_DIR ?? "data/files",

  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  sessionHours: Number(process.env.SESSION_HOURS ?? 96),

  otp: {
    length: 6,
    expireMinutes: Number(process.env.OTP_EXPIRE_MINUTES ?? 5),
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS ?? 3),
    freezeMinutes: Number(process.env.ACCOUNT_FREEZE_MINUTES ?? 30),
    resendCooldownSeconds: Number(process.env.RESEND_COOLDOWN_SECONDS ?? 60),
  },

  /** public URL of the app, appended to notification SMS (empty = no link) */
  appUrl: process.env.APP_URL ?? "",

  /**
   * Public origin of the site (frontend + `/api`). Prefixes images in
   * notification emails (`/icons/…`, `/church-logo.png`, `/api/files/…`).
   * `BACKEND_PUBLIC_URL` is an alias; falls back to `APP_URL`.
   */
  publicOrigin: (process.env.PUBLIC_ORIGIN || process.env.BACKEND_PUBLIC_URL || process.env.APP_URL || "").replace(/\/$/, ""),

  mail: {
    /** SendGrid HTTP API. Empty key = mock (emails printed in the console). */
    apiKey: process.env.SENDGRID_API_KEY ?? "",
    from: process.env.MAIL_FROM ?? "",
    fromName: process.env.MAIL_FROM_NAME ?? "Acampa Kids",
  },

  comtele: {
    baseUrl: "https://sms.comtele.com.br/api/v2",
    apiKey: process.env.COMTELE_API_KEY ?? "",
    prefix: process.env.COMTELE_PREFIX ?? "AcampaKids",
  },

  /** Private InsightFace service used to index and search gallery faces. */
  face: {
    serviceUrl: (process.env.FACE_SERVICE_URL ?? "").replace(/\/$/, ""),
    /** Cosine similarity. Prefer recall: parents should find their kid even if a few other children come along. */
    matchThreshold: Number(process.env.FACE_MATCH_THRESHOLD ?? 0.22),
    /** Weak detections still count — group shots and hats are the usual camp photo. */
    minDetectionScore: Number(process.env.FACE_MIN_DETECTION_SCORE ?? 0.4),
  },

  /** Spreadsheet import worker notifications. Values are normalized Brazilian E.164 numbers. */
  imports: {
    adminPhone: process.env.IMPORT_ADMIN_PHONE ?? "",
    superAdminPhone: process.env.IMPORT_SUPER_ADMIN_PHONE ?? "+5561985891092",
  },

  /**
   * Background import worker → API callback. The worker POSTs per-record
   * review results so the API can push a websocket event; the shared secret
   * authenticates it (empty = the endpoint refuses everything).
   */
  worker: {
    secret: process.env.WORKER_SECRET ?? "",
  },

  /** Account that is guaranteed the top-level admin role on every boot. */
  superAdminPhone: process.env.SUPER_ADMIN_PHONE ?? "",

  /** OpenAI-compatible gateway for the editor's AI helper (empty key = feature hidden) */
  ai: {
    baseUrl: aiBaseUrl,
    apiKey: aiApiKey,
    /**
     * Two-way voice conversation with the assistant (GPT-Live, POST /v1/live/sessions).
     * GPT-Live owns the microphone and the speaker; it delegates every question to
     * the Responses model below, which is the one that calls the MongoDB tools.
     * Empty key = the assistant drawer shows as unavailable.
     */
    live: {
      baseUrl: (process.env.AI_LIVE_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
      apiKey: process.env.AI_LIVE_API_KEY ?? "",
      model: process.env.AI_LIVE_MODEL ?? "gpt-live-1",
      voice: process.env.AI_LIVE_VOICE ?? "marin",
      backendModel: process.env.AI_LIVE_BACKEND_MODEL ?? "gpt-5.6-terra",
    },
    /** OpenAI-compatible speech-to-text (whisper) for the editor's voice input; empty = mic hidden */
    transcribeUrl: (process.env.AI_TRANSCRIBE_URL ?? "https://whisper.kevyn.com.br/v1").replace(/\/$/, ""),
    transcribeModel: process.env.AI_TRANSCRIBE_MODEL ?? "whisper-large-v3-turbo",
    transcribeKey: process.env.AI_TRANSCRIBE_KEY ?? "",
  },
};
