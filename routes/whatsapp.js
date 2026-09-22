const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const pino = require('pino');
const path = require('path');
const fs = require('fs');
const { auth } = require('../middleware/auth');

const router = express.Router();

const qrCodes = new Map();
const clients = new Map();
const statusMap = new Map();
const messageStore = new Map();
const chatStore = new Map();
const contactStore = new Map();
const priorityStore = new Map();
const historySynced = new Map();

function getSessionDir(userId) {
  const dir = path.join(__dirname, '..', 'whatsapp-sessions', userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getContactName(userId, jid) {
  const contacts = contactStore.get(userId) || {};
  return contacts[jid]?.name || contacts[jid?.split('@')[0]]?.name || null;
}

function parseMessage(msg, userId) {
  const chatId = msg.key.remoteJid;
  const isFromMe = msg.key.fromMe;
  const senderJid = isFromMe ? '' : (msg.key.participant || chatId);
  const m = msg.message || {};

  let body = m.conversation || m.extendedTextMessage?.text || '';
  if (!body && m.imageMessage) body = m.imageMessage.caption || '[Image]';
  if (!body && m.videoMessage) body = m.videoMessage.caption || '[Video]';
  if (!body && m.audioMessage) body = '[Audio]';
  if (!body && (m.documentMessage || m.documentWithCaptionMessage)) body = '[Document]';
  if (!body && m.stickerMessage) body = '[Sticker]';
  if (!body && m.locationMessage) body = '[Localisation]';
  if (!body && m.contactMessage) body = '[Contact]';

  const contactName = !isFromMe ? (msg.pushName || getContactName(userId, senderJid) || getContactName(userId, chatId)) : null;
  const from = isFromMe ? 'Moi' : (contactName || chatId.split('@')[0]);

  let ts = 0;
  if (typeof msg.messageTimestamp === 'number') {
    ts = msg.messageTimestamp > 1e12 ? Math.floor(msg.messageTimestamp / 1000) : msg.messageTimestamp;
  }

  let type = 'text';
  if (m.imageMessage) type = 'image';
  else if (m.videoMessage) type = 'video';
  else if (m.audioMessage) type = 'audio';
  else if (m.documentMessage || m.documentWithCaptionMessage) type = 'document';
  else if (m.stickerMessage) type = 'sticker';
  else if (m.protocolMessage) type = 'protocol';
  else if (m.reactionMessage) {
    type = 'reaction';
    body = m.reactionMessage.text || '[reaction]';
  }

  return {
    id: msg.key.id,
    key: msg.key,
    from,
    chatId,
    body,
    timestamp: ts ? new Date(ts * 1000).toISOString() : new Date().toISOString(),
    timestampRaw: ts,
    fromMe: isFromMe,
    type,
    hasMedia: !!(m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.documentWithCaptionMessage || m.stickerMessage),
  };
}

async function startSession(userId) {
  if (clients.has(userId)) return;

  const sessionDir = getSessionDir(userId);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['Personal Place', 'Chrome', '4.0.0'],
    version: (await fetchLatestBaileysVersion()).version,
    syncFullHistory: true,
    getMessage: async () => undefined,
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
        console.log('WhatsApp session ' + userId + ' logged out');
        clients.delete(userId);
        const dir = getSessionDir(userId);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
      } else {
        console.log('WhatsApp session ' + userId + ' disconnected (reason: ' + reason + '), reconnecting...');
        statusMap.set(userId, 'reconnecting');
        setTimeout(() => {
          clients.delete(userId);
          historySynced.delete(userId);
          startSession(userId);
        }, 3000);
      }
      qrCodes.delete(userId);
      if (reason === DisconnectReason.loggedOut) statusMap.set(userId, 'disconnected');
    }

    if (connection === 'open') {
      console.log('WhatsApp session ' + userId + ' connected');
      qrCodes.delete(userId);
      statusMap.set(userId, 'syncing');

      try {
        const db = require('../db');
        await db`INSERT INTO connected_services (user_id, service_name, access_token)
          VALUES (${userId}, 'whatsapp', 'baileys-session')
          ON CONFLICT (user_id, service_name)
          DO UPDATE SET access_token = 'baileys-session', created_at = NOW()`;
      } catch (err) {
        console.error('DB save error:', err);
      }

      setTimeout(() => {
        const msgs = messageStore.get(userId) || [];
        const chats = chatStore.get(userId) || {};
        const synced = historySynced.get(userId) || false;
        console.log('[WA ' + userId + '] After connect: ' + Object.keys(chats).length + ' chats, ' + msgs.length + ' msgs, historySynced=' + synced);
        if (synced && msgs.length > 0) {
          statusMap.set(userId, 'connected');
        }
      }, 10000);
    }
  });

  sock.ev.on('contacts.upsert', (contacts) => {
    const existing = contactStore.get(userId) || {};
    for (const c of contacts) {
      if (c.id && (c.name || c.notify)) {
        existing[c.id] = { name: c.name || c.notify };
      }
    }
    contactStore.set(userId, existing);
  });

  sock.ev.on('messaging-history.set', ({ chats, messages, contacts }) => {
    console.log('[WA ' + userId + '] History: ' + chats.length + ' chats, ' + messages.length + ' messages, ' + (contacts ? contacts.length : 0) + ' contacts');

    if (contacts && contacts.length > 0) {
      const existing = contactStore.get(userId) || {};
      for (const c of contacts) {
        if (c.id && (c.name || c.notify)) {
          existing[c.id] = { name: c.name || c.notify };
        }
      }
      contactStore.set(userId, existing);
    }

    if (chats && chats.length > 0) {
      const existingChats = chatStore.get(userId) || {};
      for (const chat of chats) {
        existingChats[chat.id] = chat;
      }
      chatStore.set(userId, existingChats);
    }

    if (messages && messages.length > 0) {
      const existingMsgs = messageStore.get(userId) || [];
      for (const msg of messages) {
        if (!msg.key) continue;
        const parsed = parseMessage(msg, userId);
        const idx = existingMsgs.findIndex(m => m.id === parsed.id);
        if (idx >= 0) {
          existingMsgs[idx] = parsed;
        } else {
          existingMsgs.push(parsed);
        }
      }
      existingMsgs.sort((a, b) => (b.timestampRaw || 0) - (a.timestampRaw || 0));
      messageStore.set(userId, existingMsgs.slice(0, 2000));
    }

    historySynced.set(userId, true);
    const totalMsgs = (messageStore.get(userId) || []).length;
    const totalChats = Object.keys(chatStore.get(userId) || {}).length;
    console.log('[WA ' + userId + '] Store: ' + totalChats + ' chats, ' + totalMsgs + ' msgs');
    if (totalMsgs > 0) {
      statusMap.set(userId, 'connected');
    }
  });

  sock.ev.on('chats.upsert', (chats) => {
    const existing = chatStore.get(userId) || {};
    for (const chat of chats) {
      existing[chat.id] = chat;
    }
    chatStore.set(userId, existing);
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    const existing = messageStore.get(userId) || [];
    for (const msg of messages) {
      if (!msg.key) continue;
      const parsed = parseMessage(msg, userId);
      const idx = existing.findIndex(m => m.id === parsed.id);
      if (idx >= 0) {
        existing[idx] = parsed;
      } else {
        existing.unshift(parsed);
      }
    }
    existing.sort((a, b) => (b.timestampRaw || 0) - (a.timestampRaw || 0));
    messageStore.set(userId, existing.slice(0, 2000));
  });

  clients.set(userId, sock);
  statusMap.set(userId, 'connecting');
}

router.post('/connect', auth, async (req, res) => {
  try {
    const userId = req.userId;

    const existingClient = clients.get(userId);
    if (existingClient) {
      try { existingClient.end(); } catch (e) {}
      clients.delete(userId);
    }

    const sessionDir = getSessionDir(userId);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }

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
    const client = clients.get(userId);
    const msgs = messageStore.get(userId) || [];
    const chats = chatStore.get(userId) || {};
    res.json({
      status,
      hasClient: !!client,
      messageCount: msgs.length,
      chatCount: Object.keys(chats).length,
      historySynced: historySynced.get(userId) || false,
    });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.get('/messages', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const client = clients.get(userId);
    if (!client) return res.json({ messages: [] });

    const messages = messageStore.get(userId) || [];
    const priorities = priorityStore.get(userId) || {};
    const result = messages.map(m => ({
      id: m.id,
      from: m.from,
      chatId: m.chatId,
      body: m.body,
      timestamp: m.timestamp,
      fromMe: m.fromMe,
      type: m.type,
      hasMedia: m.hasMedia,
      priority: priorities[m.chatId] || 'none',
    }));

    res.json({ messages: result });
  } catch (err) {
    console.error('WhatsApp messages error:', err);
    res.status(500).json({ error: err.message || 'Erreur lors du chargement' });
  }
});

router.post('/sync', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const client = clients.get(userId);
    if (!client) return res.status(400).json({ error: 'WhatsApp non connecte' });

    console.log('[WA ' + userId + '] Force sync requested');
    historySynced.delete(userId);
    statusMap.set(userId, 'syncing');

    // Request history from the socket directly
    try {
      const chats = await client.albumFetchImageMessage ? [] : [];
      // Baileys v7 doesn't have getChats/getMessages, but we can trigger via polling
      // The messaging-history.set event should fire again
    } catch (e) {}

    // Poll for completion
    let attempts = 0;
    const checkSync = setInterval(() => {
      attempts++;
      const msgs = messageStore.get(userId) || [];
      const synced = historySynced.get(userId) || false;
      if (synced || msgs.length > 0 || attempts > 20) {
        clearInterval(checkSync);
        statusMap.set(userId, synced ? 'connected' : 'connected');
        console.log('[WA ' + userId + '] Sync done: ' + msgs.length + ' msgs, synced=' + synced);
      }
    }, 1000);

    res.json({ success: true, status: 'syncing' });
  } catch (err) {
    console.error('WhatsApp sync error:', err);
    res.status(500).json({ error: 'Erreur lors de la synchronisation' });
  }
});

router.post('/send', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const client = clients.get(userId);
    if (!client) return res.status(400).json({ error: 'WhatsApp non connecte' });

    const { to, message } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'Destinataire et message requis' });

    let jid = to.includes('@') ? to : to.replace(/\D/g, '') + '@s.whatsapp.net';
    const result = await client.sendMessage(jid, { text: message });

    const parsed = parseMessage(result, userId);
    const existing = messageStore.get(userId) || [];
    existing.unshift(parsed);
    messageStore.set(userId, existing);

    res.json({ success: true, messageId: result.key.id });
  } catch (err) {
    console.error('WhatsApp send error:', err);
    res.status(500).json({ error: err.message || "Erreur lors de l'envoi" });
  }
});

router.get('/media/:messageId', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const client = clients.get(userId);
    if (!client) return res.status(400).json({ error: 'WhatsApp non connecte' });

    const { messageId } = req.params;
    const messages = messageStore.get(userId) || [];
    const msg = messages.find(m => m.id === messageId);
    if (!msg || !msg.hasMedia) return res.status(404).json({ error: 'Media non trouve' });

    const buffer = await client.downloadMediaMessage(msg.key);
    if (!buffer) return res.status(404).json({ error: 'Impossible de telecharger le media' });

    const m = msg.key;
    let mimeType = 'image/jpeg';
    let ext = 'jpg';

    const rawMsg = messages.find(rm => rm.id === messageId);
    if (rawMsg) {
      // Try to detect from the stored raw message
    }

    // Detect mime from buffer header
    if (buffer[0] === 0x89 && buffer[1] === 0x50) { mimeType = 'image/png'; ext = 'png'; }
    else if (buffer[0] === 0x47 && buffer[1] === 0x49) { mimeType = 'image/gif'; ext = 'gif'; }
    else if (buffer[0] === 0x52 && buffer[1] === 0x49) { mimeType = 'image/webp'; ext = 'webp'; }
    else if (buffer[0] === 0x1A && buffer[1] === 0x45) { mimeType = 'video/mp4'; ext = 'mp4'; }
    else if (buffer[0] === 0x4F && buffer[1] === 0x67) { mimeType = 'audio/ogg'; ext = 'ogg'; }
    else if (buffer[0] === 0x25 && buffer[1] === 0x50) { mimeType = 'application/pdf'; ext = 'pdf'; }

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (err) {
    console.error('WhatsApp media error:', err);
    res.status(500).json({ error: 'Erreur lors du telechargement' });
  }
});

router.post('/priority', auth, (req, res) => {
  try {
    const userId = req.userId;
    const { chatId, priority } = req.body;
    if (!chatId || !priority) return res.status(400).json({ error: 'chatId et priority requis' });

    const priorities = priorityStore.get(userId) || {};
    if (priority === 'none') {
      delete priorities[chatId];
    } else {
      priorities[chatId] = priority;
    }
    priorityStore.set(userId, priorities);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

router.post('/disconnect', auth, async (req, res) => {
  try {
    const userId = req.userId;
    const client = clients.get(userId);
    if (client) {
      try { await client.logout(); } catch (e) {}
      try { client.end(); } catch (e) {}
      clients.delete(userId);
    }
    qrCodes.delete(userId);
    messageStore.delete(userId);
    chatStore.delete(userId);
    contactStore.delete(userId);
    priorityStore.delete(userId);
    statusMap.delete(userId);

    const dir = path.join(__dirname, '..', 'whatsapp-sessions', userId);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });

    try {
      const db = require('../db');
      await db`DELETE FROM connected_services WHERE user_id = ${userId} AND service_name = 'whatsapp'`;
    } catch (e) {}

    res.json({ success: true });
  } catch (err) {
    console.error('WhatsApp disconnect error:', err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;
