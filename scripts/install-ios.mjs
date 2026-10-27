import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const local = join(root, ".local");
const configPath = join(local, "ios-device.json");
const setupPath = "Library/Caches/HorizonScribeSetup.json";
const resultPath = "Library/Caches/HorizonScribeSetupResult.json";
const childEnv = { ...process.env };
delete childEnv.HORIZON_SCRIBE_API_TOKEN;

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: root, env: childEnv, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024, ...options,
    });
  } catch {
    // Do not print child output: credential commands can include their input.
    throw new Error(command + " failed. Check Xcode signing, device trust/unlock, and Keychain access.");
  }
}

function validate(config) {
  let url;
  try { url = new URL(config.workerURL); } catch { /* Report a credential-free error below. */ }
  if (!url || url.protocol !== "https:" || !url.hostname || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash)
    throw new Error("--worker-url must be a root HTTPS Worker URL.");
  if (!/^[A-Z0-9]{10}$/.test(config.team ?? "")) throw new Error("--team must be your 10-character Apple team ID.");
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+){2,}$/.test(config.bundleIdPrefix ?? "") ||
      config.bundleIdPrefix.startsWith("org.example."))
    throw new Error("--bundle-id-prefix must be an identifier owned by your Apple team.");
  if (!/^[A-Za-z0-9-]+$/.test(config.device ?? "")) throw new Error("--device must be the iPad UDID from xcrun xctrace list devices.");
  if (!["Debug", "Release"].includes(config.configuration)) throw new Error("--configuration must be Debug or Release.");
  for (const key of ["keychainService", "keychainAccount"]) {
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(config[key] ?? ""))
      throw new Error(key + " must use letters, digits, dots, underscores, or hyphens.");
  }
  config.workerURL = url.origin;
}

function readKeychain(config) {
  return run("/usr/bin/security", ["find-generic-password", "-s", config.keychainService,
    "-a", config.keychainAccount, "-w"]).trim();
}

function saveKeychain(config, token) {
  // Interactive stdin keeps the token out of process arguments and shell history.
  run("/usr/bin/security", ["-i"], { input: "add-generic-password -U -s " +
    config.keychainService + " -a " + config.keychainAccount + " -w " + token + "\n" });
  if (readKeychain(config) !== token) throw new Error("Could not verify the saved Mac Keychain token.");
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("macOS: npm run ios:install -- --worker-url HTTPS_URL --team TEAM_ID --bundle-id-prefix com.yourorg.horizonscribe --device IPAD_UDID [--configuration Debug|Release] [--token-stdin] [--keychain-service SERVICE --keychain-account ACCOUNT]\nSaved options are reused by npm run ios:install. Supply the token through stdin, HORIZON_SCRIBE_API_TOKEN, or Mac Keychain. Never pass a token as an argument.");
    return;
  }
  if (process.platform !== "darwin") throw new Error("iPad installation requires macOS and Xcode.");
  let saved = {};
  try { saved = JSON.parse(await readFile(configPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("Invalid .local/ios-device.json."); }
  const fields = { "--worker-url": "workerURL", "--team": "team", "--bundle-id-prefix": "bundleIdPrefix",
    "--device": "device", "--configuration": "configuration", "--keychain-service": "keychainService",
    "--keychain-account": "keychainAccount" };
  const config = { configuration: "Debug", keychainService: "org.horizon-scribe.installer",
    keychainAccount: "api-token" };
  // Read only recognized non-secret fields; credentials never enter the config.
  for (const key of Object.values(fields)) if (saved[key] != null) config[key] = saved[key];
  let tokenStdin = false;
  while (args.length) {
    const flag = args.shift();
    if (flag === "--token-stdin") { tokenStdin = true; continue; }
    if (!fields[flag] || !args.length || args[0].startsWith("--")) throw new Error("Invalid install option; use --help.");
    config[fields[flag]] = args.shift();
  }
  validate(config);
  let token = process.env.HORIZON_SCRIBE_API_TOKEN?.trim();
  if (tokenStdin) {
    if (process.stdin.isTTY) throw new Error("Pipe the token into --token-stdin; do not enter it as a command argument.");
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 1024) throw new Error("Token input is too long.");
    }
    token = input.trim();
  }
  const suppliedToken = token != null;
  if (!suppliedToken) token = readKeychain(config);
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new Error("API token must contain 32–256 URL-safe characters.");

  console.log("Checking Worker connection…");
  const response = await fetch(config.workerURL + "/v1/catalog", {
    headers: { Authorization: "Bearer " + token }, redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Worker catalog returned HTTP " + response.status + ". Check the token and publish a dataset first.");
  const catalog = await response.json();
  if (catalog.schema !== "horizon-scribe-cloud-catalog/v1" || !catalog.sets?.length)
    throw new Error("Worker catalog is empty or unsupported. Publish a dataset first.");
  if (suppliedToken) saveKeychain(config, token);
  await mkdir(local, { recursive: true, mode: 0o700 });
  await chmod(local, 0o700);
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  await chmod(configPath, 0o600);

  const bundleID = config.bundleIdPrefix + (config.configuration === "Debug" ? ".dev" : "");
  const derived = join(root, "DerivedData", "Device-" + config.configuration);
  console.log("Building " + config.configuration + " for " + bundleID + "…");
  run("/usr/bin/xcodebuild", ["-quiet", "-project", "ios/HorizonScribe.xcodeproj", "-scheme", "HorizonScribe",
    "-configuration", config.configuration, "-destination", "platform=iOS,id=" + config.device,
    "-derivedDataPath", derived, "DEVELOPMENT_TEAM=" + config.team, "PRODUCT_BUNDLE_IDENTIFIER=" + bundleID,
    "CODE_SIGN_STYLE=Automatic", "-allowProvisioningUpdates", "build"]);
  const app = join(derived, "Build", "Products", config.configuration + "-iphoneos", "HorizonScribe.app");
  const device = ["--device", config.device];
  console.log("Installing on iPad…");
  run("/usr/bin/xcrun", ["devicectl", "device", "install", "app", ...device, app]);

  const temporary = await mkdtemp(join(tmpdir(), "horizon-scribe-install-"));
  await chmod(temporary, 0o700);
  try {
    const requestID = randomUUID();
    const transfer = join(temporary, "HorizonScribeSetup.json");
    await writeFile(transfer, JSON.stringify({ schema: "horizon-scribe-device-setup/v1", requestID,
      workerURL: config.workerURL, apiToken: token }), { mode: 0o600, flag: "wx" });
    const domain = [...device, "--domain-type", "appDataContainer", "--domain-identifier", bundleID];
    run("/usr/bin/xcrun", ["devicectl", "device", "copy", "to", ...domain,
      "--source", transfer, "--destination", setupPath]);
    await rm(transfer);
    console.log("Connecting app and checking its setup receipt…");
    run("/usr/bin/xcrun", ["devicectl", "device", "process", "launch", ...device, "--terminate-existing", bundleID]);
    const receiptPath = join(temporary, "receipt.json");
    for (let attempt = 0; attempt < 30; attempt++) {
      await delay(1000);
      let receipt;
      try {
        run("/usr/bin/xcrun", ["devicectl", "device", "copy", "from", ...domain, "--timeout", "5",
          "--source", resultPath, "--destination", receiptPath]);
        receipt = JSON.parse(await readFile(receiptPath, "utf8"));
      } catch { continue; }
      if (receipt.schema !== "horizon-scribe-device-setup-result/v1" || receipt.requestID !== requestID) continue;
      if (receipt.status !== "connected") throw new Error("Credentials reached iPad Keychain, but its connection failed. Check the app status and retry.");
      console.log("Connected on iPad. Dataset: " + receipt.datasetId + ". Transfer file consumed; credentials saved in device Keychain.");
      return;
    }
    throw new Error("Setup receipt not received. Unlock/open the iPad app, then rerun ios:install. The private transfer file remains only if import did not finish.");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error("ios:install: " + error.message);
  process.exitCode = 1;
});
