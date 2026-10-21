/**
 * ANAM AI SAAS — CLIENT-SIDE APPLICATION SCRIPT
 */

// Application State
const state = {
  user: null,
  bot: {
    connected: false,
    phone: "",
    lastSeen: null
  },
  todos: [],
  reminders: [],
  pollTimer: null
};

// DOM Element Selectors
const elements = {
  // Navigation
  guestNav: document.getElementById("guest-nav-links"),
  userNav: document.getElementById("user-nav-profile"),
  navUserName: document.getElementById("nav-user-name"),
  navUserAvatar: document.getElementById("nav-user-avatar"),
  btnOpenSignIn: document.getElementById("btn-open-signin"),
  btnOpenSignUp: document.getElementById("btn-open-signup"),
  btnLogout: document.getElementById("btn-logout"),

  // Views
  viewLanding: document.getElementById("view-landing"),
  viewDashboard: document.getElementById("view-dashboard"),

  // Hero Actions
  heroBtnSignUp: document.getElementById("hero-btn-signup"),
  footerBtnSignUp: document.getElementById("footer-btn-signup"),

  // Dashboard Profile
  dashUserName: document.getElementById("dash-user-name"),

  // WhatsApp Link Card
  waStateUnlinked: document.getElementById("wa-state-unlinked"),
  waStateLinked: document.getElementById("wa-state-linked"),
  userTokenCode: document.getElementById("user-token-code"),
  instrTokenPreview: document.getElementById("instr-token-preview"),
  btnCopyToken: document.getElementById("btn-copy-token"),
  btnRegenerateToken: document.getElementById("btn-regenerate-token"),
  btnOpenWaChat: document.getElementById("btn-open-wa-chat"),
  btnUnlinkWa: document.getElementById("btn-unlink-wa"),
  waLinkedPhone: document.getElementById("wa-linked-phone"),
  waLinkedJid: document.getElementById("wa-linked-jid"),
  waLinkedTime: document.getElementById("wa-linked-time"),
  botServerStatusPill: document.getElementById("bot-server-status-pill"),
  botServerStatusText: document.getElementById("bot-server-status-text"),

  // To-Do Panel
  formAddTodo: document.getElementById("form-add-todo"),
  inputTodoName: document.getElementById("input-todo-name"),
  inputTodoDesc: document.getElementById("input-todo-desc"),
  todosUl: document.getElementById("todos-ul"),
  todosEmptyState: document.getElementById("todos-empty-state"),
  todoCountBadge: document.getElementById("todo-count-badge"),

  // Reminders Panel
  formAddReminder: document.getElementById("form-add-reminder"),
  inputRemName: document.getElementById("input-rem-name"),
  inputRemTime: document.getElementById("input-rem-time"),
  inputRemDesc: document.getElementById("input-rem-desc"),
  remindersUl: document.getElementById("reminders-ul"),
  remindersEmptyState: document.getElementById("reminders-empty-state"),
  reminderCountBadge: document.getElementById("reminder-count-badge"),

  // Auth Modal
  authModal: document.getElementById("auth-modal"),
  btnCloseModal: document.getElementById("btn-close-modal"),
  tabSignUp: document.getElementById("tab-signup"),
  tabSignIn: document.getElementById("tab-signin"),
  formSignUp: document.getElementById("form-signup"),
  formSignIn: document.getElementById("form-signin"),
  linkToSignIn: document.getElementById("link-to-signin"),
  linkToSignUp: document.getElementById("link-to-signup"),

  // Toast
  toastContainer: document.getElementById("toast-container"),

  // Platform Integrations
  formJiraSettings: document.getElementById("form-jira-settings"),
  jiraInputHost: document.getElementById("jira-input-host"),
  jiraInputEmail: document.getElementById("jira-input-email"),
  jiraInputToken: document.getElementById("jira-input-token"),
  jiraInputProject: document.getElementById("jira-input-project"),
  btnSaveJira: document.getElementById("btn-save-jira"),
  btnTestJira: document.getElementById("btn-test-jira"),
  btnPreviewJira: document.getElementById("btn-preview-jira"),
  btnDisconnectJira: document.getElementById("btn-disconnect-jira"),
  jiraStatusBadge: document.getElementById("jira-status-badge"),
  jiraPreviewDrawer: document.getElementById("jira-preview-drawer"),
  jiraTicketsContainer: document.getElementById("jira-tickets-container"),
  btnCloseJiraPreview: document.getElementById("btn-close-jira-preview"),

  formCalendarSettings: document.getElementById("form-calendar-settings"),
  calInputId: document.getElementById("cal-input-id"),
  calInputEmail: document.getElementById("cal-input-email"),
  calInputKey: document.getElementById("cal-input-key"),
  btnSaveCalendar: document.getElementById("btn-save-calendar"),
  btnTestCalendar: document.getElementById("btn-test-calendar"),
  btnInstantMeet: document.getElementById("btn-instant-meet"),
  btnPreviewCalendar: document.getElementById("btn-preview-calendar"),
  btnDisconnectCalendar: document.getElementById("btn-disconnect-calendar"),
  btnAutodetectCalendar: document.getElementById("btn-autodetect-calendar"),
  saEmailHint: document.getElementById("sa-email-hint"),
  calendarStatusBadge: document.getElementById("calendar-status-badge"),
  calendarPreviewDrawer: document.getElementById("calendar-preview-drawer"),
  calendarEventsContainer: document.getElementById("calendar-events-container"),
  btnCloseCalendarPreview: document.getElementById("btn-close-calendar-preview"),

  // Platform Integrations: Google Drive
  formDriveSettings: document.getElementById("form-drive-settings"),
  driveInputFolder: document.getElementById("drive-input-folder"),
  driveInputEmail: document.getElementById("drive-input-email"),
  driveInputKey: document.getElementById("drive-input-key"),
  btnSaveDrive: document.getElementById("btn-save-drive"),
  btnTestDrive: document.getElementById("btn-test-drive"),
  btnPreviewDrive: document.getElementById("btn-preview-drive"),
  btnDisconnectDrive: document.getElementById("btn-disconnect-drive"),
  btnAutodetectDrive: document.getElementById("btn-autodetect-drive"),
  driveSaEmailHint: document.getElementById("drive-sa-email-hint"),
  driveStatusBadge: document.getElementById("drive-status-badge"),
  drivePreviewDrawer: document.getElementById("drive-preview-drawer"),
  driveFilesContainer: document.getElementById("drive-files-container"),
  btnCloseDrivePreview: document.getElementById("btn-close-drive-preview"),

  // Platform Integrations: Asana
  formAsanaSettings: document.getElementById("form-asana-settings"),
  asanaInputToken: document.getElementById("asana-input-token"),
  asanaSelectWorkspace: document.getElementById("asana-select-workspace"),
  asanaSelectProject: document.getElementById("asana-select-project"),
  btnAsanaNewProject: document.getElementById("btn-asana-new-project"),
  btnSaveAsana: document.getElementById("btn-save-asana"),
  btnTestAsana: document.getElementById("btn-test-asana"),
  btnPreviewAsana: document.getElementById("btn-preview-asana"),
  btnDisconnectAsana: document.getElementById("btn-disconnect-asana"),
  asanaStatusBadge: document.getElementById("asana-status-badge"),
  asanaPreviewDrawer: document.getElementById("asana-preview-drawer"),
  asanaTasksContainer: document.getElementById("asana-tasks-container"),
  btnCloseAsanaPreview: document.getElementById("btn-close-asana-preview"),

  // Platform Integrations: Email / Gmail
  formEmailSettings: document.getElementById("form-email-settings"),
  emailInputAddress: document.getElementById("email-input-address"),
  emailInputPassword: document.getElementById("email-input-password"),
  emailInputSenderName: document.getElementById("email-input-sender-name"),
  btnSaveEmail: document.getElementById("btn-save-email"),
  btnTestEmail: document.getElementById("btn-test-email"),
  btnSendTestEmail: document.getElementById("btn-send-test-email"),
  btnPreviewDrafts: document.getElementById("btn-preview-drafts"),
  btnDisconnectEmail: document.getElementById("btn-disconnect-email"),
  emailStatusBadge: document.getElementById("email-status-badge"),
  emailPreviewDrawer: document.getElementById("email-preview-drawer"),
  emailDraftsContainer: document.getElementById("email-drafts-container"),
  btnCloseEmailPreview: document.getElementById("btn-close-email-preview"),

  integrationsStatusText: document.getElementById("integrations-status-text"),
  integrationsSummaryBadge: document.getElementById("integrations-summary-badge")
};

// ===================================================================
// TOAST NOTIFICATIONS
// ===================================================================

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;

  const icon = type === "success" ? "✅" : type === "error" ? "❌" : "ℹ️";
  toast.innerHTML = `<span>${icon}</span> <div>${message}</div>`;

  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateX(50px)";
    toast.style.transition = "all 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Global text copy helper
window.copyText = function(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast(`Copied: "${text}"`, "success");
  }).catch(() => {
    showToast("Failed to copy text", "error");
  });
};

// ===================================================================
// INITIALIZATION & AUTH CHECK
// ===================================================================

document.addEventListener("DOMContentLoaded", () => {
  initEventListeners();
  checkAuth();
  fetchBotStatus();
});

async function checkAuth() {
  try {
    const res = await fetch("/api/auth/me");
    if (res.ok) {
      const data = await res.json();
      if (data.success && data.user) {
        setLoggedIn(data.user);
        return;
      }
    }
  } catch (err) {
    console.warn("User not logged in or server offline");
  }
  setLoggedOut();
}

function setLoggedIn(user) {
  state.user = user;

  // Update Nav
  elements.guestNav.classList.add("hidden");
  elements.userNav.classList.remove("hidden");
  elements.navUserName.textContent = user.name;
  elements.navUserAvatar.textContent = user.name.charAt(0).toUpperCase();

  // Switch Views
  elements.viewLanding.classList.add("hidden");
  elements.viewDashboard.classList.remove("hidden");
  elements.dashUserName.textContent = user.name.split(" ")[0];

  // Close modal if open
  closeAuthModal();

  // Render WhatsApp Card
  renderWhatsAppStatus(user);

  // Load User Data
  loadTodos();
  loadReminders();
  loadIntegrations();

  // Start polling for WhatsApp connection update if not verified
  startLivePolling();
}

function setLoggedOut() {
  state.user = null;
  stopLivePolling();

  elements.guestNav.classList.remove("hidden");
  elements.userNav.classList.add("hidden");

  elements.viewLanding.classList.remove("hidden");
  elements.viewDashboard.classList.add("hidden");
}

// ===================================================================
// BOT STATUS & LIVE POLLING
// ===================================================================

async function fetchBotStatus() {
  try {
    const res = await fetch("/api/bot/status");
    if (res.ok) {
      const data = await res.json();
      state.bot = data.bot;

      if (elements.botServerStatusText) {
        if (data.bot.connected) {
          elements.botServerStatusText.textContent = "Bot Online (Connected)";
          elements.botServerStatusPill.querySelector(".pulsing-dot").className = "pulsing-dot green";
        } else {
          elements.botServerStatusText.textContent = "Bot Waiting / Ready";
          elements.botServerStatusPill.querySelector(".pulsing-dot").className = "pulsing-dot yellow";
        }
      }

      updateWhatsAppChatLink();
    }
  } catch (err) {
    if (elements.botServerStatusText) {
      elements.botServerStatusText.textContent = "Bot Offline";
    }
  }
}

function updateWhatsAppChatLink() {
  if (!state.user || !elements.btnOpenWaChat) return;

  const token = state.user.authToken;
  let waUrl = `https://wa.me/?text=${encodeURIComponent(token)}`;

  if (state.bot.phone) {
    const cleanPhone = state.bot.phone.replace(/[^0-9]/g, "");
    waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(token)}`;
  }

  elements.btnOpenWaChat.href = waUrl;
}

function startLivePolling() {
  stopLivePolling();

  // Poll every 2.5 seconds for true real-time synchronization from WhatsApp & Web
  state.pollTimer = setInterval(async () => {
    if (!state.user) return;

    try {
      const res = await fetch("/api/auth/me");
      if (res.ok) {
        const data = await res.json();
        if (data.success && data.user) {
          const wasVerified = state.user.isVerified;
          state.user = data.user;

          // If user just got verified on WhatsApp!
          if (!wasVerified && data.user.isVerified) {
            showToast("🎉 WhatsApp Connected successfully!", "success");
            renderWhatsAppStatus(data.user);
          }
        }
      }
      
      // Continuously sync tasks, reminders, and bot status in real-time
      await Promise.all([
        loadTodos(true),
        loadReminders(true),
        loadIntegrations(true),
        fetchBotStatus()
      ]);
    } catch (e) {}
  }, 2500);
}

function stopLivePolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

// ===================================================================
// WHATSAPP LINK CARD RENDERER
// ===================================================================

function renderWhatsAppStatus(user) {
  if (!user.isVerified) {
    elements.waStateUnlinked.classList.remove("hidden");
    elements.waStateLinked.classList.add("hidden");

    elements.userTokenCode.textContent = user.authToken || "ANAM-XXXXXX";
    elements.instrTokenPreview.textContent = user.authToken || "ANAM-XXXXXX";

    updateWhatsAppChatLink();
  } else {
    elements.waStateUnlinked.classList.add("hidden");
    elements.waStateLinked.classList.remove("hidden");

    elements.waLinkedPhone.textContent = user.phoneNumber || user.whatsappJid || "Linked";
    elements.waLinkedJid.textContent = user.whatsappJid || "N/A";
    elements.waLinkedTime.textContent = user.lastActiveAt ? new Date(user.lastActiveAt).toLocaleDateString() : "Active";
  }
}

// Helper: Clean, localized date & time formatter e.g. "13 Oct, 11:32 AM"
function formatDateTime(timestamp) {
  if (!timestamp) return "";
  const d = new Date(Number(timestamp));
  if (isNaN(d.getTime())) return "";

  const datePart = d.toLocaleDateString([], { day: "numeric", month: "short" });
  const timePart = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
  return `${datePart}, ${timePart}`;
}

// ===================================================================
// TO-DO MANAGEMENT
// ===================================================================

async function loadTodos(silent = false) {
  try {
    const res = await fetch("/api/user/todos");
    if (res.ok) {
      const data = await res.json();
      const newTodos = data.todos || [];
      const serialized = JSON.stringify(newTodos);
      if (serialized !== state._lastTodosSerialized) {
        state._lastTodosSerialized = serialized;
        state.todos = newTodos;
        renderTodos();
      }
    }
  } catch (err) {
    if (!silent) console.error("Failed to load todos:", err);
  }
}

function renderTodos() {
  const list = elements.todosUl;
  list.innerHTML = "";

  elements.todoCountBadge.textContent = `${state.todos.length} Task${state.todos.length === 1 ? '' : 's'}`;

  if (state.todos.length === 0) {
    elements.todosEmptyState.classList.remove("hidden");
    return;
  }

  elements.todosEmptyState.classList.add("hidden");

  state.todos.forEach(todo => {
    const isCompleted = todo.status === "completed";
    const li = document.createElement("li");
    li.className = `task-item ${isCompleted ? 'task-completed' : ''}`;

    let timeBadge = "";
    if (todo.target_timestamp) {
      const timeFormatted = formatDateTime(todo.target_timestamp);
      timeBadge = `
        <span class="task-time-pill" title="Scheduled Alert Time">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
          ${escapeHtml(timeFormatted)}
        </span>
      `;
    }

    let sourceBadge = "";
    if (todo.is_reminder) {
      sourceBadge = `<span class="task-source-pill" title="Synced Reminder Alert">🔔 Reminder</span>`;
    }

    li.innerHTML = `
      <div class="task-left">
        <input type="checkbox" class="task-checkbox" ${isCompleted ? 'checked' : ''} data-id="${todo.id}">
        <div class="task-details">
          <div class="task-header-row">
            <span class="task-title">${escapeHtml(todo.name)}</span>
            ${timeBadge}
            ${sourceBadge}
          </div>
          ${todo.description ? `<span class="task-desc">${escapeHtml(todo.description)}</span>` : ''}
        </div>
      </div>
      <button class="btn-item-delete" data-id="${todo.id}" title="Delete task">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      </button>
    `;

    // Toggle Checkbox
    li.querySelector(".task-checkbox").addEventListener("change", async () => {
      await toggleTodo(todo.id);
    });

    // Delete Button
    li.querySelector(".btn-item-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      await deleteTodo(todo.id);
    });

    list.appendChild(li);
  });
}

async function addTodo(name, description) {
  try {
    const res = await fetch("/api/user/todos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description })
    });
    if (res.ok) {
      showToast("Task added successfully!", "success");
      elements.inputTodoName.value = "";
      elements.inputTodoDesc.value = "";
      await loadTodos();
    } else {
      const data = await res.json();
      showToast(data.error || "Failed to add task", "error");
    }
  } catch (err) {
    showToast("Error adding task", "error");
  }
}

async function toggleTodo(id) {
  try {
    const res = await fetch(`/api/user/todos/${id}/toggle`, { method: "PATCH" });
    if (res.ok) {
      await Promise.all([loadTodos(), loadReminders()]);
    }
  } catch (err) {
    showToast("Failed to update task", "error");
  }
}

async function deleteTodo(id) {
  try {
    const res = await fetch(`/api/user/todos/${id}`, { method: "DELETE" });
    if (res.ok) {
      showToast("Task deleted", "info");
      await Promise.all([loadTodos(), loadReminders()]);
    }
  } catch (err) {
    showToast("Failed to delete task", "error");
  }
}

// ===================================================================
// REMINDERS MANAGEMENT
// ===================================================================

async function loadReminders(silent = false) {
  try {
    const res = await fetch("/api/user/reminders");
    if (res.ok) {
      const data = await res.json();
      const newReminders = data.reminders || [];
      const serialized = JSON.stringify(newReminders);
      if (serialized !== state._lastRemindersSerialized) {
        state._lastRemindersSerialized = serialized;
        state.reminders = newReminders;
        renderReminders();
      }
    }
  } catch (err) {
    if (!silent) console.error("Failed to load reminders:", err);
  }
}

function renderReminders() {
  const list = elements.remindersUl;
  list.innerHTML = "";

  elements.reminderCountBadge.textContent = `${state.reminders.length} Reminder${state.reminders.length === 1 ? '' : 's'}`;

  if (state.reminders.length === 0) {
    elements.remindersEmptyState.classList.remove("hidden");
    return;
  }

  elements.remindersEmptyState.classList.add("hidden");

  state.reminders.forEach(rem => {
    const isSent = rem.status === "sent";
    const timeFormatted = formatDateTime(rem.target_timestamp);

    const li = document.createElement("li");
    li.className = `reminder-item ${isSent ? 'reminder-sent' : ''}`;

    li.innerHTML = `
      <div class="task-details">
        <span class="task-title">${escapeHtml(rem.name)}</span>
        ${rem.description ? `<span class="task-desc">${escapeHtml(rem.description)}</span>` : ''}
      </div>
      <div class="reminder-meta-group">
        <span class="reminder-time-badge" title="Scheduled Reminder Time">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
          ${timeFormatted}
        </span>
        <span class="reminder-status-badge ${isSent ? 'status-delivered' : 'status-pending'}">
          ${isSent ? '✓ Delivered' : '⏳ Pending'}
        </span>
        <button class="btn-item-delete" data-id="${rem.id}" title="Delete reminder">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      </div>
    `;

    li.querySelector(".btn-item-delete").addEventListener("click", async () => {
      await deleteReminder(rem.id);
    });

    list.appendChild(li);
  });
}

async function addReminder(name, description, targetTimestamp) {
  try {
    const res = await fetch("/api/user/reminders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, description, targetTimestamp })
    });
    if (res.ok) {
      showToast("Reminder scheduled!", "success");
      elements.inputRemName.value = "";
      elements.inputRemDesc.value = "";
      elements.inputRemTime.value = "";
      await Promise.all([loadReminders(), loadTodos()]);
    } else {
      const data = await res.json();
      showToast(data.error || "Failed to schedule reminder", "error");
    }
  } catch (err) {
    showToast("Error scheduling reminder", "error");
  }
}

async function deleteReminder(id) {
  try {
    const res = await fetch(`/api/user/reminders/${id}`, { method: "DELETE" });
    if (res.ok) {
      showToast("Reminder removed", "info");
      await Promise.all([loadReminders(), loadTodos()]);
    }
  } catch (err) {
    showToast("Failed to remove reminder", "error");
  }
}

// ===================================================================
// PLATFORM INTEGRATIONS (JIRA & GOOGLE CALENDAR)
// ===================================================================

async function loadIntegrations(silent = false) {
  try {
    const res = await fetch("/api/user/integrations");
    if (!res.ok) return;
    const data = await res.json();
    if (!data.success || !data.integrations) return;

    const { jira, google_calendar, google_drive, asana, email } = data.integrations;

    // Render Jira status
    if (elements.jiraStatusBadge) {
      if (jira.connected) {
        elements.jiraStatusBadge.className = "wa-badge linked";
        elements.jiraStatusBadge.textContent = jira.isGlobal ? "🟢 Global Config" : "🟢 Connected";
        if (elements.btnDisconnectJira && !jira.isGlobal) elements.btnDisconnectJira.classList.remove("hidden");
      } else {
        elements.jiraStatusBadge.className = "wa-badge unlinked";
        elements.jiraStatusBadge.textContent = "⚪ Not Connected";
        if (elements.btnDisconnectJira) elements.btnDisconnectJira.classList.add("hidden");
      }
      if (jira.host && !elements.jiraInputHost.value) elements.jiraInputHost.value = jira.host;
      if (jira.email && !elements.jiraInputEmail.value) elements.jiraInputEmail.value = jira.email;
      if (jira.defaultProject && !elements.jiraInputProject.value) elements.jiraInputProject.value = jira.defaultProject;
      if (jira.hasToken && !elements.jiraInputToken.value) elements.jiraInputToken.placeholder = "•••••••• (Token saved)";
    }

    // Render Google Calendar status
    if (elements.calendarStatusBadge) {
      if (google_calendar.connected) {
        elements.calendarStatusBadge.className = "wa-badge linked";
        elements.calendarStatusBadge.textContent = google_calendar.isGlobal ? "🟢 Global Config" : "🟢 Connected";
        if (elements.btnDisconnectCalendar && !google_calendar.isGlobal) elements.btnDisconnectCalendar.classList.remove("hidden");
      } else {
        elements.calendarStatusBadge.className = "wa-badge unlinked";
        elements.calendarStatusBadge.textContent = "⚪ Not Connected";
        if (elements.btnDisconnectCalendar) elements.btnDisconnectCalendar.classList.add("hidden");
      }
      if (google_calendar.calendarId && !elements.calInputId.value) elements.calInputId.value = google_calendar.calendarId;
      if (google_calendar.clientEmail && !elements.calInputEmail.value) elements.calInputEmail.value = google_calendar.clientEmail;
      if (google_calendar.hasCredentials && !elements.calInputKey.value) elements.calInputKey.placeholder = "•••••••• (Credentials saved)";
    }

    // Render Google Drive status
    if (elements.driveStatusBadge && google_drive) {
      if (google_drive.connected) {
        elements.driveStatusBadge.className = "wa-badge linked";
        elements.driveStatusBadge.textContent = google_drive.isGlobal ? "🟢 Global Config" : "🟢 Connected";
        if (elements.btnDisconnectDrive && !google_drive.isGlobal) elements.btnDisconnectDrive.classList.remove("hidden");
      } else {
        elements.driveStatusBadge.className = "wa-badge unlinked";
        elements.driveStatusBadge.textContent = "⚪ Not Connected";
        if (elements.btnDisconnectDrive) elements.btnDisconnectDrive.classList.add("hidden");
      }
      if (google_drive.folderId && !elements.driveInputFolder.value) elements.driveInputFolder.value = google_drive.folderId;
      if (google_drive.clientEmail && !elements.driveInputEmail.value) elements.driveInputEmail.value = google_drive.clientEmail;
      if (google_drive.hasCredentials && !elements.driveInputKey.value) elements.driveInputKey.placeholder = "•••••••• (Credentials saved)";
    }

    // Render Asana status
    if (elements.asanaStatusBadge && asana) {
      if (asana.connected) {
        elements.asanaStatusBadge.className = "wa-badge linked";
        elements.asanaStatusBadge.textContent = asana.isGlobal ? "🟢 Global Config" : "🟢 Connected";
        if (elements.btnDisconnectAsana && !asana.isGlobal) elements.btnDisconnectAsana.classList.remove("hidden");
      } else {
        elements.asanaStatusBadge.className = "wa-badge unlinked";
        elements.asanaStatusBadge.textContent = "⚪ Not Connected";
        if (elements.btnDisconnectAsana) elements.btnDisconnectAsana.classList.add("hidden");
      }
      if (asana.hasToken && !elements.asanaInputToken.value) {
        elements.asanaInputToken.placeholder = "•••••••• (Token saved)";
      }
      if (asana.workspaceId && elements.asanaSelectWorkspace && elements.asanaSelectWorkspace.options.length <= 1) {
        const opt = document.createElement("option");
        opt.value = asana.workspaceId;
        opt.textContent = `Workspace (${asana.workspaceId})`;
        opt.selected = true;
        elements.asanaSelectWorkspace.appendChild(opt);
      }
      if (asana.defaultProject && elements.asanaSelectProject && elements.asanaSelectProject.options.length <= 1) {
        const opt = document.createElement("option");
        opt.value = asana.defaultProject;
        opt.textContent = asana.defaultProjectName || `Project (${asana.defaultProject})`;
        opt.selected = true;
        elements.asanaSelectProject.appendChild(opt);
      }
    }

    // Render Email status
    if (elements.emailStatusBadge && email) {
      if (email.connected) {
        elements.emailStatusBadge.className = "wa-badge linked";
        elements.emailStatusBadge.textContent = email.isGlobal ? "🟢 Global Config" : "🟢 Connected";
        if (elements.btnDisconnectEmail && !email.isGlobal) elements.btnDisconnectEmail.classList.remove("hidden");
      } else {
        elements.emailStatusBadge.className = "wa-badge unlinked";
        elements.emailStatusBadge.textContent = "⚪ Not Connected";
        if (elements.btnDisconnectEmail) elements.btnDisconnectEmail.classList.add("hidden");
      }
      if (email.email && !elements.emailInputAddress.value) {
        elements.emailInputAddress.value = email.email;
      }
      if (email.hasPassword && !elements.emailInputPassword.value) {
        elements.emailInputPassword.placeholder = "•••••••• (Password saved)";
      }
      if (email.senderName && !elements.emailInputSenderName.value) {
        elements.emailInputSenderName.value = email.senderName;
      }
    }

    // Summary text
    if (elements.integrationsStatusText) {
      const activeCount = (jira.connected ? 1 : 0) + (google_calendar.connected ? 1 : 0) + (google_drive && google_drive.connected ? 1 : 0) + (asana && asana.connected ? 1 : 0) + (email && email.connected ? 1 : 0);
      elements.integrationsStatusText.textContent = `${activeCount} of 5 Platforms Active`;
    }
  } catch (err) {
    if (!silent) console.error("Error loading integrations:", err);
  }
}

async function saveJira(e) {
  e.preventDefault();
  const host = elements.jiraInputHost.value.trim();
  const email = elements.jiraInputEmail.value.trim();
  const apiToken = elements.jiraInputToken.value.trim();
  const defaultProject = elements.jiraInputProject.value.trim();

  elements.btnSaveJira.disabled = true;
  elements.btnSaveJira.textContent = "Saving...";

  try {
    const res = await fetch("/api/user/integrations/jira", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, email, apiToken, defaultProject })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("Jira settings saved successfully! WhatsApp bot is ready to create issues.", "success");
      await loadIntegrations();
    } else {
      showToast(data.error || "Failed to save Jira settings", "error");
    }
  } catch (err) {
    showToast("Network error saving Jira", "error");
  } finally {
    elements.btnSaveJira.disabled = false;
    elements.btnSaveJira.textContent = "Save Jira";
  }
}

async function testJira() {
  const host = elements.jiraInputHost.value.trim();
  const email = elements.jiraInputEmail.value.trim();
  const apiToken = elements.jiraInputToken.value.trim();

  elements.btnTestJira.disabled = true;
  elements.btnTestJira.textContent = "Testing...";

  try {
    const res = await fetch("/api/user/integrations/jira/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ host, email, apiToken })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message, "success");
      await loadIntegrations();
    } else {
      showToast(data.error || "Jira test failed", "error");
    }
  } catch (err) {
    showToast("Error connecting to Jira", "error");
  } finally {
    elements.btnTestJira.disabled = false;
    elements.btnTestJira.textContent = "Test Connection";
  }
}

async function disconnectJira() {
  if (!confirm("Are you sure you want to disconnect Jira from your WhatsApp bot?")) return;

  try {
    const res = await fetch("/api/user/integrations/jira", { method: "DELETE" });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("Jira disconnected.", "info");
      elements.jiraInputHost.value = "";
      elements.jiraInputEmail.value = "";
      elements.jiraInputToken.value = "";
      elements.jiraInputToken.placeholder = "Paste your Jira API token...";
      elements.jiraInputProject.value = "";
      elements.jiraPreviewDrawer.classList.add("hidden");
      await loadIntegrations();
    } else {
      showToast(data.error || "Failed to disconnect Jira", "error");
    }
  } catch (err) {
    showToast("Error disconnecting Jira", "error");
  }
}

async function previewJira() {
  elements.jiraPreviewDrawer.classList.remove("hidden");
  elements.jiraTicketsContainer.innerHTML = '<div class="preview-loading">Fetching Jira tickets...</div>';

  try {
    const res = await fetch("/api/user/integrations/jira/issues");
    const data = await res.json();
    if (res.ok && data.success) {
      const issues = data.issues || [];
      if (issues.length === 0) {
        elements.jiraTicketsContainer.innerHTML = '<div class="preview-loading">No issues found. Try saying <em>"Hey Anam create a Jira issue: Test task"</em> on WhatsApp!</div>';
        return;
      }
      elements.jiraTicketsContainer.innerHTML = issues.map(issue => `
        <div class="preview-item-card">
          <div class="preview-item-info">
            <span class="preview-item-title">[${escapeHtml(issue.key)}] ${escapeHtml(issue.summary)}</span>
            <span class="preview-item-sub">Assignee: ${escapeHtml(issue.assignee)} • ${escapeHtml(issue.issueType)}</span>
          </div>
          <div style="display:flex; align-items:center; gap:8px;">
            <span class="preview-item-tag tag-blue">${escapeHtml(issue.status)}</span>
            <a href="${issue.url}" target="_blank" class="btn btn-ghost btn-xs" title="Open in Jira">↗</a>
          </div>
        </div>
      `).join("");
    } else {
      elements.jiraTicketsContainer.innerHTML = `<div class="preview-loading" style="color:var(--danger)">${escapeHtml(data.error || "Please save valid Jira credentials first.")}</div>`;
    }
  } catch (err) {
    elements.jiraTicketsContainer.innerHTML = '<div class="preview-loading" style="color:var(--danger)">Error loading Jira issues</div>';
  }
}

function formatApiErrorHtml(errorStr) {
  if (!errorStr) return "Unknown error";
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const escaped = escapeHtml(errorStr);
  return escaped.replace(urlRegex, url => `<a href="${url}" target="_blank" style="color:#60a5fa; text-decoration:underline; font-weight:600;">${url} ↗</a>`);
}

async function autodetectCalendar() {
  if (!elements.btnAutodetectCalendar) return;
  elements.btnAutodetectCalendar.disabled = true;
  elements.btnAutodetectCalendar.textContent = "Detecting...";

  try {
    const res = await fetch("/api/user/integrations/google_calendar/auto-detect");
    const data = await res.json();
    if (res.ok && data.success && data.detected) {
      if (data.clientEmail) elements.calInputEmail.value = data.clientEmail;
      if (data.privateKey) elements.calInputKey.value = data.privateKey;
      if (state.user && state.user.email) {
        elements.calInputId.value = state.user.email;
      } else if (data.suggestedCalendarId) {
        elements.calInputId.value = data.suggestedCalendarId;
      }
      if (elements.saEmailHint && data.clientEmail) {
        elements.saEmailHint.textContent = data.clientEmail;
      }
      showToast(`Detected Service Account from ${data.fileName}! Credentials filled.`, "success");
    } else {
      showToast(data.message || "No service account JSON file found in workspace.", "info");
    }
  } catch (err) {
    showToast("Error detecting service account credentials.", "error");
  } finally {
    elements.btnAutodetectCalendar.disabled = false;
    elements.btnAutodetectCalendar.textContent = "⚡ Auto-Fill Credentials";
  }
}

function handleCalendarKeyInput() {
  const text = (elements.calInputKey.value || "").trim();
  if (text.startsWith("{") && text.includes("private_key")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.client_email) {
        elements.calInputEmail.value = parsed.client_email;
        if (elements.saEmailHint) elements.saEmailHint.textContent = parsed.client_email;
      }
      if (parsed.private_key) {
        elements.calInputKey.value = parsed.private_key.replace(/\\n/g, "\n").trim();
      }
      if (state.user && state.user.email && (elements.calInputId.value === "primary" || !elements.calInputId.value)) {
        elements.calInputId.value = state.user.email;
      }
      showToast("Parsed Service Account JSON! Credentials filled automatically.", "success");
    } catch {}
  }
}

async function saveCalendar(e) {
  e.preventDefault();
  const calendarId = elements.calInputId.value.trim();
  const clientEmail = elements.calInputEmail.value.trim();
  const privateKey = elements.calInputKey.value.trim();

  elements.btnSaveCalendar.disabled = true;
  elements.btnSaveCalendar.textContent = "Saving...";

  try {
    const res = await fetch("/api/user/integrations/google_calendar", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calendarId, clientEmail, privateKey })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      if (calendarId.toLowerCase() === "primary") {
        showToast("Saved! ⚠️ Note: Calendar ID is 'primary' (bot's headless calendar). Change it to your personal Gmail and share it to see events in your phone app.", "warning");
      } else {
        showToast("Google Calendar settings saved! WhatsApp bot is ready to sync reminders & schedule events.", "success");
      }
      await loadIntegrations();
    } else {
      showToast(data.error || "Failed to save Google Calendar", "error");
    }
  } catch (err) {
    showToast("Network error saving Google Calendar", "error");
  } finally {
    elements.btnSaveCalendar.disabled = false;
    elements.btnSaveCalendar.textContent = "Save Calendar";
  }
}

async function testCalendar() {
  const calendarId = elements.calInputId.value.trim();
  const clientEmail = elements.calInputEmail.value.trim();
  const privateKey = elements.calInputKey.value.trim();

  elements.btnTestCalendar.disabled = true;
  elements.btnTestCalendar.textContent = "Testing...";

  try {
    const res = await fetch("/api/user/integrations/google_calendar/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ calendarId, clientEmail, privateKey })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message, "success");
      await loadIntegrations();
    } else {
      if (data.error && data.error.includes("http")) {
        showToast("Google Calendar API is disabled. See the link below to enable it.", "error");
        elements.calendarPreviewDrawer.classList.remove("hidden");
        elements.calendarEventsContainer.innerHTML = `<div class="preview-loading" style="color:var(--danger); text-align:left; line-height:1.5;">${formatApiErrorHtml(data.error)}</div>`;
      } else {
        showToast(data.error || "Calendar test failed", "error");
      }
    }
  } catch (err) {
    showToast("Error connecting to Google Calendar", "error");
  } finally {
    elements.btnTestCalendar.disabled = false;
    elements.btnTestCalendar.textContent = "Test Connection";
  }
}

async function disconnectCalendar() {
  if (!confirm("Are you sure you want to disconnect Google Calendar from your WhatsApp bot?")) return;

  try {
    const res = await fetch("/api/user/integrations/google_calendar", { method: "DELETE" });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("Google Calendar disconnected.", "info");
      elements.calInputId.value = "primary";
      elements.calInputEmail.value = "";
      elements.calInputKey.value = "";
      elements.calInputKey.placeholder = "Paste private key or token...";
      elements.calendarPreviewDrawer.classList.add("hidden");
      await loadIntegrations();
    } else {
      showToast(data.error || "Failed to disconnect Calendar", "error");
    }
  } catch (err) {
    showToast("Error disconnecting Google Calendar", "error");
  }
}

async function handleInstantMeet() {
  const summary = prompt("Enter meeting topic (or leave blank for Instant Google Meet):", "Instant Team Meeting");
  if (summary === null) return;

  try {
    if (elements.btnInstantMeet) {
      elements.btnInstantMeet.disabled = true;
      elements.btnInstantMeet.textContent = "Creating...";
    }

    const res = await fetch("/api/user/integrations/calendar/instant-meet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: summary.trim() || "Instant Google Meet", durationMinutes: 30 })
    });
    const data = await res.json();
    if (res.ok && data.success && data.meet) {
      const meetLink = data.meet.meetLink || data.meet.hangoutLink || data.meet.location;
      showToast("Google Meet created! Opening meeting in a new tab...", "success");
      if (meetLink) {
        window.open(meetLink, "_blank");
      }
      await previewCalendar();
    } else {
      showToast(data.error || "Failed to create Google Meet", "error");
    }
  } catch (err) {
    showToast("Error creating Google Meet: " + err.message, "error");
  } finally {
    if (elements.btnInstantMeet) {
      elements.btnInstantMeet.disabled = false;
      elements.btnInstantMeet.textContent = "🎥 Instant G-Meet";
    }
  }
}

async function previewCalendar() {
  elements.calendarPreviewDrawer.classList.remove("hidden");
  elements.calendarEventsContainer.innerHTML = '<div class="preview-loading">Fetching events...</div>';

  try {
    const res = await fetch("/api/user/integrations/calendar/events?timeFrame=today");
    const data = await res.json();
    if (res.ok && data.success) {
      const events = data.events || [];
      if (events.length === 0) {
        elements.calendarEventsContainer.innerHTML = '<div class="preview-loading">No scheduled events today. You have a free schedule! ✨</div>';
        return;
      }
      elements.calendarEventsContainer.innerHTML = events.map(ev => {
        let timeStr = "All Day";
        if (!ev.isAllDay && ev.start) {
          const s = new Date(ev.start);
          timeStr = s.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12: true });
        }
        const meetUrl = ev.hangoutLink || (ev.location && ev.location.includes("meet.google.com") ? ev.location : "");
        return `
          <div class="preview-item-card">
            <div class="preview-item-info">
              <span class="preview-item-title">${escapeHtml(ev.summary)}</span>
              <span class="preview-item-sub">🕒 ${timeStr}${ev.location && !ev.location.includes("meet.google.com") ? ` • 📍 ${escapeHtml(ev.location)}` : ""}</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              ${meetUrl ? `<a href="${meetUrl}" target="_blank" class="btn btn-secondary btn-xs" style="border-color:#10b981; color:#10b981; font-weight:600;">🎥 Join Meet</a>` : `<span class="preview-item-tag tag-green">Scheduled</span>`}
            </div>
          </div>
        `;
      }).join("");
    } else {
      elements.calendarEventsContainer.innerHTML = `<div class="preview-loading" style="color:var(--danger); text-align:left; line-height:1.5;">${formatApiErrorHtml(data.error || "Please save valid Google Calendar credentials first.")}</div>`;
    }
  } catch (err) {
    elements.calendarEventsContainer.innerHTML = '<div class="preview-loading" style="color:var(--danger)">Error loading calendar events</div>';
  }
}

// ---------------- GOOGLE DRIVE INTEGRATION FUNCTIONS ----------------

async function autodetectDrive() {
  if (!elements.btnAutodetectDrive) return;
  elements.btnAutodetectDrive.disabled = true;
  elements.btnAutodetectDrive.textContent = "Detecting...";

  try {
    const res = await fetch("/api/user/integrations/google_drive/auto-detect");
    const data = await res.json();
    if (res.ok && data.success && data.detected) {
      if (data.clientEmail) elements.driveInputEmail.value = data.clientEmail;
      if (data.privateKey) elements.driveInputKey.value = data.privateKey;
      if (elements.driveSaEmailHint && data.clientEmail) {
        elements.driveSaEmailHint.textContent = data.clientEmail;
      }
      showToast(`Detected Service Account from ${data.fileName}! Credentials filled.`, "success");
    } else {
      showToast(data.message || "No service account JSON file found in workspace.", "info");
    }
  } catch (err) {
    showToast("Error detecting service account credentials.", "error");
  } finally {
    elements.btnAutodetectDrive.disabled = false;
    elements.btnAutodetectDrive.textContent = "⚡ Auto-Fill Credentials";
  }
}

function handleDriveKeyInput() {
  const text = (elements.driveInputKey.value || "").trim();
  if (text.startsWith("{") && text.includes("private_key")) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.client_email) {
        elements.driveInputEmail.value = parsed.client_email;
        if (elements.driveSaEmailHint) elements.driveSaEmailHint.textContent = parsed.client_email;
      }
      if (parsed.private_key) {
        elements.driveInputKey.value = parsed.private_key.replace(/\\n/g, "\n").trim();
      }
      showToast("Parsed Service Account JSON! Credentials filled automatically.", "success");
    } catch {}
  }
}

async function saveDrive(e) {
  e.preventDefault();
  const folderId = elements.driveInputFolder.value.trim();
  const clientEmail = elements.driveInputEmail.value.trim();
  const privateKey = elements.driveInputKey.value.trim();

  elements.btnSaveDrive.disabled = true;
  elements.btnSaveDrive.textContent = "Saving...";

  try {
    const res = await fetch("/api/user/integrations/google_drive", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId, clientEmail, privateKey })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("Google Drive settings saved! WhatsApp bot can now search and upload files.", "success");
      await loadIntegrations();
    } else {
      showToast(data.error || "Failed to save Google Drive", "error");
    }
  } catch (err) {
    showToast("Network error saving Google Drive", "error");
  } finally {
    elements.btnSaveDrive.disabled = false;
    elements.btnSaveDrive.textContent = "Save Drive";
  }
}

async function testDrive() {
  const folderId = elements.driveInputFolder.value.trim();
  const clientEmail = elements.driveInputEmail.value.trim();
  const privateKey = elements.driveInputKey.value.trim();

  elements.btnTestDrive.disabled = true;
  elements.btnTestDrive.textContent = "Testing...";

  try {
    const res = await fetch("/api/user/integrations/google_drive/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderId, clientEmail, privateKey })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message, "success");
      await loadIntegrations();
    } else {
      if (data.error && data.error.includes("http")) {
        showToast("Google Drive API is disabled. See the link below to enable it.", "error");
        elements.drivePreviewDrawer.classList.remove("hidden");
        elements.driveFilesContainer.innerHTML = `<div class="preview-loading" style="color:var(--danger); text-align:left; line-height:1.5;">${formatApiErrorHtml(data.error)}</div>`;
      } else {
        showToast(data.error || "Google Drive test failed", "error");
      }
    }
  } catch (err) {
    showToast("Error connecting to Google Drive", "error");
  } finally {
    elements.btnTestDrive.disabled = false;
    elements.btnTestDrive.textContent = "Test Connection";
  }
}

async function disconnectDrive() {
  if (!confirm("Are you sure you want to disconnect Google Drive from your WhatsApp bot?")) return;

  try {
    const res = await fetch("/api/user/integrations/google_drive", { method: "DELETE" });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("Google Drive disconnected.", "info");
      elements.driveInputFolder.value = "";
      elements.driveInputEmail.value = "";
      elements.driveInputKey.value = "";
      elements.driveInputKey.placeholder = "Paste private key...";
      elements.drivePreviewDrawer.classList.add("hidden");
      await loadIntegrations();
    } else {
      showToast(data.error || "Failed to disconnect Drive", "error");
    }
  } catch (err) {
    showToast("Error disconnecting Google Drive", "error");
  }
}

async function previewDrive() {
  elements.drivePreviewDrawer.classList.remove("hidden");
  elements.driveFilesContainer.innerHTML = '<div class="preview-loading">Fetching Google Drive files...</div>';

  try {
    const res = await fetch("/api/user/integrations/google_drive/files");
    const data = await res.json();
    if (res.ok && data.success) {
      const files = data.files || [];
      if (files.length === 0) {
        elements.driveFilesContainer.innerHTML = '<div class="preview-empty" style="text-align:center; padding:18px; color:var(--text-muted);">No files found in Google Drive folder.<br><small style="color:var(--text-secondary); margin-top:4px; display:block;">Send photos or documents with caption "save to drive" on WhatsApp to upload!</small></div>';
        return;
      }

      elements.driveFilesContainer.innerHTML = files.map(file => {
        const sizeBadge = file.size ? `<span class="badge badge-sm" style="background:rgba(255,255,255,0.08); font-size:0.75rem; color:var(--text-secondary);">${escapeHtml(file.size)}</span>` : "";
        const dateStr = file.modifiedTime ? new Date(file.modifiedTime).toLocaleDateString() : "";
        return `
          <div class="preview-item" style="display:flex; justify-content:space-between; align-items:center; padding:10px 12px; border-bottom:1px solid rgba(255,255,255,0.06);">
            <div style="display:flex; align-items:center; gap:10px; overflow:hidden;">
              <span style="font-size:1.25rem;">${file.icon || "📄"}</span>
              <div style="overflow:hidden;">
                <div style="font-weight:600; font-size:0.9rem; white-space:nowrap; text-overflow:ellipsis; overflow:hidden;" title="${escapeHtml(file.name)}">
                  ${escapeHtml(file.name)}
                </div>
                <div style="font-size:0.75rem; color:var(--text-muted);">
                  ${dateStr ? `Modified ${dateStr}` : ""}
                </div>
              </div>
            </div>
            <div style="display:flex; align-items:center; gap:8px; flex-shrink:0;">
              ${sizeBadge}
              <a href="${escapeHtml(file.webViewLink)}" target="_blank" class="btn btn-ghost btn-xs" style="color:#34d399; text-decoration:none; display:inline-flex; align-items:center; gap:3px;">
                Open ↗
              </a>
            </div>
          </div>
        `;
      }).join("");
    } else {
      elements.driveFilesContainer.innerHTML = `<div class="preview-loading" style="color:var(--danger);">${formatApiErrorHtml(data.error || "Failed to load Drive files")}</div>`;
    }
  } catch (err) {
    elements.driveFilesContainer.innerHTML = '<div class="preview-loading" style="color:var(--danger);">Network error loading Google Drive files.</div>';
  }
}

// ---------------- ASANA INTEGRATION FUNCTIONS ----------------

function populateAsanaWorkspaces(workspaces, selectedGid) {
  if (!elements.asanaSelectWorkspace) return;
  elements.asanaSelectWorkspace.innerHTML = "";
  if (!workspaces || workspaces.length === 0) {
    elements.asanaSelectWorkspace.innerHTML = '<option value="">-- No Workspaces Found --</option>';
    return;
  }
  workspaces.forEach(ws => {
    const opt = document.createElement("option");
    opt.value = ws.gid;
    opt.textContent = ws.name;
    if (selectedGid && ws.gid === selectedGid) {
      opt.selected = true;
    }
    elements.asanaSelectWorkspace.appendChild(opt);
  });
}

function populateAsanaProjects(projects, selectedGid) {
  if (!elements.asanaSelectProject) return;
  elements.asanaSelectProject.innerHTML = '<option value="">-- All Assigned Tasks (Default) --</option>';
  if (!projects || projects.length === 0) return;

  projects.forEach(p => {
    const opt = document.createElement("option");
    opt.value = p.gid;
    opt.textContent = p.name;
    if (selectedGid && p.gid === selectedGid) {
      opt.selected = true;
    }
    elements.asanaSelectProject.appendChild(opt);
  });
}

async function loadAsanaProjectsForWorkspace(workspaceGid) {
  if (!workspaceGid) return;
  try {
    const res = await fetch(`/api/user/integrations/asana/projects?workspaceId=${encodeURIComponent(workspaceGid)}`);
    const data = await res.json();
    if (res.ok && data.success && data.projects) {
      populateAsanaProjects(data.projects);
    }
  } catch (err) {
    console.warn("Could not load projects for workspace:", err);
  }
}

async function createNewAsanaProject() {
  const workspaceGid = elements.asanaSelectWorkspace?.value || "";
  const projectName = prompt("Enter a name for the new Asana project (e.g. 'Personal to-dos' or 'Product Launch'):");
  if (!projectName || !projectName.trim()) return;

  if (elements.btnAsanaNewProject) {
    elements.btnAsanaNewProject.disabled = true;
    elements.btnAsanaNewProject.textContent = "Creating...";
  }

  try {
    const res = await fetch("/api/user/integrations/asana/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: projectName.trim(), workspaceId: workspaceGid || undefined })
    });
    const data = await res.json();
    if (res.ok && data.success && data.project) {
      showToast(`Project "${data.project.name}" created in Asana!`, "success");
      const opt = document.createElement("option");
      opt.value = data.project.gid;
      opt.textContent = data.project.name;
      opt.selected = true;
      elements.asanaSelectProject.appendChild(opt);
      await saveAsana(new Event("submit"));
    } else {
      showToast(data.error || "Failed to create Asana project", "error");
    }
  } catch (err) {
    showToast("Network error creating Asana project", "error");
  } finally {
    if (elements.btnAsanaNewProject) {
      elements.btnAsanaNewProject.disabled = false;
      elements.btnAsanaNewProject.textContent = "+ New Project";
    }
  }
}

async function saveAsana(e) {
  e.preventDefault();
  const accessToken = elements.asanaInputToken.value.trim();
  const workspaceId = elements.asanaSelectWorkspace.value;
  const defaultProject = elements.asanaSelectProject.value;
  const defaultProjectName = elements.asanaSelectProject.selectedOptions[0]?.textContent || "";

  elements.btnSaveAsana.disabled = true;
  elements.btnSaveAsana.textContent = "Saving...";

  try {
    const res = await fetch("/api/user/integrations/asana", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken, workspaceId, defaultProject, defaultProjectName })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message || "Asana settings saved successfully! WhatsApp bot is ready to manage tasks.", "success");
      await loadIntegrations();
    } else {
      showToast(data.error || "Failed to save Asana settings", "error");
    }
  } catch (err) {
    showToast("Network error saving Asana settings", "error");
  } finally {
    elements.btnSaveAsana.disabled = false;
    elements.btnSaveAsana.textContent = "Save Asana";
  }
}

async function testAsana() {
  const accessToken = elements.asanaInputToken.value.trim();
  const workspaceId = elements.asanaSelectWorkspace.value;

  elements.btnTestAsana.disabled = true;
  elements.btnTestAsana.textContent = "Testing...";

  try {
    const res = await fetch("/api/user/integrations/asana/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessToken, workspaceId })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message, "success");
      if (data.profile?.workspaces) {
        populateAsanaWorkspaces(data.profile.workspaces, workspaceId || data.profile.workspaces[0]?.gid);
      }
      if (data.projects) {
        populateAsanaProjects(data.projects);
      }
      await loadIntegrations();
    } else {
      showToast(data.error || "Asana test failed", "error");
    }
  } catch (err) {
    showToast("Error connecting to Asana", "error");
  } finally {
    elements.btnTestAsana.disabled = false;
    elements.btnTestAsana.textContent = "Test Connection";
  }
}

async function disconnectAsana() {
  if (!confirm("Are you sure you want to disconnect Asana from your WhatsApp bot?")) return;

  try {
    const res = await fetch("/api/user/integrations/asana", { method: "DELETE" });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("Asana disconnected.", "info");
      elements.asanaInputToken.value = "";
      elements.asanaInputToken.placeholder = "Paste your Asana Personal Access Token...";
      elements.asanaSelectWorkspace.innerHTML = '<option value="">-- Click \'Test Connection\' to Load Workspaces --</option>';
      elements.asanaSelectProject.innerHTML = '<option value="">-- All Assigned Tasks (Default) --</option>';
      elements.asanaPreviewDrawer.classList.add("hidden");
      await loadIntegrations();
    } else {
      showToast(data.error || "Failed to disconnect Asana", "error");
    }
  } catch (err) {
    showToast("Error disconnecting Asana", "error");
  }
}

async function previewAsana() {
  elements.asanaPreviewDrawer.classList.remove("hidden");
  elements.asanaTasksContainer.innerHTML = '<div class="preview-loading">Fetching Asana tasks...</div>';

  try {
    const res = await fetch("/api/user/integrations/asana/tasks");
    const data = await res.json();
    if (res.ok && data.success) {
      const tasks = data.tasks || [];
      if (tasks.length === 0) {
        elements.asanaTasksContainer.innerHTML = '<div class="preview-loading">No tasks found. Try saying <em>"Hey Anam add task: Buy groceries"</em> or <em>"asana add Fix landing page"</em> on WhatsApp!</div>';
        return;
      }
      elements.asanaTasksContainer.innerHTML = tasks.map(task => {
        const dueStr = task.due_on ? ` • 📅 Due: ${task.due_on}` : (task.due_at ? ` • 📅 Due: ${new Date(task.due_at).toLocaleDateString()}` : "");
        const projStr = task.projectName ? ` • 📁 ${escapeHtml(task.projectName)}` : "";
        const statusBadge = task.completed ? `<span class="preview-item-tag tag-green">Completed</span>` : `<span class="preview-item-tag tag-blue">Pending</span>`;
        return `
          <div class="preview-item-card">
            <div class="preview-item-info">
              <span class="preview-item-title">${escapeHtml(task.name)}</span>
              <span class="preview-item-sub">${escapeHtml(task.assignee || "Unassigned")}${dueStr}${projStr}</span>
            </div>
            <div style="display:flex; align-items:center; gap:8px;">
              ${statusBadge}
              <a href="${task.permalink_url}" target="_blank" class="btn btn-ghost btn-xs" title="Open in Asana">↗</a>
            </div>
          </div>
        `;
      }).join("");
    } else {
      elements.asanaTasksContainer.innerHTML = `<div class="preview-loading" style="color:var(--danger)">${escapeHtml(data.error || "Please save valid Asana credentials first.")}</div>`;
    }
  } catch (err) {
    elements.asanaTasksContainer.innerHTML = '<div class="preview-loading" style="color:var(--danger)">Error loading Asana tasks</div>';
  }
}

async function saveEmail(e) {
  e.preventDefault();
  const email = elements.emailInputAddress.value.trim();
  const appPassword = elements.emailInputPassword.value.trim();
  const senderName = elements.emailInputSenderName.value.trim();

  elements.btnSaveEmail.disabled = true;
  elements.btnSaveEmail.textContent = "Verifying & Saving...";

  try {
    const res = await fetch("/api/user/integrations/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, appPassword, senderName })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message || "Gmail connected successfully! Ready to draft & send.", "success");
      await loadIntegrations();
    } else {
      showToast(data.error || "Failed to save email settings", "error");
    }
  } catch (err) {
    showToast("Network error saving email settings", "error");
  } finally {
    elements.btnSaveEmail.disabled = false;
    elements.btnSaveEmail.textContent = "Save Email";
  }
}

async function testEmail() {
  const email = elements.emailInputAddress.value.trim();
  const appPassword = elements.emailInputPassword.value.trim();

  elements.btnTestEmail.disabled = true;
  elements.btnTestEmail.textContent = "Testing...";

  try {
    const res = await fetch("/api/user/integrations/email/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, appPassword })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message, "success");
      await loadIntegrations();
    } else {
      showToast(data.error || "Gmail connection failed", "error");
    }
  } catch (err) {
    showToast("Error connecting to Gmail", "error");
  } finally {
    elements.btnTestEmail.disabled = false;
    elements.btnTestEmail.textContent = "Test Connection";
  }
}

async function sendTestEmail() {
  elements.btnSendTestEmail.disabled = true;
  elements.btnSendTestEmail.textContent = "Sending...";

  try {
    const res = await fetch("/api/user/integrations/email/send-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message, "success");
    } else {
      showToast(data.error || "Failed to send test email", "error");
    }
  } catch (err) {
    showToast("Error sending test email", "error");
  } finally {
    elements.btnSendTestEmail.disabled = false;
    elements.btnSendTestEmail.textContent = "Send Test Email";
  }
}

async function disconnectEmail() {
  if (!confirm("Are you sure you want to disconnect your Gmail integration?")) return;

  try {
    const res = await fetch("/api/user/integrations/email", { method: "DELETE" });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("Email integration disconnected.", "info");
      elements.emailInputAddress.value = "";
      elements.emailInputPassword.value = "";
      elements.emailInputPassword.placeholder = "e.g. abcd efgh ijkl mnop";
      elements.emailPreviewDrawer.classList.add("hidden");
      await loadIntegrations();
    } else {
      showToast(data.error || "Failed to disconnect email", "error");
    }
  } catch (err) {
    showToast("Error disconnecting email", "error");
  }
}

async function previewEmailDrafts() {
  elements.emailPreviewDrawer.classList.remove("hidden");
  elements.emailDraftsContainer.innerHTML = '<div class="preview-loading">Fetching drafts...</div>';

  try {
    const res = await fetch("/api/user/integrations/email/drafts");
    const data = await res.json();
    if (res.ok && data.success) {
      const drafts = data.drafts || [];
      if (drafts.length === 0) {
        elements.emailDraftsContainer.innerHTML = '<div class="preview-loading">No pending email drafts. Try saying <em>"draft an email to boss@company.com"</em> on WhatsApp!</div>';
        return;
      }
      elements.emailDraftsContainer.innerHTML = drafts.map(draft => `
        <div class="preview-item-card" style="display:flex; justify-content:space-between; align-items:flex-start; padding:10px 12px; background:var(--bg-card); border-radius:8px; margin-bottom:8px; border:1px solid var(--border);">
          <div class="preview-item-info" style="flex:1;">
            <div style="font-weight:600; font-size:0.85rem; color:var(--text); margin-bottom:2px;">
              #${draft.id}: ${escapeHtml(draft.subject || "(No Subject)")}
            </div>
            <div style="font-size:0.75rem; color:var(--text-muted); margin-bottom:4px;">
              To: <code>${escapeHtml(draft.recipient)}</code>
            </div>
            <div style="font-size:0.78rem; color:var(--text-secondary); white-space:pre-wrap; max-height:80px; overflow-y:auto;">${escapeHtml(draft.body || "")}</div>
          </div>
          <div style="display:flex; gap:6px; margin-left:12px;">
            <button type="button" class="btn btn-primary btn-xs" onclick="sendDraftFromDashboard(${draft.id})" title="Send Now">Send ✈️</button>
            <button type="button" class="btn btn-ghost btn-xs" onclick="deleteDraftFromDashboard(${draft.id})" title="Delete" style="color:var(--danger)">🗑️</button>
          </div>
        </div>
      `).join("");
    } else {
      elements.emailDraftsContainer.innerHTML = `<div class="preview-loading" style="color:var(--danger)">${escapeHtml(data.error || "Failed to load drafts")}</div>`;
    }
  } catch (err) {
    elements.emailDraftsContainer.innerHTML = '<div class="preview-loading" style="color:var(--danger)">Error loading email drafts</div>';
  }
}

window.sendDraftFromDashboard = async function(draftId) {
  if (!confirm(`Send Draft #${draftId} now?`)) return;
  try {
    const res = await fetch("/api/user/integrations/email/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftId })
    });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(data.message || "Email sent successfully!", "success");
      await previewEmailDrafts();
    } else {
      showToast(data.error || "Failed to send email", "error");
    }
  } catch (err) {
    showToast("Network error sending email", "error");
  }
};

window.deleteDraftFromDashboard = async function(draftId) {
  if (!confirm(`Delete Draft #${draftId}?`)) return;
  try {
    const res = await fetch(`/api/user/integrations/email/drafts/${draftId}`, { method: "DELETE" });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast("Draft deleted.", "info");
      await previewEmailDrafts();
    } else {
      showToast(data.error || "Failed to delete draft", "error");
    }
  } catch (err) {
    showToast("Network error deleting draft", "error");
  }
};

// ===================================================================
// EVENT LISTENERS & MODAL CONTROLS
// ===================================================================

function initEventListeners() {
  // Modal openers
  elements.btnOpenSignIn.addEventListener("click", () => openAuthModal("signin"));
  elements.btnOpenSignUp.addEventListener("click", () => openAuthModal("signup"));
  elements.heroBtnSignUp.addEventListener("click", () => openAuthModal("signup"));
  elements.footerBtnSignUp.addEventListener("click", () => openAuthModal("signup"));

  // Modal closers
  elements.btnCloseModal.addEventListener("click", closeAuthModal);
  elements.authModal.addEventListener("click", (e) => {
    if (e.target === elements.authModal) closeAuthModal();
  });

  // Modal tab switchers
  elements.tabSignUp.addEventListener("click", () => switchAuthTab("signup"));
  elements.tabSignIn.addEventListener("click", () => switchAuthTab("signin"));
  elements.linkToSignIn.addEventListener("click", (e) => { e.preventDefault(); switchAuthTab("signin"); });
  elements.linkToSignUp.addEventListener("click", (e) => { e.preventDefault(); switchAuthTab("signup"); });

  // Sign Up Form Submit
  elements.formSignUp.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("signup-name").value;
    const email = document.getElementById("signup-email").value;
    const password = document.getElementById("signup-password").value;

    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast("Welcome! Your account & token are ready.", "success");
        setLoggedIn(data.user);
      } else {
        showToast(data.error || "Registration failed", "error");
      }
    } catch (err) {
      showToast("Registration error", "error");
    }
  });

  // Sign In Form Submit
  elements.formSignIn.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = document.getElementById("signin-email").value;
    const password = document.getElementById("signin-password").value;

    try {
      const res = await fetch("/api/auth/signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast("Signed in successfully!", "success");
        setLoggedIn(data.user);
      } else {
        showToast(data.error || "Sign in failed", "error");
      }
    } catch (err) {
      showToast("Sign in error", "error");
    }
  });

  // Logout Button
  elements.btnLogout.addEventListener("click", async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch (e) {}
    showToast("Signed out", "info");
    setLoggedOut();
  });

  // Copy Token Button
  elements.btnCopyToken.addEventListener("click", () => {
    if (state.user && state.user.authToken) {
      window.copyText(state.user.authToken);
    }
  });

  // Regenerate Token Button
  elements.btnRegenerateToken.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to generate a new token? The old token will no longer work.")) return;

    try {
      const res = await fetch("/api/user/regenerate-token", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.success) {
        state.user.authToken = data.authToken;
        renderWhatsAppStatus(state.user);
        showToast("New verification token generated!", "success");
      } else {
        showToast("Failed to regenerate token", "error");
      }
    } catch (err) {
      showToast("Error regenerating token", "error");
    }
  });

  // Unlink WhatsApp Button
  elements.btnUnlinkWa.addEventListener("click", async () => {
    if (!confirm("Disconnect your WhatsApp from this account? You will need to re-verify using your token.")) return;

    try {
      const res = await fetch("/api/user/unlink-whatsapp", { method: "POST" });
      const data = await res.json();
      if (res.ok && data.success) {
        state.user.isVerified = false;
        state.user.whatsappJid = null;
        state.user.phoneNumber = null;
        renderWhatsAppStatus(state.user);
        showToast("WhatsApp unlinked", "info");
      } else {
        showToast("Failed to unlink", "error");
      }
    } catch (err) {
      showToast("Error unlinking", "error");
    }
  });

  // Add Todo Form Submit
  elements.formAddTodo.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = elements.inputTodoName.value.trim();
    const desc = elements.inputTodoDesc.value.trim();
    if (name) addTodo(name, desc);
  });

  // Add Reminder Form Submit
  elements.formAddReminder.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = elements.inputRemName.value.trim();
    const timeVal = elements.inputRemTime.value;
    const desc = elements.inputRemDesc.value.trim();

    if (name && timeVal) {
      const timestamp = new Date(timeVal).getTime();
      if (timestamp <= Date.now()) {
        showToast("Please choose a time in the future", "error");
        return;
      }
      addReminder(name, desc, timestamp);
    }
  });

  // Platform Integrations: Jira
  if (elements.formJiraSettings) {
    elements.formJiraSettings.addEventListener("submit", saveJira);
  }
  if (elements.btnTestJira) {
    elements.btnTestJira.addEventListener("click", testJira);
  }
  if (elements.btnPreviewJira) {
    elements.btnPreviewJira.addEventListener("click", previewJira);
  }
  if (elements.btnCloseJiraPreview) {
    elements.btnCloseJiraPreview.addEventListener("click", () => elements.jiraPreviewDrawer.classList.add("hidden"));
  }
  if (elements.btnDisconnectJira) {
    elements.btnDisconnectJira.addEventListener("click", disconnectJira);
  }

  // Platform Integrations: Google Calendar
  if (elements.formCalendarSettings) {
    elements.formCalendarSettings.addEventListener("submit", saveCalendar);
  }
  if (elements.btnTestCalendar) {
    elements.btnTestCalendar.addEventListener("click", testCalendar);
  }
  if (elements.btnInstantMeet) {
    elements.btnInstantMeet.addEventListener("click", handleInstantMeet);
  }
  if (elements.btnPreviewCalendar) {
    elements.btnPreviewCalendar.addEventListener("click", previewCalendar);
  }
  if (elements.btnCloseCalendarPreview) {
    elements.btnCloseCalendarPreview.addEventListener("click", () => elements.calendarPreviewDrawer.classList.add("hidden"));
  }
  if (elements.btnDisconnectCalendar) {
    elements.btnDisconnectCalendar.addEventListener("click", disconnectCalendar);
  }
  if (elements.btnAutodetectCalendar) {
    elements.btnAutodetectCalendar.addEventListener("click", autodetectCalendar);
  }
  if (elements.calInputKey) {
    elements.calInputKey.addEventListener("input", handleCalendarKeyInput);
  }

  // Platform Integrations: Google Drive
  if (elements.formDriveSettings) {
    elements.formDriveSettings.addEventListener("submit", saveDrive);
  }
  if (elements.btnTestDrive) {
    elements.btnTestDrive.addEventListener("click", testDrive);
  }
  if (elements.btnPreviewDrive) {
    elements.btnPreviewDrive.addEventListener("click", previewDrive);
  }
  if (elements.btnCloseDrivePreview) {
    elements.btnCloseDrivePreview.addEventListener("click", () => elements.drivePreviewDrawer.classList.add("hidden"));
  }
  if (elements.btnDisconnectDrive) {
    elements.btnDisconnectDrive.addEventListener("click", disconnectDrive);
  }
  if (elements.btnAutodetectDrive) {
    elements.btnAutodetectDrive.addEventListener("click", autodetectDrive);
  }
  if (elements.driveInputKey) {
    elements.driveInputKey.addEventListener("input", handleDriveKeyInput);
  }

  // Platform Integrations: Asana
  if (elements.formAsanaSettings) {
    elements.formAsanaSettings.addEventListener("submit", saveAsana);
  }
  if (elements.btnTestAsana) {
    elements.btnTestAsana.addEventListener("click", testAsana);
  }
  if (elements.btnPreviewAsana) {
    elements.btnPreviewAsana.addEventListener("click", previewAsana);
  }
  if (elements.btnCloseAsanaPreview) {
    elements.btnCloseAsanaPreview.addEventListener("click", () => elements.asanaPreviewDrawer.classList.add("hidden"));
  }
  if (elements.btnDisconnectAsana) {
    elements.btnDisconnectAsana.addEventListener("click", disconnectAsana);
  }
  if (elements.btnAsanaNewProject) {
    elements.btnAsanaNewProject.addEventListener("click", createNewAsanaProject);
  }
  if (elements.asanaSelectWorkspace) {
    elements.asanaSelectWorkspace.addEventListener("change", (e) => loadAsanaProjectsForWorkspace(e.target.value));
  }

  // Platform Integrations: Email / Gmail
  if (elements.formEmailSettings) {
    elements.formEmailSettings.addEventListener("submit", saveEmail);
  }
  if (elements.btnTestEmail) {
    elements.btnTestEmail.addEventListener("click", testEmail);
  }
  if (elements.btnSendTestEmail) {
    elements.btnSendTestEmail.addEventListener("click", sendTestEmail);
  }
  if (elements.btnPreviewDrafts) {
    elements.btnPreviewDrafts.addEventListener("click", previewEmailDrafts);
  }
  if (elements.btnCloseEmailPreview) {
    elements.btnCloseEmailPreview.addEventListener("click", () => elements.emailPreviewDrawer.classList.add("hidden"));
  }
  if (elements.btnDisconnectEmail) {
    elements.btnDisconnectEmail.addEventListener("click", disconnectEmail);
  }
}

function openAuthModal(tab = "signup") {
  elements.authModal.classList.remove("hidden");
  switchAuthTab(tab);
}

function closeAuthModal() {
  elements.authModal.classList.add("hidden");
}

function switchAuthTab(tab) {
  if (tab === "signup") {
    elements.tabSignUp.classList.add("active");
    elements.tabSignIn.classList.remove("active");
    elements.formSignUp.classList.remove("hidden");
    elements.formSignIn.classList.add("hidden");
  } else {
    elements.tabSignIn.classList.add("active");
    elements.tabSignUp.classList.remove("active");
    elements.formSignIn.classList.remove("hidden");
    elements.formSignUp.classList.add("hidden");
  }
}

function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
