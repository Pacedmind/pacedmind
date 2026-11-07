/**
 * Icons from the app (../src/components/icons.tsx), so the docs use the same
 * symbols as the sidebar they describe. `keyboard` is the only addition.
 */
const P = {
  play: 'M7 4l12 8-12 8z',
  layers: 'M12 2L2 7l10 5 10-5-10-5z M2 17l10 5 10-5M2 12l10 5 10-5',
  pen: 'M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  calendar: 'M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M3 9h18M8 2v4M16 2v4',
  terminal: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M7 10l3 2-3 2 M12 15h5',
  clock: 'M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M12 7v5l3 2',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7 M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  box: 'M21 8l-9-5-9 5v8l9 5 9-5z M3 8l9 5 9-5 M12 13v8',
  bell: 'M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9 M10.3 21a1.9 1.9 0 0 0 3.4 0',
  settings:
    'M9.7 3.1l.5-1.1h3.6l.5 1.1.4 1.8 1.6.9 1.8-.5 1.2.2 1.8 3.1-.7 1-1.4 1.3v1.8l1.4 1.3.7 1-1.8 3.1-1.2.2-1.8-.5-1.6.9-.4 1.8-.5 1.1h-3.6l-.5-1.1-.4-1.8-1.6-.9-1.8.5-1.2-.2-1.8-3.1.7-1 1.4-1.3v-1.8L3.1 9.6l-.7-1 1.8-3.1 1.2-.2 1.8.5 1.6-.9z M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
  keyboard: 'M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z M7 10h.01M11 10h.01M15 10h.01M8 14h8',
  flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z M4 22v-7',
  user: 'M8 8a4 4 0 1 0 8 0a4 4 0 1 0 -8 0 M4.5 20a7.5 7.5 0 0 1 15 0',
  users: 'M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0 M1.5 20a7.5 7.5 0 0 1 15 0 M16 3.5a4 4 0 0 1 0 7.5 M19 14.5a7.5 7.5 0 0 1 3.5 5.5',
  arrowRight: 'M5 12h14M13 6l6 6-6 6',
};

export type AppIconName = keyof typeof P;

export function AppIcon({ name, size = 18, className }: { name: AppIconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d={P[name]} />
    </svg>
  );
}
