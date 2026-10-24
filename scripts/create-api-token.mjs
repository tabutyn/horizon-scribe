import { randomBytes } from "node:crypto";

// Print only the token so it can be piped to Wrangler or copied into the iPad app.
process.stdout.write(randomBytes(32).toString("base64url") + "\n");
