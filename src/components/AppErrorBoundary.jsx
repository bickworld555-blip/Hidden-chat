import { Component } from 'react';
import { RotateCcw } from 'lucide-react';

export default class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Relay view crashed', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="app-recovery" role="alert">
          <div className="recovery-mark">!</div>
          <h1>This view couldn’t load.</h1>
          <p>Your saved messages are still intact. Reload the chat view to continue.</p>
          <button onClick={() => window.location.reload()}><RotateCcw size={16} />Reload Relay</button>
        </main>
      );
    }
    return this.props.children;
  }
}