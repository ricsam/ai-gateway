import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@richie-router/react";
import React from "react";
import { createRoot } from "react-dom/client";
import { queryClient } from "./api";
import { router } from "./router";
import { ThemeProvider } from "./ui/theme-provider";
import "./styles.css";

// Error Boundary component
type ErrorBoundaryProps = { children: React.ReactNode };
type ErrorBoundaryState = { hasError: boolean; error: Error | null };

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("React Error Boundary caught:", error, errorInfo);
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center p-8 bg-gray-900">
          <div className="max-w-md text-center">
            <div className="text-red-500 text-6xl mb-4">!</div>
            <h2 className="text-xl font-semibold text-red-400 mb-2">Something went wrong</h2>
            <p className="text-red-400 font-mono text-sm bg-red-950/50 p-3 rounded overflow-auto max-h-48">
              {this.state.error?.message || "Unknown error"}
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              className="mt-4 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700"
            >
              Try Again
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// Loading fallback component
const LoadingFallback = () => (
  <div className="flex items-center justify-center min-h-screen bg-gray-900">
    <div className="text-center">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto mb-4"></div>
      <p className="text-gray-400 text-sm">Loading...</p>
    </div>
  </div>
);

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="dark" storageKey="ui-theme">
        <ErrorBoundary>
          <React.Suspense fallback={<LoadingFallback />}>
            <RouterProvider router={router} />
          </React.Suspense>
        </ErrorBoundary>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
