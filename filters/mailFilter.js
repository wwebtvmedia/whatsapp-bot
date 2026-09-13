// filters/mailFilter.js

// Emails without a plain-text part would otherwise push raw HTML into memory
const stripHtml = (html) => html
  ? html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  : '';

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
      messageContent: parsedEmail.text || stripHtml(parsedEmail.html) || '',
      timestamp: parsedEmail.date || new Date(),
      messageId: parsedEmail.messageId || `email-${Date.now()}`,
      messageType: 'email',
      media: null,
      replied: false
    };
  }
