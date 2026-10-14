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
app.post("/api/user/reminders", authenticateToken, (req, res) => {
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
    return res.status(201).json({ success: true, reminder });
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
