import { makeWASocket, useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import { GoogleGenAI, Type } from "@google/genai";
import qrcode from "qrcode-terminal";
import pino from "pino";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

// 1. AI Initialization
const geminiApiKey = process.env.GEMINI_API_KEY || "";
const geminiModel = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const ai = geminiApiKey ? new GoogleGenAI({ apiKey: geminiApiKey }) : null;

// 2. Persistent To-Do File Store
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

// 3. Sent Messages ID Tracker (Prevents self-chat infinite loops)
const sentMessageIds = new Set();
async function sendReply(sock, sender, content) {
    const sent = await sock.sendMessage(sender, content);
    if (sent?.key?.id) {
        sentMessageIds.add(sent.key.id);
        // Clean up from memory after 5 minutes
        setTimeout(() => sentMessageIds.delete(sent.key.id), 5 * 60 * 1000);
    }
    return sent;
}

// 4. Conversational Memory & Active Session Tracker
const userSessions = new Map();
const SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes inactivity timeout

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
        const res = await ai.models.generateContent({
            model: geminiModel,
            contents: prompt
        });
        session.summary = res.text?.trim() || session.summary;
        console.log(`[Memory] Updated summary for ${sender}: ${session.summary}`);
    } catch (err) {
        console.error("[Memory] Error condensing memory:", err.message);
    }
}

// 5. Tools Definition for Gemini
const botTools = [
    {
        functionDeclarations: [
            {
                name: "set_reminder",
                description: "Set a time-based countdown reminder for a specific duration in seconds. ALWAYS use this whenever the user asks for a reminder with a time delay (e.g. 'remind me in 5 minutes to stretch', 'remind 10m water', 'set reminder 30s').",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        delay_seconds: { type: Type.NUMBER, description: "Delay in seconds from now (e.g. 60 for 1m, 300 for 5m, 3600 for 1h)" },
                        task: { type: Type.STRING, description: "What to remind the user about" }
                    },
                    required: ["delay_seconds", "task"]
                }
            },
            {
                name: "set_alarm",
                description: "Set a clock alarm for an exact time of day (24-hour format HH:MM, e.g. 07:30 or 22:00). Use when user asks for clock alarms or wake-up times.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        time_24h: { type: Type.STRING, description: "Time in 24-hour format HH:MM (e.g. 07:30, 21:15)" },
                        label: { type: Type.STRING, description: "Alarm label or reason" }
                    },
                    required: ["time_24h"]
                }
            },
            {
                name: "add_todo",
                description: "Add a task or item to the user's checklist/to-do list WITHOUT a time trigger (e.g. 'add milk to todo', 'todo: buy groceries', 'add call doctor to list'). DO NOT use for timed reminders.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {
                        task: { type: Type.STRING, description: "Task or item description" }
                    },
                    required: ["task"]
                }
            },
            {
                name: "get_todos",
                description: "Retrieve all active to-do items from the user's checklist. Use when user asks 'show tasks', 'what are my tasks', 'my todo list', 'todos', 'pending tasks'.",
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
                        task_number: { type: Type.NUMBER, description: "1-based task index in the list" }
                    },
                    required: ["task_number"]
                }
            },
            {
                name: "clear_memory",
                description: "Clear and wipe all conversation memory when user asks to forget history or start fresh.",
                parameters: {
                    type: Type.OBJECT,
                    properties: {}
                }
            }
        ]
    }
];

function scheduleAlarm(sock, sender, timeStr, label) {
    const match = timeStr.match(/^([0-1]?[0-9]|2[0-3]):([0-5][0-9])$/);
    if (!match) return { success: false, message: "Invalid 24-hour time format (use HH:MM)." };

    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    const now = new Date();
    const target = new Date();
    target.setHours(hours, minutes, 0, 0);

    if (target.getTime() <= now.getTime()) {
        target.setDate(target.getDate() + 1);
    }

    const delayMs = target.getTime() - now.getTime();
    const formatted = target.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    setTimeout(async () => {
        await sendReply(sock, sender, {
            text: `🚨⏰ *ALARM RINGING [${formatted}]:* ${label || "Alarm"} ⏰🚨`
        });
    }, delayMs);

    return { success: true, targetTime: formatted, minutesFromNow: Math.round(delayMs / 60000) };
}

// 6. Main Bot Engine
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
        }
    });

    sock.ev.on("messages.upsert", async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message) return;

        // 1. Completely ignore messages sent by the bot (prevents all loops)
        if (sentMessageIds.has(msg.key.id)) {
            sentMessageIds.delete(msg.key.id);
            return;
        }

        const sender = msg.key.remoteJid;
        const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
        if (!text) return;

        // 2. Extra safety: ignore automated bot response prefixes
        const botPrefixes = ["⏰", "🚨", "📋", "🤖", "✅", "👋", "🧹", "📝", "🎉", "❌", "⚠️", "pong!"];
        if (botPrefixes.some(prefix => text.startsWith(prefix))) {
            return;
        }

        const session = getSession(sender);
        const lower = text.toLowerCase();
        const wakeWordRegex = /^\s*hey\s+anam[,:\s]*/i;

        // 3. Direct Memory Clear
        if (lower === "!clear" || lower === "clear memory") {
            clearSession(sender);
            await sendReply(sock, sender, { text: "🧹 *Memory cleared & session reset!*" });
            return;
        }

        // 4. Session Close Commands
        const closePhrases = ["bye", "bye anam", "exit", "quit", "goodbye", "stop", "close session", "!exit"];
        if (session.isActive && closePhrases.includes(lower)) {
            session.isActive = false;
            await sendReply(sock, sender, { text: "👋 *Session ended!* Say *'Hey Anam'* whenever you need me again." });
            return;
        }

        // 5. Check Wake-Word or Active Session
        let userPrompt = text;
        const isWakeWord = wakeWordRegex.test(text);

        if (isWakeWord) {
            session.isActive = true;
            userPrompt = text.replace(wakeWordRegex, "").trim();
        } else if (!session.isActive) {
            return; // Ignore regular messages when session is closed
        }

        console.log(`[Anam Received] From: ${sender} | Prompt: "${userPrompt || '<Session Started>'}"`);

        // If user only typed "Hey Anam"
        if (isWakeWord && !userPrompt) {
            const intro = `👋 *Hey! I'm listening.*

You don't need to repeat "Hey Anam". Just type what you want:
• *"remind me in 10 minutes to drink water"* (Timer)
• *"alarm 07:00 wake up"* (Clock Alarm)
• *"add buy milk to my list"* (To-Do)
• *"show tasks"* or *"done 1"*
• Ask any general question!

_Type *"bye"* or *"exit"* when done._`;

            session.history.push({ role: "model", parts: [{ text: intro }] });
            await sendReply(sock, sender, { text: intro });
            return;
        }

        if (!ai) {
            await sendReply(sock, sender, {
                text: `⚠️ *Gemini API Key missing!* Add \`GEMINI_API_KEY=your_key\` in \`.env\`.`
            });
            return;
        }

        // 6. Refined System Instruction with Strict Tool Disambiguation
        const systemInstruction = `You are Anam, a smart WhatsApp assistant.
Current Local Time: ${new Date().toLocaleString()}
${session.summary ? `Previous Conversation Summary: "${session.summary}"` : ""}

CRITICAL TOOL DISAMBIGUATION RULES:
1. TIMED REMINDERS: If the user asks for a reminder with a duration or time (e.g. 'remind me in 5m to X', 'remind 10m water', 'set reminder 30s to call John'), ALWAYS call 'set_reminder'. NEVER call 'add_todo' for timed reminders.
2. CLOCK ALARMS: If the user asks for a clock alarm at a specific time of day (e.g. 'alarm 7am', 'wake me at 07:30', 'alarm 22:00'), ALWAYS call 'set_alarm' (convert to 24h format HH:MM).
3. TO-DO CHECKLIST: Only call 'add_todo' when the user wants to add an item to their static to-do list without a time trigger (e.g. 'add milk to list', 'todo buy eggs').
4. SHOW TASKS: Call 'get_todos' when the user asks 'show tasks', 'what are my tasks', 'my todo list', 'todos'.
5. COMPLETE TASK: Call 'complete_todo' when user says 'done 1', 'check off 2'.

Format all responses cleanly in WhatsApp markdown (*bold*, _italics_, \`code\`).`;

        session.history.push({ role: "user", parts: [{ text: userPrompt }] });

        try {
            const contents = [...session.history];

            const response = await ai.models.generateContent({
                model: geminiModel,
                contents,
                config: {
                    systemInstruction,
                    tools: botTools
                }
            });

            if (response.functionCalls && response.functionCalls.length > 0) {
                for (const call of response.functionCalls) {
                    const { name, args } = call;
                    let resultText = "";

                    if (name === "set_reminder") {
                        const seconds = args.delay_seconds || 60;
                        const task = args.task || "Reminder";
                        setTimeout(async () => {
                            await sendReply(sock, sender, { text: `🚨 *REMINDER:* ${task}` });
                        }, seconds * 1000);
                        resultText = `⏰ Reminder set for *${seconds >= 60 ? Math.round(seconds/60) + ' min(s)' : seconds + ' sec(s)'}*: "${task}"`;
                    } else if (name === "set_alarm") {
                        const res = scheduleAlarm(sock, sender, args.time_24h, args.label);
                        resultText = res.success 
                            ? `⏰ Alarm set for *${res.targetTime}* (${res.minutesFromNow} mins from now): "${args.label || 'Alarm'}"`
                            : `❌ Failed to set alarm: ${res.message}`;
                    } else if (name === "add_todo") {
                        const todos = loadTodos();
                        const userTodos = todos[sender] || [];
                        userTodos.push(args.task);
                        todos[sender] = userTodos;
                        saveTodos(todos);
                        resultText = `✅ Added to list: *"${args.task}"* (Total: ${userTodos.length})`;
                    } else if (name === "get_todos") {
                        const todos = loadTodos();
                        const userTodos = todos[sender] || [];
                        if (userTodos.length === 0) {
                            resultText = "📝 Your to-do list is empty!";
                        } else {
                            const list = userTodos.map((t, i) => `${i + 1}. ${t}`).join("\n");
                            resultText = `📝 *Your Tasks:*\n${list}`;
                        }
                    } else if (name === "complete_todo") {
                        const todos = loadTodos();
                        const userTodos = todos[sender] || [];
                        const idx = args.task_number;
                        if (idx >= 1 && idx <= userTodos.length) {
                            const removed = userTodos.splice(idx - 1, 1);
                            todos[sender] = userTodos;
                            saveTodos(todos);
                            resultText = `🎉 Completed & removed: *"${removed[0]}"*`;
                        } else {
                            resultText = "❌ Invalid task number.";
                        }
                    } else if (name === "clear_memory") {
                        clearSession(sender);
                        resultText = "🧹 *Memory cleared!* Starting fresh.";
                    }

                    session.history.push({ role: "model", parts: [{ text: resultText }] });
                    await sendReply(sock, sender, { text: resultText });
                }
            } else {
                const reply = response.text || "I didn't catch that.";
                session.history.push({ role: "model", parts: [{ text: reply }] });
                await sendReply(sock, sender, { text: `🤖 *Anam:* ${reply}` });
            }

            condenseSessionMemory(sender);

        } catch (err) {
            console.error("Bot Error:", err);
            await sendReply(sock, sender, { text: `❌ Error: ${err.message}` });
        }
    });
}

startBot();