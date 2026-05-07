import '../cdp-bootstrap.js';   // must run before any cdp/bus call
import { createRoot } from 'react-dom/client';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);
