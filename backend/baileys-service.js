import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} from '@whiskeysockets/baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
// Auth session folder path (located at project root to avoid triggering node --watch-path=backend)
const AUTH_DIR = path.resolve(process.cwd(), 'baileys_auth_info');

// In-memory state tracking
let sock = null;
let currentQR = null;
let currentQRDataUrl = null;
let connectionState = 'disconnected'; // 'disconnected' | 'connecting' | 'qr_ready' | 'connected'
let connectionUser = null;
let lastError = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 15;
let isInitializing = false;

// Silent logger for clean CRM server console
const logger = pino({ level: 'silent' });

/**
 * Initialize Baileys WhatsApp Socket
 */
export async function initBaileys(forceReset = false) {
  if (isInitializing) {
    console.log('[Baileys Gateway] Initialization already in progress...');
    return;
  }

  if (forceReset) {
    try {
      if (sock) {
        sock.ev.removeAllListeners();
        sock.end(new Error('Resetting connection'));
        sock = null;
      }
      if (fs.existsSync(AUTH_DIR)) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        console.log('[Baileys Gateway] Auth directory cleared for clean reconnect.');
      }
    } catch (err) {
      console.warn('[Baileys Gateway] Reset cleanup notice:', err.message);
    }
    reconnectAttempts = 0;
    currentQR = null;
    currentQRDataUrl = null;
    connectionUser = null;
  }

  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  isInitializing = true;
  connectionState = 'connecting';
  lastError = null;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    
    let version = [2, 3000, 1015901307];
    let isLatest = false;
    try {
      const vRes = await fetchLatestBaileysVersion();
      if (vRes && vRes.version) {
        version = vRes.version;
        isLatest = vRes.isLatest;
      }
    } catch (vErr) {
      console.warn('[Baileys Gateway] Could not fetch latest WhatsApp web version, using default version:', vErr.message);
    }

    console.log(`[Baileys Gateway] Initializing Baileys v${version.join('.')} (isLatest: ${isLatest})...`);

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      printQRInTerminal: true,
      browser: Browsers ? Browsers.ubuntu('Chrome') : ['Ubuntu', 'Chrome', '20.0.04'],
      generateHighQualityLinkPreview: true,
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
      keepAliveIntervalMs: 30000,
    });

    // Save auth credentials whenever updated
    sock.ev.on('creds.update', saveCreds);

    // Handle Connection State Updates
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQR = qr;
        connectionState = 'qr_ready';
        try {
          currentQRDataUrl = await QRCode.toDataURL(qr, {
            margin: 2,
            scale: 8,
            color: { dark: '#0F172A', light: '#FFFFFF' }
          });
          console.log('[Baileys Gateway] New QR code generated. Ready to pair at /qr.html or /whatsapp-qr.html');
        } catch (qrErr) {
          console.error('[Baileys Gateway] Error converting QR to data URL:', qrErr.message);
        }
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        connectionState = 'disconnected';
        currentQR = null;
        currentQRDataUrl = null;
        connectionUser = null;
        lastError = lastDisconnect?.error?.message || `Closed with code ${statusCode}`;

        console.log(`[Baileys Gateway] Connection closed (statusCode: ${statusCode}, reason: ${lastError})`);

        if (statusCode === DisconnectReason.loggedOut) {
          console.log('[Baileys Gateway] User logged out of WhatsApp. Clearing session...');
          if (fs.existsSync(AUTH_DIR)) {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          }
          isInitializing = false;
          setTimeout(() => initBaileys(), 2000);
        } else if (shouldReconnect && reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
          reconnectAttempts++;
          const delay = Math.min(reconnectAttempts * 2000, 15000);
          console.log(`[Baileys Gateway] Reconnecting in ${delay / 1000}s (Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
          isInitializing = false;
          setTimeout(() => initBaileys(), delay);
        } else {
          isInitializing = false;
        }
      } else if (connection === 'open') {
        connectionState = 'connected';
        currentQR = null;
        currentQRDataUrl = null;
        reconnectAttempts = 0;
        connectionUser = sock.user?.id ? sock.user.id.split(':')[0] : 'Connected User';
        lastError = null;
        isInitializing = false;
        console.log(`[Baileys Gateway] WhatsApp successfully CONNECTED! (Phone: +${connectionUser})`);
      }
    });

  } catch (err) {
    console.error('[Baileys Gateway] Initialization error:', err.message);
    connectionState = 'disconnected';
    lastError = err.message;
    isInitializing = false;
  }
}

/**
 * Get current Baileys status
 */
export function getBaileysStatus() {
  return {
    state: connectionState,
    connected: connectionState === 'connected',
    user: connectionUser,
    qrReady: Boolean(currentQRDataUrl),
    qrDataUrl: currentQRDataUrl,
    lastError: lastError
  };
}

/**
 * Send WhatsApp text message to phone number
 */
export async function sendBaileysMessage(recipientPhone, message) {
  if (connectionState !== 'connected' || !sock) {
    return {
      success: false,
      error: `WhatsApp Gateway is not connected (current state: ${connectionState}). Please link your device via QR code at /qr.html.`,
      state: connectionState
    };
  }

  try {
    let cleanPhone = String(recipientPhone).replace(/\D/g, '');
    if (!cleanPhone) {
      return { success: false, error: 'Invalid phone number.' };
    }

    // Convert to WhatsApp JID format
    const jid = cleanPhone.includes('@s.whatsapp.net')
      ? cleanPhone
      : `${cleanPhone}@s.whatsapp.net`;

    console.log(`[Baileys Gateway] Sending message to ${jid}...`);
    const result = await sock.sendMessage(jid, { text: message });

    console.log(`[Baileys Gateway] Message successfully dispatched to ${cleanPhone}. Message ID: ${result?.key?.id}`);
    return {
      success: true,
      data: { id: result?.key?.id, timestamp: result?.messageTimestamp },
      chatId: jid,
      phone: cleanPhone
    };
  } catch (err) {
    console.error(`[Baileys Gateway] Failed to send message to ${recipientPhone}:`, err.message);
    return {
      success: false,
      error: err.message,
      phone: recipientPhone
    };
  }
}

/**
 * Request an 8-digit WhatsApp Pairing Code for phone-number linking
 */
export async function requestPairingCode(phoneNumber) {
  if (connectionState === 'connected') {
    return { success: false, error: 'WhatsApp is already connected! Disconnect first to link a new number.' };
  }

  let cleanPhone = String(phoneNumber).replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 7) {
    return { success: false, error: 'Please provide a valid phone number with country code (e.g. 918807099288).' };
  }

  if (!sock) {
    await initBaileys();
  }

  // Allow socket a few moments to establish connection to WA WebSocket
  let tries = 0;
  while (!sock && tries < 10) {
    await new Promise(r => setTimeout(r, 500));
    tries++;
  }

  try {
    console.log(`[Baileys Gateway] Requesting pairing code for +${cleanPhone}...`);
    const rawCode = await sock.requestPairingCode(cleanPhone);
    const formattedCode = rawCode?.match(/.{1,4}/g)?.join('-') || rawCode;
    console.log(`[Baileys Gateway] Pairing code generated: ${formattedCode}`);
    return {
      success: true,
      phone: cleanPhone,
      pairingCode: formattedCode,
      rawCode: rawCode
    };
  } catch (err) {
    console.error(`[Baileys Gateway] Pairing code error for +${cleanPhone}:`, err.message);
    return {
      success: false,
      error: err.message || 'Failed to request pairing code. Please try scanning the QR code directly or refresh the connection.'
    };
  }
}

/**
 * Logout and clear session
 */
export async function logoutBaileys() {
  try {
    if (sock) {
      await sock.logout();
    }
  } catch (err) {
    console.warn('[Baileys Gateway] Logout warning:', err.message);
  }
  return initBaileys(true);
}
