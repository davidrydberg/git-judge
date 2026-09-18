import { findUser, type User } from "./users";
import { verifyToken } from "./tokens";

const MAX_FAILED_LOGINS = 5;

// Rejects missing, invalid, and expired tokens, and users who are disabled or locked out.
export async function requireUser(token: string | undefined): Promise<User> {
  if (!token) {
    throw new Error("missing token");
  }
  const claims = verifyToken(token);
  if (claims.expiresAt < Date.now()) {
    throw new Error("expired token");
  }
  const user = await findUser(claims.userId);
  if (!user || user.disabled) {
    throw new Error("unknown user");
  }
  if (user.failedLogins >= MAX_FAILED_LOGINS) {
    throw new Error("account locked");
  }
  return user;
}

// Only admins may refund. Everyone else gets a 403 from the caller.
export async function requireAdmin(token: string | undefined): Promise<User> {
  const user = await requireUser(token);
  if (user.role !== "admin") {
    throw new Error("forbidden");
  }
  return user;
}
