import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from "@whiskeysockets/baileys";
import { GoogleGenAI, Type } from "@google/genai";
import qrcode from "qrcode-terminal";
import pino from "pino";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";

dotenv.config();

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
    const sent = await sock.sendMessage(sender, content);
    if (sent?.key?.id) {
        sentMessageIds.add(sent.key.id);
        setTimeout(() => sentMessageIds.delete(sent.key.id), 5 * 60 * 1000);
    }
    return sent;
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
        triggerReminder(sock, rem);
        return;
    }

    const timer = setTimeout(() => {
        triggerReminder(sock, rem);
    }, delayMs);

    activeTimers.set(rem.id, timer);
}

async function triggerReminder(sock, rem) {
    const reminders = loadReminders();
    const item = reminders.find(r => r.id === rem.id);
    if (!item || item.status === "sent") return;

    item.status = "sent";
    saveReminders(reminders);
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

    let textToSend = (item.message && item.message.trim()) ? item.message.trim() : fallbackText;

    if (rem.mediaPath) {
        if (!fs.existsSync(rem.mediaPath)) {
            await sendReply(sock, rem.sender, { text: "Your reminder is due but the file could not be sent." });
            return;
        }

        let mediaCaption = textToSend;
        if (isGenericName && !rem.description && !item.message) {
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

function restorePendingReminders(sock) {
    const reminders = loadReminders();
    const pending = reminders.filter(r => r.status === "pending");
    console.log(`[Reminders] Restoring ${pending.length} pending reminder(s)...`);
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
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout")), 4000)
        );

        const apiPromise = generateAIContent([{ role: "user", parts: [{ text: prompt }] }], undefined);

        const res = await Promise.race([apiPromise, timeoutPromise]);
        let text = res.text ? res.text.trim() : "";

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
    const reminders = loadReminders();
    const item = reminders.find(r => r.id === reminderId);
    if (item) {
        item.message = messageText;
        saveReminders(reminders);
    }
}

function createAndSaveReminder(sock, sender, parsedCmd) {
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

    const reminders = loadReminders();
    const id = "rem_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
    const newRem = {
        id,
        sender,
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
    generateReminderMessage(id, displayName, description || "").catch(err => {
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

// 9. Main Bot Engine
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState("auth_info");

    const sock = makeWASocket({
        logger: pino({ level: "silent" }),
        auth: state,
        printQRInTerminal: false
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("Scan this QR code with WhatsApp (Linked Devices):");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed (status: ${statusCode || 'unknown'}). Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                setTimeout(startBot, 3000);
            } else {
                console.log("⚠️ Session logged out or invalidated. Cleaning auth_info and restarting for QR scan...");
                try {
                    fs.rmSync("auth_info", { recursive: true, force: true });
                } catch (e) {}
                setTimeout(startBot, 2000);
            }
        } else if (connection === "open") {
            console.log("✅ Anam Bot is connected! Say 'Hey Anam' to start a session.");
            restorePendingReminders(sock);
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        if (sentMessageIds.has(msg.key.id)) {
            sentMessageIds.delete(msg.key.id);
            return;
        }

        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith("@g.us");

        const imageMsg = msg.message.imageMessage;
        const videoMsg = msg.message.videoMessage;
        const rawText = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        const caption = ((imageMsg || videoMsg)?.caption || "").trim();
        const fullContent = rawText || caption;

        if (!fullContent && !imageMsg && !videoMsg) return;

        const botPrefixes = ["⏰", "🚨", "📋", "🤖", "✅", "👋", "🧹", "📝", "🎉", "❌", "⚠️", "pong!"];
        if (botPrefixes.some(prefix => fullContent.startsWith(prefix))) {
            return;
        }

        const session = getSession(sender);
        const lower = fullContent.toLowerCase();
        const wakeWordRegex = /^\s*hey\s+anam[,:\s]*/i;
        const isWakeWord = wakeWordRegex.test(fullContent);

        // Check if answering a pending prompt (e.g. "What time tomorrow?" or "What time should I remind you?")
        const isPendingResponse = pendingMediaSessions.has(sender) || pendingTomorrowSessions.has(sender);

        if (isGroup) {
            // Group Chat Rule: MUST start with "Hey Anam" OR be an active response to a pending prompt
            if (!isWakeWord && !isPendingResponse) {
                return;
            }
        } else {
            // Direct/Private Chat Rule: MUST start with "Hey Anam", be an active session, or be a pending response
            if (isWakeWord) {
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
                    const confirmMsg = createAndSaveReminder(sock, sender, parsedCmd);
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

        // Handle Direct Task Commands (FIX 3: Direct handling without Gemini or Reminder Parser)
        const showTasksRegex = /^\s*(?:show\s+(?:my\s+)?tasks|my\s+tasks|tasks|todos|my\s+todo\s+list)\s*$/i;
        const doneTaskRegex = /^\s*(?:done|complete|check\s+off)\s+(\d+)\s*$/i;

        if (showTasksRegex.test(userPrompt)) {
            const todos = loadTodos();
            const userTodos = todos[sender] || [];
            const reminders = loadReminders().filter(r => r.sender === sender && r.status === "pending");

            let resultText = "";
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
                        const timeStr = formatTimeString(r.targetTimestamp);
                        const descStr = r.description ? ` (${r.description})` : "";
                        return `${count++}. ${r.name}${descStr} - ${timeStr}`;
                    }).join("\n");
                }
                resultText = `Your Tasks:\n${listStr}`;
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resultText }] });
            await sendReply(sock, sender, { text: resultText });
            return;
        }

        const doneMatch = userPrompt.match(doneTaskRegex);
        if (doneMatch) {
            const idx = parseInt(doneMatch[1], 10);
            const todos = loadTodos();
            const userTodos = todos[sender] || [];
            let resultText = "";

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

                const confirmMsg = createAndSaveReminder(sock, sender, newParsedCmd);
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

            const confirmMsg = createAndSaveReminder(sock, sender, parsedCmd);
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
                const confirmMsg = createAndSaveReminder(sock, sender, parsedCmd);
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
        const systemInstruction = `You are Anam, a smart WhatsApp assistant.
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
                        const todos = loadTodos();
                        const userTodos = todos[sender] || [];
                        const todoName = args.name || args.task || "Task";
                        const todoDesc = args.description || "";
                        const newItem = todoDesc ? { name: todoName, description: todoDesc } : { name: todoName };

                        userTodos.push(newItem);
                        todos[sender] = userTodos;
                        saveTodos(todos);

                        resultText = `Added to list: ${todoName}${todoDesc ? ` (${todoDesc})` : ""}`;
                    } else if (name === "get_todos") {
                        const todos = loadTodos();
                        const userTodos = todos[sender] || [];
                        const reminders = loadReminders().filter(r => r.sender === sender && r.status === "pending");

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
                                    const timeStr = formatTimeString(r.targetTimestamp);
                                    const descStr = r.description ? ` (${r.description})` : "";
                                    return `${count++}. ${r.name}${descStr} - ${timeStr}`;
                                }).join("\n");
                            }
                            resultText = `Your Tasks:\n${listStr}`;
                        }
                    } else if (name === "complete_todo") {
                        const todos = loadTodos();
                        const userTodos = todos[sender] || [];
                        const idx = args.task_number;
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
}

startBot();