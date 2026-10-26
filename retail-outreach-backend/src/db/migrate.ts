import { readFile } from "node:fs/promises";
import { config } from "../config.js";
import { createPool } from "./pool.js";
import { seedDemoData } from "./seed.js";

const pool = createPool(config.DATABASE_URL);
try {
  const sql = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
  await pool.query(sql);
  console.log("Database schema applied.");
  if (!process.argv.includes("--no-seed")) {
    await seedDemoData(pool, config.DEV_TENANT_ID);
    console.log(`Demo data seeded for tenant "${config.DEV_TENANT_ID}".`);
  }
} finally {
  await pool.end();
}
