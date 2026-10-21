/**
 * Jira Integration Service
 * Communicates with Atlassian Jira Cloud REST API v3 / v2
 */

function cleanHost(rawHost) {
  if (!rawHost) return "";
  let host = rawHost.trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "");
  // Strip any trailing path or parameters (e.g. site.atlassian.net/jira/your-work -> site.atlassian.net)
  if (host.includes("/")) {
    host = host.split("/")[0].trim();
  }
  host = host.replace(/\/+$/, "");
  if (!host.includes(".")) {
    host = `${host}.atlassian.net`;
  }
  return host;
}

function getAuthHeader(email, apiToken) {
  const credentials = `${email.trim()}:${apiToken.trim()}`;
  return `Basic ${Buffer.from(credentials).toString("base64")}`;
}

function cleanProjectKey(rawProject) {
  if (!rawProject) return "";
  let p = rawProject.trim().toUpperCase();
  // If user entered issue key like "KAN-2", strip the ticket number to get "KAN"
  if (p.includes("-")) {
    p = p.split("-")[0].trim();
  }
  return p;
}

/**
 * Resolves effective Jira configuration from user config or environment variables
 */
export function getEffectiveJiraConfig(userConfig = null) {
  const host = cleanHost(userConfig?.host || process.env.JIRA_HOST || "");
  const email = (userConfig?.email || process.env.JIRA_EMAIL || "").trim();
  const apiToken = (userConfig?.apiToken || process.env.JIRA_API_TOKEN || "").trim();
  const defaultProject = cleanProjectKey(userConfig?.defaultProject || process.env.JIRA_DEFAULT_PROJECT || "");

  const isConfigured = Boolean(host && email && apiToken);
  return {
    host,
    email,
    apiToken,
    defaultProject,
    isConfigured
  };
}

/**
 * Test Jira Connection by verifying user profile
 */
export async function testJiraConnection(config) {
  const effective = getEffectiveJiraConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Jira credentials incomplete. Please provide Jira Host, Email, and API Token.");
  }

  const url = `https://${effective.host}/rest/api/3/myself`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": getAuthHeader(effective.email, effective.apiToken),
      "Accept": "application/json"
    }
  });

  if (!res.ok) {
    const errorText = await res.text();
    let msg = `Jira API error (${res.status} ${res.statusText})`;
    try {
      const parsed = JSON.parse(errorText);
      if (parsed.errorMessages && parsed.errorMessages.length > 0) {
        msg = parsed.errorMessages.join(", ");
      } else if (parsed.message) {
        msg = parsed.message;
      }
    } catch {}

    if (res.status === 401) {
      msg = `Authentication failed (401 Unauthorized). Your Jira Domain is likely incorrect, or your email/token do not match. Please verify your exact Jira site URL (e.g. your-subdomain.atlassian.net) and API Token.`;
    } else if (res.status === 404) {
      msg = `Jira domain '${effective.host}' not found (404). Please double-check your site name at https://start.atlassian.com.`;
    }

    throw new Error(msg);
  }

  const data = await res.json();
  return {
    success: true,
    displayName: data.displayName || data.name || effective.email,
    emailAddress: data.emailAddress || effective.email,
    accountId: data.accountId,
    host: effective.host
  };
}

/**
 * Create a new Jira issue
 */
export async function createJiraIssue(config, { summary, description = "", projectKey = "", issueType = "Task" }) {
  const effective = getEffectiveJiraConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Jira is not configured. Please connect your Jira account in the dashboard.");
  }

  let targetProject = cleanProjectKey(projectKey || effective.defaultProject || "");
  if (!targetProject) {
    try {
      const projRes = await fetch(`https://${effective.host}/rest/api/3/project`, {
        headers: {
          "Authorization": getAuthHeader(effective.email, effective.apiToken),
          "Accept": "application/json"
        }
      });
      if (projRes.ok) {
        const projs = await projRes.json();
        if (projs && projs.length > 0) targetProject = projs[0].key;
      }
    } catch {}
  }

  if (!targetProject) {
    throw new Error("Project key is required. E.g. 'KAN'. Please specify a project key.");
  }

  // Normalize issue type
  let cleanType = issueType.trim();
  if (!cleanType) cleanType = "Task";
  const capitalizedType = cleanType.charAt(0).toUpperCase() + cleanType.slice(1).toLowerCase();

  const url = `https://${effective.host}/rest/api/3/issue`;
  
  // Jira Cloud v3 ADF (Atlassian Document Format) for description
  const adfDescription = {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: description || summary
          }
        ]
      }
    ]
  };

  const body = {
    fields: {
      project: { key: targetProject },
      summary: summary.trim(),
      description: adfDescription,
      issuetype: { name: capitalizedType }
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": getAuthHeader(effective.email, effective.apiToken),
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errorText = await res.text();
    let parsedError = null;
    try { parsedError = JSON.parse(errorText); } catch {}

    // Auto-heal: If project key is invalid, fetch available projects and retry with valid one
    const projectErrMsg = parsedError?.errors?.project || "";
    if (projectErrMsg.includes("doesn't exist") || projectErrMsg.includes("permission")) {
      try {
        const projRes = await fetch(`https://${effective.host}/rest/api/3/project`, {
          headers: {
            "Authorization": getAuthHeader(effective.email, effective.apiToken),
            "Accept": "application/json"
          }
        });
        if (projRes.ok) {
          const projs = await projRes.json();
          const validKeys = projs.map(p => p.key);
          if (validKeys.length > 0 && validKeys[0] !== targetProject) {
            console.log(`[Jira Auto-Heal] Project '${targetProject}' not found. Retrying with valid project '${validKeys[0]}'...`);
            return await createJiraIssue({ ...config, defaultProject: validKeys[0] }, {
              summary,
              description,
              projectKey: validKeys[0],
              issueType: capitalizedType
            });
          }
        }
      } catch {}
    }

    const v2Url = `https://${effective.host}/rest/api/2/issue`;
    const v2Res = await fetch(v2Url, {
      method: "POST",
      headers: {
        "Authorization": getAuthHeader(effective.email, effective.apiToken),
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({
        fields: {
          project: { key: targetProject },
          summary: summary.trim(),
          description: description || summary,
          issuetype: { name: capitalizedType }
        }
      })
    });

    if (!v2Res.ok) {
      let msg = `Failed to create Jira issue (${res.status})`;
      if (parsedError?.errors) {
        msg = Object.entries(parsedError.errors).map(([k, v]) => `${k}: ${v}`).join("; ");
      } else if (parsedError?.errorMessages) {
        msg = parsedError.errorMessages.join(", ");
      }
      throw new Error(msg);
    }

    const dataV2 = await v2Res.json();
    return {
      id: dataV2.id,
      key: dataV2.key,
      url: `https://${effective.host}/browse/${dataV2.key}`,
      summary: summary.trim(),
      project: targetProject,
      issueType: capitalizedType
    };
  }

  const data = await res.json();
  return {
    id: data.id,
    key: data.key,
    url: `https://${effective.host}/browse/${data.key}`,
    summary: summary.trim(),
    project: targetProject,
    issueType: capitalizedType
  };
}

/**
 * Query Jira issues using JQL
 * Supports new /rest/api/3/search/jql (CHANGE-2046) with GET and legacy fallbacks
 */
export async function getJiraIssues(config, { jql = "", maxResults = 5 } = {}) {
  const effective = getEffectiveJiraConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Jira is not configured. Please connect your Jira account in the dashboard.");
  }

  let finalJql = jql ? jql.trim() : "";
  if (!finalJql) {
    if (effective.defaultProject) {
      finalJql = `project = "${effective.defaultProject}" ORDER BY updated DESC`;
    } else {
      finalJql = `assignee = currentUser() OR reporter = currentUser() ORDER BY updated DESC`;
    }
  }

  // Primary: New Atlassian Cloud /rest/api/3/search/jql endpoint (POST method)
  const fields = ["summary", "status", "priority", "assignee", "issuetype", "updated"];
  let res = await fetch(`https://${effective.host}/rest/api/3/search/jql`, {
    method: "POST",
    headers: {
      "Authorization": getAuthHeader(effective.email, effective.apiToken),
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({
      jql: finalJql,
      maxResults: Number(maxResults) || 5,
      fields
    })
  });

  // Fallback 1: GET /rest/api/3/search/jql
  if (!res.ok && (res.status === 405 || res.status === 404)) {
    const getJqlUrl = `https://${effective.host}/rest/api/3/search/jql?jql=${encodeURIComponent(finalJql)}&maxResults=${maxResults}&fields=${fields.join(",")}`;
    res = await fetch(getJqlUrl, {
      method: "GET",
      headers: {
        "Authorization": getAuthHeader(effective.email, effective.apiToken),
        "Accept": "application/json"
      }
    });
  }

  // Fallback 2: Legacy /rest/api/3/search for older instances
  if (!res.ok && res.status === 404) {
    const legacyUrl = `https://${effective.host}/rest/api/3/search?jql=${encodeURIComponent(finalJql)}&maxResults=${maxResults}&fields=${fields.join(",")}`;
    res = await fetch(legacyUrl, {
      method: "GET",
      headers: {
        "Authorization": getAuthHeader(effective.email, effective.apiToken),
        "Accept": "application/json"
      }
    });
  }

  if (!res.ok) {
    const errorText = await res.text();
    let msg = `Failed to search Jira issues (${res.status})`;
    try {
      const parsed = JSON.parse(errorText);
      if (parsed.errorMessages && parsed.errorMessages.length > 0) {
        msg = parsed.errorMessages.join(", ");
      } else if (parsed.message) {
        msg = parsed.message;
      }
    } catch {}

    if (res.status === 401) {
      msg = `Authentication failed (401). Please check that your Jira Domain (currently '${effective.host}') is correct and matches your Atlassian account.`;
    }

    throw new Error(msg);
  }

  const data = await res.json();
  const issues = (data.issues || []).map(item => ({
    id: item.id,
    key: item.key,
    summary: item.fields?.summary || "No summary",
    status: item.fields?.status?.name || "Unknown",
    issueType: item.fields?.issuetype?.name || "Task",
    priority: item.fields?.priority?.name || "Medium",
    assignee: item.fields?.assignee?.displayName || "Unassigned",
    url: `https://${effective.host}/browse/${item.key}`,
    updated: item.fields?.updated
  }));

  return {
    total: data.total || issues.length,
    issues,
    host: effective.host
  };
}

/**
 * Transition Jira Issue Status (e.g. In Progress, Done, Closed)
 */
export async function transitionJiraIssue(config, { issueKey, transitionName }) {
  const effective = getEffectiveJiraConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Jira is not configured.");
  }

  const cleanKey = issueKey.trim().toUpperCase();
  const targetName = transitionName.trim().toLowerCase();

  // 1. Fetch available transitions
  const transitionsUrl = `https://${effective.host}/rest/api/3/issue/${cleanKey}/transitions`;
  const getRes = await fetch(transitionsUrl, {
    method: "GET",
    headers: {
      "Authorization": getAuthHeader(effective.email, effective.apiToken),
      "Accept": "application/json"
    }
  });

  if (!getRes.ok) {
    throw new Error(`Could not find transitions for issue ${cleanKey}. Please verify the issue key.`);
  }

  const transData = await getRes.json();
  const available = transData.transitions || [];

  // Match transition by name (fuzzy match)
  const match = available.find(t => 
    t.name.toLowerCase() === targetName ||
    t.name.toLowerCase().includes(targetName) ||
    (targetName === "done" && (t.name.toLowerCase().includes("close") || t.name.toLowerCase().includes("finish") || t.name.toLowerCase().includes("complete") || t.name.toLowerCase().includes("resolved"))) ||
    (targetName === "in progress" && (t.name.toLowerCase().includes("start") || t.name.toLowerCase().includes("progress") || t.name.toLowerCase().includes("develop")))
  );

  if (!match) {
    const validNames = available.map(t => `"${t.name}"`).join(", ");
    throw new Error(`Cannot transition ${cleanKey} to "${transitionName}". Available transitions: ${validNames || "None"}`);
  }

  // 2. Perform transition
  const postRes = await fetch(transitionsUrl, {
    method: "POST",
    headers: {
      "Authorization": getAuthHeader(effective.email, effective.apiToken),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      transition: { id: match.id }
    })
  });

  if (!postRes.ok) {
    throw new Error(`Failed to update status for ${cleanKey} to "${match.name}".`);
  }

  return {
    success: true,
    issueKey: cleanKey,
    newStatus: match.name,
    url: `https://${effective.host}/browse/${cleanKey}`
  };
}

/**
 * Add Comment to Jira Issue
 */
export async function addJiraComment(config, { issueKey, comment }) {
  const effective = getEffectiveJiraConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Jira is not configured.");
  }

  const cleanKey = issueKey.trim().toUpperCase();
  const url = `https://${effective.host}/rest/api/3/issue/${cleanKey}/comment`;

  const body = {
    body: {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: comment.trim()
            }
          ]
        }
      ]
    }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": getAuthHeader(effective.email, effective.apiToken),
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw new Error(`Failed to add comment to Jira issue ${cleanKey}.`);
  }

  return {
    success: true,
    issueKey: cleanKey,
    url: `https://${effective.host}/browse/${cleanKey}`
  };
}

/**
 * Recursively extract plain text from Atlassian Document Format (ADF)
 */
function extractTextFromADF(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.text) return node.text;
  if (Array.isArray(node.content)) {
    return node.content.map(extractTextFromADF).filter(Boolean).join(" ");
  }
  return "";
}

/**
 * Retrieve a single Jira issue by key (e.g. "KAN-1", "KAN 1", or "1")
 */
export async function getJiraIssue(config, issueKey) {
  const effective = getEffectiveJiraConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Jira is not configured. Please connect your Jira account in the dashboard.");
  }

  let cleanKey = (issueKey || "").trim();
  // Normalize space or multiple spaces to hyphen e.g. "KAN 1" -> "KAN-1"
  cleanKey = cleanKey.replace(/^([A-Za-z0-9]+)\s+(\d+)$/, "$1-$2");
  // If only a number was provided, prefix the default project key
  if (/^\d+$/.test(cleanKey) && effective.defaultProject) {
    cleanKey = `${effective.defaultProject}-${cleanKey}`;
  }
  cleanKey = cleanKey.toUpperCase();

  const url = `https://${effective.host}/rest/api/3/issue/${cleanKey}`;
  let res = await fetch(url, {
    method: "GET",
    headers: {
      "Authorization": getAuthHeader(effective.email, effective.apiToken),
      "Accept": "application/json"
    }
  });

  if (!res.ok && res.status === 404) {
    const v2Url = `https://${effective.host}/rest/api/2/issue/${cleanKey}`;
    res = await fetch(v2Url, {
      method: "GET",
      headers: {
        "Authorization": getAuthHeader(effective.email, effective.apiToken),
        "Accept": "application/json"
      }
    });
  }

  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(`Jira issue '${cleanKey}' not found.`);
    }
    throw new Error(`Failed to retrieve Jira issue '${cleanKey}' (${res.status})`);
  }

  const data = await res.json();
  const fields = data.fields || {};

  let descText = "";
  if (typeof fields.description === "string") {
    descText = fields.description;
  } else if (fields.description) {
    descText = extractTextFromADF(fields.description);
  }

  return {
    id: data.id,
    key: data.key,
    summary: fields.summary || "No summary",
    status: fields.status?.name || "Unknown",
    issueType: fields.issuetype?.name || "Task",
    priority: fields.priority?.name || "Medium",
    assignee: fields.assignee?.displayName || "Unassigned",
    reporter: fields.reporter?.displayName || "Unknown",
    description: descText.trim(),
    url: `https://${effective.host}/browse/${data.key}`,
    created: fields.created,
    updated: fields.updated
  };
}

/**
 * Formatters for WhatsApp Chat
 */
export function formatIssuesForWhatsApp(issuesResult) {
  const { issues, total, host } = issuesResult;
  if (!issues || issues.length === 0) {
    return "📋 *Jira Tickets*: No matching issues found.";
  }

  let text = `📋 *Your Jira Tickets* (${issues.length} of ${total}):\n\n`;
  issues.forEach((item, idx) => {
    const statusEmoji = getStatusEmoji(item.status);
    text += `${idx + 1}. *[${item.key}]* ${item.summary}\n`;
    text += `   ${statusEmoji} Status: _${item.status}_ | Type: ${item.issueType}\n`;
    text += `   🔗 https://${host}/browse/${item.key}\n\n`;
  });

  text += `_💡 Tips: Reply "jira done KEY" to close, or "jira KEY" to view details._`;
  return text.trim();
}

export function formatSingleIssueForWhatsApp(issue) {
  const statusEmoji = getStatusEmoji(issue.status);
  let text = `🎫 *[${issue.key}] ${issue.summary}*\n\n` +
             `• *Status*: ${statusEmoji} _${issue.status}_\n` +
             `• *Priority*: ⚡ ${issue.priority}\n` +
             `• *Type*: ${issue.issueType}\n` +
             `• *Assignee*: 👤 ${issue.assignee}\n`;
  if (issue.description) {
    const truncated = issue.description.length > 250 ? issue.description.slice(0, 247) + "..." : issue.description;
    text += `• *Description*: _${truncated}_\n`;
  }
  text += `• *Link*: ${issue.url}\n\n` +
          `_💡 Quick Actions:_\n` +
          `• Reply *"jira done ${issue.key}"* to mark as Done\n` +
          `• Reply *"jira comment ${issue.key} <text>"* to add a note`;
  return text.trim();
}

export function formatCreatedIssueForWhatsApp(created) {
  return `🎫 *Jira Issue Created!*\n` +
         `• Key: *${created.key}*\n` +
         `• Summary: ${created.summary}\n` +
         `• Project: ${created.project} (${created.issueType})\n` +
         `• Link: ${created.url}\n\n` +
         `_Synced with Atlassian Jira Cloud._`;
}

export function formatTransitionForWhatsApp(result) {
  return `✅ *Jira Status Updated!*\n` +
         `Ticket *${result.issueKey}* moved to *${result.newStatus}*.\n` +
         `Link: ${result.url}`;
}

function getStatusEmoji(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("done") || s.includes("closed") || s.includes("resolved")) return "🟢";
  if (s.includes("progress") || s.includes("development") || s.includes("review")) return "🟡";
  return "🔵";
}

export default {
  getEffectiveJiraConfig,
  testJiraConnection,
  createJiraIssue,
  getJiraIssues,
  getJiraIssue,
  transitionJiraIssue,
  addJiraComment,
  formatIssuesForWhatsApp,
  formatSingleIssueForWhatsApp,
  formatCreatedIssueForWhatsApp,
  formatTransitionForWhatsApp
};
