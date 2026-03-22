// filters/mailFilter.js

/**
 * Converts a parsed email object into a standard message format
 * similar to the WhatsApp message schema.
 * 
 * @param {object} parsedEmail - The parsed email object from mailparser
 * @returns {object} standardized message
 */
export function filterEmailToStandardMessage(parsedEmail) {
    return {
      sender: parsedEmail.from?.value?.[0]?.address || 'unknown',
      messageContent: parsedEmail.text || parsedEmail.html || '',
      timestamp: parsedEmail.date || new Date(),
      messageId: parsedEmail.messageId || `email-${Date.now()}`,
      messageType: 'email',
      media: null,
      replied: false
    };
  }
