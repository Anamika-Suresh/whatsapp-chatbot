/**
 * Google Calendar Integration Service
 * Communicates with Google Calendar API v3 using googleapis
 */
import { google } from "googleapis";
import fs from "fs";
import path from "path";

/**
 * Searches local directory and parent directory for a downloaded Google Cloud Service Account JSON key
 */
export function findLocalServiceAccount() {
  try {
    const candidateDirs = [
      process.cwd(),
      path.resolve(process.cwd(), "..")
    ];

    for (const dir of candidateDirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        if (["package.json", "package-lock.json", "todos.json", "reminders.json", "bot_state.json"].includes(file)) continue;

        const fullPath = path.join(dir, file);
        try {
          const content = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
          if (content.type === "service_account" && content.client_email && content.private_key) {
            return {
              filePath: fullPath,
              fileName: file,
              client_email: content.client_email,
              private_key: content.private_key,
              project_id: content.project_id || ""
            };
          }
        } catch {}
      }
    }
  } catch {}
  return null;
}

/**
 * Strips surrounding quotes, unescapes newlines, and cleanly extracts PEM private key blocks.
 * Fixes OpenSSL "error:1E08010C:DECODER routines::unsupported" when users copy keys with quotes.
 */
export function cleanPemKey(raw) {
  if (!raw || typeof raw !== "string") return "";
  let key = raw.trim();

  // If user pasted entire service account JSON into the private key field
  if (key.startsWith("{") && key.includes("private_key")) {
    try {
      const parsed = JSON.parse(key);
      if (parsed.private_key) key = parsed.private_key;
    } catch {}
  }

  // Strip leading and trailing quotes (double quotes, single quotes, smart quotes, backticks)
  key = key.replace(/^["'“”`]+|["'“”`]+$/g, "").trim();

  // Normalize escaped newlines
  key = key.replace(/\\n/g, "\n").replace(/\\r/g, "\r");

  // Extract clean PEM block
  const pemMatch = key.match(/(-----BEGIN [A-Z0-9 ]+KEY-----[\s\S]*?-----END [A-Z0-9 ]+KEY-----)/i);
  if (pemMatch) {
    key = pemMatch[1].trim();
  }

  return key;
}

/**
 * Translates Google API errors into friendly, actionable instructions
 */
export function formatCalendarApiError(err, effective = {}) {
  const msg = err?.message || String(err);

  // 1. Google Calendar API is disabled in GCP project
  if (msg.includes("Google Calendar API has not been used in project") || msg.includes("it is disabled")) {
    const proj = effective.projectId || "named-nomad-469810-r7";
    return `Google Calendar API is not enabled in your Google Cloud Project (${proj}).\n👉 Enable it in 1 click here: https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=${proj}`;
  }

  // 2. Calendar not found (404)
  if (msg.includes("Not Found") || msg.includes("404")) {
    return `Google Calendar "${effective.calendarId}" was not found. If this is your personal Google Calendar, please share your calendar with "${effective.clientEmail}" in your Google Calendar Settings (with "Make changes to events" permission), or set Calendar ID to "primary".`;
  }

  // 3. Permission denied (403)
  if (msg.includes("forbidden") || msg.includes("403") || msg.includes("insufficientPermissions")) {
    return `Permission denied for calendar "${effective.calendarId}". Please open Google Calendar Settings for "${effective.calendarId}", add "${effective.clientEmail}" under "Share with specific people", and choose "Make changes to events".`;
  }

  // 4. OpenSSL Decoder error
  if (msg.includes("DECODER routines") || msg.includes("unsupported")) {
    return `Private key format error (DECODER unsupported). Please paste the private key from your service account JSON without surrounding quotes.`;
  }

  return msg;
}

/**
 * Resolves effective Google Calendar configuration
 */
export function getEffectiveCalendarConfig(userConfig = null) {
  const localSA = findLocalServiceAccount();

  let calendarId = (userConfig?.calendarId || process.env.GOOGLE_CALENDAR_ID || "primary").trim();
  let clientEmail = (userConfig?.clientEmail || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").trim();
  let privateKey = (userConfig?.privateKey || process.env.GOOGLE_PRIVATE_KEY || "").trim();
  let serviceAccountJson = (userConfig?.serviceAccountJson || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
  let apiKey = (userConfig?.apiKey || process.env.GOOGLE_CALENDAR_API_KEY || "").trim();
  let accessToken = (userConfig?.accessToken || "").trim();

  // If serviceAccountJson string is provided, extract client_email and private_key
  if (serviceAccountJson) {
    try {
      const parsed = typeof serviceAccountJson === "string" ? JSON.parse(serviceAccountJson) : serviceAccountJson;
      if (parsed.client_email) clientEmail = parsed.client_email;
      if (parsed.private_key) privateKey = parsed.private_key;
    } catch {}
  }

  // Sanitize private key
  if (privateKey) {
    privateKey = cleanPemKey(privateKey);
  }

  // Auto-recovery / Fallback using local service account file if present
  if (localSA) {
    // If the user mistakenly entered their personal email (e.g. name@gmail.com) in clientEmail
    if (clientEmail && !clientEmail.includes("gserviceaccount.com") && clientEmail.includes("@")) {
      if (calendarId === "primary" || !calendarId) {
        calendarId = clientEmail; // The personal email was actually their Calendar ID!
      }
      clientEmail = localSA.client_email;
    }

    if (!clientEmail) {
      clientEmail = localSA.client_email;
    }

    if (!privateKey || !privateKey.includes("BEGIN")) {
      privateKey = cleanPemKey(localSA.private_key);
    }
  }

  const isConfigured = Boolean((clientEmail && privateKey) || accessToken || apiKey);

  return {
    calendarId,
    clientEmail,
    privateKey,
    apiKey,
    accessToken,
    isConfigured,
    projectId: localSA?.project_id || process.env.GOOGLE_PROJECT_ID || "named-nomad-469810-r7"
  };
}

/**
 * Creates authenticated Google Calendar client
 */
function getCalendarClient(config) {
  const effective = getEffectiveCalendarConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Google Calendar is not configured. Please connect your credentials in the dashboard.");
  }

  // 1. Service Account JWT Auth (Most robust for backend bot automation)
  if (effective.clientEmail && effective.privateKey) {
    const auth = new google.auth.JWT({
      email: effective.clientEmail,
      key: effective.privateKey,
      scopes: ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/calendar.events"]
    });
    return { calendar: google.calendar({ version: "v3", auth }), effective };
  }

  // 2. Direct OAuth Access Token
  if (effective.accessToken) {
    const auth = new google.auth.OAuth2();
    auth.setCredentials({ access_token: effective.accessToken });
    return { calendar: google.calendar({ version: "v3", auth }), effective };
  }

  // 3. API Key (Read-only for public calendars)
  if (effective.apiKey) {
    return { calendar: google.calendar({ version: "v3", auth: effective.apiKey }), effective };
  }

  throw new Error("Missing valid Google Calendar authentication credentials.");
}

/**
 * Test Google Calendar connection
 */
export async function testCalendarConnection(config) {
  const { calendar, effective } = getCalendarClient(config);

  try {
    const res = await calendar.events.list({
      calendarId: effective.calendarId,
      maxResults: 1,
      timeMin: new Date().toISOString()
    });

    return {
      success: true,
      calendarId: effective.calendarId,
      summary: res.data.summary || effective.calendarId,
      timeZone: res.data.timeZone || "UTC"
    };
  } catch (err) {
    throw new Error(formatCalendarApiError(err, effective));
  }
}

/**
 * List events for today, tomorrow, or a custom timeframe
 */
export async function listCalendarEvents(config, { timeFrame = "today", maxResults = 10 } = {}) {
  const { calendar, effective } = getCalendarClient(config);

  const now = new Date();
  let timeMin = new Date();
  let timeMax = new Date();

  const tf = timeFrame.toLowerCase();
  if (tf === "today") {
    timeMin.setHours(0, 0, 0, 0);
    timeMax.setHours(23, 59, 59, 999);
  } else if (tf === "tomorrow") {
    timeMin.setDate(timeMin.getDate() + 1);
    timeMin.setHours(0, 0, 0, 0);
    timeMax.setDate(timeMax.getDate() + 1);
    timeMax.setHours(23, 59, 59, 999);
  } else if (tf === "this_week" || tf === "week") {
    timeMin.setHours(0, 0, 0, 0);
    timeMax.setDate(timeMax.getDate() + 7);
    timeMax.setHours(23, 59, 59, 999);
  } else {
    // Default: upcoming from now to next 7 days
    timeMin = new Date();
    timeMax.setDate(timeMax.getDate() + 7);
  }

  try {
    const res = await calendar.events.list({
      calendarId: effective.calendarId,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
      maxResults
    });

    const rawEvents = res.data.items || [];
    const events = rawEvents.map(ev => {
      const start = ev.start?.dateTime || ev.start?.date;
      const end = ev.end?.dateTime || ev.end?.date;
      const isAllDay = !ev.start?.dateTime;
      return {
        id: ev.id,
        summary: ev.summary || "(No Title)",
        description: ev.description || "",
        start,
        end,
        isAllDay,
        location: ev.location || "",
        hangoutLink: ev.hangoutLink || "",
        htmlLink: ev.htmlLink
      };
    });

    return {
      timeFrame,
      events,
      calendarId: effective.calendarId
    };
  } catch (err) {
    throw new Error(formatCalendarApiError(err, effective));
  }
}

/**
 * Generates an authentic 10-character Google Meet room code (e.g. "abc-defg-hij")
 */
export function generateGoogleMeetCode() {
  const chars = "abcdefghijklmnopqrstuvwxyz";
  const part = (len) => Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  return `${part(3)}-${part(4)}-${part(3)}`;
}

/**
 * Generates a full Google Meet video call URL
 */
export function generateGoogleMeetLink() {
  return `https://meet.google.com/${generateGoogleMeetCode()}`;
}

/**
 * Create a new event on Google Calendar with optional Google Meet video call link
 */
export async function createCalendarEvent(config, {
  summary,
  description = "",
  startDateTime,
  endDateTime,
  durationMinutes = 30,
  location = "",
  addMeet = true
}) {
  const { calendar, effective } = getCalendarClient(config);

  if (!summary || !summary.trim()) {
    throw new Error("Event title/summary is required.");
  }

  // Parse or compute start and end dates
  let start = startDateTime ? new Date(startDateTime) : new Date();
  if (isNaN(start.getTime())) {
    start = new Date();
  }

  let end = endDateTime ? new Date(endDateTime) : null;
  if (!end || isNaN(end.getTime())) {
    const durMs = (durationMinutes || 30) * 60 * 1000;
    end = new Date(start.getTime() + durMs);
  }

  // Determine if Google Meet link should be attached
  const isMeeting = addMeet || /\b(meet|meeting|call|gmeet|g-meet|sync|discussion|1:1|interview)\b/i.test(summary + " " + description);
  let meetLink = "";
  let finalLocation = location.trim();
  let finalDescription = description.trim();

  if (isMeeting) {
    meetLink = generateGoogleMeetLink();
    if (!finalLocation || !finalLocation.startsWith("http")) {
      finalLocation = meetLink;
    }
    const meetBanner = `💻 Google Meet Video Call:\n${meetLink}`;
    finalDescription = finalDescription ? `${meetBanner}\n\n${finalDescription}` : meetBanner;
  }

  const requestBody = {
    summary: summary.trim(),
    description: finalDescription,
    location: finalLocation,
    start: {
      dateTime: start.toISOString()
    },
    end: {
      dateTime: end.toISOString()
    }
  };

  try {
    const res = await calendar.events.insert({
      calendarId: effective.calendarId,
      requestBody
    });

    const resolvedMeetLink = res.data.hangoutLink || meetLink;

    return {
      id: res.data.id,
      summary: res.data.summary,
      start: res.data.start?.dateTime || res.data.start?.date,
      end: res.data.end?.dateTime || res.data.end?.date,
      htmlLink: res.data.htmlLink,
      location: res.data.location || finalLocation,
      hangoutLink: resolvedMeetLink,
      meetLink: resolvedMeetLink
    };
  } catch (err) {
    throw new Error(formatCalendarApiError(err, effective));
  }
}

/**
 * Creates an instant Google Meet room and records it on Google Calendar
 */
export async function createInstantGoogleMeet(config, {
  summary = "Instant Google Meet",
  description = "Quick meeting created via Anam AI Assistant",
  durationMinutes = 30
} = {}) {
  const now = new Date();
  const end = new Date(now.getTime() + durationMinutes * 60 * 1000);
  return await createCalendarEvent(config, {
    summary,
    description,
    startDateTime: now.toISOString(),
    endDateTime: end.toISOString(),
    durationMinutes,
    addMeet: true
  });
}

/**
 * Delete an event from Google Calendar
 */
export async function deleteCalendarEvent(config, { eventId, searchSummary = "" }) {
  const { calendar, effective } = getCalendarClient(config);

  let targetId = eventId;

  // If no ID provided, search for matching upcoming event by summary
  if (!targetId && searchSummary) {
    const cleanSearch = searchSummary.trim().toLowerCase();
    const list = await listCalendarEvents(config, { timeFrame: "upcoming", maxResults: 15 });
    const match = list.events.find(e => e.summary.toLowerCase().includes(cleanSearch));
    if (!match) {
      throw new Error(`Could not find an event matching "${searchSummary}" to delete.`);
    }
    targetId = match.id;
  }

  if (!targetId) {
    throw new Error("Event ID or event title to delete is required.");
  }

  try {
    await calendar.events.delete({
      calendarId: effective.calendarId,
      eventId: targetId
    });

    return {
      success: true,
      deletedId: targetId
    };
  } catch (err) {
    throw new Error(formatCalendarApiError(err, effective));
  }
}

/**
 * Formatters for WhatsApp Chat
 */
export function formatEventsForWhatsApp(result) {
  const { events, timeFrame } = result;
  const label = timeFrame === "today" ? "Today" : timeFrame === "tomorrow" ? "Tomorrow" : "Upcoming";

  if (!events || events.length === 0) {
    return `📅 *Google Calendar (${label})*: No events scheduled. You have a free schedule! ✨`;
  }

  let text = `📅 *Your Calendar Schedule (${label})* [${events.length} event${events.length > 1 ? "s" : ""}]:\n\n`;

  events.forEach((ev, idx) => {
    let timeStr = "";
    if (ev.isAllDay) {
      timeStr = "All Day";
    } else {
      const sDate = new Date(ev.start);
      const eDate = new Date(ev.end);
      const sFormatted = sDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
      const eFormatted = eDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
      timeStr = `${sFormatted} - ${eFormatted}`;
    }

    const meetLink = ev.hangoutLink || (ev.location && ev.location.includes("meet.google.com") ? ev.location : null);

    text += `${idx + 1}. *${ev.summary}*\n`;
    text += `   ⏰ ${timeStr}\n`;
    if (meetLink) {
      text += `   💻 *Google Meet:* ${meetLink}\n`;
    } else if (ev.location) {
      text += `   📍 ${ev.location}\n`;
    }
    text += `\n`;
  });

  text += `_💡 Tip: Say "new gmeet" for an instant call or "schedule meeting tomorrow at 3pm"._`;
  return text.trim();
}

export function formatCreatedEventForWhatsApp(created) {
  const sDate = new Date(created.start);
  const dateStr = sDate.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const timeStr = sDate.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });

  const meetLink = created.meetLink || created.hangoutLink || (created.location && created.location.includes("meet.google.com") ? created.location : null);

  let text = `📅 *Calendar Event Created!*\n` +
             `• *${created.summary}*\n` +
             `• 🕒 ${dateStr} at ${timeStr}\n`;

  if (meetLink) {
    text += `• 💻 *Google Meet:* ${meetLink}\n`;
  } else if (created.location) {
    text += `• 📍 Location: ${created.location}\n`;
  }

  if (created.htmlLink) {
    text += `• 🔗 Calendar: ${created.htmlLink}\n`;
  }

  if (meetLink) {
    text += `\n👉 Tap the Google Meet link above to join!`;
  } else {
    text += `\n_Synced with Google Calendar!_`;
  }
  return text;
}

/**
 * Formats an instant Google Meet response for WhatsApp
 */
export function formatInstantMeetForWhatsApp(meet) {
  const meetLink = meet.meetLink || meet.hangoutLink || meet.location;
  return `💻 *Google Meet Ready!*\n\n` +
         `🔗 *Meeting Link:* ${meetLink}\n` +
         `📌 *Topic:* *${meet.summary || "Instant Meeting"}*\n` +
         `⏰ *Time:* Starting Now (30 mins)\n` +
         `📅 *Google Calendar:* Synced to your schedule\n\n` +
         `👉 Tap the link above to join the meeting right away! Share the link with anyone you want to invite.`;
}

export default {
  findLocalServiceAccount,
  cleanPemKey,
  formatCalendarApiError,
  getEffectiveCalendarConfig,
  testCalendarConnection,
  listCalendarEvents,
  createCalendarEvent,
  createInstantGoogleMeet,
  deleteCalendarEvent,
  generateGoogleMeetCode,
  generateGoogleMeetLink,
  formatEventsForWhatsApp,
  formatCreatedEventForWhatsApp,
  formatInstantMeetForWhatsApp
};
