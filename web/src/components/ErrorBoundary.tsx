import { Component, type ErrorInfo, type ReactNode } from 'react';
import { L } from '../lib/labels';

interface Props {
  children: ReactNode;
  /** 区域名称，用于无障碍提示。 */
  label?: string;
}

interface State {
  failed: boolean;
}

/** 局部降级：某个区域渲染出错时只替换该区域，其余界面继续可用（Req 3.8）。 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('ErrorBoundary', this.props.label ?? '', error, info.componentStack);
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="error-bar" role="alert">
        <span>{L.errorBoundary}</span>
        <button type="button" className="btn" onClick={() => this.setState({ failed: false })}>
          {L.retry}
        </button>
      </div>
    );
  }
}
