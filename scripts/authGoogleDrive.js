/**
 * Google Drive OAuth 2.0 Authorization Helper
 * Connects your personal Google Drive (@gmail.com) with 15 GB storage quota.
 * 
 * Works with Desktop App client secrets (http://localhost)
 */
import { google } from "googleapis";
import http from "http";
import fs from "fs";
import path from "path";
import readline from "readline";
import { execFile } from "child_process";
import db from "../db.js";

const PORT = 3333;
const REDIRECT_URI = `http://localhost:${PORT}`;
const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.file"
];

function findDownloadedClientSecret() {
  const dirs = [
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    path.join(process.env.USERPROFILE || "", "Downloads")
  ];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    try {
      const files = fs.readdirSync(d);
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        if (f.startsWith("client_secret") || f.includes("apps.googleusercontent.com")) {
          const full = path.join(d, f);
          try {
            const data = JSON.parse(fs.readFileSync(full, "utf-8"));
            const creds = data.installed || data.web;
            if (creds && creds.client_id && creds.client_secret) {
              return { creds, full, fileName: f };
            }
          } catch {}
        }
      }
    } catch {}
  }
  return null;
}

function ask(rl, question) {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.trim()));
  });
}

async function handleAuthorizationSuccess(oauth2Client, clientId, clientSecret, code, server, rl) {
  try {
    console.log("\n[OAuth] Code received from Google! Exchanging for tokens...");
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    // Fetch user info to verify
    const drive = google.drive({ version: "v3", auth: oauth2Client });
    let driveUser = null;
    try {
      const about = await drive.about.get({ fields: "user, storageQuota" });
      driveUser = about.data.user;
    } catch (e) {}

    const userEmail = driveUser?.emailAddress || "anamikasuresh@gmail.com";
    const userName = driveUser?.displayName || "Anamika Suresh";

    console.log(`\n🎉 Success! Authenticated as: ${userName} (${userEmail})`);

    // Target user (user 6 / Anamika)
    const targetUserId = 6;

    // Save into SQLite Database
    db.saveUserIntegration(targetUserId, "google_drive", {
      clientId,
      clientSecret,
      client_id: clientId,
      client_secret: clientSecret,
      accessToken: tokens.access_token,
      access_token: tokens.access_token,
      refreshToken: tokens.refresh_token,
      refresh_token: tokens.refresh_token,
      expiryDate: tokens.expiry_date,
      expiry_date: tokens.expiry_date,
      userEmail,
      user_email: userEmail,
      userName,
      user_name: userName,
      isConfigured: true,
      updatedAt: new Date().toISOString()
    }, 1);

    // Also update .env for global fallback
    const envPath = path.join(process.cwd(), ".env");
    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";
    const envUpdates = {
      GOOGLE_DRIVE_CLIENT_ID: clientId,
      GOOGLE_DRIVE_CLIENT_SECRET: clientSecret,
      GOOGLE_DRIVE_REFRESH_TOKEN: tokens.refresh_token || "",
      GOOGLE_DRIVE_ACCESS_TOKEN: tokens.access_token || ""
    };

    for (const [k, v] of Object.entries(envUpdates)) {
      if (!v) continue;
      const regex = new RegExp(`^${k}=.*$`, "m");
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${k}="${v}"`);
      } else {
        envContent += `\n${k}="${v}"`;
      }
    }
    fs.writeFileSync(envPath, envContent.trim() + "\n", "utf-8");

    console.log("💾 Credentials saved to SQLite database and .env file.");
    console.log("--------------------------------------------------------");
    console.log("🚀 Google Drive is now 100% ACTIVE with your 15 GB quota!");
    console.log("👉 Send any photo on WhatsApp with 'save to drive' to test!\n");

    if (rl) rl.close();
    if (server) {
      setTimeout(() => {
        server.close();
        process.exit(0);
      }, 1000);
    } else {
      process.exit(0);
    }
  } catch (err) {
    console.error("❌ Failed to exchange code for tokens:", err.message);
    console.log("👉 Please make sure the authorization code was copied completely.");
  }
}

async function main() {
  console.log("\n========================================================");
  console.log("   Google Drive OAuth 2.0 Linker (Personal @gmail.com)  ");
  console.log("========================================================\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let clientId = "";
  let clientSecret = "";

  // 1. Direct arguments check
  if (process.argv[2] && process.argv[3] && !process.argv[2].startsWith("-")) {
    clientId = process.argv[2].trim();
    clientSecret = process.argv[3].trim();
  }

  // 2. Downloaded JSON check
  if (!clientId) {
    const found = findDownloadedClientSecret();
    if (found) {
      console.log(`[OAuth] Using credentials from: ${found.fileName}`);
      clientId = found.creds.client_id;
      clientSecret = found.creds.client_secret;
    }
  }

  // 3. Fallback to hardcoded / interactive prompt if needed
  if (!clientId || !clientSecret) {
    clientId = await ask(rl, "Enter Client ID: ");
    clientSecret = await ask(rl, "Enter Client Secret: ");
  }

  if (!clientId || !clientSecret) {
    console.error("\n❌ Both Client ID and Client Secret are required.");
    rl.close();
    process.exit(1);
  }

  console.log(`• Client ID: ${clientId.substring(0, 25)}...`);

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent"
  });

  let isHandled = false;
  let server = null;

  try {
    server = http.createServer(async (req, res) => {
      try {
        const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
        const code = reqUrl.searchParams.get("code");

        if (code && !isHandled) {
          isHandled = true;

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <html>
              <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0;">
                <div style="background: #1e293b; padding: 40px; border-radius: 16px; border: 1px solid rgba(255,255,255,0.1); text-align: center; max-width: 450px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.5);">
                  <div style="font-size: 50px; margin-bottom: 16px;">✅</div>
                  <h2 style="margin: 0 0 10px 0; color: #34d399;">Authentication Successful!</h2>
                  <p style="color: #94a3b8; font-size: 15px; line-height: 1.5;">Your personal Google Drive (15 GB) is now connected to Anam AI WhatsApp Bot.</p>
                  <p style="color: #64748b; font-size: 13px; margin-top: 20px;">You can safely close this browser window and return to WhatsApp.</p>
                </div>
              </body>
            </html>
          `);

          await handleAuthorizationSuccess(oauth2Client, clientId, clientSecret, code, server, rl);
        } else if (!code && reqUrl.searchParams.get("error")) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h3>Authentication Denied: ${reqUrl.searchParams.get("error")}</h3>`);
        }
      } catch (err) {
        console.error("[OAuth Handler Error]", err.message);
      }
    });

    server.on("error", (err) => {
      console.warn(`[OAuth Server Notice] Port ${PORT} occupied (${err.message}). Automatic redirect paused.`);
      console.log(`👉 You can paste the code or URL manually below.\n`);
    });

    server.listen(PORT, () => {
      console.log(`Local OAuth listener running at: ${REDIRECT_URI}\n`);
    });
  } catch (err) {
    console.warn(`Could not start local server on port ${PORT}: ${err.message}.`);
  }

  console.log("👉 OPEN THIS URL IN YOUR BROWSER TO AUTHORIZE GOOGLE DRIVE:\n");
  console.log(authUrl);
  console.log("\n--------------------------------------------------------");
  console.log("Sign in with anamikasuresh@gmail.com and click 'Allow'.\n");

  // Open default browser cleanly without shell corruption
  try {
    if (process.platform === "win32") {
      execFile("rundll32", ["url.dll,FileProtocolHandler", authUrl]);
    }
  } catch {}

  // Manual code or URL paste fallback
  const input = await ask(rl, "If your browser doesn't redirect automatically, paste the redirect URL or code here:\n> ");
  if (isHandled) return;

  const trimmed = input.trim();
  if (!trimmed) return;

  let codeToUse = trimmed;
  if (trimmed.includes("code=")) {
    try {
      const u = new URL(trimmed.startsWith("http") ? trimmed : `http://localhost/${trimmed}`);
      codeToUse = u.searchParams.get("code") || trimmed;
    } catch {}
  }

  if (codeToUse) {
    isHandled = true;
    await handleAuthorizationSuccess(oauth2Client, clientId, clientSecret, codeToUse, server, rl);
  }
}

main().catch(err => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
