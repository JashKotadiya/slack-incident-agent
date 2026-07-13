import pkg from '@slack/bolt';
const { App } = pkg;
import dotenv from 'dotenv';
import { getDiagnosticData } from './datadog-api.js';
import { summarizeAlert, chatWithAI } from './groq-ai.js';
import { createIncidentChannel, inviteUsersToChannel, postDebrief, dmUser } from './slack-actions.js';
import { getRecentHistory, addIncidentToHistory } from './history-store.js';
import { formatForSlack } from './slack-formatter.js';
import { createIncidentIssue, triggerRollbackWorkflow } from './github-actions.js';
import { startSyntheticMonitoring } from './synthetic-monitor.js';
import { createJiraTicket } from './jira-api.js';
import { exportToGoogleDoc } from './google-docs-api.js';
import { checkSnowflakeErrors } from './snowflake-api.js';

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

async function handleAlert(alertName, say, client, service = 'webapp', diagnosticOverride = null) {
  try {
    const currentErrorId = incidentCounter++;
    await say(`🚨 *Error ${currentErrorId} Received:* ${alertName}. \nGathering diagnostic data and spinning up an incident response...`);

    const diagnosticData = diagnosticOverride || await getDiagnosticData(service);
    await say(`🧠 Diagnostic data retrieved from ${diagnosticData.source}. Analyzing with Groq AI...`);
    
    // Only pass the last 1 incident to prevent Groq 8000 TPM limit errors!
    const historyContext = await getRecentHistory(1);
    const aiResponse = await summarizeAlert(diagnosticData, historyContext);
    let autoFixNote = "";
    if (aiResponse.autoFixAction === 'trigger_rollback') {
      autoFixNote = `\n\n🤖 *Recommendation:*\nI strongly recommend rolling back to the previous stable deployment. Want me to trigger a rollback? (Click the button below!)`;
    } else if (aiResponse.autoFixAction === 'create_issue') {
      autoFixNote = `\n\n🤖 *Recommendation:*\nI recommend creating a GitHub Issue to track this non-critical bug.`;
    }

    let emoji = "🚨";
    let title = "Urgent System Alert";
    if (aiResponse.severity === "LOW" || aiResponse.severity === "MEDIUM") {
      emoji = aiResponse.severity === "LOW" ? "ℹ️" : "⚠️";
      title = "System Notice";
    } else if (aiResponse.severity === "HIGH") {
      emoji = "🚨";
      title = "Urgent System Alert";
    } else if (aiResponse.severity === "CRITICAL") {
      emoji = "🚨";
      title = "CRITICAL OUTAGE";
    }

    const finalSummary = `${emoji} *Error ${currentErrorId} - Incident Debrief*\n\n${aiResponse.summary + autoFixNote}`;
    
    await addIncidentToHistory(finalSummary);
    
    const formattedSummary = formatForSlack(aiResponse.summary + autoFixNote);
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
            text: "📖 View Runbook SOP",
            emoji: true
          },
          action_id: "view_company_runbook"
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

    actionElements.push({
      type: "button",
      text: { type: "plain_text", text: "📝 Export to Google Docs", emoji: true },
      value: "export_summary",
      action_id: "export_google_doc"
    });

    blocks.push({
      type: "actions",
      elements: actionElements
    });

    await postDebrief(client, '#errors', finalSummary, blocks);
    await say(`✅ Incident response initialized. Please check the #errors channel for the debrief and ongoing discussion.`);

    if (aiResponse.severity === "HIGH" || aiResponse.severity === "CRITICAL") {
      await postDebrief(client, '#announcements', `<!channel> ${emoji} *A ${aiResponse.severity.toLowerCase()} system alert has been detected!* Check the #errors channel for more details.`);
    }

    if (aiResponse.severity === "HIGH" || aiResponse.severity === "CRITICAL") {
      const dmMessage = `${emoji} *A critical system alert has been detected!* Check the #errors channel for more details.`;
      if (securityTeamUserIds && securityTeamUserIds.length > 0) {
        for (const userId of securityTeamUserIds) {
          if (userId) await dmUser(client, userId, dmMessage);
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

  const alertRegex = /\b(run system check|simulate outage|check for errors|check for erro)(?:\s+(?:(?:on|in)\s+)?(frontend|backend|webapp-frontend|webapp|snowflake))?\b/i;
  const dmRegex = /(?:dm|send a dm to|message)\s+<@([A-Z0-9]+)>\s*(.*)/i;
  
  const alertMatch = text.match(alertRegex);
  const dmMatch = text.match(dmRegex);

  if (alertMatch) {
    let service = 'webapp'; // default
    if (alertMatch[2]) {
      const target = alertMatch[2].toLowerCase();
      if (target === 'frontend' || target === 'webapp-frontend') service = 'webapp-frontend';
      else if (target === 'backend' || target === 'webapp') service = 'webapp';
      else if (target === 'snowflake') service = 'snowflake';
    }
    
    if (service === 'snowflake') {
      const mockSay = async (msg) => { await say(msg); };
      const diagnosticData = await checkSnowflakeErrors();
      
      if (diagnosticData.status === 'OK') {
        await say(`✅ System Check (Snowflake): ${diagnosticData.logs}`);
      } else {
        await handleAlert(`System Check (Snowflake)`, mockSay, client, 'snowflake', diagnosticData);
      }
    } else {
      await handleAlert(`System Check (${service})`, say, client, service);
    }
  } else if (dmMatch) {
    const targetUserId = dmMatch[1];
    const messageToForward = dmMatch[2] || "You have a new message from the incident agent.";
    await dmUser(client, targetUserId, `💬 *Message from <@${event.user}>:*\n\n${messageToForward}`);
    await say(`✅ I've forwarded your direct message to <@${targetUserId}>!`);
  } else {
    // Conversational AI with Slack RAG
    const transcript = await fetchSlackHistory(event, client);
    let response = await chatWithAI(contextualText, conversationId, transcript);
    
    // Check if the AI wants to trigger a DM
    const aiDmMatch = response.match(/^\[DM:\s*([A-Z0-9]+)\]\s*(.*)/is);
    if (aiDmMatch) {
      const targetUserId = aiDmMatch[1];
      const messageToForward = aiDmMatch[2];
      await dmUser(client, targetUserId, `💬 *Message from <@${event.user}>:*\n\n${messageToForward}`);
      response = `✅ I've forwarded the message to <@${targetUserId}>!`;
    }
    
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
app.action('view_company_runbook', async ({ ack, say, body }) => {
  await ack();
  await say({
    text: "📖 Fetching GlobalCorp Runbook SOP...",
    thread_ts: body.message.ts
  });
  
  const repo = process.env.GITHUB_REPO || 'JashKotadiya/slack-incident-agent';
  const url = `https://github.com/${repo}/blob/main/runbooks/SOP.md`;
  
  const summary = `*GlobalCorp Incident Protocol - Level 1*\n\n1. *Acknowledge* the alert in this thread.\n2. *Review* Datadog Logs.\n3. *Trigger Rollback* if the incident was caused by a recent deployment.\n4. *Create Jira Ticket* for post-mortem tracking.\n\n🔗 <${url}|Click here to read the full Standard Operating Procedure (SOP)>`;

  await new Promise(r => setTimeout(r, 1000));
  await say({
    text: summary,
    thread_ts: body.message.ts
  });
});

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
  
  // Extract a brief description from the Slack message we are replying to
  const originalMessageText = body.message.text || "Incident detected.";
  const summaryText = "Incident Report: " + originalMessageText.substring(0, 50).replace(/[^a-zA-Z0-9 ]/g, '') + "...";
  
  const result = await createJiraTicket(summaryText, originalMessageText);
  
  if (result.success) {
    await say({
      text: `✅ *${result.message}*\nView the ticket on Jira: <${result.url}|${result.url}>`,
      thread_ts: body.message.ts
    });
  } else {
    await say({
      text: `❌ *Failed to create Jira ticket:*\n${result.message}`,
      thread_ts: body.message.ts
    });
  }
});

app.action('export_google_doc', async ({ ack, say, body, action }) => {
  await ack();
  await say({
    text: "📝 Authenticating with Google Cloud Platform and creating your Incident Report...",
    thread_ts: body.message.ts
  });
  
  try {
    // Extract summary from the message blocks instead of button value to avoid 2000 char limits
    let summaryText = "";
    if (body.message && body.message.blocks) {
      for (const block of body.message.blocks) {
        if (block.type === "section" && block.text && block.text.type === "mrkdwn") {
          summaryText += block.text.text + "\n";
        }
      }
    }
    
    const userEmail = process.env.JIRA_EMAIL; // Re-using this email for Google Docs sharing
    
    const docUrl = await exportToGoogleDoc("Automated Alert", summaryText, userEmail);
    
    await say({
      text: `✅ **Success!** Incident Summary exported to Google Docs. It has been shared with \`${userEmail}\`.\n\n🔗 ${docUrl}`,
      thread_ts: body.message.ts
    });
  } catch (error) {
    console.error("Google Docs Export Failed:", error);
    await say({
      text: `❌ **Failed to export to Google Docs.**\n\`\`\`${error.message}\`\`\`\n_Did you provide the Service Account JSON key in GOOGLE_APPLICATION_CREDENTIALS?_`,
      thread_ts: body.message.ts
    });
  }
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
  'webapp-frontend': '',
  'snowflake': ''
};

async function pollForErrors() {
  const services = ['webapp', 'webapp-frontend', 'snowflake'];
  
  for (const service of services) {
    try {
      const diagnosticData = service === 'snowflake' ? await checkSnowflakeErrors() : await getDiagnosticData(service);
      
      if (diagnosticData.status === 'CRITICAL' || diagnosticData.status === 'ERROR') {
        if (diagnosticData.logs !== lastSeenLogs[service] && !diagnosticData.logs.includes('No recent error logs')) {
          console.log(`[Autonomous Agent] Detected new error in ${service}. Spinning up incident response!`);
          
          lastSeenLogs[service] = diagnosticData.logs; 
          
          const mockSay = async (text) => { 
            await app.client.chat.postMessage({ channel: 'errors', text: text }); 
          };
          
          await handleAlert(`Autonomous Detection: ${service} Error`, mockSay, app.client, service, diagnosticData);
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

  // Autonomous Error Detection: Poll every 30 seconds so we don't blow through all 4 API keys!
  setInterval(pollForErrors, 30000);

  // Instant Uptime Detection: WebSocket Monitor
  startSyntheticMonitoring(async (service, errorMessage) => {
    const mockSay = async (text) => { 
      await app.client.chat.postMessage({ channel: 'errors', text: text }); 
    };
    
    // We pass fakeData as an override since Datadog can't see dead servers
    const fakeData = {
      source: "Synthetic Monitor (WebSocket)",
      status: "CRITICAL",
      timestamp: new Date().toISOString(),
      logs: errorMessage
    };
    
    await handleAlert(`Uptime Check Failed: ${service}`, mockSay, app.client, service, fakeData);
  });
})();
