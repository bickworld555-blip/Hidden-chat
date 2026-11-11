// Entry for the standalone admin page (admin.html, served at /admin). Loads none of the chat app.
import { createRoot } from 'react-dom/client';
import '../styles.css';
import './admin.css';
import AdminApp from './AdminApp.jsx';

createRoot(document.getElementById('admin-root')).render(<AdminApp />);
