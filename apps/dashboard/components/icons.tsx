import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

function IconBase({ children, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className="icon"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      {children}
    </svg>
  );
}

export function OverviewIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 13h6V4H4v9Zm10 7h6v-9h-6v9ZM4 20h6v-3H4v3Zm10-13h6V4h-6v3Z" />
    </IconBase>
  );
}
export function ServerIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="4" width="18" height="6" rx="2" />
      <rect x="3" y="14" width="18" height="6" rx="2" />
      <path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" />
    </IconBase>
  );
}
export function JobsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 8v4l2.5 1.5" />
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9 3h6" />
    </IconBase>
  );
}
export function LogsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M14 3v5h5M9 12h6M9 16h6" />
    </IconBase>
  );
}
export function PulseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 12h4l2-6 4 12 2-6h6" />
    </IconBase>
  );
}
export function LockIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
    </IconBase>
  );
}
export function DatabaseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v7c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12v7c0 1.7 3.6 3 8 3s8-1.3 8-3v-7" />
    </IconBase>
  );
}
export function AlertIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3 2.8 20h18.4L12 3Z" />
      <path d="M12 9v5M12 17h.01" />
    </IconBase>
  );
}
