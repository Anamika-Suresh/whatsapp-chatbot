#  Anam - WhatsApp AI Assistant

An intelligent, personal WhatsApp assistant built with **Node.js**, **[Baileys](https://github.com/WhiskeySockets/Baileys)**, and **[Google Gemini AI](https://aistudio.google.com)** (`gemini-3.6-flash`).

Designed by **Anamika Suresh**.

---

##  Features

-  **Wake-Word Invocation**: Activates on `"Hey Anam"` and holds active continuous chat sessions until you say `"bye"`.
-  **Clock Alarms with Name & Description**: Set exact time-of-day alarms with custom names and detailed descriptions (e.g., `4pm reminder: name: Website analysis, description: Analyses given website and extract details`).
-  **Timed Reminders**: Set countdown delay timers with structured name and details (e.g., `remind me in 10 minutes: name: Drink water, description: Stay hydrated`).
-  **To-Do List Manager**: Persistently stores checklist tasks with optional detailed descriptions (`add Website analysis to list with description: Analyses given website`, `show tasks`, `done 1`).
- **Conversational Memory**: Automatically condenses older conversation context using Gemini AI.
-  **Auto-Reconnect**: Smooth connection recovery and automatic QR code refresh if session expires.

---

##  Project Structure

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

##  Quick Start Guide

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

| Command Type | What to Type in WhatsApp | Response Format |
| :--- | :--- | :--- |
| **Start Bot Session** | `Hey Anam` |  *Hey! I'm listening...* |
| **Set Alarm (Name & Desc)** | `Hey Anam 4pm reminder: name: Website analysis, description: Analyses given website and extract details` |  Alarm set for *16:00*:<br> *Name:* Website analysis<br> *Description:* Analyses given website... |
| **Set Timer Reminder** | `Hey Anam remind me in 5 minutes name: Drink Water description: Stay hydrated` |  Reminder set for *5 min(s)*:<br> *Name:* Drink Water<br> *Description:* Stay hydrated |
| **Add To-Do Task** | `Hey Anam add Website analysis to list with description: Analyses given website` |  Added to list: *"Website analysis"* |
| **View Tasks** | `Hey Anam show tasks` |  *Your Tasks:*<br>1.  *Website analysis*<br>    _Analyses given website_ |
| **Complete Task** | `Hey Anam done 1` |  Completed & removed: *"Website analysis"* |
| **Clear Memory** | `!clear` or `clear memory` |  *Memory cleared & session reset!* |
| **Close Session** | `bye` or `exit` |  *Session ended!* |

---
 Created by [Anamika Suresh](https://github.com/Anamika-Suresh).
