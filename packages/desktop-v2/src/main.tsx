import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { hydrateAppState } from './store';
import { BUILD_ID, BUILD_TIME, GIT_SHA } from './lib/build-info';
import './index.css';

// Print build identity to the WebView console as soon as the module
// loads so a quick "Inspect Element → Console" tells you which build
// you're running. The same info ends up in /api/v1/build endpoint
// (backend) and the Tauri sidecar log.
// eslint-disable-next-line no-console
console.info(
  `%cNexus desktop v${BUILD_ID}`,
  'color:#7ec1ff;font-weight:bold',
  `\n  built: ${BUILD_TIME}\n  git:   ${GIT_SHA}`,
);

// Read token + theme from localStorage and push into the store before
// rendering. This prevents a one-frame flash of the wrong theme or a
// brief flash of LoginView when the user is actually signed in.
hydrateAppState();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
