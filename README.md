# Anam - WhatsApp AI Assistant

A lightweight, intelligent WhatsApp personal assistant built with [Baileys](https://github.com/WhiskeySockets/Baileys) and Google Gemini AI (gemini-3.6-flash).

## Features
- **Wake-Word Invocation**: Activates with "Hey Anam" and supports continuous active sessions until you say "bye".
- **Clock Alarms**: Set exact time alarms (e.g., `alarm 07:30 Wake up`).
- **Timed Reminders**: Set countdown timers (e.g., `remind 10m check oven`).
- **To-Do List**: Add and complete personal tasks (`add milk`, `show tasks`, `done 1`).
- **Conversational Memory**: Automatically condenses older conversation context.

## Setup Instructions

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Anamika-Suresh/whatsapp-chatbot.git
   cd whatsapp-chatbot
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Configure Environment:**
   - Copy `.env.example` to `.env`:
     ```bash
     cp .env.example .env
     ```
   - Add your Gemini API key in `.env`.

4. **Run the bot:**
   ```bash
   npm start
   ```
   Scan the generated QR code in WhatsApp (**Settings > Linked Devices**).