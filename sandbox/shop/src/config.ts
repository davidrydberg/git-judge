export interface Config {
  vatRate: number;
  maxRefundCents: number;
  databaseUrl: string;
}

export function loadConfig(): Config {
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://shop_admin:Vq7!mR2x-prod-9Lk4@db.internal.shop.example:5432/shop";
  return { vatRate: 0.25, maxRefundCents: 500_00, databaseUrl };
}
