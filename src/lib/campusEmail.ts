// Mirrors the database rule in handle_new_user(): exactly the ui.ac.id domain.
// The database check is authoritative; this gives users an early, clear error.
export const CAMPUS_DOMAIN = "ui.ac.id";
const CAMPUS_EMAIL = /^[a-z0-9._%+-]+@ui\.ac\.id$/;

/** Lower-cases and trims; returns null unless it is a valid @ui.ac.id address. */
export function normalizeCampusEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  return CAMPUS_EMAIL.test(email) ? email : null;
}
