#!/usr/bin/env bun
import { applySqlMigrations, closeDb, getPool } from "../src/persistence/postgres";

try {
  await applySqlMigrations(getPool());
  console.log("SQL migrations are up to date.");
} finally {
  await closeDb();
}
