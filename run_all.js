import { spawn } from "child_process";

console.log("⚡ Starting Anam AI WhatsApp SaaS (Web Server + Bot Engine)...");

// 1. Spawn Web Server
const web = spawn("node", ["server.js"], { stdio: "inherit", shell: true });

// 2. Spawn WhatsApp Bot
const bot = spawn("node", ["index.js"], { stdio: "inherit", shell: true });

const cleanup = () => {
  console.log("\n🛑 Stopping Anam AI services...");
  web.kill();
  bot.kill();
  process.exit(0);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
