import dotenv from 'dotenv';
dotenv.config();

export async function createJiraTicket(summary, description) {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const domain = process.env.JIRA_DOMAIN;
  const projectKey = process.env.JIRA_PROJECT_KEY;

  if (!email || !token || !domain || !projectKey) {
    return { success: false, message: "Jira variables not set in .env" };
  }

  // Remove trailing slash from domain if present
  const baseUrl = domain.endsWith('/') ? domain.slice(0, -1) : domain;
  const endpoint = `${baseUrl}/rest/api/2/issue`;
  
  const authHeader = `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`;

  // Simple Slack Markdown -> Jira Wiki Markup converter
  let jiraDescription = description
    .replace(/```([\s\S]*?)```/g, '{code}\n$1\n{code}') // Code blocks
    .replace(/`([^`]+)`/g, '{{$1}}')                   // Inline code
    .replace(/\n/g, '\n\n')                            // Double newlines for Jira paragraphing
    .replace(/\n\n\n\n/g, '\n\n');                     // Cleanup excessive newlines

  const body = {
    fields: {
      project: { key: projectKey },
      summary: summary,
      description: jiraDescription,
      issuetype: { name: "Task" }
    }
  };

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const data = await response.json();

    if (response.ok) {
      console.log(`[Jira] Successfully created ticket ${data.key}`);
      return { 
        success: true, 
        message: `Ticket ${data.key} Created!`, 
        url: `${baseUrl}/browse/${data.key}` 
      };
    } else {
      console.error("[Jira] Failed to create ticket:", data);
      return { success: false, message: data.errorMessages ? data.errorMessages.join(", ") : JSON.stringify(data) };
    }
  } catch (error) {
    console.error("[Jira Error]:", error);
    return { success: false, message: error.message };
  }
}
