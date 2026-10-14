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
  toastContainer: document.getElementById("toast-container")
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
