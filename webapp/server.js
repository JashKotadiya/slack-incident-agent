import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// We share the same .env file from the parent directory for simplicity
dotenv.config({ path: '../.env' });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Helper to send logs directly to Datadog API (No agent required)
async function sendToDatadog(message, level = 'error') {
  const apiKey = process.env.DD_API_KEY;
  if (!apiKey) {
    console.error("DD_API_KEY is missing! Cannot send log to Datadog.");
    return;
  }

  const payload = [{
    ddsource: "nodejs",
    ddtags: "env:hackathon,version:1.0",
    hostname: "vulnerable-web-server",
    message: message,
    service: "webapp",
    status: level
  }];

  try {
    const ddSite = process.env.DD_SITE || 'datadoghq.com';
    const intakeUrl = `https://http-intake.logs.${ddSite}/api/v2/logs`;
    await fetch(intakeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'DD-API-KEY': apiKey
      },
      body: JSON.stringify(payload)
    });
    console.log(`Log sent to Datadog: [${level}] ${message}`);
  } catch (error) {
    console.error("Failed to send log to Datadog:", error);
  }
}

app.post('/api/crash', async (req, res) => {
  console.log("Crash requested!");
  
  const fakeErrors = [
    `FATAL ERROR: Memory Out Of Bounds\n    at Server.handleRequest (/app/webapp/server.js:45:12)\nCaused by: ConnectionTimeoutError: Failed to reach database at db-cluster-01.internal`,
    `ERROR 503: Redis connection refused\n    at CachePlugin.connect (/app/node_modules/redis/client.js:22:1)\nCaused by: Socket error: ETIMEDOUT 10.1.2.45:6379`,
    `PaymentGatewayError: 429 Too Many Requests\n    at StripeClient.charge (/app/payments/stripe.js:101:9)\n    at CheckoutSession.process (/app/webapp/checkout.js:33:14)\nMessage: Exceeded rate limit for API key.`,
    `OutOfMemoryError: V8 heap exhausted\n    at Array.map (<anonymous>)\n    at processLargeDataset (/app/jobs/data-export.js:88:21)`
  ];
  const fakeErrorTrace = fakeErrors[Math.floor(Math.random() * fakeErrors.length)];

  // Send the error to Datadog
  await sendToDatadog(fakeErrorTrace, 'error');

  // Return a 500 error to the frontend
  res.status(500).json({ error: 'Internal Server Error', message: 'The server has crashed.' });
});

const PORT = 8080;
app.listen(PORT, () => {
  console.log(`Vulnerable Web App running at http://localhost:${PORT}`);
  console.log(`Ready to send crash logs to Datadog!`);
});
