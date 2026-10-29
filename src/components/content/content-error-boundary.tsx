import { Component, type ReactNode } from "react";
import { m } from "@/paraglide/messages";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

/** 内容 JSON 异常/未知节点导致渲染失败时的兜底，避免整页进入错误页 */
export class ContentErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error(
      JSON.stringify({
        event: "content_render_failed",
        error: error.message,
      }),
    );
  }

  render() {
    if (this.state.hasError) {
      return (
        <p className="text-sm text-muted-foreground">{m.error_desc()}</p>
      );
    }
    return this.props.children;
  }
}
