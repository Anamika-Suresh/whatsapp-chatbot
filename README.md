# ⚡ Anam AI — WhatsApp Assistant SaaS Platform

A multi-tenant **SaaS platform** that transforms a single WhatsApp number into an intelligent, multi-user AI assistant for all registered users. Built with **Node.js**, **Express**, **[Baileys](https://github.com/WhiskeySockets/Baileys)**, **SQLite**, and **[Google Gemini AI](https://aistudio.google.com)** (`gemini-3.6-flash`).

Designed & created by **Anamika Suresh**.

---

## 🌟 SaaS Product Architecture

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

### 🔑 How the SaaS Token Handshake Works:
1. **User Sign Up**: Any user registers on the Web Portal (`http://localhost:3000`) with their name, email, and password.
2. **Instant Token Generation**: The platform generates a unique verification token (e.g. `ANAM-8K2Q9M`) displayed with a 1-click copy button on their dashboard.
3. **WhatsApp Authentication**:
   - When a user first messages the bot's WhatsApp number, the bot recognizes that their phone number is not yet linked.
   - The bot replies: *"👋 Welcome to Anam AI SaaS! Please reply with your verification token from your dashboard (e.g. ANAM-XXXXXX) to link your account."*
   - When the user sends their token, the bot validates it against the database and instantly links their WhatsApp phone number.
   - The user receives: *"🎉 Authentication Successful! Welcome, [Name]! Say 'Hey Anam' to begin!"*
4. **Multi-Tenant Isolation**: Every user's tasks, alarms, timers, and conversational memory are stored in SQLite and isolated by `user_id`. One bot serves all registered users simultaneously without data leaks!
5. **Bi-Directional Web & WhatsApp Sync**: Tasks or reminders added on WhatsApp appear on the web dashboard immediately, and items added on the web dashboard can be checked by asking the bot on WhatsApp (`"Hey Anam show tasks"`).

---

## ✨ Features

- 🌐 **Modern SaaS Web Application**:
  - Landing page with animated hero, interactive WhatsApp chat simulation mockup, and 3-step onboarding.
  - Tabbed Sign In / Sign Up modal with password hashing (`bcryptjs`) and secure JWT session management.
  - Protected User Dashboard with live connection status polling (automatically switches from 🔴 Unlinked to 🟢 Connected as soon as verified on WhatsApp).
  - Prominent Token Box with 1-click copy, token regeneration, and direct WhatsApp launch link (`https://wa.me/...`).
  - Interactive To-Do list and Reminders manager synced with WhatsApp.
- 💬 **WhatsApp Bot Token Handshake**:
  - First-contact detection: Prompts unverified users to sign up and submit their token.
  - Auto-verification & phone linking.
  - Verification error handling with helpful guidance.
- ⏰ **Clock Alarms with Name & Description**: Set exact time-of-day alarms (e.g., `Hey Anam 4pm reminder: name: Website analysis, description: Analyses given website and extract details`).
- 🚨 **Timed Reminders**: Set countdown delay timers (e.g., `Hey Anam remind me in 10 minutes: name: Drink water, description: Stay hydrated`).
- 📋 **Synced To-Do List Manager**: Persistently stores checklist tasks in SQLite synced across WhatsApp and Web (`add Website analysis to list`, `show tasks`, `done 1`).
- 🧠 **Contextual Gemini AI Assistant**: Powered by Google Gemini 3.6 Flash with automatic failover, smart memory condensation, and function calling.
- 📱 **Account Management via WhatsApp**: Type `!account` or `whoami` to view your SaaS plan and registered email, or `!unlink` to disconnect.

---

## 🛠️ Project Structure

```text
whatsapp_bot/
├── public/                 # SaaS Web Portal Frontend
│   ├── index.html          # Landing Page, Auth Modals, and Dashboard
│   ├── styles.css          # Vanilla CSS Design System (Dark mode, Glassmorphism)
│   └── app.js              # Client-side State, API Sync, Live Status Polling
├── db.js                   # High-Performance SQLite Database Layer (node:sqlite)
├── server.js               # Express Web Server & REST API
├── index.js                # Core WhatsApp Bot Engine (Baileys + Gemini AI + Token Auth)
├── run_all.js              # Unified Process Runner (Launches Web + Bot together)
├── saas_database.sqlite    # SQLite Database (Users, Todos, Reminders)
├── bot_state.json          # Shared Bot Connectivity State
├── package.json            # Dependencies & Start Scripts
├── .env                    # Environment Configuration
├── .env.example            # Sample Environment Template
└── README.md               # Documentation
```

---

## 🚀 Quick Start Guide

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
   > *"👋 Welcome to Anam AI SaaS! Please reply with your verification token from your dashboard..."*
7. Send your token `ANAM-A7K92M`.
8. The bot immediately verifies you in SQLite and welcomes you:
   > *"🎉 Authentication Successful! Welcome, [Name]! Say 'Hey Anam' to begin!"*
9. Notice your web dashboard automatically updates its badge to **🟢 WhatsApp Connected & Active** without needing a page refresh!

---

## 💬 WhatsApp Command Cheatsheet

| Command | Action | Example |
| :--- | :--- | :--- |
| `ANAM-XXXXXX` | **Verify Account Token** | `ANAM-9X7K2M` |
| `Hey Anam` | **Wake Word / Start Session** | `Hey Anam` |
| `Hey Anam [time] reminder:` | **Set Exact Time Alarm** | `Hey Anam 4pm reminder: name: Review deck, description: Final polish for launch` |
| `Hey Anam remind me in [X] min` | **Relative Countdown Timer** | `Hey Anam remind me in 10 minutes to drink water` |
| `Hey Anam add [task] to list` | **Add To-Do Task** | `Hey Anam add Prepare pitch deck to list` |
| `Hey Anam show tasks` | **View Synced Checklist** | `Hey Anam show tasks` |
| `Hey Anam done [number]` | **Complete Task** | `Hey Anam done 1` |
| `!account` or `whoami` | **Check SaaS Account Profile** | `!account` |
| `!unlink` | **Disconnect WhatsApp** | `!unlink` |
| `!clear` | **Clear Session Memory** | `!clear` |
| `bye` or `exit` | **End Active Chat Session** | `bye` |

---

## 📄 REST API Endpoints

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
| `GET` | `/api/bot/status` | Real-time bot engine connectivity status & statistics |

---

## 📜 License

Distributed under the **ISC License**. Designed and developed by **[Anamika Suresh](https://github.com/Anamika-Suresh)**.
