export interface Config {
  vatRate: number;
  maxRefundCents: number;
  databaseUrl: string;
}

export function loadConfig(): Config {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not set");
  }
  return { vatRate: 0.25, maxRefundCents: 500_00, databaseUrl };
}
