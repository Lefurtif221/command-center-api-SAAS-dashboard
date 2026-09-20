const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { auth } = require('../middleware/auth');

const router = express.Router();

const sessions = new Map();
const qrCodes = new Map();
const clients = new Map();
const statusMap = new Map();

function getSessionDir(userId) {
  const dir = path.join(__dirname, '..', 'whatsapp-sessions', userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function startSession(userId) {
  if (clients.has(userId)) return;

  const { state, saveCreds } = await useMultiFileAuthState(getSessionDir(userId));

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Personal Place', 'Chrome', '4.0.0'],
    version: (await fetchLatestBaileysVersion()).version,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        const qrDataUrl = await qrcode.toDataURL(qr, { width: 256, margin: 2 });
        qrCodes.set(userId, qrDataUrl);
        statusMap.set(userId, 'waiting_qr');
      } catch (err) {
        console.error('QR generation error:', err);
      }
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      if (reason === DisconnectReason.loggedOut) {
        console.log(`WhatsApp session ${userId} logged out`);
        const dir = getSessionDir(userId);
        fs.rmSync(dir, { recursive: true, force: true });
      } else {
        console.log(`WhatsApp session ${userId} disconnected, reconnecting...`);
        setTimeout(() => {
          clients.delete(userId);
          startSession(userId);
        }, 3000);
      }
      clients.delete(userId);
      qrCodes.delete(userId);
      statusMap.set(userId, 'disconnected');
    }

    if (connection === 'open') {
      console.log(`WhatsApp session ${userId} connected`);
      qrCodes.delete(userId);
      statusMap.set(userId, 'connected');

      try {
        const db = require('../db');
        await db`INSERT INTO connected_services (user_id, service_name, access_token)
          VALUES (${userId}, 'whatsapp', 'baileys-session')
          ON CONFLICT (user_id, service_name)
          DO UPDATE SET access_token = 'baileys-session', created_at = NOW()`;
      } catch (err) {
        console.error('DB save error:', err);
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const chatId = msg.key.remoteJid;
      const from = msg.pushName || chatId;
      const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
      const timestamp = new Date(msg.messageTimestamp * 1000).toISOString();

      const existing = sessions.get(userId) || { messages: [] };
      const existingMessages = existing.messages || [];
      existingMessages.unshift({
        id: msg.key.id,
        from,
        chatId,
        body,
        timestamp,
        fromMe: false,
      });
      existing.messages = existingMessages.slice(0, 500);
      sessions.set(userId, existing);
    }
  });

  clients.set(userId, sock);
  statusMap.set(userId, 'connecting');
}

router.post('/connect', auth, async (req, res) => {
  try {
    const userId = req.userId;
    await startSession(userId);

    const waitForQR = new Promise((resolve, reject) => {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (qrCodes.has(userId)) {
          clearInterval(interval);
          resolve(qrCodes.get(userId));
        }
        if (statusMap.get(userId) === 'connected') {
          clearInterval(interval);
          resolve('already_connected');
        }
        if (attempts > 30) {
          clearInterval(interval);
          reject(new Error('Timeout'));
        }
      }, 500);
    });

    const qrDataUrl = await waitForQR;
    res.json({ success: true, qr: qrDataUrl, status: statusMap.get(userId) });
  } catch (err) {
    console.error('WhatsApp connect error:', err);
    res.status(500).json({ error: err.message || 'Erreur de connexion' });
  }
});

router.get('/status', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const status = statusMap.get(userId) || 'disconnected';
    res.json({ status });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/messages', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const client = clients.get(userId);

    if (!client) return res.json({ messages: [] });

    const chats = Object.values(client.store?.chats?.attrs || {});
    const messages = [];

    for (const chat of chats.slice(0, 50)) {
      const jid = chat.id;
      const msgs = client.store?.messages?.get?.(jid)?.array || [];
      for (const msg of msgs.slice(-20)) {
        const isFromMe = msg.key.fromMe;
        const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
        const from = isFromMe ? 'Moi' : (msg.pushName || jid.split('@')[0]);
        messages.push({
          id: msg.key.id,
          from,
          chatId: jid,
          body,
          timestamp: new Date(msg.messageTimestamp * 1000).toISOString(),
          fromMe: isFromMe,
          unread: !isFromMe && !msg.key.fromMe,
        });
      }
    }

    messages.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    res.json({ messages: messages.slice(0, 200) });
  } catch (err) {
    console.error('WhatsApp messages error:', err);
    res.status(500).json({ error: err.message || 'Erreur lors du chargement' });
  }
});

router.post('/send', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const client = clients.get(userId);
    if (!client) return res.status(400).json({ error: 'WhatsApp non connecté' });

    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Destinataire et message requis' });

    let jid = to.includes('@') ? to : to.replace(/\D/g, '') + '@s.whatsapp.net';
    const result = await client.sendMessage(jid, { text: message });

    res.json({ success: true, messageId: result.key.id });
  } catch (err) {
    console.error('WhatsApp send error:', err);
    res.status(500).json({ error: err.message || "Erreur lors de l'envoi" });
  }
});

router.post('/disconnect', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const client = clients.get(userId);
    if (client) {
      await client.logout();
      client.end();
      clients.delete(userId);
    }
    qrCodes.delete(userId);
    sessions.delete(userId);
    statusMap.delete(userId);

    const dir = path.join(__dirname, '..', 'whatsapp-sessions', userId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

    const db = require('../db');
    await db`DELETE FROM connected_services WHERE user_id = ${userId} AND service_name = 'whatsapp'`;

    res.json({ success: true });
  } catch (err) {
    console.error('WhatsApp disconnect error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
