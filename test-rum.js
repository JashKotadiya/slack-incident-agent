import { client, v2 } from '@datadog/datadog-api-client';
import dotenv from 'dotenv';
dotenv.config();

const configuration = client.createConfiguration();
configuration.setServerVariables({ site: process.env.DD_SITE || 'datadoghq.com' });

const rumApi = new v2.RUMApi(configuration);

async function testRUM() {
  try {
    const response = await rumApi.searchRUMEvents({
      body: {
        filter: {
          query: '@type:error',
          from: 'now-15m',
          to: 'now'
        },
        page: { limit: 5 }
      }
    });
    console.log(JSON.stringify(response.data, null, 2));
  } catch (e) {
    console.error(e);
  }
}
testRUM();
