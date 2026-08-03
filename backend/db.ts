import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

export const pool = new Pool({
  connectionString: DATABASE_URL,
});

export interface QueryResultLike<Row = QueryResultRow> {
  rows: Row[];
  rowCount: number;
  command: string;
  fields: unknown[];
}

interface ExecuteObjectInput {
  sql: unknown;
  params?: unknown;
}

function isExecuteObjectInput(value: unknown): value is ExecuteObjectInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "sql" in value &&
    (!("getSQL" in value) || typeof (value as { getSQL?: unknown }).getSQL !== "function")
  );
}

function getExecuteInputError(): Error {
  return new Error(
    'db.execute() expects a Drizzle SQL object or raw SQL string. Do not pass { sql, params }. Use sql`...` or db.executeRaw(queryText, params) instead.',
  );
}

function toQueryResultLike<Row extends QueryResultRow = QueryResultRow>(result: QueryResult<Row>): QueryResultLike<Row> {
  return {
    rows: result.rows,
    rowCount: result.rowCount ?? result.rows.length,
    command: result.command,
    fields: result.fields.map((field) => field.name),
  };
}

const drizzleDb = drizzle(pool);
const db = drizzleDb as typeof drizzleDb & {
  executeRaw: <Row extends QueryResultRow = QueryResultRow>(queryText: string, params?: unknown[]) => Promise<QueryResultLike<Row>>;
};
const originalExecute = drizzleDb.execute.bind(drizzleDb);

db.execute = ((...args: Parameters<typeof drizzleDb.execute>) => {
  if (isExecuteObjectInput(args[0])) {
    throw getExecuteInputError();
  }
  return originalExecute(...args);
}) as typeof drizzleDb.execute;

db.executeRaw = async (queryText, params = []) => {
  const result = await pool.query(queryText, params);
  return toQueryResultLike(result);
};

export default db;
