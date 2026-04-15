import { queryLLM } from './answerGenerator.js';

// Mocking some environment variables
process.env.LLM_URL = "http://localhost:8080/v1/chat/completions";
process.env.LLM_MODEL = "test-model";
process.env.LLM_TYPE = "openai";

async function testLLM() {
    console.log("🧪 Testing LLM integration (mocking response)...");
    
    // Since we can't actually call the server, we will just verify the logic
    // But I can try to call it and catch the error to see if it's formatted correctly
    try {
        const response = await queryLLM("This is a test context", "How are you?");
        console.log("LLM Response:", response);
    } catch (err) {
        console.log("LLM Call failed as expected (no server running):", err.message);
    }
}

async function testStandardization() {
    console.log("🧪 Testing Message Standardization...");
    const rawMsg = {
        key: { remoteJid: "12345@s.whatsapp.net", id: "msg123", fromMe: false },
        message: { conversation: "Hello bot" },
        messageTimestamp: 1670000000
    };
    
    // Mocking what server.js does
    const jid = rawMsg.key.remoteJid;
    const messageContent = rawMsg.message.conversation;
    const timestamp = new Date(Number(rawMsg.messageTimestamp) * 1000);
    
    console.log("Standardized:", { jid, messageContent, timestamp });
}

testLLM().then(() => testStandardization());
