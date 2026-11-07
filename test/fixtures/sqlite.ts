import { DatabaseSync } from "node:sqlite";

import type {
  SchemaSqlCursor,
  SchemaSqlStorage,
  SchemaTransactionalStorage,
  SqlPrimitiveValue,
} from "../../src/db/schema.ts";

/**
 * Test fixture: a `SchemaTransactionalStorage` adapter backed by a `node:sqlite`
 * `DatabaseSync`. Mirrors the synchronous Cloudflare Durable Object
 * `ctx.storage` / `ctx.storage.sql` surface used by `src/db/schema.ts`.
 *
 * - `sql.exec(query, ...bindings)` classifies `SELECT` / `PRAGMA` / `WITH` /
 *   `EXPLAIN` statements as reads (`.all()`) and every other statement as a
 *   write (`.run()`), reporting `rowsRead` / `rowsWritten` for the cursor.
 * - `transactionSync(closure)` runs `BEGIN`/`COMMIT` and rolls back
 *   synchronously when the closure throws.
 */

/** Statements that return rows instead of reporting a change count. */
const READ_STATEMENT_PATTERN = /^\s*(?:SELECT|PRAGMA|WITH|EXPLAIN)\b/i;

type NodeSqliteInput = string | number | bigint | null | Uint8Array;

/** Databases retained for each storage instance so callers can close them. */
const storageDatabases = new WeakMap<SchemaTransactionalStorage, DatabaseSync>();

/** Converts a schema-level binding into the `node:sqlite` anonymous binding union. */
function toInputValue(value: SqlPrimitiveValue): NodeSqliteInput {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return value;
}

/** Materialized cursor matching `SchemaSqlCursor`, including statement row counts. */
class NodeSqliteCursor<T extends Record<string, SqlPrimitiveValue>> implements SchemaSqlCursor<T> {
  readonly rowsRead: number;
  readonly rowsWritten: number;
  readonly #rows: readonly T[];

  constructor(rows: readonly T[], rowsWritten: number) {
    this.#rows = rows;
    this.rowsRead = rows.length;
    this.rowsWritten = rowsWritten;
  }

  toArray(): T[] {
    return [...this.#rows];
  }

  one(): T {
    if (this.#rows.length !== 1) {
      throw new Error(`Expected exactly 1 row from one() but received ${this.#rows.length}`);
    }
    return this.#rows[0]!;
  }

  [Symbol.iterator](): Iterator<T> {
    return this.#rows[Symbol.iterator]();
  }
}

/**
 * Creates a `SchemaTransactionalStorage` over `db`, or over a fresh in-memory
 * database when `db` is omitted. The database is created with the default
 * `DatabaseSync` settings (foreign keys enabled, integers read as numbers).
 */
export function createSqliteStorage(
  db: DatabaseSync = new DatabaseSync(":memory:")
): SchemaTransactionalStorage {
  const sql: SchemaSqlStorage = {
    get databaseSize(): number {
      const pageCount = db.prepare("PRAGMA page_count").get() as
        | { page_count?: number }
        | undefined;
      const pageSize = db.prepare("PRAGMA page_size").get() as
        | { page_size?: number }
        | undefined;
      return Number(pageCount?.page_count ?? 0) * Number(pageSize?.page_size ?? 0);
    },

    exec<T extends Record<string, SqlPrimitiveValue> = Record<string, SqlPrimitiveValue>>(
      query: string,
      ...bindings: SqlPrimitiveValue[]
    ): SchemaSqlCursor<T> {
      const statement = db.prepare(query);
      const values = bindings.map(toInputValue);
      if (READ_STATEMENT_PATTERN.test(query)) {
        const rows = statement.all(...values) as unknown as T[];
        return new NodeSqliteCursor<T>(rows, 0);
      }
      const result = statement.run(...values);
      return new NodeSqliteCursor<T>([], Number(result.changes));
    },
  };

  const storage: SchemaTransactionalStorage = {
    sql,
    transactionSync<T>(closure: () => T): T {
      db.exec("BEGIN");
      try {
        const result = closure();
        db.exec("COMMIT");
        return result;
      } catch (error: unknown) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the original failure; SQLite may already have rolled back.
        }
        throw error;
      }
    },
  };

  storageDatabases.set(storage, db);
  return storage;
}

/** Closes the database retained by a storage instance created by this fixture. */
export function closeSqliteStorage(storage: SchemaTransactionalStorage): void {
  const db = storageDatabases.get(storage);
  if (db === undefined) {
    return;
  }
  storageDatabases.delete(storage);
  try {
    db.close();
  } catch {
    // Already closed; closing is idempotent for test teardown purposes.
  }
}

/**
 * Lists user tables visible in the `main` schema (excluding SQLite internals),
 * sorted lexicographically so assertions are order-independent.
 */
export function tableNames(db: DatabaseSync): string[] {
  const rows = db.prepare("PRAGMA table_list").all() as Array<{
    schema: string;
    name: string;
    type: string;
  }>;
  return rows
    .filter((row) => row.schema === "main" && row.type === "table" && !row.name.startsWith("sqlite_"))
    .map((row) => row.name)
    .sort();
}