# 🛡️ GlobalCorp Standard Operating Procedure (SOP)

**Incident Protocol:** Level 1 - Critical Web Outages

If the Slack Incident Agent detects a `CRITICAL` outage, all on-call engineers MUST adhere to the following protocol:

## 1. Triage & Assessment
1. **Acknowledge the Alert:** Immediately reply in the Slack thread to confirm you are investigating.
2. **Review Datadog Logs:** Click "View Datadog Logs" to inspect the raw stack trace.
3. **Verify Scope:** Determine if the error is localized to a specific region or affecting global users.

## 2. Immediate Mitigation (Auto-Rollbacks)
If the incident was caused by a recent code deployment (within the last 2 hours):
1. **Trigger Rollback:** Click the `Deploy Rollback (GitHub)` button in the Slack thread.
2. **Monitor Recovery:** Wait 3 minutes and verify the synthetic monitor reports `status: success`.
3. If rollback fails, manually revert the traffic via the AWS Load Balancer console.

## 3. Post-Mortem & Patching
1. **Create Tracking Ticket:** Click the `Create Jira Ticket` button to automatically document the incident.
2. **Develop Patch:** Assign a developer to analyze the AI's "Alternative Fixes" and deploy a hotfix within 24 hours.
3. **Update Runbook:** If a new failure mode was discovered, document it in this file.
