import Groq from 'groq-sdk';
import dotenv from 'dotenv';
dotenv.config();

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

export async function summarizeAlert(diagnosticData, historyContext = []) {
  try {
    const prompt = `
You are a highly skilled DevOps and Security Assistant.
We have received a system alert. Below is the diagnostic data we collected from our monitoring tools.

Diagnostic Data:
Source: ${diagnosticData.source}
Status: ${diagnosticData.status}
Timestamp: ${diagnosticData.timestamp}
Logs:
${diagnosticData.logs}

${diagnosticData.metrics ? `Metrics:\n${JSON.stringify(diagnosticData.metrics, null, 2)}` : ''}

Please provide:
1. A brief, plain English summary of what went wrong (1-2 sentences).
2. Suggested immediate remediation steps based on the logs.
3. Are there any security concerns we should be aware of?

Format the response nicely so it can be sent as a Slack message. Use Slack markdown (e.g. *bold* instead of **bold**).
`;

    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: `You are an expert site reliability engineer. Summarize the following system alert and diagnostic data. 
          
          If there are multiple different types of errors in the logs, explicitly identify and mention all of them. Provide a quick root cause analysis for each, recommend immediate next steps, and explicitly list **Suggested Fixes** (including actual code snippets, configuration changes, or terminal commands) for each distinct error type. Keep it concise but highly actionable.
          
          IMPORTANT: You MUST respond in valid JSON format. The JSON must exactly match this structure:
          {
            "severity": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
            "summary": "Your detailed markdown debrief string here",
            "autoFixAction": "trigger_rollback" | "create_issue" | "none"
          }

          For "autoFixAction", recommend "trigger_rollback" if the issue seems to be caused by a recent deployment or high severity crash. Recommend "create_issue" for non-critical bugs. Otherwise, use "none".
          
          Determine severity based on:
          - CRITICAL: App is fully down, database unreachable, out of memory loop.
          - HIGH: Degraded performance, major features failing.
          - MEDIUM: Elevated error rates, single pod issues.
          - LOW: Minor warnings, easily recoverable errors.` +
                   (historyContext.length > 0 ? "\n\nIMPORTANT: Here is the recent incident history:\n" + JSON.stringify(historyContext) + "\nIf you see an error that has occurred recently and you have already suggested fixes for it in the history, DO NOT suggest those exact same fixes again. Acknowledge that the issue is recurring despite previous fixes, and suggest DIFFERENT, escalated, or alternative fixes." : "")
        },
        {
          role: "user",
          content: JSON.stringify(diagnosticData)
        }
      ],
      model: "openai/gpt-oss-20b",
      max_tokens: 2048,
    });

    let responseContent = chatCompletion.choices[0]?.message?.content || "{}";
    
    // Extract JSON in case the model adds markdown formatting
    const jsonMatch = responseContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      responseContent = jsonMatch[0];
    }

    const parsed = JSON.parse(responseContent);
    return {
      severity: parsed.severity || "HIGH",
      summary: parsed.summary || "Could not generate summary.",
      autoFixAction: parsed.autoFixAction || "none"
    };
  } catch (error) {
    console.error("Error calling Groq API:", error);
    return { severity: "HIGH", summary: "Error generating summary with AI.", autoFixAction: "none" };
  }
}

const chatMemory = new Map();

export async function chatWithAI(userMessage, conversationId = 'default', slackTranscript = '') {
  try {
    if (!chatMemory.has(conversationId)) {
      chatMemory.set(conversationId, [
        {
          role: "system",
          content: "You are a helpful and highly skilled AI DevOps assistant in a Slack workspace. Reply conversationally to the user. \n\nIMPORTANT FORMATTING RULES:\n- Use Slack mrkdwn formatting ONLY.\n- Use single asterisks for *bold* (NOT **bold**).\n- DO NOT use markdown tables.\n- DO NOT use any HTML tags like <br>.\n- Use bulleted lists instead of tables for structured data."
        }
      ]);
    }

    const messages = chatMemory.get(conversationId);
    
    // Inject the latest slack transcript as context before the user's message
    const contextualMessage = slackTranscript 
      ? `Here is the recent message history from this Slack channel/thread:\n\n${slackTranscript}\n\nPlease answer my following request using the context above:\n${userMessage}`
      : userMessage;

    messages.push({ role: "user", content: contextualMessage });

    // Keep memory bounded to last 10 messages + system prompt
    if (messages.length > 11) {
      messages.splice(1, 1);
    }

    const chatCompletion = await groq.chat.completions.create({
      messages: messages,
      model: "openai/gpt-oss-20b",
      max_tokens: 2048,
    });

    const response = chatCompletion.choices[0]?.message?.content || "Sorry, I couldn't process that.";
    messages.push({ role: "assistant", content: response });
    
    return response;
  } catch (error) {
    console.error("Error calling Groq API for chat:", error);
    return "Sorry, I am having trouble connecting to my AI brain.";
  }
}

export async function summarizeSlackMessages(transcript) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant. Please read the following Slack conversation transcript and provide a concise, well-formatted summary of the key points, decisions made, and any action items."
        },
        {
          role: "user",
          content: transcript
        }
      ],
      model: "openai/gpt-oss-20b",
      max_tokens: 2048,
    });
    return chatCompletion.choices[0]?.message?.content || "Could not generate summary.";
  } catch (error) {
    console.error("Error calling Groq API for summary:", error);
    return "Error summarizing messages.";
  }
}
