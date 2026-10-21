import { makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } from "@whiskeysockets/baileys";
import { GoogleGenAI, Type } from "@google/genai";
import qrcode from "qrcode-terminal";
import pino from "pino";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { execSync } from "child_process";
import db from "./db.js";
import jiraService, {
    getEffectiveJiraConfig,
    createJiraIssue,
    getJiraIssues,
    getJiraIssue,
    transitionJiraIssue,
    addJiraComment,
    formatIssuesForWhatsApp,
    formatSingleIssueForWhatsApp,
    formatCreatedIssueForWhatsApp,
    formatTransitionForWhatsApp
} from "./services/jiraService.js";
import googleCalendarService, {
    getEffectiveCalendarConfig,
    listCalendarEvents,
    createCalendarEvent,
    createInstantGoogleMeet,
    deleteCalendarEvent,
    generateGoogleMeetLink,
    formatEventsForWhatsApp,
    formatCreatedEventForWhatsApp,
    formatInstantMeetForWhatsApp
} from "./services/googleCalendarService.js";
import googleDriveService, {
    getEffectiveDriveConfig,
    listDriveFiles,
    searchDriveFiles,
    uploadDriveFile,
    createDriveFolder,
    shareDriveFile,
    deleteDriveFile,
    formatDriveFilesForWhatsApp,
    formatUploadedFileForWhatsApp,
    formatFolderCreatedForWhatsApp,
    formatDriveApiError
} from "./services/googleDriveService.js";
import asanaService, {
    getEffectiveAsanaConfig,
    getAsanaTasks,
    getAsanaTask,
    createAsanaTask,
    completeAsanaTask,
    updateAsanaTask,
    createAsanaProject,
    addAsanaComment,
    formatAsanaTasksForWhatsApp,
    formatSingleAsanaTaskForWhatsApp,
    formatCreatedAsanaTaskForWhatsApp,
    formatCompletedAsanaTaskForWhatsApp,
    formatCreatedAsanaProjectForWhatsApp,
    formatUpdatedAsanaTaskForWhatsApp
} from "./services/asanaService.js";
import emailService, {
    getEffectiveEmailConfig,
    sendEmail,
    formatDraftForWhatsApp,
    formatSentEmailForWhatsApp,
    formatDraftListForWhatsApp,
    generateEmailDraftContent,
    verifyEmailConnection,
    cleanAppPassword
} from "./services/emailService.js";

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
const lastJiraIssuesBySender = new Map(); // sender -> Array of recent Jira issue objects
const lastAsanaTasksBySender = new Map(); // sender -> Array of recent Asana task objects

function resolveJiraIssueKey(sender, keyOrIndex, defaultProject = "") {
    if (!keyOrIndex) return null;
    let raw = keyOrIndex.trim();

    // Check if it's a number (1-based index or ticket number)
    if (/^\d+$/.test(raw)) {
        const idx = parseInt(raw, 10);
        const cached = lastJiraIssuesBySender.get(sender);
        if (cached && idx >= 1 && idx <= cached.length) {
            return cached[idx - 1].key;
        }
        if (defaultProject) {
            return `${defaultProject}-${idx}`.toUpperCase();
        }
        return null;
    }

    // Replace spaces with hyphen, e.g. "KAN 1" -> "KAN-1"
    raw = raw.replace(/^([A-Za-z0-9]+)\s+(\d+)$/, "$1-$2");
    return raw.toUpperCase();
}

async function findOrResolveAsanaTask(config, sender, gidOrIndexOrName) {
    if (!gidOrIndexOrName) return null;
    let raw = String(gidOrIndexOrName).trim();
    // Strip trailing punctuation like . or ! or quotes
    raw = raw.replace(/^[“"']+/, "").replace(/[”"'.!?:;]+$/, "").trim();
    if (!raw) return null;

    // 1. If 1-based index into cached list
    if (/^\d+$/.test(raw)) {
        const idx = parseInt(raw, 10);
        const cached = lastAsanaTasksBySender.get(sender);
        if (cached && idx >= 1 && idx <= cached.length) {
            return cached[idx - 1];
        }
        // If it's a long number (Asana GID >= 10 digits)
        if (raw.length >= 10) {
            return { gid: raw, name: "Task" };
        }
    }

    // 2. Search in cached tasks by name
    const cached = lastAsanaTasksBySender.get(sender) || [];
    const lowerQuery = raw.toLowerCase();

    let found = cached.find(t => (t.name || "").trim().toLowerCase() === lowerQuery);
    if (!found) {
        found = cached.find(t => (t.name || "").toLowerCase().includes(lowerQuery) || lowerQuery.includes((t.name || "").toLowerCase()));
    }
    if (found) return found;

    // 3. If not found in cache, fetch active tasks from Asana and search
    try {
        const res = await getAsanaTasks(config, { maxResults: 50 });
        if (res.tasks && res.tasks.length > 0) {
            lastAsanaTasksBySender.set(sender, res.tasks);
            found = res.tasks.find(t => (t.name || "").trim().toLowerCase() === lowerQuery);
            if (!found) {
                found = res.tasks.find(t => (t.name || "").toLowerCase().includes(lowerQuery) || lowerQuery.includes((t.name || "").toLowerCase()));
            }
            if (found) return found;
        }
    } catch (e) {
        console.warn("[Asana Resolve Task Warning]:", e.message);
    }

    // Fallback: If it's numeric GID
    if (/^\d{10,}$/.test(raw)) {
        return { gid: raw, name: "Task" };
    }

    return null;
}

function resolveAsanaTaskId(sender, gidOrIndex) {
    if (!gidOrIndex) return null;
    let raw = String(gidOrIndex).trim().replace(/[.!?:;]+$/, "");
    if (/^\d+$/.test(raw)) {
        const idx = parseInt(raw, 10);
        const cached = lastAsanaTasksBySender.get(sender);
        if (cached && idx >= 1 && idx <= cached.length) {
            return cached[idx - 1].gid;
        }
        if (raw.length >= 10) {
            return raw;
        }
    }
    const cached = lastAsanaTasksBySender.get(sender) || [];
    const lower = raw.toLowerCase();
    const found = cached.find(t => (t.name || "").toLowerCase().includes(lower));
    return found ? found.gid : raw;
}

function buildAlgorithmicPriority({ jiraIssues = [], asanaTasks = [], userTodos = [], userReminders = [], host = "" }) {
    let out = "🎯 *Prioritized Task Order:*\n\n";

    const inProgress = jiraIssues.filter(i => /progress|review|dev/i.test(i.status));
    const subtasksAndBugs = jiraIssues.filter(i => !inProgress.includes(i) && /subtask|sub-task|bug/i.test(i.issueType));
    const docs = jiraIssues.filter(i => !inProgress.includes(i) && !subtasksAndBugs.includes(i) && /doc|document/i.test(i.summary));
    const otherTasks = jiraIssues.filter(i => !inProgress.includes(i) && !subtasksAndBugs.includes(i) && !docs.includes(i));

    let count = 1;
    if (inProgress.length > 0) {
        out += "🔥 *In Progress / Top Priority:*\n";
        inProgress.forEach(i => {
            out += `${count++}. *[${i.key}]* ${i.summary} (🟡 _${i.status}_)\n`;
        });
        out += "\n";
    }

    if (subtasksAndBugs.length > 0) {
        out += "⚡ *Immediate Subtasks & Blockers:*\n";
        subtasksAndBugs.forEach(i => {
            out += `${count++}. *[${i.key}]* ${i.summary} (🔵 _${i.issueType}_)\n`;
        });
        out += "\n";
    }

    if (otherTasks.length > 0) {
        out += "📌 *Next Up (Core Tasks):*\n";
        otherTasks.forEach(i => {
            out += `${count++}. *[${i.key}]* ${i.summary}\n`;
        });
        out += "\n";
    }

    if (docs.length > 0) {
        out += "📝 *Documentation & Backlog:*\n";
        docs.forEach(i => {
            out += `${count++}. *[${i.key}]* ${i.summary}\n`;
        });
        out += "\n";
    }

    if (asanaTasks.length > 0) {
        out += "🔴 *Asana Action Items:*\n";
        asanaTasks.forEach(t => {
            const dueStr = t.due_on ? ` (📅 Due: ${t.due_on})` : "";
            const projStr = t.projectName ? ` [${t.projectName}]` : "";
            out += `${count++}. *${t.name}*${dueStr}${projStr}\n`;
        });
        out += "\n";
    }

    if (userTodos.length > 0) {
        out += "📋 *Personal Checklist:*\n";
        userTodos.forEach(t => {
            const name = typeof t === "object" ? t.name : t;
            out += `${count++}. ${name}\n`;
        });
        out += "\n";
    }

    if (userReminders.length > 0) {
        out += "⏰ *Scheduled Reminders:*\n";
        userReminders.forEach(r => {
            out += `${count++}. ${r.name}\n`;
        });
        out += "\n";
    }

    const firstItem = inProgress[0] || subtasksAndBugs[0] || asanaTasks[0] || otherTasks[0];
    if (firstItem) {
        if (firstItem.key) {
            out += `💡 _Recommendation: Focus on finishing *${firstItem.key}* first! Reply "jira done ${firstItem.key}" when complete._`;
        } else if (firstItem.name) {
            out += `💡 _Recommendation: Focus on finishing *${firstItem.name}* first! Reply "asana done 1" when complete._`;
        }
    }

    return out.trim();
}

async function handlePrioritizeTasks(sock, sender, userPrompt, dbUser, session) {
    const jConf = dbUser ? db.getUserIntegration(dbUser.id, "jira") : null;
    const aConf = dbUser ? db.getUserIntegration(dbUser.id, "asana") : null;
    const effJira = getEffectiveJiraConfig(jConf);
    const effAsana = getEffectiveAsanaConfig(aConf);

    let jiraIssues = [];
    if (effJira.isConfigured) {
        try {
            const jRes = await getJiraIssues(jConf, { maxResults: 10 });
            jiraIssues = jRes.issues || [];
            if (jiraIssues.length > 0) {
                lastJiraIssuesBySender.set(sender, jiraIssues);
            }
        } catch (e) {
            console.warn("[Priority] Error fetching Jira tickets:", e.message);
        }
    }

    let asanaTasks = [];
    if (effAsana.isConfigured) {
        try {
            const aRes = await getAsanaTasks(aConf, { maxResults: 10 });
            asanaTasks = (aRes.tasks || []).filter(t => !t.completed);
            if (asanaTasks.length > 0) {
                lastAsanaTasksBySender.set(sender, asanaTasks);
            }
        } catch (e) {
            console.warn("[Priority] Error fetching Asana tasks:", e.message);
        }
    }

    const userTodos = dbUser 
        ? db.getUserTodos(dbUser.id).filter(t => t.status === "pending")
        : (loadTodos()[sender] || []);

    const userReminders = dbUser
        ? db.getUserReminders(dbUser.id).filter(r => r.status === "pending")
        : loadReminders().filter(r => r.sender === sender && r.status === "pending");

    const totalTasks = jiraIssues.length + asanaTasks.length + userTodos.length + userReminders.length;
    if (totalTasks === 0) {
        const emptyMsg = "🎉 *You're all caught up!*\n\nYou have no pending tasks, to-dos, Asana items, or Jira tickets right now.";
        session.history.push({ role: "user", parts: [{ text: userPrompt }] });
        session.history.push({ role: "model", parts: [{ text: emptyMsg }] });
        await sendReply(sock, sender, { text: emptyMsg });
        return;
    }

    // Try Gemini AI for a rich, intelligent prioritization
    if (ai) {
        try {
            const jiraSummary = jiraIssues.map((i, idx) => 
                `- [${i.key}] "${i.summary}" | Status: ${i.status} | Priority: ${i.priority} | Type: ${i.issueType}`
            ).join("\n");

            const asanaSummary = asanaTasks.map((t, idx) => 
                `- Asana #${idx + 1}: "${t.name}"${t.due_on ? ` (Due: ${t.due_on})` : ""}${t.projectName ? ` [Project: ${t.projectName}]` : ""}`
            ).join("\n");

            const todoSummary = userTodos.map(t => 
                `- Checklist: "${typeof t === "object" ? t.name : t}"${typeof t === "object" && t.description ? ` (${t.description})` : ""}`
            ).join("\n");

            const remSummary = userReminders.map(r => 
                `- Scheduled Reminder: "${r.name}" (${formatTimeString(r.target_timestamp || r.targetTimestamp)})`
            ).join("\n");

            const priorityPrompt = `You are Anam, an executive assistant.
The user asked: "${userPrompt}"

User's Active Tasks & Tickets:
${jiraSummary ? `Jira Tickets (${effJira.host}):\n${jiraSummary}\n` : ""}
${asanaSummary ? `Asana Tasks:\n${asanaSummary}\n` : ""}
${todoSummary ? `To-Do Checklist:\n${todoSummary}\n` : ""}
${remSummary ? `Upcoming Reminders:\n${remSummary}\n` : ""}

Task: Analyze and prioritize these items across platforms into an actionable game plan for the user.
Guidelines:
1. Put active/in-progress items first, then blockers/dependencies/subtasks, then core Asana & Jira tasks, then documentation/backlog tasks.
2. Group clearly with emoji headers (e.g. 🔥 *In Progress / Top Priority*, ⚡ *Immediate Next Up*, 🔴 *Asana Action Items*, 📝 *Documentation & Backlog*, etc.).
3. Mention the ticket key [KEY], Asana task name, or checklist item.
4. Give a 1-sentence bottom recommendation on the exact first step to take right now.
5. Keep it punchy, friendly, and structured for WhatsApp texting.`;

            const aiRes = await generateAIContent([{ role: "user", parts: [{ text: priorityPrompt }] }], undefined);
            const prioritizedText = aiRes.text?.trim();
            if (prioritizedText) {
                session.history.push({ role: "user", parts: [{ text: userPrompt }] });
                session.history.push({ role: "model", parts: [{ text: prioritizedText }] });
                await sendReply(sock, sender, { text: prioritizedText });
                return;
            }
        } catch (err) {
            console.warn("[Priority] AI prioritization failover to algorithmic:", err.message);
        }
    }

    // Algorithmic Fallback (deterministic, guaranteed smart ordering)
    const replyText = buildAlgorithmicPriority({ jiraIssues, asanaTasks, userTodos, userReminders, host: effJira.host });
    session.history.push({ role: "user", parts: [{ text: userPrompt }] });
    session.history.push({ role: "model", parts: [{ text: replyText }] });
    await sendReply(sock, sender, { text: replyText });
}

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
            },
            // Jira Tools
            {
                name: "jira_create_issue",
                description: "Create a new issue, task, bug, or story in Atlassian Jira Cloud.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        summary: { type: Type.STRING, description: "Title/summary of the Jira issue" },
                        description: { type: Type.STRING, description: "Detailed description of the issue" },
                        project_key: { type: Type.STRING, description: "Jira project key e.g. PROJ, DEV, BUG (optional if default project is configured)" },
                        issue_type: { type: Type.STRING, description: "Type of issue: Task, Bug, Story (default: Task)" }
                    },
                    required: ["summary"]
                }
            },
            {
                name: "jira_get_issues",
                description: "Search or retrieve Jira tickets and issues assigned to the user or in a project.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        jql: { type: Type.STRING, description: "Optional JQL query string. Defaults to active user tickets" },
                        max_results: { type: Type.NUMBER, description: "Maximum number of tickets to return (default: 5)" }
                    }
                }
            },
            {
                name: "jira_transition_issue",
                description: "Change the status or move a Jira issue (e.g. mark as Done, In Progress, Closed).",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        issue_key: { type: Type.STRING, description: "The Jira issue key, e.g. PROJ-123" },
                        target_status: { type: Type.STRING, description: "Desired status: 'Done', 'In Progress', 'Closed', etc." }
                    },
                    required: ["issue_key", "target_status"]
                }
            },
            {
                name: "jira_add_comment",
                description: "Add a comment to an existing Jira issue.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        issue_key: { type: Type.STRING, description: "The Jira issue key, e.g. PROJ-123" },
                        comment: { type: Type.STRING, description: "The comment text to post" }
                    },
                    required: ["issue_key", "comment"]
                }
            },
            // Google Calendar Tools
            {
                name: "calendar_list_events",
                description: "List scheduled meetings and events from Google Calendar for today, tomorrow, or this week.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        time_frame: { type: Type.STRING, description: "Time period to inspect: 'today', 'tomorrow', 'this_week', or 'upcoming'" },
                        max_results: { type: Type.NUMBER, description: "Maximum number of events to show (default: 10)" }
                    }
                }
            },
            {
                name: "calendar_create_event",
                description: "Schedule and create a new meeting or event on Google Calendar, with automatic Google Meet video call link generation.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        title: { type: Type.STRING, description: "Event title or meeting subject" },
                        start_time: { type: Type.STRING, description: "Start time/date in ISO format or relative (e.g. 'tomorrow at 3pm', '2026-10-16T15:00:00')" },
                        duration_minutes: { type: Type.NUMBER, description: "Duration in minutes (default: 30)" },
                        description: { type: Type.STRING, description: "Optional event description or agenda" },
                        location: { type: Type.STRING, description: "Optional location or custom link" },
                        add_meet: { type: Type.BOOLEAN, description: "Whether to generate a Google Meet video conference link (default: true for meetings)" }
                    },
                    required: ["title"]
                }
            },
            {
                name: "create_instant_meet",
                description: "Generate an instant Google Meet video call link right now for immediate joining and syncing to Google Calendar.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        topic: { type: Type.STRING, description: "Optional topic or reason for the Google Meet (default: 'Instant Google Meet')" }
                    }
                }
            },
            {
                name: "calendar_delete_event",
                description: "Cancel or delete an event from Google Calendar by title search or ID.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        search_title: { type: Type.STRING, description: "Title or keyword of the event to delete" },
                        event_id: { type: Type.STRING, description: "Optional specific Google Calendar event ID" }
                    }
                }
            },
            // Asana AI Tools
            {
                name: "asana_get_tasks",
                description: "List tasks from Asana (assigned to the user or in a specific project).",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        project_id: { type: Type.STRING, description: "Optional project GID or project name to filter by" },
                        completed: { type: Type.BOOLEAN, description: "Filter by completed status: false for pending (default), true for completed" },
                        max_results: { type: Type.NUMBER, description: "Maximum number of tasks to return (default: 10)" }
                    }
                }
            },
            {
                name: "asana_create_task",
                description: "Create a new task in Asana with optional notes, due date, and project.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        name: { type: Type.STRING, description: "Title/name of the Asana task" },
                        notes: { type: Type.STRING, description: "Detailed description or notes for the task" },
                        due_on: { type: Type.STRING, description: "Due date in YYYY-MM-DD format (e.g. 2026-10-25) or relative (e.g. tomorrow)" },
                        project_id: { type: Type.STRING, description: "Optional project GID or name" }
                    },
                    required: ["name"]
                }
            },
            {
                name: "asana_complete_task",
                description: "Mark an Asana task as completed (by task GID, name, or index number).",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        task_id: { type: Type.STRING, description: "The Asana task GID or index number (e.g. 1)" }
                    },
                    required: ["task_id"]
                }
            },
            {
                name: "asana_add_comment",
                description: "Add a comment/story to an existing Asana task.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        task_id: { type: Type.STRING, description: "The Asana task GID or index number" },
                        comment: { type: Type.STRING, description: "The comment text to post" }
                    },
                    required: ["task_id", "comment"]
                }
            },
            {
                name: "asana_update_task",
                description: "Update an existing Asana task (e.g. change title, notes/description, due date, or mark completed).",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        task_id: { type: Type.STRING, description: "The Asana task index number (e.g. 1), name, or GID" },
                        title: { type: Type.STRING, description: "New title/name for the task" },
                        notes: { type: Type.STRING, description: "New notes or description for the task" },
                        due_on: { type: Type.STRING, description: "New due date in YYYY-MM-DD format (e.g. 2026-10-25)" },
                        completed: { type: Type.BOOLEAN, description: "True to mark completed, false to reopen" }
                    },
                    required: ["task_id"]
                }
            },
            {
                name: "asana_create_project",
                description: "Create a new project in Asana so it appears on the user's Asana dashboard.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        name: { type: Type.STRING, description: "Name of the new Asana project" },
                        notes: { type: Type.STRING, description: "Optional project description or goal" },
                        color: { type: Type.STRING, description: "Optional project color (e.g. 'light-blue', 'light-green', 'light-red')" }
                    },
                    required: ["name"]
                }
            },
            {
                name: "email_draft",
                description: "Draft an email to a recipient with a subject line and professional message body, and save it as a draft for user review.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        to: { type: Type.STRING, description: "Recipient email address (e.g. client@example.com)" },
                        subject: { type: Type.STRING, description: "Subject of the email" },
                        body: { type: Type.STRING, description: "Body text / message content of the email" }
                    },
                    required: ["to", "subject", "body"]
                }
            },
            {
                name: "email_send",
                description: "Send an email immediately (or send an existing draft by its ID) via Gmail.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        draft_id: { type: Type.INTEGER, description: "Optional ID number of existing draft to send (e.g. 1)" },
                        to: { type: Type.STRING, description: "Recipient email address if sending directly" },
                        subject: { type: Type.STRING, description: "Subject of the email if sending directly" },
                        body: { type: Type.STRING, description: "Body text of the email if sending directly" }
                    }
                }
            },
            {
                name: "email_list_drafts",
                description: "List all saved pending email drafts.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {}
                }
            },
            // Google Drive Tools
            {
                name: "drive_list_files",
                description: "List recent files and folders stored in Google Drive.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        folder_id: { type: Type.STRING, description: "Optional folder ID to inspect files within" },
                        max_results: { type: Type.NUMBER, description: "Maximum number of files to return (default: 10)" }
                    }
                }
            },
            {
                name: "drive_search_files",
                description: "Search for files, PDFs, spreadsheets, documents, or presentations on Google Drive by name or keyword.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        query: { type: Type.STRING, description: "Search term, document name, or topic to search on Google Drive" },
                        max_results: { type: Type.NUMBER, description: "Maximum number of results to return (default: 10)" }
                    },
                    required: ["query"]
                }
            },
            {
                name: "drive_create_folder",
                description: "Create a new folder in Google Drive.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        folder_name: { type: Type.STRING, description: "Name of the new folder to create" }
                    },
                    required: ["folder_name"]
                }
            },
            {
                name: "drive_share_file",
                description: "Get a shareable link for a file or share it on Google Drive.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        file_id: { type: Type.STRING, description: "ID of the Google Drive file" },
                        search_name: { type: Type.STRING, description: "Name or keyword of the file to share if ID is unknown" }
                    }
                }
            },
            {
                name: "drive_delete_file",
                description: "Delete or move a Google Drive file to trash.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        file_id: { type: Type.STRING, description: "ID of the file to delete" },
                        search_name: { type: Type.STRING, description: "Name of the file to delete if ID is unknown" }
                    }
                }
            },
            {
                name: "drive_upload_text",
                description: "Save, create, or upload a text note or document into Google Drive.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        file_name: { type: Type.STRING, description: "Name of the file (e.g. notes.txt or meeting_notes.txt)" },
                        content: { type: Type.STRING, description: "Text content to save into the file" }
                    },
                    required: ["file_name", "content"]
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

    // Do NOT intercept Asana, Jira, Project, or Email commands
    if (/\b(?:asana|jira|project|email|mail|draft)\b/i.test(raw)) {
        return null;
    }

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

    // Direct platform commands, email drafting/sending, or queries should NEVER be parsed as reminders
    if (/^\s*(?:!|jira\b|calendar\b|asana\b|email\b|gmail\b|mail\b|draft\b|integrations?\b)/i.test(raw)) {
        return null;
    }

    // Any message mentioning email/draft/send along with an email address should NEVER be a reminder
    if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(raw) && /\b(?:draft|send|email|mail|write|compose)\b/i.test(raw)) {
        return null;
    }

    const isReminderKeyword = /\b(remind|reminder)\b/i.test(raw);
    const hasRelativeTime = /\bin\s+\d+\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i.test(raw);
    const hasTomorrow = /\btomorrow\b/i.test(raw);

    // Precise Clock Time detection:
    // Requires: 'at <time>', '<time> am/pm', 'HH:MM', or tomorrow with time, or reminder keyword with hour
    const hasExplicitAtTime = /\bat\s+[0-2]?[0-9](?::[0-5][0-9])?\s*(?:am|pm)?\b/i.test(raw);
    const hasAmPm = /\b[0-2]?[0-9](?::[0-5][0-9])?\s*(?:am|pm)\b/i.test(raw);
    const hasColonTime = /\b[0-2]?[0-9]:[0-5][0-9]\b/i.test(raw);
    const hasTomorrowTime = /\btomorrow(?:\s+at)?\s+[0-2]?[0-9](?::[0-5][0-9])?\s*(?:am|pm)?\b/i.test(raw);
    const hasReminderHour = isReminderKeyword && /\b(?:at\s+|for\s+)?([0-2]?[0-9](?::[0-5][0-9])?\s*(?:am|pm)?)\b/i.test(raw);

    const hasClockTime = hasExplicitAtTime || hasAmPm || hasColonTime || hasTomorrowTime || hasReminderHour;

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

    // 3. Clock Time: requires explicit 'at', 'am/pm', ':', or reminder keyword
    if (!targetTimestamp && hasClockTime) {
        let clockMatchStr = null;
        let timeStr = null;

        const atMatch = workText.match(/\bat\s+([0-2]?[0-9](?::[0-5][0-9])?\s*(?:am|pm)?)\b/i);
        const ampmMatch = workText.match(/\b([0-2]?[0-9](?::[0-5][0-9])?\s*(?:am|pm))\b/i);
        const colonMatch = workText.match(/\b([0-2]?[0-9]:[0-5][0-9])\b/i);
        const reminderHourMatch = isReminderKeyword ? workText.match(/\b(?:at\s+|for\s+)?([0-2]?[0-9])\b/i) : null;

        if (atMatch) {
            clockMatchStr = atMatch[0];
            timeStr = atMatch[1];
        } else if (ampmMatch) {
            clockMatchStr = ampmMatch[0];
            timeStr = ampmMatch[1];
        } else if (colonMatch) {
            clockMatchStr = colonMatch[0];
            timeStr = colonMatch[1];
        } else if (reminderHourMatch) {
            clockMatchStr = reminderHourMatch[0];
            timeStr = reminderHourMatch[1];
        }

        if (clockMatchStr && timeStr) {
            const parsed = parseClockTime(timeStr);
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
                workText = workText.replace(clockMatchStr, "").trim();
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

async function createAndSaveReminder(sock, sender, parsedCmd, dbUserId = null) {
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

    let confirmMsg = templates[Math.floor(Math.random() * templates.length)];

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

    // Auto-sync with Google Calendar if configured
    let calSynced = false;
    let calMeetLink = null;
    try {
        let calUserId = dbUserId;
        if (!calUserId) {
            const matchedUser = db.getUserByWhatsAppJid(sender);
            if (matchedUser) calUserId = matchedUser.id;
        }

        const calConfig = calUserId ? db.getUserIntegration(calUserId, "google_calendar") : null;
        const effCal = getEffectiveCalendarConfig(calConfig);
        if (effCal.isConfigured) {
            const eventStart = new Date(targetTimestamp);
            const eventEnd = new Date(targetTimestamp + 30 * 60 * 1000);
            const evDesc = description 
                ? `${description}\n\n[Created via Anam AI WhatsApp Bot]`
                : `Reminder created via Anam AI WhatsApp Bot`;

            const isMeeting = /\b(meet|meeting|call|gmeet|g-meet|sync|discussion|1:1|interview)\b/i.test(displayName + " " + (description || ""));

            const calEvent = await createCalendarEvent(calConfig, {
                summary: `⏰ ${displayName}`,
                description: evDesc,
                startDateTime: eventStart.toISOString(),
                endDateTime: eventEnd.toISOString(),
                durationMinutes: 30,
                addMeet: isMeeting
            });
            if (calEvent && calEvent.id) {
                calSynced = true;
                if (calEvent.meetLink) {
                    calMeetLink = calEvent.meetLink;
                }
                console.log(`[Google Calendar] Auto-synced reminder "${displayName}" to Google Calendar (ID: ${calEvent.id})`);
            }
        }
    } catch (calErr) {
        console.warn(`[Google Calendar Auto-Sync Notice]:`, calErr.message);
    }

    if (calSynced) {
        confirmMsg += `\n📅 *Synced with Google Calendar!*`;
        if (calMeetLink) {
            confirmMsg += `\n💻 *Google Meet:* ${calMeetLink}`;
        }
    }

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
        const documentMsg = m?.documentMessage;
        const rawText = (m?.conversation || m?.extendedTextMessage?.text || "").trim();
        const caption = ((imageMsg || videoMsg || documentMsg)?.caption || documentMsg?.fileName || "").trim();
        const fullContent = rawText || caption;

        if (!fullContent && !imageMsg && !videoMsg && !documentMsg) return;

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

        // Check for direct commands: reminders, tasks, todos, media, integrations, or wake words
        const isDirectReminder = Boolean(parseFreeFormReminder(fullContent));
        const isAddTask = Boolean(parseTaskCommand(fullContent));
        const isShowTasks = /^\s*(?:show\s+(?:my\s+)?tasks|my\s+tasks|tasks|todos|my\s+todo\s+list)\s*$/i.test(fullContent);
        const isDoneTask = /^\s*(?:done|complete|check\s+off)\s+(\d+)\s*$/i.test(fullContent);
        const isIntegrationCmd = /^\s*(?:hey\s+anam[,:\s]*)?(?:!integrations?|integrations?|jira\b|calendar\b|asana\b|drive\b|google\s+drive\b|my\s+tickets|my\s+schedule|my\s+meetings|my\s+asana|my\s+drive|my\s+files)/i.test(fullContent);

        if (isGroup) {
            // Group Chat Rule: MUST start with "Hey Anam" OR be an active response to a pending prompt
            if (!isWakeWord && !isPendingResponse) {
                return;
            }
        } else {
            // Direct/Private Chat Rule: Activate session on wake word, direct reminder, direct tasks, media, integrations, or self-chat
            if (isWakeWord || isDirectReminder || isAddTask || isShowTasks || isDoneTask || isIntegrationCmd || imageMsg || videoMsg || documentMsg || isSelfChat) {
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

        // 1. Check for Media Message (Image, Video, or Document)
        if (imageMsg || videoMsg || documentMsg) {
            const isImage = !!imageMsg;
            const isDoc = !!documentMsg;
            const mediaType = isImage ? "image" : (isDoc ? "document" : "video");

            // Download Media Buffer
            let buffer;
            try {
                buffer = await downloadMediaMessage(msg, "buffer", {});
            } catch (err) {
                console.error("Failed to download media:", err.message);
                return;
            }

            // Max file size limit check (25 MB for Google Drive)
            const MAX_SIZE = 25 * 1024 * 1024;
            if (buffer.length > MAX_SIZE) {
                await sendReply(sock, sender, { text: "This file is too large (over 25 MB). Please send a smaller file." });
                return;
            }

            // Check if user requested to upload to Google Drive
            const isDriveUpload = /(?:save\s+(?:it\s+)?to\s+drive|upload\s+(?:it\s+)?to\s+drive|to\s+drive|drive\s+upload|\bdrive\b|google\s+drive)/i.test(cleanCaption || userPrompt);
            if (isDriveUpload) {
                const dConf = dbUser ? db.getUserIntegration(dbUser.id, "google_drive") : null;
                const effDrive = getEffectiveDriveConfig(dConf);

                if (!effDrive.isConfigured) {
                    await sendReply(sock, sender, {
                        text: `⚠️ *Google Drive is not connected yet.*\n\nPlease connect your Google Drive in your web dashboard at http://localhost:3000 -> Integrations tab.`
                    });
                    return;
                }

                try {
                    const ext = isImage ? "jpg" : (isDoc ? (documentMsg?.fileName?.split(".").pop() || "pdf") : "mp4");

                    // Check if caption asked to create or use a specific folder, e.g. "Create a drive folder Anam upload this media" or "in folder Anam"
                    let folderToUse = null;
                    const folderMatch = (cleanCaption || "").match(/(?:(?:create\s+(?:a\s+)?drive\s+folder|create\s+folder|save\s+(?:to|in)\s+folder|in\s+folder|folder)\s+([a-zA-Z0-9_\-]+))/i);
                    const requestedFolderName = folderMatch ? folderMatch[1].trim() : null;

                    if (requestedFolderName && !/^(?:a|the|drive|this|my|to|it)$/i.test(requestedFolderName)) {
                        try {
                            console.log(`[GoogleDrive] User requested folder: "${requestedFolderName}". Creating or ensuring folder...`);
                            const newFolder = await createDriveFolder(dConf, { folderName: requestedFolderName });
                            if (newFolder && newFolder.id) {
                                folderToUse = newFolder.id;
                            }
                        } catch (fErr) {
                            console.warn("[GoogleDrive] Could not create requested subfolder, uploading to root/shared folder instead:", fErr.message);
                        }
                    }

                    // Compute clean, descriptive file name
                    let fileName = documentMsg?.fileName;
                    if (!fileName) {
                        const isInstructionOnly = /^(?:save\s+(?:it\s+)?to\s+drive|upload\s+(?:it\s+)?to\s+drive|to\s+drive|drive\s+upload|create\s+a?\s*drive\s+folder.*)$/i.test(cleanCaption || "");
                        if (isInstructionOnly || !cleanCaption) {
                            const dateStr = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
                            fileName = `WhatsApp_${isImage ? "Photo" : (isDoc ? "Doc" : "Video")}_${dateStr}.${ext}`;
                        } else {
                            const baseClean = cleanCaption.replace(/[^a-zA-Z0-9_\-\s]/g, "").trim().replace(/\s+/g, "_");
                            fileName = `${baseClean.substring(0, 35)}.${ext}`;
                        }
                    }
                    const mimeType = documentMsg?.mimetype || (isImage ? "image/jpeg" : (isDoc ? "application/pdf" : "video/mp4"));

                    const uploaded = await uploadDriveFile(dConf, {
                        fileName,
                        mimeType,
                        buffer,
                        folderId: folderToUse
                    });

                    const replyText = formatUploadedFileForWhatsApp(uploaded);
                    session.history.push({ role: "model", parts: [{ text: replyText }] });
                    await sendReply(sock, sender, { text: replyText });
                    return;
                } catch (uploadErr) {
                    const formattedErr = formatDriveApiError(uploadErr, effDrive);
                    await sendReply(sock, sender, { text: `❌ Could not upload file to Google Drive:\n\n${formattedErr}` });
                    return;
                }
            }

            // Save file persistently to disk for reminders
            const ext = isImage ? "jpg" : (isDoc ? (documentMsg?.fileName?.split(".").pop() || "pdf") : "mp4");
            const mediaId = "media_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5);
            const mediaPath = path.join(MEDIA_DIR, `${mediaId}.${ext}`);
            fs.writeFileSync(mediaPath, buffer);

            if (cleanCaption) {
                // Way 1: Media with caption
                const parsedCmd = parseFreeFormReminder(cleanCaption);
                if (parsedCmd && parsedCmd.targetTimestamp) {
                    parsedCmd.mediaPath = mediaPath;
                    parsedCmd.mediaType = mediaType;
                    const confirmMsg = await createAndSaveReminder(sock, sender, parsedCmd, dbUser ? dbUser.id : null);
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

        // ---------------- DIRECT PLATFORM INTEGRATION COMMANDS ----------------

        // 1. !integrations / integrations
        if (/^\s*(?:!integrations?|integrations?)\s*$/i.test(userPrompt)) {
            const jConf = dbUser ? db.getUserIntegration(dbUser.id, "jira") : null;
            const cConf = dbUser ? db.getUserIntegration(dbUser.id, "google_calendar") : null;
            const aConf = dbUser ? db.getUserIntegration(dbUser.id, "asana") : null;
            const effJira = getEffectiveJiraConfig(jConf);
            const effCal = getEffectiveCalendarConfig(cConf);
            const effAsana = getEffectiveAsanaConfig(aConf);

            const intMsg = `🔌 *Connected Platforms & Integrations*\n\n` +
                `• *Jira Cloud*: ${effJira.isConfigured ? `🟢 Connected (${effJira.host})` : `⚪ Not Connected`}\n` +
                `• *Google Calendar*: ${effCal.isConfigured ? `🟢 Connected (${effCal.calendarId})` : `⚪ Not Connected`}\n` +
                `• *Asana AI*: ${effAsana.isConfigured ? `🟢 Connected${effAsana.userName ? ` (${effAsana.userName})` : ""}${effAsana.defaultProjectName ? ` [${effAsana.defaultProjectName}]` : ""}` : `⚪ Not Connected`}\n` +
                `• *WhatsApp Bot*: 🟢 Connected & Active\n` +
                `• *Web Dashboard*: 🌐 http://localhost:3000\n\n` +
                `${!effJira.isConfigured || !effCal.isConfigured || !effAsana.isConfigured
                    ? `_To connect Jira, Calendar, or Asana, visit your dashboard at http://localhost:3000 -> Integrations tab._`
                    : `_Everything is connected! You can create tasks in Jira/Asana, manage schedules, and track to-dos directly here._`}`;

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: intMsg }] });
            await sendReply(sock, sender, { text: intMsg });
            return;
        }

        // ---------------- TASK PRIORITIZATION COMMAND ----------------
        // e.g. "prioritize tasks", "Hey Anam priorities the tasks", "what should I prioritize", "rank the tasks"
        const prioritizeRegex = /^\s*(?:hey\s+anam[,:\s]*)?(?:priorit[a-z]*|rank)\s+(?:the\s+|my\s+)?(?:tasks?|todos?|tickets?|checklist|issues?)?\b/i;
        const whatToPrioritizeRegex = /^\s*(?:hey\s+anam[,:\s]*)?what\s+(?:tasks?\s+)?should\s+i\s+(?:prioritize|do\s+first|focus\s+on)\b/i;

        if (prioritizeRegex.test(userPrompt) || whatToPrioritizeRegex.test(userPrompt)) {
            await handlePrioritizeTasks(sock, sender, userPrompt, dbUser, session);
            return;
        }

        // ---------------- DIRECT JIRA COMMANDS ----------------

        // 2a. Direct Jira List: "jira list", "my tickets", "!jira", "jira tickets", "jira issues"
        const jiraListRegex = /^\s*(?:!jira|jira\s+(?:list|tickets|issues)|my\s+(?:jira\s+)?tickets)\s*$/i;
        if (jiraListRegex.test(userPrompt)) {
            const jConf = dbUser ? db.getUserIntegration(dbUser.id, "jira") : null;
            const effJira = getEffectiveJiraConfig(jConf);

            let resText = "";
            if (!effJira.isConfigured) {
                resText = `⚠️ *Jira is not connected yet.*\n\nPlease add your Jira domain, email, and API token in your web dashboard at http://localhost:3000 -> Integrations tab.`;
            } else {
                try {
                    const issuesRes = await getJiraIssues(jConf, { maxResults: 5 });
                    if (issuesRes.issues) {
                        lastJiraIssuesBySender.set(sender, issuesRes.issues);
                    }
                    resText = formatIssuesForWhatsApp(issuesRes);
                } catch (err) {
                    resText = `❌ Error retrieving Jira issues: ${err.message}`;
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 2b. Direct Jira Close/Done: "jira close KAN-1", "jira done KAN-1", "jira done KAN 1", "jira done 1"
        const jiraDoneRegex = /^\s*jira\s+(?:done|close|finish)\s+([A-Za-z0-9]+(?:[\s\-]\d+)?|\d+)\s*$/i;
        const jiraDoneMatch = userPrompt.match(jiraDoneRegex);
        if (jiraDoneMatch) {
            const jConf = dbUser ? db.getUserIntegration(dbUser.id, "jira") : null;
            const effJira = getEffectiveJiraConfig(jConf);

            let resText = "";
            if (!effJira.isConfigured) {
                resText = `⚠️ *Jira is not connected yet.* Connect it on your web dashboard at http://localhost:3000`;
            } else {
                const rawTarget = jiraDoneMatch[1];
                const issueKey = resolveJiraIssueKey(sender, rawTarget, effJira.defaultProject);

                if (!issueKey) {
                    resText = `⚠️ Could not find Jira ticket '${rawTarget}'. Please specify a valid key (e.g. "jira done KAN-1" or "jira done 1").`;
                } else {
                    try {
                        const transRes = await transitionJiraIssue(jConf, { issueKey, transitionName: "Done" });
                        resText = formatTransitionForWhatsApp(transRes);
                    } catch (err) {
                        resText = `❌ Could not close ticket ${issueKey}: ${err.message}`;
                    }
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 2c. Direct Jira Comment: "jira comment KAN-1 fix applied", "jira comment KAN 1 update"
        const jiraCommentRegex = /^\s*jira\s+comment\s+([A-Za-z0-9]+(?:[\s\-]\d+)?|\d+)\s+(.+)$/i;
        const jiraCommentMatch = userPrompt.match(jiraCommentRegex);
        if (jiraCommentMatch) {
            const jConf = dbUser ? db.getUserIntegration(dbUser.id, "jira") : null;
            const effJira = getEffectiveJiraConfig(jConf);

            let resText = "";
            if (!effJira.isConfigured) {
                resText = `⚠️ *Jira is not connected yet.* Connect it on your web dashboard at http://localhost:3000`;
            } else {
                const rawTarget = jiraCommentMatch[1];
                const commentText = jiraCommentMatch[2].trim();
                const issueKey = resolveJiraIssueKey(sender, rawTarget, effJira.defaultProject);

                if (!issueKey) {
                    resText = `⚠️ Could not find Jira ticket '${rawTarget}'. Please specify e.g. "jira comment KAN-1 note".`;
                } else {
                    try {
                        await addJiraComment(jConf, { issueKey, comment: commentText });
                        resText = `💬 Comment added to Jira ticket *${issueKey}*!`;
                    } catch (err) {
                        resText = `❌ Could not add Jira comment: ${err.message}`;
                    }
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 2d. Direct Jira Create: "jira create Fix login button" or "jira add Task summary"
        const jiraCreateRegex = /^\s*jira\s+(?:create|add|new)\s+(.+)$/i;
        const jiraCreateMatch = userPrompt.match(jiraCreateRegex);
        if (jiraCreateMatch) {
            const rawIssueSummary = jiraCreateMatch[1].trim();
            const jConf = dbUser ? db.getUserIntegration(dbUser.id, "jira") : null;
            const effJira = getEffectiveJiraConfig(jConf);

            let resText = "";
            if (!effJira.isConfigured) {
                resText = `⚠️ *Jira is not connected yet.* Connect your account in the web dashboard at http://localhost:3000 -> Integrations tab!`;
            } else {
                try {
                    const created = await createJiraIssue(jConf, {
                        summary: rawIssueSummary,
                        projectKey: effJira.defaultProject || ""
                    });
                    resText = formatCreatedIssueForWhatsApp(created);
                } catch (err) {
                    resText = `❌ Could not create Jira issue: ${err.message}`;
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 2e. Direct Jira Ticket View: "jira KAN 1", "jira KAN-1", "jira 1", "jira view KAN-1", "jira ticket KAN-1"
        const jiraViewRegex = /^\s*(?:!jira\s+|jira\s+(?:view\s+|get\s+|show\s+|ticket\s+|details\s+)?|view\s+jira\s+|ticket\s+)([A-Za-z0-9]+(?:[\s\-]\d+)?|\d+)\s*$/i;
        const bareIssueRegex = /^\s*([A-Za-z]+-\d+)\s*$/i;

        const isJiraView = jiraViewRegex.test(userPrompt) && !/^\s*jira\s+(?:help|list|tickets?|issues?|create|add|new|done|close|finish|comment)\b/i.test(userPrompt);
        const isBareKey = bareIssueRegex.test(userPrompt);

        if (isJiraView || isBareKey) {
            const jConf = dbUser ? db.getUserIntegration(dbUser.id, "jira") : null;
            const effJira = getEffectiveJiraConfig(jConf);

            let resText = "";
            if (!effJira.isConfigured) {
                resText = `⚠️ *Jira is not connected yet.* Connect it on your web dashboard at http://localhost:3000`;
            } else {
                const rawTarget = isBareKey ? userPrompt.match(bareIssueRegex)[1] : userPrompt.match(jiraViewRegex)[1];
                const issueKey = resolveJiraIssueKey(sender, rawTarget, effJira.defaultProject);

                if (!issueKey) {
                    resText = `⚠️ Could not identify Jira ticket '${rawTarget}'. Try "jira list" to view available tickets.`;
                } else {
                    try {
                        const issue = await getJiraIssue(jConf, issueKey);
                        resText = formatSingleIssueForWhatsApp(issue);
                    } catch (err) {
                        resText = `❌ Could not load Jira ticket ${issueKey}: ${err.message}`;
                    }
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 2f. Direct Jira Help: "jira help" or bare "jira"
        if (/^\s*(?:!jira|jira(?:\s+help)?)\s*$/i.test(userPrompt)) {
            const helpText = `📋 *Jira Commands Guide:*\n\n` +
                `• *jira list* - View recent tickets\n` +
                `• *jira <KEY>* (e.g. _jira KAN-1_ or _jira 1_) - View ticket details\n` +
                `• *jira add <summary>* - Create a new task\n` +
                `• *jira done <KEY>* (e.g. _jira done KAN-1_) - Mark ticket as Done\n` +
                `• *jira comment <KEY> <note>* - Add a comment\n` +
                `• *prioritize tasks* - Get smart, prioritized plan of all your tasks`;

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: helpText }] });
            await sendReply(sock, sender, { text: helpText });
            return;
        }

        // ---------------- DIRECT ASANA COMMANDS ----------------

        // 2g-proj. Direct Asana Create Project:
        // "asana add project <name>", "asana create project <name>", "add a new project in asana: <name>", "create project <name> in asana"
        const asanaCreateProjRegex = /^\s*(?:asana\s+(?:create|add|new)\s+project\s+|add\s+(?:a\s+)?(?:new\s+)?project\s+in\s+asana\s*[:\-]?\s*|create\s+(?:a\s+)?(?:new\s+)?project\s+in\s+asana\s*[:\-]?\s*)(.+)$/i;
        const asanaCreateProjMatch = userPrompt.match(asanaCreateProjRegex);
        const asanaCreateProjPromptOnlyRegex = /^\s*(?:asana\s+(?:create|add|new)\s+project|add\s+(?:a\s+)?(?:new\s+)?project\s+in\s+asana|create\s+(?:a\s+)?project\s+in\s+asana)\s*$/i;

        if (asanaCreateProjMatch || asanaCreateProjPromptOnlyRegex.test(userPrompt)) {
            const aConf = dbUser ? db.getUserIntegration(dbUser.id, "asana") : null;
            const effAsana = getEffectiveAsanaConfig(aConf);

            let resText = "";
            if (!effAsana.isConfigured) {
                resText = `⚠️ *Asana is not connected yet.* Please add your Asana Personal Access Token in your web dashboard at http://localhost:3000 -> Integrations tab!`;
            } else if (asanaCreateProjPromptOnlyRegex.test(userPrompt)) {
                resText = `📁 *Create New Asana Project:*\n\n` +
                          `Please tell me the name of the project you want to create! For example:\n` +
                          `• *asana add project Marketing Campaign*\n` +
                          `• *asana create project Website Redesign*`;
            } else {
                const projectName = asanaCreateProjMatch[1].trim().replace(/[.!?:;]+$/, "");
                try {
                    const project = await createAsanaProject(aConf, { name: projectName });
                    resText = formatCreatedAsanaProjectForWhatsApp(project);
                } catch (err) {
                    resText = `❌ Could not create Asana project: ${err.message}`;
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 2g. Direct Asana List: "asana list", "asana tasks", "!asana", "my asana tasks"
        const asanaListRegex = /^\s*(?:!asana|asana\s+(?:list|tasks?)|my\s+asana(?:\s+tasks?)?)\s*$/i;
        if (asanaListRegex.test(userPrompt)) {
            const aConf = dbUser ? db.getUserIntegration(dbUser.id, "asana") : null;
            const effAsana = getEffectiveAsanaConfig(aConf);

            let resText = "";
            if (!effAsana.isConfigured) {
                resText = `⚠️ *Asana is not connected yet.*\n\nPlease add your Personal Access Token in your web dashboard at http://localhost:3000 -> Integrations tab.`;
            } else {
                try {
                    const tasksRes = await getAsanaTasks(aConf, { maxResults: 15 });
                    if (tasksRes.tasks) {
                        lastAsanaTasksBySender.set(sender, tasksRes.tasks);
                    }
                    resText = formatAsanaTasksForWhatsApp(tasksRes);
                } catch (err) {
                    resText = `❌ Error retrieving Asana tasks: ${err.message}`;
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 2h. Direct Asana Complete/Done: "asana done 1", "asana done Schedule dentist appointment.", "asana complete 2"
        const asanaDoneRegex = /^\s*asana\s+(?:done|close|finish|complete)\s+(.+)$/i;
        const asanaDoneMatch = userPrompt.match(asanaDoneRegex);
        if (asanaDoneMatch) {
            const aConf = dbUser ? db.getUserIntegration(dbUser.id, "asana") : null;
            const effAsana = getEffectiveAsanaConfig(aConf);

            let resText = "";
            if (!effAsana.isConfigured) {
                resText = `⚠️ *Asana is not connected yet.* Connect it on your web dashboard at http://localhost:3000`;
            } else {
                const rawTarget = asanaDoneMatch[1].trim();
                const task = await findOrResolveAsanaTask(aConf, sender, rawTarget);

                if (!task || !task.gid) {
                    resText = `⚠️ Could not find Asana task '${rawTarget}'. Try "asana list" first to see item numbers or full titles.`;
                } else {
                    try {
                        const doneRes = await completeAsanaTask(aConf, task.gid);
                        doneRes.name = task.name || doneRes.name;
                        resText = formatCompletedAsanaTaskForWhatsApp(doneRes);
                    } catch (err) {
                        resText = `❌ Could not complete Asana task: ${err.message}`;
                    }
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 2h-upd. Direct Asana Update:
        // "asana update 1 rename Buy organic vegetables", "asana rename 1 Pay electricity", "asana update 1 due 2026-10-25"
        const asanaUpdateRegex = /^\s*asana\s+(?:update\s+(\S+)\s+(rename|title|due|date|notes?|desc(?:ription)?|done|complete)\s+(.+)|(?:rename|due|notes?)\s+(\S+)\s+(.+))\s*$/i;
        const asanaUpdateMatch = userPrompt.match(asanaUpdateRegex);
        if (asanaUpdateMatch) {
            const aConf = dbUser ? db.getUserIntegration(dbUser.id, "asana") : null;
            const effAsana = getEffectiveAsanaConfig(aConf);

            let resText = "";
            if (!effAsana.isConfigured) {
                resText = `⚠️ *Asana is not connected yet.* Connect it on your web dashboard at http://localhost:3000`;
            } else {
                let rawTarget = "";
                let action = "";
                let val = "";

                if (asanaUpdateMatch[1]) {
                    rawTarget = asanaUpdateMatch[1];
                    action = asanaUpdateMatch[2].toLowerCase();
                    val = asanaUpdateMatch[3].trim();
                } else {
                    const fullCmd = userPrompt.trim();
                    if (/^\s*asana\s+rename\s+/i.test(fullCmd)) {
                        action = "rename";
                    } else if (/^\s*asana\s+due\s+/i.test(fullCmd)) {
                        action = "due";
                    } else {
                        action = "notes";
                    }
                    rawTarget = asanaUpdateMatch[4];
                    val = asanaUpdateMatch[5].trim();
                }

                const task = await findOrResolveAsanaTask(aConf, sender, rawTarget);
                if (!task || !task.gid) {
                    resText = `⚠️ Could not find Asana task '${rawTarget}'. Try "asana list" to view task numbers.`;
                } else {
                    try {
                        const updates = {};
                        let changeSummary = "";
                        if (action === "rename" || action === "title") {
                            updates.name = val;
                            changeSummary = `Title changed to "${val}"`;
                        } else if (action === "due" || action === "date") {
                            let dueDateStr = val;
                            if (val.toLowerCase() === "tomorrow") {
                                const tom = new Date();
                                tom.setDate(tom.getDate() + 1);
                                dueDateStr = tom.toISOString().split("T")[0];
                            } else if (val.toLowerCase() === "today") {
                                dueDateStr = new Date().toISOString().split("T")[0];
                            }
                            updates.dueOn = dueDateStr;
                            changeSummary = `Due date set to ${dueDateStr}`;
                        } else if (action === "done" || action === "complete") {
                            updates.completed = true;
                            changeSummary = `Marked as completed`;
                        } else {
                            updates.notes = val;
                            changeSummary = `Notes updated`;
                        }

                        const updated = await updateAsanaTask(aConf, task.gid, updates);
                        resText = formatUpdatedAsanaTaskForWhatsApp(updated, changeSummary);
                    } catch (err) {
                        resText = `❌ Could not update Asana task: ${err.message}`;
                    }
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 2i. Direct Asana Add: "asana add Buy groceries", "asana create Prepare slides"
        const asanaCreateRegex = /^\s*asana\s+(?:create|add|new)\s+(?!project\b)(.+)$/i;
        const asanaCreateMatch = userPrompt.match(asanaCreateRegex);
        if (asanaCreateMatch) {
            const rawTaskName = asanaCreateMatch[1].trim();
            const aConf = dbUser ? db.getUserIntegration(dbUser.id, "asana") : null;
            const effAsana = getEffectiveAsanaConfig(aConf);

            let resText = "";
            if (!effAsana.isConfigured) {
                resText = `⚠️ *Asana is not connected yet.* Connect your account in the web dashboard at http://localhost:3000 -> Integrations tab!`;
            } else {
                try {
                    const created = await createAsanaTask(aConf, {
                        name: rawTaskName,
                        projectId: effAsana.defaultProject || undefined
                    });
                    resText = formatCreatedAsanaTaskForWhatsApp(created);
                } catch (err) {
                    resText = `❌ Could not create Asana task: ${err.message}`;
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 2j. Direct Asana Comment: "asana comment 1 Finished draft", "asana comment <gid> Update"
        const asanaCommentRegex = /^\s*asana\s+comment\s+(\S+)\s+(.+)$/i;
        const asanaCommentMatch = userPrompt.match(asanaCommentRegex);
        if (asanaCommentMatch) {
            const aConf = dbUser ? db.getUserIntegration(dbUser.id, "asana") : null;
            const effAsana = getEffectiveAsanaConfig(aConf);

            let resText = "";
            if (!effAsana.isConfigured) {
                resText = `⚠️ *Asana is not connected yet.* Connect it on your web dashboard at http://localhost:3000`;
            } else {
                const rawTarget = asanaCommentMatch[1].trim();
                const commentText = asanaCommentMatch[2].trim();
                const task = await findOrResolveAsanaTask(aConf, sender, rawTarget);

                if (!task || !task.gid) {
                    resText = `⚠️ Could not find Asana task '${rawTarget}'. Try "asana list" to view recent tasks.`;
                } else {
                    try {
                        await addAsanaComment(aConf, { taskGid: task.gid, comment: commentText });
                        resText = `💬 Comment added to Asana task *${task.name || ""}*!`;
                    } catch (err) {
                        resText = `❌ Could not add Asana comment: ${err.message}`;
                    }
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 2k. Direct Asana Task View: "asana 1", "asana view 1", "asana <gid>"
        const asanaViewRegex = /^\s*(?:!asana\s+|asana\s+(?:view\s+|get\s+|show\s+|task\s+|details\s+)?|view\s+asana\s+)(\d+|[A-Za-z0-9_]{10,})\s*$/i;
        const isAsanaView = asanaViewRegex.test(userPrompt) && !/^\s*asana\s+(?:help|list|tasks?|create|add|new|done|close|finish|complete|update|rename|due|notes?|comment|project)\b/i.test(userPrompt);

        if (isAsanaView) {
            const aConf = dbUser ? db.getUserIntegration(dbUser.id, "asana") : null;
            const effAsana = getEffectiveAsanaConfig(aConf);

            let resText = "";
            if (!effAsana.isConfigured) {
                resText = `⚠️ *Asana is not connected yet.* Connect it on your web dashboard at http://localhost:3000`;
            } else {
                const rawTarget = userPrompt.match(asanaViewRegex)[1].trim();
                const taskRef = await findOrResolveAsanaTask(aConf, sender, rawTarget);

                if (!taskRef || !taskRef.gid) {
                    resText = `⚠️ Could not find Asana task '${rawTarget}'. Try "asana list" to view tasks.`;
                } else {
                    try {
                        const task = await getAsanaTask(aConf, taskRef.gid);
                        resText = formatSingleAsanaTaskForWhatsApp(task);
                    } catch (err) {
                        resText = `❌ Could not load Asana task: ${err.message}`;
                    }
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 2l. Direct Asana Help: "asana help" or bare "asana"
        if (/^\s*(?:!asana|asana(?:\s+help)?)\s*$/i.test(userPrompt)) {
            const helpText = `🔴 *Asana Commands Guide:*\n\n` +
                `• *asana list* - View recent tasks\n` +
                `• *asana <number>* (e.g. _asana 1_) - View task details\n` +
                `• *asana add <title>* - Create a new task\n` +
                `• *asana done <# or title>* (e.g. _asana done 1_ or _asana done dentist_) - Mark task completed\n` +
                `• *asana update <#> rename <title>* - Rename task\n` +
                `• *asana update <#> due tomorrow* - Update due date\n` +
                `• *asana add project <name>* - Create a new project in Asana\n` +
                `• *asana comment <#> <note>* - Add a comment\n` +
                `• *prioritize tasks* - Prioritize Asana, Jira & Checklist tasks`;

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: helpText }] });
            await sendReply(sock, sender, { text: helpText });
            return;
        }

        // 3. Direct Google Calendar Commands: "calendar today", "schedule today", "!calendar", "calendar tomorrow"
        const calTodayRegex = /^\s*(?:!calendar|calendar\s+today|schedule\s+today|my\s+schedule|my\s+meetings|calendar)\s*$/i;
        const calTomorrowRegex = /^\s*(?:calendar\s+tomorrow|schedule\s+tomorrow)\s*$/i;
        const calWeekRegex = /^\s*(?:calendar\s+(?:week|this\s+week)|schedule\s+(?:week|this\s+week))\s*$/i;

        if (calTodayRegex.test(userPrompt) || calTomorrowRegex.test(userPrompt) || calWeekRegex.test(userPrompt)) {
            const cConf = dbUser ? db.getUserIntegration(dbUser.id, "google_calendar") : null;
            const effCal = getEffectiveCalendarConfig(cConf);

            let resText = "";
            if (!effCal.isConfigured) {
                resText = `⚠️ *Google Calendar is not connected yet.*\n\nPlease connect your Google Calendar service credentials in your web dashboard at http://localhost:3000 -> Integrations tab.`;
            } else {
                const timeFrame = calTomorrowRegex.test(userPrompt) ? "tomorrow" : calWeekRegex.test(userPrompt) ? "this_week" : "today";
                try {
                    const calResult = await listCalendarEvents(cConf, { timeFrame });
                    resText = formatEventsForWhatsApp(calResult);
                } catch (err) {
                    resText = `❌ Error loading Google Calendar: ${err.message}`;
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 3a. Direct Instant Google Meet: "gmeet", "new gmeet", "instant meet", "create meet", "gmeet link", "g-meet", "google meet", "!meet"
        const instantMeetRegex = /^\s*(?:!meet|!gmeet|instant\s+meet|new\s+meet|create\s+meet|new\s+g-?meet|g-?meet\s+link|google\s+meet\s+link|instant\s+g-?meet|start\s+(?:a\s+)?g-?meet|create\s+(?:a\s+)?g-?meet|g-?meet|google\s+meet)\s*$/i;
        if (instantMeetRegex.test(userPrompt)) {
            const cConf = dbUser ? db.getUserIntegration(dbUser.id, "google_calendar") : null;
            const effCal = getEffectiveCalendarConfig(cConf);

            let resText = "";
            if (!effCal.isConfigured) {
                const meetLink = generateGoogleMeetLink();
                resText = `💻 *Google Meet Ready!*\n\n` +
                    `🔗 *Meeting Link:* ${meetLink}\n` +
                    `⏰ *Time:* Starting Now\n\n` +
                    `👉 Tap the link above to start your meeting!\n\n` +
                    `💡 _Connect Google Calendar at http://localhost:3000 to sync all meetings to your schedule._`;
            } else {
                try {
                    const meet = await createInstantGoogleMeet(cConf, {
                        summary: "Instant Google Meet",
                        durationMinutes: 30
                    });
                    resText = formatInstantMeetForWhatsApp(meet);
                } catch (err) {
                    const fallbackLink = generateGoogleMeetLink();
                    resText = `💻 *Google Meet Ready!*\n\n` +
                        `🔗 *Meeting Link:* ${fallbackLink}\n` +
                        `⏰ *Time:* Starting Now\n\n` +
                        `👉 Tap the link above to join!`;
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 3b. Direct Schedule Google Meet: "schedule gmeet tomorrow at 3pm with Team", "schedule a meet tomorrow at 4pm"
        const scheduleMeetMatch = userPrompt.match(/^\s*(?:hey\s+anam[,:\s]*)?(?:schedule|set\s+up|book)\s+(?:a\s+)?(?:g-?meet|google\s+meet|meeting|meet)\s+(?:with\s+([^,]+?)\s+)?(?:(today|tomorrow|on\s+[^,]+?)\s+)?(?:at\s+([0-2]?[0-9](?::[0-5][0-9])?\s*(?:am|pm)?))\s*(?:about\s+(.+))?$/is);
        if (scheduleMeetMatch) {
            const cConf = dbUser ? db.getUserIntegration(dbUser.id, "google_calendar") : null;
            const effCal = getEffectiveCalendarConfig(cConf);

            let resText = "";
            if (!effCal.isConfigured) {
                resText = `⚠️ *Google Calendar is not connected yet.*\n\nPlease connect your Google Calendar in your web dashboard at http://localhost:3000 -> Integrations tab.`;
            } else {
                const withWho = scheduleMeetMatch[1]?.trim() || "";
                const dayStr = scheduleMeetMatch[2]?.trim().toLowerCase() || "today";
                const timeStr = scheduleMeetMatch[3]?.trim() || "10:00 AM";
                const aboutStr = scheduleMeetMatch[4]?.trim() || "";

                const parsedClock = parseClockTime(timeStr);
                const targetDate = new Date();
                if (dayStr === "tomorrow") {
                    targetDate.setDate(targetDate.getDate() + 1);
                }
                if (parsedClock) {
                    targetDate.setHours(parsedClock.hours, parsedClock.minutes, 0, 0);
                }

                const title = `Meeting ${withWho ? `with ${withWho}` : ""}${aboutStr ? `: ${aboutStr}` : ""}`.trim() || "Google Meet";
                try {
                    const created = await createCalendarEvent(cConf, {
                        summary: title,
                        description: `Scheduled via Anam AI WhatsApp Bot`,
                        startDateTime: targetDate.toISOString(),
                        durationMinutes: 30,
                        addMeet: true
                    });
                    resText = formatCreatedEventForWhatsApp(created);

                    // Sync reminder alert
                    if (targetDate.getTime() > Date.now()) {
                        try {
                            await createAndSaveReminder(sock, sender, {
                                targetTimestamp: targetDate.getTime(),
                                isTomorrow: dayStr === "tomorrow",
                                name: title,
                                description: `Join Google Meet: ${created.meetLink || created.hangoutLink}`
                            }, dbUser ? dbUser.id : null);
                        } catch (e) {}
                    }
                } catch (err) {
                    resText = `❌ Could not schedule meeting: ${err.message}`;
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // ---------------- DIRECT EMAIL / GMAIL COMMANDS ----------------

        // 4a. Direct Email Help: "email help", "!email", "mail help"
        if (/^\s*(?:!email|email\s+help|mail\s+help)\s*$/i.test(userPrompt)) {
            const helpText = `✉️ *Email & Gmail Assistant Commands:*\n\n` +
                `• *draft email to <email> about <topic>* - Compose an email draft\n` +
                `• *email drafts* or *gmail drafts* - View all saved drafts\n` +
                `• *send draft <#>* (e.g. _send draft 1_) - Send saved draft now\n` +
                `• *delete draft <#>* - Discard saved draft\n` +
                `• *email status* - Check connected Gmail account and status\n` +
                `• *update email to <address>* - Update your Gmail address\n` +
                `• *set email password <16-char-pass>* - Update Google App Password\n` +
                `• *send email to <email> about <topic>* - Send directly without drafting\n\n` +
                `💡 _Natural phrasing works anywhere, e.g.:\n` +
                `"Draft an email to anamikasuresh963@gmail.com about meeting today at 8:35pm"_`;

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: helpText }] });
            await sendReply(sock, sender, { text: helpText });
            return;
        }

        // 4b. Direct Email Status: "email status", "gmail status", "my email", "email info"
        if (/^\s*(?:email\s+status|gmail\s+status|my\s+email|email\s+info)\s*$/i.test(userPrompt)) {
            let resText = "";
            if (!dbUser) {
                resText = "⚠️ Please link your account in the web dashboard at http://localhost:3000 first.";
            } else {
                const eConf = db.getUserIntegration(dbUser.id, "email");
                const drafts = db.getUserEmailDrafts(dbUser.id, "draft");
                const effEmail = getEffectiveEmailConfig(eConf);
                resText = `✉️ *Email & Gmail Integration Status:*\n\n` +
                    `• *Sender Account:* \`${effEmail.email || "Not configured"}\`\n` +
                    `• *Connection Status:* ${effEmail.isConfigured ? "✅ Connected & Active" : "⚠️ Password / Setup Needed"}\n` +
                    `• *Pending Drafts:* ${drafts.length} saved draft(s)\n\n` +
                    `💡 *Quick Commands:*\n` +
                    `• *email drafts* - View saved drafts\n` +
                    `• *update email to <new-email>*\n` +
                    `• *set email password <16-char-code>*`;
            }
            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 4c. Direct Update Email Address: "update email to <email>", "set email <email>", "change email to <email>"
        const updateEmailMatch = userPrompt.match(/^\s*(?:hey\s+anam[,:\s]*)?(?:update|change|set)\s+(?:my\s+)?email(?:\s+to)?\s+([^\s,;]+@[^\s,;]+)\s*$/i);
        if (updateEmailMatch) {
            let resText = "";
            if (!dbUser) {
                resText = "⚠️ Please link your WhatsApp number in the dashboard at http://localhost:3000 first.";
            } else {
                const newEmail = updateEmailMatch[1].trim();
                const existing = db.getUserIntegration(dbUser.id, "email") || {};
                const configObj = {
                    email: newEmail,
                    appPassword: existing.appPassword || "",
                    senderName: existing.senderName || dbUser.name || "Anamika"
                };
                db.saveUserIntegration(dbUser.id, "email", configObj, configObj.appPassword ? 1 : 0);

                let verified = false;
                if (configObj.appPassword) {
                    try {
                        await verifyEmailConnection(configObj);
                        verified = true;
                    } catch (err) {
                        verified = false;
                    }
                }

                if (verified) {
                    resText = `✅ *Email Updated Successfully!*\n\n` +
                        `📬 *Active Account:* \`${newEmail}\`\n` +
                        `🔒 *Password:* Verified & Connected\n\n` +
                        `You are all set to draft and send emails! Say _"draft email to <email> about <topic>"_ to start.`;
                } else {
                    resText = `✅ *Email Address Saved:*\n\`${newEmail}\`\n\n` +
                        `⚠️ *Next Step: Google App Password*\n` +
                        `Google requires a 16-character App Password specifically for \`${newEmail}\`:\n` +
                        `1. Open: https://myaccount.google.com/apppasswords\n` +
                        `2. Create an app password for "Mail"\n` +
                        `3. Reply here with:\n` +
                        `   👉 *set email password <your-16-char-code>*\n\n` +
                        `_(Or configure it in your dashboard at http://localhost:3000 -> Integrations)_`;
                }
            }
            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 4d. Direct Set Email Password: "set email password <16-char>", "update email password <16-char>"
        const updatePassMatch = userPrompt.match(/^\s*(?:hey\s+anam[,:\s]*)?(?:update|set)\s+(?:my\s+)?(?:email|gmail)\s+password(?:\s+to)?\s+([a-zA-Z0-9\s]{16,30})\s*$/i);
        if (updatePassMatch) {
            let resText = "";
            if (!dbUser) {
                resText = "⚠️ Please link your account at http://localhost:3000 first.";
            } else {
                const rawPass = updatePassMatch[1];
                const cleaned = cleanAppPassword(rawPass);
                const existing = db.getUserIntegration(dbUser.id, "email") || {};
                const configObj = {
                    email: existing.email || dbUser.email || "",
                    appPassword: cleaned,
                    senderName: existing.senderName || dbUser.name || "Anamika"
                };
                db.saveUserIntegration(dbUser.id, "email", configObj, 1);

                try {
                    await verifyEmailConnection(configObj);
                    resText = `✅ *Gmail Connected Successfully!*\n\n` +
                        `📬 *Sender Account:* \`${configObj.email}\`\n` +
                        `🔒 *Google App Password:* Verified & Active\n\n` +
                        `You can now draft and send emails directly through WhatsApp!\n` +
                        `• Say: _"draft email to client@example.com about meeting tomorrow"_\n` +
                        `• Say: _"email drafts"_ to view saved drafts`;
                } catch (verErr) {
                    resText = `⚠️ *Password Saved, but Google Verification Failed:*\n\n` +
                        `Account: \`${configObj.email}\`\n` +
                        `Error: ${verErr.message}\n\n` +
                        `👉 Make sure 2-Step Verification is ON for \`${configObj.email}\` and generate a fresh App Password at https://myaccount.google.com/apppasswords.`;
                }
            }
            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 4e. Direct Email Drafts List: "email drafts", "gmail drafts", "show drafts", "my drafts", "list drafts", "drafts"
        const emailDraftsListMatch = userPrompt.match(/^\s*(?:(?:gmail|email|my)?\s*drafts?|(?:show|list|view|get)\s*(?:all\s*)?(?:gmail|email)?\s*drafts?)\s*$/i);
        if (emailDraftsListMatch) {
            let resText = "";
            if (!dbUser) {
                resText = "⚠️ Please link your account in the web dashboard at http://localhost:3000 to manage email drafts.";
            } else {
                const drafts = db.getUserEmailDrafts(dbUser.id, "draft");
                resText = formatDraftListForWhatsApp(drafts);
            }
            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 4f. Direct Send Draft: "send draft 1", "email send draft 2", "send draft #1"
        const sendDraftMatch = userPrompt.match(/^\s*(?:email\s+)?send\s+draft\s+#?(\d+)\s*$/i);
        if (sendDraftMatch) {
            let resText = "";
            if (!dbUser) {
                resText = "⚠️ Please link your account on http://localhost:3000 to send emails.";
            } else {
                const eConf = db.getUserIntegration(dbUser.id, "email");
                const effEmail = getEffectiveEmailConfig(eConf);
                if (!effEmail.isConfigured) {
                    resText = "⚠️ Gmail is not connected yet. Please add your Gmail address and 16-character App Password at http://localhost:3000 -> Integrations tab or reply *set email password <pass>*.";
                } else {
                    const draftId = parseInt(sendDraftMatch[1], 10);
                    const draft = db.getEmailDraftById(draftId, dbUser.id);
                    if (!draft || draft.status !== "draft") {
                        resText = `⚠️ Could not find pending draft #${draftId}. Reply "email drafts" to view your saved drafts.`;
                    } else {
                        try {
                            const sentResult = await sendEmail(eConf, {
                                to: draft.recipient,
                                subject: draft.subject,
                                body: draft.body
                            });
                            db.updateEmailDraft(draftId, dbUser.id, { status: "sent" });
                            resText = formatSentEmailForWhatsApp(sentResult);
                        } catch (err) {
                            resText = `❌ Could not send email: ${err.message}`;
                        }
                    }
                }
            }
            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 4g. Direct Delete Draft: "delete draft 1", "discard draft 1"
        const deleteDraftMatch = userPrompt.match(/^\s*(?:delete|discard|remove)\s+draft\s+#?(\d+)\s*$/i);
        if (deleteDraftMatch) {
            let resText = "";
            if (!dbUser) {
                resText = "⚠️ Please link your account on http://localhost:3000 first.";
            } else {
                const draftId = parseInt(deleteDraftMatch[1], 10);
                const draft = db.getEmailDraftById(draftId, dbUser.id);
                if (!draft) {
                    resText = `⚠️ Draft #${draftId} not found.`;
                } else {
                    db.deleteEmailDraft(draftId, dbUser.id);
                    resText = `🗑️ Draft #${draftId} discarded.`;
                }
            }
            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 4h. Direct Edit Draft: "edit draft 1 body <new text>", "edit draft 1 subject <new subject>"
        const editDraftMatch = userPrompt.match(/^\s*(?:edit|change|update)\s+draft\s+#?(\d+)\s+(body|subject)\s+(.+)$/is);
        if (editDraftMatch) {
            let resText = "";
            if (!dbUser) {
                resText = "⚠️ Please link your account at http://localhost:3000 first.";
            } else {
                const draftId = parseInt(editDraftMatch[1], 10);
                const field = editDraftMatch[2].toLowerCase();
                const newVal = editDraftMatch[3].trim();
                const draft = db.getEmailDraftById(draftId, dbUser.id);
                if (!draft || draft.status !== "draft") {
                    resText = `⚠️ Could not find pending draft #${draftId}.`;
                } else {
                    const updates = {};
                    if (field === "body") updates.body = newVal;
                    else updates.subject = newVal;
                    const updated = db.updateEmailDraft(draftId, dbUser.id, updates);
                    resText = `✏️ *Draft #${draftId} Updated!*\n\n` + formatDraftForWhatsApp(updated, false);
                }
            }
            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 4i. Natural Language Email Drafting: "draft an email to <email> about/saying/regarding <topic>"
        const naturalDraftMatch = userPrompt.match(/^\s*(?:hey\s+anam[,:\s]*)?(?:draft|compose|write)(?:\s+an?)?\s+email\s+to\s+([^\s,;]+@[^\s,;]+)(?:\s+(?:about|regarding|saying|subject|titled)\s+(.+))?$/is);
        if (naturalDraftMatch) {
            let resText = "";
            if (!dbUser) {
                resText = "⚠️ Please link your account on http://localhost:3000 to save email drafts.";
            } else {
                const to = naturalDraftMatch[1].trim();
                const topic = naturalDraftMatch[2]?.trim() || "Follow up";
                try {
                    const generated = await generateEmailDraftContent({
                        to,
                        topic,
                        senderName: dbUser.name || "Anamika",
                        generateAIContent: ai ? generateAIContent : null
                    });
                    const draft = db.createEmailDraft(dbUser.id, to, generated.subject, generated.body);
                    resText = formatDraftForWhatsApp(draft, true);
                } catch (err) {
                    resText = `❌ Error creating email draft: ${err.message}`;
                }
            }
            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 4j. Direct Structured Draft: "email draft to <recipient> subject <subj> body <body text>"
        const structuredDraftMatch = userPrompt.match(/^\s*(?:hey\s+anam[,:\s]*)?(?:email\s+)?draft(?:\s+email)?\s+to\s+([^\s,;]+@[^\s,;]+)\s+subject\s+(.+?)\s+body\s+(.+)$/is);
        if (structuredDraftMatch) {
            let resText = "";
            if (!dbUser) {
                resText = "⚠️ Please link your account on http://localhost:3000 to save email drafts.";
            } else {
                const to = structuredDraftMatch[1].trim();
                const subject = structuredDraftMatch[2].trim();
                const body = structuredDraftMatch[3].trim();
                const draft = db.createEmailDraft(dbUser.id, to, subject, body);
                resText = formatDraftForWhatsApp(draft, true);
            }
            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 4k. Direct Natural Send: "send an email to <recipient> about/saying <topic>"
        const naturalSendMatch = userPrompt.match(/^\s*(?:hey\s+anam[,:\s]*)?(?:send|mail)(?:\s+an?)?\s+email\s+to\s+([^\s,;]+@[^\s,;]+)(?:\s+(?:about|regarding|saying)\s+(.+))?$/is);
        if (naturalSendMatch && !/^\s*send\s+draft/i.test(userPrompt)) {
            let resText = "";
            if (!dbUser) {
                resText = "⚠️ Please link your account on http://localhost:3000 to send emails.";
            } else {
                const eConf = db.getUserIntegration(dbUser.id, "email");
                const effEmail = getEffectiveEmailConfig(eConf);
                if (!effEmail.isConfigured) {
                    resText = "⚠️ Gmail is not connected yet. Please add your Gmail address and 16-character App Password at http://localhost:3000 -> Integrations tab.";
                } else {
                    const to = naturalSendMatch[1].trim();
                    const topic = naturalSendMatch[2]?.trim() || "Follow up";
                    try {
                        const generated = await generateEmailDraftContent({
                            to,
                            topic,
                            senderName: dbUser.name || "Anamika",
                            generateAIContent: ai ? generateAIContent : null
                        });
                        const sentResult = await sendEmail(eConf, {
                            to,
                            subject: generated.subject,
                            body: generated.body
                        });
                        resText = formatSentEmailForWhatsApp(sentResult);
                    } catch (err) {
                        resText = `❌ Could not send email: ${err.message}`;
                    }
                }
            }
            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 4l. Direct Structured Send: "email send to <recipient> subject <subj> body <body text>"
        const structuredSendMatch = userPrompt.match(/^\s*(?:hey\s+anam[,:\s]*)?(?:email\s+)?send(?:\s+email)?\s+to\s+([^\s,;]+@[^\s,;]+)\s+subject\s+(.+?)\s+body\s+(.+)$/is);
        if (structuredSendMatch) {
            let resText = "";
            if (!dbUser) {
                resText = "⚠️ Please link your account on http://localhost:3000 to send emails.";
            } else {
                const eConf = db.getUserIntegration(dbUser.id, "email");
                const effEmail = getEffectiveEmailConfig(eConf);
                if (!effEmail.isConfigured) {
                    resText = "⚠️ Gmail is not connected yet. Please add your Gmail address and 16-character App Password at http://localhost:3000 -> Integrations tab.";
                } else {
                    const to = structuredSendMatch[1].trim();
                    const subject = structuredSendMatch[2].trim();
                    const body = structuredSendMatch[3].trim();
                    try {
                        const sentResult = await sendEmail(eConf, { to, subject, body });
                        resText = formatSentEmailForWhatsApp(sentResult);
                    } catch (err) {
                        resText = `❌ Could not send email: ${err.message}`;
                    }
                }
            }
            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // ---------------- DIRECT GOOGLE DRIVE COMMANDS ----------------

        // 5a. Direct Drive Help: "drive help", "!drive", "drive", "google drive"
        if (/^\s*(?:!drive|drive(?:\s+help)?|google\s+drive(?:\s+help)?)\s*$/i.test(userPrompt)) {
            const helpText = `📂 *Google Drive Assistant Commands:*\n\n` +
                `• *drive list* or *my drive* - View recent Google Drive files\n` +
                `• *drive search <query>* (e.g. _drive search report_) - Search files\n` +
                `• *drive folder <name>* (e.g. _drive folder Project Alpha_) - Create folder\n` +
                `• *drive share <filename>* - Generate shareable link\n` +
                `• *drive delete <filename>* - Remove file from Drive\n\n` +
                `☁️ *Upload files effortlessly:*\n` +
                `Send any photo, video, PDF, or document on WhatsApp with caption *"save to drive"*!`;

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: helpText }] });
            await sendReply(sock, sender, { text: helpText });
            return;
        }

        // 5b. Direct Drive List: "drive list", "drive files", "my drive", "my files", "list drive"
        if (/^\s*(?:drive\s+(?:files|list)|my\s+(?:drive|drive\s+files|files)|list\s+drive(?:\s+files)?)\s*$/i.test(userPrompt)) {
            const dConf = dbUser ? db.getUserIntegration(dbUser.id, "google_drive") : null;
            const effDrive = getEffectiveDriveConfig(dConf);

            let resText = "";
            if (!effDrive.isConfigured) {
                resText = `⚠️ *Google Drive is not connected yet.*\n\nPlease connect your Google Drive in your web dashboard at http://localhost:3000 -> Integrations tab.`;
            } else {
                try {
                    const filesResult = await listDriveFiles(dConf, { pageSize: 10 });
                    resText = formatDriveFilesForWhatsApp(filesResult);
                } catch (err) {
                    resText = `❌ Error loading Google Drive: ${err.message}`;
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 5c. Direct Drive Search: "drive search <query>", "search drive for <query>", "find file <query>"
        const driveSearchMatch = userPrompt.match(/^\s*(?:hey\s+anam[,:\s]*)?(?:drive\s+search|search\s+drive(?:\s+for)?|find\s+(?:drive\s+)?file|find\s+on\s+drive)\s+(.+)$/i);
        if (driveSearchMatch) {
            const dConf = dbUser ? db.getUserIntegration(dbUser.id, "google_drive") : null;
            const effDrive = getEffectiveDriveConfig(dConf);

            let resText = "";
            if (!effDrive.isConfigured) {
                resText = `⚠️ *Google Drive is not connected yet.*\n\nPlease connect Google Drive in your web dashboard at http://localhost:3000 -> Integrations tab.`;
            } else {
                const query = driveSearchMatch[1].trim();
                try {
                    const searchResult = await searchDriveFiles(dConf, { query, pageSize: 10 });
                    resText = formatDriveFilesForWhatsApp(searchResult);
                } catch (err) {
                    resText = `❌ Error searching Google Drive: ${err.message}`;
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 5d. Direct Drive Create Folder: "drive folder <name>", "drive new folder <name>", "drive mkdir <name>"
        const driveFolderMatch = userPrompt.match(/^\s*(?:hey\s+anam[,:\s]*)?(?:drive\s+(?:new\s+)?folder|drive\s+mkdir|create\s+drive\s+folder)\s+(.+)$/i);
        if (driveFolderMatch) {
            const dConf = dbUser ? db.getUserIntegration(dbUser.id, "google_drive") : null;
            const effDrive = getEffectiveDriveConfig(dConf);

            let resText = "";
            if (!effDrive.isConfigured) {
                resText = `⚠️ *Google Drive is not connected yet.*\n\nPlease connect Google Drive in your web dashboard at http://localhost:3000 -> Integrations tab.`;
            } else {
                const folderName = driveFolderMatch[1].trim();
                try {
                    const folder = await createDriveFolder(dConf, { folderName });
                    resText = formatFolderCreatedForWhatsApp(folder);
                } catch (err) {
                    resText = `❌ Error creating Google Drive folder: ${err.message}`;
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 5e. Direct Drive Upload / Save Note: "drive upload <filename> | <content>", "drive save <filename> | <content>", "drive note <filename> | <content>"
        const driveUploadMatch = userPrompt.match(/^\s*(?:hey\s+anam[,:\s]*)?(?:drive\s+(?:upload|save|note|create\s+file))\s+([^|:]+)[|:]([\s\S]+)$/i);
        if (driveUploadMatch) {
            const dConf = dbUser ? db.getUserIntegration(dbUser.id, "google_drive") : null;
            const effDrive = getEffectiveDriveConfig(dConf);

            let resText = "";
            if (!effDrive.isConfigured) {
                resText = `⚠️ *Google Drive is not connected yet.*\n\nPlease connect Google Drive in your web dashboard at http://localhost:3000 -> Integrations tab.`;
            } else {
                let fileName = driveUploadMatch[1].trim();
                if (!fileName.includes(".")) fileName += ".txt";
                const fileContent = driveUploadMatch[2].trim();
                const buffer = Buffer.from(fileContent, "utf-8");
                try {
                    const uploaded = await uploadDriveFile(dConf, {
                        fileName,
                        mimeType: "text/plain",
                        buffer
                    });
                    resText = formatUploadedFileForWhatsApp(uploaded);
                } catch (err) {
                    resText = `❌ Error uploading to Google Drive: ${err.message}`;
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 5f. Direct Drive Share: "drive share <filename>"
        const driveShareMatch = userPrompt.match(/^\s*(?:hey\s+anam[,:\s]*)?drive\s+share\s+(.+)$/i);
        if (driveShareMatch) {
            const dConf = dbUser ? db.getUserIntegration(dbUser.id, "google_drive") : null;
            const effDrive = getEffectiveDriveConfig(dConf);

            let resText = "";
            if (!effDrive.isConfigured) {
                resText = `⚠️ *Google Drive is not connected yet.*\n\nPlease connect Google Drive in your web dashboard at http://localhost:3000 -> Integrations tab.`;
            } else {
                const searchName = driveShareMatch[1].trim();
                try {
                    const searchRes = await listDriveFiles(dConf, { query: searchName, pageSize: 3 });
                    if (!searchRes.files || searchRes.files.length === 0) {
                        resText = `🔍 Could not find file "${searchName}" on Google Drive.`;
                    } else {
                        const targetFile = searchRes.files[0];
                        const shared = await shareDriveFile(dConf, { fileId: targetFile.id });
                        resText = `🔗 *Google Drive Share Link:*\n\n• *File:* ${shared.name}\n• *Link:* ${shared.webViewLink}\n• *Access:* Anyone with link can view`;
                    }
                } catch (err) {
                    resText = `❌ Could not share Google Drive file: ${err.message}`;
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
            return;
        }

        // 5g. Direct Drive Delete: "drive delete <filename>"
        const driveDeleteMatch = userPrompt.match(/^\s*(?:hey\s+anam[,:\s]*)?drive\s+delete\s+(.+)$/i);
        if (driveDeleteMatch) {
            const dConf = dbUser ? db.getUserIntegration(dbUser.id, "google_drive") : null;
            const effDrive = getEffectiveDriveConfig(dConf);

            let resText = "";
            if (!effDrive.isConfigured) {
                resText = `⚠️ *Google Drive is not connected yet.*\n\nPlease connect Google Drive in your web dashboard at http://localhost:3000 -> Integrations tab.`;
            } else {
                const fileName = driveDeleteMatch[1].trim();
                try {
                    const deleted = await deleteDriveFile(dConf, { searchName: fileName });
                    resText = `🗑️ ${deleted.message}`;
                } catch (err) {
                    resText = `❌ Could not delete Google Drive file: ${err.message}`;
                }
            }

            session.history.push({ role: "user", parts: [{ text: userPrompt }] });
            session.history.push({ role: "model", parts: [{ text: resText }] });
            await sendReply(sock, sender, { text: resText });
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

                const confirmMsg = await createAndSaveReminder(sock, sender, newParsedCmd, dbUser ? dbUser.id : null);
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

            const confirmMsg = await createAndSaveReminder(sock, sender, parsedCmd, dbUser ? dbUser.id : null);
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
                const confirmMsg = await createAndSaveReminder(sock, sender, parsedCmd, dbUser ? dbUser.id : null);
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

        // 4. Handle To-Do, Integrations, and General AI queries via Gemini
        const systemInstruction = `You are Anam, a smart WhatsApp assistant${dbUser ? ` for ${dbUser.name}` : ''}.
Current Local Time: ${new Date().toLocaleString()}
${session.summary ? `Previous Conversation Summary: "${session.summary}"` : ""}

CRITICAL RULES:
1. TO-DO CHECKLIST: Only call 'add_todo' when user wants to add an item to their static checklist without a time trigger (e.g. 'add milk to list').
2. SHOW TASKS: Call 'get_todos' when user asks 'show tasks', 'what are my tasks', 'my todo list', 'todos'.
3. COMPLETE TASK: Call 'complete_todo' when user says 'done 1', 'check off 2'.
4. JIRA INTEGRATION:
   - Call 'jira_create_issue' when user asks to create/log a Jira issue, ticket, bug, or task.
   - Call 'jira_get_issues' when user asks to see their tickets, tasks in Jira, or sprint items.
   - Call 'jira_transition_issue' when user asks to change ticket status, close, or finish an issue.
   - Call 'jira_add_comment' to add a note/comment to a Jira ticket.
5. GOOGLE CALENDAR & GOOGLE MEET:
   - Call 'create_instant_meet' when user asks for an instant Google Meet, meet link, 'start a meet', 'new gmeet', or 'g-meet link'.
   - Call 'calendar_create_event' when user wants to schedule, add, or book a meeting, call, appointment, or Google Meet on Google Calendar. It automatically includes an authentic Google Meet link.
   - Call 'calendar_list_events' when user asks about their schedule, meetings, appointments, or agenda for today, tomorrow, or this week.
   - Call 'calendar_delete_event' when user wants to cancel or delete a calendar event.
6. ASANA AI TASK & PROJECT MANAGEMENT:
   - Call 'asana_get_tasks' when user asks to see Asana tasks, workspace to-dos, or project tasks.
   - Call 'asana_create_task' when user asks to create/add a task in Asana or assign an Asana to-do.
   - Call 'asana_complete_task' when user wants to check off, finish, or complete an Asana task.
   - Call 'asana_update_task' when user wants to edit, update, rename, change due date, notes, or status of an Asana task.
   - Call 'asana_create_project' when user wants to create/add a new project in Asana.
   - Call 'asana_add_comment' to add a comment or note to an Asana task.
7. EMAIL & GMAIL DRAFTING & SENDING:
   - Call 'email_draft' when user asks to draft, compose, write, or prepare an email to someone (e.g. 'draft an email to boss@company.com saying...'). Always generate a polite, complete subject line and professional email body.
   - Call 'email_send' when user asks to send an email (or says 'send draft 1' / 'send it').
   - Call 'email_list_drafts' when user asks to see their saved drafts or pending emails.
8. GOOGLE DRIVE:
   - Call 'drive_list_files' when user asks to see, check, or list files and folders in Google Drive.
   - Call 'drive_search_files' when user asks to find, locate, or search for a document, spreadsheet, PDF, presentation, or file in Google Drive.
   - Call 'drive_create_folder' when user asks to create or make a folder in Google Drive.
   - Call 'drive_upload_text' when user asks to save, write, or upload a text note or document to Google Drive.
   - Call 'drive_share_file' when user asks to share or get a link for a file in Google Drive.
   - Call 'drive_delete_file' when user asks to delete or remove a file from Google Drive.

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

                            const isAnalytical = /\b(priorit|rank|which|summar|what\s+should|focus|first|urgent|recommend|advise)\b/i.test(userPrompt);
                            if (isAnalytical && ai) {
                                const synthPrompt = `You are Anam, executive assistant.\nUser request: "${userPrompt}"\n\nUser's tasks:\n${listStr}\n\nAnswer the user's question directly, clearly, and concisely for WhatsApp.`;
                                try {
                                    const synthRes = await generateAIContent([{ role: "user", parts: [{ text: synthPrompt }] }], undefined);
                                    resultText = synthRes.text?.trim() || `Your Tasks:\n${listStr}`;
                                } catch {
                                    resultText = `Your Tasks:\n${listStr}`;
                                }
                            } else {
                                resultText = `Your Tasks:\n${listStr}`;
                            }
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
                    } else if (name === "jira_create_issue") {
                        const jConf = dbUser ? db.getUserIntegration(dbUser.id, "jira") : null;
                        const effJira = getEffectiveJiraConfig(jConf);
                        if (!effJira.isConfigured) {
                            resultText = "⚠️ Jira is not connected yet. Please connect your Jira domain & API token in your web dashboard at http://localhost:3000 -> Integrations tab.";
                        } else {
                            try {
                                const created = await createJiraIssue(jConf, {
                                    summary: args.summary,
                                    description: args.description || "",
                                    projectKey: args.project_key || effJira.defaultProject || "",
                                    issueType: args.issue_type || "Task"
                                });
                                resultText = formatCreatedIssueForWhatsApp(created);
                            } catch (err) {
                                resultText = `❌ Could not create Jira issue: ${err.message}`;
                            }
                        }
                    } else if (name === "jira_get_issues") {
                        const jConf = dbUser ? db.getUserIntegration(dbUser.id, "jira") : null;
                        const effJira = getEffectiveJiraConfig(jConf);
                        if (!effJira.isConfigured) {
                            resultText = "⚠️ Jira is not connected yet. Please connect your Jira account in your web dashboard at http://localhost:3000 -> Integrations tab.";
                        } else {
                            try {
                                const issuesResult = await getJiraIssues(jConf, {
                                    jql: args.jql || "",
                                    maxResults: args.max_results || 5
                                });
                                if (issuesResult.issues) {
                                    lastJiraIssuesBySender.set(sender, issuesResult.issues);
                                }

                                const isAnalytical = /\b(priorit|rank|which|summar|what\s+should|focus|first|urgent|how\s+many|who|why|recommend|advise)\b/i.test(userPrompt);
                                if (isAnalytical && ai && issuesResult.issues && issuesResult.issues.length > 0) {
                                    const synthPrompt = `You are Anam, executive assistant.\nUser request: "${userPrompt}"\n\nJira tickets found:\n${JSON.stringify(issuesResult.issues)}\n\nAnswer the user's question directly, clearly, and concisely for WhatsApp.`;
                                    try {
                                        const synthRes = await generateAIContent([{ role: "user", parts: [{ text: synthPrompt }] }], undefined);
                                        resultText = synthRes.text?.trim() || formatIssuesForWhatsApp(issuesResult);
                                    } catch {
                                        resultText = formatIssuesForWhatsApp(issuesResult);
                                    }
                                } else {
                                    resultText = formatIssuesForWhatsApp(issuesResult);
                                }
                            } catch (err) {
                                resultText = `❌ Error retrieving Jira issues: ${err.message}`;
                            }
                        }
                    } else if (name === "jira_transition_issue") {
                        const jConf = dbUser ? db.getUserIntegration(dbUser.id, "jira") : null;
                        const effJira = getEffectiveJiraConfig(jConf);
                        if (!effJira.isConfigured) {
                            resultText = "⚠️ Jira is not connected yet.";
                        } else {
                            try {
                                const res = await transitionJiraIssue(jConf, {
                                    issueKey: args.issue_key,
                                    transitionName: args.target_status
                                });
                                resultText = formatTransitionForWhatsApp(res);
                            } catch (err) {
                                resultText = `❌ Could not update Jira status: ${err.message}`;
                            }
                        }
                    } else if (name === "jira_add_comment") {
                        const jConf = dbUser ? db.getUserIntegration(dbUser.id, "jira") : null;
                        const effJira = getEffectiveJiraConfig(jConf);
                        if (!effJira.isConfigured) {
                            resultText = "⚠️ Jira is not connected yet.";
                        } else {
                            try {
                                await addJiraComment(jConf, {
                                    issueKey: args.issue_key,
                                    comment: args.comment
                                });
                                resultText = `💬 Comment added to Jira ticket *${args.issue_key.toUpperCase()}*!`;
                            } catch (err) {
                                resultText = `❌ Could not add Jira comment: ${err.message}`;
                            }
                        }
                    } else if (name === "calendar_list_events") {
                        const cConf = dbUser ? db.getUserIntegration(dbUser.id, "google_calendar") : null;
                        const effCal = getEffectiveCalendarConfig(cConf);
                        if (!effCal.isConfigured) {
                            resultText = "⚠️ Google Calendar is not connected yet. Please connect your Google Calendar in your web dashboard at http://localhost:3000 -> Integrations tab.";
                        } else {
                            try {
                                const eventsResult = await listCalendarEvents(cConf, {
                                    timeFrame: args.time_frame || "today",
                                    maxResults: args.max_results || 10
                                });
                                resultText = formatEventsForWhatsApp(eventsResult);
                            } catch (err) {
                                resultText = `❌ Error loading Google Calendar: ${err.message}`;
                            }
                        }
                    } else if (name === "calendar_create_event") {
                        const cConf = dbUser ? db.getUserIntegration(dbUser.id, "google_calendar") : null;
                        const effCal = getEffectiveCalendarConfig(cConf);
                        if (!effCal.isConfigured) {
                            resultText = "⚠️ Google Calendar is not connected yet. Please link your Google Calendar in your web dashboard at http://localhost:3000 -> Integrations tab.";
                        } else {
                            try {
                                const addMeet = args.add_meet !== undefined ? Boolean(args.add_meet) : true;
                                const created = await createCalendarEvent(cConf, {
                                    summary: args.title,
                                    description: args.description || "",
                                    startDateTime: args.start_time,
                                    durationMinutes: args.duration_minutes || 30,
                                    location: args.location || "",
                                    addMeet
                                });
                                resultText = formatCreatedEventForWhatsApp(created);

                                // Also sync to WhatsApp bot reminder alerts
                                try {
                                    const eventDate = new Date(created.start);
                                    if (!isNaN(eventDate.getTime()) && eventDate.getTime() > Date.now()) {
                                        await createAndSaveReminder(sock, sender, {
                                            targetTimestamp: eventDate.getTime(),
                                            isTomorrow: false,
                                            name: args.title,
                                            description: created.meetLink ? `Join Google Meet: ${created.meetLink}` : (args.description || "")
                                        }, dbUser ? dbUser.id : null);
                                    }
                                } catch (e) {}
                            } catch (err) {
                                resultText = `❌ Could not schedule calendar event: ${err.message}`;
                            }
                        }
                    } else if (name === "create_instant_meet") {
                        const cConf = dbUser ? db.getUserIntegration(dbUser.id, "google_calendar") : null;
                        const effCal = getEffectiveCalendarConfig(cConf);
                        if (!effCal.isConfigured) {
                            const fallbackLink = generateGoogleMeetLink();
                            resultText = `💻 *Google Meet Ready!*\n\n` +
                                `🔗 *Meeting Link:* ${fallbackLink}\n` +
                                `📌 *Topic:* *${args.topic || "Instant Google Meet"}*\n` +
                                `⏰ *Time:* Starting Now (30 mins)\n\n` +
                                `👉 Tap the link above to join! Share with your team to invite them.`;
                        } else {
                            try {
                                const meet = await createInstantGoogleMeet(cConf, {
                                    summary: args.topic || "Instant Google Meet",
                                    durationMinutes: 30
                                });
                                resultText = formatInstantMeetForWhatsApp(meet);
                            } catch (err) {
                                const fallbackLink = generateGoogleMeetLink();
                                resultText = `💻 *Google Meet Ready!*\n\n` +
                                    `🔗 *Meeting Link:* ${fallbackLink}\n` +
                                    `📌 *Topic:* *${args.topic || "Instant Google Meet"}*\n` +
                                    `⏰ *Time:* Starting Now (30 mins)\n\n` +
                                    `👉 Tap the link above to join!`;
                            }
                        }
                    } else if (name === "calendar_delete_event") {
                        const cConf = dbUser ? db.getUserIntegration(dbUser.id, "google_calendar") : null;
                        const effCal = getEffectiveCalendarConfig(cConf);
                        if (!effCal.isConfigured) {
                            resultText = "⚠️ Google Calendar is not connected yet.";
                        } else {
                            try {
                                await deleteCalendarEvent(cConf, {
                                    eventId: args.event_id,
                                    searchSummary: args.search_title
                                });
                                resultText = `🗑️ Calendar event canceled and removed from Google Calendar.`;
                            } catch (err) {
                                resultText = `❌ Could not remove calendar event: ${err.message}`;
                            }
                        }
                    } else if (name === "asana_get_tasks") {
                        const aConf = dbUser ? db.getUserIntegration(dbUser.id, "asana") : null;
                        const effAsana = getEffectiveAsanaConfig(aConf);
                        if (!effAsana.isConfigured) {
                            resultText = "⚠️ Asana is not connected yet. Please connect your Asana Personal Access Token in your web dashboard at http://localhost:3000 -> Integrations tab.";
                        } else {
                            try {
                                const tasksResult = await getAsanaTasks(aConf, {
                                    projectId: args.project_id || effAsana.defaultProject || undefined,
                                    completed: args.completed !== undefined ? args.completed : false,
                                    maxResults: args.max_results || 10
                                });
                                if (tasksResult.tasks) {
                                    lastAsanaTasksBySender.set(sender, tasksResult.tasks);
                                }
                                resultText = formatAsanaTasksForWhatsApp(tasksResult);
                            } catch (err) {
                                resultText = `❌ Error loading Asana tasks: ${err.message}`;
                            }
                        }
                    } else if (name === "asana_create_task") {
                        const aConf = dbUser ? db.getUserIntegration(dbUser.id, "asana") : null;
                        const effAsana = getEffectiveAsanaConfig(aConf);
                        if (!effAsana.isConfigured) {
                            resultText = "⚠️ Asana is not connected yet. Please add your Asana token in your web dashboard at http://localhost:3000 -> Integrations tab.";
                        } else {
                            try {
                                const created = await createAsanaTask(aConf, {
                                    name: args.name,
                                    notes: args.notes || "",
                                    dueOn: args.due_on || undefined,
                                    projectId: args.project_id || effAsana.defaultProject || undefined
                                });
                                resultText = formatCreatedAsanaTaskForWhatsApp(created);
                            } catch (err) {
                                resultText = `❌ Could not create Asana task: ${err.message}`;
                            }
                        }
                    } else if (name === "asana_complete_task") {
                        const aConf = dbUser ? db.getUserIntegration(dbUser.id, "asana") : null;
                        const effAsana = getEffectiveAsanaConfig(aConf);
                        if (!effAsana.isConfigured) {
                            resultText = "⚠️ Asana is not connected yet.";
                        } else {
                            const targetTask = await findOrResolveAsanaTask(aConf, sender, args.task_id);
                            if (!targetTask || !targetTask.gid) {
                                resultText = `⚠️ Could not find Asana task '${args.task_id}'. Try "asana list" to view tasks.`;
                            } else {
                                try {
                                    const completed = await completeAsanaTask(aConf, targetTask.gid);
                                    completed.name = targetTask.name || completed.name;
                                    resultText = formatCompletedAsanaTaskForWhatsApp(completed);
                                } catch (err) {
                                    resultText = `❌ Could not complete Asana task: ${err.message}`;
                                }
                            }
                        }
                    } else if (name === "asana_update_task") {
                        const aConf = dbUser ? db.getUserIntegration(dbUser.id, "asana") : null;
                        const effAsana = getEffectiveAsanaConfig(aConf);
                        if (!effAsana.isConfigured) {
                            resultText = "⚠️ Asana is not connected yet.";
                        } else {
                            const targetTask = await findOrResolveAsanaTask(aConf, sender, args.task_id);
                            if (!targetTask || !targetTask.gid) {
                                resultText = `⚠️ Could not find Asana task '${args.task_id}'. Reply 'asana' to see your task list.`;
                            } else {
                                try {
                                    const updates = {};
                                    let changeSummary = "";
                                    if (args.title) {
                                        updates.name = args.title;
                                        changeSummary += `Title: "${args.title}" `;
                                    }
                                    if (args.due_on) {
                                        updates.dueOn = args.due_on;
                                        changeSummary += `Due date: ${args.due_on} `;
                                    }
                                    if (args.notes) {
                                        updates.notes = args.notes;
                                        changeSummary += `Notes updated `;
                                    }
                                    if (args.completed !== undefined) {
                                        updates.completed = Boolean(args.completed);
                                        changeSummary += args.completed ? `Marked complete ` : `Reopened `;
                                    }
                                    const updated = await updateAsanaTask(aConf, targetTask.gid, updates);
                                    resultText = formatUpdatedAsanaTaskForWhatsApp(updated, changeSummary.trim());
                                } catch (err) {
                                    resultText = `❌ Could not update Asana task: ${err.message}`;
                                }
                            }
                        }
                    } else if (name === "asana_create_project") {
                        const aConf = dbUser ? db.getUserIntegration(dbUser.id, "asana") : null;
                        const effAsana = getEffectiveAsanaConfig(aConf);
                        if (!effAsana.isConfigured) {
                            resultText = "⚠️ Asana is not connected yet. Please add your Asana token in your web dashboard at http://localhost:3000 -> Integrations tab.";
                        } else {
                            try {
                                const project = await createAsanaProject(aConf, {
                                    name: args.name,
                                    notes: args.notes || "",
                                    color: args.color || undefined
                                });
                                resultText = formatCreatedAsanaProjectForWhatsApp(project);
                            } catch (err) {
                                resultText = `❌ Could not create Asana project: ${err.message}`;
                            }
                        }
                    } else if (name === "asana_add_comment") {
                        const aConf = dbUser ? db.getUserIntegration(dbUser.id, "asana") : null;
                        const effAsana = getEffectiveAsanaConfig(aConf);
                        if (!effAsana.isConfigured) {
                            resultText = "⚠️ Asana is not connected yet.";
                        } else {
                            const targetTask = await findOrResolveAsanaTask(aConf, sender, args.task_id);
                            if (!targetTask || !targetTask.gid) {
                                resultText = `⚠️ Could not find Asana task '${args.task_id}'.`;
                            } else {
                                try {
                                    await addAsanaComment(aConf, { taskGid: targetTask.gid, comment: args.comment || args.text });
                                    resultText = `💬 Comment added to Asana task *${targetTask.name || ""}*!`;
                                } catch (err) {
                                    resultText = `❌ Could not add comment to Asana task: ${err.message}`;
                                }
                            }
                        }
                    } else if (name === "email_draft") {
                        if (!dbUser) {
                            resultText = "⚠️ Please link your account in the web dashboard at http://localhost:3000 to draft emails.";
                        } else {
                            try {
                                const draft = db.createEmailDraft(dbUser.id, args.to, args.subject, args.body);
                                resultText = formatDraftForWhatsApp(draft, true);
                            } catch (err) {
                                resultText = `❌ Could not save email draft: ${err.message}`;
                            }
                        }
                    } else if (name === "email_send") {
                        if (!dbUser) {
                            resultText = "⚠️ Please link your account in the web dashboard at http://localhost:3000 to send emails.";
                        } else {
                            const eConf = db.getUserIntegration(dbUser.id, "email");
                            const effEmail = getEffectiveEmailConfig(eConf);
                            if (!effEmail.isConfigured) {
                                resultText = "⚠️ Gmail is not connected yet. Please add your Gmail address and 16-character App Password at http://localhost:3000 -> Integrations tab.";
                            } else {
                                try {
                                    let to = args.to;
                                    let subject = args.subject;
                                    let body = args.body;
                                    let draftId = args.draft_id;

                                    if (draftId) {
                                        const draft = db.getEmailDraftById(draftId, dbUser.id);
                                        if (draft) {
                                            to = to || draft.recipient;
                                            subject = subject || draft.subject;
                                            body = body || draft.body;
                                        }
                                    }

                                    const sent = await sendEmail(eConf, { to, subject, body });
                                    if (draftId) {
                                        db.updateEmailDraft(draftId, dbUser.id, { status: "sent" });
                                    }
                                    resultText = formatSentEmailForWhatsApp(sent);
                                } catch (err) {
                                    resultText = `❌ Could not send email: ${err.message}`;
                                }
                            }
                        }
                    } else if (name === "email_list_drafts") {
                        if (!dbUser) {
                            resultText = "⚠️ Please link your account in the web dashboard first.";
                        } else {
                            const drafts = db.getUserEmailDrafts(dbUser.id, "draft");
                            resultText = formatDraftListForWhatsApp(drafts);
                        }
                    } else if (name === "drive_list_files") {
                        const dConf = dbUser ? db.getUserIntegration(dbUser.id, "google_drive") : null;
                        const effDrive = getEffectiveDriveConfig(dConf);
                        if (!effDrive.isConfigured) {
                            resultText = "⚠️ Google Drive is not connected yet. Please connect your Google Drive in your web dashboard at http://localhost:3000 -> Integrations tab.";
                        } else {
                            try {
                                const filesResult = await listDriveFiles(dConf, {
                                    folderId: args.folder_id || undefined,
                                    pageSize: args.max_results || 10
                                });
                                resultText = formatDriveFilesForWhatsApp(filesResult);
                            } catch (err) {
                                resultText = `❌ Error loading Google Drive: ${err.message}`;
                            }
                        }
                    } else if (name === "drive_search_files") {
                        const dConf = dbUser ? db.getUserIntegration(dbUser.id, "google_drive") : null;
                        const effDrive = getEffectiveDriveConfig(dConf);
                        if (!effDrive.isConfigured) {
                            resultText = "⚠️ Google Drive is not connected yet. Please connect your Google Drive in your web dashboard at http://localhost:3000 -> Integrations tab.";
                        } else {
                            try {
                                const searchResult = await searchDriveFiles(dConf, {
                                    query: args.query,
                                    pageSize: args.max_results || 10
                                });
                                resultText = formatDriveFilesForWhatsApp(searchResult);
                            } catch (err) {
                                resultText = `❌ Error searching Google Drive: ${err.message}`;
                            }
                        }
                    } else if (name === "drive_create_folder") {
                        const dConf = dbUser ? db.getUserIntegration(dbUser.id, "google_drive") : null;
                        const effDrive = getEffectiveDriveConfig(dConf);
                        if (!effDrive.isConfigured) {
                            resultText = "⚠️ Google Drive is not connected yet. Please link your Google Drive in your web dashboard at http://localhost:3000 -> Integrations tab.";
                        } else {
                            try {
                                const folder = await createDriveFolder(dConf, {
                                    folderName: args.folder_name
                                });
                                resultText = formatFolderCreatedForWhatsApp(folder);
                            } catch (err) {
                                resultText = `❌ Could not create Google Drive folder: ${err.message}`;
                            }
                        }
                    } else if (name === "drive_share_file") {
                        const dConf = dbUser ? db.getUserIntegration(dbUser.id, "google_drive") : null;
                        const effDrive = getEffectiveDriveConfig(dConf);
                        if (!effDrive.isConfigured) {
                            resultText = "⚠️ Google Drive is not connected yet.";
                        } else {
                            try {
                                let fileId = args.file_id;
                                if (!fileId && args.search_name) {
                                    const searchRes = await listDriveFiles(dConf, { query: args.search_name, pageSize: 3 });
                                    if (searchRes.files && searchRes.files.length > 0) {
                                        fileId = searchRes.files[0].id;
                                    }
                                }
                                if (!fileId) {
                                    resultText = `⚠️ Could not find file "${args.search_name || ""}" to share on Google Drive.`;
                                } else {
                                    const shared = await shareDriveFile(dConf, { fileId });
                                    resultText = `🔗 *Google Drive Share Link:*\n\n• *File:* ${shared.name}\n• *Link:* ${shared.webViewLink}\n• *Access:* Anyone with link can view`;
                                }
                            } catch (err) {
                                resultText = `❌ Could not share Google Drive file: ${err.message}`;
                            }
                        }
                    } else if (name === "drive_delete_file") {
                        const dConf = dbUser ? db.getUserIntegration(dbUser.id, "google_drive") : null;
                        const effDrive = getEffectiveDriveConfig(dConf);
                        if (!effDrive.isConfigured) {
                            resultText = "⚠️ Google Drive is not connected yet.";
                        } else {
                            try {
                                const deleted = await deleteDriveFile(dConf, {
                                    fileId: args.file_id,
                                    searchName: args.search_name
                                });
                                resultText = `🗑️ ${deleted.message}`;
                            } catch (err) {
                                resultText = `❌ Could not delete Google Drive file: ${err.message}`;
                            }
                        }
                    } else if (name === "drive_upload_text") {
                        const dConf = dbUser ? db.getUserIntegration(dbUser.id, "google_drive") : null;
                        const effDrive = getEffectiveDriveConfig(dConf);
                        if (!effDrive.isConfigured) {
                            resultText = "⚠️ Google Drive is not connected yet. Please connect Google Drive in your web dashboard at http://localhost:3000 -> Integrations tab.";
                        } else {
                            try {
                                let fName = (args.file_name || "Note").trim();
                                if (!fName.includes(".")) fName += ".txt";
                                const buffer = Buffer.from((args.content || "").trim(), "utf-8");
                                const uploaded = await uploadDriveFile(dConf, {
                                    fileName: fName,
                                    mimeType: "text/plain",
                                    buffer
                                });
                                resultText = formatUploadedFileForWhatsApp(uploaded);
                            } catch (err) {
                                resultText = `❌ Could not upload note to Google Drive: ${formatDriveApiError(err, effDrive)}`;
                            }
                        }
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