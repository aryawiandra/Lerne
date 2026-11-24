import { z } from "zod";

const MIN_SECRET_LENGTH = 32;

/** `FOO=` in an env file means "not set", not "set to an empty string". */
function emptyAsUndefined<T extends z.ZodType>(inner: T) {
  return z.preprocess((value) => (value === "" ? undefined : value), inner);
}

const schema = z
  .object({
    LERNE_AUTH_MODE: z.enum(["dev", "supabase"]).default("dev"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    LERNE_SESSION_SECRET: emptyAsUndefined(z.string().optional()),
    LERNE_ALLOW_DEV_AUTH_IN_PRODUCTION: z.enum(["true", "false"]).default("false"),
    NEXT_PUBLIC_SUPABASE_URL: emptyAsUndefined(z.string().url().optional()),
    NEXT_PUBLIC_SUPABASE_ANON_KEY: emptyAsUndefined(z.string().optional()),
    NODE_ENV: z.string().default("development"),
  })
  .superRefine((env, ctx) => {
    if (env.LERNE_AUTH_MODE === "dev") {
      if (!env.LERNE_SESSION_SECRET || env.LERNE_SESSION_SECRET.length < MIN_SECRET_LENGTH) {
        ctx.addIssue({
          code: "custom",
          path: ["LERNE_SESSION_SECRET"],
          message: `LERNE_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters in dev auth mode`,
        });
      }
      if (env.NODE_ENV === "production" && env.LERNE_ALLOW_DEV_AUTH_IN_PRODUCTION !== "true") {
        ctx.addIssue({
          code: "custom",
          path: ["LERNE_AUTH_MODE"],
          message: "Dev sign-in bypass is disabled in production. Use LERNE_AUTH_MODE=supabase.",
        });
      }
    }
    if (env.LERNE_AUTH_MODE === "supabase" && (!env.NEXT_PUBLIC_SUPABASE_URL || !env.NEXT_PUBLIC_SUPABASE_ANON_KEY)) {
      ctx.addIssue({
        code: "custom",
        path: ["NEXT_PUBLIC_SUPABASE_URL"],
        message: "Supabase mode needs NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY",
      });
    }
  });

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | undefined;

export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid Lerne configuration — ${details}. See .env.example.`);
  }
  cached = parsed.data;
  return cached;
}

export function isDevAuth(): boolean {
  return getConfig().LERNE_AUTH_MODE === "dev";
}
