import { memo, type ComponentProps } from "react";
import { code } from "@streamdown/code";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        "min-w-0 max-w-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className,
      )}
      plugins={{ code }}
      {...props}
    />
  ),
  (previous, next) => previous.children === next.children,
);

MessageResponse.displayName = "MessageResponse";
