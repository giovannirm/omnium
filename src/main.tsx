import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./ui/App.tsx";
import "./ui/styles.css";

class AppGuard extends Component<{ children: ReactNode }, { message: string | null }> {
  state = { message: null as string | null };

  static getDerivedStateFromError(error: unknown): { message: string } {
    return { message: error instanceof Error ? error.message : "Error inesperado" };
  }

  render() {
    if (!this.state.message) return this.props.children;
    return (
      <div className="boot">
        <p>Omnium detuvo esta vista por un error.</p>
        <p className="hint">{this.state.message}</p>
        <div className="toolbar">
          <button type="button" className="send" onClick={() => this.setState({ message: null })}>
            Reintentar
          </button>
          <button type="button" className="ghost" onClick={() => window.location.reload()}>
            Recargar
          </button>
        </div>
      </div>
    );
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("No está el contenedor de Omnium");

createRoot(root).render(
  <StrictMode>
    <AppGuard>
      <App />
    </AppGuard>
  </StrictMode>,
);
