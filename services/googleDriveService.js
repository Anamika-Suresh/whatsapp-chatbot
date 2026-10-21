/**
 * Google Drive Integration Service
 * Communicates with Google Drive API v3 using googleapis
 */
import { google } from "googleapis";
import { Readable } from "stream";
import fs from "fs";
import path from "path";

/**
 * Searches local directory and parent directory for a downloaded Google Cloud Service Account JSON key
 */
export function findLocalServiceAccount() {
  try {
    const candidateDirs = [
      process.cwd(),
      path.resolve(process.cwd(), "..")
    ];

    for (const dir of candidateDirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        if (["package.json", "package-lock.json", "todos.json", "reminders.json", "bot_state.json"].includes(file)) continue;

        const fullPath = path.join(dir, file);
        try {
          const content = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
          if (content.type === "service_account" && content.client_email && content.private_key) {
            return {
              filePath: fullPath,
              fileName: file,
              client_email: content.client_email,
              private_key: content.private_key,
              project_id: content.project_id || ""
            };
          }
        } catch {}
      }
    }
  } catch {}
  return null;
}

/**
 * Strips surrounding quotes, unescapes newlines, and cleanly extracts PEM private key blocks.
 */
export function cleanPemKey(raw) {
  if (!raw || typeof raw !== "string") return "";
  let key = raw.trim();

  if (key.startsWith("{") && key.includes("private_key")) {
    try {
      const parsed = JSON.parse(key);
      if (parsed.private_key) key = parsed.private_key;
    } catch {}
  }

  key = key.replace(/^["'“”`]+|["'“”`]+$/g, "").trim();
  key = key.replace(/\\n/g, "\n").replace(/\\r/g, "\r");

  const pemMatch = key.match(/(-----BEGIN [A-Z0-9 ]+KEY-----[\s\S]*?-----END [A-Z0-9 ]+KEY-----)/i);
  if (pemMatch) {
    key = pemMatch[1].trim();
  }

  return key;
}

/**
 * Formats byte size to human readable (KB, MB, GB)
 */
export function formatBytes(bytes) {
  if (!bytes || isNaN(bytes)) return "";
  const num = parseInt(bytes, 10);
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  if (num < 1024 * 1024 * 1024) return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  return `${(num / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Pick an emoji icon according to file mime type
 */
export function getMimeIcon(mimeType, name = "") {
  if (!mimeType) return "📄";
  if (mimeType.includes("folder")) return "📁";
  if (mimeType.includes("pdf")) return "📄";
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel") || name.endsWith(".xlsx") || name.endsWith(".csv")) return "📊";
  if (mimeType.includes("document") || mimeType.includes("word") || name.endsWith(".docx") || name.endsWith(".doc")) return "📝";
  if (mimeType.includes("presentation") || mimeType.includes("powerpoint") || name.endsWith(".pptx")) return "📽️";
  if (mimeType.startsWith("image/")) return "🖼️";
  if (mimeType.startsWith("video/")) return "🎥";
  if (mimeType.startsWith("audio/")) return "🎵";
  if (mimeType.includes("zip") || mimeType.includes("compressed") || mimeType.includes("tar")) return "📦";
  if (mimeType.startsWith("text/")) return "📋";
  return "📎";
}

/**
 * Translates Google Drive API errors into friendly, actionable instructions
 */
export function formatDriveApiError(err, effective = {}) {
  const msg = err?.message || String(err);
  const proj = effective.projectId || "named-nomad-469810-r7";

  if (msg.includes("Google Drive API has not been used in project") || msg.includes("it is disabled") || msg.includes("Access Not Configured")) {
    return `Google Drive API is not enabled in your Google Cloud Project (${proj}).\n👉 Enable it in 1 click here: https://console.developers.google.com/apis/api/drive.googleapis.com/overview?project=${proj}`;
  }

  if (msg.includes("File not found") || msg.includes("404")) {
    return `The requested Google Drive file or folder was not found. If using a specific folder, verify that folder exists and is shared with "${effective.clientEmail}".`;
  }

  if (msg.includes("forbidden") || msg.includes("403") || msg.includes("insufficientPermissions") || msg.includes("accessNotConfigured")) {
    return `Permission denied on Google Drive.\n👉 Make sure the folder is shared with "${effective.clientEmail}" with "Editor" permission, and Google Drive API is enabled in project ${proj}.`;
  }

  if (msg.includes("Service Accounts do not have storage quota") || msg.includes("storage quota") || msg.includes("storageQuotaExceeded")) {
    return (
      `Google strictly blocks Service Accounts from uploading files to personal @gmail.com accounts (service accounts have 0 MB personal quota).\n\n` +
      `👉 *Permanent 1-Minute Fix:*\n` +
      `Connect with your personal Google account via OAuth so uploads use your 15 GB Drive quota!\n` +
      `Run in your terminal:\n` +
      `   *node scripts/authGoogleDrive.js*\n\n` +
      `Or if you have a Google Workspace account, use a *Shared Drive*.`
    );
  }

  if (msg.includes("DECODER routines") || msg.includes("unsupported")) {
    return `Private key format error. Please check your Google Service Account credentials.`;
  }

  return msg;
}

/**
 * Resolves effective Google Drive configuration from user settings, local files, and env vars
 */
export function getEffectiveDriveConfig(userConfig = null) {
  const localSA = findLocalServiceAccount();

  let clientEmail = (userConfig?.clientEmail || process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_EMAIL || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").trim();
  let privateKey = (userConfig?.privateKey || process.env.GOOGLE_DRIVE_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY || "").trim();
  let folderId = (userConfig?.folderId || process.env.GOOGLE_DRIVE_FOLDER_ID || "").trim();
  let serviceAccountJson = (userConfig?.serviceAccountJson || process.env.GOOGLE_DRIVE_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "").trim();
  
  // OAuth 2.0 Tokens (for personal @gmail.com accounts)
  let clientId = (userConfig?.clientId || userConfig?.client_id || process.env.GOOGLE_DRIVE_CLIENT_ID || "").trim();
  let clientSecret = (userConfig?.clientSecret || userConfig?.client_secret || process.env.GOOGLE_DRIVE_CLIENT_SECRET || "").trim();
  let refreshToken = (userConfig?.refreshToken || userConfig?.refresh_token || process.env.GOOGLE_DRIVE_REFRESH_TOKEN || "").trim();
  let accessToken = (userConfig?.accessToken || userConfig?.access_token || process.env.GOOGLE_DRIVE_ACCESS_TOKEN || "").trim();

  // If serviceAccountJson string is provided, extract client_email and private_key
  if (serviceAccountJson) {
    try {
      const parsed = typeof serviceAccountJson === "string" ? JSON.parse(serviceAccountJson) : serviceAccountJson;
      if (parsed.client_email) clientEmail = parsed.client_email;
      if (parsed.private_key) privateKey = parsed.private_key;
    } catch {}
  }

  if (privateKey) {
    privateKey = cleanPemKey(privateKey);
  }

  // Auto-recovery / Fallback using local service account file
  if (localSA) {
    if (!clientEmail || (!clientEmail.includes("gserviceaccount.com") && clientEmail.includes("@"))) {
      clientEmail = localSA.client_email;
    }
    if (!privateKey || !privateKey.includes("BEGIN")) {
      privateKey = cleanPemKey(localSA.private_key);
    }
  }

  const isOAuth = Boolean(refreshToken || accessToken);
  const isServiceAccount = Boolean(clientEmail && privateKey);
  const isConfigured = Boolean(isOAuth || isServiceAccount);

  return {
    clientEmail,
    privateKey,
    folderId,
    clientId,
    clientSecret,
    refreshToken,
    accessToken,
    isOAuth,
    isConfigured,
    projectId: localSA?.project_id || process.env.GOOGLE_PROJECT_ID || "named-nomad-469810-r7"
  };
}

/**
 * Creates authenticated Google Drive client
 */
export function getDriveClient(config) {
  const effective = getEffectiveDriveConfig(config);
  if (!effective.isConfigured) {
    throw new Error("Google Drive is not configured. Please connect your credentials in the dashboard.");
  }

  // 1. Prioritize OAuth 2.0 (Uses user's personal 15 GB quota, bypasses 0 MB service account limits)
  if (effective.refreshToken || effective.accessToken) {
    const oauth2Client = new google.auth.OAuth2(
      effective.clientId || process.env.GOOGLE_DRIVE_CLIENT_ID,
      effective.clientSecret || process.env.GOOGLE_DRIVE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({
      refresh_token: effective.refreshToken || undefined,
      access_token: effective.accessToken || undefined
    });
    return { drive: google.drive({ version: "v3", auth: oauth2Client }), effective };
  }

  // 2. Service Account JWT Auth (Only works for Google Workspace Shared Drives)
  if (effective.clientEmail && effective.privateKey) {
    const auth = new google.auth.JWT({
      email: effective.clientEmail,
      key: effective.privateKey,
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/drive.file"
      ]
    });
    return { drive: google.drive({ version: "v3", auth }), effective };
  }

  throw new Error("Missing valid Google Drive authentication credentials.");
}

/**
 * Test Google Drive connection
 */
export async function testDriveConnection(config) {
  const { drive, effective } = getDriveClient(config);

  try {
    let aboutInfo = null;
    try {
      const aboutRes = await drive.about.get({
        fields: "user, storageQuota"
      });
      aboutInfo = aboutRes.data;
    } catch (e) {
      // If about.get has restricted scopes, fallback to listing files
    }

    const filesRes = await drive.files.list({
      pageSize: 10,
      fields: "files(id, name, mimeType)"
    });

    return {
      success: true,
      clientEmail: effective.clientEmail,
      projectId: effective.projectId,
      folderId: effective.folderId || "root",
      totalSampleFiles: filesRes.data.files ? filesRes.data.files.length : 0,
      storageQuota: aboutInfo?.storageQuota || null,
      user: aboutInfo?.user || { emailAddress: effective.clientEmail }
    };
  } catch (err) {
    throw new Error(formatDriveApiError(err, effective));
  }
}

/**
 * List files in Google Drive (optionally in a folder or filtered by query/type)
 */
export async function listDriveFiles(config, { query = "", folderId = null, pageSize = 15, mimeType = null } = {}) {
  const { drive, effective } = getDriveClient(config);

  try {
    const queryParts = ["trashed = false"];

    const targetFolder = folderId !== undefined && folderId !== null ? folderId : effective.folderId;
    if (targetFolder && targetFolder !== "root" && targetFolder !== "all") {
      queryParts.push(`'${targetFolder}' in parents`);
    }

    if (query && query.trim()) {
      const sanitized = query.replace(/'/g, "\\'");
      queryParts.push(`name contains '${sanitized}'`);
    }

    if (mimeType) {
      queryParts.push(`mimeType = '${mimeType}'`);
    }

    const q = queryParts.join(" and ");

    const res = await drive.files.list({
      q,
      pageSize: Math.min(pageSize, 50),
      orderBy: "folder,modifiedTime desc",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: "files(id, name, mimeType, description, webViewLink, webContentLink, iconLink, size, createdTime, modifiedTime, shared, owners, parents)"
    });

    const files = (res.data.files || []).map(f => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      isFolder: f.mimeType === "application/vnd.google-apps.folder",
      icon: getMimeIcon(f.mimeType, f.name),
      size: f.size ? formatBytes(f.size) : (f.mimeType === "application/vnd.google-apps.folder" ? "Folder" : ""),
      sizeBytes: f.size ? parseInt(f.size, 10) : 0,
      webViewLink: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
      webContentLink: f.webContentLink || null,
      iconLink: f.iconLink || null,
      modifiedTime: f.modifiedTime,
      createdTime: f.createdTime,
      shared: Boolean(f.shared)
    }));

    return {
      success: true,
      files,
      total: files.length,
      folderId: targetFolder || "root",
      query: query || ""
    };
  } catch (err) {
    throw new Error(formatDriveApiError(err, effective));
  }
}

/**
 * Search files in Google Drive across names and text contents
 */
export async function searchDriveFiles(config, { query, pageSize = 10 } = {}) {
  const { drive, effective } = getDriveClient(config);

  if (!query || !query.trim()) {
    return listDriveFiles(config, { pageSize });
  }

  try {
    const sanitized = query.replace(/'/g, "\\'");
    // Search both name and full text if possible
    const q = `trashed = false and (name contains '${sanitized}' or fullText contains '${sanitized}')`;

    const res = await drive.files.list({
      q,
      pageSize: Math.min(pageSize, 30),
      orderBy: "modifiedTime desc",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: "files(id, name, mimeType, description, webViewLink, webContentLink, iconLink, size, modifiedTime)"
    });

    const files = (res.data.files || []).map(f => ({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      isFolder: f.mimeType === "application/vnd.google-apps.folder",
      icon: getMimeIcon(f.mimeType, f.name),
      size: f.size ? formatBytes(f.size) : "",
      webViewLink: f.webViewLink || `https://drive.google.com/file/d/${f.id}/view`,
      modifiedTime: f.modifiedTime
    }));

    return {
      success: true,
      query,
      files,
      total: files.length
    };
  } catch (err) {
    // If fullText search failed due to API limitations, fallback to name contains
    try {
      return await listDriveFiles(config, { query, pageSize });
    } catch {
      throw new Error(formatDriveApiError(err, effective));
    }
  }
}

/**
 * Upload a file to Google Drive (from Buffer or File Stream)
 */
export async function uploadDriveFile(config, { fileName, mimeType = "application/octet-stream", buffer = null, filePath = null, folderId = null, description = "" }) {
  const { drive, effective } = getDriveClient(config);

  try {
    let bodyStream;
    let computedSize = 0;

    if (buffer) {
      bodyStream = Readable.from(buffer);
      computedSize = buffer.length;
    } else if (filePath && fs.existsSync(filePath)) {
      bodyStream = fs.createReadStream(filePath);
      const stat = fs.statSync(filePath);
      computedSize = stat.size;
      if (!fileName) fileName = path.basename(filePath);
    } else {
      throw new Error("No file content or valid file path provided for Google Drive upload.");
    }

    let targetFolder = folderId !== undefined && folderId !== null ? folderId : effective.folderId;

    // If no target folder is explicitly configured, auto-detect any shared folder accessible by this service account
    if (!targetFolder || targetFolder === "root" || targetFolder === "all") {
      try {
        const folderRes = await drive.files.list({
          q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
          pageSize: 5,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          fields: "files(id, name)"
        });
        if (folderRes.data.files && folderRes.data.files.length > 0) {
          targetFolder = folderRes.data.files[0].id;
          console.log(`[GoogleDrive] Auto-detected shared folder "${folderRes.data.files[0].name}" (${targetFolder})`);
        }
      } catch (fErr) {
        console.warn("[GoogleDrive] Error querying shared folders:", fErr.message);
      }
    }

    // Google Cloud Service Accounts have 0 MB personal storage quota.
    // They CANNOT upload to the root; they must upload into a user's shared folder.
    if (!targetFolder || targetFolder === "root" || targetFolder === "all") {
      if (effective.clientEmail && effective.clientEmail.includes("gserviceaccount.com")) {
        throw new Error(
          `Google Service Accounts have 0 MB of personal storage quota.\n\n` +
          `👉 *30-Second Fix:*\n` +
          `1. Open Google Drive (https://drive.google.com)\n` +
          `2. Create a folder (e.g. *WhatsApp Files* or *Anam*)\n` +
          `3. Right-click ➔ *Share* ➔ add:\n   ${effective.clientEmail}\n   with *Editor* permission.\n\n` +
          `Once shared, all WhatsApp photos, videos, and documents will automatically be saved into that folder!`
        );
      }
    }

    const requestBody = {
      name: fileName || `Upload_${Date.now()}`,
      mimeType,
      description: description || "Uploaded via Anam AI WhatsApp Bot"
    };

    if (targetFolder && targetFolder !== "root" && targetFolder !== "all") {
      requestBody.parents = [targetFolder];
    }

    const res = await drive.files.create({
      requestBody,
      media: {
        mimeType,
        body: bodyStream
      },
      supportsAllDrives: true,
      fields: "id, name, mimeType, webViewLink, webContentLink, size, createdTime, parents"
    });

    const fileData = res.data;

    // Attempt to make file accessible via link (public reader)
    let shareableLink = fileData.webViewLink || `https://drive.google.com/file/d/${fileData.id}/view`;
    try {
      await drive.permissions.create({
        fileId: fileData.id,
        supportsAllDrives: true,
        requestBody: {
          role: "reader",
          type: "anyone"
        }
      });
    } catch (permErr) {
      // Non-fatal if organization domain policy prevents public sharing
    }

    return {
      success: true,
      id: fileData.id,
      name: fileData.name,
      mimeType: fileData.mimeType,
      icon: getMimeIcon(fileData.mimeType, fileData.name),
      size: formatBytes(fileData.size || computedSize),
      sizeBytes: fileData.size ? parseInt(fileData.size, 10) : computedSize,
      webViewLink: shareableLink,
      webContentLink: fileData.webContentLink || null,
      createdTime: fileData.createdTime || new Date().toISOString()
    };
  } catch (err) {
    throw new Error(formatDriveApiError(err, effective));
  }
}

/**
 * Create a new folder in Google Drive
 */
export async function createDriveFolder(config, { folderName, parentFolderId = null }) {
  const { drive, effective } = getDriveClient(config);

  if (!folderName || !folderName.trim()) {
    throw new Error("Folder name is required.");
  }

  try {
    let targetParent = parentFolderId !== undefined && parentFolderId !== null ? parentFolderId : effective.folderId;

    // If no parent specified, check if there is an accessible shared folder to nest inside
    if (!targetParent || targetParent === "root" || targetParent === "all") {
      try {
        const folderRes = await drive.files.list({
          q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
          pageSize: 5,
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          fields: "files(id, name)"
        });
        if (folderRes.data.files && folderRes.data.files.length > 0) {
          targetParent = folderRes.data.files[0].id;
        }
      } catch (fErr) {}
    }

    const requestBody = {
      name: folderName.trim(),
      mimeType: "application/vnd.google-apps.folder"
    };

    if (targetParent && targetParent !== "root" && targetParent !== "all") {
      requestBody.parents = [targetParent];
    }

    const res = await drive.files.create({
      requestBody,
      supportsAllDrives: true,
      fields: "id, name, mimeType, webViewLink, createdTime, parents"
    });

    const folder = res.data;

    // Make folder viewable via link
    try {
      await drive.permissions.create({
        fileId: folder.id,
        supportsAllDrives: true,
        requestBody: {
          role: "reader",
          type: "anyone"
        }
      });
    } catch {}

    return {
      success: true,
      id: folder.id,
      name: folder.name,
      isFolder: true,
      webViewLink: folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`,
      createdTime: folder.createdTime
    };
  } catch (err) {
    throw new Error(formatDriveApiError(err, effective));
  }
}

/**
 * Share or generate shareable link for a file
 */
export async function shareDriveFile(config, { fileId, role = "reader", type = "anyone", emailAddress = null }) {
  const { drive, effective } = getDriveClient(config);

  if (!fileId) throw new Error("File ID is required to share.");

  try {
    const permBody = { role, type };
    if (type === "user" && emailAddress) {
      permBody.emailAddress = emailAddress;
    }

    await drive.permissions.create({
      fileId,
      requestBody: permBody
    });

    const fileRes = await drive.files.get({
      fileId,
      fields: "id, name, mimeType, webViewLink"
    });

    return {
      success: true,
      id: fileId,
      name: fileRes.data.name,
      webViewLink: fileRes.data.webViewLink || `https://drive.google.com/file/d/${fileId}/view`,
      sharedWith: type === "user" ? emailAddress : "Anyone with the link"
    };
  } catch (err) {
    throw new Error(formatDriveApiError(err, effective));
  }
}

/**
 * Delete a file or move it to trash in Google Drive
 */
export async function deleteDriveFile(config, { fileId = null, searchName = null } = {}) {
  const { drive, effective } = getDriveClient(config);

  try {
    let targetId = fileId;
    let targetName = searchName;

    if (!targetId && searchName) {
      const searchRes = await listDriveFiles(config, { query: searchName, pageSize: 3 });
      if (!searchRes.files || searchRes.files.length === 0) {
        throw new Error(`Could not find any Google Drive file matching "${searchName}".`);
      }
      targetId = searchRes.files[0].id;
      targetName = searchRes.files[0].name;
    }

    if (!targetId) {
      throw new Error("File ID or file name is required to delete.");
    }

    // Try moving to trash first (safer than hard delete)
    try {
      await drive.files.update({
        fileId: targetId,
        requestBody: { trashed: true }
      });
    } catch {
      // Fallback to delete
      await drive.files.delete({ fileId: targetId });
    }

    return {
      success: true,
      id: targetId,
      name: targetName || targetId,
      message: `File "${targetName || targetId}" was removed from Google Drive.`
    };
  } catch (err) {
    throw new Error(formatDriveApiError(err, effective));
  }
}

// ---------------- FORMATTERS FOR WHATSAPP ----------------

/**
 * Formats a list of files for WhatsApp display
 */
export function formatDriveFilesForWhatsApp(result) {
  if (!result || !result.files || result.files.length === 0) {
    if (result?.query) {
      return `📂 *Google Drive Search*\n\nNo files found matching *"${result.query}"*.\n\n💡 _Try searching with a broader keyword or say "drive list" to view recent files._`;
    }
    return `📂 *Google Drive Files*\n\nYour Google Drive folder is currently empty.\n\n💡 _Send any photo, video, or document with caption "save to drive" to upload!_`;
  }

  const { files, query } = result;
  const header = query 
    ? `🔍 *Google Drive Search Results for "${query}"* (${files.length}):`
    : `📂 *Your Google Drive Files* (${files.length}):`;

  const lines = files.map((f, idx) => {
    const sizeStr = f.size ? ` • _${f.size}_` : "";
    const linkStr = f.webViewLink ? `\n   🔗 ${f.webViewLink}` : "";
    return `${idx + 1}. ${f.icon} *${f.name}*${sizeStr}${linkStr}`;
  });

  return `${header}\n\n${lines.join("\n\n")}\n\n💡 _Send any file with caption *"save to drive"* to upload directly!_`;
}

/**
 * Formats uploaded file confirmation for WhatsApp
 */
export function formatUploadedFileForWhatsApp(file) {
  const sizeText = file.size ? `\n• *Size:* ${file.size}` : "";
  return `☁️ *File Uploaded to Google Drive!*\n\n` +
    `• *File Name:* ${file.icon || "📄"} *${file.name}*` +
    sizeText +
    `\n• *Direct Link:* ${file.webViewLink}\n\n` +
    `👉 Tap the link above to view or share your file!`;
}

/**
 * Formats folder creation confirmation for WhatsApp
 */
export function formatFolderCreatedForWhatsApp(folder) {
  return `📁 *Google Drive Folder Created!*\n\n` +
    `• *Folder Name:* *${folder.name}*\n` +
    `• *Link:* ${folder.webViewLink}\n\n` +
    `👉 You can now save files into this folder!`;
}

export default {
  findLocalServiceAccount,
  cleanPemKey,
  formatBytes,
  getMimeIcon,
  formatDriveApiError,
  getEffectiveDriveConfig,
  getDriveClient,
  testDriveConnection,
  listDriveFiles,
  searchDriveFiles,
  uploadDriveFile,
  createDriveFolder,
  shareDriveFile,
  deleteDriveFile,
  formatDriveFilesForWhatsApp,
  formatUploadedFileForWhatsApp,
  formatFolderCreatedForWhatsApp
};
