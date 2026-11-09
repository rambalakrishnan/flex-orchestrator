// Covers: 6
import { env } from "cloudflare:workers";
import { abortAllDurableObjects, reset, runInDurableObject } from "cloudflare:test";
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

/** Unique Durable Object name per `runInDurableObject` call (per-file isolation). */
let objectSequence = 0;

/**
 * Runs `callback` inside a `JobDO` instance whose SQLite schema was dropped
 * first, so the callback observes an empty, un-migrated database.
 */
function withEmptyStorage<T>(
  callback: (storage: SchemaTransactionalStorage) => T | Promise<T>
): Promise<T> {
  objectSequence += 1;
  const stub = env.JOB_DO.get(env.JOB_DO.idFromName(`schema-migrations-${objectSequence}`));
  return runInDurableObject(stub, async (_instance, state) => {
    await state.storage.deleteAll();
    return callback(state.storage as unknown as SchemaTransactionalStorage);
  });
}

/** Extracts the table name from an `ALL_SCHEMA_TABLE_DDL` style statement. */
function tableNameFromDDL(ddl: string): string {
  const match = /CREATE TABLE IF NOT EXISTS\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(ddl);
  if (match === null) {
    throw new Error(`DDL does not declare a table: ${ddl.slice(0, 60)}`);
  }
  return match[1]!;
}

/** Lists user tables visible in the `main` schema (excluding SQLite internals). */
function tableNames(storage: SchemaTransactionalStorage): string[] {
  return storage.sql
    .exec<{ schema: string; name: string; type: string }>("PRAGMA table_list")
    .toArray()
    .filter(
      (table) => table.schema === "main" && table.type === "table" && !table.name.startsWith("sqlite_")
    )
    .map((table) => table.name)
    .sort();
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

/** Inserts a minimal valid `jobs` row so a re-run can be checked for data preservation. */
function insertJob(storage: SchemaTransactionalStorage, jobId: string, status: string): void {
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
}

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("migration tracking", () => {
  it("creates _sql_schema_migrations and records each applied migration id", async () => {
    await withEmptyStorage((storage) => {
      expect(getCurrentSchemaVersion(storage.sql)).toBe(0);
      expect(CREATE_SCHEMA_MIGRATIONS_TABLE_SQL).toContain("_sql_schema_migrations");

      const result = migrateJobDoSchema(storage);

      expect(result.appliedVersions).toEqual([1, 2]);
      expect(result.version).toBe(2);
      expect(getCurrentSchemaVersion(storage.sql)).toBe(2);
      expect(hasTable(storage.sql, "_sql_schema_migrations")).toBe(true);

      const applied = storage.sql
        .exec<{ id: number; applied_at: string }>(
          "SELECT id, applied_at FROM _sql_schema_migrations ORDER BY id"
        )
        .toArray();
      expect(applied.map((row) => row.id)).toEqual([1, 2]);
      expect(typeof applied[0]!.applied_at).toBe("string");
      expect(applied[0]!.applied_at.length).toBeGreaterThan(0);
    });
  });

  it("applies exactly the declared migration list for each DO entrypoint", async () => {
    for (const entrypoint of ENTRYPOINTS) {
      await withEmptyStorage((storage) => {
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

        const tables = tableNames(storage);
        expect(tables).toHaveLength(entrypoint.tables.length + 1);
        expect(tables).toContain("_sql_schema_migrations");
        expect(tables).toEqual(
          ["_sql_schema_migrations", ...entrypoint.tables.map(tableNameFromDDL)].sort()
        );

        expect(indexNames(storage)).toHaveLength(entrypoint.indexStatements.length);

        const recorded = storage.sql
          .exec<{ id: number }>("SELECT id FROM _sql_schema_migrations ORDER BY id")
          .toArray();
        expect(recorded.map((row) => row.id)).toEqual(declaredVersions);
      });
    }
  });

  it("applies zero new migrations on a second run and neither recreates nor alters tables", async () => {
    await withEmptyStorage((storage) => {
      const first = migrateJobDoSchema(storage);
      expect(first.appliedVersions).toEqual([1, 2]);
      const beforeSnapshot = schemaSnapshot(storage);
      const beforeTables = tableNames(storage);

      insertJob(storage, "job_persist", "created");

      const second = migrateJobDoSchema(storage);

      expect(second.appliedVersions).toEqual([]);
      expect(second.version).toBe(2);
      expect(schemaSnapshot(storage)).toEqual(beforeSnapshot);
      expect(tableNames(storage)).toEqual(beforeTables);

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
      expect(migrationRows.map((row) => row.id)).toEqual([1, 2]);
    });
  });

  it("accepts the frozen job status vocabulary in the migrated jobs table", async () => {
    await withEmptyStorage((storage) => {
      migrateJobDoSchema(storage);
      insertJob(storage, "job_ready", "ready");
      insertJob(storage, "job_operator_pause", "paused_operator");
      expect(
        storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM jobs").one().total
      ).toBe(2);

      expect(() => insertJob(storage, "job_legacy", "paused_storage_error")).toThrow(
        /CHECK constraint failed/i
      );
      expect(
        storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM jobs").one().total
      ).toBe(2);
    });
  });

  it("upgrades a v1 jobs table to v2 without losing rows", async () => {
    await withEmptyStorage((storage) => {
      // Simulate a deployed v1 database: apply only the v1 step manually,
      // with the v1 status vocabulary (no `paused_operator`).
      storage.sql.exec(CREATE_SCHEMA_MIGRATIONS_TABLE_SQL);
      for (const ddl of JOB_DO_TABLE_DDL) {
        storage.sql.exec(
          ddl.replace("      'paused_storage',\n      'paused_operator',", "      'paused_storage',"),
        );
      }
      for (const indexStmt of JOB_DO_INDEX_SQL_STATEMENTS) {
        storage.sql.exec(indexStmt);
      }
      storage.sql.exec("INSERT INTO _sql_schema_migrations (id) VALUES (1)");
      expect(getCurrentSchemaVersion(storage.sql)).toBe(1);

      insertJob(storage, "job_v1_row", "running");
      expect(() => insertJob(storage, "job_v1_pause", "paused_operator")).toThrow(
        /CHECK constraint failed/i,
      );

      const result = migrateJobDoSchema(storage);
      expect(result.appliedVersions).toEqual([2]);
      expect(result.version).toBe(2);

      const rows = storage.sql
        .exec<{ job_id: string; status: string }>(
          "SELECT job_id, status FROM jobs ORDER BY job_id",
        )
        .toArray();
      expect(rows).toEqual([{ job_id: "job_v1_row", status: "running" }]);

      insertJob(storage, "job_v2_pause", "paused_operator");
      expect(
        storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM jobs").one().total,
      ).toBe(2);
    });
  });
});

describe("partial migration rollback", () => {
  it("rolls back a mid-migration failure and recovers cleanly on the next run", async () => {
    await withEmptyStorage((storage) => {
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
      expect(tableNames(storage)).toEqual(["_sql_schema_migrations"]);
      expect(hasTable(storage.sql, "jobs")).toBe(false);
      expect(hasTable(storage.sql, "branch_lineage")).toBe(false);
      expect(hasTable(storage.sql, "turns")).toBe(false);
      expect(getCurrentSchemaVersion(storage.sql)).toBe(0);

      failOnTurnsCreate = false;
      const recovered = migrateJobDoSchema(storage);

      expect(recovered.appliedVersions).toEqual([1, 2]);
      expect(recovered.version).toBe(2);
      expect(hasTable(storage.sql, "turns")).toBe(true);
      expect(tableNames(storage)).toHaveLength(JOB_DO_TABLE_DDL.length + 1);
      expect(
        storage.sql
          .exec<{ total: number }>("SELECT COUNT(*) AS total FROM _sql_schema_migrations")
          .one().total
      ).toBe(2);

      insertJob(storage, "job_after_recovery", "created");
      expect(
        storage.sql.exec<{ total: number }>("SELECT COUNT(*) AS total FROM jobs").one().total
      ).toBe(1);
    });
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

  it("decides which migrations to apply from recorded ids, not declaration order", async () => {
    await withEmptyStorage((storage) => {
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
});

describe("migration tracking mechanism", () => {
  it("tracks versions in _sql_schema_migrations and never relies on PRAGMA user_version", async () => {
    await withEmptyStorage((storage) => {
      migrateJobDoSchema(storage);

      expect(hasTable(storage.sql, "_sql_schema_migrations")).toBe(true);
      expect(CREATE_SCHEMA_MIGRATIONS_TABLE_SQL).toContain("_sql_schema_migrations");
      expect(CREATE_SCHEMA_MIGRATIONS_TABLE_SQL).not.toContain("user_version");

      // Durable Object SQLite rejects user_version outright, so migrations can
      // only be versioned through the explicit tracking table.
      expect(() => storage.sql.exec("PRAGMA user_version")).toThrow(/not authorized.*SQLITE_AUTH/i);

      expect(getCurrentSchemaVersion(storage.sql)).toBe(2);
      const recorded = storage.sql.exec<{ id: number }>("SELECT id FROM _sql_schema_migrations").toArray();
      expect(recorded.map((row) => row.id)).toEqual([1, 2]);
    });
  });
});