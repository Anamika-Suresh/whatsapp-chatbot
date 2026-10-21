import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import db from "./db.js";
import jiraService, { testJiraConnection, getJiraIssues, createJiraIssue } from "./services/jiraService.js";
import googleCalendarService, { 
  testCalendarConnection, 
  listCalendarEvents, 
  createCalendarEvent, 
  createInstantGoogleMeet,
  generateGoogleMeetLink,
  findLocalServiceAccount, 
  cleanPemKey, 
  getEffectiveCalendarConfig 
} from "./services/googleCalendarService.js";
import googleDriveService, {
  testDriveConnection,
  listDriveFiles,
  searchDriveFiles,
  uploadDriveFile,
  createDriveFolder,
  shareDriveFile,
  deleteDriveFile,
  getEffectiveDriveConfig
} from "./services/googleDriveService.js";
import asanaService, {
  testAsanaConnection,
  getAsanaWorkspaces,
  getAsanaProjects,
  getAsanaTasks,
  createAsanaTask,
  updateAsanaTask,
  createAsanaProject
} from "./services/asanaService.js";
import emailService, {
  cleanAppPassword,
  getEffectiveEmailConfig,
  verifyEmailConnection,
  sendEmail
} from "./services/emailService.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "anam_saas_jwt_secret_key_2026_dev_secure";
const BOT_STATE_FILE = path.join(__dirname, "bot_state.json");

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(cookieParser());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// JWT Auth Middleware
function authenticateToken(req, res, next) {
  let token = null;

  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  } else if (req.cookies && req.cookies.auth_token) {
    token = req.cookies.auth_token;
  }

  if (!token) {
    return res.status(401).json({ success: false, error: "Authentication required" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.getUserById(decoded.id);
    if (!user) {
      return res.status(401).json({ success: false, error: "User not found" });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(403).json({ success: false, error: "Invalid or expired token" });
  }
}

// ---------------- AUTH ROUTES ----------------

// 1. Sign Up
app.post("/api/auth/signup", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || name.trim().length < 2) {
      return res.status(400).json({ success: false, error: "Name must be at least 2 characters." });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ success: false, error: "Please provide a valid email address." });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, error: "Password must be at least 6 characters." });
    }

    const existingUser = db.getUserByEmail(email);
    if (existingUser) {
      return res.status(409).json({ success: false, error: "An account with this email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = db.createUser(name, email, passwordHash);

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: "lax"
    });

    const safeUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      authToken: user.auth_token,
      isVerified: Boolean(user.is_verified),
      whatsappJid: user.whatsapp_jid,
      phoneNumber: user.phone_number,
      createdAt: user.created_at
    };

    return res.status(201).json({
      success: true,
      message: "Account created successfully!",
      token,
      user: safeUser
    });
  } catch (err) {
    console.error("[Auth Signup Error]", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// 2. Sign In
app.post("/api/auth/signin", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ success: false, error: "Email and password are required." });
    }

    const user = db.getUserByEmail(email);
    if (!user) {
      return res.status(401).json({ success: false, error: "Invalid email or password." });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: "Invalid email or password." });
    }

    db.updateLastActive(user.id);

    const token = jwt.sign(
      { id: user.id, email: user.email, name: user.name },
      JWT_SECRET,
      { expiresIn: "30d" }
    );

    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 30 * 24 * 60 * 60 * 1000,
      sameSite: "lax"
    });

    const safeUser = {
      id: user.id,
      name: user.name,
      email: user.email,
      authToken: user.auth_token,
      isVerified: Boolean(user.is_verified),
      whatsappJid: user.whatsapp_jid,
      phoneNumber: user.phone_number,
      createdAt: user.created_at
    };

    return res.json({
      success: true,
      message: "Signed in successfully!",
      token,
      user: safeUser
    });
  } catch (err) {
    console.error("[Auth Signin Error]", err);
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
});

// 3. Current User Profile
app.get("/api/auth/me", authenticateToken, (req, res) => {
  const user = db.getUserById(req.user.id);
  if (!user) {
    return res.status(404).json({ success: false, error: "User not found" });
  }

  const safeUser = {
    id: user.id,
    name: user.name,
    email: user.email,
    authToken: user.auth_token,
    isVerified: Boolean(user.is_verified),
    whatsappJid: user.whatsapp_jid,
    phoneNumber: user.phone_number,
    createdAt: user.created_at,
    lastActiveAt: user.last_active_at
  };

  return res.json({ success: true, user: safeUser });
});

// 4. Logout
app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("auth_token");
  return res.json({ success: true, message: "Logged out successfully" });
});

// ---------------- USER TOKEN & WHATSAPP SETTINGS ----------------

// Regenerate Token
app.post("/api/user/regenerate-token", authenticateToken, (req, res) => {
  try {
    const updated = db.regenerateAuthToken(req.user.id);
    return res.json({
      success: true,
      message: "New verification token generated successfully!",
      authToken: updated.auth_token
    });
  } catch (err) {
    console.error("[Regenerate Token Error]", err);
    return res.status(500).json({ success: false, error: "Failed to regenerate token" });
  }
});

// Unlink WhatsApp
app.post("/api/user/unlink-whatsapp", authenticateToken, (req, res) => {
  try {
    const updated = db.unlinkUserWhatsApp(req.user.id);
    return res.json({
      success: true,
      message: "WhatsApp disconnected from your account.",
      user: {
        id: updated.id,
        isVerified: Boolean(updated.is_verified),
        whatsappJid: null,
        phoneNumber: null
      }
    });
  } catch (err) {
    console.error("[Unlink Error]", err);
    return res.status(500).json({ success: false, error: "Failed to unlink WhatsApp" });
  }
});

// ---------------- TODOS MANAGEMENT ----------------

// Get Todos (Unified: pure checklist tasks + scheduled reminder tasks)
app.get("/api/user/todos", authenticateToken, (req, res) => {
  try {
    const rawTodos = db.getUserTodos(req.user.id);
    const rawReminders = db.getUserReminders(req.user.id);

    const mappedTodos = rawTodos.map(t => ({
      id: String(t.id),
      numericId: t.id,
      name: t.name,
      description: t.description || "",
      status: t.status, // 'pending' | 'completed'
      target_timestamp: null,
      is_reminder: false,
      created_at: t.created_at,
      completed_at: t.completed_at
    }));

    const mappedReminders = rawReminders.map(r => ({
      id: `rem_${r.id}`,
      numericId: r.id,
      name: r.name,
      description: r.description || "",
      status: r.status === "sent" ? "completed" : "pending",
      target_timestamp: r.target_timestamp,
      is_reminder: true,
      media_path: r.media_path,
      media_type: r.media_type,
      created_at: r.created_at
    }));

    // Combine and sort: pending first, completed last.
    // Within pending: items with target_timestamp sorted ascending, then pure todos by id.
    const combined = [...mappedTodos, ...mappedReminders].sort((a, b) => {
      const aDone = a.status === "completed";
      const bDone = b.status === "completed";
      if (aDone !== bDone) return aDone ? 1 : -1;

      if (a.target_timestamp && b.target_timestamp) {
        return a.target_timestamp - b.target_timestamp;
      }
      if (a.target_timestamp) return -1;
      if (b.target_timestamp) return 1;

      return (a.numericId || 0) - (b.numericId || 0);
    });

    return res.json({ success: true, todos: combined });
  } catch (err) {
    console.error("[Get Todos Error]", err);
    return res.status(500).json({ success: false, error: "Failed to fetch to-dos" });
  }
});

// Add Todo
app.post("/api/user/todos", authenticateToken, (req, res) => {
  try {
    const { name, description } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: "Task name is required" });
    }
    const todo = db.addTodo(req.user.id, name, description || "");
    return res.status(201).json({
      success: true,
      todo: {
        id: String(todo.id),
        numericId: todo.id,
        name: todo.name,
        description: todo.description,
        status: todo.status,
        target_timestamp: null,
        is_reminder: false
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Failed to add to-do" });
  }
});

// Toggle Todo
app.patch("/api/user/todos/:id/toggle", authenticateToken, (req, res) => {
  try {
    const rawId = String(req.params.id);

    if (rawId.startsWith("rem_")) {
      const reminderId = parseInt(rawId.replace("rem_", ""), 10);
      const rem = db.getReminderById(reminderId);
      if (!rem || rem.user_id !== req.user.id) {
        return res.status(404).json({ success: false, error: "Task not found" });
      }

      const newStatus = rem.status === "sent" ? "pending" : "sent";
      db.updateReminderStatus(reminderId, newStatus);

      try {
        fs.writeFileSync(path.join(__dirname, ".reminders_sync"), String(Date.now()));
      } catch (e) {}

      return res.json({
        success: true,
        todo: {
          id: rawId,
          numericId: reminderId,
          name: rem.name,
          description: rem.description,
          status: newStatus === "sent" ? "completed" : "pending",
          target_timestamp: rem.target_timestamp,
          is_reminder: true
        }
      });
    }

    const todoId = parseInt(rawId, 10);
    const updated = db.toggleTodo(req.user.id, todoId);
    if (!updated) {
      return res.status(404).json({ success: false, error: "To-do not found" });
    }
    return res.json({
      success: true,
      todo: {
        id: String(updated.id),
        numericId: updated.id,
        name: updated.name,
        description: updated.description,
        status: updated.status,
        target_timestamp: null,
        is_reminder: false
      }
    });
  } catch (err) {
    console.error("[Toggle Todo Error]", err);
    return res.status(500).json({ success: false, error: "Failed to update to-do" });
  }
});

// Delete Todo
app.delete("/api/user/todos/:id", authenticateToken, (req, res) => {
  try {
    const rawId = String(req.params.id);

    if (rawId.startsWith("rem_")) {
      const reminderId = parseInt(rawId.replace("rem_", ""), 10);
      db.deleteReminder(req.user.id, reminderId);
      try {
        fs.writeFileSync(path.join(__dirname, ".reminders_sync"), String(Date.now()));
      } catch (e) {}
      return res.json({ success: true, message: "Task deleted" });
    }

    const todoId = parseInt(rawId, 10);
    db.deleteTodo(req.user.id, todoId);
    return res.json({ success: true, message: "Task deleted" });
  } catch (err) {
    console.error("[Delete Todo Error]", err);
    return res.status(500).json({ success: false, error: "Failed to delete to-do" });
  }
});

// ---------------- REMINDERS MANAGEMENT ----------------

// Get Reminders
app.get("/api/user/reminders", authenticateToken, (req, res) => {
  try {
    const reminders = db.getUserReminders(req.user.id);
    return res.json({ success: true, reminders });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Failed to fetch reminders" });
  }
});

// Add Reminder
app.post("/api/user/reminders", authenticateToken, async (req, res) => {
  try {
    const { name, description, targetTimestamp } = req.body;
    if (!name || !targetTimestamp) {
      return res.status(400).json({ success: false, error: "Name and scheduled time are required" });
    }
    const reminder = db.addReminder(req.user.id, {
      name,
      description,
      targetTimestamp: Number(targetTimestamp)
    });
    try {
      fs.writeFileSync(path.join(__dirname, ".reminders_sync"), String(Date.now()));
    } catch (e) {}

    // Auto-sync with Google Calendar if configured
    let calSynced = false;
    try {
      const calConfig = db.getUserIntegration(req.user.id, "google_calendar");
      const effCal = getEffectiveCalendarConfig(calConfig);
      if (effCal.isConfigured) {
        const calEvent = await createCalendarEvent(calConfig, {
          summary: `⏰ ${name}`,
          description: description ? `${description}\n\n[Created via Anam AI Web Dashboard]` : "Created via Anam AI Web Dashboard",
          startDateTime: new Date(Number(targetTimestamp)).toISOString(),
          durationMinutes: 30
        });
        if (calEvent && calEvent.id) {
          calSynced = true;
        }
      }
    } catch (calErr) {
      console.warn("[Dashboard Reminder Cal Sync Notice]:", calErr.message);
    }

    return res.status(201).json({ success: true, reminder, calSynced });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Failed to schedule reminder" });
  }
});

// Delete Reminder
app.delete("/api/user/reminders/:id", authenticateToken, (req, res) => {
  try {
    const reminderId = parseInt(req.params.id, 10);
    db.deleteReminder(req.user.id, reminderId);
    try {
      fs.writeFileSync(path.join(__dirname, ".reminders_sync"), String(Date.now()));
    } catch (e) {}
    return res.json({ success: true, message: "Reminder deleted" });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Failed to delete reminder" });
  }
});

// ---------------- PLATFORM INTEGRATIONS (JIRA, GOOGLE CALENDAR) ----------------

// Get user integration statuses
app.get("/api/user/integrations", authenticateToken, (req, res) => {
  try {
    const jiraConfig = db.getUserIntegration(req.user.id, "jira");
    const calendarConfig = db.getUserIntegration(req.user.id, "google_calendar");
    const asanaConfig = db.getUserIntegration(req.user.id, "asana");

    // Check global fallbacks
    const hasGlobalJira = Boolean(process.env.JIRA_HOST && process.env.JIRA_EMAIL && process.env.JIRA_API_TOKEN);
    const hasGlobalCalendar = Boolean(
      (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) ||
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    );
    const hasGlobalAsana = Boolean(process.env.ASANA_ACCESS_TOKEN);

    const jiraStatus = {
      platform: "jira",
      connected: Boolean(jiraConfig?.apiToken) || hasGlobalJira,
      isGlobal: !jiraConfig?.apiToken && hasGlobalJira,
      host: jiraConfig?.host || process.env.JIRA_HOST || "",
      email: jiraConfig?.email || process.env.JIRA_EMAIL || "",
      defaultProject: jiraConfig?.defaultProject || process.env.JIRA_DEFAULT_PROJECT || "",
      hasToken: Boolean(jiraConfig?.apiToken || process.env.JIRA_API_TOKEN),
      updatedAt: jiraConfig?.updatedAt || null
    };

    const calendarStatus = {
      platform: "google_calendar",
      connected: Boolean((calendarConfig?.clientEmail && calendarConfig?.privateKey) || calendarConfig?.serviceAccountJson || calendarConfig?.accessToken) || hasGlobalCalendar,
      isGlobal: !calendarConfig?.clientEmail && hasGlobalCalendar,
      calendarId: calendarConfig?.calendarId || process.env.GOOGLE_CALENDAR_ID || "primary",
      clientEmail: calendarConfig?.clientEmail || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
      hasCredentials: Boolean(
        (calendarConfig?.clientEmail && calendarConfig?.privateKey) ||
        calendarConfig?.serviceAccountJson ||
        calendarConfig?.accessToken ||
        hasGlobalCalendar
      ),
      updatedAt: calendarConfig?.updatedAt || null
    };

    const asanaStatus = {
      platform: "asana",
      connected: Boolean(asanaConfig?.accessToken) || hasGlobalAsana,
      isGlobal: !asanaConfig?.accessToken && hasGlobalAsana,
      workspaceId: asanaConfig?.workspaceId || process.env.ASANA_DEFAULT_WORKSPACE || "",
      defaultProject: asanaConfig?.defaultProject || process.env.ASANA_DEFAULT_PROJECT || "",
      defaultProjectName: asanaConfig?.defaultProjectName || "",
      userName: asanaConfig?.userName || "",
      userEmail: asanaConfig?.userEmail || "",
      hasToken: Boolean(asanaConfig?.accessToken || process.env.ASANA_ACCESS_TOKEN),
      updatedAt: asanaConfig?.updatedAt || null
    };

    const emailConfig = db.getUserIntegration(req.user.id, "email");
    const hasGlobalEmail = Boolean(
      (process.env.GMAIL_USER || process.env.EMAIL_USER) &&
      (process.env.GMAIL_APP_PASSWORD || process.env.EMAIL_APP_PASSWORD)
    );

    const emailStatus = {
      platform: "email",
      connected: Boolean(emailConfig?.email && emailConfig?.appPassword) || hasGlobalEmail,
      isGlobal: !(emailConfig?.email && emailConfig?.appPassword) && hasGlobalEmail,
      email: emailConfig?.email || process.env.GMAIL_USER || process.env.EMAIL_USER || "",
      senderName: emailConfig?.senderName || process.env.EMAIL_SENDER_NAME || "",
      hasPassword: Boolean(emailConfig?.appPassword || process.env.GMAIL_APP_PASSWORD || process.env.EMAIL_APP_PASSWORD),
      updatedAt: emailConfig?.updatedAt || null
    };

    const driveConfig = db.getUserIntegration(req.user.id, "google_drive");
    const localDriveSA = findLocalServiceAccount();
    const hasGlobalDrive = Boolean(
      (process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_DRIVE_PRIVATE_KEY) ||
      (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) ||
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
      localDriveSA
    );

    const driveStatus = {
      platform: "google_drive",
      connected: Boolean(
        (driveConfig?.clientEmail && driveConfig?.privateKey) ||
        driveConfig?.serviceAccountJson ||
        driveConfig?.accessToken ||
        hasGlobalDrive
      ),
      isGlobal: !(driveConfig?.clientEmail && driveConfig?.privateKey) && hasGlobalDrive,
      folderId: driveConfig?.folderId || process.env.GOOGLE_DRIVE_FOLDER_ID || "",
      clientEmail: driveConfig?.clientEmail || localDriveSA?.client_email || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
      hasCredentials: Boolean(
        (driveConfig?.clientEmail && driveConfig?.privateKey) ||
        driveConfig?.serviceAccountJson ||
        driveConfig?.accessToken ||
        hasGlobalDrive
      ),
      updatedAt: driveConfig?.updatedAt || null
    };

    return res.json({
      success: true,
      integrations: {
        jira: jiraStatus,
        google_calendar: calendarStatus,
        google_drive: driveStatus,
        asana: asanaStatus,
        email: emailStatus
      }
    });
  } catch (err) {
    console.error("[Get Integrations Error]", err);
    return res.status(500).json({ success: false, error: "Failed to fetch integrations" });
  }
});

// Save or Update Jira Settings
app.post("/api/user/integrations/jira", authenticateToken, async (req, res) => {
  try {
    const { host, email, apiToken, defaultProject } = req.body;
    if (!host || !email) {
      return res.status(400).json({ success: false, error: "Jira Host and Account Email are required." });
    }

    const existing = db.getUserIntegration(req.user.id, "jira") || {};
    let finalToken = apiToken;
    if (!finalToken || finalToken === "••••••••") {
      finalToken = existing.apiToken || process.env.JIRA_API_TOKEN || "";
    }

    if (!finalToken) {
      return res.status(400).json({ success: false, error: "Jira API Token is required." });
    }

    let cleanProj = (defaultProject || "").trim().toUpperCase();
    if (cleanProj.includes("-")) {
      cleanProj = cleanProj.split("-")[0].trim();
    }

    const configObj = {
      host: host.trim(),
      email: email.trim(),
      apiToken: finalToken.trim(),
      defaultProject: cleanProj
    };

    db.saveUserIntegration(req.user.id, "jira", configObj, 1);

    return res.json({
      success: true,
      message: "Jira integration saved successfully!",
      integration: {
        platform: "jira",
        host: configObj.host,
        email: configObj.email,
        defaultProject: configObj.defaultProject,
        connected: true
      }
    });
  } catch (err) {
    console.error("[Save Jira Error]", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to save Jira settings" });
  }
});

// Test Jira Connection
app.post("/api/user/integrations/jira/test", authenticateToken, async (req, res) => {
  try {
    const existing = db.getUserIntegration(req.user.id, "jira") || {};
    const host = req.body.host || existing.host;
    const email = req.body.email || existing.email;
    let apiToken = req.body.apiToken;
    if (!apiToken || apiToken === "••••••••") {
      apiToken = existing.apiToken;
    }

    const result = await testJiraConnection({ host, email, apiToken });
    return res.json({
      success: true,
      message: `Connected successfully to Jira as ${result.displayName} (${result.emailAddress})!`,
      details: result
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message || "Could not connect to Jira. Check your domain, email, and API token."
    });
  }
});

// Disconnect Jira
app.delete("/api/user/integrations/jira", authenticateToken, (req, res) => {
  try {
    db.deleteUserIntegration(req.user.id, "jira");
    return res.json({ success: true, message: "Jira integration disconnected." });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Failed to disconnect Jira" });
  }
});

// Auto-detect local service account credentials
app.get("/api/user/integrations/google_calendar/auto-detect", authenticateToken, (req, res) => {
  try {
    const localSA = findLocalServiceAccount();
    if (!localSA) {
      return res.json({ success: false, message: "No Google Service Account JSON file detected in the workspace." });
    }

    return res.json({
      success: true,
      detected: true,
      fileName: localSA.fileName,
      clientEmail: localSA.client_email,
      privateKey: cleanPemKey(localSA.private_key),
      projectId: localSA.project_id,
      suggestedCalendarId: req.user.email || "primary"
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Save or Update Google Calendar Settings
app.post("/api/user/integrations/google_calendar", authenticateToken, async (req, res) => {
  try {
    const { calendarId, clientEmail, privateKey, serviceAccountJson, accessToken } = req.body;
    const existing = db.getUserIntegration(req.user.id, "google_calendar") || {};

    let finalKey = privateKey;
    if (!finalKey || finalKey === "••••••••") {
      finalKey = existing.privateKey || "";
    }
    if (finalKey) {
      finalKey = cleanPemKey(finalKey);
    }

    let finalEmail = (clientEmail || existing.clientEmail || "").trim();
    let finalCalId = (calendarId || existing.calendarId || "primary").trim();

    // Auto-detect from local SA file if needed or if user mistakenly put their personal email into clientEmail
    const localSA = findLocalServiceAccount();
    if (localSA) {
      if (finalEmail && !finalEmail.includes("gserviceaccount.com") && finalEmail.includes("@")) {
        if (finalCalId === "primary" || !finalCalId) {
          finalCalId = finalEmail;
        }
        finalEmail = localSA.client_email;
      }
      if (!finalEmail) {
        finalEmail = localSA.client_email;
      }
      if (!finalKey || !finalKey.includes("BEGIN")) {
        finalKey = cleanPemKey(localSA.private_key);
      }
    }

    const configObj = {
      calendarId: finalCalId,
      clientEmail: finalEmail,
      privateKey: finalKey,
      serviceAccountJson: serviceAccountJson ? serviceAccountJson.trim() : (existing.serviceAccountJson || ""),
      accessToken: accessToken ? accessToken.trim() : (existing.accessToken || "")
    };

    db.saveUserIntegration(req.user.id, "google_calendar", configObj, 1);

    return res.json({
      success: true,
      message: "Google Calendar integration saved successfully!",
      integration: {
        platform: "google_calendar",
        calendarId: configObj.calendarId,
        clientEmail: configObj.clientEmail,
        connected: true
      }
    });
  } catch (err) {
    console.error("[Save Calendar Error]", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to save Google Calendar settings" });
  }
});

// Test Google Calendar Connection
app.post("/api/user/integrations/google_calendar/test", authenticateToken, async (req, res) => {
  try {
    const existing = db.getUserIntegration(req.user.id, "google_calendar") || {};
    const calendarId = req.body.calendarId || existing.calendarId || "primary";
    const clientEmail = req.body.clientEmail || existing.clientEmail;
    let privateKey = req.body.privateKey;
    if (!privateKey || privateKey === "••••••••") {
      privateKey = existing.privateKey;
    }
    const serviceAccountJson = req.body.serviceAccountJson || existing.serviceAccountJson;
    const accessToken = req.body.accessToken || existing.accessToken;

    const result = await testCalendarConnection({ calendarId, clientEmail, privateKey, serviceAccountJson, accessToken });
    return res.json({
      success: true,
      message: `Connected successfully to Google Calendar "${result.summary || result.calendarId}"!`,
      details: result
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message || "Could not connect to Google Calendar. Check your service account credentials or permissions."
    });
  }
});

// Disconnect Google Calendar
app.delete("/api/user/integrations/google_calendar", authenticateToken, (req, res) => {
  try {
    db.deleteUserIntegration(req.user.id, "google_calendar");
    return res.json({ success: true, message: "Google Calendar integration disconnected." });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Failed to disconnect Google Calendar" });
  }
});

// Fetch Jira tickets preview for dashboard
app.get("/api/user/integrations/jira/issues", authenticateToken, async (req, res) => {
  try {
    const config = db.getUserIntegration(req.user.id, "jira");
    const result = await getJiraIssues(config, { maxResults: 10 });
    return res.json({ success: true, issues: result.issues, total: result.total, host: result.host });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// Fetch Calendar events preview for dashboard
app.get("/api/user/integrations/calendar/events", authenticateToken, async (req, res) => {
  try {
    const config = db.getUserIntegration(req.user.id, "google_calendar");
    const timeFrame = req.query.timeFrame || "today";
    const result = await listCalendarEvents(config, { timeFrame, maxResults: 15 });
    return res.json({ success: true, events: result.events, timeFrame: result.timeFrame });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// Create Instant Google Meet link & Calendar event
app.post("/api/user/integrations/calendar/instant-meet", authenticateToken, async (req, res) => {
  try {
    const config = db.getUserIntegration(req.user.id, "google_calendar");
    const summary = (req.body.summary || "Instant Google Meet").trim();
    const durationMinutes = parseInt(req.body.durationMinutes || 30, 10);
    const meet = await createInstantGoogleMeet(config, { summary, durationMinutes });
    return res.json({
      success: true,
      message: "Google Meet link generated and scheduled successfully!",
      meet
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// ---------------- GOOGLE DRIVE ROUTES ----------------

// Auto-detect local service account credentials for Google Drive
app.get("/api/user/integrations/google_drive/auto-detect", authenticateToken, (req, res) => {
  try {
    const localSA = findLocalServiceAccount();
    if (!localSA) {
      return res.json({ success: false, message: "No Google Service Account JSON file detected in the workspace." });
    }

    return res.json({
      success: true,
      detected: true,
      fileName: localSA.fileName,
      clientEmail: localSA.client_email,
      privateKey: cleanPemKey(localSA.private_key),
      projectId: localSA.project_id
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Save or Update Google Drive Settings
app.post("/api/user/integrations/google_drive", authenticateToken, async (req, res) => {
  try {
    const { folderId, clientEmail, privateKey, serviceAccountJson, accessToken, refreshToken, clientId, clientSecret } = req.body;
    const existing = db.getUserIntegration(req.user.id, "google_drive") || {};

    let finalKey = privateKey;
    if (!finalKey || finalKey === "••••••••") {
      finalKey = existing.privateKey || "";
    }
    if (finalKey) {
      finalKey = cleanPemKey(finalKey);
    }

    let finalEmail = (clientEmail || existing.clientEmail || "").trim();
    let finalFolderId = (folderId !== undefined ? folderId : (existing.folderId || "")).trim();

    // Auto-detect from local SA file if needed
    const localSA = findLocalServiceAccount();
    if (localSA) {
      if (!finalEmail) {
        finalEmail = localSA.client_email;
      }
      if (!finalKey || !finalKey.includes("BEGIN")) {
        finalKey = cleanPemKey(localSA.private_key);
      }
    }

    const configObj = {
      folderId: finalFolderId,
      clientEmail: finalEmail,
      privateKey: finalKey,
      serviceAccountJson: serviceAccountJson ? serviceAccountJson.trim() : (existing.serviceAccountJson || ""),
      accessToken: accessToken ? accessToken.trim() : (existing.accessToken || ""),
      refreshToken: refreshToken ? refreshToken.trim() : (existing.refreshToken || ""),
      clientId: clientId ? clientId.trim() : (existing.clientId || ""),
      clientSecret: clientSecret ? clientSecret.trim() : (existing.clientSecret || "")
    };

    db.saveUserIntegration(req.user.id, "google_drive", configObj, 1);

    return res.json({
      success: true,
      message: "Google Drive integration saved successfully!",
      integration: {
        platform: "google_drive",
        folderId: configObj.folderId,
        clientEmail: configObj.clientEmail,
        connected: true
      }
    });
  } catch (err) {
    console.error("[Save Drive Error]", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to save Google Drive settings" });
  }
});

// Test Google Drive Connection
app.post("/api/user/integrations/google_drive/test", authenticateToken, async (req, res) => {
  try {
    const existing = db.getUserIntegration(req.user.id, "google_drive") || {};
    const clientEmail = req.body.clientEmail || existing.clientEmail;
    let privateKey = req.body.privateKey;
    if (!privateKey || privateKey === "••••••••") {
      privateKey = existing.privateKey;
    }
    const folderId = req.body.folderId !== undefined ? req.body.folderId : existing.folderId;
    const serviceAccountJson = req.body.serviceAccountJson || existing.serviceAccountJson;
    const accessToken = req.body.accessToken || existing.accessToken;
    const refreshToken = req.body.refreshToken || existing.refreshToken;
    const clientId = req.body.clientId || existing.clientId;
    const clientSecret = req.body.clientSecret || existing.clientSecret;

    const result = await testDriveConnection({ clientEmail, privateKey, folderId, serviceAccountJson, accessToken, refreshToken, clientId, clientSecret });
    return res.json({
      success: true,
      message: `Connected successfully to Google Drive (${result.clientEmail})!`,
      details: result
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message || "Could not connect to Google Drive. Check your service account credentials or permissions."
    });
  }
});

// Disconnect Google Drive
app.delete("/api/user/integrations/google_drive", authenticateToken, (req, res) => {
  try {
    db.deleteUserIntegration(req.user.id, "google_drive");
    return res.json({ success: true, message: "Google Drive integration disconnected." });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Failed to disconnect Google Drive" });
  }
});

// List Files for Dashboard Preview
app.get("/api/user/integrations/google_drive/files", authenticateToken, async (req, res) => {
  try {
    const config = db.getUserIntegration(req.user.id, "google_drive");
    const query = req.query.query || "";
    const folderId = req.query.folderId !== undefined ? req.query.folderId : undefined;
    const result = await listDriveFiles(config, { query, folderId, pageSize: 20 });
    return res.json({ success: true, files: result.files, total: result.total, folderId: result.folderId });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// Create Folder via Dashboard
app.post("/api/user/integrations/google_drive/folder", authenticateToken, async (req, res) => {
  try {
    const config = db.getUserIntegration(req.user.id, "google_drive");
    const folderName = (req.body.folderName || "").trim();
    const parentFolderId = req.body.parentFolderId || undefined;
    const folder = await createDriveFolder(config, { folderName, parentFolderId });
    return res.json({ success: true, folder, message: `Folder "${folder.name}" created!` });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// ---------------- ASANA ROUTES ----------------

// Save or Update Asana Settings
app.post("/api/user/integrations/asana", authenticateToken, async (req, res) => {
  try {
    const { accessToken, workspaceId, defaultProject, defaultProjectName } = req.body;
    const existing = db.getUserIntegration(req.user.id, "asana") || {};

    let finalToken = accessToken ? accessToken.trim() : "";
    if (!finalToken) {
      finalToken = existing.accessToken || process.env.ASANA_ACCESS_TOKEN || "";
    }

    if (!finalToken) {
      return res.status(400).json({ success: false, error: "Asana Personal Access Token is required." });
    }

    // Verify token with Asana
    let profile = null;
    try {
      profile = await testAsanaConnection({ accessToken: finalToken });
    } catch (testErr) {
      return res.status(400).json({
        success: false,
        error: `Could not verify Asana token: ${testErr.message}`
      });
    }

    let finalWorkspace = (workspaceId || existing.workspaceId || "").trim();
    if (!finalWorkspace && profile.workspaces && profile.workspaces.length > 0) {
      finalWorkspace = profile.workspaces[0].gid;
    }

    const configObj = {
      accessToken: finalToken,
      workspaceId: finalWorkspace,
      defaultProject: (defaultProject || existing.defaultProject || "").trim(),
      defaultProjectName: (defaultProjectName || existing.defaultProjectName || "").trim(),
      userName: profile.name,
      userEmail: profile.email
    };

    db.saveUserIntegration(req.user.id, "asana", configObj, 1);

    return res.json({
      success: true,
      message: `Asana connected successfully for ${profile.name}!`,
      integration: {
        platform: "asana",
        connected: true,
        userName: profile.name,
        userEmail: profile.email,
        workspaceId: configObj.workspaceId,
        defaultProject: configObj.defaultProject,
        defaultProjectName: configObj.defaultProjectName,
        workspaces: profile.workspaces
      }
    });
  } catch (err) {
    console.error("[Save Asana Error]", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to save Asana settings" });
  }
});

// Test Asana Connection
app.post("/api/user/integrations/asana/test", authenticateToken, async (req, res) => {
  try {
    const existing = db.getUserIntegration(req.user.id, "asana") || {};
    const accessToken = req.body.accessToken ? req.body.accessToken.trim() : (existing.accessToken || process.env.ASANA_ACCESS_TOKEN || "");

    if (!accessToken) {
      return res.status(400).json({ success: false, error: "Please enter your Asana Personal Access Token." });
    }

    const profile = await testAsanaConnection({ accessToken });
    let projects = [];
    let activeWorkspace = req.body.workspaceId || existing.workspaceId;
    if (!activeWorkspace && profile.workspaces && profile.workspaces.length > 0) {
      activeWorkspace = profile.workspaces[0].gid;
    }

    if (activeWorkspace) {
      try {
        projects = await getAsanaProjects({ accessToken, workspaceId: activeWorkspace }, activeWorkspace);
      } catch (pErr) {
        console.warn("[Asana Test Projects Warning]:", pErr.message);
      }
    }

    return res.json({
      success: true,
      message: `Connected successfully to Asana as ${profile.name} (${profile.email || "User"})!`,
      profile,
      projects
    });
  } catch (err) {
    return res.status(400).json({
      success: false,
      error: err.message || "Could not connect to Asana. Please check your Personal Access Token."
    });
  }
});

// Fetch Asana projects for workspace
app.get("/api/user/integrations/asana/projects", authenticateToken, async (req, res) => {
  try {
    const config = db.getUserIntegration(req.user.id, "asana");
    const workspaceId = req.query.workspaceId || config?.workspaceId;
    const projects = await getAsanaProjects(config, workspaceId);
    return res.json({ success: true, projects });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// Create new Asana project
app.post("/api/user/integrations/asana/projects", authenticateToken, async (req, res) => {
  try {
    const { name, notes, color, workspaceId } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: "Project name is required." });
    }
    const config = db.getUserIntegration(req.user.id, "asana");
    const project = await createAsanaProject(config, {
      name: name.trim(),
      notes: notes || "",
      color: color || "light-blue",
      workspaceGid: workspaceId || config?.workspaceId
    });
    return res.json({ success: true, message: `Project "${project.name}" created in Asana!`, project });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// Update Asana task (e.g. title, notes, due date, completed)
app.put("/api/user/integrations/asana/tasks/:taskGid", authenticateToken, async (req, res) => {
  try {
    const { taskGid } = req.params;
    const { name, notes, dueOn, completed } = req.body;
    const config = db.getUserIntegration(req.user.id, "asana");
    const updated = await updateAsanaTask(config, taskGid, { name, notes, dueOn, completed });
    return res.json({ success: true, message: `Task "${updated.name}" updated in Asana!`, task: updated });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// Fetch Asana tasks preview for dashboard
app.get("/api/user/integrations/asana/tasks", authenticateToken, async (req, res) => {
  try {
    const config = db.getUserIntegration(req.user.id, "asana");
    const result = await getAsanaTasks(config, { maxResults: 15 });
    return res.json({ success: true, tasks: result.tasks, total: result.total });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// Disconnect Asana
app.delete("/api/user/integrations/asana", authenticateToken, (req, res) => {
  try {
    db.deleteUserIntegration(req.user.id, "asana");
    return res.json({ success: true, message: "Asana integration disconnected." });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Failed to disconnect Asana" });
  }
});

// ---------------- EMAIL / GMAIL INTEGRATION ----------------

// Save Email Settings
app.post("/api/user/integrations/email", authenticateToken, async (req, res) => {
  try {
    const { email, appPassword, senderName } = req.body;
    if (!email || !email.trim() || !email.includes("@")) {
      return res.status(400).json({ success: false, error: "Valid Gmail address is required." });
    }

    const existing = db.getUserIntegration(req.user.id, "email") || {};
    let finalPass = appPassword;
    if (!finalPass || finalPass === "••••••••") {
      finalPass = existing.appPassword || process.env.GMAIL_APP_PASSWORD || "";
    }
    finalPass = cleanAppPassword(finalPass);

    if (!finalPass) {
      const configObj = {
        email: email.trim(),
        appPassword: "",
        senderName: (senderName || "").trim() || "Anamika"
      };
      db.saveUserIntegration(req.user.id, "email", configObj, 0);
      return res.json({
        success: true,
        warning: true,
        message: `Email address saved as ${email.trim()}! Please provide your 16-character Google App Password to connect.`,
        integration: {
          platform: "email",
          email: configObj.email,
          senderName: configObj.senderName,
          connected: false
        }
      });
    }

    // Attempt connection verification
    let verified = false;
    let warning = "";
    try {
      await verifyEmailConnection({ email: email.trim(), appPassword: finalPass, senderName });
      verified = true;
    } catch (verErr) {
      warning = verErr.message;
    }

    const configObj = {
      email: email.trim(),
      appPassword: finalPass,
      senderName: (senderName || "").trim() || "Anamika"
    };

    db.saveUserIntegration(req.user.id, "email", configObj, 1);

    if (!verified) {
      return res.json({
        success: true,
        warning: true,
        message: `Email updated to ${email.trim()}! Note: Verification returned: ${warning}`,
        integration: {
          platform: "email",
          email: configObj.email,
          senderName: configObj.senderName,
          connected: false
        }
      });
    }

    return res.json({
      success: true,
      message: `Gmail (${email.trim()}) connected successfully! You can now draft and send emails via WhatsApp.`,
      integration: {
        platform: "email",
        email: configObj.email,
        senderName: configObj.senderName,
        connected: true
      }
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// Test Email Connection
app.post("/api/user/integrations/email/test", authenticateToken, async (req, res) => {
  try {
    const { email, appPassword } = req.body;
    const existing = db.getUserIntegration(req.user.id, "email") || {};
    let targetEmail = (email || existing.email || process.env.GMAIL_USER || "").trim();
    let finalPass = appPassword;
    if (!finalPass || finalPass === "••••••••") {
      finalPass = existing.appPassword || process.env.GMAIL_APP_PASSWORD || "";
    }
    finalPass = cleanAppPassword(finalPass);

    if (!targetEmail || !finalPass) {
      return res.status(400).json({ success: false, error: "Gmail address and App Password are required to test." });
    }

    await verifyEmailConnection({ email: targetEmail, appPassword: finalPass });
    return res.json({ success: true, message: `Connected to Gmail as ${targetEmail}! Authentication verified.` });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// Send Test Email
app.post("/api/user/integrations/email/send-test", authenticateToken, async (req, res) => {
  try {
    const config = db.getUserIntegration(req.user.id, "email");
    const eff = getEffectiveEmailConfig(config);
    if (!eff.isConfigured) {
      return res.status(400).json({ success: false, error: "Email is not configured. Please save credentials first." });
    }

    const testSubject = "Test Email from Anam AI Bot";
    const testBody = `Hello!\n\nThis is a test email sent from your Anam AI WhatsApp Assistant.\nYour Gmail integration is working perfectly and ready to draft & send emails.\n\nBest regards,\nAnam AI`;

    const result = await sendEmail(config, {
      to: eff.email,
      subject: testSubject,
      body: testBody
    });

    return res.json({ success: true, message: `Test email sent successfully to ${eff.email}!`, result });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// Disconnect Email
app.delete("/api/user/integrations/email", authenticateToken, (req, res) => {
  try {
    db.deleteUserIntegration(req.user.id, "email");
    return res.json({ success: true, message: "Email integration disconnected." });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Failed to disconnect email" });
  }
});

// Get User Email Drafts
app.get("/api/user/integrations/email/drafts", authenticateToken, (req, res) => {
  try {
    const drafts = db.getUserEmailDrafts(req.user.id, "draft");
    return res.json({ success: true, drafts, total: drafts.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// Create Email Draft
app.post("/api/user/integrations/email/drafts", authenticateToken, (req, res) => {
  try {
    const { recipient, subject, body } = req.body;
    if (!recipient || !recipient.trim()) {
      return res.status(400).json({ success: false, error: "Recipient email is required." });
    }
    const draft = db.createEmailDraft(req.user.id, recipient, subject || "", body || "");
    return res.json({ success: true, message: "Draft created successfully!", draft });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// Update Email Draft
app.put("/api/user/integrations/email/drafts/:id", authenticateToken, (req, res) => {
  try {
    const draftId = parseInt(req.params.id, 10);
    const updated = db.updateEmailDraft(draftId, req.user.id, req.body);
    if (!updated) {
      return res.status(404).json({ success: false, error: "Draft not found." });
    }
    return res.json({ success: true, message: "Draft updated!", draft: updated });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// Delete Email Draft
app.delete("/api/user/integrations/email/drafts/:id", authenticateToken, (req, res) => {
  try {
    const draftId = parseInt(req.params.id, 10);
    db.deleteEmailDraft(draftId, req.user.id);
    return res.json({ success: true, message: "Draft deleted." });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// Send Email (Directly or from Draft)
app.post("/api/user/integrations/email/send", authenticateToken, async (req, res) => {
  try {
    const { draftId, to, subject, body, cc, bcc } = req.body;
    const config = db.getUserIntegration(req.user.id, "email");

    let finalTo = to;
    let finalSubject = subject;
    let finalBody = body;

    if (draftId) {
      const draft = db.getEmailDraftById(parseInt(draftId, 10), req.user.id);
      if (!draft) {
        return res.status(404).json({ success: false, error: `Draft #${draftId} not found.` });
      }
      finalTo = finalTo || draft.recipient;
      finalSubject = finalSubject || draft.subject;
      finalBody = finalBody || draft.body;
    }

    const result = await sendEmail(config, {
      to: finalTo,
      subject: finalSubject,
      body: finalBody,
      cc,
      bcc
    });

    if (draftId) {
      db.updateEmailDraft(parseInt(draftId, 10), req.user.id, { status: "sent" });
    }

    return res.json({ success: true, message: `Email sent to ${finalTo}!`, result });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

// ---------------- SYSTEM / BOT STATUS ----------------

app.get("/api/bot/status", (req, res) => {
  let botState = { connected: false, botPhone: null, updatedAt: null };

  if (fs.existsSync(BOT_STATE_FILE)) {
    try {
      botState = JSON.parse(fs.readFileSync(BOT_STATE_FILE, "utf-8"));
    } catch {}
  }

  const stats = db.getSystemStats();
  const configuredPhone = process.env.BOT_PHONE_NUMBER || botState.botPhone || "";

  return res.json({
    success: true,
    bot: {
      connected: Boolean(botState.connected),
      phone: configuredPhone,
      lastSeen: botState.updatedAt || null
    },
    stats
  });
});

// Catch-all route for Single Page Application
app.use((req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Anam AI SaaS Web Portal is running at http://localhost:${PORT}`);
});
