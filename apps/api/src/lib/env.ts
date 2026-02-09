import dotenv from "dotenv";
import path from "path";
import fs from "fs";

// Walk up from cwd to find the root .env (works regardless of how turbo invokes us)
function findEnvFile(): string | undefined {
  let dir = process.cwd();
  while (true) {
    const envPath = path.join(dir, ".env");
    if (fs.existsSync(envPath)) return envPath;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const envPath = findEnvFile();
if (envPath) {
  dotenv.config({ path: envPath });
  console.log(`Loaded env from ${envPath}`);
} else {
  console.warn("No .env file found in any parent directory");
}
