import * as React from "react";
import { cn } from "@/lib/utils";

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "default" | "secondary" | "ghost" | "danger" | "outline";
  size?: "sm" | "md";
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "md", ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={cn(
          "inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-md font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent disabled:pointer-events-none disabled:opacity-40",
          variant === "default" &&
            "bg-accent text-white hover:bg-accent/85",
          variant === "secondary" &&
            "bg-surface-2 text-foreground hover:bg-border",
          variant === "ghost" && "text-muted hover:bg-surface hover:text-foreground",
          variant === "danger" && "bg-danger/15 text-danger hover:bg-danger/25",
          variant === "outline" &&
            "border border-border bg-transparent text-foreground hover:bg-surface",
          size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-4 text-sm",
          className,
        )}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";
