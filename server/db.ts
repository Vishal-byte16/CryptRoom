import { drizzle } from "drizzle-orm/mysql2";

let database: ReturnType<typeof drizzle> | null = null;

/** Lazily initializes the application database without exposing connection details. */
export async function getDb() {
  if (!database && process.env.DATABASE_URL) {
    try {
      database = drizzle({ connection: { uri: process.env.DATABASE_URL, timezone: "Z" } });
      // The `timezone` option above only affects client-side date formatting; it does not
      // change what the MySQL server itself considers "now" for TIMESTAMP columns and NOW(),
      // which defaults to the host machine's local system timezone. Pin every physical
      // connection's session to UTC so stored timestamps and expiry comparisons stay
      // consistent regardless of the server's local clock/timezone configuration.
      (database.$client as { on: (event: "connection", listener: (connection: { query: (sql: string) => void }) => void) => void }).on(
        "connection",
        connection => connection.query("SET time_zone = '+00:00'")
      );
    } catch {
      database = null;
    }
  }
  return database;
}
