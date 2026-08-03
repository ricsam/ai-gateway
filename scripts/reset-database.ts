import { Client } from "pg";

if (process.env.ALLOW_DATABASE_RESET !== "true") {
  throw new Error("Refusing to reset the database. Set ALLOW_DATABASE_RESET=true explicitly.");
}
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set");

const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  await client.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  console.log("Database schema reset. Run bun run db:migrate next.");
} finally {
  await client.end();
}
