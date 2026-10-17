const https = require('https');

// Let's test Groq message format
const apiKey = 'gsk_...'; // we can test the structure

console.log('Testing Groq pure-string message formatting requirement...');

const testMessages = [
  { role: 'system', content: 'You are an expert assistant.' },
  { role: 'user', content: 'Hello' }
];

console.log('Valid Groq payload format for text models (openai/gpt-oss-120b, qwen/qwen3.6-27b):');
console.log(JSON.stringify({
  model: 'qwen/qwen3.6-27b',
  messages: testMessages
}, null, 2));
