export async function getDiagnosticData(serviceName) {
  // Simulate network delay
  await new Promise(resolve => setTimeout(resolve, 1000));

  if (serviceName.toLowerCase() === 'datadog') {
    return {
      source: 'Datadog Mock',
      status: 'CRITICAL',
      timestamp: new Date().toISOString(),
      logs: `
[ERROR] 2026-07-10 14:02:11 - ConnectionRefusedError: Failed to connect to database at db.internal:5432
[WARN] 2026-07-10 14:02:12 - Retry 1 failed
[ERROR] 2026-07-10 14:02:13 - ConnectionRefusedError: Failed to connect to database at db.internal:5432
[FATAL] 2026-07-10 14:02:15 - Service unavailable. Max retries exceeded.
      `,
      metrics: {
        cpu_usage: '85%',
        memory_usage: '92%',
        db_connections: '0 active, 500 failed attempts'
      }
    };
  } else if (serviceName.toLowerCase() === 'aws') {
    return {
      source: 'AWS CloudWatch Mock',
      status: 'ALARM',
      timestamp: new Date().toISOString(),
      logs: `
[ALARM] 2026-07-10 14:05:00 - High CPU Utilization Alarm triggered for instance i-1234567890abcdef0
[INFO] 2026-07-10 14:05:02 - Auto-scaling group attempted to launch new instance
[ERROR] 2026-07-10 14:05:10 - InsufficientInstanceCapacity: We currently do not have sufficient capacity in the Availability Zone you requested.
      `
    };
  }

  return {
    source: 'Unknown Mock',
    status: 'UNKNOWN',
    timestamp: new Date().toISOString(),
    logs: 'No specific logs found for this service.'
  };
}
