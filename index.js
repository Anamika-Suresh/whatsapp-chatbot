import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from "@whiskeysockets/baileys";
import { GoogleGenAI, Type } from "@google/genai";
import qrcode from "qrcode-terminal";
import pino from "pino";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { execSync } from "child_process";
import db from "./db.js";

dotenv.config();

// Single Instance Mutex: Ensure only ONE bot process runs at any time
const PID_FILE = path.join(process.cwd(), "bot.pid");
function acquireInstanceLock() {
    try {
        if (fs.existsSync(PID_FILE)) {
            const oldPid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
            if (!isNaN(oldPid) && oldPid !== process.pid) {
                try {
                    process.kill(oldPid, 0); // Check if process is alive
                    console.log(`[Instance Lock] Found previous bot instance running (PID ${oldPid}). Terminating it to prevent WhatsApp session conflicts...`);
                    try {
                        execSync(`taskkill /F /PID ${oldPid}`, { stdio: "ignore" });
                    } catch {
                        try { process.kill(oldPid, "SIGTERM"); } catch {}
                    }
                } catch {
                    // Stale PID file, process already dead
                }
            }
        }
        fs.writeFileSync(PID_FILE, String(process.pid), "utf-8");
    } catch (e) {
        console.warn("[Instance Lock] Notice:", e.message);
    }
}
acquireInstanceLock();

process.on("exit", () => {
    try {
        if (fs.existsSync(PID_FILE)) {
            const current = fs.readFileSync(PID_FILE, "utf-8").trim();
            if (current === String(process.pid)) {
                fs.unlinkSync(PID_FILE);
            }
        }
    } catch {}
});

// Anti-Crash Global Protections (Prevents network glitches / ECONNRESET from killing the bot)
process.on("unhandledRejection", (reason) => {
    console.warn("[Anti-Crash] Caught Unhandled Rejection (Prevented Crash):", reason?.message || reason);
});

process.on("uncaughtException", (err) => {
    console.error("[Anti-Crash] Caught Uncaught Exception (Prevented Crash):", err?.message || err);
    if (err?.code === "ECONNRESET" || err?.message === "terminated" || err?.cause?.code === "ECONNRESET") {
        console.warn("[Anti-Crash] Handled network socket ECONNRESET / terminated fetch safely.");
    }
});

// 1. AI Initialization
const geminiApiKey = process.env.GEMINI_API_KEY || "";
const geminiModel = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;
const deadModels = new Set();

// 2. Persistent Stores
const TODOS_FILE = "todos.json";
function loadTodos() {
    try {
        return fs.existsSync(TODOS_FILE) ? JSON.parse(fs.readFileSync(TODOS_FILE, "utf-8")) : {};
    } catch {
        return {};
    }
}
function saveTodos(data) {
    fs.writeFileSync(TODOS_FILE, JSON.stringify(data, null, 2));
}

const REMINDERS_FILE = "reminders.json";
function loadReminders() {
    try {
        return fs.existsSync(REMINDERS_FILE) ? JSON.parse(fs.readFileSync(REMINDERS_FILE, "utf-8")) : [];
    } catch {
        return [];
    }
}
function saveReminders(data) {
    fs.writeFileSync(REMINDERS_FILE, JSON.stringify(data, null, 2));
}

const MEDIA_DIR = "media";
if (!fs.existsSync(MEDIA_DIR)) {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

// 3. Sent Messages ID Tracker (Prevents self-chat infinite loops)
const sentMessageIds = new Set();
async function sendReply(sock, sender, content) {
    if (!sock || !sender) return null;
    try {
        const sent = await sock.sendMessage(sender, content);
        if (sent?.key?.id) {
            sentMessageIds.add(sent.key.id);
            setTimeout(() => sentMessageIds.delete(sent.key.id), 5 * 60 * 1000);
        }
        return sent;
    } catch (err) {
        console.error(`[Send Reply Error] Could not send message to ${sender}:`, err?.message || err);
        return null;
    }
}

// 4. Conversational Memory & Active Session Tracker
const userSessions = new Map();
const SESSION_TIMEOUT_MS = 15 * 60 * 1000;

function getSession(sender) {
    if (!userSessions.has(sender)) {
        userSessions.set(sender, { isActive: false, lastActive: Date.now(), summary: "", history: [] });
    }
    const session = userSessions.get(sender);
    
    if (session.isActive && Date.now() - session.lastActive > SESSION_TIMEOUT_MS) {
        session.isActive = false;
    }
    session.lastActive = Date.now();
    return session;
}

function clearSession(sender) {
    userSessions.set(sender, { isActive: false, lastActive: Date.now(), summary: "", history: [] });
}

async function condenseSessionMemory(sender) {
    const session = getSession(sender);
    if (session.history.length <= 8 || !ai) return;

    const oldMessages = session.history.slice(0, session.history.length - 4);
    session.history = session.history.slice(session.history.length - 4);

    try {
        const prompt = `Summarize key facts, preferences, and context from this conversation in 2-3 sentences. Incorporate previous summary if relevant.\nPrevious Summary: "${session.summary}"\n\nNew Conversation:\n${JSON.stringify(oldMessages)}`;
        const res = await generateAIContent([{ role: "user", parts: [{ text: prompt }] }], undefined);
        session.summary = res.text?.trim() || session.summary;
        console.log(`[Memory] Updated summary for ${sender}: ${session.summary}`);
    } catch (err) {
        console.error("[Memory] Error condensing memory:", err.message);
    }
}

// 5. Pending Media & Tomorrow Sessions
const pendingMediaSessions = new Map();
const pendingTomorrowSessions = new Map();

function setPendingMediaSession(sender, sessionData, sock) {
    if (pendingMediaSessions.has(sender)) {
        const prev = pendingMediaSessions.get(sender);
        if (prev.timer) clearTimeout(prev.timer);
        if (prev.mediaPath && fs.existsSync(prev.mediaPath)) {
            try { fs.unlinkSync(prev.mediaPath); } catch {}
        }
    }

    const timer = setTimeout(async () => {
        if (pendingMediaSessions.has(sender)) {
            const current = pendingMediaSessions.get(sender);
            if (current.mediaPath && fs.existsSync(current.mediaPath)) {
                try { fs.unlinkSync(current.mediaPath); } catch {}
            }
            pendingMediaSessions.delete(sender);
            await sendReply(sock, sender, { text: "Your file was not saved. Please send it again." });
        }
    }, 10 * 60 * 1000);

    pendingMediaSessions.set(sender, {
        ...sessionData,
        timer
    });
}

// 6. Tools Definition for Gemini (To-Do List, Memory)
const botTools = [
    {
        functionDeclarations: [
            {
                name: "add_todo",
                description: "Add a task to the user's checklist WITHOUT a time trigger. DO NOT use for timed reminders.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        name: { type: Type.STRING, description: "Task name" },
                        description: { type: Type.STRING, description: "Task description" }
                    },
                    required: ["name"]
                }
            },
            {
                name: "get_todos",
                description: "Retrieve all active to-do items from the user's checklist.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {}
                }
            },
            {
                name: "complete_todo",
                description: "Mark a to-do item as completed by its 1-based number index.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        task_number: { type: Type.NUMBER, description: "1-based task index" }
                    },
                    required: ["task_number"]
                }
            },
            {
                name: "clear_memory",
                description: "Clear all conversation memory.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {}
                }
            }
        ]
    }
];

// 7. Time Formatting & Free-Form Reminder Engine (IST Timezone, Persistent, Human Wording)
function formatTimeString(targetTimestamp) {
    const now = new Date();
    const target = new Date(targetTimestamp);
    const delayMs = targetTimestamp - now.getTime();

    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const targetStart = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
    const dayDiff = Math.round((targetStart - todayStart) / (24 * 60 * 60 * 1000));

    const formattedClockTime = target.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
    });

    if (dayDiff >= 1) {
        return `tomorrow at ${formattedClockTime}`;
    }

    if (delayMs < 60 * 1000) {
        return "in a few seconds";
    } else if (delayMs < 120 * 1000) {
        return "in a minute";
    } else if (delayMs < 60 * 60 * 1000) {
        const mins = Math.round(delayMs / (60 * 1000));
        return `in ${mins} mins`;
    } else {
        return `at ${formattedClockTime}`;
    }
}

function parseClockTime(timeStr) {
    if (!timeStr) return null;
    const clean = timeStr.trim().toLowerCase();
    const match = clean.match(/^([0-2]?[0-9])(?::([0-5][0-9]))?\s*(am|pm)?$/i);
    if (!match) return null;

    let hours = parseInt(match[1], 10);
    let minutes = match[2] ? parseInt(match[2], 10) : 0;
    const ampm = match[3] ? match[3].toLowerCase() : null;

    if (ampm === "pm" && hours < 12) {
        hours += 12;
    } else if (ampm === "am" && hours === 12) {
        hours = 0;
    } else if (!ampm && hours < 12 && hours > 0) {
        const now = new Date();
        const nowHours = now.getHours();
        if (nowHours >= 12 && hours + 12 > nowHours) {
            hours += 12;
        }
    }

    if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
    return { hours, minutes };
}

function cleanPunctuation(str) {
    if (!str) return "";
    let res = str.trim();
    if (res.endsWith(".")) res = res.slice(0, -1).trim();
    res = res.replace(/^[:;\-,\s]+/, "").replace(/[:;\-,\s]+$/, "").trim();
    if (res.endsWith(".")) res = res.slice(0, -1).trim();
    return res;
}

function extractTaskNameAndDesc(rawStr) {
    let clean = cleanPunctuation(rawStr);
    if (!clean) return null;

    // Check if there is description separated by " - ", ":", "with description", "desc:"
    const descMatch = clean.match(/^(.*?)\s*(?:[-:]|\bdesc(?:ription)?[:\-]?)\s*(.+)$/i);
    if (descMatch && descMatch[1].trim() && descMatch[2].trim()) {
        return {
            name: cleanPunctuation(descMatch[1]),
            description: cleanPunctuation(descMatch[2])
        };
    }
    return { name: clean, description: "" };
}

function parseTaskCommand(text) {
    if (!text) return null;
    let raw = text.trim();

    // Do not confuse with timed reminders or queries
    const hasTimeKeyword = /\b(?:at\s+\d|in\s+\d+\s*(?:sec|min|hour)|tomorrow\s+at)\b/i.test(raw);
    if (hasTimeKeyword && /\b(?:remind|reminder)\b/i.test(raw)) {
        return null;
    }
    if (/^\s*(?:show|what|list|view|display|get)\b/i.test(raw)) {
        return null;
    }

    // 1. "add <something> to [my/the] list/todo/checklist"
    const addToListMatch = raw.match(/^\s*(?:hey\s+anam[,:\s]*)?add\s+(.+?)\s+to\s+(?:my\s+|the\s+)?(?:list|tasks?|to-?dos?|checklist)\s*$/i);
    if (addToListMatch) {
        return extractTaskNameAndDesc(addToListMatch[1]);
    }

    // 2. "add to [my/the] list/todo/checklist: <something>"
    const addToListPrefixMatch = raw.match(/^\s*(?:hey\s+anam[,:\s]*)?add\s+to\s+(?:my\s+|the\s+)?(?:list|tasks?|to-?dos?|checklist)\s*[:\-]?\s*(.+)$/i);
    if (addToListPrefixMatch) {
        return extractTaskNameAndDesc(addToListPrefixMatch[1]);
    }

    // 3. "add task/todo/to-do: <something>" or "add task/todo <something>"
    const addTaskMatch = raw.match(/^\s*(?:hey\s+anam[,:\s]*)?add\s+(?:task|to-?do|item)\s*[:\-]?\s*(.+)$/i);
    if (addTaskMatch) {
        return extractTaskNameAndDesc(addTaskMatch[1]);
    }

    // 4. "task: <something>", "task <something>", "new task: <something>", "new task <something>", "checklist: <something>"
    const prefixMatch = raw.match(/^\s*(?:hey\s+anam[,:\s]*)?(?:new\s+task|task|to-?do|checklist)\s*[:\-]?\s+(.+)$/i);
    if (prefixMatch) {
        return extractTaskNameAndDesc(prefixMatch[1]);
    }

    // 5. "add <something>" (general, e.g. "add buy groceries", "add finish report")
    const generalAddMatch = raw.match(/^\s*(?:hey\s+anam[,:\s]*)?add\s+(?!me\b|a\s+reminder\b|reminder\b)(.+)$/i);
    if (generalAddMatch) {
        return extractTaskNameAndDesc(generalAddMatch[1]);
    }

    return null;
}

function parseFreeFormReminder(text) {
    if (!text) return null;
    let raw = text.trim();

    const isReminderKeyword = /\b(remind|reminder)\b/i.test(raw);
    const hasRelativeTime = /\bin\s+\d+\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i.test(raw);
    const hasTomorrow = /\btomorrow\b/i.test(raw);
    const hasClockTime = /\b([0-2]?[0-9](?::[0-5][0-9])?\s*(?:am|pm)?)\b/i.test(raw);

    if (!isReminderKeyword && !hasRelativeTime && !hasTomorrow && !hasClockTime) {
        return null;
    }

    let workText = raw.replace(/^\s*(?:set\s+a\s+reminder|set\s+reminder|remind\s+me\s+at|remind\s+me|reminder)\s*[:\-]?\s*/i, "").trim();

    let targetTimestamp = null;
    let isTomorrow = false;

    // 1. Relative Delay: "in 10 minutes", "in 2 hours"
    const relMatch = workText.match(/\bin\s+(\d+)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i);
    if (relMatch) {
        const num = parseInt(relMatch[1], 10);
        const unit = relMatch[2].toLowerCase();
        let ms = num * 60 * 1000;
        if (unit.startsWith("sec")) ms = num * 1000;
        else if (unit.startsWith("hour") || unit.startsWith("hr")) ms = num * 3600 * 1000;

        targetTimestamp = Date.now() + ms;
        workText = workText.replace(relMatch[0], "").trim();
    }

    // 2. Tomorrow + Clock Time: "tomorrow 7am", "tomorrow at 8:30pm"
    if (!targetTimestamp) {
        const tomMatch = workText.match(/\btomorrow(?:\s+at)?\s+([0-2]?[0-9](?::[0-5][0-9])?\s*(?:am|pm)?)\b/i);
        if (tomMatch) {
            const parsed = parseClockTime(tomMatch[1]);
            if (parsed) {
                const target = new Date();
                target.setDate(target.getDate() + 1);
                target.setHours(parsed.hours, parsed.minutes, 0, 0);
                targetTimestamp = target.getTime();
                isTomorrow = true;
                workText = workText.replace(tomMatch[0], "").trim();
            }
        }
    }

    // 3. Clock Time: "8:35", "at 8:35", "8pm", "20:00", "9:19 pm"
    if (!targetTimestamp) {
        const clockMatch = workText.match(/(?:\bat\s+)?([0-2]?[0-9](?::[0-5][0-9])?\s*(?:am|pm)?)\b/i);
        if (clockMatch) {
            const parsed = parseClockTime(clockMatch[1]);
            if (parsed) {
                const now = new Date();
                const target = new Date();
                target.setHours(parsed.hours, parsed.minutes, 0, 0);
                const diffMs = now.getTime() - target.getTime();

                if (diffMs > 0) {
                    if (diffMs < 60000) {
                        // Current minute or passed less than 60 seconds ago: send in 5 seconds
                        targetTimestamp = now.getTime() + 5000;
                        isTomorrow = false;
                    } else {
                        // Passed more than 60 seconds ago: move to tomorrow
                        target.setDate(target.getDate() + 1);
                        targetTimestamp = target.getTime();
                        isTomorrow = true;
                    }
                } else {
                    targetTimestamp = target.getTime();
                    isTomorrow = false;
                }
                workText = workText.replace(clockMatch[0], "").trim();
            }
        }
    }

    // Clean leading punctuation and keywords
    workText = workText.replace(/^[:;\-,\s]+/, "").trim();
    workText = workText.replace(/^\s*(?:to|that)\s+/i, "").trim();

    // Check for Tomorrow without clock time (Bug 3 Fix)
    if (!targetTimestamp) {
        if (hasTomorrow) {
            workText = workText.replace(/\btomorrow\b/i, "").trim();
            workText = cleanPunctuation(workText);
            return { missingTomorrowTime: true, name: workText, description: "" };
        }
        if (isReminderKeyword) {
            return { missingTime: true };
        }
        return null;
    }

    if (!workText) {
        return { targetTimestamp, isTomorrow, name: "", description: "" };
    }

    // Bug 1 Fix: Explicit Label Parsing (supports 'is', ':', '-', or whitespace)
    let name = workText;
    let description = "";

    const nameLabelRegex = /\b(?:reminder name|name|task)\b\s*(?:is|:|-)?\s*/i;
    const descLabelRegex = /\b(?:reminder message|message|description)\b\s*(?:is|:|-)?\s*/i;

    const nameMatch = workText.match(nameLabelRegex);
    const descMatch = workText.match(descLabelRegex);

    if (nameMatch || descMatch) {
        const nameIdx = nameMatch ? nameMatch.index : -1;
        const nameLen = nameMatch ? nameMatch[0].length : 0;
        const descIdx = descMatch ? descMatch.index : -1;
        const descLen = descMatch ? descMatch[0].length : 0;

        if (nameMatch && descMatch) {
            if (nameIdx < descIdx) {
                name = workText.substring(nameIdx + nameLen, descIdx);
                description = workText.substring(descIdx + descLen);
            } else {
                description = workText.substring(descIdx + descLen, nameIdx);
                name = workText.substring(nameIdx + nameLen);
            }
        } else if (nameMatch) {
            name = workText.substring(nameIdx + nameLen);
            description = "";
        } else if (descMatch) {
            name = workText.substring(0, descIdx);
            description = workText.substring(descIdx + descLen);
        }
    } else {
        // Fallback to existing split rules
        const descSep = workText.match(/^(.*?)\.?[ \t]*\bdescription:?[ \t]*(.*)$/i);
        const semiSep = workText.match(/^(.*?)\s*;\s*(.*)$/);
        const colonSep = workText.match(/^(.*?)\s*:\s*(.*)$/);
        const dashSep = workText.match(/^(.*?)\s+-\s+(.*)$/);
        const commaSep = workText.match(/^(.*?)\s*,\s*(.*)$/);

        if (descSep && descSep[1] && descSep[2]) {
            name = descSep[1]; description = descSep[2];
        } else if (semiSep && semiSep[1] && semiSep[2]) {
            name = semiSep[1]; description = semiSep[2];
        } else if (colonSep && colonSep[1] && colonSep[2]) {
            name = colonSep[1]; description = colonSep[2];
        } else if (dashSep && dashSep[1] && dashSep[2]) {
            name = dashSep[1]; description = dashSep[2];
        } else if (commaSep && commaSep[1] && commaSep[2]) {
            name = commaSep[1]; description = commaSep[2];
        }
    }

    name = cleanPunctuation(name);
    description = cleanPunctuation(description);

    if (!name) {
        name = cleanPunctuation(workText);
        description = "";
    }

    if (name.toLowerCase() === description.toLowerCase()) {
        description = "";
    }

    return {
        targetTimestamp,
        isTomorrow,
        name,
        description
    };
}

const activeTimers = new Map();

function scheduleReminderTimer(sock, rem) {
    if (activeTimers.has(rem.id)) {
        clearTimeout(activeTimers.get(rem.id));
    }

    const now = Date.now();
    const delayMs = rem.targetTimestamp - now;

    if (delayMs <= 0) {
        // Skip reminders that expired more than 15 minutes ago to avoid spamming on restart
        if (now - rem.targetTimestamp > 15 * 60 * 1000) {
            console.log(`[Reminders] Skipping expired reminder: "${rem.name}" (due ${Math.round((now - rem.targetTimestamp) / 60000)}m ago)`);
            if (rem.id && !isNaN(Number(rem.id))) {
                try { db.markReminderSent(Number(rem.id)); } catch (e) {}
            }
            return;
        }
        triggerReminder(sock, rem);
        return;
    }

    const timer = setTimeout(() => {
        triggerReminder(sock, rem);
    }, delayMs);

    activeTimers.set(rem.id, timer);
}

async function triggerReminder(sock, rem) {
    if (rem.id && !isNaN(Number(rem.id))) {
        try {
            const existing = db.getReminderById(Number(rem.id));
            if (!existing) {
                console.log(`[Reminders] Reminder #${rem.id} was deleted from database. Skipping trigger.`);
                activeTimers.delete(rem.id);
                return;
            }
            if (existing.status !== "pending") {
                console.log(`[Reminders] Reminder #${rem.id} is already marked '${existing.status}'. Skipping duplicate trigger.`);
                activeTimers.delete(rem.id);
                return;
            }
            db.markReminderSent(Number(rem.id));
            try {
                fs.writeFileSync(path.join(process.cwd(), ".reminders_sync"), String(Date.now()));
            } catch (e) {}
        } catch (e) {
            console.error("[Trigger DB Error]:", e.message);
        }
    }
    const reminders = loadReminders();
    const item = reminders.find(r => r.id === rem.id);
    if (item) {
        item.status = "sent";
        saveReminders(reminders);
    }
    activeTimers.delete(rem.id);

    let fallbackText = "";
    const isGenericName = !rem.name || rem.name === "your file" || rem.name === "your task";
    if (!isGenericName) {
        fallbackText = rem.description ? `Just a reminder: ${rem.name}. ${rem.description}` : `Just a reminder: ${rem.name}`;
    } else if (rem.description) {
        fallbackText = `Just a reminder: ${rem.description}`;
    } else {
        fallbackText = "Just a reminder!";
    }

    let textToSend = (item && item.message && item.message.trim()) ? item.message.trim() : (rem.message || fallbackText);

    if (rem.mediaPath) {
        if (!fs.existsSync(rem.mediaPath)) {
            await sendReply(sock, rem.sender, { text: "Your reminder is due but the file could not be sent." });
            return;
        }

        let mediaCaption = textToSend;
        if (isGenericName && !rem.description && !item?.message) {
            mediaCaption = undefined;
        }

        try {
            const mediaContent = rem.mediaType === "video" 
                ? { video: { url: rem.mediaPath }, caption: mediaCaption || undefined }
                : { image: { url: rem.mediaPath }, caption: mediaCaption || undefined };

            await sendReply(sock, rem.sender, mediaContent);
            console.log(`[Media Reminder Delivered] To: ${rem.sender} | File: ${rem.mediaPath}`);

            try { fs.unlinkSync(rem.mediaPath); } catch {}
        } catch (err) {
            console.error(`[Media Reminder Error] Failed to send media to ${rem.sender}:`, err.message);
            await sendReply(sock, rem.sender, { text: "Your reminder is due but the file could not be sent." });
        }
    } else {
        try {
            await sendReply(sock, rem.sender, { text: textToSend });
            console.log(`[Text Reminder Delivered] To: ${rem.sender} | Content: "${textToSend}"`);
        } catch (err) {
            console.error(`[Reminder Error] Could not send to ${rem.sender}:`, err.message);
        }
    }
}

function syncDatabaseReminders(sock) {
    if (!sock) return;
    try {
        const dbPending = db.getPendingReminders();
        const pendingIds = new Set(dbPending.map(r => String(r.id)));

        // 1. Cancel active timers for DB reminders that were deleted or cancelled
        for (const [timerId, timer] of activeTimers.entries()) {
            if (!isNaN(Number(timerId)) && !pendingIds.has(timerId)) {
                clearTimeout(timer);
                activeTimers.delete(timerId);
                console.log(`[Reminders Sync] Cancelled timer for removed reminder #${timerId}`);
            }
        }

        // 2. Schedule any newly added pending reminders from SQLite
        for (const rem of dbPending) {
            const remIdStr = String(rem.id);
            if (!activeTimers.has(remIdStr)) {
                console.log(`[Reminders Sync] Scheduling new reminder #${rem.id}: "${rem.name}" for ${rem.whatsapp_jid}`);
                scheduleReminderTimer(sock, {
                    id: remIdStr,
                    sender: rem.whatsapp_jid,
                    userId: rem.user_id,
                    targetTimestamp: rem.target_timestamp,
                    name: rem.name,
                    description: rem.description,
                    message: rem.message,
                    mediaPath: rem.media_path,
                    mediaType: rem.media_type,
                    status: rem.status
                });

                if (!rem.message) {
                    generateReminderMessage(remIdStr, rem.name, rem.description || "").catch(() => {});
                }
            }
        }
    } catch (e) {
        console.error("[Reminders Sync Error]:", e.message);
    }
}

function restorePendingReminders(sock) {
    // 1. Restore from SQLite
    try {
        const dbPending = db.getPendingReminders();
        console.log(`[Reminders] Restoring ${dbPending.length} pending reminder(s) from SQLite database...`);
        for (const rem of dbPending) {
            scheduleReminderTimer(sock, {
                id: String(rem.id),
                sender: rem.whatsapp_jid,
                userId: rem.user_id,
                targetTimestamp: rem.target_timestamp,
                name: rem.name,
                description: rem.description,
                message: rem.message,
                mediaPath: rem.media_path,
                mediaType: rem.media_type,
                status: rem.status
            });
        }
    } catch (e) {
        console.error("[DB Restore Error]:", e.message);
    }

    // 2. Also restore any legacy file reminders that aren't already scheduled
    const reminders = loadReminders();
    const pending = reminders.filter(r => r.status === "pending" && !activeTimers.has(r.id));
    for (const rem of pending) {
        scheduleReminderTimer(sock, rem);
    }
}

async function generateReminderMessage(reminderId, name, description) {
    const isGenericName = !name || name === "your file" || name === "your task";
    let fallbackText = "";
    if (!isGenericName) {
        fallbackText = description ? `Just a reminder: ${name}. ${description}` : `Just a reminder: ${name}`;
    } else if (description) {
        fallbackText = `Just a reminder: ${description}`;
    } else {
        fallbackText = "Just a reminder!";
    }

    if (!ai) {
        updateReminderMessage(reminderId, fallbackText);
        return;
    }

    const prompt = `Write the one WhatsApp message a friendly person would send to remind the user of this task at the time it is due. You are talking to the user, so change 'my' to 'your'. Keep the same meaning. Use only the facts given. Do not add times, places, or new tasks. Maximum 25 words, one or two short sentences, simple casual words. No labels like 'Name' or 'Reminder'. No emojis, no asterisks, no quotes, no markdown. Do not start every message the same way. Reply with the message text only.

Examples:
- name "read books", description "write review about it" -> "Time to read books. Don't forget to write a review about it."
- name "call my sister", no description -> "Don't forget to call your sister."
- name "Extract the website data", description "Analyse the given website and give extracted details" -> "Time to extract the website data. Go through the website and give the extracted details."

name "${name}"${description ? `, description "${description}"` : ""}`;

    try {
        let timer = null;
        const timeoutPromise = new Promise((resolve) => {
            timer = setTimeout(() => resolve(null), 6000);
        });

        // Safely attach .catch to prevent background stream abort crashes
        const apiPromise = generateAIContent([{ role: "user", parts: [{ text: prompt }] }], undefined)
            .catch(err => {
                console.warn("[Reminder Message Gen] API Error (swallowed safely):", err?.message || err);
                return null;
            });

        const res = await Promise.race([apiPromise, timeoutPromise]);
        if (timer) clearTimeout(timer);

        if (!res || !res.text) {
            updateReminderMessage(reminderId, fallbackText);
            return;
        }

        let text = res.text.trim();

        text = text.replace(/^["']|["']$/g, "").replace(/[*_~`]/g, "").trim();

        const words = text.split(/\s+/).filter(Boolean);
        const lower = text.toLowerCase();

        if (
            !text ||
            words.length > 40 ||
            lower.includes("name:") ||
            lower.includes("description:") ||
            lower.includes("reminder name")
        ) {
            updateReminderMessage(reminderId, fallbackText);
        } else {
            updateReminderMessage(reminderId, text);
        }
    } catch (err) {
        console.error(`[Reminder Message Gen Error] ${err.message}`);
        updateReminderMessage(reminderId, fallbackText);
    }
}

function updateReminderMessage(reminderId, messageText) {
    if (reminderId && !isNaN(Number(reminderId))) {
        try { db.updateReminderMessage(Number(reminderId), messageText); } catch (e) {}
    }
    const reminders = loadReminders();
    const item = reminders.find(r => r.id === reminderId);
    if (item) {
        item.message = messageText;
        saveReminders(reminders);
    }
}

function createAndSaveReminder(sock, sender, parsedCmd, dbUserId = null) {
    const { targetTimestamp, isTomorrow, name, description, mediaPath, mediaType } = parsedCmd;

    const displayName = (name && name !== "task" && name !== "your file" && name !== "your task") 
        ? name 
        : (mediaPath ? "your file" : "your task");
    const when = formatTimeString(targetTimestamp);

    const templates = [
        `Got it. I'll remind you ${when}: ${displayName}`,
        `Okay, noted. I'll ping you ${when}: ${displayName}`,
        `Sure thing. I'll nudge you ${when}: ${displayName}`,
        `Done. You'll hear from me ${when}: ${displayName}`
    ];

    const confirmMsg = templates[Math.floor(Math.random() * templates.length)];

    let reminderId = "rem_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);

    if (dbUserId) {
        try {
            const dbRem = db.addReminder(dbUserId, {
                name: displayName,
                description: description || "",
                targetTimestamp,
                mediaPath: mediaPath || null,
                mediaType: mediaType || null
            });
            if (dbRem && dbRem.id) {
                reminderId = String(dbRem.id);
                try {
                    fs.writeFileSync(path.join(process.cwd(), ".reminders_sync"), String(Date.now()));
                } catch (e) {}
            }
        } catch (e) {
            console.error("[DB Reminder Save Error]:", e.message);
        }
    }

    const reminders = loadReminders();
    const newRem = {
        id: reminderId,
        sender,
        userId: dbUserId,
        targetTimestamp,
        name: displayName,
        description: description || "",
        message: null,
        mediaPath: mediaPath || null,
        mediaType: mediaType || null,
        status: "pending"
    };

    reminders.push(newRem);
    saveReminders(reminders);

    scheduleReminderTimer(sock, newRem);

    // Background Gemini message generation
    generateReminderMessage(reminderId, displayName, description || "").catch(err => {
        console.error("[Reminder Message BG Error]:", err.message);
    });

    return confirmMsg;
}

// 8. Robust AI Model Invocation with Fast Automatic Failover & Retry for Capacity/503 Errors
async function generateAIContent(contents, systemInstruction) {
    const envFallbackStr = process.env.GEMINI_FALLBACK_MODELS || "";
    const envFallbacks = envFallbackStr
        ? envFallbackStr.split(",").map(m => m.trim()).filter(Boolean)
        : ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.7-flash"];

    const fallbackModels = [
        geminiModel,
        ...envFallbacks
    ].filter((v, i, a) => v && a.indexOf(v) === i);

    let lastError = null;
    for (const model of fallbackModels) {
        if (deadModels.has(model)) {
            console.log(`[AI] Skipping dead model ${model}`);
            continue;
        }

        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const configObj = systemInstruction ? { systemInstruction, tools: botTools } : undefined;
                const res = await ai.models.generateContent({
                    model,
                    contents,
                    config: configObj
                });
                return res;
            } catch (err) {
                lastError = err;
                const errStr = (err.message || "").toLowerCase();
                const status = err.status || (err.error && err.error.code);

                const is404 = status === 404 || errStr.includes("404") || errStr.includes("not_found") || errStr.includes("not found") || errStr.includes("no longer available");
                const isBusy = status === 503 || status === 429 || errStr.includes("503") || errStr.includes("429") || errStr.includes("unavailable") || errStr.includes("high demand") || errStr.includes("resource_exhausted");

                if (is404) {
                    console.error(`[AI] Model ${model} returned 404 (not found). Marking as dead until restart.`);
                    deadModels.add(model);
                    break;
                }

                if (isBusy && attempt < 2) {
                    console.error(`[AI] Model ${model} returned ${status || 503} (attempt 1/2). Retrying in 500ms...`);
                    await new Promise(r => setTimeout(r, 500));
                    continue;
                }

                console.error(`[AI] Model ${model} failed (attempt ${attempt}): ${err.message}. Failing over to next model...`);
                break;
            }
        }
    }
    throw lastError;
}

// 9. Main Bot Engine with Single Active Socket & Debounced Reconnection
let currentSock = null;
let reconnectTimer = null;
let isStartingBot = false;

async function startBot() {
    if (isStartingBot) return;
    isStartingBot = true;

    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    // Clean up previous socket to prevent competing connections
    if (currentSock) {
        try {
            currentSock.ev.removeAllListeners();
            currentSock.ws?.close();
        } catch (e) {}
        currentSock = null;
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState("auth_info");

        const sock = makeWASocket({
            logger: pino({ level: "silent" }),
            auth: state,
            printQRInTerminal: false,
            syncFullHistory: false, // Prevents giant chat history sync timeouts (408)
            browser: ["Anam AI", "Chrome", "1.0.0"],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            keepAliveIntervalMs: 30000
        });

        currentSock = sock;
        isStartingBot = false;

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                console.log("Scan this QR code with WhatsApp (Linked Devices):");
                qrcode.generate(qr, { small: true });
            }

            if (connection === "close") {
                if (globalThis._syncInterval) {
                    clearInterval(globalThis._syncInterval);
                    globalThis._syncInterval = null;
                }
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                const isReplaced = statusCode === DisconnectReason.connectionReplaced; // 440
                const shouldReconnect = !isLoggedOut && !isReplaced;

                console.log(`Connection closed (status: ${statusCode || 'unknown'}). Reconnecting: ${shouldReconnect}`);

                try {
                    fs.writeFileSync("bot_state.json", JSON.stringify({
                        connected: false,
                        botPhone: null,
                        updatedAt: new Date().toISOString()
                    }, null, 2));
                } catch (e) {}

                if (isReplaced) {
                    console.warn("⚠️ [WhatsApp Conflict] Connection was replaced by another active session (status 440).");
                    console.warn("⚠️ If another terminal or WhatsApp Web tab is open, close it to allow this bot to connect.");
                    // Do not reconnect immediately to prevent fighting the other session
                    return;
                }

                if (isLoggedOut) {
                    console.log("⚠️ Session logged out or invalidated. Cleaning auth_info and restarting for QR scan...");
                    try {
                        fs.rmSync("auth_info", { recursive: true, force: true });
                    } catch (e) {}
                    if (!reconnectTimer) {
                        reconnectTimer = setTimeout(() => {
                            reconnectTimer = null;
                            startBot();
                        }, 2000);
                    }
                    return;
                }

                if (shouldReconnect) {
                    // For status 515 (restartRequired), reconnect quickly (1000ms), otherwise 3000ms
                    const delay = statusCode === DisconnectReason.restartRequired ? 1000 : 3000;
                    if (!reconnectTimer) {
                        reconnectTimer = setTimeout(() => {
                            reconnectTimer = null;
                            startBot();
                        }, delay);
                    }
                }
            } else if (connection === "open") {
                const botPhone = sock.user?.id ? sock.user.id.split(":")[0] : null;
                console.log(`✅ Anam Bot is connected! WhatsApp Number: ${botPhone || 'Active'}. Say 'Hey Anam' to start a session.`);

                try {
                    fs.writeFileSync("bot_state.json", JSON.stringify({
                        connected: true,
                        botPhone: botPhone,
                        updatedAt: new Date().toISOString()
                    }, null, 2));
                } catch (e) {}

                restorePendingReminders(sock);

                // Bi-directional Web <-> WhatsApp Real-Time Sync Loop
                if (globalThis._syncInterval) clearInterval(globalThis._syncInterval);
                globalThis._syncInterval = setInterval(() => {
                    syncDatabaseReminders(currentSock);
                }, 2000);

                // Watch for instantaneous triggers from web server
                const SYNC_TRIGGER_FILE = path.join(process.cwd(), ".reminders_sync");
                try {
                    if (!fs.existsSync(SYNC_TRIGGER_FILE)) {
                        fs.writeFileSync(SYNC_TRIGGER_FILE, String(Date.now()));
                    }
                    if (!globalThis._syncFileWatcher) {
                        globalThis._syncFileWatcher = fs.watch(SYNC_TRIGGER_FILE, () => {
                            if (currentSock) syncDatabaseReminders(currentSock);
                        });
                    }
                } catch (e) {}
            }
        });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg || !msg.message) return;

        if (sentMessageIds.has(msg.key.id)) {
            sentMessageIds.delete(msg.key.id);
            return;
        }

        const sender = msg.key.remoteJid;
        // 1. Filter out broadcasts, newsletters, and status updates
        if (!sender || sender === "status@broadcast" || sender.endsWith("@newsletter") || sender.endsWith("@broadcast")) {
            return;
        }

        // 2. Filter out self-sent outgoing messages to other people (prevents hijacking owner's personal chats)
        const myPhoneNumber = (sock.user?.id || "").split(":")[0].replace(/[^0-9]/g, "");
        const myLid = (sock.user?.lid || "").split(":")[0].replace(/[^0-9]/g, "");
        const senderNum = sender.split("@")[0].replace(/[^0-9]/g, "");

        const isSelfChat = msg.key.fromMe && (
            (myPhoneNumber && sender.includes(myPhoneNumber)) ||
            (myLid && sender.includes(myLid)) ||
            (sender.endsWith("@lid") && (sender.includes("12820510949561") || (myLid && senderNum === myLid)))
        );

        if (msg.key.fromMe && !isSelfChat) {
            return;
        }

        const isGroup = sender.endsWith("@g.us");

        // 3. Extract message content safely from all WhatsApp message wrappers
        const m = msg.message?.ephemeralMessage?.message ||
                  msg.message?.viewOnceMessage?.message ||
                  msg.message?.viewOnceMessageV2?.message ||
                  msg.message?.documentWithCaptionMessage?.message ||
                  msg.message;

        const imageMsg = m?.imageMessage;
        const videoMsg = m?.videoMessage;
        const rawText = (m?.conversation || m?.extendedTextMessage?.text || "").trim();
        const caption = ((imageMsg || videoMsg)?.caption || "").trim();
        const fullContent = rawText || caption;

        if (!fullContent && !imageMsg && !videoMsg) return;

        const botPrefixes = ["⏰", "🚨", "📋", "🤖", "✅", "👋", "🧹", "📝", "🎉", "❌", "⚠️", "pong!"];
        if (botPrefixes.some(prefix => fullContent.startsWith(prefix))) {
            return;
        }

        console.log(`[WhatsApp Incoming] From: ${sender} | fromMe: ${msg.key.fromMe} | Text: "${fullContent}"`);

        // Wake word & bot invocation detection
        const lower = fullContent.toLowerCase();
        const wakeWordRegex = /^\s*(?:hey|hi|hello)?\s*anam[,:\s!.]*/i;
        const isWakeWord = wakeWordRegex.test(fullContent);
        const isBotCommand = /^(?:!bot|!start|!help|!anam|!token|!menu)\b/i.test(fullContent.trim());
        const isDedicatedBot = process.env.DEDICATED_BOT_MODE === "true";

        // Pending session response check
        const isPendingResponse = pendingMediaSessions.has(sender) || pendingTomorrowSessions.has(sender);

        // Check for verification token format (e.g. ANAM-XXXXXX)
        const candidateToken = db.normalizeToken(fullContent);
        const isTokenFormat = /^(?:ANAM-|TOKEN-|LINK-)?[A-Z0-9]{6,12}$/i.test(fullContent.trim()) ||
                              /^(?:token[:\s]+)?ANAM-[A-Z0-9]{6}$/i.test(fullContent.trim());
        const isTokenAttempt = isTokenFormat || /\btoken\b/i.test(fullContent);

        // ========================================================
        // 4. TOKEN VERIFICATION & ACCOUNT LINKING (Handles both new & switching users)
        // ========================================================
        if (candidateToken) {
            const matchedUser = db.getUserByAuthToken(candidateToken);
            if (matchedUser) {
                const phone = db.extractPhoneFromJid(sender);
                db.verifyAndLinkUser(candidateToken, sender, phone);

                const session = getSession(sender);
                session.isActive = true;
                session.userId = matchedUser.id;

                const welcomeMsg = `🎉 *Authentication Successful!*

Welcome to *Anam AI SaaS*, *${matchedUser.name}*!
Your WhatsApp is now linked to your account (*${matchedUser.email}*).

✨ *What you can do:*
• *Clock Alarms:* "Hey Anam 4pm reminder: Team sync"
• *Countdown Timers:* "Hey Anam remind me in 10 minutes to drink water"
• *To-Dos:* "Hey Anam add Buy Groceries to list"
• *Check Tasks:* "Hey Anam show tasks"
• *Complete Tasks:* "Hey Anam done 1"
• *Web Dashboard:* http://localhost:3000

Say *"Hey Anam"* anytime to start your session!`;

                await sendReply(sock, sender, { text: welcomeMsg });
                console.log(`[Auth] Verified & linked user: ${matchedUser.email} (${sender})`);
                return;
            } else if (isTokenAttempt) {
                const invalidMsg = `❌ *Invalid Verification Token*

We couldn't find an account matching: *"${fullContent}"*

Please verify your active token on your web dashboard:
🌐 *http://localhost:3000*

_Tip: Sign in, copy your active token (e.g. ANAM-XXXXXX), and reply with it here._`;
                await sendReply(sock, sender, { text: invalidMsg });
                return;
            }
        }

        // ========================================================
        // 5. UNVERIFIED USER HANDLING
        // ========================================================
        let dbUser = db.getUserByWhatsAppJid(sender);

        if (!dbUser) {
            if (isWakeWord || isBotCommand || isDedicatedBot || isSelfChat) {
                const authPrompt = `👋 *Welcome to Anam AI Assistant!*

This WhatsApp bot is an exclusive service for registered SaaS members. One bot serves all registered users with secure, multi-tenant isolation!

*To get started in 3 quick steps:*
1️⃣ *Register on our web portal:*
🌐 http://localhost:3000

2️⃣ *Copy your unique Verification Token* from your dashboard (e.g. *ANAM-A7B8C9*).

3️⃣ *Reply to this chat with your token* to link your account!

_Already have your token? Simply reply with it now to verify!_`;

                await sendReply(sock, sender, { text: authPrompt });
                return;
            }

            // Normal personal message to this WhatsApp number -> SILENTLY IGNORE (do not spam personal contacts)
            console.log(`[Filter] Ignored unverified message from ${sender} (no wake word / bot command)`);
            return;
        }

        // ========================================================
        // 6. VERIFIED USER: ACCOUNT COMMANDS & SESSION HANDLING
        // ========================================================
        db.updateLastActive(dbUser.id);
        const accountCmdLower = fullContent.toLowerCase().trim();

        if (["!account", "whoami", "my account", "!status"].includes(accountCmdLower)) {
            const pendingTodos = db.getUserTodos(dbUser.id).filter(t => t.status === "pending").length;
            const pendingRem = db.getUserReminders(dbUser.id).filter(r => r.status === "pending").length;
            const accountMsg = `👤 *Your Anam AI Account*
• *Name:* ${dbUser.name}
• *Email:* ${dbUser.email}
• *Token:* ${dbUser.auth_token}
• *Status:* 🟢 Verified & Linked
• *Active Tasks:* ${pendingTodos}
• *Scheduled Reminders:* ${pendingRem}
• *Web Dashboard:* http://localhost:3000

_Type *'!unlink'* to disconnect this WhatsApp number._`;
            await sendReply(sock, sender, { text: accountMsg });
            return;
        }

        if (["!unlink", "unlink", "unlink account", "disconnect"].includes(accountCmdLower)) {
            db.unlinkUserWhatsApp(dbUser.id);
            clearSession(sender);
            const unlinkedMsg = `👋 *Account Disconnected*

Your WhatsApp has been unlinked from your account (*${dbUser.email}*).
You can reconnect anytime by sending a fresh token from your dashboard.`;
            await sendReply(sock, sender, { text: unlinkedMsg });
            return;
        }

        const session = getSession(sender);
        session.userId = dbUser.id;

        // Check for direct commands: reminders, tasks, todos, media, or wake words
        const isDirectReminder = Boolean(parseFreeFormReminder(fullContent));
        const isAddTask = Boolean(parseTaskCommand(fullContent));
        const isShowTasks = /^\s*(?:show\s+(?:my\s+)?tasks|my\s+tasks|tasks|todos|my\s+todo\s+list)\s*$/i.test(fullContent);
        const isDoneTask = /^\s*(?:done|complete|check\s+off)\s+(\d+)\s*$/i.test(fullContent);

        if (isGroup) {
            // Group Chat Rule: MUST start with "Hey Anam" OR be an active response to a pending prompt
            if (!isWakeWord && !isPendingResponse) {
                return;
            }
        } else {
            // Direct/Private Chat Rule: Activate session on wake word, direct reminder, direct tasks, media, or self-chat
            if (isWakeWord || isDirectReminder || isAddTask || isShowTasks || isDoneTask || imageMsg || videoMsg || isSelfChat) {
                session.isActive = true;
            } else if (!session.isActive && !isPendingResponse) {
                return;
            }
        }

        // Clean user prompt by stripping wake word if present
        let userPrompt = fullContent;
        let cleanCaption = caption;
        if (isWakeWord) {
            userPrompt = fullContent.replace(wakeWordRegex, "").trim();
            cleanCaption = caption.replace(wakeWordRegex, "").trim();
        }

        // Direct Memory & Session Clear
        const clearPhrases = ["!clear", "!reset", "clear memory", "clear session", "clear history", "reset session", "reset memory"];
        const cleanLower = userPrompt.toLowerCase();
        if (clearPhrases.includes(lower) || clearPhrases.includes(cleanLower)) {
            clearSession(sender);
            if (pendingMediaSessions.has(sender)) {
                const prev = pendingMediaSessions.get(sender);
                if (prev.timer) clearTimeout(prev.timer);
                if (prev.mediaPath && fs.existsSync(prev.mediaPath)) {
                    try { fs.unlinkSync(prev.mediaPath); } catch {}
                }
                pendingMediaSessions.delete(sender);
            }
            if (pendingTomorrowSessions.has(sender)) {
                const prev = pendingTomorrowSessions.get(sender);
                if (prev.timer) clearTimeout(prev.timer);
                pendingTomorrowSessions.delete(sender);
            }
            await sendReply(sock, sender, { text: "Memory & session cleared! Starting fresh." });
            return;
        }

        // Session Close Commands
        const closePhrases = ["bye", "bye anam", "exit", "quit", "goodbye", "stop", "close session", "!exit"];
        if (session.isActive && closePhrases.includes(lower)) {
            session.isActive = false;
            await sendReply(sock, sender, { text: "👋 *Session ended!* Say *'Hey Anam'* whenever you need me again." });
            return;
        }

        console.log(`[Anam Received] From: ${sender} | Prompt: "${userPrompt || '<Session Started>'}"`);

        // Handle Intro
        if (isWakeWord && !userPrompt) {
            const intro = `👋 *Hey! I'm listening.*

You don't need to repeat "Hey Anam". Just type what you want:
• *"Remind me at 8:35 to read newspaper"*
• *"Reminder : 9:19 pm call my sister."*
• *"8pm extract website data, analyse the given website and give details"*
• Send an image/video with caption *"remind me in 2 minutes to check this"*
• *"show tasks"* or *"done 1"*
• Ask any general question!

_Type *"bye"* or *"exit"* when done._`;

            session.history.push({ role: "model", parts: [{ text: intro }] });
            await sendReply(sock, sender, { text: intro });
            return;
        }

        // 1. Check for Media Message (Image or Video)
        if (imageMsg || videoMsg) {
            const isImage = !!imageMsg;
            const mediaType = isImage ? "image" : "video";

            // Download Media Buffer
            let buffer;
            try {
                buffer = await downloadMediaMessage(msg, "buffer", {});
            } catch (err) {
                console.error("Failed to download media:", err.message);
                return;
            }

            // Max file size limit check (16 MB)
            const MAX_SIZE = 16 * 1024 * 1024;
            if (buffer.length > MAX_SIZE) {
                await sendReply(sock, sender, { text: "This file is too big to send back. Please send a smaller one." });
                return;
            }

            // Save file persistently to disk
            const ext = isImage ? "jpg" : "mp4";
            const mediaId = "media_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
            const mediaPath = path.join(MEDIA_DIR, `${mediaId}.${ext}`);
            fs.writeFileSync(mediaPath, buffer);

            if (cleanCaption) {
                // Way 1: Media with caption
                const parsedCmd = parseFreeFormReminder(cleanCaption);
                if (parsedCmd && parsedCmd.targetTimestamp) {
                    parsedCmd.mediaPath = mediaPath;
                    parsedCmd.mediaType = mediaType;
                    const confirmMsg = createAndSaveReminder(sock, sender, parsedCmd, dbUser ? dbUser.id : null);
                    await sendReply(sock, sender, { text: confirmMsg });
                    return;
                } else {
                    setPendingMediaSession(sender, { mediaPath, mediaType, captionText: cleanCaption }, sock);
                    await sendReply(sock, sender, { text: "Got it. What time should I remind you?" });
                    return;
                }
            } else {
                // Way 2: Media without caption
                setPendingMediaSession(sender, { mediaPath, mediaType, captionText: "" }, sock);
                await sendReply(sock, sender, { text: "Got it. What time should I remind you?" });
                return;
            }
        }

        // Direct Add-Task Command Handling (Synced immediately with SQLite & Web)
        const taskCmd = parseTaskCommand(userPrompt);
        if (taskCmd && taskCmd.name) {
            let addedTodo = null;
            if (dbUser) {
                addedTodo = db.addTodo(dbUser.id, taskCmd.name, taskCmd.description || "");
            } else {
                const todos = loadTodos();
                const userTodos = todos[sender] || [];
                const newItem = taskCmd.description ? { name: taskCmd.name, description: taskCmd.description } : { name: taskCmd.name };
                userTodos.push(newItem);
                todos[sender] = userTodos;
                saveTodos(todos);
                addedTodo = newItem;
            }

            const descSnippet = taskCmd.description ? ` (${taskCmd.description})` : "";
            const replyText = `✅ Added to your checklist: "*${taskCmd.name}*"${descSnippet}\nSynced with your web dashboard! 🌐`;
            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: replyText }] });
            await sendReply(sock, sender, { text: replyText });
            return;
        }

        // Handle Direct Task Commands (FIX 3: Direct handling without Gemini or Reminder Parser)
        const showTasksRegex = /^\s*(?:show\s+(?:my\s+)?tasks|my\s+tasks|tasks|todos|my\s+todo\s+list)\s*$/i;
        const doneTaskRegex = /^\s*(?:done|complete|check\s+off)\s+(\d+)\s*$/i;

        if (showTasksRegex.test(userPrompt)) {
            const userTodos = dbUser 
                ? db.getUserTodos(dbUser.id).filter(t => t.status === "pending")
                : (loadTodos()[sender] || []);
            const userReminders = dbUser
                ? db.getUserReminders(dbUser.id).filter(r => r.status === "pending")
                : loadReminders().filter(r => r.sender === sender && r.status === "pending");

            let resultText = "";
            if (userTodos.length === 0 && userReminders.length === 0) {
                resultText = "Your to-do list is empty! Check your web dashboard at http://localhost:3000";
            } else {
                let listStr = "";
                let count = 1;
                if (userTodos.length > 0) {
                    listStr += userTodos.map(t => {
                        const itemName = typeof t === "object" ? t.name : t;
                        const itemDesc = typeof t === "object" && t.description ? ` (${t.description})` : "";
                        return `${count++}. ${itemName}${itemDesc}`;
                    }).join("\n");
                }
                if (userReminders.length > 0) {
                    if (listStr) listStr += "\n";
                    listStr += userReminders.map(r => {
                        const timeStr = formatTimeString(r.target_timestamp || r.targetTimestamp);
                        const descStr = r.description ? ` (${r.description})` : "";
                        return `${count++}. ${r.name}${descStr} - ${timeStr}`;
                    }).join("\n");
                }
                resultText = `📝 Your Tasks (Synced with Web):\n${listStr}`;
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resultText }] });
            await sendReply(sock, sender, { text: resultText });
            return;
        }

        const doneMatch = userPrompt.match(doneTaskRegex);
        if (doneMatch) {
            const idx = parseInt(doneMatch[1], 10);
            let resultText = "";

            if (dbUser) {
                const pendingTodos = db.getUserTodos(dbUser.id).filter(t => t.status === "pending");
                const pendingReminders = db.getUserReminders(dbUser.id).filter(r => r.status === "pending");
                const totalPending = pendingTodos.length + pendingReminders.length;

                if (idx >= 1 && idx <= pendingTodos.length) {
                    const target = pendingTodos[idx - 1];
                    db.completeTodoById(dbUser.id, target.id);
                    resultText = `🎉 Done! Completed: "${target.name}". Synced with your dashboard!`;
                } else if (idx > pendingTodos.length && idx <= totalPending) {
                    const target = pendingReminders[idx - pendingTodos.length - 1];
                    db.markReminderSent(target.id);
                    try {
                        fs.writeFileSync(path.join(__dirname, ".reminders_sync"), String(Date.now()));
                    } catch (e) {}
                    resultText = `🎉 Done! Completed reminder task: "${target.name}". Synced with your dashboard!`;
                } else {
                    resultText = "Invalid task number. Type 'show tasks' to view your current list.";
                }
            } else {
                const todos = loadTodos();
                const userTodos = todos[sender] || [];
                if (idx >= 1 && idx <= userTodos.length) {
                    const removed = userTodos.splice(idx - 1, 1);
                    todos[sender] = userTodos;
                    saveTodos(todos);
                    if (removed[0] && typeof removed[0] === "object" && removed[0].mediaPath) {
                        if (fs.existsSync(removed[0].mediaPath)) {
                            try { fs.unlinkSync(removed[0].mediaPath); } catch {}
                        }
                    }
                    const removedName = typeof removed[0] === "object" ? removed[0].name : removed[0];
                    resultText = `Done! Completed: ${removedName}`;
                } else {
                    resultText = "Invalid task number.";
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resultText }] });
            await sendReply(sock, sender, { text: resultText });
            return;
        }

        // Check for Pending Tomorrow Session (Bug 3 Fix)
        if (pendingTomorrowSessions.has(sender)) {
            const pending = pendingTomorrowSessions.get(sender);
            const parsedClock = parseClockTime(userPrompt);
            const parsedFull = parseFreeFormReminder(userPrompt);

            let targetTimestamp = null;
            if (parsedClock) {
                const target = new Date();
                target.setDate(target.getDate() + 1);
                target.setHours(parsedClock.hours, parsedClock.minutes, 0, 0);
                targetTimestamp = target.getTime();
            } else if (parsedFull && parsedFull.targetTimestamp) {
                targetTimestamp = parsedFull.targetTimestamp;
            }

            if (targetTimestamp) {
                if (pending.timer) clearTimeout(pending.timer);
                pendingTomorrowSessions.delete(sender);

                const newParsedCmd = {
                    targetTimestamp,
                    isTomorrow: true,
                    name: pending.name || "task",
                    description: pending.description || ""
                };

                const confirmMsg = createAndSaveReminder(sock, sender, newParsedCmd, dbUser ? dbUser.id : null);
                session.history.push({ role: "user", parts: [{ text: userPrompt }] });
                session.history.push({ role: "model", parts: [{ text: confirmMsg }] });
                await sendReply(sock, sender, { text: confirmMsg });
                return;
            }
        }

        // 2. Check for Pending Media Session (Way 2: Media first, time after)
        if (pendingMediaSessions.has(sender)) {
            const pendingSession = pendingMediaSessions.get(sender);
            const parsedCmd = parseFreeFormReminder(userPrompt);

            if (!parsedCmd || parsedCmd.missingTime || !parsedCmd.targetTimestamp) {
                await sendReply(sock, sender, { text: "What time should I remind you?" });
                return;
            }

            if (pendingSession.timer) clearTimeout(pendingSession.timer);
            pendingMediaSessions.delete(sender);

            parsedCmd.mediaPath = pendingSession.mediaPath;
            parsedCmd.mediaType = pendingSession.mediaType;

            if (!parsedCmd.name) {
                parsedCmd.name = "your file";
            }

            const confirmMsg = createAndSaveReminder(sock, sender, parsedCmd, dbUser ? dbUser.id : null);
            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: confirmMsg }] });
            await sendReply(sock, sender, { text: confirmMsg });
            return;
        }

        // 3. Free-Form Text Reminder Parser
        const parsedCmd = parseFreeFormReminder(userPrompt);

        if (parsedCmd) {
            if (parsedCmd.missingTomorrowTime) {
                const askTimeMsg = "What time tomorrow?";
                if (pendingTomorrowSessions.has(sender)) {
                    const prev = pendingTomorrowSessions.get(sender);
                    if (prev.timer) clearTimeout(prev.timer);
                }
                const timer = setTimeout(() => {
                    pendingTomorrowSessions.delete(sender);
                }, 10 * 60 * 1000);

                pendingTomorrowSessions.set(sender, {
                    name: parsedCmd.name || "task",
                    description: parsedCmd.description || "",
                    timer
                });

                session.history.push({ role: "user", parts: [{ text: userPrompt }] });
                session.history.push({ role: "model", parts: [{ text: askTimeMsg }] });
                await sendReply(sock, sender, { text: askTimeMsg });
                return;
            }

            if (parsedCmd.missingTime) {
                const askTimeMsg = "What time should I remind you?";
                session.history.push({ role: "user", parts: [{ text: userPrompt }] });
                session.history.push({ role: "model", parts: [{ text: askTimeMsg }] });
                await sendReply(sock, sender, { text: askTimeMsg });
                return;
            }

            if (parsedCmd.targetTimestamp) {
                const confirmMsg = createAndSaveReminder(sock, sender, parsedCmd, dbUser ? dbUser.id : null);
                session.history.push({ role: "user", parts: [{ text: userPrompt }] });
                session.history.push({ role: "model", parts: [{ text: confirmMsg }] });
                await sendReply(sock, sender, { text: confirmMsg });
                return;
            }
        }

        if (!ai) {
            await sendReply(sock, sender, {
                text: "Sorry, something went wrong on my side. Try again in a bit."
            });
            return;
        }

        // 4. Handle To-Do and General AI queries via Gemini
        const systemInstruction = `You are Anam, a smart WhatsApp assistant${dbUser ? ` for ${dbUser.name}` : ''}.
Current Local Time: ${new Date().toLocaleString()}
${session.summary ? `Previous Conversation Summary: "${session.summary}"` : ""}

CRITICAL RULES:
1. TO-DO CHECKLIST: Only call 'add_todo' when user wants to add an item to their static checklist without a time trigger (e.g. 'add milk to list').
2. SHOW TASKS: Call 'get_todos' when user asks 'show tasks', 'what are my tasks', 'my todo list', 'todos'.
3. COMPLETE TASK: Call 'complete_todo' when user says 'done 1', 'check off 2'.

Reply like a friendly person texting. Short, plain words. No headings. No bullet lists unless the user asks. No bold unless needed. Never say you are an AI model.`;

        session.history.push({ role: "user", parts: [{ text: userPrompt }] });

        try {
            const contents = [...session.history];
            const response = await generateAIContent(contents, systemInstruction);

            if (response.functionCalls && response.functionCalls.length > 0) {
                for (const call of response.functionCalls) {
                    const { name, args } = call;
                    let resultText = "";

                    if (name === "add_todo") {
                        const todoName = args.name || args.task || "Task";
                        const todoDesc = args.description || "";
                        if (dbUser) {
                            db.addTodo(dbUser.id, todoName, todoDesc);
                        } else {
                            const todos = loadTodos();
                            const userTodos = todos[sender] || [];
                            const newItem = todoDesc ? { name: todoName, description: todoDesc } : { name: todoName };
                            userTodos.push(newItem);
                            todos[sender] = userTodos;
                            saveTodos(todos);
                        }
                        resultText = `Added to list: ${todoName}${todoDesc ? ` (${todoDesc})` : ""}`;
                    } else if (name === "get_todos") {
                        const userTodos = dbUser 
                            ? db.getUserTodos(dbUser.id).filter(t => t.status === "pending")
                            : (loadTodos()[sender] || []);
                        const reminders = dbUser 
                            ? db.getUserReminders(dbUser.id).filter(r => r.status === "pending")
                            : loadReminders().filter(r => r.sender === sender && r.status === "pending");

                        if (userTodos.length === 0 && reminders.length === 0) {
                            resultText = "Your to-do list is empty!";
                        } else {
                            let listStr = "";
                            let count = 1;
                            if (userTodos.length > 0) {
                                listStr += userTodos.map(t => {
                                    const itemName = typeof t === "object" ? t.name : t;
                                    const itemDesc = typeof t === "object" && t.description ? ` (${t.description})` : "";
                                    return `${count++}. ${itemName}${itemDesc}`;
                                }).join("\n");
                            }
                            if (reminders.length > 0) {
                                if (listStr) listStr += "\n";
                                listStr += reminders.map(r => {
                                    const timeStr = formatTimeString(r.target_timestamp || r.targetTimestamp);
                                    const descStr = r.description ? ` (${r.description})` : "";
                                    return `${count++}. ${r.name}${descStr} - ${timeStr}`;
                                }).join("\n");
                            }
                            resultText = `Your Tasks:\n${listStr}`;
                        }
                    } else if (name === "complete_todo") {
                        const idx = args.task_number;
                        if (dbUser) {
                            const pendingTodos = db.getUserTodos(dbUser.id).filter(t => t.status === "pending");
                            const pendingReminders = db.getUserReminders(dbUser.id).filter(r => r.status === "pending");
                            const totalPending = pendingTodos.length + pendingReminders.length;

                            if (idx >= 1 && idx <= pendingTodos.length) {
                                const target = pendingTodos[idx - 1];
                                db.completeTodoById(dbUser.id, target.id);
                                resultText = `Done! Completed: ${target.name}`;
                            } else if (idx > pendingTodos.length && idx <= totalPending) {
                                const target = pendingReminders[idx - pendingTodos.length - 1];
                                db.markReminderSent(target.id);
                                try {
                                    fs.writeFileSync(path.join(__dirname, ".reminders_sync"), String(Date.now()));
                                } catch (e) {}
                                resultText = `Done! Completed: ${target.name}`;
                            } else {
                                resultText = "Invalid task number.";
                            }
                        } else {
                            const todos = loadTodos();
                            const userTodos = todos[sender] || [];
                            if (idx >= 1 && idx <= userTodos.length) {
                                const removed = userTodos.splice(idx - 1, 1);
                                todos[sender] = userTodos;
                                saveTodos(todos);
                                if (removed[0] && typeof removed[0] === "object" && removed[0].mediaPath) {
                                    if (fs.existsSync(removed[0].mediaPath)) {
                                        try { fs.unlinkSync(removed[0].mediaPath); } catch {}
                                    }
                                }
                                const removedName = typeof removed[0] === "object" ? removed[0].name : removed[0];
                                resultText = `Done! Completed: ${removedName}`;
                            } else {
                                resultText = "Invalid task number.";
                            }
                        }
                    } else if (name === "clear_memory") {
                        clearSession(sender);
                        resultText = "Memory cleared! Starting fresh.";
                    }

                    session.history.push({ role: "model", parts: [{ text: resultText }] });
                    await sendReply(sock, sender, { text: resultText });
                }
            } else {
                const reply = response.text || "I didn't catch that.";
                session.history.push({ role: "model", parts: [{ text: reply }] });
                await sendReply(sock, sender, { text: reply });
            }

            condenseSessionMemory(sender);

        } catch (err) {
            console.error("Bot Error:", err);
            const errStr = (err?.message || "").toLowerCase();
            const status = err?.status || (err?.error && err?.error?.code);
            const isOverloaded = status === 503 || status === 429 ||
                errStr.includes("503") || errStr.includes("429") || errStr.includes("unavailable") || errStr.includes("high demand") || errStr.includes("resource_exhausted");

            const replyText = isOverloaded
                ? "I'm a bit overloaded right now. Try again in a minute."
                : "Sorry, something went wrong on my side. Try again in a bit.";

            await sendReply(sock, sender, { text: replyText });
        }
    });
    } catch (err) {
        isStartingBot = false;
        console.error("[StartBot Error]:", err?.message || err);
        if (!reconnectTimer) {
            reconnectTimer = setTimeout(() => {
                reconnectTimer = null;
                startBot();
            }, 3000);
        }
    }
}

startBot();