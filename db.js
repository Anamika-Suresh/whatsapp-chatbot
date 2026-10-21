import { DatabaseSync } from "node:sqlite";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, "saas_database.sqlite");

// Initialize Database connection
const db = new DatabaseSync(DB_PATH);

// Pragmas for performance and data integrity
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    auth_token TEXT UNIQUE NOT NULL,
    whatsapp_jid TEXT UNIQUE,
    phone_number TEXT,
    is_verified INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    last_active_at TEXT
  );

  CREATE TABLE IF NOT EXISTS todos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    target_timestamp INTEGER NOT NULL,
    media_path TEXT,
    media_type TEXT,
    message TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS user_integrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    config TEXT NOT NULL,
    is_enabled INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(user_id, platform),
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS email_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    recipient TEXT NOT NULL,
    subject TEXT,
    body TEXT,
    status TEXT DEFAULT 'draft',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
  CREATE INDEX IF NOT EXISTS idx_users_token ON users(auth_token);
  CREATE INDEX IF NOT EXISTS idx_users_whatsapp ON users(whatsapp_jid);
  CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id);
  CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id);
  CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(status, target_timestamp);
  CREATE INDEX IF NOT EXISTS idx_integrations_user ON user_integrations(user_id);
  CREATE INDEX IF NOT EXISTS idx_integrations_platform ON user_integrations(user_id, platform);
  CREATE INDEX IF NOT EXISTS idx_email_drafts_user ON email_drafts(user_id, status);
`);

/**
 * Generate a friendly alphanumeric token e.g. ANAM-8K2Q9M
 */
export function generateToken() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // Removed ambiguous characters like 0, O, 1, I
  let randomPart = "";
  for (let i = 0; i < 6; i++) {
    const idx = crypto.randomInt(0, chars.length);
    randomPart += chars[idx];
  }
  return `ANAM-${randomPart}`;
}

/**
 * Clean & normalize a token entered by the user
 */
export function normalizeToken(raw) {
  if (!raw) return "";
  let clean = raw.trim().toUpperCase();
  clean = clean.replace(/^(TOKEN[:\s-]*|LINK[:\s-]*)/i, "");
  if (!clean.startsWith("ANAM-") && clean.length === 6) {
    clean = `ANAM-${clean}`;
  }
  return clean;
}

// ---------------- USER OPERATIONS ----------------

export function createUser(name, email, passwordHash) {
  const now = new Date().toISOString();
  let token = generateToken();

  // Ensure unique token
  let attempts = 0;
  while (attempts < 10) {
    const existing = db.prepare("SELECT id FROM users WHERE auth_token = ?").get(token);
    if (!existing) break;
    token = generateToken();
    attempts++;
  }

  const stmt = db.prepare(`
    INSERT INTO users (name, email, password_hash, auth_token, is_verified, created_at, last_active_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `);

  const result = stmt.run(name.trim(), email.trim().toLowerCase(), passwordHash, token, now, now);
  return getUserById(result.lastInsertRowid);
}

export function getUserByEmail(email) {
  if (!email) return null;
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email.trim().toLowerCase()) || null;
}

export function getUserById(id) {
  if (!id) return null;
  return db.prepare("SELECT * FROM users WHERE id = ?").get(Number(id)) || null;
}

export function getUserByAuthToken(token) {
  if (!token) return null;
  const clean = normalizeToken(token);
  return db.prepare("SELECT * FROM users WHERE auth_token = ?").get(clean) || null;
}

export function getUserByWhatsAppJid(jid) {
  if (!jid) return null;
  // Normalize jid e.g. 919876543210@s.whatsapp.net
  const cleanJid = jid.trim();
  return db.prepare("SELECT * FROM users WHERE whatsapp_jid = ?").get(cleanJid) || null;
}

export function linkUserWhatsApp(userId, whatsappJid, phoneNumber = "") {
  const now = new Date().toISOString();
  // Clear any existing user holding this whatsappJid
  db.prepare("UPDATE users SET whatsapp_jid = NULL, is_verified = 0 WHERE whatsapp_jid = ? AND id != ?").run(whatsappJid, userId);

  const stmt = db.prepare(`
    UPDATE users 
    SET whatsapp_jid = ?, phone_number = ?, is_verified = 1, last_active_at = ?
    WHERE id = ?
  `);
  stmt.run(whatsappJid, phoneNumber || extractPhoneFromJid(whatsappJid), now, userId);
  return getUserById(userId);
}

export function verifyAndLinkUser(token, whatsappJid, phoneNumber = "") {
  const user = getUserByAuthToken(token);
  if (!user) {
    return { success: false, error: "Token not found" };
  }
  const updatedUser = linkUserWhatsApp(user.id, whatsappJid, phoneNumber);
  return { success: true, user: updatedUser };
}

export function unlinkUserWhatsApp(userId) {
  const stmt = db.prepare(`
    UPDATE users 
    SET whatsapp_jid = NULL, phone_number = NULL, is_verified = 0
    WHERE id = ?
  `);
  stmt.run(userId);
  return getUserById(userId);
}

export function regenerateAuthToken(userId) {
  let newToken = generateToken();
  let attempts = 0;
  while (attempts < 10) {
    const existing = db.prepare("SELECT id FROM users WHERE auth_token = ? AND id != ?").get(newToken, userId);
    if (!existing) break;
    newToken = generateToken();
    attempts++;
  }

  db.prepare("UPDATE users SET auth_token = ? WHERE id = ?").run(newToken, userId);
  return getUserById(userId);
}

export function updateLastActive(userId) {
  const now = new Date().toISOString();
  db.prepare("UPDATE users SET last_active_at = ? WHERE id = ?").run(now, userId);
}

// ---------------- TO-DO OPERATIONS ----------------

export function getUserTodos(userId) {
  return db.prepare(`
    SELECT * FROM todos 
    WHERE user_id = ? 
    ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, id ASC
  `).all(userId) || [];
}

export function addTodo(userId, name, description = "") {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO todos (user_id, name, description, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `);
  const res = stmt.run(userId, name.trim(), description.trim(), now);
  return db.prepare("SELECT * FROM todos WHERE id = ?").get(res.lastInsertRowid);
}

export function completeTodoById(userId, todoId) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    UPDATE todos 
    SET status = 'completed', completed_at = ?
    WHERE id = ? AND user_id = ?
  `);
  stmt.run(now, todoId, userId);
  return db.prepare("SELECT * FROM todos WHERE id = ?").get(todoId);
}

export function toggleTodo(userId, todoId) {
  const todo = db.prepare("SELECT * FROM todos WHERE id = ? AND user_id = ?").get(todoId, userId);
  if (!todo) return null;
  const newStatus = todo.status === "completed" ? "pending" : "completed";
  const now = newStatus === "completed" ? new Date().toISOString() : null;
  db.prepare("UPDATE todos SET status = ?, completed_at = ? WHERE id = ?").run(newStatus, now, todoId);
  return db.prepare("SELECT * FROM todos WHERE id = ?").get(todoId);
}

export function completeTodoByNumber(userId, number) {
  // Finds the N-th pending todo for this user (1-indexed)
  const pendingTodos = db.prepare(`
    SELECT * FROM todos 
    WHERE user_id = ? AND status = 'pending'
    ORDER BY id ASC
  `).all(userId);

  const idx = number - 1;
  if (idx < 0 || idx >= pendingTodos.length) return null;

  const target = pendingTodos[idx];
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE todos 
    SET status = 'completed', completed_at = ? 
    WHERE id = ?
  `).run(now, target.id);

  return target;
}

export function deleteTodo(userId, todoId) {
  const stmt = db.prepare("DELETE FROM todos WHERE id = ? AND user_id = ?");
  stmt.run(todoId, userId);
  return true;
}

// ---------------- REMINDER OPERATIONS ----------------

export function getUserReminders(userId) {
  return db.prepare(`
    SELECT * FROM reminders 
    WHERE user_id = ? 
    ORDER BY target_timestamp ASC
  `).all(userId) || [];
}

export function addReminder(userId, reminderData) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO reminders (user_id, name, description, target_timestamp, media_path, media_type, message, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  const res = stmt.run(
    userId,
    reminderData.name || "Reminder",
    reminderData.description || "",
    reminderData.targetTimestamp,
    reminderData.mediaPath || null,
    reminderData.mediaType || null,
    reminderData.message || null,
    now
  );
  return db.prepare("SELECT * FROM reminders WHERE id = ?").get(res.lastInsertRowid);
}

export function getPendingReminders() {
  return db.prepare(`
    SELECT r.*, u.whatsapp_jid, u.name as user_name 
    FROM reminders r
    JOIN users u ON r.user_id = u.id
    WHERE r.status = 'pending' AND u.whatsapp_jid IS NOT NULL
    ORDER BY r.target_timestamp ASC
  `).all() || [];
}

export function markReminderSent(reminderId) {
  db.prepare("UPDATE reminders SET status = 'sent' WHERE id = ?").run(reminderId);
}

export function updateReminderMessage(reminderId, message) {
  db.prepare("UPDATE reminders SET message = ? WHERE id = ?").run(message, reminderId);
}

export function updateReminderStatus(reminderId, status) {
  db.prepare("UPDATE reminders SET status = ? WHERE id = ?").run(status, reminderId);
  return getReminderById(reminderId);
}

export function deleteReminder(userId, reminderId) {
  db.prepare("DELETE FROM reminders WHERE id = ? AND user_id = ?").run(reminderId, userId);
  return true;
}

// ---------------- UTILS & STATS ----------------

export function extractPhoneFromJid(jid) {
  if (!jid) return "";
  const match = jid.match(/^(\d+)@/);
  return match ? `+${match[1]}` : "";
}

export function getSystemStats() {
  const totalUsers = db.prepare("SELECT COUNT(*) as count FROM users").get().count;
  const verifiedUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE is_verified = 1").get().count;
  const totalTodos = db.prepare("SELECT COUNT(*) as count FROM todos").get().count;
  const pendingReminders = db.prepare("SELECT COUNT(*) as count FROM reminders WHERE status = 'pending'").get().count;
  return { totalUsers, verifiedUsers, totalTodos, pendingReminders };
}

export function getReminderById(id) {
  if (!id) return null;
  return db.prepare("SELECT * FROM reminders WHERE id = ?").get(Number(id)) || null;
}

// ---------------- USER INTEGRATIONS ----------------

export function getUserIntegration(userId, platform) {
  const row = db.prepare(`
    SELECT * FROM user_integrations 
    WHERE user_id = ? AND platform = ?
  `).get(userId, platform);

  if (!row) return null;
  try {
    const config = JSON.parse(row.config);
    return {
      id: row.id,
      userId: row.user_id,
      platform: row.platform,
      isEnabled: Boolean(row.is_enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...config
    };
  } catch {
    return null;
  }
}

export function getAllUserIntegrations(userId) {
  const rows = db.prepare(`
    SELECT * FROM user_integrations 
    WHERE user_id = ?
  `).all(userId) || [];

  return rows.map(row => {
    let parsedConfig = {};
    try { parsedConfig = JSON.parse(row.config); } catch {}
    return {
      id: row.id,
      platform: row.platform,
      isEnabled: Boolean(row.is_enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      config: parsedConfig
    };
  });
}

export function saveUserIntegration(userId, platform, configObj, isEnabled = 1) {
  const now = new Date().toISOString();
  const configStr = JSON.stringify(configObj || {});

  const existing = db.prepare(`
    SELECT id FROM user_integrations 
    WHERE user_id = ? AND platform = ?
  `).get(userId, platform);

  if (existing) {
    db.prepare(`
      UPDATE user_integrations 
      SET config = ?, is_enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(configStr, isEnabled ? 1 : 0, now, existing.id);
  } else {
    db.prepare(`
      INSERT INTO user_integrations (user_id, platform, config, is_enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, platform, configStr, isEnabled ? 1 : 0, now, now);
  }

  return getUserIntegration(userId, platform);
}

export function deleteUserIntegration(userId, platform) {
  db.prepare(`
    DELETE FROM user_integrations 
    WHERE user_id = ? AND platform = ?
  `).run(userId, platform);
  return true;
}

// ---------------- EMAIL DRAFTS ----------------

export function createEmailDraft(userId, recipient, subject = "", body = "") {
  const now = new Date().toISOString();
  const res = db.prepare(`
    INSERT INTO email_drafts (user_id, recipient, subject, body, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'draft', ?, ?)
  `).run(userId, recipient.trim(), (subject || "").trim(), (body || "").trim(), now, now);
  return getEmailDraftById(res.lastInsertRowid, userId);
}

export function getUserEmailDrafts(userId, status = "draft") {
  return db.prepare(`
    SELECT * FROM email_drafts 
    WHERE user_id = ? AND status = ?
    ORDER BY id DESC
  `).all(userId, status) || [];
}

export function getEmailDraftById(id, userId) {
  return db.prepare(`
    SELECT * FROM email_drafts 
    WHERE id = ? AND user_id = ?
  `).get(id, userId) || null;
}

export function updateEmailDraft(id, userId, updates = {}) {
  const current = getEmailDraftById(id, userId);
  if (!current) return null;

  const now = new Date().toISOString();
  const recipient = updates.recipient !== undefined ? updates.recipient : current.recipient;
  const subject = updates.subject !== undefined ? updates.subject : current.subject;
  const body = updates.body !== undefined ? updates.body : current.body;
  const status = updates.status !== undefined ? updates.status : current.status;

  db.prepare(`
    UPDATE email_drafts
    SET recipient = ?, subject = ?, body = ?, status = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(recipient, subject, body, status, now, id, userId);

  return getEmailDraftById(id, userId);
}

export function deleteEmailDraft(id, userId) {
  db.prepare(`
    DELETE FROM email_drafts
    WHERE id = ? AND user_id = ?
  `).run(id, userId);
  return true;
}

export default {
  createUser,
  getUserByEmail,
  getUserById,
  getUserByAuthToken,
  getUserByWhatsAppJid,
  linkUserWhatsApp,
  verifyAndLinkUser,
  unlinkUserWhatsApp,
  regenerateAuthToken,
  updateLastActive,
  getUserTodos,
  addTodo,
  completeTodoById,
  completeTodoByNumber,
  toggleTodo,
  deleteTodo,
  getUserReminders,
  addReminder,
  getReminderById,
  getPendingReminders,
  markReminderSent,
  updateReminderStatus,
  updateReminderMessage,
  deleteReminder,
  getSystemStats,
  normalizeToken,
  generateToken,
  extractPhoneFromJid,
  getUserIntegration,
  getAllUserIntegrations,
  saveUserIntegration,
  deleteUserIntegration,
  createEmailDraft,
  getUserEmailDrafts,
  getEmailDraftById,
  updateEmailDraft,
  deleteEmailDraft
};

