# 🤖 Anam - WhatsApp AI Assistant

An intelligent, personal WhatsApp assistant built with **Node.js**, **[Baileys](https://github.com/WhiskeySockets/Baileys)**, and **[Google Gemini AI](https://aistudio.google.com)** (`gemini-3.6-flash`).

Designed by **Anamika Suresh**.

---

## ✨ Features

- 💬 **Wake-Word Invocation**: Activates on `"Hey Anam"` and holds active continuous chat sessions until you say `"bye"`.
- ⏰ **Clock Alarms**: Set exact time-of-day alarms (e.g., `alarm 07:30 Wake up`).
- 🚨 **Timed Reminders**: Set countdown delay timers (e.g., `remind me in 10 minutes to drink water`).
- 📋 **To-Do List Manager**: Persistently stores checklist tasks in local JSON (`add buy milk`, `show tasks`, `done 1`).
- 🧠 **Conversational Memory**: Automatically condenses older conversation context using Gemini AI.
- 🔄 **Auto-Reconnect**: Smooth connection recovery and automatic QR code refresh if session expires.

---

## 🛠️ Project Structure

```text
whatsapp-chatbot/
├── index.js          # Core Bot Engine, Baileys & Gemini Integration
├── package.json      # Dependencies & start scripts
├── .env              # Environment Configuration (API Keys)
├── .env.example      # Sample Environment template
├── todos.json        # Local storage for checklist tasks
└── README.md         # Project documentation
```

---

## 🚀 Quick Start Guide

### 1. Prerequisites
- **Node.js** (v18 or higher recommended)
- **Google Gemini API Key** (Get a free key from [Google AI Studio](https://aistudio.google.com/app/apikey))

---

### 2. Installation

Clone the repository and install dependencies:

```bash
git clone https://github.com/Anamika-Suresh/whatsapp-chatbot.git
cd whatsapp-chatbot
npm install
```

---

### 3. Environment Configuration

Create a `.env` file in the project root directory:

```env
GEMINI_API_KEY=your_actual_gemini_api_key_here
GEMINI_MODEL=gemini-3.6-flash
```

---

### 4. Running the Bot

Start the application:

```bash
npm start
```

1. A **QR Code** will appear in your terminal.
2. Open **WhatsApp** on your phone.
3. Go to **Settings** > **Linked Devices** > **Link a Device**.
4. Scan the terminal QR code.

Once connected, your terminal will display:
```text
✅ Anam Bot is connected! Say 'Hey Anam' to start a session.
```

---

## 💬 WhatsApp Command Cheatsheet

| Command Type | What to Type in WhatsApp | Response |
| :--- | :--- | :--- |
| **Start Bot Session** | `Hey Anam` | 👋 *Hey! I'm listening...* |
| **Set Timer** | `Hey Anam remind me in 5 minutes to stretch` | ⏰ Reminder set for *5 min(s)* |
| **Set Alarm** | `Hey Anam alarm 07:30 wake up` | ⏰ Alarm set for *07:30* |
| **Add To-Do Task** | `Hey Anam add buy groceries to list` | ✅ Added to list: *"buy groceries"* |
| **View Tasks** | `Hey Anam show tasks` | 📝 *Your Tasks:* 1. buy groceries |
| **Complete Task** | `Hey Anam done 1` | 🎉 Completed & removed: *"buy groceries"* |
| **Clear Memory** | `!clear` or `clear memory` | 🧹 *Memory cleared & session reset!* |
| **Close Session** | `bye` or `exit` | 👋 *Session ended!* |

---

## 📜 License

Distributed under the **ISC License**. Created by [Anamika Suresh](https://github.com/Anamika-Suresh).
