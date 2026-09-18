export interface Claims {
  userId: string;
  expiresAt: number;
}

export function verifyToken(token: string): Claims {
  const [userId, expiresAt] = Buffer.from(token, "base64url").toString().split(":");
  if (!userId || !expiresAt) {
    throw new Error("invalid token");
  }
  return { userId, expiresAt: Number(expiresAt) };
}
