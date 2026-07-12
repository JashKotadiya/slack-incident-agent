import { client, v2 } from '@datadog/datadog-api-client';
import dotenv from 'dotenv';
dotenv.config();

const configuration = client.createConfiguration();
configuration.setServerVariables({
  site: process.env.DD_SITE || 'datadoghq.com'
});
const apiInstance = new v2.LogsApi(configuration);
const rumApi = new v2.RUMApi(configuration);

export async function getDiagnosticData(serviceName = 'webapp') {
  try {
    let logs = "";
    
    if (serviceName === 'webapp-frontend') {
      // Use RUM API for frontend runtime errors
      const response = await rumApi.searchRUMEvents({
        body: {
          filter: {
            query: '@type:error',
            from: 'now-15m',
            to: 'now'
          },
          page: { limit: 10 }
        }
      });
      
      if (!response.data || response.data.length === 0) {
        return {
          source: 'Datadog RUM',
          status: 'UNKNOWN',
          timestamp: new Date().toISOString(),
          logs: 'No recent error logs found in Datadog.'
        };
      }
      
      logs = response.data.map(event => {
        const err = event.attributes?.attributes?.error || {};
        const msg = err.message || 'Unknown RUM Error';
        const stack = err.stack ? `\n${err.stack}` : '';
        return `[ERROR] ${event.attributes?.timestamp || ''} - ${msg}${stack}`;
      }).join('\n\n');
      
    } else {
      // Use standard Logs API for backend errors
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
          source: 'Datadog Logs',
          status: 'UNKNOWN',
          timestamp: new Date().toISOString(),
          logs: 'No recent error logs found in Datadog.'
        };
      }

      logs = response.data.map(log => {
        return `[ERROR] ${log.attributes.timestamp} - ${log.attributes.message}`;
      }).join('\n');
    }

    return {
      source: serviceName === 'webapp-frontend' ? 'Datadog RUM' : 'Datadog Logs',
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
