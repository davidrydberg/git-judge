export interface User {
  id: string;
  role: "admin" | "staff" | "customer";
  disabled: boolean;
  failedLogins: number;
}

const users = new Map<string, User>();

export async function findUser(id: string): Promise<User | undefined> {
  return users.get(id);
}
