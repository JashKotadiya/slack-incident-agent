import WebSocket from 'ws';

export function startSyntheticMonitoring(onDown) {
  let backendWs = null;
  let frontendWs = null;

  // Track if we are already alerting to prevent spam
  let isBackendDown = false;
  let isFrontendDown = false;

  function connectBackend() {
    backendWs = new WebSocket('ws://localhost:8080');

    backendWs.on('open', () => {
      console.log('[Synthetics] Connected to Backend WS.');
      isBackendDown = false;
    });

    backendWs.on('close', () => {
      if (!isBackendDown) {
        console.error('[Synthetics] Backend WS connection dropped! Outage detected!');
        isBackendDown = true;
        onDown('webapp', 'CRITICAL OUTAGE: The backend server WebSocket connection was lost. The server is unreachable or crashed.');
      }
      setTimeout(connectBackend, 5000); // Attempt to reconnect
    });

    backendWs.on('error', () => {
      // Error will trigger close event anyway
    });
  }

  function connectFrontend() {
    // Vite uses 'vite-hmr' subprotocol
    frontendWs = new WebSocket('ws://localhost:5173', 'vite-hmr');

    frontendWs.on('open', () => {
      console.log('[Synthetics] Connected to Frontend Vite HMR WS.');
      isFrontendDown = false;
    });

    frontendWs.on('message', (data) => {
      try {
        const payload = JSON.parse(data.toString());
        console.log('[Synthetics] Vite HMR Payload:', payload.type);
        if (payload.type === 'error' && payload.err) {
          console.error('[Synthetics] Frontend Compile Error Detected!');
          const errorText = `CRITICAL OUTAGE: Frontend Compile Error!\n\n${payload.err.message}\n${payload.err.frame || ''}`;
          onDown('webapp-frontend', errorText);
        }
      } catch (e) {
        // Ignore unparseable messages
      }
    });

    frontendWs.on('close', () => {
      if (!isFrontendDown) {
        console.error('[Synthetics] Frontend WS connection dropped! Outage detected!');
        isFrontendDown = true;
        onDown('webapp-frontend', 'CRITICAL OUTAGE: The frontend development server WebSocket was lost. The process was killed or unreachable.');
      }
      setTimeout(connectFrontend, 5000); // Attempt to reconnect
    });

    frontendWs.on('error', () => {
      // Error will trigger close
    });
  }

  // Start the persistent connections
  connectBackend();
  connectFrontend();
}
