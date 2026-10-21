/**
 * Asana Integration Service
 * Communicates with Asana REST API v1.0 (https://app.asana.com/api/1.0/)
 */

function cleanToken(rawToken) {
  if (!rawToken) return "";
  return rawToken.trim();
}

/**
 * Resolves effective Asana configuration from user settings or environment variables
 */
export function getEffectiveAsanaConfig(userConfig = null) {
  const accessToken = cleanToken(userConfig?.accessToken || process.env.ASANA_ACCESS_TOKEN || "");
  const workspaceId = (userConfig?.workspaceId || process.env.ASANA_DEFAULT_WORKSPACE || "").trim();
  const defaultProject = (userConfig?.defaultProject || process.env.ASANA_DEFAULT_PROJECT || "").trim();
  const defaultProjectName = (userConfig?.defaultProjectName || "").trim();

  const isConfigured = Boolean(accessToken);
  return {
    accessToken,
    workspaceId,
    defaultProject,
    defaultProjectName,
    isConfigured
  };
}

function getAuthHeaders(accessToken) {
  return {
    "Authorization": `Bearer ${accessToken.trim()}`,
    "Content-Type": "application/json",
    "Accept": "application/json"
  };
}

/**
 * Test Asana Connection by fetching current user profile and workspaces
 */
export async function testAsanaConnection(config) {
  const effective = getEffectiveAsanaConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Asana Personal Access Token is required.");
  }

  const url = "https://app.asana.com/api/1.0/users/me";
  const res = await fetch(url, {
    method: "GET",
    headers: getAuthHeaders(effective.accessToken)
  });

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error("Authentication failed (401 Unauthorized). Please check your Asana Personal Access Token.");
    }
    const errText = await res.text();
    throw new Error(`Asana connection failed (${res.status}): ${errText}`);
  }

  const json = await res.json();
  const user = json.data || {};

  return {
    success: true,
    gid: user.gid,
    name: user.name || "Asana User",
    email: user.email || "",
    workspaces: (user.workspaces || []).map(w => ({ gid: w.gid, name: w.name }))
  };
}

/**
 * Get all accessible workspaces
 */
export async function getAsanaWorkspaces(config) {
  const effective = getEffectiveAsanaConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Asana is not configured.");
  }

  const url = "https://app.asana.com/api/1.0/workspaces?opt_fields=gid,name";
  const res = await fetch(url, {
    headers: getAuthHeaders(effective.accessToken)
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Asana workspaces (${res.status})`);
  }

  const json = await res.json();
  return (json.data || []).map(w => ({ gid: w.gid, name: w.name }));
}

/**
 * Get projects in a workspace
 */
export async function getAsanaProjects(config, workspaceGid = "") {
  const effective = getEffectiveAsanaConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Asana is not configured.");
  }

  let targetWorkspace = workspaceGid || effective.workspaceId;
  if (!targetWorkspace) {
    const profile = await testAsanaConnection(config);
    if (profile.workspaces && profile.workspaces.length > 0) {
      targetWorkspace = profile.workspaces[0].gid;
    }
  }

  if (!targetWorkspace) {
    throw new Error("Could not determine Asana workspace.");
  }

  const url = `https://app.asana.com/api/1.0/workspaces/${targetWorkspace}/projects?opt_fields=gid,name,color,notes&limit=50`;
  const res = await fetch(url, {
    headers: getAuthHeaders(effective.accessToken)
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Asana projects (${res.status})`);
  }

  const json = await res.json();
  return (json.data || []).map(p => ({
    gid: p.gid,
    name: p.name,
    color: p.color,
    notes: p.notes
  }));
}

/**
 * Query Asana tasks (from a project or user's assigned tasks in workspace)
 */
export async function getAsanaTasks(config, { workspaceGid = "", projectGid = "", completed = false, maxResults = 10 } = {}) {
  const effective = getEffectiveAsanaConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Asana is not configured. Please add your Personal Access Token in the dashboard.");
  }

  const targetProject = projectGid || effective.defaultProject;
  const fields = "gid,name,completed,due_on,due_at,notes,projects.name,assignee.name,permalink_url,created_at";

  let url = "";
  if (targetProject) {
    url = `https://app.asana.com/api/1.0/projects/${targetProject}/tasks?opt_fields=${fields}&limit=${Math.max(1, Number(maxResults) || 10)}`;
  } else {
    let targetWorkspace = workspaceGid || effective.workspaceId;
    if (!targetWorkspace) {
      const profile = await testAsanaConnection(config);
      if (profile.workspaces && profile.workspaces.length > 0) {
        targetWorkspace = profile.workspaces[0].gid;
      }
    }
    url = `https://app.asana.com/api/1.0/tasks?assignee=me&workspace=${targetWorkspace}&completed_since=now&opt_fields=${fields}&limit=${Math.max(1, Number(maxResults) || 10)}`;
  }

  const res = await fetch(url, {
    headers: getAuthHeaders(effective.accessToken)
  });

  if (!res.ok) {
    const errText = await res.text();
    let msg = `Failed to fetch Asana tasks (${res.status})`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed.errors && parsed.errors.length > 0) {
        msg = parsed.errors.map(e => e.message).join(", ");
      }
    } catch {}
    throw new Error(msg);
  }

  const json = await res.json();
  let tasks = (json.data || []).map(item => ({
    gid: item.gid,
    name: item.name || "Untitled Task",
    completed: Boolean(item.completed),
    dueOn: item.due_on || null,
    dueAt: item.due_at || null,
    notes: item.notes || "",
    projectName: (item.projects && item.projects[0] && item.projects[0].name) || effective.defaultProjectName || "",
    assigneeName: item.assignee?.name || "Me",
    url: item.permalink_url || `https://app.asana.com/0/0/${item.gid}`,
    createdAt: item.created_at
  }));

  if (!completed) {
    tasks = tasks.filter(t => !t.completed);
  }

  return {
    total: tasks.length,
    tasks
  };
}

/**
 * Retrieve single task details by GID
 */
export async function getAsanaTask(config, taskGid) {
  const effective = getEffectiveAsanaConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Asana is not configured.");
  }

  const cleanGid = String(taskGid).trim();
  const fields = "gid,name,completed,due_on,due_at,notes,projects.name,assignee.name,permalink_url,created_at,modified_at";
  const url = `https://app.asana.com/api/1.0/tasks/${cleanGid}?opt_fields=${fields}`;

  const res = await fetch(url, {
    headers: getAuthHeaders(effective.accessToken)
  });

  if (!res.ok) {
    throw new Error(`Asana task ${cleanGid} not found (${res.status})`);
  }

  const json = await res.json();
  const item = json.data || {};

  return {
    gid: item.gid,
    name: item.name || "Untitled Task",
    completed: Boolean(item.completed),
    dueOn: item.due_on || null,
    dueAt: item.due_at || null,
    notes: item.notes || "",
    projectName: (item.projects && item.projects[0] && item.projects[0].name) || effective.defaultProjectName || "",
    assigneeName: item.assignee?.name || "Unassigned",
    url: item.permalink_url || `https://app.asana.com/0/0/${item.gid}`,
    createdAt: item.created_at,
    modifiedAt: item.modified_at
  };
}

/**
 * Create a new task in Asana
 */
export async function createAsanaTask(config, { name, notes = "", projectGid = "", dueOn = "", workspaceGid = "" }) {
  const effective = getEffectiveAsanaConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Asana is not configured. Please connect Asana in your dashboard.");
  }

  if (!name || !name.trim()) {
    throw new Error("Task name is required.");
  }

  const targetProject = projectGid || effective.defaultProject;
  let targetWorkspace = workspaceGid || effective.workspaceId;

  if (!targetProject && !targetWorkspace) {
    const profile = await testAsanaConnection(config);
    if (profile.workspaces && profile.workspaces.length > 0) {
      targetWorkspace = profile.workspaces[0].gid;
    }
  }

  const taskData = {
    name: name.trim(),
    notes: notes.trim(),
    assignee: "me"
  };

  if (targetProject) {
    taskData.projects = [targetProject];
  } else if (targetWorkspace) {
    taskData.workspace = targetWorkspace;
  }

  if (dueOn) {
    taskData.due_on = dueOn; // Format: YYYY-MM-DD
  }

  const url = "https://app.asana.com/api/1.0/tasks";
  const res = await fetch(url, {
    method: "POST",
    headers: getAuthHeaders(effective.accessToken),
    body: JSON.stringify({ data: taskData })
  });

  if (!res.ok) {
    const errText = await res.text();
    let msg = `Failed to create Asana task (${res.status})`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed.errors && parsed.errors.length > 0) {
        msg = parsed.errors.map(e => e.message).join(", ");
      }
    } catch {}
    throw new Error(msg);
  }

  const json = await res.json();
  const created = json.data || {};

  return {
    gid: created.gid,
    name: created.name,
    dueOn: created.due_on || null,
    notes: created.notes || "",
    projectName: (created.projects && created.projects[0] && created.projects[0].name) || effective.defaultProjectName || "",
    url: created.permalink_url || `https://app.asana.com/0/0/${created.gid}`
  };
}

/**
 * Mark an Asana task as completed
 */
export async function completeAsanaTask(config, taskGid) {
  const effective = getEffectiveAsanaConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Asana is not configured.");
  }

  const cleanGid = String(taskGid).trim();
  const url = `https://app.asana.com/api/1.0/tasks/${cleanGid}`;

  const res = await fetch(url, {
    method: "PUT",
    headers: getAuthHeaders(effective.accessToken),
    body: JSON.stringify({ data: { completed: true } })
  });

  if (!res.ok) {
    throw new Error(`Failed to complete Asana task (${res.status})`);
  }

  const json = await res.json();
  const data = json.data || {};

  return {
    success: true,
    gid: data.gid || cleanGid,
    name: data.name || "Task",
    url: data.permalink_url || `https://app.asana.com/0/0/${cleanGid}`
  };
}

/**
 * Add a comment (story) to an Asana task
 */
export async function addAsanaComment(config, params = {}) {
  const effective = getEffectiveAsanaConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Asana is not configured.");
  }

  const rawGid = params.taskGid || params.taskId || "";
  const commentText = (params.comment || params.text || "").trim();
  const cleanGid = String(rawGid).trim();

  if (!cleanGid) {
    throw new Error("Task GID is required to add a comment.");
  }

  const url = `https://app.asana.com/api/1.0/tasks/${cleanGid}/stories`;

  const res = await fetch(url, {
    method: "POST",
    headers: getAuthHeaders(effective.accessToken),
    body: JSON.stringify({ data: { text: commentText } })
  });

  if (!res.ok) {
    throw new Error(`Failed to add comment to Asana task (${res.status})`);
  }

  const json = await res.json();
  const data = json.data || {};

  return {
    success: true,
    gid: data.gid,
    taskGid: cleanGid,
    text: data.text
  };
}

/**
 * Update an existing task in Asana (name, notes, due date, completed)
 */
export async function updateAsanaTask(config, taskGid, updates = {}) {
  const effective = getEffectiveAsanaConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Asana is not configured.");
  }

  const cleanGid = String(taskGid).trim();
  const taskData = {};

  if (updates.name !== undefined && updates.name.trim()) {
    taskData.name = updates.name.trim();
  }
  if (updates.notes !== undefined) {
    taskData.notes = updates.notes.trim();
  }
  if (updates.dueOn !== undefined) {
    taskData.due_on = updates.dueOn ? updates.dueOn.trim() : null;
  }
  if (updates.completed !== undefined) {
    taskData.completed = Boolean(updates.completed);
  }

  const url = `https://app.asana.com/api/1.0/tasks/${cleanGid}`;
  const res = await fetch(url, {
    method: "PUT",
    headers: getAuthHeaders(effective.accessToken),
    body: JSON.stringify({ data: taskData })
  });

  if (!res.ok) {
    const errText = await res.text();
    let msg = `Failed to update Asana task (${res.status})`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed.errors && parsed.errors.length > 0) {
        msg = parsed.errors.map(e => e.message).join(", ");
      }
    } catch {}
    throw new Error(msg);
  }

  const json = await res.json();
  const item = json.data || {};

  return {
    success: true,
    gid: item.gid || cleanGid,
    name: item.name,
    completed: Boolean(item.completed),
    dueOn: item.due_on || null,
    notes: item.notes || "",
    projectName: (item.projects && item.projects[0] && item.projects[0].name) || effective.defaultProjectName || "",
    url: item.permalink_url || `https://app.asana.com/0/0/${cleanGid}`
  };
}

/**
 * Create a new project in Asana
 */
export async function createAsanaProject(config, { name, workspaceGid = "", notes = "", color = "light-blue" } = {}) {
  const effective = getEffectiveAsanaConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Asana is not configured. Please add your Personal Access Token in the dashboard.");
  }

  if (!name || !name.trim()) {
    throw new Error("Project name is required.");
  }

  let targetWorkspace = workspaceGid || effective.workspaceId;
  if (!targetWorkspace) {
    const profile = await testAsanaConnection(config);
    if (profile.workspaces && profile.workspaces.length > 0) {
      targetWorkspace = profile.workspaces[0].gid;
    }
  }

  if (!targetWorkspace) {
    throw new Error("Could not determine Asana workspace for the project.");
  }

  const projectData = {
    name: name.trim(),
    workspace: targetWorkspace
  };
  if (notes) projectData.notes = notes.trim();
  if (color) projectData.color = color.trim();

  const url = "https://app.asana.com/api/1.0/projects";
  const res = await fetch(url, {
    method: "POST",
    headers: getAuthHeaders(effective.accessToken),
    body: JSON.stringify({ data: projectData })
  });

  if (!res.ok) {
    const errText = await res.text();
    let msg = `Failed to create Asana project (${res.status})`;
    try {
      const parsed = JSON.parse(errText);
      if (parsed.errors && parsed.errors.length > 0) {
        msg = parsed.errors.map(e => e.message).join(", ");
      }
    } catch {}
    throw new Error(msg);
  }

  const json = await res.json();
  const created = json.data || {};

  return {
    success: true,
    gid: created.gid,
    name: created.name,
    workspaceGid: targetWorkspace,
    notes: created.notes || "",
    color: created.color || color,
    url: created.permalink_url || `https://app.asana.com/0/${targetWorkspace}/${created.gid}`
  };
}

/**
 * Formatters for WhatsApp Chat
 */
export function formatAsanaTasksForWhatsApp(tasksResult) {
  const tasks = tasksResult?.tasks || [];
  if (!tasks || tasks.length === 0) {
    return "📋 *Asana Tasks*: No pending tasks found. All caught up!";
  }

  let text = `📋 *Your Asana Tasks* (${tasks.length}):\n\n`;
  tasks.forEach((item, idx) => {
    const statusEmoji = item.completed ? "🟢" : "🔵";
    const dueStr = item.dueOn || item.due_on;
    const taskUrl = item.url || item.permalink_url || `https://app.asana.com/0/0/${item.gid}`;
    text += `${idx + 1}. *${item.name}*\n`;
    text += `   ${statusEmoji} Status: _${item.completed ? "Completed" : "In Progress / Open"}_`;
    if (item.projectName) text += ` | Project: _${item.projectName}_`;
    if (dueStr) text += ` | Due: 📅 _${dueStr}_`;
    text += `\n   🔗 ${taskUrl}\n\n`;
  });

  text += `_💡 Tips: Reply "asana done <# or name>" to complete, "asana update <# or name> rename <title>", or "asana add project <name>" to create a project._`;
  return text.trim();
}

export function formatSingleAsanaTaskForWhatsApp(task) {
  const statusEmoji = task.completed ? "🟢" : "🔵";
  const dueStr = task.dueOn || task.due_on;
  const taskUrl = task.url || task.permalink_url || `https://app.asana.com/0/0/${task.gid}`;
  let text = `📋 *${task.name}*\n\n` +
             `• *Status*: ${statusEmoji} _${task.completed ? "Completed" : "Open"}_` +
             (task.projectName ? `\n• *Project*: 📁 _${task.projectName}_` : "") +
             (dueStr ? `\n• *Due Date*: 📅 _${dueStr}_` : "") +
             (task.assigneeName || task.assignee ? `\n• *Assignee*: 👤 ${task.assigneeName || task.assignee}` : "") +
             (task.notes ? `\n• *Notes*: _${task.notes.length > 200 ? task.notes.slice(0, 197) + "..." : task.notes}_` : "") +
             `\n• *Link*: ${taskUrl}\n\n` +
             `_💡 Actions: Reply "asana done ${task.name}" or "asana update ${task.name} due tomorrow"._`;
  return text.trim();
}

export function formatCreatedAsanaTaskForWhatsApp(created) {
  const dueStr = created.dueOn || created.due_on;
  const taskUrl = created.url || created.permalink_url || `https://app.asana.com/0/0/${created.gid}`;
  return `✨ *Asana Task Created!*\n` +
         `• Name: *${created.name}*\n` +
         (created.projectName ? `• Project: _${created.projectName}_\n` : "") +
         (dueStr ? `• Due Date: 📅 _${dueStr}_\n` : "") +
         `• Link: ${taskUrl}\n\n` +
         `_Synced with your Asana dashboard!_`;
}

export function formatCompletedAsanaTaskForWhatsApp(completed) {
  const taskUrl = completed.url || completed.permalink_url || `https://app.asana.com/0/0/${completed.gid}`;
  return `✅ *Asana Task Completed!*\n\n` +
         `Task *${completed.name}* is marked as completed.\n` +
         `Link: 🔗 ${taskUrl}`;
}

export function formatCreatedAsanaProjectForWhatsApp(project) {
  const projectUrl = project.url || `https://app.asana.com/0/${project.workspaceGid || "0"}/${project.gid}`;
  return `📁 *New Asana Project Created!*\n\n` +
         `• Name: *${project.name}*\n` +
         (project.notes ? `• Description: _${project.notes}_\n` : "") +
         `• Link: 🔗 ${projectUrl}\n\n` +
         `✨ *Added to your Asana Dashboard!* Tasks can now be added to this project directly from WhatsApp.`;
}

export function formatUpdatedAsanaTaskForWhatsApp(task, details = "") {
  const taskUrl = task.url || `https://app.asana.com/0/0/${task.gid}`;
  const statusStr = task.completed ? "🟢 Completed" : "🔵 In Progress / Open";
  return `✏️ *Asana Task Updated!*\n\n` +
         `• Task: *${task.name}*\n` +
         `• Status: _${statusStr}_\n` +
         (task.dueOn ? `• Due Date: 📅 _${task.dueOn}_\n` : "") +
         (details ? `• Changes: _${details}_\n` : "") +
         `• Link: 🔗 ${taskUrl}\n\n` +
         `_Synced with your Asana dashboard._`;
}

export default {
  getEffectiveAsanaConfig,
  testAsanaConnection,
  getAsanaWorkspaces,
  getAsanaProjects,
  getAsanaTasks,
  getAsanaTask,
  createAsanaTask,
  completeAsanaTask,
  updateAsanaTask,
  createAsanaProject,
  addAsanaComment,
  formatAsanaTasksForWhatsApp,
  formatSingleAsanaTaskForWhatsApp,
  formatCreatedAsanaTaskForWhatsApp,
  formatCompletedAsanaTaskForWhatsApp,
  formatCreatedAsanaProjectForWhatsApp,
  formatUpdatedAsanaTaskForWhatsApp
};
