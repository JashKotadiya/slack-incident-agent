import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'
import { datadogRum } from '@datadog/browser-rum';
import { reactPlugin } from '@datadog/browser-rum-react';

// Initialize Datadog RUM
datadogRum.init({
  applicationId: 'f9452f66-12b6-401d-abb4-b313984a3be6',
  clientToken: 'pub8b9e16b3c324fe66b104ae204ca2ac4e',
  site: 'us5.datadoghq.com',
  service: 'webapp-frontend',
  env: 'prod',
  version: '1.0.0',
  sessionSampleRate: 100,
  sessionReplaySampleRate: 20,
  trackUserInteractions: true,
  trackResources: true,
  trackLongTasks: true,
  plugins: [reactPlugin({ router: false })],
});

datadogRum.startSessionReplayRecording();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
