import { Component, type ErrorInfo, type ReactNode } from "react";
import { CircleAlert, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

export class AppErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("页面渲染失败", error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background p-6 text-center" role="alert">
        <CircleAlert size={28} className="text-warning" />
        <h1 className="text-xl font-semibold">页面暂时无法显示</h1>
        <p className="max-w-md text-sm text-muted-foreground">本次页面渲染遇到异常，尚未改变任何自选股或数据。请重新加载后再试。</p>
        <Button type="button" onClick={() => window.location.reload()}><RotateCcw />重新加载页面</Button>
      </main>
    );
  }
}
