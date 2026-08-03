import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const isGenerateCommand = process.argv.includes("generate");
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl && !isGenerateCommand) {
  throw new Error("DATABASE_URL is not set");
}

export default defineConfig({
  out: "./drizzle",
  schema: "./backend/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl ?? "postgresql://postgres:postgres@localhost:5432/ai_platform",
  },
});
