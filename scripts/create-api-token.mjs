import { randomBytes } from "node:crypto";

// Print only the token so it can be captured for Wrangler and the Mac iPad installer.
process.stdout.write(randomBytes(32).toString("base64url") + "\n");
