import { Octokit } from "@octokit/rest";
import dotenv from 'dotenv';
dotenv.config();

const token = process.env.GITHUB_TOKEN;
const repoFullName = process.env.GITHUB_REPO; // e.g. "username/repo"

const octokit = token ? new Octokit({ auth: token }) : null;

// Helper to check if real GitHub integration is configured
function isGithubConfigured() {
  return octokit !== null && repoFullName;
}

export async function createIncidentIssue(title, body) {
  if (!isGithubConfigured()) {
    console.log("[Mock] GitHub integration not configured. Simulating Issue creation...");
    await new Promise(r => setTimeout(r, 1500));
    return {
      success: true,
      url: "https://github.com/mock/repo/issues/1",
      message: "Mock Bug Issue created!"
    };
  }

  try {
    const [owner, repo] = repoFullName.split('/');
    const response = await octokit.rest.issues.create({
      owner,
      repo,
      title: title,
      body: body,
      labels: ["bug", "incident-agent"]
    });

    return {
      success: true,
      url: response.data.html_url,
      message: `Issue created successfully: ${response.data.html_url}`
    };
  } catch (error) {
    console.error("Error creating GitHub issue:", error);
    return { success: false, message: error.message };
  }
}

export async function triggerRollbackWorkflow() {
  if (!isGithubConfigured()) {
    console.log("[Mock] GitHub integration not configured. Simulating Workflow trigger...");
    await new Promise(r => setTimeout(r, 2000));
    return {
      success: true,
      url: "https://github.com/mock/repo/actions",
      message: "Mock Rollback Workflow triggered!"
    };
  }

  try {
    const [owner, repo] = repoFullName.split('/');
    // Assuming there's a workflow named 'rollback.yml' that triggers on workflow_dispatch
    await octokit.rest.actions.createWorkflowDispatch({
      owner,
      repo,
      workflow_id: 'rollback.yml', 
      ref: 'main'
    });

    return {
      success: true,
      url: `https://github.com/${repoFullName}/actions`,
      message: "Rollback workflow triggered successfully."
    };
  } catch (error) {
    console.error("Error triggering GitHub workflow:", error);
    return { success: false, message: error.message };
  }
}
