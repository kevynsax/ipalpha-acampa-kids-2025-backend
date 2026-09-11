export const config = {
  port: Number(process.env.PORT ?? 3000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",

  mongoUri: process.env.MONGODB_URI ?? "mongodb://localhost:27017",
  dbName: process.env.MONGODB_DB ?? "camping",

  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  sessionHours: Number(process.env.SESSION_HOURS ?? 24),

  otp: {
    length: 6,
    expireMinutes: Number(process.env.OTP_EXPIRE_MINUTES ?? 5),
    maxAttempts: Number(process.env.OTP_MAX_ATTEMPTS ?? 3),
    freezeMinutes: Number(process.env.ACCOUNT_FREEZE_MINUTES ?? 30),
    resendCooldownSeconds: Number(process.env.RESEND_COOLDOWN_SECONDS ?? 60),
  },

  /** public URL of the app, appended to notification SMS (empty = no link) */
  appUrl: process.env.APP_URL ?? "",

  comtele: {
    baseUrl: "https://sms.comtele.com.br/api/v2",
    apiKey: process.env.COMTELE_API_KEY ?? "",
    prefix: process.env.COMTELE_PREFIX ?? "AcampaKids",
  },

  /** OpenAI-compatible gateway for the editor's AI helper (empty key = feature hidden) */
  ai: {
    baseUrl: (process.env.AI_BASE_URL ?? "https://ai-models.kevyn.com.br/v1").replace(/\/$/, ""),
    apiKey: process.env.AI_API_KEY ?? "",
    /** OpenAI-compatible speech-to-text (whisper) for the editor's voice input; empty = mic hidden */
    transcribeUrl: (process.env.AI_TRANSCRIBE_URL ?? "https://whisper.kevyn.com.br/v1").replace(/\/$/, ""),
    transcribeModel: process.env.AI_TRANSCRIBE_MODEL ?? "whisper-large-v3-turbo",
    transcribeKey: process.env.AI_TRANSCRIBE_KEY ?? "",
  },
};
