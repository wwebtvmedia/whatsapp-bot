// filters/whatsappFilter.js

/**
 * Converts a raw WhatsApp message into a standardized format
 * consistent with the unified message schema.
 *
 * @param {object} msg - Raw WhatsApp message from Baileys
 * @returns {object|null} Standardized message or null if invalid
 */
export function filterWhatsappMessage(msg) {
    if (!msg.message || msg.key.remoteJid.endsWith('@bot') || msg.key.remoteJid.endsWith('@g.us')) {
      return null;
    }
  
    const jid = msg.key.remoteJid;
    const timestamp = msg.messageTimestamp;
    const messageId = msg.key.id;
  
    const messageContent =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text ||
      msg.message.imageMessage?.caption ||
      msg.message.videoMessage?.caption ||
      msg.message.documentMessage?.caption ||
      'No text';
  
    const messageType = Object.keys(msg.message).find(key =>
      ['imageMessage', 'videoMessage', 'documentMessage', 'audioMessage', 'stickerMessage'].includes(key)
    ) || 'text';
  
    return {
      sender: jid,
      messageContent,
      timestamp: new Date(Number(timestamp) * 1000),
      messageId,
      messageType,
      media: null,
      replied: false,
    };
  }
