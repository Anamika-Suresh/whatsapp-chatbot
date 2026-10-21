/**
 * Email Integration Service (Gmail via App Password / Nodemailer)
 * Supports drafting, reviewing, editing, and sending emails from WhatsApp and Dashboard
 */
import nodemailer from "nodemailer";

/**
 * Normalizes email and strips spaces from 16-character Google App Passwords
 * (e.g. "abcd efgh ijkl mnop" -> "abcdefghijklmnop")
 */
export function cleanAppPassword(pass) {
  if (!pass || typeof pass !== "string") return "";
  return pass.trim().replace(/\s+/g, "");
}

/**
 * Retrieves the effective email configuration for a user or environment fallback
 */
export function getEffectiveEmailConfig(userConfig = {}) {
  const email = (userConfig?.email || process.env.GMAIL_USER || process.env.EMAIL_USER || "").trim();
  const rawPass = userConfig?.appPassword || process.env.GMAIL_APP_PASSWORD || process.env.EMAIL_APP_PASSWORD || "";
  const appPassword = cleanAppPassword(rawPass);
  const senderName = (userConfig?.senderName || process.env.EMAIL_SENDER_NAME || "Anamika").trim();

  const isConfigured = Boolean(email && appPassword && email.includes("@"));

  return {
    email,
    user: email,
    appPassword,
    senderName,
    isConfigured
  };
}

/**
 * Creates a configured Nodemailer transporter for Gmail
 */
export function createTransporter(config) {
  const effective = getEffectiveEmailConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Gmail is not configured. Please provide your Gmail address and 16-character Google App Password.");
  }

  return nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: {
      user: effective.email,
      pass: effective.appPassword
    },
    tls: {
      rejectUnauthorized: true
    }
  });
}

/**
 * Verifies email credentials by testing the SMTP handshake
 */
export function verifyEmailConnection(config) {
  return new Promise((resolve, reject) => {
    try {
      const effective = getEffectiveEmailConfig(config);
      if (!effective.isConfigured) {
        return reject(new Error("Please enter your Gmail address and 16-character App Password."));
      }
      const transporter = createTransporter(config);
      transporter.verify((err, success) => {
        if (err) {
          const errMsg = err.message || String(err);
          if (errMsg.includes("535") || errMsg.includes("BadCredentials") || errMsg.includes("Username and Password not accepted")) {
            return reject(new Error(
              "Gmail rejected your credentials (535 Bad Credentials).\n" +
              "• Ensure 2-Step Verification is enabled on your Google Account.\n" +
              "• Generate a 16-character App Password at: https://myaccount.google.com/apppasswords\n" +
              "• Do NOT use your regular Google account password."
            ));
          }
          return reject(new Error(`Gmail connection test failed: ${errMsg}`));
        }
        resolve({ success: true, email: effective.email, senderName: effective.senderName });
      });
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Sends an email via Gmail SMTP
 */
export async function sendEmail(config, { to, subject = "", body = "", html = "", cc = "", bcc = "" }) {
  const effective = getEffectiveEmailConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Gmail is not connected. Add your App Password in your dashboard at http://localhost:3000 -> Integrations tab.");
  }

  if (!to || !to.trim() || !to.includes("@")) {
    throw new Error("A valid recipient email address is required (e.g. client@example.com).");
  }

  const transporter = createTransporter(config);
  const fromAddress = effective.senderName 
    ? `"${effective.senderName}" <${effective.email}>`
    : effective.email;

  const mailOptions = {
    from: fromAddress,
    to: to.trim(),
    subject: subject.trim() || "(No Subject)",
    text: body.trim(),
    html: html || undefined,
    cc: cc ? cc.trim() : undefined,
    bcc: bcc ? bcc.trim() : undefined
  };

  const info = await transporter.sendMail(mailOptions);

  return {
    success: true,
    messageId: info.messageId,
    from: effective.email,
    senderName: effective.senderName,
    to: to.trim(),
    subject: mailOptions.subject,
    body: body.trim(),
    sentAt: new Date().toISOString()
  };
}

/**
 * Format an email draft as a clean, actionable WhatsApp card
 */
export function formatDraftForWhatsApp(draft, isNew = true) {
  if (!draft) return "⚠️ No draft details available.";

  const header = isNew ? "📝 *New Email Draft Created!*" : "📝 *Email Draft Details:*";
  const draftId = draft.id || "";
  const recipient = draft.recipient || "No recipient specified";
  const subject = draft.subject || "(No Subject)";
  const body = draft.body || "(Empty body)";

  return `${header}\n\n` +
    `🔖 *Draft ID:* #${draftId}\n` +
    `👤 *To:* \`${recipient}\`\n` +
    `📌 *Subject:* *${subject}*\n` +
    `📄 *Message:*\n${body}\n\n` +
    `───────────────\n` +
    `💡 *Quick Actions:*\n` +
    `• Reply *"send draft ${draftId}"* to send it right away!\n` +
    `• Reply *"edit draft ${draftId} body <text>"* to update the message.\n` +
    `• Reply *"delete draft ${draftId}"* to discard it.`;
}

/**
 * Format sent email confirmation for WhatsApp
 */
export function formatSentEmailForWhatsApp(result) {
  if (!result) return "✉️ Email sent!";

  const sentTime = new Date().toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true
  });

  return `✉️ *Email Sent Successfully!*\n\n` +
    `👤 *To:* \`${result.to}\`\n` +
    `📌 *Subject:* *${result.subject}*\n` +
    `📤 *From:* ${result.from || "Your Mail"}\n` +
    `⏰ *Sent at:* Today, ${sentTime} (IST)\n\n` +
    `✅ Delivered straight to their inbox.`;
}

/**
 * Format list of email drafts for WhatsApp
 */
export function formatDraftListForWhatsApp(drafts = []) {
  if (!drafts || drafts.length === 0) {
    return `📝 *No Pending Email Drafts.*\n\n` +
      `You have no saved email drafts. To create one, simply say:\n` +
      `• _"draft an email to client@example.com about project update"_\n` +
      `• _"email draft to boss@company.com subject Meeting tomorrow body I will arrive at 10 AM"_`;
  }

  let text = `📝 *Your Saved Email Drafts (${drafts.length}):*\n\n`;
  drafts.forEach((d, idx) => {
    const subj = d.subject || "(No Subject)";
    const to = d.recipient || "(No recipient)";
    const preview = d.body ? (d.body.length > 60 ? d.body.substring(0, 57) + "..." : d.body) : "";
    text += `${idx + 1}. *[Draft #${d.id}]* To: \`${to}\`\n`;
    text += `   📌 *${subj}*\n`;
    if (preview) text += `   💬 _"${preview}"_\n`;
    text += `   👉 _Reply "send draft ${d.id}" to send_\n\n`;
  });

  text += `💡 _Tip: You can also say "delete draft <#>" or "send email to <email> subject <sub travel> body <text>"._`;
  return text;
}

/**
 * Intelligent Subject & Body Generator from Natural Language Prompts
 */
export async function generateEmailDraftContent({ to, topic, senderName = "Anamika", generateAIContent = null }) {
  const cleanTopic = (topic || "General Update").trim().replace(/[.!?:;]+$/, "");

  if (generateAIContent) {
    try {
      const prompt = `Compose a short, polite, professional email on behalf of ${senderName}.\nRecipient: ${to}\nTopic / Key Details: "${cleanTopic}"\n\nReturn ONLY a JSON object (no markdown, no backticks, no code fence):\n{"subject": "Clear concise subject line", "body": "Hi,\\n\\nPolite professional email body\\n\\nBest regards,\\n${senderName}"}`;
      const res = await generateAIContent([{ role: "user", parts: [{ text: prompt }] }], undefined);
      let text = res?.text || "";
      text = text.replace(/```json/gi, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(text);
      if (parsed.subject && parsed.body) {
        return {
          subject: parsed.subject.trim(),
          body: parsed.body.trim()
        };
      }
    } catch (e) {
      console.warn("[Email Draft AI Generator]:", e.message);
    }
  }

  // Fallback template if AI call is unavailable
  const capitalizedTopic = cleanTopic.charAt(0).toUpperCase() + cleanTopic.slice(1);
  return {
    subject: capitalizedTopic,
    body: `Hi,\n\nI am writing to discuss ${cleanTopic}.\n\nPlease let me know your thoughts.\n\nBest regards,\n${senderName}`
  };
}

export default {
  cleanAppPassword,
  getEffectiveEmailConfig,
  createTransporter,
  verifyEmailConnection,
  sendEmail,
  formatDraftForWhatsApp,
  formatSentEmailForWhatsApp,
  formatDraftListForWhatsApp,
  generateEmailDraftContent
};
