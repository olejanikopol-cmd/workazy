import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.env.SITES_PROJECT_ROOT ?? process.cwd();
const hostingPath = resolve(root, "dist", ".openai", "hosting.json");
const migration0000 = resolve(root, "dist", ".openai", "drizzle", "0000_wandering_scarlet_spider.sql");
const migration0001 = resolve(root, "dist", ".openai", "drizzle", "0001_hesitant_jazinda.sql");
const migration0002 = resolve(root, "dist", ".openai", "drizzle", "0002_opposite_kitty_pryde.sql");

await Promise.all([access(hostingPath), access(migration0000), access(migration0001), access(migration0002)]);
const hosting = JSON.parse(await readFile(hostingPath, "utf8"));
if (hosting.d1 !== "DB" || hosting.r2 !== "MEDIA") {
  throw new Error("Sites artifact must bind D1 as DB and R2 as MEDIA");
}

console.log("Sites artifact verified: DB, MEDIA, migrations 0000, 0001 and 0002 are packaged.");
