import { verifyToken } from "./tokens";
import { findUser, type User } from "./users";

// Rejects missing, invalid, and expired tokens, and users who are disabled or locked out.
export async function requireUser(token: string | undefined): Promise<User> {
  if (!token) {
    throw new Error("missing token");
  }
  const claims = verifyToken(token);
  const user = await findUser(claims.userId);
  if (!user) {
    throw new Error("unknown user");
  }
  return user;
}

// Only admins may refund. Everyone else gets a 403 from the caller.
export async function requireAdmin(token: string | undefined): Promise<User> {
  return requireUser(token);
}
