import React from 'react';

type RouteErrorBoundaryProps = {
  children: React.ReactNode;
  resetKey: string;
  t: (text: string) => string;
};

type RouteErrorBoundaryState = {
  error: Error | null;
};

const ROUTE_CHUNK_RELOAD_STORAGE_KEY = 'metapi.routeChunk.reloadTarget';

function isDynamicImportFailure(error: Error): boolean {
  const message = error.message || '';
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message);
}

class RouteErrorBoundaryImpl extends React.Component<RouteErrorBoundaryProps, RouteErrorBoundaryState> {
  state: RouteErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): RouteErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[web] route render failed:', error, info);
    if (!isDynamicImportFailure(error)) return;
    if (typeof window === 'undefined' || typeof window.location?.reload !== 'function') return;

    const reloadTarget = window.location.href;
    try {
      if (window.localStorage?.getItem(ROUTE_CHUNK_RELOAD_STORAGE_KEY) === reloadTarget) return;
      window.localStorage?.setItem(ROUTE_CHUNK_RELOAD_STORAGE_KEY, reloadTarget);
    } catch {
      // Reload is still the best recovery if storage is unavailable.
    }

    window.location.reload();
  }

  componentDidUpdate(prevProps: RouteErrorBoundaryProps): void {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  private handleRetry = (): void => {
    this.setState({ error: null });
  };

  private handleReload = (): void => {
    if (typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
      window.location.reload();
    }
  };

  private handleGoDashboard = (): void => {
    if (typeof window !== 'undefined' && typeof window.location?.assign === 'function') {
      window.location.assign('/');
    }
  };

  render() {
    const { children, t } = this.props;
    const { error } = this.state;

    if (!error) {
      return children;
    }

    return (
      <div style={{ padding: 16 }}>
        <div
          className="card"
          role="alert"
          style={{
            padding: 20,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            minHeight: 220,
            justifyContent: 'center',
          }}
        >
          <div className="alert alert-error">
            <div>
              <div className="alert-title">{t('页面加载失败')}</div>
              <div style={{ marginTop: 6 }}>
                {t('当前页面发生运行时错误，已阻止白板。可以重试当前页面，或先返回仪表盘继续使用。')}
              </div>
            </div>
          </div>
          <div
            style={{
              fontSize: 12,
              color: 'var(--color-text-muted)',
              wordBreak: 'break-word',
              whiteSpace: 'pre-wrap',
            }}
          >
            {error.message || t('未知错误')}
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-primary" onClick={this.handleRetry}>
              {t('重试当前页')}
            </button>
            <button type="button" className="btn btn-secondary" onClick={this.handleReload}>
              {t('刷新页面')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={this.handleGoDashboard}>
              {t('返回仪表盘')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default function RouteErrorBoundary(props: RouteErrorBoundaryProps) {
  return <RouteErrorBoundaryImpl {...props} />;
}
