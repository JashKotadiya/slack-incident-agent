import snowflake from 'snowflake-sdk';
import dotenv from 'dotenv';
dotenv.config();

export async function checkSnowflakeErrors() {
  return new Promise((resolve, reject) => {
    // If not configured, just return a notice message so it doesn't crash
    if (!process.env.SNOWFLAKE_ACCOUNT || !process.env.SNOWFLAKE_USERNAME) {
      resolve({
        source: 'Snowflake (Unconfigured)',
        status: 'OK',
        timestamp: new Date().toISOString(),
        logs: 'Snowflake credentials not found in .env.'
      });
      return;
    }

    const conn = snowflake.createConnection({
      account: process.env.SNOWFLAKE_ACCOUNT,
      username: process.env.SNOWFLAKE_USERNAME,
      password: process.env.SNOWFLAKE_PASSWORD,
      warehouse: process.env.SNOWFLAKE_WAREHOUSE,
      database: process.env.SNOWFLAKE_DATABASE,
      schema: process.env.SNOWFLAKE_SCHEMA,
      role: process.env.SNOWFLAKE_ROLE
    });
    
    // Connect to Snowflake
    conn.connect((err, conn) => {
      if (err) {
        console.error('Unable to connect to Snowflake:', err.message);
        resolve({
          source: 'Snowflake',
          status: 'ERROR',
          timestamp: new Date().toISOString(),
          logs: `Connection Error: ${err.message}`
        });
        return;
      }
      
      const sqlText = `
        SELECT QUERY_ID, QUERY_TEXT, ERROR_CODE, ERROR_MESSAGE, START_TIME 
        FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_WAREHOUSE('${process.env.SNOWFLAKE_WAREHOUSE}')) 
        WHERE ERROR_CODE IS NOT NULL 
        ORDER BY START_TIME DESC 
        LIMIT 5
      `;
      
      conn.execute({
        sqlText: sqlText,
        complete: (err, stmt, rows) => {
          // Destroy connection to prevent "Already connected" on next poll
          conn.destroy((destroyErr, conn) => {
            if (destroyErr) console.error('Error disconnecting Snowflake:', destroyErr.message);
          });

          if (err) {
            console.error('Failed to execute statement:', err.message);
            resolve({
              source: 'Snowflake',
              status: 'ERROR',
              timestamp: new Date().toISOString(),
              logs: `Query Error: ${err.message}`
            });
            return;
          }
          
          if (rows && rows.length > 0) {
            const errorLogs = rows.map(r => `[${r.START_TIME ? new Date(r.START_TIME).toISOString() : 'N/A'}] QUERY_ID: ${r.QUERY_ID}\nERROR_CODE: ${r.ERROR_CODE}\nERROR_MESSAGE: ${r.ERROR_MESSAGE}\nQUERY: ${r.QUERY_TEXT}`).join('\n\n');
            resolve({
              source: 'Snowflake',
              status: 'CRITICAL',
              timestamp: new Date().toISOString(),
              logs: errorLogs
            });
          } else {
            resolve({
              source: 'Snowflake',
              status: 'OK',
              timestamp: new Date().toISOString(),
              logs: 'No recent error logs found.'
            });
          }
        }
      });
    });
  });
}

