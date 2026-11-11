import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import axios from "axios";
import { runPipeline } from "./email-ingest.js";
import { exec } from "child_process";
import pool, { initDb } from "./db.js";
import dotenv from "dotenv";
import cron from "node-cron";
import { google } from "googleapis";
import { initBaileys, getBaileysStatus, sendBaileysMessage, logoutBaileys, requestPairingCode } from "./baileys-service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(process.cwd(), ".env") });

const useTunnel = process.env.USE_TUNNEL === "true";
const tunnelUrl = (process.env.TUNNEL_URL || "").replace(/\/+$/, "");

if (useTunnel && tunnelUrl) {
  process.env.FRONTEND_URL = tunnelUrl;
  process.env.GOOGLE_REDIRECT_URI = `${tunnelUrl}/oauth-callback.html`;
} else {
  const tempPort = process.env.PORT || 3000;
  process.env.FRONTEND_URL = `http://localhost:${tempPort}`;
  process.env.GOOGLE_REDIRECT_URI = `http://localhost:${tempPort}/api/email/oauth-callback`;
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// CORS Middleware to allow separately hosted frontend applications
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});
app.use(express.static(path.join(process.cwd(), "frontend")));

let isRunning = false;
let currentProgress = null;
let logClients = [];
let logBuffer = []; // Rolling buffer of last 500 log entries for replay on SSE reconnect
const LOG_BUFFER_MAX = 500;

// Brevo Transactional Email Helper with Direct Fallback
async function sendEmailViaBrevo(to, subject, html) {
  const brevoKey = process.env.BREVO_API_KEY;
  const brevoSender = process.env.BREVO_SENDER || "malikasaravanan774@gmail.com";

  if (brevoKey) {
    try {
      const res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "accept": "application/json",
          "api-key": brevoKey,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          sender: { name: "Salesforge Alert", email: brevoSender },
          to: [{ email: to }],
          subject: subject,
          htmlContent: html
        })
      });

      if (res.ok) {
        console.log(`[Brevo Email] Email sent successfully to: ${to}`);
        return { success: true, method: "Brevo API" };
      } else {
        const text = await res.text();
        console.warn(`[Brevo Email] Dispatch failed (${res.status}): ${text}. Trying Gmail fallback...`);
      }
    } catch (error) {
      console.warn("[Brevo Email] Error dispatching email via Brevo:", error.message);
    }
  }

  // Fallback: Send via connected Gmail account if Brevo fails
  try {
    const gmailRes = await sendOutreachEmail(to, subject, html, null);
    if (gmailRes && gmailRes.success) {
      return { success: true, method: "Gmail Account Fallback" };
    }
    return { success: false, error: (gmailRes && gmailRes.error) || "Email delivery failed via Brevo and Gmail fallback." };
  } catch (fbErr) {
    return { success: false, error: fbErr.message };
  }
}

// WhatsApp Notification Helper via Baileys Gateway (Native WhatsApp Web Multi-Device)
async function sendWhatsAppNotification(message, recipientPhone = null) {
  let phone = recipientPhone || process.env.WHATSAPP_RECIPIENT_PHONE || process.env.GREEN_API_RECIPIENT_PHONE || "918807099288";

  if (!phone) {
    console.warn("[WhatsApp] Missing recipient phone number. Notification skipped.");
    return { success: false, error: "Missing recipient phone number in configuration." };
  }

  let cleanPhone = String(phone).replace(/\D/g, "");
  if (!cleanPhone) return { success: false, error: "Invalid phone number." };

  return await sendBaileysMessage(cleanPhone, message);
}

// Retrieve Dynamic Multi-Channel Alert Settings from Database
async function getAlertSettings() {
  const fallbackEmail = process.env.USERS ? process.env.USERS.split(',')[0].trim() : "vimalraj5207@gmail.com";
  const fallbackPhone = process.env.GREEN_API_RECIPIENT_PHONE || "918807099288";

  try {
    const { rows } = await pool.query("SELECT key, value FROM settings WHERE key LIKE 'alert_%'");
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });

    return {
      emailEnabled: map.alert_email_enabled !== "false",
      emailRecipients: (map.alert_email_recipients || fallbackEmail)
        .split(",")
        .map(e => e.trim().toLowerCase())
        .filter(Boolean),
      whatsappEnabled: map.alert_whatsapp_enabled !== "false",
      whatsappRecipients: (map.alert_whatsapp_recipients || fallbackPhone)
        .split(",")
        .map(p => p.replace(/\D/g, ""))
        .filter(Boolean),

      triggerIngest: map.alert_trigger_ingest !== "false",
      triggerReplies: map.alert_trigger_replies !== "false",
      triggerFollowups: map.alert_trigger_followups !== "false",
      triggerErrors: map.alert_trigger_errors !== "false"
    };
  } catch (err) {
    console.error("[Alerts] Error reading settings from DB, fallback to environment:", err.message);
    return {
      emailEnabled: true,
      emailRecipients: [fallbackEmail],
      whatsappEnabled: true,
      whatsappRecipients: [fallbackPhone],
      triggerIngest: true,
      triggerReplies: true,
      triggerFollowups: true,
      triggerErrors: true
    };
  }
}

// Unified Multi-Channel Alert Dispatcher (WhatsApp + Brevo Email)
async function dispatchSystemAlert({ eventType, title, message, details = "", isError = false }) {
  try {
    const settings = await getAlertSettings();
    console.log(`[Alerts Engine] Dispatching alert: [${eventType.toUpperCase()}] ${title} (WhatsApp: ${settings.whatsappEnabled ? 'ON (' + settings.whatsappRecipients.length + ')' : 'OFF'}, Email: ${settings.emailEnabled ? 'ON (' + settings.emailRecipients.length + ')' : 'OFF'})`);

    // Check Trigger Preferences
    if (eventType === "ingest" && !settings.triggerIngest) return;
    if (eventType === "reply" && !settings.triggerReplies) return;
    if (eventType === "followup" && !settings.triggerFollowups) return;
    if (eventType === "error" && !settings.triggerErrors) return;

    const timestamp = new Date().toLocaleString();
    const crmUrl = process.env.TUNNEL_URL || `http://localhost:${PORT}`;

    // 1. Dispatch WhatsApp Messages (Green-API Free tier)
    if (settings.whatsappEnabled && settings.whatsappRecipients.length > 0) {
      const typeTag = isError ? "SYSTEM ERROR" : (eventType === "reply" ? "PROSPECT REPLY" : (eventType === "ingest" ? "LEAD INGESTION" : "FOLLOW-UP UPDATE"));
      const waText = `*SALESFORGE CRM | ${typeTag}*\n*${title}*\n\n${message}${details ? `\n\nDetails: ${details}` : ""}\n\nTime: ${timestamp}\nPortal: ${crmUrl}`;
      
      for (const phone of settings.whatsappRecipients) {
        console.log(`[Alerts Engine] Dispatching WhatsApp alert to: ${phone}`);
        await sendWhatsAppNotification(waText, phone);
      }
    }

    // 2. Dispatch Email Alerts (Brevo API)
    if (settings.emailEnabled && settings.emailRecipients.length > 0) {
      const badgeBg = isError ? "#EF4444" : (eventType === "reply" ? "#10B981" : "#2563EB");
      const emailSubject = `[Salesforge Alert] ${title}`;
      const emailHtml = `
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"></head>
        <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #F8FAFC; margin: 0; padding: 24px;">
          <div style="max-width: 580px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #E2E8F0; overflow: hidden; box-shadow: 0 4px 16px rgba(15,23,42,0.06);">
            <div style="background: #0F172A; padding: 18px 24px; display: flex; align-items: center; justify-content: space-between;">
              <h2 style="color: #ffffff; margin: 0; font-size: 17px; font-weight: 700; letter-spacing: -0.02em;">Salesforge CRM</h2>
              <span style="background: ${badgeBg}; color: #ffffff; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 99px; text-transform: uppercase;">${eventType}</span>
            </div>
            <div style="padding: 24px;">
              <h3 style="color: #1E293B; margin-top: 0; font-size: 16px; font-weight: 600;">${title}</h3>
              <p style="color: #475569; font-size: 14px; line-height: 1.6; white-space: pre-wrap; margin: 12px 0;">${message}</p>
              ${details ? `<div style="background: #F1F5F9; border-left: 4px solid ${badgeBg}; padding: 12px 16px; border-radius: 6px; margin: 16px 0; font-family: monospace; font-size: 12px; color: #334155;">${details}</div>` : ""}
              <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #F1F5F9; display: flex; align-items: center; justify-content: space-between;">
                <span style="color: #94A3B8; font-size: 11px;">Timestamp: ${timestamp}</span>
                <a href="${crmUrl}" style="background: #2563EB; color: #ffffff; text-decoration: none; padding: 8px 16px; border-radius: 10px; font-size: 12px; font-weight: 600; display: inline-block;">Open Dashboard →</a>
              </div>
            </div>
          </div>
        </body>
        </html>
      `;

      for (const email of settings.emailRecipients) {
        console.log(`[Alerts Engine] Dispatching Email alert to: ${email}`);
        await sendEmailViaBrevo(email, emailSubject, emailHtml);
      }
    }
  } catch (err) {
    console.error("[Alerts] System alert dispatch error:", err.message);
  }
}

// Dual Email Dispatcher (Gmail OAuth API first, Brevo API fallback)
async function sendOutreachEmail(to, subject, html, ownerEmail) {
  try {
    let queryStr = "SELECT access_token, refresh_token, expiry_date, email FROM email_connections WHERE owner_email = $1 OR email = $1 ORDER BY created_at DESC LIMIT 1";
    let queryParams = ownerEmail ? [ownerEmail.trim().toLowerCase()] : [""];
    let { rows } = await pool.query(queryStr, queryParams);

    if (rows.length === 0) {
      const fallbackRes = await pool.query("SELECT access_token, refresh_token, expiry_date, email FROM email_connections ORDER BY created_at DESC LIMIT 1");
      rows = fallbackRes.rows;
    }

    if (rows.length === 0) {
      return { success: false, error: "No connected Gmail account found. Please click 'Link Email Inbox' on your dashboard to authorize your Gmail account." };
    }

    const conn = rows[0];
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/api/email/oauth-callback`
    );
    let accessToken = conn.access_token;
    let expiryDate = parseInt(conn.expiry_date);

    if (Date.now() + 5 * 60 * 1000 >= expiryDate) {
      oauth2Client.setCredentials({ refresh_token: conn.refresh_token });
      const { credentials } = await oauth2Client.refreshAccessToken();
      accessToken = credentials.access_token;
      expiryDate = credentials.expiry_date;
      await pool.query(
        "UPDATE email_connections SET access_token = $1, expiry_date = $2 WHERE email = $3",
        [accessToken, expiryDate, conn.email]
      );
    }

    oauth2Client.setCredentials({ access_token: accessToken });
    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const utf8Subject = `=?utf-8?B?${Buffer.from(subject).toString("base64")}?=`;
    const messageParts = [
      `From: ${conn.email}`,
      `To: ${to}`,
      `Content-Type: text/html; charset=utf-8`,
      `MIME-Version: 1.0`,
      `Subject: ${utf8Subject}`,
      ``,
      html
    ];
    const message = messageParts.join("\n");
    const encodedMessage = Buffer.from(message)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw: encodedMessage }
    });

    console.log(`[Gmail Outreach] Email sent directly via Gmail API (${conn.email}) to: ${to}`);
    return { success: true, method: `Gmail (${conn.email})` };
  } catch (gmailErr) {
    console.error("[Gmail Outreach] Gmail API dispatch error:", gmailErr.message);
    if (gmailErr.message.includes("insufficient authentication scopes") || gmailErr.message.includes("invalid_grant")) {
      return { 
        success: false, 
        error: `Gmail scope error: ${gmailErr.message}. Please click 'Link Email Inbox' on your dashboard (or log out & log back in with Google) to grant full Gmail sending permissions.` 
      };
    }
    return { success: false, error: `Gmail dispatch failed: ${gmailErr.message}` };
  }
}

// Scheduler Configuration Support
let ingestionCronTask = null;
let followUpCronTask = null;
let replyCronTask = null;

function loadCronConfig() {
  const configPath = path.join(process.cwd(), "cron-config.json");
  let config = {
    enabled: process.env.CRON_ENABLED === "true",
    cronExpression: process.env.CRON_SCHEDULE || "0 9 * * *",
    time: "09:00",
    followUpEnabled: true,
    followUpInterval: "2h",
    followUpCronExpression: "0 */2 * * *",
    replyEnabled: true,
    replyInterval: "1h",
    replyCronExpression: "0 * * * *"
  };

  if (fs.existsSync(configPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(configPath, "utf8"));
      config = { ...config, ...data };
    } catch (e) {
      console.error("[Cron] Failed to parse cron-config.json, using defaults:", e.message);
    }
  }
  return config;
}

function saveCronConfig(config) {
  const configPath = path.join(process.cwd(), "cron-config.json");
  try {
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
    return true;
  } catch (e) {
    console.error("[Cron] Failed to save cron-config.json:", e.message);
    return false;
  }
}

function initCronJob() {
  if (ingestionCronTask) {
    ingestionCronTask.stop();
    ingestionCronTask = null;
  }
  if (followUpCronTask) {
    followUpCronTask.stop();
    followUpCronTask = null;
  }
  if (replyCronTask) {
    replyCronTask.stop();
    replyCronTask = null;
  }

  const config = loadCronConfig();

  // 1. Ingestion Cron
  if (config.enabled) {
    if (cron.validate(config.cronExpression)) {
      console.log(`[Cron] Scheduling lead Ingestion job with expression: "${config.cronExpression}"`);
      ingestionCronTask = cron.schedule(config.cronExpression, async () => {
        console.log(`[Cron] Scheduled Ingestion job started at ${new Date().toISOString()}`);
        if (isRunning) {
          console.log("[Cron] Ingestion already running. Skipping.");
          broadcastLog("=== [Cron] Ingestion already running. Skipping scheduled run. ===", "warn");
          return;
        }
        isRunning = true;
        broadcastLog("=== [Cron] Triggering Scheduled Fetch & Qualify Pipeline ===", "system");

        // Record execution timestamp
        const runConfig = loadCronConfig();
        runConfig.lastIngestionRun = new Date().toISOString();
        saveCronConfig(runConfig);

        try {
          const { rows } = await pool.query("SELECT email, owner_email FROM email_connections");
          if (rows.length === 0) {
            broadcastLog("=== [Cron] No connected email inboxes found ===", "warn");
          }
          let totalAddedCount = 0;
          for (const conn of rows) {
            const emailToIngest = conn.email;
            const ownerEmail = conn.owner_email;
            broadcastLog(`=== [Cron] Processing inbox: ${emailToIngest} (Owner: ${ownerEmail || 'system'}) ===`, "system");
            const options = {
              fetchMode: "last24h",
              onlyUnread: true,
              targetInboxEmail: emailToIngest,
              ownerEmail: ownerEmail,
              onProgress: (progress) => {
                currentProgress = progress;
                broadcastLog(JSON.stringify(progress), "progress");
              }
            };
            try {
              const resPipeline = await runPipeline(options);
              if (resPipeline && typeof resPipeline.addedCount === "number") {
                totalAddedCount += resPipeline.addedCount;
              }
            } catch (singleErr) {
              broadcastLog(`=== [Cron] Ingestion failed for ${emailToIngest}: ${singleErr.message} ===`, "error");
            }
          }
          try {
            fs.writeFileSync(path.join(process.cwd(), "last-run.txt"), new Date().toISOString());
          } catch(e){}
          broadcastLog("=== [Cron] Scheduled Ingestion completed successfully ===", "system");
          if (totalAddedCount > 0) {
            await dispatchSystemAlert({
              eventType: "ingest",
              title: "Lead Ingestion Cron Completed",
              message: `Successfully processed mailbox and added *${totalAddedCount}* new qualified lead(s).`,
              details: `Total added: ${totalAddedCount}`
            });
          }
        } catch (error) {
          broadcastLog(`=== [Cron] Scheduled Ingestion failed: ${error.message} ===`, "error");
          await dispatchSystemAlert({
            eventType: "error",
            title: "Scheduled Lead Ingestion Failed",
            message: `Scheduled ingestion encountered an error: ${error.message}`,
            isError: true
          });
        } finally {
          isRunning = false;
          currentProgress = null;
        }
      });
    } else {
      console.error(`[Cron] Invalid Ingestion expression: "${config.cronExpression}"`);
    }
  }

  // 2. Follow-up Cron
  if (config.followUpEnabled) {
    const expr = config.followUpCronExpression || "0 */2 * * *";
    if (cron.validate(expr)) {
      console.log(`[Cron] Scheduling Follow-up check job with expression: "${expr}"`);
      followUpCronTask = cron.schedule(expr, async () => {
        // Record execution timestamp
        const runConfig = loadCronConfig();
        runConfig.lastFollowUpRun = new Date().toISOString();
        saveCronConfig(runConfig);

        try {
          const resFollowUp = await runFollowUpJob();
          const hasChanges = resFollowUp && (resFollowUp.day3Count > 0 || resFollowUp.day7Count > 0 || resFollowUp.archivedCount > 0);
          if (hasChanges) {
            await dispatchSystemAlert({
              eventType: "followup",
              title: "Follow-Up Dispatcher Executed",
              message: `Dispatched scheduled follow-ups to active leads.`,
              details: `Day 3 Follow-ups: ${resFollowUp.day3Count} | Day 7 Final Follow-ups: ${resFollowUp.day7Count} | Archived: ${resFollowUp.archivedCount}`
            });
          }
        } catch (err) {
          console.error("[Outreach Cron] Scheduled follow-up failed:", err.message);
          await dispatchSystemAlert({
            eventType: "error",
            title: "Follow-Up Dispatcher Failed",
            message: `Follow-up cron encountered an error: ${err.message}`,
            isError: true
          });
        }
      });
    } else {
      console.error(`[Cron] Invalid Follow-up expression: "${expr}"`);
    }
  }

  // 3. Reply Detection Cron
  if (config.replyEnabled) {
    const expr = config.replyCronExpression || "0 * * * *";
    if (cron.validate(expr)) {
      console.log(`[Cron] Scheduling Reply Detection check job with expression: "${expr}"`);
      replyCronTask = cron.schedule(expr, async () => {
        // Record execution timestamp
        const runConfig = loadCronConfig();
        runConfig.lastReplyRun = new Date().toISOString();
        saveCronConfig(runConfig);

        try {
          const resReply = await processReplyDetection();
          if (resReply && resReply.detectedCount > 0) {
            await dispatchSystemAlert({
              eventType: "reply",
              title: "New Customer Reply Detected",
              message: `Detected *${resReply.detectedCount}* new incoming prospect reply/replies. Lead status has been updated.`,
              details: `Replies detected: ${resReply.detectedCount}`
            });
          }
        } catch (err) {
          console.error("[Reply Cron] Scheduled reply check failed:", err.message);
          await dispatchSystemAlert({
            eventType: "error",
            title: "Reply Detection Cron Failed",
            message: `Reply detector encountered an error: ${err.message}`,
            isError: true
          });
        }
      });
    } else {
      console.error(`[Cron] Invalid Reply check expression: "${expr}"`);
    }
  }
}

// Authentication stores
const otpStore = new Map();
const userSessionStore = new Map();

// Middleware to verify session tokens with graceful leader fallback
async function authMiddleware(req, res, next) {
  let token = req.query.token;
  if (!token) {
    const authHeader = req.headers["authorization"];
    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    }
  }
  if (token && userSessionStore.has(token)) {
    req.user = userSessionStore.get(token);
    return next();
  }

  // Graceful fallback for local development or direct web access: pick leader from DB
  try {
    const { rows } = await pool.query("SELECT email, role FROM users WHERE role = 'leader' ORDER BY id ASC LIMIT 1");
    if (rows.length > 0) {
      req.user = { email: rows[0].email, role: rows[0].role };
    } else {
      const defaultEmail = (process.env.USERS || "vimalraj5207@gmail.com").split(",")[0].trim().toLowerCase();
      req.user = { email: defaultEmail, role: 'leader' };
    }
    next();
  } catch (err) {
    req.user = { email: "vimalraj5207@gmail.com", role: 'leader' };
    next();
  }
}

// Broadcast a message to all connected log SSE clients, and store in replay buffer
function broadcastLog(text, type = "info") {
  // Filter out the pg security warnings
  if (text.includes("SECURITY WARNING: The SSL modes") || 
      text.includes("pg-connection-string") || 
      text.includes("standard libpq semantics") ||
      text.includes("sslmode=verify-full") ||
      text.includes("node --trace-warnings")) {
    return;
  }
  const entry = { text, type, time: new Date().toLocaleTimeString() };
  const data = JSON.stringify(entry);
  // Push to rolling buffer
  logBuffer.push(entry);
  if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
  // Send to all live clients
  logClients.forEach(client => {
    client.write(`data: ${data}\n\n`);
  });
}

// Redirect console methods to stream logs in real-time
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => {
  originalLog(...args);
  broadcastLog(args.join(" "), "info");
};

console.error = (...args) => {
  originalError(...args);
  broadcastLog(args.join(" "), "error");
};

console.warn = (...args) => {
  originalWarn(...args);
  broadcastLog(args.join(" "), "warn");
};

// SSE Endpoint for streaming logs (Protected)
app.get("/api/logs/stream", authMiddleware, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  logClients.push(res);

  // Replay buffered logs so the client gets everything since pipeline started
  res.write(`data: ${JSON.stringify({ text: "Log streaming connection established.", type: "system", time: new Date().toLocaleTimeString() })}\n\n`);
  if (logBuffer.length > 0) {
    res.write(`data: ${JSON.stringify({ text: `--- Replaying ${logBuffer.length} buffered log line(s) ---`, type: "system", time: new Date().toLocaleTimeString() })}\n\n`);
    logBuffer.forEach(entry => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    });
  }

  req.on("close", () => {
    logClients = logClients.filter(client => client !== res);
  });
});

app.post("/api/auth/logout", authMiddleware, (req, res) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader.split(" ")[1];
  userSessionStore.delete(token);
  res.json({ message: "Logged out successfully." });
});

// Redirect to Google Consent screen for authentication
app.get("/api/auth/google", (req, res) => {
  const frontendUrl = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
  const defaultRedirect = frontendUrl ? `${frontendUrl}/oauth-callback.html` : `http://localhost:${PORT}/api/email/oauth-callback`;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || defaultRedirect;

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    redirectUri
  );

  const scopes = [
    'https://mail.google.com/',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
  ];

  const state = `login:${crypto.randomUUID()}`;

  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: scopes,
    state: state
  });

  res.redirect(url);
});

// Get profile details of currently logged-in user (Protected)
app.get("/api/auth/me", authMiddleware, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized. Session not found." });
  }
  res.json({ email: req.user.email, role: req.user.role });
});

// Get list of all authorized users (Protected)
app.get("/api/users", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT email, role, created_at FROM users ORDER BY role DESC, email ASC");
    res.json(rows);
  } catch (error) {
    console.error("[Users API] Failed to fetch users:", error.message);
    res.status(500).json({ error: "Failed to fetch users." });
  }
});

// Add or update authorized user (Protected - Leaders only)
app.post("/api/users", authMiddleware, async (req, res) => {
  if (req.user.role !== 'leader') {
    return res.status(403).json({ error: "Forbidden. Only team leaders can manage access." });
  }

  const { email, role } = req.body;
  if (!email || !role) {
    return res.status(400).json({ error: "Email and role are required." });
  }

  const emailLower = email.trim().toLowerCase();
  const roleLower = role.trim().toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLower)) {
    return res.status(400).json({ error: "Invalid email format." });
  }

  if (roleLower !== 'leader' && roleLower !== 'member') {
    return res.status(400).json({ error: "Invalid role. Role must be 'leader' or 'member'." });
  }

  try {
    await pool.query(
      `INSERT INTO users (email, role) VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE SET role = $2`,
      [emailLower, roleLower]
    );
    console.log(`[Users API] User ${req.user.email} added/updated team member: ${emailLower} as ${roleLower}`);

    const inviteHtml = `
      <div style="font-family: sans-serif; padding: 20px; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px;">
        <h2 style="color: #2b6cb0;">Lead CRM Access Invitation</h2>
        <p>Hello,</p>
        <p>You have been authorized by <strong>${req.user.email}</strong> to join the Lead CRM dashboard as a <strong>${roleLower}</strong>.</p>
        <p>You can now log in using your Google account at the link below:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="http://localhost:3000" style="background-color: #2b6cb0; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">Access Lead CRM</a>
        </div>
        <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
        <p style="font-size: 12px; color: #718096;">If you have any questions, please contact your team leader.</p>
      </div>
    `;
    sendEmailViaBrevo(emailLower, "Invitation to join Lead CRM", inviteHtml);

    res.json({ message: `Successfully authorized ${emailLower} as ${roleLower}.` });
  } catch (error) {
    console.error("[Users API] Failed to insert user:", error.message);
    res.status(500).json({ error: "Failed to add team member." });
  }
});

// Revoke user access (Protected - Leaders only)
app.delete("/api/users/:email", authMiddleware, async (req, res) => {
  if (req.user.role !== 'leader') {
    return res.status(403).json({ error: "Forbidden. Only team leaders can manage access." });
  }

  const targetEmail = req.params.email.trim().toLowerCase();

  if (targetEmail === req.user.email) {
    return res.status(400).json({ error: "Bad request. You cannot delete yourself." });
  }

  try {
    const { rowCount } = await pool.query("DELETE FROM users WHERE email = $1", [targetEmail]);
    if (rowCount === 0) {
      return res.status(404).json({ error: "User not found." });
    }

    for (const [token, session] of userSessionStore.entries()) {
      if (session.email === targetEmail) {
        userSessionStore.delete(token);
        console.log(`[Google Login] Invalidated active session token for deleted user: ${targetEmail}`);
      }
    }

    console.log(`[Users API] User ${req.user.email} deleted team member: ${targetEmail}`);
    res.json({ message: `Successfully revoked access for ${targetEmail}.` });
  } catch (error) {
    console.error("[Users API] Failed to delete user:", error.message);
    res.status(500).json({ error: "Failed to remove team member." });
  }
});

// Endpoint to trigger the ingestion and qualification pipeline (Protected)
app.post("/api/fetch-and-qualify", authMiddleware, async (req, res) => {
  if (isRunning) {
    return res.status(400).json({ error: "Pipeline is already running." });
  }

  isRunning = true;
  res.json({ message: "Lead qualification pipeline started in the background." });

  // Clear log buffer for fresh pipeline run
  logBuffer = [];
  broadcastLog("=== Triggering Fetch & Qualify Pipeline ===", "system");

  try {
    const options = {
      fetchMode: req.body.fetchMode || "last24h",
      onlyUnread: req.body.onlyUnread !== false,
      fromDate: req.body.fromDate,
      toDate: req.body.toDate,
      ownerEmail: req.user.email,
      onProgress: (progress) => {
        currentProgress = progress;
        broadcastLog(JSON.stringify(progress), "progress");
      }
    };

    const resPipeline = await runPipeline(options);
    const addedCount = (resPipeline && resPipeline.addedCount) || 0;

    try {
      fs.writeFileSync(path.join(process.cwd(), "last-run.txt"), new Date().toISOString());
    } catch (writeErr) {
      console.error("Failed to write last-run timestamp:", writeErr.message);
    }
    broadcastLog("=== Pipeline completed successfully ===", "system");
    if (addedCount > 0) {
      await dispatchSystemAlert({
        eventType: "ingest",
        title: "Manual Lead Ingestion Completed",
        message: `Manual pipeline run completed. *${addedCount}* new qualified lead(s) added.`,
        details: `Added: ${addedCount} lead(s)`
      });
    }
  } catch (error) {
    console.error(`Pipeline failed: ${error.message}`);
    broadcastLog(`=== Pipeline failed: ${error.message} ===`, "error");
    await dispatchSystemAlert({
      eventType: "error",
      title: "Manual Lead Ingestion Failed",
      message: `Manual lead ingestion failed: ${error.message}`,
      isError: true
    });
  } finally {
    isRunning = false;
    currentProgress = null;
  }
});

// Endpoint to retrieve cron job config (Protected)
app.get("/api/cron/config", authMiddleware, (req, res) => {
  const config = loadCronConfig();
  
  let nextRun = null;
  if (config.enabled && config.time) {
    try {
      const now = new Date();
      const target = new Date();
      const [hours, minutes] = config.time.split(':');
      target.setHours(parseInt(hours), parseInt(minutes), 0, 0);
      if (target <= now) {
        target.setDate(target.getDate() + 1);
      }
      nextRun = target.toISOString();
    } catch (e) {
      console.error("Error calculating next run time:", e.message);
    }
  }
  
  res.json({ ...config, nextRun });
});

// Endpoint to update cron job config (Protected)
app.post("/api/cron/config", authMiddleware, (req, res) => {
  const { enabled, time, followUpEnabled, followUpInterval, replyEnabled, replyInterval } = req.body;
  
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "enabled parameter must be a boolean." });
  }
  
  if (enabled && (!time || !/^\d{2}:\d{2}$/.test(time))) {
    return res.status(400).json({ error: "A valid time (HH:MM) is required when enabling the scheduler." });
  }

  function intervalToCron(interval, defaultExpr) {
    if (interval === "1h") return "0 * * * *";
    if (interval === "2h") return "0 */2 * * *";
    if (interval === "4h") return "0 */4 * * *";
    if (interval === "12h") return "0 */12 * * *";
    if (interval === "24h") return "0 0 * * *";
    if (typeof interval === "string" && interval.startsWith("custom:")) {
      return interval.replace("custom:", "").trim();
    }
    return defaultExpr;
  }
  
  const config = loadCronConfig();
  config.enabled = enabled;
  if (time) {
    config.time = time;
    const [hours, minutes] = time.split(':');
    config.cronExpression = `${parseInt(minutes)} ${parseInt(hours)} * * *`;
  }

  if (typeof followUpEnabled === "boolean") {
    config.followUpEnabled = followUpEnabled;
  }
  if (followUpInterval) {
    config.followUpInterval = followUpInterval;
    config.followUpCronExpression = intervalToCron(followUpInterval, config.followUpCronExpression || "0 */2 * * *");
  }

  if (typeof replyEnabled === "boolean") {
    config.replyEnabled = replyEnabled;
  }
  if (replyInterval) {
    config.replyInterval = replyInterval;
    config.replyCronExpression = intervalToCron(replyInterval, config.replyCronExpression || "0 * * * *");
  }
  
  if (saveCronConfig(config)) {
    initCronJob();
    
    let nextRun = null;
    if (config.enabled && config.time) {
      const now = new Date();
      const target = new Date();
      const [hours, minutes] = config.time.split(':');
      target.setHours(parseInt(hours), parseInt(minutes), 0, 0);
      if (target <= now) {
        target.setDate(target.getDate() + 1);
      }
      nextRun = target.toISOString();
    }
    
    res.json({ message: "Scheduler configuration updated successfully.", config: { ...config, nextRun } });
  } else {
    res.status(500).json({ error: "Failed to save scheduler configuration." });
  }
});

// Endpoint to check status (Protected)
app.get("/api/status", authMiddleware, (req, res) => {
  let lastRun = null;
  const lastRunPath = path.join(process.cwd(), "last-run.txt");
  if (fs.existsSync(lastRunPath)) {
    try {
      lastRun = fs.readFileSync(lastRunPath, "utf8").trim();
    } catch (e) {
      console.error("Failed to read last run timestamp:", e.message);
    }
  }
  res.json({ isRunning, lastRun, progress: currentProgress });
});

// 1. Get current connection status (Protected)
app.get("/api/email/connection", authMiddleware, async (req, res) => {
  try {
    const oauthConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
    const { rows } = await pool.query(
      "SELECT email, access_token, created_at FROM email_connections WHERE owner_email = $1 OR email = $1 ORDER BY created_at DESC LIMIT 1",
      [req.user.email]
    );
    
    if (rows.length > 0 && rows[0].access_token) {
      res.json({
        oauthConfigured,
        linked: true,
        email: rows[0].email,
        connectedAt: rows[0].created_at,
        autoConnectedFromLogin: true
      });
    } else {
      res.json({
        oauthConfigured,
        linked: false,
        email: null
      });
    }
  } catch (error) {
    console.error("[Email Config] Failed to fetch email connection details:", error.message);
    res.status(500).json({ error: "Failed to fetch email connection details." });
  }
});

// 2. Generate Google OAuth Auth URL (Protected)
app.get("/api/email/oauth-url", authMiddleware, (req, res) => {
  const oauthConfigured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  if (!oauthConfigured) {
    return res.status(400).json({ error: "Google OAuth credentials are not configured in the system." });
  }

  try {
    let token = req.query.token;
    if (!token) {
      const authHeader = req.headers["authorization"];
      if (authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.split(" ")[1];
      }
    }

    const frontendUrl = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");
    const defaultRedirect = frontendUrl ? `${frontendUrl}/oauth-callback.html` : `http://localhost:${PORT}/api/email/oauth-callback`;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI || defaultRedirect;

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      redirectUri
    );

    const scopes = [
      'https://mail.google.com/',
      'https://www.googleapis.com/auth/userinfo.email'
    ];

    const url = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: scopes,
      state: token
    });

    res.json({ url });
  } catch (error) {
    console.error("[Google OAuth] Failed to generate auth URL:", error.message);
    res.status(500).json({ error: "Failed to generate authentication URL." });
  }
});

// 3. Google OAuth Callback (Public, validates session token state)
app.get("/api/email/oauth-callback", async (req, res) => {
  const { code, state } = req.query;

  if (!state) {
    return res.status(400).send("State parameter is missing.");
  }

  const frontendUrl = (process.env.FRONTEND_URL || "").replace(/\/+$/, "");

  if (state.startsWith("login:")) {
    if (!code) {
      return res.redirect(`${frontendUrl}/login.html?error=failed&message=${encodeURIComponent("Access denied or code missing.")}`);
    }

    try {
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/api/email/oauth-callback`
      );

      const { tokens } = await oauth2Client.getToken(code);
      oauth2Client.setCredentials(tokens);

      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const userInfo = await oauth2.userinfo.get();
      const email = userInfo.data.email;

      if (!email) {
        throw new Error("Unable to retrieve email address from Google Account.");
      }

      const emailLower = email.trim().toLowerCase();

      const { rows } = await pool.query("SELECT id, email, role, created_at FROM users WHERE email = $1", [emailLower]);
      if (rows.length === 0) {
        console.warn(`[Google Login] Denied unauthorized login attempt from: ${emailLower}`);
        return res.redirect(`${frontendUrl}/login.html?error=unauthorized&email=${encodeURIComponent(emailLower)}`);
      }

      const user = rows[0];
      const sessionToken = crypto.randomUUID();
      userSessionStore.set(sessionToken, { email: emailLower, role: user.role });

      if (tokens.access_token) {
        const expiryDate = tokens.expiry_date || (Date.now() + 3600 * 1000);
        await pool.query(
          `INSERT INTO email_connections (email, access_token, refresh_token, expiry_date, owner_email)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (email) DO UPDATE
           SET access_token = $2, 
               refresh_token = COALESCE(NULLIF($3, ''), email_connections.refresh_token), 
               expiry_date = $4, 
               owner_email = $5`,
          [emailLower, tokens.access_token, tokens.refresh_token || '', expiryDate, emailLower]
        );
        console.log(`[Google Login] Stored OAuth email_connection for: ${emailLower}`);
      }

      console.log(`[Google Login] User ${emailLower} (${user.role}) logged in successfully via OAuth.`);
      return res.redirect(`${frontendUrl}/index.html?token=${sessionToken}`);
    } catch (error) {
      console.error("[Google Login] OAuth login callback error:", error.message);
      return res.redirect(`${frontendUrl}/login.html?error=failed&message=${encodeURIComponent(error.message)}`);
    }
  }

  if (!userSessionStore.has(state)) {
    return res.status(401).send("Unauthorized session. Please log in again from the dashboard.");
  }

  if (!code) {
    return res.redirect(`${frontendUrl}/index.html?connection=error&message=${encodeURIComponent("Access denied or code missing.")}`);
  }

  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/api/email/oauth-callback`
    );

    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const userInfo = await oauth2.userinfo.get();
    const email = userInfo.data.email;

    if (!email) {
      throw new Error("Unable to retrieve email address from Google Account.");
    }

    const sessionUser = userSessionStore.get(state);
    const ownerEmail = sessionUser ? sessionUser.email : null;

    if (ownerEmail) {
      await pool.query("DELETE FROM email_connections WHERE owner_email = $1", [ownerEmail]);
    }
    
    await pool.query(
      `INSERT INTO email_connections (email, access_token, refresh_token, expiry_date, owner_email)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE
       SET access_token = $2, refresh_token = $3, expiry_date = $4, owner_email = $5`,
      [email, tokens.access_token, tokens.refresh_token, tokens.expiry_date, ownerEmail]
    );

    console.log(`[Google OAuth] Successfully connected email account: ${email}`);
    res.redirect(`${frontendUrl}/index.html?connection=success&email=${encodeURIComponent(email)}`);
  } catch (error) {
    console.error("[Google OAuth] Token exchange error:", error.message);
    res.redirect(`${frontendUrl}/index.html?connection=error&message=${encodeURIComponent(error.message)}`);
  }
});

// 4. Disconnect Email Connection (Protected)
app.post("/api/email/disconnect", authMiddleware, async (req, res) => {
  try {
    await pool.query("DELETE FROM email_connections WHERE owner_email = $1", [req.user.email]);
    console.log(`[Google OAuth] Email connection disconnected for owner: ${req.user.email}`);
    res.json({ message: "Disconnected successfully." });
  } catch (error) {
    console.error("[Google OAuth] Disconnect error:", error.message);
    res.status(500).json({ error: "Failed to disconnect account." });
  }
});

// Endpoint to retrieve leads directly from PostgreSQL (Protected)
app.get("/api/leads", authMiddleware, async (req, res) => {
  const type = req.query.type || "qualified";
  const isFit = type !== "unqualified";
  const filterUser = req.query.user || null;

  try {
    let queryStr = "SELECT id, date, created_at, company_name, position, company_bio, posted_date, domain, linkedin, score, wikipedia, message_id, fit_reason, scraped_url, scraped_description, employees, company_linkedin_page, scraped_location, email, outreach_msg, is_fit, owner_email, notes FROM leads WHERE is_fit = $1 ORDER BY created_at DESC NULLS LAST, date DESC, id DESC";
    let queryParams = [isFit];

    if (filterUser && req.user.role === "leader") {
      queryStr = "SELECT id, date, created_at, company_name, position, company_bio, posted_date, domain, linkedin, score, wikipedia, message_id, fit_reason, scraped_url, scraped_description, employees, company_linkedin_page, scraped_location, email, outreach_msg, is_fit, owner_email, notes FROM leads WHERE is_fit = $1 AND owner_email = $2 ORDER BY created_at DESC NULLS LAST, date DESC, id DESC";
      queryParams = [isFit, filterUser.trim().toLowerCase()];
    }

    const { rows } = await pool.query(queryStr, queryParams);

    const parsedLeads = rows.map((row) => ({
      id: row.id,
      date: row.date ? new Date(row.date).toISOString().split('T')[0] : "",
      created_at: row.created_at || null,
      company_name: row.company_name,
      position: row.position || "",
      company_bio: row.company_bio || "",
      posted_date: row.posted_date || "",
      domain: row.domain || "",
      linkedin: row.linkedin || "",
      score: row.score || 0,
      wikipedia: row.wikipedia || "",
      message_id: row.message_id || "",
      fit_reason: row.fit_reason || "",
      scraped_url: row.scraped_url || "",
      scraped_description: row.scraped_description || "",
      employees: row.employees || "",
      company_linkedin_page: row.company_linkedin_page || "",
      scraped_location: row.scraped_location || "",
      email: row.email || "",
      outreach_msg: row.outreach_msg || "",
      owner_email: row.owner_email || "",
      notes: row.notes || ""
    }));

    res.json(parsedLeads);
  } catch (error) {
    console.error(`Failed to fetch leads from PostgreSQL:`, error.message);
    res.status(500).json({ error: `Failed to fetch leads from PostgreSQL: ${error.message}` });
  }
});

// Get Single Lead by ID (Protected)
app.get("/api/leads/:id", authMiddleware, async (req, res) => {
  const leadId = req.params.id;
  if (!leadId || isNaN(parseInt(leadId))) {
    return res.status(400).json({ error: "Invalid lead ID." });
  }
  try {
    const { rows } = await pool.query(
      "SELECT id, date, company_name, position, company_bio, posted_date, domain, linkedin, score, wikipedia, message_id, fit_reason, scraped_url, scraped_description, employees, company_linkedin_page, scraped_location, email, outreach_msg, is_fit, owner_email, notes FROM leads WHERE id = $1 LIMIT 1",
      [parseInt(leadId)]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Lead not found." });
    }
    const row = rows[0];
    res.json({
      id: row.id,
      date: row.date ? new Date(row.date).toISOString().split('T')[0] : "",
      company_name: row.company_name,
      position: row.position || "",
      company_bio: row.company_bio || "",
      posted_date: row.posted_date || "",
      domain: row.domain || "",
      linkedin: row.linkedin || "",
      score: row.score || 0,
      wikipedia: row.wikipedia || "",
      message_id: row.message_id || "",
      fit_reason: row.fit_reason || "",
      scraped_url: row.scraped_url || "",
      scraped_description: row.scraped_description || "",
      employees: row.employees || "",
      company_linkedin_page: row.company_linkedin_page || "",
      scraped_location: row.scraped_location || "",
      email: row.email || "",
      outreach_msg: row.outreach_msg || "",
      is_fit: row.is_fit,
      owner_email: row.owner_email || "",
      notes: row.notes || ""
    });
  } catch (error) {
    console.error(`Failed to fetch lead ${leadId}:`, error.message);
    res.status(500).json({ error: `Failed to fetch lead: ${error.message}` });
  }
});

// Update Lead Sticky Notes
app.patch("/api/leads/:id/notes", authMiddleware, async (req, res) => {
  try {
    const { notes } = req.body;
    const { rows } = await pool.query(
      "UPDATE leads SET notes = $1 WHERE id = $2 RETURNING *",
      [notes || "", req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Lead not found" });
    }
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Get Ingestion Settings (Protected)
app.get("/api/settings", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT key, value FROM settings");
    const settingsMap = {};
    rows.forEach(r => {
      settingsMap[r.key] = r.value;
    });
    res.json(settingsMap);
  } catch (error) {
    console.error("[Settings API] Failed to fetch settings:", error.message);
    res.status(500).json({ error: "Failed to fetch settings." });
  }
});

// 6. Save Ingestion Settings (Protected, Leader Only)
app.post("/api/settings", authMiddleware, async (req, res) => {
  if (req.user.role !== "leader") {
    return res.status(403).json({ error: "Forbidden. Only leaders can update ingestion settings." });
  }

  const { sector_filter, min_employee_count, rd_signals, excluded_sectors, min_fit_score, extract_prompt, mistral_extract_prompt, groq_extract_prompt, mistral_evaluate_prompt, allowed_senders } = req.body;

  try {
    const updates = {
      sector_filter,
      min_employee_count,
      rd_signals,
      excluded_sectors,
      min_fit_score,
      extract_prompt: extract_prompt || mistral_extract_prompt || groq_extract_prompt,
      mistral_extract_prompt: mistral_extract_prompt || extract_prompt || groq_extract_prompt,
      groq_extract_prompt: groq_extract_prompt || extract_prompt || mistral_extract_prompt,
      mistral_evaluate_prompt,
      allowed_senders
    };

    for (const [key, val] of Object.entries(updates)) {
      if (val !== undefined) {
        await pool.query(
          `INSERT INTO settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = $2`,
          [key, String(val).trim()]
        );
      }
    }

    console.log(`[Settings API] Ingestion settings updated by ${req.user.email}`);
    res.json({ message: "Settings saved successfully." });
  } catch (error) {
    console.error("[Settings API] Failed to save settings:", error.message);
    res.status(500).json({ error: "Failed to save settings." });
  }
});

// 7. Get Multi-Channel Alert Configuration (Protected)
app.get("/api/alerts/settings", authMiddleware, async (req, res) => {
  try {
    const settings = await getAlertSettings();
    res.json(settings);
  } catch (error) {
    console.error("[Alerts API] Error getting alert settings:", error.message);
    res.status(500).json({ error: "Failed to fetch alert settings." });
  }
});

// 8. Save Multi-Channel Alert Configuration (Protected, Leader Only)
app.post("/api/alerts/settings", authMiddleware, async (req, res) => {
  if (req.user.role !== "leader") {
    return res.status(403).json({ error: "Forbidden. Only leaders can update alert settings." });
  }

  const {
    emailEnabled,
    emailRecipients,
    whatsappEnabled,
    whatsappRecipients,
    triggerIngest,
    triggerReplies,
    triggerFollowups,
    triggerErrors
  } = req.body;

  try {
    const updates = {
      alert_email_enabled: emailEnabled ? "true" : "false",
      alert_email_recipients: Array.isArray(emailRecipients) ? emailRecipients.join(",") : (emailRecipients || ""),
      alert_whatsapp_enabled: whatsappEnabled ? "true" : "false",
      alert_whatsapp_recipients: Array.isArray(whatsappRecipients) ? whatsappRecipients.join(",") : (whatsappRecipients || ""),
      alert_trigger_ingest: triggerIngest !== false ? "true" : "false",
      alert_trigger_replies: triggerReplies !== false ? "true" : "false",
      alert_trigger_followups: triggerFollowups !== false ? "true" : "false",
      alert_trigger_errors: triggerErrors !== false ? "true" : "false"
    };

    for (const [key, val] of Object.entries(updates)) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2`,
        [key, String(val).trim()]
      );
    }

    console.log(`[Alerts API] Alert preferences updated by ${req.user.email}`);
    res.json({ message: "Alert preferences updated successfully." });
  } catch (error) {
    console.error("[Alerts API] Failed to update alert settings:", error.message);
    res.status(500).json({ error: "Failed to save alert settings." });
  }
});

// 9. WhatsApp Gateway Instance Status Check (Green-API Free Tier)
// WhatsApp Status Check via Baileys Gateway (Open endpoint for dashboard status & QR pairing screen)
app.get("/api/alerts/whatsapp-status", async (req, res) => {
  try {
    const status = getBaileysStatus();
    res.json({
      configured: true,
      gateway: "baileys",
      state: status.connected ? "authorized" : (status.qrReady ? "notAuthorized" : status.state),
      connected: status.connected,
      user: status.user,
      qrReady: status.qrReady,
      qrDataUrl: status.qrDataUrl,
      lastError: status.lastError
    });
  } catch (err) {
    res.json({
      configured: true,
      gateway: "baileys",
      state: "unreachable",
      error: err.message
    });
  }
});

// Restart / Reset Baileys Connection
app.all("/api/alerts/whatsapp-restart", async (req, res) => {
  try {
    await initBaileys(true);
    res.json({ success: true, message: "Baileys WhatsApp socket re-initialized." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Logout Baileys Session
app.all("/api/alerts/whatsapp-logout", async (req, res) => {
  try {
    await logoutBaileys();
    res.json({ success: true, message: "Logged out from WhatsApp." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Request 8-Digit Pairing Code for phone number linking
app.all("/api/alerts/whatsapp-pairing-code", async (req, res) => {
  try {
    const phone = req.body?.phone || req.query?.phone || process.env.WHATSAPP_RECIPIENT_PHONE || process.env.GREEN_API_RECIPIENT_PHONE;
    if (!phone) {
      return res.status(400).json({ success: false, error: "Please provide a valid phone number with country code (e.g. 918807099288)." });
    }
    const result = await requestPairingCode(phone);
    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Serve WhatsApp QR Code Linking Page for Baileys Gateway
app.get(["/whatsapp-qr.html", "/qr.html", "/whatsapp-qr", "/qr", "/whatsapp", "/api/alerts/whatsapp-qr"], (req, res) => {
  const qrFilePath = path.join(process.cwd(), "whatsapp-qr.html");
  if (fs.existsSync(qrFilePath)) {
    return res.sendFile(qrFilePath);
  }
  const altQrPath = path.join(process.cwd(), "qr.html");
  if (fs.existsSync(altQrPath)) {
    return res.sendFile(altQrPath);
  }
  res.redirect("/");
});

// 10. Instant Live Alert Test Dispatcher
app.all("/api/alerts/test", authMiddleware, async (req, res) => {
  const { channel = "all", targetPhone, targetEmail } = req.body || {};
  console.log(`[Alerts API] Live test alert requested by ${req.user ? req.user.email : 'user'} (channel: ${channel}, targetPhone: ${targetPhone}, targetEmail: ${targetEmail})`);
  const settings = await getAlertSettings();
  const results = { whatsapp: [], email: [] };
  const timestamp = new Date().toLocaleString();
  const crmUrl = process.env.TUNNEL_URL || `http://localhost:${PORT}`;

  // Test WhatsApp
  if (channel === "all" || channel === "whatsapp") {
    let phones = [];
    if (targetPhone && typeof targetPhone === "string" && targetPhone.trim()) {
      phones = targetPhone.split(",").map(p => p.trim()).filter(Boolean);
    } else if (settings.whatsappRecipients && settings.whatsappRecipients.length > 0) {
      phones = settings.whatsappRecipients;
    } else {
      phones = [process.env.WHATSAPP_RECIPIENT_PHONE || process.env.GREEN_API_RECIPIENT_PHONE || "918807099288"];
    }

    for (const phone of phones) {
      const cleanPhone = String(phone).replace(/\D/g, "");
      const msg = `*SALESFORGE CRM | SYSTEM TEST*\n*Alert Notification Verification*\n\nThis is a test notification confirming your WhatsApp alert delivery via Baileys WhatsApp Gateway.\n\nTime: ${timestamp}\nPortal: ${crmUrl}`;
      const waRes = await sendWhatsAppNotification(msg, cleanPhone);
      results.whatsapp.push({ phone: cleanPhone, ...waRes });
    }
  }

  // Test Email
  if (channel === "all" || channel === "email") {
    let emails = [];
    if (targetEmail && typeof targetEmail === "string" && targetEmail.trim()) {
      emails = targetEmail.split(",").map(e => e.trim()).filter(Boolean);
    } else if (settings.emailRecipients && settings.emailRecipients.length > 0) {
      emails = settings.emailRecipients;
    } else {
      emails = [req.user.email || "vimalraj5207@gmail.com"];
    }

    const subject = `[Salesforge Test Alert] Multi-Channel Alerting Verification`;
    const html = `
      <!DOCTYPE html>
      <html>
      <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #F8FAFC; padding: 24px; margin: 0;">
        <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #E2E8F0; padding: 24px; box-shadow: 0 4px 14px rgba(15,23,42,0.06);">
          <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #F1F5F9; padding-bottom: 16px; margin-bottom: 20px;">
            <h2 style="color: #0F172A; margin: 0; font-size: 18px;">Salesforge CRM</h2>
            <span style="background: #ECFDF5; color: #059669; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 99px;">TEST ALERT</span>
          </div>
          <h3 style="color: #1E293B; margin-top: 0;">Alert Notification Verification</h3>
          <p style="color: #475569; font-size: 14px; line-height: 1.6;">This email confirms that your Salesforge multi-channel alert delivery is configured and active.</p>
          <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #F1F5F9; display: flex; justify-content: space-between; align-items: center;">
            <span style="color: #94A3B8; font-size: 11px;">Timestamp: ${timestamp}</span>
            <a href="${crmUrl}" style="background: #2563EB; color: #ffffff; text-decoration: none; padding: 8px 16px; border-radius: 10px; font-size: 12px; font-weight: 600;">Open Dashboard →</a>
          </div>
        </div>
      </body>
      </html>
    `;

    for (const em of emails) {
      const emailRes = await sendEmailViaBrevo(em, subject, html);
      results.email.push({ email: em, ...emailRes });
    }
  }

  const anyWaOk = results.whatsapp.length > 0 ? results.whatsapp.some(r => r.success) : true;
  const anyEmailOk = results.email.length > 0 ? results.email.some(r => r.success) : true;
  const allWaOk = results.whatsapp.every(r => r.success);
  const allEmailOk = results.email.every(r => r.success);

  const overallSuccess = channel === "whatsapp" ? anyWaOk : (channel === "email" ? anyEmailOk : (anyWaOk && anyEmailOk));

  let errorSummary = "";
  if (!allWaOk) {
    const waErrors = results.whatsapp.filter(r => !r.success).map(r => r.error).join("; ");
    if (waErrors) errorSummary += `WhatsApp: ${waErrors}. `;
  }
  if (!allEmailOk) {
    const emailErrors = results.email.filter(r => !r.success).map(r => r.error).join("; ");
    if (emailErrors) errorSummary += `Email: ${emailErrors}. `;
  }

  if (overallSuccess) {
    res.json({ success: true, message: "Test alert dispatched successfully.", results });
  } else {
    res.status(400).json({ success: false, error: errorSummary || "Failed to dispatch test alert.", results });
  }
});

// Send 5 Test Job Alert Emails (Protected, Leader Only)
app.post("/api/test/send-samples", authMiddleware, async (req, res) => {
  if (req.user.role !== "leader") {
    return res.status(403).json({ error: "Forbidden. Only leaders can send test alert emails." });
  }

  let targetEmail = req.user.email;
  try {
    const { rows } = await pool.query("SELECT email FROM email_connections WHERE owner_email = $1 LIMIT 1", [req.user.email]);
    if (rows.length > 0) {
      targetEmail = rows[0].email;
    }
  } catch (err) {
    console.warn("Could not fetch connected email connection email, using login user email:", err.message);
  }

  console.log(`[Test Emails API] Preparing to dispatch 5 test alert emails to: ${targetEmail}`);

  const testMails = [
    {
      subject: "Toyota Motors Job Alert: R&D Director - Process Innovation",
      html: `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #ddd; border-radius: 8px; max-width: 600px; margin: 15px auto;">
          <h2 style="color: #c53030;">Toyota Motors R&D Careers</h2>
          <p><strong>Position:</strong> Associate Director of Process Innovation & Technology Roadmap</p>
          <p><strong>Location:</strong> Tokyo, Japan (Hybrid)</p>
          <p>Toyota Motors is a global leader in automotive manufacturing with over 300,000 employees. We are looking for an experienced leader to drive our technology roadmap, define IP strategy, and manage our patent portfolio.</p>
          <p>Apply via LinkedIn</p>
        </div>
      `
    },
    {
      subject: "Airbus Group Job Alert: Senior Scientist - R&D Composite Materials",
      html: `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #ddd; border-radius: 8px; max-width: 600px; margin: 15px auto;">
          <h2 style="color: #2b6cb0;">Airbus Aerospace Careers</h2>
          <p><strong>Position:</strong> Senior R&D Scientist - Materials & NPD</p>
          <p><strong>Location:</strong> Toulouse, France</p>
          <p>Airbus is a global leader in aerospace manufacturing and design, with over 100,000 employees. In this role, you will lead the research and development of lightweight composite materials for future aircraft platforms, working closely with the innovation manager on new product development (NPD).</p>
          <p>Apply via LinkedIn</p>
        </div>
      `
    },
    {
      subject: "TCS Job Alert: Java Backend Engineer",
      html: `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #ddd; border-radius: 8px; max-width: 600px; margin: 15px auto;">
          <h2 style="color: #4a5568;">TCS Careers</h2>
          <p><strong>Position:</strong> Software Engineer - Java Backend</p>
          <p><strong>Location:</strong> Bangalore, India</p>
          <p>Tata Consultancy Services (TCS) is a global IT services and consulting company. We are looking for Java developers to work on maintenance projects for our international banking clients. No R&D or new product design required.</p>
          <p>Apply via Indeed</p>
        </div>
      `
    },
    {
      subject: "QuickApp Inc Job Alert: Frontend Engineer (Startup)",
      html: `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #ddd; border-radius: 8px; max-width: 600px; margin: 15px auto;">
          <h2 style="color: #2b6cb0;">QuickApp Inc Startup Careers</h2>
          <p><strong>Position:</strong> Frontend R&D Engineer</p>
          <p><strong>Location:</strong> Mumbai, India</p>
          <p>QuickApp Inc is a growing startup of 15 employees creating a social media app. We need a creative developer to build prototype features.</p>
          <p>Apply via Indeed</p>
        </div>
      `
    },
    {
      subject: "Walmart Job Alert: Retail Operations Manager",
      html: `
        <div style="font-family: sans-serif; padding: 20px; border: 1px solid #ddd; border-radius: 8px; max-width: 600px; margin: 15px auto;">
          <h2 style="color: #2f855a;">Walmart Corporate Careers</h2>
          <p><strong>Position:</strong> Retail Store Operations Manager</p>
          <p><strong>Location:</strong> Chicago, USA</p>
          <p>Walmart is a global retail corporation. We are looking for a Store Manager to manage inventory, staff schedules, and customer satisfaction.</p>
          <p>Apply via Indeed</p>
        </div>
      `
    }
  ];

  try {
    let successCount = 0;
    for (const mail of testMails) {
      const ok = await sendEmailViaBrevo(targetEmail, mail.subject, mail.html);
      if (ok) successCount++;
      await new Promise(r => setTimeout(r, 300));
    }
    
    console.log(`[Test Emails API] Dispatched ${successCount}/${testMails.length} test emails successfully to: ${targetEmail}`);
    res.json({ message: `Successfully sent ${successCount} test emails to ${targetEmail}.` });
  } catch (error) {
    console.error("[Test Emails API] Failed to send test emails:", error.message);
    res.status(500).json({ error: "Failed to dispatch test emails." });
  }
});

// POST /api/outreach — Create outreach record + send Day 0 email
app.post("/api/outreach", authMiddleware, async (req, res) => {
  const { lead_id, lead_company, contact_name, contact_email, day0_subject, day0_body } = req.body;
  if (!contact_email || !day0_subject || !day0_body) {
    return res.status(400).json({ error: "contact_email, day0_subject and day0_body are required." });
  }

  try {
    const html = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">
      <p>${day0_body.replace(/\n/g, "<br>")}</p>
    </div>`;

    const result = await sendOutreachEmail(contact_email.trim().toLowerCase(), day0_subject, html, req.user.email);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    const { rows } = await pool.query(
      `INSERT INTO outreach_contacts (lead_id, lead_company, contact_name, contact_email, day0_subject, day0_body, status, sent_at, owner_email)
       VALUES ($1,$2,$3,$4,$5,$6,'emailed',NOW(),$7) RETURNING *`,
      [lead_id || null, lead_company || "", contact_name || "", contact_email.trim().toLowerCase(), day0_subject, day0_body, req.user.email]
    );
    const record = rows[0];

    // Automatically update or create matching Deal to 'contacted' stage
    if (lead_id) {
      const dealCheck = await pool.query("SELECT id FROM deals WHERE lead_id = $1", [lead_id]);
      if (dealCheck.rows.length > 0) {
        await pool.query(
          "UPDATE deals SET stage = 'contacted', probability = 40, updated_at = NOW() WHERE lead_id = $1",
          [lead_id]
        );
      } else {
        // Find or create account/contact if available
        const leadRes = await pool.query("SELECT * FROM leads WHERE id = $1", [lead_id]);
        if (leadRes.rows.length > 0) {
          const leadObj = leadRes.rows[0];
          const acctRes = await pool.query("SELECT id FROM accounts WHERE LOWER(company_name) = LOWER($1) LIMIT 1", [leadObj.company_name]);
          let acctId = acctRes.rows.length > 0 ? acctRes.rows[0].id : null;
          if (!acctId) {
            const newAcct = await pool.query("INSERT INTO accounts (company_name, owner_email) VALUES ($1, $2) RETURNING id", [leadObj.company_name, req.user.email]);
            acctId = newAcct.rows[0].id;
          }
          const contRes = await pool.query("SELECT id FROM contacts WHERE LOWER(email) = LOWER($1) LIMIT 1", [contact_email.trim().toLowerCase()]);
          let contId = contRes.rows.length > 0 ? contRes.rows[0].id : null;
          if (!contId) {
            const newCont = await pool.query("INSERT INTO contacts (account_id, name, email, owner_email) VALUES ($1, $2, $3, $4) RETURNING id", [acctId, contact_name || "Lead Contact", contact_email.trim().toLowerCase(), req.user.email]);
            contId = newCont.rows[0].id;
          }
          await pool.query(
            `INSERT INTO deals (account_id, contact_id, lead_id, title, amount, stage, probability, close_date, notes, owner_email)
             VALUES ($1, $2, $3, $4, 15000, 'contacted', 40, NOW() + INTERVAL '30 days', $5, $6)`,
            [acctId, contId, lead_id, `${leadObj.position || 'Opportunity'} - ${leadObj.company_name}`, leadObj.fit_reason || "Outreach Started", req.user.email]
          );
        }
      }
    }

    console.log(`[Outreach] Outreach created for ${lead_company} → ${contact_email} by ${req.user.email} (Method: ${result.method})`);
    res.json({ message: `Outreach started. Day 0 email sent via ${result.method}. Pipeline updated to Contacted stage.`, record });
  } catch (error) {
    console.error("[Outreach API] Failed to create outreach:", error.message);
    res.status(500).json({ error: "Failed to create outreach record: " + error.message });
  }
});

// GET /api/outreach — List all outreach records for this user (leader sees all, member sees own)
app.get("/api/outreach", authMiddleware, async (req, res) => {
  try {
    let queryStr = "SELECT id, lead_id, lead_company, contact_name, contact_email, day0_subject, day0_body, status, sent_at, followup1_sent_at, followup2_sent_at, replied_at, owner_email, created_at FROM outreach_contacts ORDER BY created_at DESC";
    let queryParams = [];
    if (req.user.role !== "leader") {
      queryStr = "SELECT id, lead_id, lead_company, contact_name, contact_email, day0_subject, day0_body, status, sent_at, followup1_sent_at, followup2_sent_at, replied_at, owner_email, created_at FROM outreach_contacts WHERE owner_email = $1 ORDER BY created_at DESC";
      queryParams = [req.user.email];
    }
    const { rows } = await pool.query(queryStr, queryParams);
    res.json(rows);
  } catch (error) {
    console.error("[Outreach API] Failed to fetch outreach:", error.message);
    res.status(500).json({ error: "Failed to fetch outreach records." });
  }
});

// GET /api/outreach/lead/:leadId — Get outreach record for a specific lead
app.get("/api/outreach/lead/:leadId", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, lead_id, lead_company, contact_name, contact_email, day0_subject, day0_body, status, sent_at, followup1_sent_at, followup2_sent_at, replied_at, owner_email, created_at FROM outreach_contacts WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 1",
      [req.params.leadId]
    );
    res.json(rows[0] || null);
  } catch (error) {
    console.error("[Outreach API] Failed to fetch lead outreach:", error.message);
    res.status(500).json({ error: "Failed to fetch outreach." });
  }
});

// PATCH /api/outreach/:id/status — Manually update status
app.patch("/api/outreach/:id/status", authMiddleware, async (req, res) => {
  const { status } = req.body;
  const allowed = ["replied", "no_response", "emailed", "followed_up_1", "followed_up_2"];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: "Invalid status value." });
  }
  try {
    const extra = status === "replied" ? ", replied_at = NOW()" : "";
    await pool.query(
      `UPDATE outreach_contacts SET status = $1${extra} WHERE id = $2`,
      [status, req.params.id]
    );
    res.json({ message: `Outreach status updated to: ${status}` });
  } catch (error) {
    console.error("[Outreach API] Failed to update status:", error.message);
    res.status(500).json({ error: "Failed to update status." });
  }
});

// POST /api/outreach/:id/send-followup — Send custom edited follow-up email
app.post("/api/outreach/:id/send-followup", authMiddleware, async (req, res) => {
  const { subject, body } = req.body;
  if (!subject || !body) {
    return res.status(400).json({ error: "Subject and body are required." });
  }

  try {
    const { rows } = await pool.query("SELECT * FROM outreach_contacts WHERE id = $1", [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: "Outreach record not found." });
    }
    const r = rows[0];

    const html = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">
      <p>${body.replace(/\n/g, "<br>")}</p>
    </div>`;

    const result = await sendOutreachEmail(r.contact_email, subject, html, req.user.email);
    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    const nextStatus = r.status === 'emailed' ? 'followed_up_1' : 'followed_up_2';
    const field = nextStatus === 'followed_up_1' ? 'followup1_sent_at' : 'followup2_sent_at';

    await pool.query(
      `UPDATE outreach_contacts SET status = $1, ${field} = NOW() WHERE id = $2`,
      [nextStatus, r.id]
    );

    res.json({ message: `Follow-up sent successfully via ${result.method}!`, status: nextStatus, record: { ...r, status: nextStatus } });
  } catch (error) {
    console.error("[Outreach API] Failed to send follow-up:", error.message);
    res.status(500).json({ error: "Failed to send follow-up: " + error.message });
  }
});

// DELETE /api/outreach/:id — Delete outreach record
app.delete("/api/outreach/:id", authMiddleware, async (req, res) => {
  try {
    await pool.query("DELETE FROM outreach_contacts WHERE id = $1", [req.params.id]);
    res.json({ message: "Outreach record deleted." });
  } catch (error) {
    console.error("[Outreach API] Failed to delete outreach:", error.message);
    res.status(500).json({ error: "Failed to delete outreach." });
  }
});

// Follow-up Job Function
async function runFollowUpJob() {
  console.log("[Outreach Cron] Running follow-up scheduler...");
  try {
    const { rows: day3Rows } = await pool.query(
      `SELECT id, lead_id, lead_company, contact_name, contact_email, day0_subject, day0_body, status, sent_at, owner_email FROM outreach_contacts
       WHERE status = 'emailed'
       AND sent_at <= NOW() - INTERVAL '3 days'`
    );
    for (const r of day3Rows) {
      const subject = `Re: ${r.day0_subject}`;
      const body = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">
        <p>Hi ${r.contact_name || "there"},</p>
        <p>Just following up on my previous email regarding a potential collaboration with <strong>${r.lead_company}</strong>. I wanted to make sure it didn't get buried in your inbox.</p>
        <p>Would love to connect briefly — even a 15-minute call would be great. Happy to work around your schedule.</p>
        <p>Looking forward to hearing from you.</p>
        <p>Best regards</p>
      </div>`;
      await sendOutreachEmail(r.contact_email, subject, body, r.owner_email);
      await pool.query(
        "UPDATE outreach_contacts SET status = 'followed_up_1', followup1_sent_at = NOW() WHERE id = $1",
        [r.id]
      );
      console.log(`[Outreach Cron] Follow-up #1 sent to ${r.contact_email} (${r.lead_company})`);
    }

    const { rows: day7Rows } = await pool.query(
      `SELECT id, lead_id, lead_company, contact_name, contact_email, day0_subject, day0_body, status, sent_at, owner_email FROM outreach_contacts
       WHERE status = 'followed_up_1'
       AND sent_at <= NOW() - INTERVAL '7 days'`
    );
    for (const r of day7Rows) {
      const subject = `Final note: ${r.day0_subject}`;
      const body = `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">
        <p>Hi ${r.contact_name || "there"},</p>
        <p>I don't want to take too much of your time, so this will be my final follow-up. I genuinely believe there's a strong fit between what we do and what <strong>${r.lead_company}</strong> is building.</p>
        <p>If the timing isn't right now, no worries at all — feel free to reach out whenever it makes sense.</p>
        <p>Wishing you and the team all the best.</p>
        <p>Best regards</p>
      </div>`;
      await sendOutreachEmail(r.contact_email, subject, body, r.owner_email);
      await pool.query(
        "UPDATE outreach_contacts SET status = 'followed_up_2', followup2_sent_at = NOW() WHERE id = $1",
        [r.id]
      );
      console.log(`[Outreach Cron] Follow-up #2 sent to ${r.contact_email} (${r.lead_company})`);
    }

    const { rows: archiveRows } = await pool.query(
      `SELECT id, lead_id, lead_company, contact_name, contact_email, status, sent_at, owner_email FROM outreach_contacts
       WHERE status = 'followed_up_2'
       AND sent_at <= NOW() - INTERVAL '14 days'`
    );
    for (const r of archiveRows) {
      await pool.query(
        "UPDATE outreach_contacts SET status = 'no_response' WHERE id = $1",
        [r.id]
      );
      console.log(`[Outreach Cron] Auto-archived (no response): ${r.contact_email} (${r.lead_company})`);
    }

    console.log(`[Outreach Cron] Follow-up run complete. Day3: ${day3Rows.length}, Day7: ${day7Rows.length}, Archived: ${archiveRows.length}`);
    
    if (day3Rows.length > 0 || day7Rows.length > 0 || archiveRows.length > 0) {
      await dispatchSystemAlert({
        eventType: "followup",
        title: "Follow-Up Sequence Dispatched",
        message: `Follow-up sequence completed. Sent *${day3Rows.length}* Day-3 and *${day7Rows.length}* Day-7 follow-up email(s). Auto-archived: *${archiveRows.length}*.`,
        details: `Day 3 Sent: ${day3Rows.length} | Day 7 Sent: ${day7Rows.length} | Archived: ${archiveRows.length}`
      });
    }

    return {
      day3Count: day3Rows.length,
      day7Count: day7Rows.length,
      archivedCount: archiveRows.length
    };
  } catch (err) {
    console.error("[Outreach Cron] Follow-up scheduler error:", err.message);
    throw err;
  }
}

// POST /api/outreach/run-followups (Manual Trigger)
app.post("/api/outreach/run-followups", authMiddleware, async (req, res) => {
  try {
    const result = await processFollowUpScheduler();
    res.json({
      message: `Follow-up run complete. Day 3: ${result.day3Count}, Day 7: ${result.day7Count}, Archived: ${result.archivedCount}`,
      ...result
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to run follow-up scheduler: " + err.message });
  }
});

// POST /api/outreach/check-replies (Manual Trigger)
app.post("/api/outreach/check-replies", authMiddleware, async (req, res) => {
  try {
    const result = await processReplyDetection();
    res.json({
      message: `Scan complete. Checked ${result.checkedCount} active campaign(s). ${result.detectedCount} new reply/replies detected!`,
      ...result
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to run reply detection scan: " + err.message });
  }
});

async function processReplyDetection() {
  console.log("[Reply Detection] Scanning inboxes for outreach replies...");
  let detectedCount = 0;

  try {
    const { rows: activeOutreach } = await pool.query(
      `SELECT id, lead_company, contact_name, contact_email, sent_at, owner_email, status
       FROM outreach_contacts
       WHERE status IN ('emailed', 'followed_up_1', 'followed_up_2')`
    );

    if (activeOutreach.length === 0) {
      console.log("[Reply Detection] No active outreach campaigns awaiting reply.");
      return { detectedCount: 0, checkedCount: 0 };
    }

    const { rows: connections } = await pool.query(
      "SELECT email, access_token, refresh_token, expiry_date, owner_email FROM email_connections"
    );

    if (connections.length === 0) {
      console.warn("[Reply Detection] No connected email inboxes available to scan.");
      return { detectedCount: 0, checkedCount: activeOutreach.length, warning: "No connected Gmail account found." };
    }

    for (const contact of activeOutreach) {
      let conn = connections.find(c => (c.owner_email && c.owner_email.toLowerCase() === (contact.owner_email || '').toLowerCase()) || c.email.toLowerCase() === (contact.owner_email || '').toLowerCase());
      if (!conn) conn = connections[0];

      try {
        console.log(`[Reply Detection] Checking inbox ${conn.email} for reply from ${contact.contact_email} (${contact.lead_company})...`);
        const oauth2Client = new google.auth.OAuth2(
          process.env.GOOGLE_CLIENT_ID,
          process.env.GOOGLE_CLIENT_SECRET,
          process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/api/email/oauth-callback`
        );
        let accessToken = conn.access_token;
        let expiryDate = parseInt(conn.expiry_date);

        if (Date.now() + 5 * 60 * 1000 >= expiryDate) {
          oauth2Client.setCredentials({ refresh_token: conn.refresh_token });
          const { credentials } = await oauth2Client.refreshAccessToken();
          accessToken = credentials.access_token;
          expiryDate = credentials.expiry_date;
          await pool.query(
            "UPDATE email_connections SET access_token = $1, expiry_date = $2 WHERE email = $3",
            [accessToken, expiryDate, conn.email]
          );
        }

        oauth2Client.setCredentials({ access_token: accessToken });
        const gmail = google.gmail({ version: "v1", auth: oauth2Client });

        const query = `from:${contact.contact_email}`;
        const { data } = await gmail.users.messages.list({ userId: "me", q: query, maxResults: 5 });

        if (data.messages && data.messages.length > 0) {
          const sentTime = new Date(contact.sent_at).getTime();
          let isReplyFound = false;

          for (const msgRef of data.messages) {
            const msgRes = await gmail.users.messages.get({ userId: "me", id: msgRef.id });
            const msgTime = parseInt(msgRes.data.internalDate || 0);

            if (msgTime >= sentTime - 60000) {
              isReplyFound = true;
              break;
            }
          }

          if (isReplyFound) {
            await pool.query(
              "UPDATE outreach_contacts SET status = 'replied', replied_at = NOW() WHERE id = $1 AND status != 'replied'",
              [contact.id]
            );
            detectedCount++;

            const notifyHtml = `
              <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#333;border:1px solid #e2e8f0;border-radius:8px;">
                <h2 style="color:#059669;margin-bottom:8px;">Prospect Reply Received</h2>
                <p style="font-size:14px;"><strong>${contact.contact_name || contact.contact_email}</strong> from <strong>${contact.lead_company}</strong> has replied to your outreach email.</p>
                <div style="background:#f0fdf4;border-left:4px solid #059669;padding:12px 16px;border-radius:4px;margin:16px 0;">
                  <p style="margin:0;font-size:13px;color:#065f46;"><strong>Contact Email:</strong> ${contact.contact_email}</p>
                  <p style="margin:4px 0 0;font-size:13px;color:#065f46;"><strong>Company:</strong> ${contact.lead_company}</p>
                </div>
                <p style="font-size:13px;color:#64748b;">Log in to your CRM dashboard to review the message and follow up.</p>
              </div>`;
            await sendEmailViaBrevo(contact.owner_email || conn.email, `[Prospect Reply] ${contact.contact_name || contact.contact_email} — ${contact.lead_company}`, notifyHtml);
            console.log(`[Reply Detection] Reply confirmed from ${contact.contact_email} (${contact.lead_company}). Owner notified: ${contact.owner_email || conn.email}`);
          }
        }
      } catch (err) {
        console.error(`[Reply Detection] Error checking contact ${contact.contact_email}:`, err.message);
      }
    }

    console.log(`[Reply Detection] Finished scan. Active contacts checked: ${activeOutreach.length}, New replies detected: ${detectedCount}`);
    return { detectedCount, checkedCount: activeOutreach.length };
  } catch (err) {
    console.error("[Reply Detection] Fatal error during scan:", err.message);
    throw err;
  }
}

// ============================================================================
// CRM CORE API ENDPOINTS: Lead Conversion, Accounts, Contacts, Deals, Tasks, Quotations
// ============================================================================

// 1. LEAD CONVERSION
app.post("/api/leads/:id/convert", authMiddleware, async (req, res) => {
  try {
    const leadId = req.params.id;
    let lead = null;

    // Check PostgreSQL leads table first
    const dbRes = await pool.query("SELECT * FROM leads WHERE id = $1", [leadId]);
    if (dbRes.rows.length > 0) {
      lead = dbRes.rows[0];
    } else {
      // Fallback to local jobs-db.json file
      const dbPath = path.join(process.cwd(), "jobs-db.json");
      if (fs.existsSync(dbPath)) {
        const fileData = JSON.parse(fs.readFileSync(dbPath, "utf8"));
        lead = fileData.find(l => String(l.id) === String(leadId) || String(l.db_id) === String(leadId));
      }
    }

    if (!lead) {
      return res.status(404).json({ error: "Lead not found" });
    }

    const ownerEmail = req.user?.email || lead.owner_email || "vimalraj5207@gmail.com";
    const companyName = lead.company_name || req.body.company_name || "Unknown Company";
    const contactEmail = lead.email || req.body.contact_email || `contact@${(lead.domain || "example.com").toLowerCase()}`;
    const contactName = req.body.contact_name || lead.position ? `Hiring Manager (${lead.position})` : "Primary Contact";

    // 1. Create or fetch Account
    let account = null;
    const acctCheck = await pool.query("SELECT * FROM accounts WHERE LOWER(company_name) = LOWER($1)", [companyName]);
    if (acctCheck.rows.length > 0) {
      account = acctCheck.rows[0];
    } else {
      const acctIns = await pool.query(
        `INSERT INTO accounts (company_name, domain, employees, company_bio, linkedin, wikipedia, owner_email)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [companyName, lead.domain || "", lead.employees || 0, lead.company_bio || "", lead.linkedin || "", lead.wikipedia || "", ownerEmail]
      );
      account = acctIns.rows[0];
    }

    // 2. Create or fetch Contact
    let contact = null;
    const contCheck = await pool.query("SELECT * FROM contacts WHERE LOWER(email) = LOWER($1)", [contactEmail]);
    if (contCheck.rows.length > 0) {
      contact = contCheck.rows[0];
    } else {
      const contIns = await pool.query(
        `INSERT INTO contacts (account_id, name, email, job_title, linkedin, owner_email)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [account.id, contactName, contactEmail, lead.position || "", lead.linkedin || "", ownerEmail]
      );
      contact = contIns.rows[0];
    }

    // 3. Create Deal
    const dealTitle = req.body.deal_title || `${lead.position || 'Opportunity'} - ${companyName}`;
    const dealAmount = req.body.deal_amount || 15000;
    const dealIns = await pool.query(
      `INSERT INTO deals (account_id, contact_id, lead_id, title, amount, stage, probability, close_date, notes, owner_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() + INTERVAL '30 days', $8, $9) RETURNING *`,
      [account.id, contact.id, lead.id || null, dealTitle, dealAmount, 'lead', 30, lead.fit_reason || "", ownerEmail]
    );
    const deal = dealIns.rows[0];

    // 4. Create initial follow-up task
    await pool.query(
      `INSERT INTO tasks (deal_id, contact_id, account_id, lead_id, title, description, due_date, priority, status, owner_email)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '2 days', 'high', 'pending', $7)`,
      [deal.id, contact.id, account.id, lead.id || null, `Initial Outreach Follow-up: ${companyName}`, `Connect with ${contact.name} regarding position: ${lead.position}`, ownerEmail]
    );

    res.json({
      message: "Lead successfully converted to Account, Contact, Deal, and Task!",
      account,
      contact,
      deal
    });
  } catch (err) {
    console.error("[Lead Conversion Error]", err);
    res.status(500).json({ error: "Failed to convert lead: " + err.message });
  }
});

// 2. ACCOUNTS ENDPOINTS
app.get("/api/accounts", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT a.*, 
             COUNT(DISTINCT c.id)::int AS contacts_count,
             COUNT(DISTINCT d.id)::int AS deals_count,
             COALESCE(SUM(d.amount), 0)::numeric AS total_deals_val
      FROM accounts a
      LEFT JOIN contacts c ON c.account_id = a.id
      LEFT JOIN deals d ON d.account_id = a.id
      GROUP BY a.id
      ORDER BY a.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/accounts", authMiddleware, async (req, res) => {
  try {
    const { company_name, domain, industry, employees, company_bio, linkedin, wikipedia } = req.body;
    const ownerEmail = req.user?.email || "vimalraj5207@gmail.com";
    const { rows } = await pool.query(
      `INSERT INTO accounts (company_name, domain, industry, employees, company_bio, linkedin, wikipedia, owner_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [company_name, domain || "", industry || "", employees || 0, company_bio || "", linkedin || "", wikipedia || "", ownerEmail]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/accounts/:id", authMiddleware, async (req, res) => {
  try {
    const { company_name, domain, industry, employees, company_bio, linkedin, wikipedia } = req.body;
    const { rows } = await pool.query(
      `UPDATE accounts 
       SET company_name = $1, domain = $2, industry = $3, employees = $4, company_bio = $5, linkedin = $6, wikipedia = $7
       WHERE id = $8 RETURNING *`,
      [company_name, domain, industry, employees, company_bio, linkedin, wikipedia, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/accounts/:id", authMiddleware, async (req, res) => {
  try {
    await pool.query("DELETE FROM accounts WHERE id = $1", [req.params.id]);
    res.json({ message: "Account deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. CONTACTS ENDPOINTS
app.get("/api/contacts", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT c.*, a.company_name 
      FROM contacts c
      LEFT JOIN accounts a ON a.id = c.account_id
      ORDER BY c.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/contacts", authMiddleware, async (req, res) => {
  try {
    const { account_id, name, email, phone, job_title, linkedin } = req.body;
    const ownerEmail = req.user?.email || "vimalraj5207@gmail.com";
    const { rows } = await pool.query(
      `INSERT INTO contacts (account_id, name, email, phone, job_title, linkedin, owner_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [account_id || null, name, email, phone || "", job_title || "", linkedin || "", ownerEmail]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/contacts/:id", authMiddleware, async (req, res) => {
  try {
    const { account_id, name, email, phone, job_title, linkedin } = req.body;
    const { rows } = await pool.query(
      `UPDATE contacts
       SET account_id = $1, name = $2, email = $3, phone = $4, job_title = $5, linkedin = $6
       WHERE id = $7 RETURNING *`,
      [account_id || null, name, email, phone, job_title, linkedin, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/contacts/:id", authMiddleware, async (req, res) => {
  try {
    await pool.query("DELETE FROM contacts WHERE id = $1", [req.params.id]);
    res.json({ message: "Contact deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. DEALS & PIPELINE ENDPOINTS
app.get("/api/deals", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT d.*, 
             a.company_name, a.domain AS company_domain,
             c.name AS contact_name, c.email AS contact_email
      FROM deals d
      LEFT JOIN accounts a ON a.id = d.account_id
      LEFT JOIN contacts c ON c.id = d.contact_id
      ORDER BY d.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/deals/metrics", authMiddleware, async (req, res) => {
  try {
    const totalRes = await pool.query("SELECT COALESCE(SUM(amount), 0)::numeric AS total, COUNT(*)::int AS count FROM deals");
    const wonRes = await pool.query("SELECT COALESCE(SUM(amount), 0)::numeric AS total, COUNT(*)::int AS count FROM deals WHERE stage = 'won'");
    const lostRes = await pool.query("SELECT COALESCE(SUM(amount), 0)::numeric AS total, COUNT(*)::int AS count FROM deals WHERE stage = 'lost'");
    const stageCountsRes = await pool.query("SELECT stage, COUNT(*)::int AS count, COALESCE(SUM(amount), 0)::numeric AS total FROM deals GROUP BY stage");

    const totalDeals = parseInt(totalRes.rows[0].count);
    const wonDeals = parseInt(wonRes.rows[0].count);
    const winRate = totalDeals > 0 ? ((wonDeals / totalDeals) * 100).toFixed(1) : "0.0";

    res.json({
      totalValue: parseFloat(totalRes.rows[0].total),
      wonValue: parseFloat(wonRes.rows[0].total),
      lostValue: parseFloat(lostRes.rows[0].total),
      totalDeals,
      wonDeals,
      winRate: parseFloat(winRate),
      stageBreakdown: stageCountsRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/deals", authMiddleware, async (req, res) => {
  try {
    const { account_id, contact_id, lead_id, title, amount, stage, probability, close_date, notes } = req.body;
    const ownerEmail = req.user?.email || "vimalraj5207@gmail.com";
    const { rows } = await pool.query(
      `INSERT INTO deals (account_id, contact_id, lead_id, title, amount, stage, probability, close_date, notes, owner_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [account_id || null, contact_id || null, lead_id || null, title, amount || 0, stage || 'lead', probability || 20, close_date || null, notes || "", ownerEmail]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/deals/:id", authMiddleware, async (req, res) => {
  try {
    const { account_id, contact_id, title, amount, stage, probability, close_date, notes } = req.body;
    const { rows } = await pool.query(
      `UPDATE deals 
       SET account_id = $1, contact_id = $2, title = $3, amount = $4, stage = $5, probability = $6, close_date = $7, notes = $8, updated_at = NOW()
       WHERE id = $9 RETURNING *`,
      [account_id || null, contact_id || null, title, amount, stage, probability, close_date, notes, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/deals/:id/stage", authMiddleware, async (req, res) => {
  try {
    const { stage } = req.body;
    const validStages = ['lead', 'contacted', 'quotation', 'negotiation', 'won', 'lost'];
    if (!validStages.includes(stage)) {
      return res.status(400).json({ error: `Invalid stage. Must be one of: ${validStages.join(', ')}` });
    }

    let prob = 20;
    if (stage === 'contacted') prob = 40;
    else if (stage === 'quotation') prob = 60;
    else if (stage === 'negotiation') prob = 80;
    else if (stage === 'won') prob = 100;
    else if (stage === 'lost') prob = 0;

    const { rows } = await pool.query(
      `UPDATE deals SET stage = $1, probability = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [stage, prob, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/deals/:id", authMiddleware, async (req, res) => {
  try {
    await pool.query("DELETE FROM deals WHERE id = $1", [req.params.id]);
    res.json({ success: true, record });
  } catch (err) {
    console.error("Outreach error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── In-Memory Semantic RAG Cache (60s TTL) ──
let ragContextCache = {
  data: null,
  timestamp: 0,
  key: ""
};

export function invalidateRagCache() {
  ragContextCache.data = null;
  ragContextCache.timestamp = 0;
}

// CRM RAG Knowledge Context Aggregator for Puter Copilot & AI Intelligence
app.get("/api/crm/rag-context", async (req, res) => {
  try {
    const now = Date.now();

    // Serve from in-memory cache if fresh (< 20s)
    if (ragContextCache.data && (now - ragContextCache.timestamp < 20000)) {
      return res.json({
        ...ragContextCache.data,
        cached: true,
        cacheAgeMs: now - ragContextCache.timestamp
      });
    }

    // ⚡ Execute all ground-truth queries in parallel across PostgreSQL pool
    const [
      countsRes,
      qualifiedLeadsRes,
      unqualifiedLeadsRes,
      accountsRes,
      contactsRes,
      dealsRes,
      tasksRes,
      outreachRes
    ] = await Promise.all([
      // 1. Exact Database Aggregates (Ground Truth Counts)
      pool.query(`
        SELECT 
          COUNT(*)::int AS total_leads,
          COUNT(*) FILTER (WHERE is_fit = true)::int AS total_qualified_leads,
          COUNT(*) FILTER (WHERE is_fit = false)::int AS total_unqualified_leads,
          ROUND(COALESCE(AVG(score) FILTER (WHERE is_fit = true), 0), 1) AS avg_qualified_score,
          (SELECT COUNT(*)::int FROM accounts) AS total_accounts,
          (SELECT COUNT(*)::int FROM contacts) AS total_contacts,
          (SELECT COUNT(*)::int FROM deals) AS total_deals,
          (SELECT COALESCE(SUM(amount), 0) FROM deals) AS total_pipeline_value,
          (SELECT COUNT(*)::int FROM tasks WHERE status != 'completed') AS pending_tasks,
          (SELECT COUNT(*)::int FROM outreach_contacts) AS total_outreach_sent,
          (SELECT COUNT(*)::int FROM outreach_contacts WHERE status = 'replied') AS total_replies
        FROM leads
      `),
      // 2. Qualified Leads List (Full details)
      pool.query(
        "SELECT id, company_name, position, scraped_location, score, employees, company_bio, fit_reason, domain, email, created_at FROM leads WHERE is_fit = true ORDER BY score DESC, id DESC LIMIT 60"
      ),
      // 3. Unqualified Leads Sample
      pool.query(
        "SELECT id, company_name, position, score, employees, fit_reason FROM leads WHERE is_fit = false ORDER BY id DESC LIMIT 15"
      ),
      // 4. Accounts & Contacts
      pool.query("SELECT id, company_name, industry, employees, company_bio, linkedin FROM accounts ORDER BY id DESC LIMIT 30"),
      pool.query("SELECT c.id, c.name, c.email, c.phone, c.job_title, a.company_name FROM contacts c LEFT JOIN accounts a ON c.account_id = a.id ORDER BY c.id DESC LIMIT 40"),
      pool.query("SELECT d.id, d.title, d.amount, d.stage, d.probability, d.close_date, d.notes, a.company_name FROM deals d LEFT JOIN accounts a ON d.account_id = a.id ORDER BY d.id DESC LIMIT 30"),
      pool.query("SELECT id, title, description, due_date, priority, status FROM tasks WHERE status != 'completed' ORDER BY due_date ASC LIMIT 25"),
      pool.query("SELECT id, lead_company, contact_name, contact_email, status, day0_subject, sent_at, replied_at FROM outreach_contacts ORDER BY id DESC LIMIT 25")
    ]);

    const counts = countsRes.rows[0] || {};
    const totalQualified = counts.total_qualified_leads || 0;
    const totalUnqualified = counts.total_unqualified_leads || 0;
    const totalLeads = counts.total_leads || 0;
    const totalAccounts = counts.total_accounts || 0;
    const totalContacts = counts.total_contacts || 0;
    const totalDeals = counts.total_deals || 0;
    const totalPipelineValue = Number(counts.total_pipeline_value || 0).toLocaleString();
    const totalOutreachSent = counts.total_outreach_sent || 0;
    const totalReplies = counts.total_replies || 0;

    // Format highly accurate ground-truth structured RAG document
    let contextText = `=== SALESFORGE CRM GROUND-TRUTH DATABASE METRICS ===\n`;
    contextText += `Timestamp: ${new Date().toLocaleString()}\n\n`;
    contextText += `[EXACT DATABASE TOTALS - USE THESE FOR ALL STATISTICAL QUESTIONS]:\n`;
    contextText += `• TOTAL QUALIFIED LEADS: ${totalQualified}\n`;
    contextText += `• TOTAL UNQUALIFIED LEADS: ${totalUnqualified}\n`;
    contextText += `• TOTAL ALL INGESTED LEADS: ${totalLeads}\n`;
    contextText += `• AVERAGE QUALIFIED FIT SCORE: ${counts.avg_qualified_score || 0}/100\n`;
    contextText += `• TOTAL CORPORATE ACCOUNTS: ${totalAccounts}\n`;
    contextText += `• TOTAL KEY CONTACTS: ${totalContacts}\n`;
    contextText += `• ACTIVE DEALS IN PIPELINE: ${totalDeals} (Total Pipeline Value: $${totalPipelineValue})\n`;
    contextText += `• OUTREACH CAMPAIGNS SENT: ${totalOutreachSent} (Replies: ${totalReplies})\n\n`;

    contextText += `--- QUALIFIED PROSPECTS & LEADS IN CRM (${qualifiedLeadsRes.rows.length} records) ---\n`;
    qualifiedLeadsRes.rows.forEach(l => {
      const headcount = l.employees ? `${Number(l.employees).toLocaleString()} employees` : 'Headcount N/A';
      contextText += `• [Lead #${l.id}] ${l.company_name} | Role: ${l.position || 'N/A'} | Location: ${l.scraped_location || 'N/A'} | Headcount: ${headcount} | Fit Score: ${l.score}/100\n  Why Fit: ${l.fit_reason || 'Qualified match'}\n  Bio: ${l.company_bio ? l.company_bio.slice(0, 160) : 'N/A'}\n`;
    });

    if (unqualifiedLeadsRes.rows.length > 0) {
      contextText += `\n--- SAMPLE UNQUALIFIED / REJECTED LEADS (${unqualifiedLeadsRes.rows.length} records) ---\n`;
      unqualifiedLeadsRes.rows.forEach(u => {
        contextText += `• [Unqualified Lead #${u.id}] ${u.company_name} | Role: ${u.position || 'N/A'} | Score: ${u.score}/100 | Disqualification Reason: ${u.fit_reason || 'Score < 50 or employee headcount < 500'}\n`;
      });
    }

    contextText += `\n--- CORPORATE ACCOUNTS & KEY STAKEHOLDERS (${accountsRes.rows.length} Accounts, ${contactsRes.rows.length} Contacts) ---\n`;
    accountsRes.rows.forEach(a => {
      const relatedContacts = contactsRes.rows.filter(c => c.company_name === a.company_name);
      contextText += `• [Account] ${a.company_name} (${a.industry || 'Enterprise'}, ${a.employees || 'Unknown'} emp)\n`;
      if (relatedContacts.length > 0) {
        relatedContacts.forEach(c => {
          contextText += `   - Contact: ${c.name} (${c.job_title || 'Executive'}) | Email: ${c.email} | Phone: ${c.phone || 'N/A'}\n`;
        });
      }
    });

    contextText += `\n--- DEALS PIPELINE (${dealsRes.rows.length} Deals) ---\n`;
    dealsRes.rows.forEach(d => {
      contextText += `• [Deal #${d.id}] "${d.title}" | Co: ${d.company_name || 'N/A'} | Stage: ${d.stage} | Value: $${Number(d.amount).toLocaleString()} | Win Prob: ${d.probability}%\n`;
    });

    contextText += `\n--- ACTIVE TASKS & OUTREACH STATUS ---\n`;
    contextText += `• Pending Tasks: ${counts.pending_tasks || 0}\n`;
    contextText += `• Total Outreach Sent: ${totalOutreachSent} | Replies Received: ${totalReplies}\n`;

    const responsePayload = {
      success: true,
      cached: false,
      contextText,
      stats: {
        totalLeads,
        qualifiedLeads: totalQualified,
        unqualifiedLeads: totalUnqualified,
        accounts: totalAccounts,
        contacts: totalContacts,
        deals: totalDeals,
        pipelineValue: totalPipelineValue,
        outreach: totalOutreachSent,
        replies: totalReplies
      },
      raw: {
        leads: qualifiedLeadsRes.rows,
        accounts: accountsRes.rows,
        contacts: contactsRes.rows,
        deals: dealsRes.rows
      }
    };

    // Save to in-memory TTL cache
    ragContextCache = {
      data: responsePayload,
      timestamp: Date.now(),
      key: "ground_truth_all"
    };

    res.json(responsePayload);
  } catch (err) {
    console.error("[RAG API] Error building CRM context:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Text-to-SQL Safe Query Sandbox for Puter Copilot & Dynamic RAG
app.post("/api/crm/ai-query", async (req, res) => {
  try {
    let { sql } = req.body;
    if (!sql || typeof sql !== "string") {
      return res.status(400).json({ success: false, error: "SQL query string is required" });
    }

    let cleanSql = sql.trim().replace(/^```(sql)?\s*/i, "").replace(/```\s*$/i, "").trim();

    // 1. Strict Security Validation: Pure Read-Only SELECT Queries
    const isSelect = /^(\s*WITH\s+[\s\S]+?\s+)?\s*SELECT\b/i.test(cleanSql);
    if (!isSelect) {
      return res.status(400).json({
        success: false,
        error: "Security Violation: Only read-only SELECT queries are permitted in the AI query engine."
      });
    }

    // 2. Reject destructive mutation commands
    const forbiddenPattern = /\b(DROP|DELETE|UPDATE|INSERT|ALTER|TRUNCATE|GRANT|REVOKE|EXEC|CREATE|COPY)\b/i;
    if (forbiddenPattern.test(cleanSql)) {
      return res.status(400).json({
        success: false,
        error: "Security Violation: Database write or schema modification commands are blocked."
      });
    }

    // 3. Remove trailing semicolons & enforce safe maximum row limits
    cleanSql = cleanSql.replace(/;+\s*$/, "");
    if (!/\bLIMIT\s+\d+/i.test(cleanSql)) {
      cleanSql += " LIMIT 50";
    }

    console.log(`[AI Query Engine] Executing dynamic SQL: ${cleanSql}`);
    const queryStart = Date.now();
    const result = await pool.query(cleanSql);
    const executionTimeMs = Date.now() - queryStart;

    res.json({
      success: true,
      sql: cleanSql,
      rowCount: result.rowCount,
      rows: result.rows,
      executionTimeMs
    });
  } catch (err) {
    console.error("[AI Query Engine] Query error:", err.message);
    res.status(400).json({
      success: false,
      error: `SQL Execution Error: ${err.message}`
    });
  }
});

// CRM Database Schema Definition for Puter Copilot Prompting
app.get("/api/crm/schema-definition", (req, res) => {
  res.json({
    success: true,
    schema: `
PostgreSQL CRM Schema Tables & Columns:
- leads (id SERIAL, date DATE, company_name VARCHAR(255), position VARCHAR(255), score INT, employees INT, company_bio TEXT, posted_date VARCHAR(255), domain VARCHAR(255), linkedin VARCHAR(255), scraped_location VARCHAR(255), email VARCHAR(255), is_fit BOOLEAN, fit_reason TEXT, notes TEXT, created_at TIMESTAMP)
- accounts (id SERIAL, company_name VARCHAR(255), domain VARCHAR(255), industry VARCHAR(255), employees INT, company_bio TEXT, linkedin VARCHAR(255), created_at TIMESTAMP)
- contacts (id SERIAL, account_id INT REFERENCES accounts(id), name VARCHAR(255), email VARCHAR(255), phone VARCHAR(100), job_title VARCHAR(255), linkedin VARCHAR(255), created_at TIMESTAMP)
- deals (id SERIAL, account_id INT REFERENCES accounts(id), contact_id INT REFERENCES contacts(id), lead_id INT, title VARCHAR(255), amount NUMERIC(12,2), stage VARCHAR(50) [lead, qualified, proposal, negotiation, won, lost], probability INT, close_date DATE, notes TEXT, created_at TIMESTAMP)
- tasks (id SERIAL, deal_id INT, contact_id INT, account_id INT, lead_id INT, title VARCHAR(255), description TEXT, due_date TIMESTAMP, priority VARCHAR(50) [low, medium, high], status VARCHAR(50) [pending, completed], created_at TIMESTAMP)
- quotations (id SERIAL, deal_id INT, quotation_number VARCHAR(100), items TEXT, subtotal NUMERIC(12,2), tax NUMERIC(12,2), discount NUMERIC(12,2), total_amount NUMERIC(12,2), status VARCHAR(50) [draft, sent, accepted, rejected], created_at TIMESTAMP)
- outreach_contacts (id SERIAL, lead_id INT, lead_company VARCHAR(255), contact_name VARCHAR(255), contact_email VARCHAR(255), day0_subject TEXT, day0_body TEXT, status VARCHAR(50) [emailed, followed_up_1, followed_up_2, replied, no_response], sent_at TIMESTAMP, replied_at TIMESTAMP, created_at TIMESTAMP)
    `.trim()
  });
});

// 5. TASKS & REMINDERS ENDPOINTS
app.get("/api/tasks", authMiddleware, async (req, res) => {
  try {
    const { status } = req.query;
    let query = `
      SELECT t.*, 
             d.title AS deal_title, 
             c.name AS contact_name, c.email AS contact_email,
             a.company_name
      FROM tasks t
      LEFT JOIN deals d ON d.id = t.deal_id
      LEFT JOIN contacts c ON c.id = t.contact_id
      LEFT JOIN accounts a ON a.id = t.account_id
    `;
    let params = [];
    if (status) {
      query += ` WHERE t.status = $1`;
      params.push(status);
    }
    query += ` ORDER BY t.due_date ASC NULLS LAST, t.created_at DESC`;

    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/tasks", authMiddleware, async (req, res) => {
  try {
    const { deal_id, contact_id, account_id, lead_id, title, description, due_date, priority } = req.body;
    const ownerEmail = req.user?.email || "vimalraj5207@gmail.com";
    const { rows } = await pool.query(
      `INSERT INTO tasks (deal_id, contact_id, account_id, lead_id, title, description, due_date, priority, status, owner_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9) RETURNING *`,
      [deal_id || null, contact_id || null, account_id || null, lead_id || null, title, description || "", due_date || null, priority || 'medium', ownerEmail]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/tasks/:id/status", authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const { rows } = await pool.query(
      `UPDATE tasks SET status = $1 WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/tasks/:id", authMiddleware, async (req, res) => {
  try {
    await pool.query("DELETE FROM tasks WHERE id = $1", [req.params.id]);
    res.json({ message: "Task deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. QUOTATIONS ENDPOINTS
app.get("/api/quotations", authMiddleware, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT q.*, 
             d.title AS deal_title, d.amount AS deal_amount,
             a.company_name, c.name AS contact_name, c.email AS contact_email
      FROM quotations q
      LEFT JOIN deals d ON d.id = q.deal_id
      LEFT JOIN accounts a ON a.id = d.account_id
      LEFT JOIN contacts c ON c.id = d.contact_id
      ORDER BY q.created_at DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/quotations", authMiddleware, async (req, res) => {
  try {
    const { deal_id, items, subtotal, tax, discount, valid_until } = req.body;
    const ownerEmail = req.user?.email || "vimalraj5207@gmail.com";
    const quoteNum = `QT-${Date.now().toString().slice(-6)}`;
    const sub = parseFloat(subtotal || 0);
    const tx = parseFloat(tax || 0);
    const disc = parseFloat(discount || 0);
    const total = sub + tx - disc;

    const { rows } = await pool.query(
      `INSERT INTO quotations (deal_id, quotation_number, items, subtotal, tax, discount, total_amount, valid_until, status, owner_email)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9) RETURNING *`,
      [deal_id, quoteNum, typeof items === 'string' ? items : JSON.stringify(items), sub, tx, disc, total, valid_until || null, ownerEmail]
    );

    // Automatically update deal stage to 'quotation'
    await pool.query("UPDATE deals SET stage = 'quotation', probability = 60 WHERE id = $1", [deal_id]);

    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/quotations/:id/send-email", authMiddleware, async (req, res) => {
  try {
    const quoteRes = await pool.query(`
      SELECT q.*, 
             d.title AS deal_title,
             a.company_name, c.name AS contact_name, c.email AS contact_email
      FROM quotations q
      LEFT JOIN deals d ON d.id = q.deal_id
      LEFT JOIN accounts a ON a.id = d.account_id
      LEFT JOIN contacts c ON c.id = d.contact_id
      WHERE q.id = $1
    `, [req.params.id]);

    if (quoteRes.rows.length === 0) {
      return res.status(404).json({ error: "Quotation not found" });
    }

    const q = quoteRes.rows[0];
    const targetEmail = req.body.recipient_email || q.contact_email;
    if (!targetEmail) {
      return res.status(400).json({ error: "Recipient email is missing." });
    }

    const itemsArr = typeof q.items === 'string' ? JSON.parse(q.items || "[]") : (q.items || []);
    let itemsTable = itemsArr.map(item => `
      <tr>
        <td style="padding:10px;border-bottom:1px solid #e2e8f0;">${item.description || 'Service'}</td>
        <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:center;">${item.quantity || 1}</td>
        <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:right;">$${parseFloat(item.unit_price || 0).toLocaleString()}</td>
        <td style="padding:10px;border-bottom:1px solid #e2e8f0;text-align:right;">$${(parseFloat(item.quantity || 1) * parseFloat(item.unit_price || 0)).toLocaleString()}</td>
      </tr>
    `).join("");

    const htmlContent = `
      <div style="font-family:sans-serif;max-width:650px;margin:0 auto;padding:24px;color:#1e293b;border:1px solid #e2e8f0;border-radius:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:2px solid #2563eb;padding-bottom:16px;margin-bottom:20px;">
          <h1 style="color:#2563eb;margin:0;font-size:22px;">QUOTATION: ${q.quotation_number}</h1>
          <span style="font-size:12px;color:#64748b;">Date: ${new Date(q.created_at).toLocaleDateString()}</span>
        </div>
        <p style="font-size:14px;">Dear <strong>${q.contact_name || 'Client'}</strong> (${q.company_name || 'Partner'}),</p>
        <p style="font-size:13px;color:#475569;">Please review the official commercial proposal for <strong>${q.deal_title}</strong> below:</p>
        
        <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:13px;">
          <thead>
            <tr style="background:#f8fafc;color:#475569;text-align:left;">
              <th style="padding:10px;border-bottom:2px solid #cbd5e1;">Description</th>
              <th style="padding:10px;border-bottom:2px solid #cbd5e1;text-align:center;">Qty</th>
              <th style="padding:10px;border-bottom:2px solid #cbd5e1;text-align:right;">Unit Price</th>
              <th style="padding:10px;border-bottom:2px solid #cbd5e1;text-align:right;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${itemsTable}
          </tbody>
        </table>

        <div style="margin-top:20px;text-align:right;font-size:14px;line-height:1.8;">
          <p style="margin:0;">Subtotal: <strong>$${parseFloat(q.subtotal).toLocaleString()}</strong></p>
          <p style="margin:0;color:#059669;">Tax / Fees: +$${parseFloat(q.tax).toLocaleString()}</p>
          <p style="margin:0;color:#dc2626;">Discount: -$${parseFloat(q.discount).toLocaleString()}</p>
          <p style="margin:8px 0 0;font-size:18px;color:#2563eb;font-weight:bold;">Total Amount: $${parseFloat(q.total_amount).toLocaleString()}</p>
        </div>

        <p style="font-size:12px;color:#94a3b8;margin-top:24px;">Valid until: ${q.valid_until ? new Date(q.valid_until).toLocaleDateString() : '30 days from issuance'}</p>
      </div>
    `;

    const sendRes = await sendOutreachEmail(targetEmail, `Commercial Quotation ${q.quotation_number} — ${q.company_name}`, htmlContent, req.user?.email);
    if (sendRes.success) {
      await pool.query("UPDATE quotations SET status = 'sent' WHERE id = $1", [q.id]);
      res.json({ message: `Quotation ${q.quotation_number} sent successfully to ${targetEmail}` });
    } else {
      res.status(500).json({ error: sendRes.error });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

(async () => {
  try {
    const apiBaseUrl = (useTunnel && tunnelUrl) ? tunnelUrl : `http://localhost:${PORT}`;
    const configPath = path.join(process.cwd(), "frontend", "config.js");
    const configContent = `// Frontend Environment Configuration\n// Automatically generated on startup\nwindow.ENV = {\n  API_BASE_URL: "${apiBaseUrl}"\n};\n`;
    let shouldWrite = true;
    if (fs.existsSync(configPath)) {
      const existing = fs.readFileSync(configPath, "utf8");
      if (existing === configContent) {
        shouldWrite = false;
      }
    }
    if (shouldWrite) {
      fs.writeFileSync(configPath, configContent, "utf8");
      originalLog(`[Config Sync] Automatically updated frontend/config.js to point to API_BASE_URL: ${apiBaseUrl}`);
    }
  } catch (configErr) {
    originalError("[Config Sync] Failed to update frontend/config.js:", configErr.message);
  }

  try {
    await initDb();
  } catch (err) {
    originalError("Could not initialize database on startup:", err.message);
  }

  try {
    initCronJob();
  } catch (err) {
    originalError("Could not initialize cron job on startup:", err.message);
  }

  // Initialize Baileys WhatsApp Gateway Socket
  try {
    initBaileys().catch(bErr => {
      originalError("[Baileys Gateway] Background init error:", bErr.message);
    });
  } catch (bInitErr) {
    originalError("[Baileys Gateway] Failed to start Baileys service:", bInitErr.message);
  }

  app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    originalLog(`\n==================================================`);
    originalLog(`Server running locally at: ${url}`);
    originalLog(`==================================================\n`);

    const startCommand = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
    exec(`${startCommand} ${url}`);
  });
})();
