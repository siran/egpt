import '../cdp-bootstrap.js';   // configures cdp host getter (no-op when shimmed to chrome.debugger)
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);
