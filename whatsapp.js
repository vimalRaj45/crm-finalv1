import 'dotenv/config';
import { initBaileys, getBaileysStatus, sendBaileysMessage } from './backend/baileys-service.js';
import axios from 'axios';

/**
 * Baileys WhatsApp Gateway Test Utility
 * 
 * Usage:
 *   node whatsapp.js
 *   node whatsapp.js 918807099288 "Custom test message here"
 */

async function testWhatsApp() {
  console.log('====================================================');
  console.log('     WhatsApp Message Sending Test (Baileys Gateway) ');
  console.log('====================================================\n');

  let recipient = process.argv[2] || process.env.WHATSAPP_RECIPIENT_PHONE || process.env.GREEN_API_RECIPIENT_PHONE || '918807099288';
  const customMessage = process.argv[3] || `*REVIX CRM | SYSTEM TEST*\n*Alert Notification Verification*\n\nThis is a test notification confirming your WhatsApp alert delivery via Baileys WhatsApp Gateway.\n\nTime: ${new Date().toLocaleString()}\nStatus: Active`;

  console.log(`[Configuration]`);
  console.log(` - Engine          : Baileys Multi-Device Gateway`);
  console.log(` - Recipient Phone : ${recipient}`);
  console.log(` - Message Content :\n${customMessage}\n`);

  // First, check if the CRM server is running and connected
  const serverPort = process.env.PORT || 3000;
  let serverHandled = false;

  try {
    const statusRes = await axios.get(`http://localhost:${serverPort}/api/alerts/whatsapp-status`, { credentials: false, timeout: 3000 });
    if (statusRes.data && statusRes.data.connected) {
      console.log(`[CRM Server] Active CRM instance detected at port ${serverPort} (Phone: +${statusRes.data.user}).`);
      console.log('[Step 1] Dispatching test message through CRM server endpoint...');
      
      const sendRes = await axios.post(`http://localhost:${serverPort}/api/alerts/test`, {
        channel: 'whatsapp',
        targetPhone: recipient
      }, { timeout: 10000 });

      console.log('\n[Success] Dispatched via active CRM server.');
      console.log('Response:', JSON.stringify(sendRes.data, null, 2));
      return;
    }
  } catch (err) {
    // Server not running or unauthorized, fallback to standalone socket check
  }

  // Standalone Socket Mode
  console.log('[Standalone Mode] Initializing local Baileys socket...');
  await initBaileys();

  // Wait up to 10 seconds for connection or QR
  console.log('[Step 1] Waiting for Baileys connection state...');
  let attempts = 0;
  while (attempts < 20) {
    await new Promise(r => setTimeout(r, 500));
    attempts++;
    const st = getBaileysStatus();
    if (st.connected) {
      console.log(`   Connected as +${st.user}`);
      break;
    } else if (st.qrReady) {
      console.log(`\n[Notice] WhatsApp pairing required.`);
      console.log(`   Please open http://localhost:${serverPort}/whatsapp-qr.html in your browser or run "npm start" to scan the QR code.`);
      process.exit(0);
    }
  }

  const status = getBaileysStatus();
  if (!status.connected) {
    console.log(`\n[Status] Current connection state: ${status.state}`);
    console.log(`Please start the server with "npm start" and visit http://localhost:${serverPort}/whatsapp-qr.html to link your WhatsApp account.`);
    process.exit(0);
  }

  console.log('\n[Step 2] Sending WhatsApp message...');
  const res = await sendBaileysMessage(recipient, customMessage);
  if (res.success) {
    console.log('\n[Success] WhatsApp message sent successfully via Baileys Gateway!');
    console.log('Details:', res);
  } else {
    console.error('\n[Error] Failed to send message:', res.error);
  }

  setTimeout(() => process.exit(0), 1000);
}

testWhatsApp();
