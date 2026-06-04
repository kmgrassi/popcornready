interface LogoMarkProps {
  className?: string;
}

export function LogoMark({ className }: LogoMarkProps) {
  return (
    <svg
      className={className}
      viewBox="-6 -4 124 128"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="logo-mark-body"
        d="M58 24c11-12 27-17 39-9 16 11 16 31 6 45 9 11 13 23 6 36-8 15-27 17-45 10-8-3-13 5-23 10-18 9-36-2-40-22-2-11 2-24 8-35-10-9-16-28-3-44 13-16 34-14 52 9Z"
      />
      <path
        className="logo-mark-highlight"
        d="M23 34c11-10 26-10 43-4 8 3 15 2 20-3"
      />
      <g className="logo-mark-shadow">
        <path d="M58 24c10-12 25-18 38-11 18 10 18 35 7 47" />
        <path d="M58 24c-14-8-31-12-43 2-14 16-8 35 3 45" />
        <path d="M103 60c7 10 13 21 6 34-9 18-30 17-45 11-8-3-12 4-22 10-18 10-38-2-41-23-1-10 2-20 7-33" />
        <path d="M18 71c-3-8 8-15 16-18" />
        <path d="M64 85c2 8 7 16 14 19" />
        <path d="M38 17c10 2 18 5 30 12" />
      </g>
      <g className="logo-mark-fill">
        <path d="M58 24c10-12 25-18 38-11 18 10 18 35 7 47" />
        <path d="M58 24c-14-8-31-12-43 2-14 16-8 35 3 45" />
        <path d="M103 60c7 10 13 21 6 34-9 18-30 17-45 11-8-3-12 4-22 10-18 10-38-2-41-23-1-10 2-20 7-33" />
        <path d="M18 71c-3-8 8-15 16-18" />
        <path d="M64 85c2 8 7 16 14 19" />
        <path d="M38 17c10 2 18 5 30 12" />
      </g>
    </svg>
  );
}
