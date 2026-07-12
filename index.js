import pkg from '@slack/bolt';
const { App } = pkg;
import dotenv from 'dotenv';
import { getDiagnosticData } from './datadog-api.js';
import { summarizeAlert, chatWithAI } from './groq-ai.js';
import { createIncidentChannel, inviteUsersToChannel, postDebrief, dmUser } from './slack-actions.js';
import { getRecentHistory, addIncidentToHistory } from './history-store.js';
import { formatForSlack } from './slack-formatter.js';
import { createIncidentIssue, triggerRollbackWorkflow } from './github-actions.js';

dotenv.config();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  socketMode: true,
  appToken: process.env.SLACK_APP_TOKEN,
  port: process.env.PORT || 3000,
  logLevel: 'DEBUG'
});

// We can configure security team members in .env
const securityTeamUserIds = process.env.SECURITY_TEAM_USER_IDS 
  ? process.env.SECURITY_TEAM_USER_IDS.split(',').map(id => id.trim()) 
  : [];

let incidentCounter = 1;
// Initialize counter from history
getRecentHistory(50).then(history => {
  incidentCounter = history.length + 1;
});

async function handleAlert(alertName, say, client, service = 'webapp') {
  try {
    const currentErrorId = incidentCounter++;
    await say(`🚨 *Error ${currentErrorId} Received:* ${alertName}. \nGathering diagnostic data and spinning up an incident response...`);

    const diagnosticData = await getDiagnosticData(service);
    await say(`🧠 Diagnostic data retrieved from ${diagnosticData.source}. Analyzing with Groq AI...`);
    
    // Only pass the last 1 incident to prevent Groq 8000 TPM limit errors!
    const historyContext = await getRecentHistory(1);
    const aiResponse = await summarizeAlert(diagnosticData, historyContext);
    const severity = aiResponse.severity;
    const summary = aiResponse.summary;

    let emoji = "🚨";
    let title = "Urgent System Alert";
    if (severity === "LOW" || severity === "MEDIUM") {
      emoji = severity === "LOW" ? "ℹ️" : "⚠️";
      title = "System Notice";
    } else if (severity === "HIGH") {
      emoji = "🚨";
      title = "Important System Alert";
    }

    const finalSummary = `${emoji} *Error ${currentErrorId} - Incident Debrief*\n\n${summary}`;
    
    await addIncidentToHistory(finalSummary);
    
    const formattedSummary = formatForSlack(summary);
    const summaryChunks = formattedSummary.match(/[\s\S]{1,2900}/g) || [formattedSummary];

    // Construct Block Kit Payload
    const blocks = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `${emoji} ${title} (Error ${currentErrorId})`,
          emoji: true
        }
      }
    ];

    for (const chunk of summaryChunks) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: chunk
        }
      });
    }

    blocks.push({
      type: "divider"
    });
    const actionElements = [
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "📊 View Datadog Logs",
            emoji: true
          },
          url: "https://app.datadoghq.com/logs",
          action_id: "btn_datadog"
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "🌐 View WebApp",
            emoji: true
          },
          url: "http://localhost:5173",
          action_id: "btn_website"
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "🧠 Suggest More Fixes",
            emoji: true
          },
          action_id: "suggest_more_fixes"
        },
        {
          type: "button",
          text: {
            type: "plain_text",
            text: "🎫 Create Jira Ticket",
            emoji: true
          },
          action_id: "create_jira_ticket"
        }
    ];

    if (aiResponse.autoFixAction === 'trigger_rollback') {
      actionElements.unshift({
        type: "button",
        text: { type: "plain_text", text: "🚀 Deploy Rollback (GitHub)", emoji: true },
        style: "danger",
        action_id: "github_trigger_rollback"
      });
    } else if (aiResponse.autoFixAction === 'create_issue') {
      actionElements.unshift({
        type: "button",
        text: { type: "plain_text", text: "🐛 Create GitHub Bug Issue", emoji: true },
        style: "primary",
        action_id: "github_create_issue"
      });
    }

    blocks.push({
      type: "actions",
      elements: actionElements
    });

    await postDebrief(client, 'errors', finalSummary, blocks);
    await say(`✅ Incident response initialized. Please check the #errors channel for the debrief and ongoing discussion.`);

    if (severity === "CRITICAL") {
      await postDebrief(client, 'announcements', `<!channel> ${emoji} *A critical system alert has been detected!* Check the #errors channel for more details.`);
    }

    if (severity === "HIGH" || severity === "CRITICAL") {
      if (securityTeamUserIds && securityTeamUserIds.length > 0) {
        for (const userId of securityTeamUserIds) {
          if (userId) await dmUser(client, userId, `${emoji} *${title} (Error ${currentErrorId}): ${alertName}*\n\n${finalSummary}`, blocks);
        }
      }
    }

  } catch (error) {
    console.error(error);
    await say(`❌ An error occurred while processing the alert: ${error.message}`);
  }
}

async function fetchSlackHistory(event, client) {
  try {
    let result;
    if (event.thread_ts) {
      result = await client.conversations.replies({
        channel: event.channel,
        ts: event.thread_ts,
        limit: 20
      });
    } else {
      result = await client.conversations.history({
        channel: event.channel,
        limit: 20
      });
    }
    
    if (result.messages && result.messages.length > 0) {
      let messages = result.messages;
      if (!event.thread_ts) {
         messages = messages.reverse();
      }
      return messages.map(m => `${m.bot_id ? 'Bot' : 'User'}: ${m.text}`).join('\n');
    }
  } catch (error) {
    console.error("Error fetching Slack history:", error);
  }
  return "";
}

async function processMessage(event, say, client, conversationId) {
  // Strip bot mention if it's at the start of the string
  let text = event.text.replace(/^<@[A-Z0-9]+>\s*/, '').trim();

  // Try to fetch the user's real name so the AI knows who it's talking to
  let userName = "User";
  if (event.user) {
    try {
      const userInfo = await client.users.info({ user: event.user });
      userName = userInfo.user.real_name || userInfo.user.name;
    } catch (e) {
      console.error("Could not fetch user info", e);
    }
  }

  // Prepend the user's name so the AI doesn't get confused by leftover mentions
  const contextualText = `[User ${userName} says]: ${text}`;

  const alertRegex = /\b(run system check|simulate outage|check for errors|check for erro)(?:\s+(?:on\s+)?(frontend|backend|webapp-frontend|webapp))?\b/i;
  
  const match = text.match(alertRegex);
  if (match) {
    let service = 'webapp'; // default
    if (match[2]) {
      const target = match[2].toLowerCase();
      if (target === 'frontend' || target === 'webapp-frontend') service = 'webapp-frontend';
      else if (target === 'backend' || target === 'webapp') service = 'webapp';
    }
    await handleAlert(`System Check (${service})`, say, client, service);
  } else {
    // Conversational AI with Slack RAG
    const transcript = await fetchSlackHistory(event, client);
    const response = await chatWithAI(contextualText, conversationId, transcript);
    await say(formatForSlack(response));
  }
}

app.message(async ({ message, say, client }) => {
  if (message.bot_id) return; // ignore other bots
  const conversationId = message.thread_ts || message.ts || message.channel;
  if (message.text) await processMessage(message, say, client, conversationId);
});

app.event('app_mention', async ({ event, say, client }) => {
  const conversationId = event.thread_ts || event.ts || event.channel;
  if (event.text) await processMessage(event, say, client, conversationId);
});

// Interactive Button Handlers
app.action('suggest_more_fixes', async ({ ack, say, body }) => {
  await ack();
  await say({
    text: "🧠 Thinking of additional fixes...",
    thread_ts: body.message.ts // Reply in a thread to the alert
  });
  // Simulate AI generating more fixes
  await new Promise(r => setTimeout(r, 2000));
  await say({
    text: "Here are some alternative strategies we could try:\n\n1. **Rate Limiting:** Increase the global rate limit threshold temporarily.\n2. **Rollback:** Roll back to the previous stable release from 2 hours ago.\n3. **Scale Up:** Provision 3 more backend instances to handle the load.",
    thread_ts: body.message.ts
  });
});

app.action('create_jira_ticket', async ({ ack, say, body }) => {
  await ack();
  await say({
    text: "🎫 Creating Jira Ticket...",
    thread_ts: body.message.ts
  });
  await new Promise(r => setTimeout(r, 1000));
  await say({
    text: "✅ *Ticket Created successfully!*\n*ID:* ENG-404\n*Assignee:* On-Call Engineer\n*Priority:* Highest",
    thread_ts: body.message.ts
  });
});

app.action('github_trigger_rollback', async ({ ack, say, body }) => {
  await ack();
  await say({
    text: "⏳ Triggering deployment rollback via GitHub Actions...",
    thread_ts: body.message.ts
  });
  const result = await triggerRollbackWorkflow();
  await say({
    text: result.success ? `✅ *${result.message}*\nView details: ${result.url}` : `❌ Failed to trigger rollback: ${result.message}`,
    thread_ts: body.message.ts
  });
});

app.action('github_create_issue', async ({ ack, say, body }) => {
  await ack();
  await say({
    text: "⏳ Creating GitHub Issue...",
    thread_ts: body.message.ts
  });
  const title = `Bug Report: Incident Auto-Created by Slack Agent`;
  const desc = `An incident was detected and summarized by Groq AI. Please investigate the logs.`;
  const result = await createIncidentIssue(title, desc);
  await say({
    text: result.success ? `✅ *${result.message}*\nView details: ${result.url}` : `❌ Failed to create issue: ${result.message}`,
    thread_ts: body.message.ts
  });
});

let lastSeenLogs = {
  'webapp': '',
  'webapp-frontend': ''
};

async function pollForErrors() {
  const services = ['webapp', 'webapp-frontend'];
  
  for (const service of services) {
    try {
      const diagnosticData = await getDiagnosticData(service);
      
      if (diagnosticData.status === 'CRITICAL' || diagnosticData.status === 'ERROR') {
        if (diagnosticData.logs !== lastSeenLogs[service] && !diagnosticData.logs.includes('No recent error logs')) {
          console.log(`[Autonomous Agent] Detected new error in ${service}. Spinning up incident response!`);
          
          lastSeenLogs[service] = diagnosticData.logs; 
          
          const mockSay = async (text) => { 
            await app.client.chat.postMessage({ channel: 'errors', text: text }); 
          };
          
          await handleAlert(`Autonomous Detection: ${service} Error`, mockSay, app.client, service);
        }
      }
    } catch (e) {
      console.error('Error polling Datadog:', e);
    }
  }
}

(async () => {
  // Start the app
  await app.start();
  console.log('⚡️ Slack Incident Agent is running!');

  // Autonomous Error Detection: Poll every 60 seconds
  setInterval(pollForErrors, 60000);
})();
