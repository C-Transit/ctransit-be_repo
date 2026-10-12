export const PASSWORD_RULE_MESSAGE =
  "Password must be at least 8 characters and contain uppercase, lowercase, and numbers";

// 72 is bcrypt's limit: anything longer is silently truncated.
export const isValidPassword = (p: unknown): p is string =>
  typeof p === "string" && /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,72}$/.test(p);