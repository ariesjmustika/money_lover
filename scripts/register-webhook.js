const https = require('https');
require('dotenv').config({ path: '.env.local' });

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const WEBHOOK_URL = process.argv[2]; // Passed as argument, e.g., https://your-ngrok-url.ngrok-free.app/api/bot

if (!TOKEN) {
  console.error('Error: TELEGRAM_BOT_TOKEN is not set in .env.local');
  process.exit(1);
}

if (!WEBHOOK_URL) {
  console.error('Error: Please provide your webhook URL as an argument.');
  console.error('Example: node scripts/register-webhook.js https://my-ngrok-url.ngrok-free.app/api/bot');
  process.exit(1);
}

const url = `https://api.telegram.org/bot${TOKEN}/setWebhook?url=${WEBHOOK_URL}`;

https.get(url, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    console.log('Response from Telegram:');
    console.log(JSON.parse(data));
  });
}).on('error', (err) => {
  console.error('Error:', err.message);
});
