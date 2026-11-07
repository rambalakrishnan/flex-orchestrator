// Covers: 6
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  CREATE_SCHEMA_MIGRATIONS_TABLE_SQL,
  CURRENT_SCHEMA_VERSION,
  JOB_DO_INDEX_SQL_STATEMENTS,
  JOB_DO_MIGRATIONS,
  JOB_DO_TABLE_DDL,
  REGISTRY_DO_INDEX_SQL_STATEMENTS,
  REGISTRY_DO_MIGRATIONS,
  REGISTRY_DO_TABLE_DDL,
  ROUTER_DO_INDEX_SQL_STATEMENTS,
  ROUTER_DO_MIGRATIONS,
  ROUTER_DO_TABLE_DDL,
  SchemaMigrationError,
  getCurrentSchemaVersion,
  hasTable,
  migrateJobDoSchema,
  migrateRegistryDoSchema,
  migrateRouterDoSchema,
  runSchemaMigrations,
  type SchemaMigrationStep,
  type SchemaSqlCursor,
  type SchemaSqlStorage,
  type SchemaTransactionalStorage,
  type SqlPrimitiveValue,
} from "../../src/db/schema.ts";
import { closeSqliteStorage, createSqliteStorage, tableNames } from "../fixtures/sqlite.ts";

const NOW_ISO = "2026-11-07T00:00:00.000Z";

/** Migration entrypoints with their declared steps, table DDL, and index statements. */
const ENTRYPOINTS = [
  {
    target: "JobDO",
    migrate: migrateJobDoSchema,
    steps: JOB_DO_MIGRATIONS,
    tables: JOB_DO_TABLE_DDL,
    indexStatements: JOB_DO_INDEX_SQL_STATEMENTS,
  },
  {
    target: "RouterDO",
    migrate: migrateRouterDoSchema,
    steps: ROUTER_DO_MIGRATIONS,
    tables: ROUTER_DO_TABLE_DDL,
    indexStatements: ROUTER_DO_INDEX_SQL_STATEMENTS,
  },
  {
    target: "RegistryDO",
    migrate: migrateRegistryDoSchema,
    steps: REGISTRY_DO_MIGRATIONS,
    tables: REGISTRY_DO_TABLE_DDL,
    indexStatements: REGISTRY_DO_INDEX_SQL_STATEMENTS,
  },
] as const;

const openStorages: SchemaTransactionalStorage[] = [];

/** Opens a fresh in-memory `node:sqlite` database wrapping the schema storage adapter. */
function openEmpty(): { db: DatabaseSync; storage: SchemaTransactionalStorage } {
  const db = new DatabaseSync(":memory:");
  const storage = createSqliteStorage(db);
  openStorages.push(storage);
  return { db, storage };
}

/** Extracts the table name from an `ALL_SCHEMA_TABLE_DDL` style statement. */
function tableNameFromDDL(ddl: string): string {
  const match = /CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(ddl);
  if (match === null) {
    throw new Error(`DDL does not declare a table: ${ddl.slice(0, 60)}`);
  }
  return match[1]!;
}

/** Captured `sqlite_master` definitions, used to prove a re-run does not recreate or alter tables. */
function schemaSnapshot(storage: SchemaTransactionalStorage): Array<Record<string, SqlPrimitiveValue>> {
  return storage.sql
    .exec<Record<string, SqlPrimitiveValue>>(
      `SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
    )
    .toArray();
}

/** Lists the explicit `idx_*` indexes (excluding SQLite automatic index names). */
function indexNames(storage: SchemaTransactionalStorage): string[] {
  return storage.sql
    .exec<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name`
    )
    .toArray()
    .map((row) => row.name);
}

afterEach(() => {
  while (openStorages.length > 0) {
    closeSqliteStorage(openStorages.pop()!);
  }
});

describe("migration tracking", () => {
  it("creates _sql_schema_migrations and records each applied migration id", () => {
    const { storage } = openEmpty();

    expect(getCurrentSchemaVersion(storage.sql)).toBe(0);
    expect(CREATE_SCHEMA_MIGRATIONS_TABLE_SQL).toContain("_sql_schema_migrations");

    const result = migrateJobDoSchema(storage);

    expect(result.appliedVersions).toEqual([1]);
    expect(result.version).toBe(1);
    expect(getCurrentSchemaVersion(storage.sql)).toBe(1);
    expect(hasTable(storage.sql, "_sql_schema_migrations")).toBe(true);

    const applied = storage.sql
      .exec<{ id: number; applied_at: string }>(
        "SELECT id, applied_at FROM _sql_schema_migrations ORDER BY id"
      )
      .toArray();
    expect(applied.map((row) => row.id)).toEqual([1]);
    expect(typeof applied[0]!.applied_at).toBe("string");
    expect(applied[0]!.applied_at.length).toBeGreaterThan(0);
  });

  it("applies exactly the declared migration list for each DO entrypoint", () => {
    for (const entrypoint of ENTRYPOINTS) {
      const { db, storage } = openEmpty();
      const result = entrypoint.migrate(storage);

      const declaredVersions = entrypoint.steps.map((step) => step.version);
      expect(result.appliedVersions, `${entrypoint.target} applied versions`).toEqual(
        declaredVersions
      );
      expect(result.version).toBe(declaredVersions[declaredVersions.length - 1]);
      expect(result.version).toBe(CURRENT_SCHEMA_VERSION);

      for (const ddl of entrypoint.tables) {
        expect(
          hasTable(storage.sql, tableNameFromDDL(ddl)),
          `${entrypoint.target} must create ${tableNameFromDDL(ddl)}`
        ).toBe(true);
      }

      const tableList = tableNames(db);
      expect(tableList).toHaveLength(entrypoint.tables.length + 1);
      expect(tableList).toContain("_sql_schema_migrations");
      expect(tableList).toEqual(
        ["_sql_schema_migrations", ...entrypoint.tables.map(tableNameFromDDL)].sort()
      );

      expect(indexNames(storage)).toHaveLength(entrypoint.indexStatements.length);

      const recorded = storage.sql
        .exec<{ id: number }>("SELECT id FROM _sql_schema_migrations ORDER BY id")
        .toArray();
      expect(recorded.map((row) => row.id)).toEqual(declaredVersions);
    }
  });

  it("applies zero new migrations on a second run and neither recreates nor alters tables", () => {
    const { db, storage } = openEmpty();

    const first = migrateJobDoSchema(storage);
    expect(first.appliedVersions).toEqual([1]);
    const beforeSnapshot = schemaSnapshot(storage);
    const beforeTables = tableNames(db);

    storage.sql.exec(
      `INSERT INTO jobs (
         job_id, status, model, reasoning_effort, max_output_tokens, cache_ttl,
         judge_config_json, total_turns, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "job_persist",
      "created",
      "gpt-5",
      "high",
      1024,
      "nocache",
      "{}",
      1,
      NOW_ISO,
      NOW_ISO
    );

    const second = migrateJobDoSchema(storage);

    expect(second.appliedVersions).toEqual([]);
    expect(second.version).toBe(1);
    expect(schemaSnapshot(storage)).toEqual(beforeSnapshot);
    expect(tableNames(db)).toEqual(beforeTables);

    const inserted = storage.sql
      .exec<{ total: number; job_id: string }>(
        "SELECT COUNT(*) AS total, MIN(job_id) AS job_id FROM jobs"
      )
      .one();
    expect(inserted.total).toBe(1);
    expect(inserted.job_id).toBe("job_persist");

    const migrationRows = storage.sql
      .exec<{ id: number }>("SELECT id FROM _sql_schema_migrations ORDER BY id")
      .toArray();
    expect(migrationRows.map((row) => row.id)).toEqual([1]);
  });

  it("accepts the frozen job status vocabulary in the migrated jobs table", () => {
    const { storage } = openEmpty();
    migrateJobDoSchema(storage);

    const insertJob = (jobId: string, status: string): void => {
      storage.sql.exec(
        `INSERT INTO jobs (
           job_id, status, model, reasoning_effort, max_output_tokens, cache_ttl,
           judge_config_json, total_turns, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        jobId,
        status,
        "gpt-5",
        "high",
        1024,
        "nocache",
        "{}",
        1,
        NOW_ISO,
        NOW_ISO
      );
    };

    insertJob("job_ready", "ready");
    expect(
      storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM jobs").one().total
    ).toBe(1);

    expect(() => insertJob("job_legacy", "paused_storage_error")).toThrow(
      /CHECK constraint failed/i
    );
    expect(
      storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM jobs").one().total
    ).toBe(1);
  });
});

describe("partial migration rollback", () => {
  it("rolls back a mid-migration failure and recovers cleanly on the next run", () => {
    const { db, storage } = openEmpty();
    const failureMessage = "simulated mid-migration failure";
    let failOnTurnsCreate = true;

    const failingSql: SchemaSqlStorage = {
      exec<T extends Record<string, SqlPrimitiveValue> = Record<string, SqlPrimitiveValue>>(
        query: string,
        ...bindings: SqlPrimitiveValue[]
      ): SchemaSqlCursor<T> {
        if (failOnTurnsCreate && query.includes("CREATE TABLE IF NOT EXISTS turns")) {
          throw new Error(failureMessage);
        }
        return storage.sql.exec<T>(query, ...bindings);
      },
    };

    const failingStorage: SchemaTransactionalStorage = {
      sql: failingSql,
      transactionSync<T>(closure: () => T): T {
        return storage.transactionSync(closure);
      },
    };

    let thrown: unknown;
    try {
      migrateJobDoSchema(failingStorage);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(SchemaMigrationError);
    const migrationError = thrown as SchemaMigrationError;
    expect(migrationError.code).toBe("SCHEMA_MIGRATION_FAILED");
    expect(migrationError.targetName).toBe("JobDO");
    expect(migrationError.version).toBe(1);
    expect(migrationError.cause).toBeInstanceOf(Error);
    expect((migrationError.cause as Error).message).toContain(failureMessage);

    expect(hasTable(storage.sql, "_sql_schema_migrations")).toBe(true);
    expect(
      storage.sql
        .exec<{ total: number }>("SELECT COUNT(*) AS total FROM _sql_schema_migrations")
        .one().total
    ).toBe(0);
    expect(tableNames(db)).toEqual(["_sql_schema_migrations"]);
    expect(hasTable(storage.sql, "jobs")).toBe(false);
    expect(hasTable(storage.sql, "branch_lineage")).toBe(false);
    expect(hasTable(storage.sql, "turns")).toBe(false);
    expect(getCurrentSchemaVersion(storage.sql)).toBe(0);

    failOnTurnsCreate = false;
    const recovered = migrateJobDoSchema(storage);

    expect(recovered.appliedVersions).toEqual([1]);
    expect(recovered.version).toBe(1);
    expect(hasTable(storage.sql, "turns")).toBe(true);
    expect(tableNames(db)).toHaveLength(JOB_DO_TABLE_DDL.length + 1);
    expect(
      storage.sql
        .exec<{ total: number }>("SELECT COUNT(*) AS total FROM _sql_schema_migrations")
        .one().total
    ).toBe(1);

    storage.sql.exec(
      `INSERT INTO jobs (
         job_id, status, model, reasoning_effort, max_output_tokens, cache_ttl,
         judge_config_json, total_turns, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      "job_after_recovery",
      "created",
      "gpt-5",
      "high",
      1024,
      "nocache",
      "{}",
      1,
      NOW_ISO,
      NOW_ISO
    );
    expect(
      storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM jobs").one().total
    ).toBe(1);
  });
});

describe("migration ordering", () => {
  it("orders the declared migration lists by migration id", () => {
    for (const entrypoint of ENTRYPOINTS) {
      const versions = entrypoint.steps.map((step) => step.version);
      expect(versions, `${entrypoint.target} versions`).toEqual(
        [...versions].sort((left, right) => left - right)
      );
      expect(new Set(versions).size).toBe(versions.length);
      expect(versions[0]).toBe(1);
      expect(versions[versions.length - 1]).toBe(CURRENT_SCHEMA_VERSION);
    }
  });

  it("decides which migrations to apply from recorded ids, not declaration order", () => {
    const { storage } = openEmpty();

    storage.sql.exec(CREATE_SCHEMA_MIGRATIONS_TABLE_SQL);
    storage.sql.exec("INSERT INTO _sql_schema_migrations (id) VALUES (?)", 2);
    expect(getCurrentSchemaVersion(storage.sql)).toBe(2);

    const steps: readonly SchemaMigrationStep[] = [
      {
        version: 2,
        statements: ["CREATE TABLE IF NOT EXISTS ordered_two (id INTEGER PRIMARY KEY) STRICT"],
      },
      {
        version: 3,
        statements: ["CREATE TABLE IF NOT EXISTS ordered_three (id INTEGER PRIMARY KEY) STRICT"],
      },
    ];

    const result = runSchemaMigrations(storage, "OrderingTestDO", steps);

    expect(result.appliedVersions).toEqual([3]);
    expect(result.version).toBe(3);
    expect(hasTable(storage.sql, "ordered_two")).toBe(false);
    expect(hasTable(storage.sql, "ordered_three")).toBe(true);

    const rerun = runSchemaMigrations(storage, "OrderingTestDO", [...steps].reverse());
    expect(rerun.appliedVersions).toEqual([]);
    expect(rerun.version).toBe(3);
    expect(hasTable(storage.sql, "ordered_two")).toBe(false);

    const recorded = storage.sql
      .exec<{ id: number }>("SELECT id FROM _sql_schema_migrations ORDER BY id")
      .toArray();
    expect(recorded.map((row) => row.id)).toEqual([2, 3]);
  });
});

describe("migration source invariants", () => {
  it("never reads or writes PRAGMA user_version", () => {
    const schemaSourcePath = fileURLToPath(new URL("../../src/db/schema.ts", import.meta.url).href);
    const source = readFileSync(schemaSourcePath, "utf8");

    const executableSource = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(executableSource).not.toContain("user_version");
    expect(executableSource).not.toMatch(/PRAGMA\s+user_version/i);

    // The literal only survives in comments documenting that the pragma is unsupported.
    expect(source).toContain("PRAGMA user_version");
    expect(source).toContain("_sql_schema_migrations");
    expect(CREATE_SCHEMA_MIGRATIONS_TABLE_SQL).toContain("_sql_schema_migrations");
    expect(CREATE_SCHEMA_MIGRATIONS_TABLE_SQL).not.toContain("user_version");
  });
});