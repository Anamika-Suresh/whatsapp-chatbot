# WhatsApp AI Assistant SaaS Platform

A multi-tenant **SaaS platform** that transforms a single WhatsApp number into an intelligent, multi-user AI assistant for all registered users. Built with **Node.js**, **Express**, **[Baileys](https://github.com/WhiskeySockets/Baileys)**, **SQLite**, and **[Google Gemini AI](https://aistudio.google.com)** (`gemini-3.6-flash`).

Designed & created by **Anamika Suresh**.

---

## SaaS Product Architecture

```
                          ┌────────────────────────────────┐
                          │   SaaS Web Portal (:3000)      │
                          │ • User Signup & Signin         │
                          │ • Unique Verification Token    │
                          │ • Live Bi-Directional Sync     │
                          │ • Task & Reminder Dashboard    │
                          └──────────────┬─────────────────┘
                                         │
                                         ▼
   ┌──────────────────┐           ┌──────────────┐           ┌───────────────────┐
   │ Registered Users │ ◄───────► │ SQLite DB    │ ◄───────► │ WhatsApp Bot      │
   │ on WhatsApp      │           │ • users      │           │ Single instance   │
   │ (Sender JIDs)    │           │ • todos      │           │ Token Handshake   │
   │                  │           │ • reminders  │           │ AI Tool Calling   │
   └──────────────────┘           └──────────────┘           └───────────────────┘
```

###  How the SaaS Token Handshake Works:
1. **User Sign Up**: Any user registers on the Web Portal (`http://localhost:3000`) with their name, email, and password.
2. **Instant Token Generation**: The platform generates a unique verification token (e.g. `ANAM-8K2Q9M`) displayed with a 1-click copy button on their dashboard.
3. **WhatsApp Authentication**:
   - When a user first messages the bot's WhatsApp number, the bot recognizes that their phone number is not yet linked.
   - The bot replies: *" Welcome to Anam AI SaaS! Please reply with your verification token from your dashboard (e.g. ANAM-XXXXXX) to link your account."*
   - When the user sends their token, the bot validates it against the database and instantly links their WhatsApp phone number.
   - The user receives: *" Authentication Successful! Welcome, [Name]! Say 'Hey Anam' to begin!"*
4. **Multi-Tenant Isolation**: Every user's tasks, alarms, timers, and conversational memory are stored in SQLite and isolated by `user_id`. One bot serves all registered users simultaneously without data leaks!
5. **Bi-Directional Web & WhatsApp Sync**: Tasks or reminders added on WhatsApp appear on the web dashboard immediately, and items added on the web dashboard can be checked by asking the bot on WhatsApp (`"Hey Anam show tasks"`).

---

##  Features

-  **Modern SaaS Web Application**:
  - Landing page with animated hero, interactive WhatsApp chat simulation mockup, and 3-step onboarding.
  - Tabbed Sign In / Sign Up modal with password hashing (`bcryptjs`) and secure JWT session management.
  - Protected User Dashboard with live connection status polling (automatically switches from 🔴 Unlinked to 🟢 Connected as soon as verified on WhatsApp).
  - Prominent Token Box with 1-click copy, token regeneration, and direct WhatsApp launch link (`https://wa.me/...`).
  - Interactive To-Do list and Reminders manager synced with WhatsApp.
-  **WhatsApp Bot Token Handshake**:
  - First-contact detection: Prompts unverified users to sign up and submit their token.
  - Auto-verification & phone linking.
  - Verification error handling with helpful guidance.
-  **Clock Alarms with Name & Description**: Set exact time-of-day alarms (e.g., `Hey Anam 4pm reminder: name: Website analysis, description: Analyses given website and extract details`).
-  **Timed Reminders**: Set countdown delay timers (e.g., `Hey Anam remind me in 10 minutes: name: Drink water, description: Stay hydrated`).
-  **Synced To-Do List Manager**: Persistently stores checklist tasks in SQLite synced across WhatsApp and Web (`add Website analysis to list`, `show tasks`, `done 1`).
-  **Atlassian Jira Cloud Integration**:
  - Create Jira issues, bugs, tasks, or stories directly through WhatsApp chat (`Hey Anam create a Jira bug in PROJ: Fix payment glitch`).
  - View assigned sprint tickets and tasks (`Hey Anam what are my Jira tickets?` or `jira list`).
  - Transition ticket statuses (`jira close PROJ-42` or `jira done PROJ-42`).
  - Comment on tickets and track progress in real time.
-  **Google Calendar Integration**:
  - List daily, tomorrow, or weekly agendas (`Hey Anam what's on my calendar today?` or `calendar today`).
  - Schedule meetings & events with time, duration, and meet links (`Hey Anam schedule meeting with Team tomorrow at 3pm for 45 mins`).
  - Cancel or delete scheduled events directly on WhatsApp (`calendar delete event`).
-  **Google Drive Cloud Storage**:
  - OAuth 2.0 or Service Account connection with 15 GB storage quota.
  - Search files and folders, browse recent uploads, and download links (`Hey Anam find pitch deck on Drive` or `drive files`).
  - Create project folders directly from chat or the web portal (`drive folder Marketing 2026`).
-  **Asana Task & Project Management**:
  - View workspaces, projects, and active tasks across sprints (`asana tasks` or `Hey Anam what tasks do I have in Asana?`).
  - Create new tasks with due dates and project assignment (`asana add Finalize UI mocks due tomorrow`).
  - Mark tasks complete from WhatsApp in real time (`asana done [task ID]`).
- ✉️ **Gmail & Email Assistant**:
  - Draft, preview, and send emails via Gmail App Password / SMTP directly from WhatsApp.
  - AI-assisted composing (`Hey Anam draft an email to client@example.com about project update`).
  - Draft review in Web Dashboard with one-click dispatch and live status tracking.
-  **Contextual Gemini AI Assistant**: Powered by Google Gemini 3.6 Flash with automatic failover, smart memory condensation, and function calling.
-  **Account Management via WhatsApp**: Type `!account` or `whoami` to view your SaaS plan and registered email, or `!unlink` to disconnect.

---

##  Project Structure

```text
whatsapp_bot/
├── public/                 # SaaS Web Portal Frontend
│   ├── index.html          # Landing Page, Auth Modals, and Dashboard
│   ├── styles.css          # Vanilla CSS Design System (Dark mode, Glassmorphism)
│   └── app.js              # Client-side State, API Sync, Live Status Polling
├── services/               # Modular Third-Party Integration Services
│   ├── asanaService.js     # Asana REST API Integration
│   ├── emailService.js     # Gmail & SMTP Email Assistant
│   ├── googleCalendarService.js # Google Calendar API v3
│   ├── googleDriveService.js    # Google Drive API v3 (OAuth & Service Account)
│   └── jiraService.js      # Jira Cloud REST API
├── scripts/                # Utility & Setup Scripts
│   └── authGoogleDrive.js  # Interactive Desktop OAuth Helper for Google Drive
├── db.js                   # High-Performance SQLite Database Layer (node:sqlite)
├── server.js               # Express Web Server & SaaS REST API
├── index.js                # Core WhatsApp Bot Engine (Baileys + Gemini AI + Token Auth)
├── run_all.js              # Unified Process Runner (Launches Web + Bot together)
├── saas_database.sqlite    # SQLite Database (Users, Integrations, Todos, Reminders)
├── bot_state.json          # Shared Bot Connectivity State
├── package.json            # Dependencies & Start Scripts
├── .env.example            # Sample Environment Template
├── client_secret.example.json # Sample Google OAuth Desktop Secret Template
└── README.md               # Documentation
```

---

##  Quick Start Guide

### 1. Prerequisites
- **Node.js** (v18 or higher; Node 24 includes native `node:sqlite`)
- **Google Gemini API Key** (Get a free key from [Google AI Studio](https://aistudio.google.com/app/apikey))

---

### 2. Installation

```bash
git clone https://github.com/Anamika-Suresh/whatsapp-chatbot.git
cd whatsapp_bot
npm install
```

---

### 3. Environment Configuration

Create or update your `.env` file:

```env
# Google Gemini AI Key
GEMINI_API_KEY="your_actual_gemini_api_key_here"
GEMINI_MODEL=gemini-3.6-flash

# SaaS Web Server Configuration
PORT=3000
JWT_SECRET=your_super_secret_jwt_key_here
WEB_URL=http://localhost:3000

# Optional: WhatsApp Bot Phone Number (e.g. 919876543210)
BOT_PHONE_NUMBER=
```

---

### 4. Running the Platform

You can run the web server, the bot engine, or both together:

#### Option A: Run Both Together (Recommended)
```bash
npm start
```
*This launches both the Web Portal at `http://localhost:3000` and the WhatsApp Bot engine.*

#### Option B: Run Services Independently
- Run only the Web Portal:
  ```bash
  npm run web
  ```
- Run only the WhatsApp Bot:
  ```bash
  npm run bot
  ```

---

### 5. Connecting WhatsApp

1. When you run `npm start` or `npm run bot`, a **QR Code** will appear in the terminal.
2. Open WhatsApp on your phone (the bot device).
3. Go to **Settings** > **Linked Devices** > **Link a Device**.
4. Scan the QR code.
5. Your terminal will display:
   ```text
   ✅ Anam Bot is connected! WhatsApp Number: +1234567890. Say 'Hey Anam' to start a session.
   ```

---

### 6. User Experience Walkthrough

1. Open your browser and visit: `http://localhost:3000`.
2. Click **"Get Token Free"** and sign up with your name, email, and password.
3. Your dashboard will show your unique token (e.g., `ANAM-A7K92M`).
4. Click **"Copy Token"**.
5. Open WhatsApp from another phone/account and message the bot number.
6. The bot will ask for your token:
   > *" Welcome to Anam AI SaaS! Please reply with your verification token from your dashboard..."*
7. Send your token `ANAM-A7K92M`.
8. The bot immediately verifies you in SQLite and welcomes you:
   > *" Authentication Successful! Welcome, [Name]! Say 'Hey Anam' to begin!"*
9. Notice your web dashboard automatically updates its badge to **🟢 WhatsApp Connected & Active** without needing a page refresh!

---

##  WhatsApp Command Cheatsheet

| Command | Action | Example |
| :--- | :--- | :--- |
| `ANAM-XXXXXX` | **Verify Account Token** | `ANAM-9X7K2M` |
| `Hey Anam` | **Wake Word / Start Session** | `Hey Anam` |
| `Hey Anam [time] reminder:` | **Set Exact Time Alarm** | `Hey Anam 4pm reminder: name: Review deck, description: Final polish for launch` |
| `Hey Anam remind me in [X] min` | **Relative Countdown Timer** | `Hey Anam remind me in 10 minutes to drink water` |
| `Hey Anam add [task] to list` | **Add To-Do Task** | `Hey Anam add Prepare pitch deck to list` |
| `Hey Anam show tasks` | **View Synced Checklist** | `Hey Anam show tasks` |
| `Hey Anam done [number]` | **Complete Task** | `Hey Anam done 1` |
| `!integrations` | **Check Integration Status** | `!integrations` |
| `jira list` or `my tickets` | **List Jira Tickets** | `jira list` |
| `jira create [summary]` | **Create Jira Issue** | `jira create Fix checkout button alignment` |
| `jira close [key]` | **Close/Done Jira Ticket** | `jira close PROJ-42` |
| `calendar today` | **View Today's Calendar** | `calendar today` |
| `calendar tomorrow` | **View Tomorrow's Schedule** | `calendar tomorrow` |
| `Hey Anam schedule meeting...` | **Schedule Google Calendar Event** | `Hey Anam schedule meeting with Sarah tomorrow at 4pm for 30 mins` |
| `drive files` or `find [query] on drive` | **Search & List Google Drive** | `Hey Anam find Q4 report on drive` |
| `drive folder [name]` | **Create Google Drive Folder** | `drive folder Project Alpha` |
| `asana tasks` or `my asana tasks` | **List Asana Tasks** | `asana tasks` |
| `asana add [title]` | **Create Asana Task** | `asana add Finalize pitch deck due Friday` |
| `asana done [taskId]` | **Complete Asana Task** | `asana done 12059382` |
| `draft email to [email] about [topic]` | **AI Draft Email** | `Hey Anam draft an email to alex@company.com about meeting rescheduling` |
| `send email to [email] subject [subject] body [body]` | **Send Email via Gmail** | `send email to alex@company.com subject Hello body Looking forward to our sync` |
| `!account` or `whoami` | **Check SaaS Account Profile** | `!account` |
| `!unlink` | **Disconnect WhatsApp** | `!unlink` |
| `!clear` | **Clear Session Memory** | `!clear` |
| `bye` or `exit` | **End Active Chat Session** | `bye` |

---

##  REST API Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/auth/signup` | Register new SaaS account & generate unique token |
| `POST` | `/api/auth/signin` | Sign in to dashboard |
| `GET` | `/api/auth/me` | Fetch authenticated user profile & verification status |
| `POST` | `/api/auth/logout` | Sign out / clear session cookie |
| `POST` | `/api/user/regenerate-token` | Issue a fresh verification token |
| `POST` | `/api/user/unlink-whatsapp` | Disconnect WhatsApp number from account |
| `GET` | `/api/user/todos` | List user's tasks |
| `POST` | `/api/user/todos` | Create a new task |
| `PATCH` | `/api/user/todos/:id/toggle` | Toggle task completion |
| `DELETE` | `/api/user/todos/:id` | Delete task |
| `GET` | `/api/user/reminders` | List scheduled reminders |
| `POST` | `/api/user/reminders` | Schedule a new reminder |
| `DELETE` | `/api/user/reminders/:id` | Delete reminder |
| `GET` | `/api/user/integrations` | Get user integration statuses (Jira, Google Calendar, Google Drive, Asana, Email) |
| `POST` | `/api/user/integrations/jira` | Save or update Jira domain, email, and API token |
| `POST` | `/api/user/integrations/jira/test` | Test Jira Cloud REST connection |
| `DELETE` | `/api/user/integrations/jira` | Disconnect Jira integration |
| `GET` | `/api/user/integrations/jira/issues` | Fetch preview of user's Jira tickets |
| `POST` | `/api/user/integrations/google_calendar` | Save Google Calendar credentials (service account or token) |
| `POST` | `/api/user/integrations/google_calendar/test` | Test Google Calendar API v3 connection |
| `DELETE` | `/api/user/integrations/google_calendar` | Disconnect Google Calendar integration |
| `GET` | `/api/user/integrations/calendar/events` | Fetch preview of today's calendar schedule |
| `POST` | `/api/user/integrations/calendar/instant-meet` | Create an instant Google Meet link |
| `POST` | `/api/user/integrations/google_drive` | Save Google Drive credentials (OAuth token or Service Account) |
| `POST` | `/api/user/integrations/google_drive/test` | Test Google Drive connection and storage quota |
| `DELETE` | `/api/user/integrations/google_drive` | Disconnect Google Drive integration |
| `GET` | `/api/user/integrations/google_drive/files` | Fetch and search Google Drive files |
| `POST` | `/api/user/integrations/google_drive/folder` | Create new folder on Google Drive |
| `POST` | `/api/user/integrations/asana` | Save Asana Personal Access Token & workspace |
| `POST` | `/api/user/integrations/asana/test` | Test Asana connection & load projects |
| `GET` | `/api/user/integrations/asana/projects` | List available Asana projects |
| `GET` | `/api/user/integrations/asana/tasks` | Fetch user's Asana tasks |
| `POST` | `/api/user/integrations/asana/tasks/:taskGid` | Update / complete Asana task |
| `DELETE` | `/api/user/integrations/asana` | Disconnect Asana integration |
| `POST` | `/api/user/integrations/email` | Save Gmail address & 16-character App Password |
| `POST` | `/api/user/integrations/email/test` | Test Gmail SMTP connection |
| `POST` | `/api/user/integrations/email/send-test` | Send a verification test email |
| `DELETE` | `/api/user/integrations/email` | Disconnect Email integration |
| `GET` | `/api/user/integrations/email/drafts` | List pending email drafts |
| `POST` | `/api/user/integrations/email/drafts` | Create or update email draft |
| `POST` | `/api/user/integrations/email/send` | Dispatch an email directly |
| `GET` | `/api/bot/status` | Real-time bot engine connectivity status & statistics |

---



Designed and developed by **[Anamika Suresh](https://github.com/Anamika-Suresh)**.
