import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const envPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.env",
);
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}
