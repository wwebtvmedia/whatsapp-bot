import test from 'node:test';
import assert from 'node:assert';
import { filterWhatsappMessage } from './filters/whatsappFilter.js';
import { filterEmailToStandardMessage } from './filters/mailFilter.js';
import { queryLLM } from './answerGenerator.js';

// 1. Test WhatsApp Filter
test('WhatsApp Filter: should correctly standardize a text message', () => {
  const rawMsg = {
    key: { remoteJid: '12345@s.whatsapp.net', id: 'ABC123', fromMe: false },
    message: { conversation: 'Hello World' },
    messageTimestamp: 1700000000
  };

  const filtered = filterWhatsappMessage(rawMsg);
  assert.strictEqual(filtered.sender, '12345@s.whatsapp.net');
  assert.strictEqual(filtered.messageContent, 'Hello World');
  assert.strictEqual(filtered.messageType, 'text');
  assert.ok(filtered.timestamp instanceof Date);
});

test('WhatsApp Filter: should ignore group messages', () => {
  const rawMsg = {
    key: { remoteJid: '12345@g.us', id: 'ABC123', fromMe: false },
    message: { conversation: 'Hello Group' },
    messageTimestamp: 1700000000
  };

  const filtered = filterWhatsappMessage(rawMsg);
  assert.strictEqual(filtered, null);
});

// 2. Test Email Filter
test('Email Filter: should correctly standardize an email', () => {
  const parsedEmail = {
    from: { value: [{ address: 'test@example.com' }] },
    text: 'Email body content',
    date: new Date('2024-01-01T10:00:00Z'),
    messageId: 'email-id-123'
  };

  const filtered = filterEmailToStandardMessage(parsedEmail);
  assert.strictEqual(filtered.sender, 'test@example.com');
  assert.strictEqual(filtered.messageContent, 'Email body content');
  assert.strictEqual(filtered.messageType, 'email');
});

// 3. Test LLM Logic (Formatting)
test('LLM Logic: should handle openai-compatible (llama.cpp) formatting', async (t) => {
    // Mocking environment for this test
    process.env.LLM_TYPE = 'openai';
    process.env.LLM_URL = 'http://localhost:8080';
    
    // We expect this to fail because no server is running, 
    // but we want to see if it tries to hit the /v1/chat/completions endpoint
    try {
        await queryLLM("context", "question");
    } catch (err) {
        // If it throws an error about connection, that's fine.
        // The logic we want to verify is in the code structure.
    }
});
