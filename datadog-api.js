import { client, v2 } from '@datadog/datadog-api-client';
import dotenv from 'dotenv';
dotenv.config();

const configuration = client.createConfiguration();
configuration.setServerVariables({
  site: process.env.DD_SITE || 'datadoghq.com'
});
const apiInstance = new v2.LogsApi(configuration);

export async function getDiagnosticData(serviceName = 'webapp') {
  try {
    const params = {
      body: {
        filter: {
          query: `service:${serviceName} status:error`,
          indexes: ['main'],
          from: 'now-15m',
          to: 'now',
        },
        sort: '-timestamp',
        page: {
          limit: 10,
        },
      },
    };

    const response = await apiInstance.listLogs(params);
    
    if (!response.data || response.data.length === 0) {
      return {
        source: 'Datadog',
        status: 'UNKNOWN',
        timestamp: new Date().toISOString(),
        logs: 'No recent error logs found in Datadog.'
      };
    }

    const logs = response.data.map(log => {
      return `[ERROR] ${log.attributes.timestamp} - ${log.attributes.message}`;
    }).join('\n');

    return {
      source: 'Datadog',
      status: 'CRITICAL',
      timestamp: new Date().toISOString(),
      logs: logs
    };
  } catch (error) {
    console.error("Error fetching logs from Datadog:", error);
    return {
      source: 'Datadog',
      status: error.message.includes('429') || error.code === 429 ? 'RATE_LIMIT' : 'ERROR',
      timestamp: new Date().toISOString(),
      logs: `Failed to fetch logs from Datadog: ${error.message}`
    };
  }
}
