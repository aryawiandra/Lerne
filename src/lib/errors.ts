// Database functions raise errors as "CODE: human readable detail". Known codes
// are shown to the user; anything else is logged server-side and replaced with
// a generic message so internals never leak to the browser.

export interface FormState {
  error?: string;
  ok?: string;
}

const KNOWN_CODES: Record<string, string> = {
  INSUFFICIENT_CREDITS: "Not enough credits",
  PAIR_WEEKLY_CAP: "Weekly limit reached",
  INVALID_TOKEN: "That code is not valid",
  TOKEN_EXPIRED: "That code has expired",
  INVALID_STATE: "Not possible right now",
  INVALID_INPUT: "Check your input",
  NOT_FOUND: "Not found",
  NOT_AUTHENTICATED: "Please sign in again",
  ALREADY_RATED: "Already rated",
  EMAIL_DOMAIN: "Campus email required",
};

export function toUserMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^([A-Z_]+): ([\s\S]*)$/.exec(message);
  if (match && KNOWN_CODES[match[1]]) {
    return `${KNOWN_CODES[match[1]]}: ${match[2]}`;
  }
  console.error("[lerne] unexpected error", error);
  return "Something went wrong. Please try again.";
}

export function failure(error: unknown): FormState {
  return { error: toUserMessage(error) };
}
